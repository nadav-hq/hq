import { ALWAYS_ON_TOOLS, splitToolRef, TOOL_CATALOG } from "@hq/shared";
import type pg from "pg";
import { z } from "zod";
import { withCompanyRole } from "../db/pool.ts";
import type { LoadedCard } from "../loader/load-company.ts";
import type { Logger } from "../log.ts";
import { EXECUTORS, requestApproval } from "./approvals.ts";
import type { DriverTool } from "./driver.ts";
import { handoffError } from "./handoff.ts";
import { MAX_HOP, type TaskRow } from "./queue.ts";
import { untrusted } from "./untrusted.ts";

export type RunState = {
  statusSet: boolean;
  proposals: string[];
  waiting: string[];
  executed: string[];
  hopLimitHit: boolean;
};

export type ToolContext = {
  pool: pg.Pool;
  runId: string;
  card: LoadedCard;
  companyCards: LoadedCard[];
  shadow: boolean;
  task: TaskRow | null;
  log: Logger;
  state: RunState;
};

type AsCompany = <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;

/**
 * Build the model-facing tools for one run from the card's `tools` (+ the always-on close tools).
 * Every handler re-checks against the card (spec §9) and runs as the company's Postgres role.
 */
export function buildTools(ctx: ToolContext): { tools: DriverTool[]; unavailable: string[] } {
  const { card } = ctx;
  const company = card.company;
  const refs = [...new Set([...ALWAYS_ON_TOOLS, ...card.tools])];
  const readTables = refs.filter((r) => r.startsWith("db.read:")).map((r) => splitToolRef(r).arg!);
  const writeTables = refs.filter((r) => r.startsWith("db.write:")).map((r) => splitToolRef(r).arg!);
  const bases = new Set(refs.map((r) => splitToolRef(r).base));
  const unavailable = [...bases].filter((b) => !TOOL_CATALOG[b]).sort();
  const asCompany: AsCompany = (fn) => withCompanyRole(ctx.pool, company, fn);

  /**
   * Spec §6 step 5. Shadow → proposal (never executed). Listed in card.approvals, or external →
   * waiting for Nadav. Otherwise execute now with the same executor an approval would use.
   */
  const gate = async (action: string, payload: Record<string, unknown>): Promise<string> => {
    const spec = TOOL_CATALOG[action]!;
    if (ctx.shadow || card.approvals.includes(action) || spec.external) {
      const { row, created } = await asCompany((c) =>
        requestApproval(c, { runId: ctx.runId, agentId: card.id, companyId: company, action, payload, shadow: ctx.shadow }),
      );
      ctx.log("approval.requested", { run_id: ctx.runId, agent_id: card.id, approval_id: row.id, action, shadow: ctx.shadow, created });
      if (ctx.shadow) {
        if (created) ctx.state.proposals.push(row.id);
        return `PROPOSED (shadow mode): "${action}" was not executed. It is recorded as proposal #${row.id} for Nadav to review.`;
      }
      if (created) ctx.state.waiting.push(row.id);
      return `WAITING FOR APPROVAL: "${action}" is approval #${row.id}. It runs only after Nadav approves it.`;
    }
    const exec = EXECUTORS[action];
    if (!exec) throw new Error(`no executor for ${action}`);
    const result = await asCompany((c) =>
      exec(c, { id: "direct", agent_id: card.id, company_id: company, action, payload, idempotency_key: "", shadow: false, status: "executed" }),
    );
    ctx.state.executed.push(action);
    ctx.log("action.executed", { run_id: ctx.runId, agent_id: card.id, action });
    return `DONE: ${result}`;
  };

  const tools: DriverTool[] = [];
  const add = (base: string, name: string, schema: DriverTool["schema"], handler: DriverTool["handler"], extra = "") => {
    if (bases.has(base)) tools.push({ name, description: `${TOOL_CATALOG[base]!.description}${extra}`, schema, handler });
  };

  add("memory.write", "memory_write", { note: z.string().min(1).max(2000) }, async ({ note }) => {
    await asCompany((c) =>
      c.query("insert into hq.memory (agent_id, company_id, note) values ($1, $2, $3)", [card.id, company, String(note)]),
    );
    return "saved";
  });

  add(
    "status.set",
    "status_set",
    { line: z.string().min(1).max(200), needs_owner: z.boolean().optional() },
    async ({ line, needs_owner }) => {
      await setStatus(asCompany, card, String(line), Boolean(needs_owner));
      ctx.state.statusSet = true;
      return "status set";
    },
  );

  if (readTables.length) {
    add(
      "db.read",
      "db_read",
      {
        table: z.enum(readTables as [string, ...string[]]),
        where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ table, where, limit }) => {
        const t = String(table);
        if (!readTables.includes(t)) throw new Error(`table ${t} is not in your card`);
        const rows = await asCompany((c) => selectRows(c, company, t, (where ?? {}) as Record<string, unknown>, Number(limit ?? 50)));
        return untrusted(`db:${t}`, rows);
      },
      ` (tables: ${readTables.join(", ")})`,
    );
  }

  if (writeTables.length) {
    add(
      "db.write",
      "db_write",
      { table: z.enum(writeTables as [string, ...string[]]), row: z.record(z.string(), z.unknown()) },
      async ({ table, row }) => {
        const t = String(table);
        if (!writeTables.includes(t)) throw new Error(`table ${t} is not in your card`);
        return gate("db.write", { table: t, row: row as Record<string, unknown> });
      },
      ` (tables: ${writeTables.join(", ")})`,
    );
  }

  add(
    "queue.create_task",
    "queue_create_task",
    { to_agent: z.string(), task: z.string().min(1).max(4000) },
    async ({ to_agent, task }) => {
      const to = String(to_agent);
      const err = handoffError(card, to, ctx.companyCards);
      if (err) throw new Error(err);
      const hop = (ctx.task?.hop ?? -1) + 1;
      if (hop > MAX_HOP) {
        ctx.state.hopLimitHit = true;
        await setStatus(asCompany, card, `hop limit reached handing off to ${to}; needs Nadav`, true);
        await asCompany((c) =>
          c.query("insert into hq.events (company_id, kind, payload) values ($1, 'hop_limit', $2)", [
            company,
            JSON.stringify({ from: card.id, to, hop, parent_task_id: ctx.task?.id ?? null, task: String(task) }),
          ]),
        );
        ctx.log("handoff.hop_limit", { run_id: ctx.runId, agent_id: card.id, to, hop });
        return `STOPPED: hop limit (${MAX_HOP}) reached. The task was not created; Nadav has been asked to decide.`;
      }
      return gate("queue.create_task", { to_agent: to, payload: { task: String(task) }, hop, parent_task_id: ctx.task?.id ?? null });
    },
    " (workers: your manager or another worker in your company; managers: their own workers)",
  );

  if (card.approvals.length) {
    add(
      "approval.request",
      "approval_request",
      { action: z.enum(card.approvals as [string, ...string[]]), details: z.string().min(1).max(4000) },
      async ({ action, details }) => {
        const a = String(action);
        if (!card.approvals.includes(a)) throw new Error(`"${a}" is not in your card's approvals`);
        const { row, created } = await asCompany((c) =>
          requestApproval(c, { runId: ctx.runId, agentId: card.id, companyId: company, action: a, payload: { details: String(details) }, shadow: ctx.shadow }),
        );
        if (created) (ctx.shadow ? ctx.state.proposals : ctx.state.waiting).push(row.id);
        return `Approval #${row.id} for "${a}" is waiting for Nadav.${ctx.shadow ? " (shadow mode: it will never be executed)" : ""}`;
      },
    );
  }

  add("test.ping", "test_ping", { message: z.string().min(1).max(500) }, async ({ message }) => gate("test.ping", { message: String(message) }));

  return { tools, unavailable };
}

export async function setStatus(asCompany: AsCompany, card: { id: string; company: string }, line: string, needsOwner: boolean) {
  await asCompany((c) =>
    c.query(
      `insert into hq.status (agent_id, company_id, line, needs_owner) values ($1, $2, $3, $4)
       on conflict (agent_id) do update set line = excluded.line, needs_owner = excluded.needs_owner, updated_at = now()`,
      [card.id, card.company, line.slice(0, 200), needsOwner],
    ),
  );
}

/** Fixed, parameterized select from "<company>"."<table>" with optional equality filters. */
async function selectRows(c: pg.ClientBase, company: string, table: string, where: Record<string, unknown>, limit: number) {
  const [schema, name] = table.split(".");
  if (schema !== company || !name) throw new Error(`table ${table} is not in schema ${company}`);
  const id = (s: string) => c.escapeIdentifier(s);
  const cols = Object.keys(where);
  for (const k of cols) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(k)) throw new Error(`bad column name ${k}`);
  const cond = cols.length ? ` where ${cols.map((k, i) => `${id(k)} is not distinct from $${i + 1}`).join(" and ")}` : "";
  const n = Math.max(1, Math.min(Math.trunc(limit) || 50, 200));
  const { rows } = await c.query(`select * from ${id(schema)}.${id(name)}${cond} limit ${n}`, cols.map((k) => where[k]));
  return rows;
}
