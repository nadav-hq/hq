import { createHash } from "node:crypto";
import type pg from "pg";
import { withCompanyRole, type Queryable } from "../db/pool.ts";
import { insertTask } from "./queue.ts";

export type ApprovalRow = {
  id: string;
  agent_id: string;
  company_id: string;
  action: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  shadow: boolean;
  status: string;
};

/** Deterministic key: the same action with the same payload in the same run is one approval. */
export function idempotencyKey(runId: string, action: string, payload: unknown): string {
  return createHash("sha256").update(`${runId}\n${action}\n${canonical(payload)}`).digest("hex");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Create (or find) the approval row. Runs as the company role. */
export async function requestApproval(
  client: pg.ClientBase,
  a: { runId: string; agentId: string; companyId: string; action: string; payload: Record<string, unknown>; shadow: boolean },
): Promise<{ row: ApprovalRow; created: boolean }> {
  const key = idempotencyKey(a.runId, a.action, a.payload);
  const ins = await client.query<ApprovalRow>(
    `insert into hq.approvals (agent_id, company_id, action, payload, idempotency_key, shadow)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing
     returning id::text, agent_id, company_id, action, payload, idempotency_key, shadow, status::text`,
    [a.agentId, a.companyId, a.action, JSON.stringify(a.payload), key, a.shadow],
  );
  if (ins.rows[0]) return { row: ins.rows[0], created: true };
  const found = await client.query<ApprovalRow>(
    `select id::text, agent_id, company_id, action, payload, idempotency_key, shadow, status::text
       from hq.approvals where idempotency_key = $1`,
    [key],
  );
  return { row: found.rows[0]!, created: false };
}

/**
 * Executors for approved actions, run inside the company role's transaction together with the
 * `approved → executed` flip, so a DB action happens exactly once. Actions without an executor
 * (e.g. future external sends) stay `approved` until one exists.
 */
export type Executor = (client: pg.ClientBase, row: ApprovalRow) => Promise<string>;

export const EXECUTORS: Record<string, Executor> = {
  "test.ping": async (client, row) => {
    await client.query("insert into hq.events (company_id, kind, payload) values ($1, 'test.ping', $2)", [
      row.company_id,
      JSON.stringify({ ...row.payload, agent_id: row.agent_id, approval_id: row.id }),
    ]);
    return "pinged";
  },
  "db.write": async (client, row) => {
    const { table, row: values } = row.payload as { table: string; row: Record<string, unknown> };
    await insertRow(client, row.company_id, table, values);
    return `inserted into ${table}`;
  },
  "queue.create_task": async (client, row) => {
    const p = row.payload as { to_agent: string; payload: Record<string, unknown>; hop: number; parent_task_id: string | null };
    const id = await insertTask(client, {
      fromAgent: row.agent_id,
      toAgent: p.to_agent,
      companyId: row.company_id,
      payload: p.payload,
      hop: p.hop,
      parentTaskId: p.parent_task_id,
    });
    return `task ${id} created`;
  },
};

/** Fixed, parameterized insert into "<company>"."<table>" (no raw SQL from agents). */
export async function insertRow(client: pg.ClientBase, companyId: string, table: string, values: Record<string, unknown>) {
  const [schema, name] = table.split(".");
  if (schema !== companyId || !name) throw new Error(`table ${table} is not in schema ${companyId}`);
  const cols = Object.keys(values);
  if (!cols.length) throw new Error("row is empty");
  for (const c of cols) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(c)) throw new Error(`bad column name ${c}`);
  const id = (s: string) => client.escapeIdentifier(s);
  await client.query(
    `insert into ${id(schema)}.${id(name)} (${cols.map(id).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => values[c]),
  );
}

export type DecideResult = { approval: ApprovalRow; executed: boolean; result?: string; note?: string };

/**
 * Nadav's decision (CLI now, Telegram buttons in M3). Approving a non-shadow approval executes it
 * once. Approving a shadow proposal only counts toward the agent's shadow approval rate.
 */
export async function decideApproval(
  pool: pg.Pool,
  id: string,
  decision: "approve" | "reject",
  decidedBy: string,
  reason?: string,
): Promise<DecideResult> {
  const status = decision === "approve" ? "approved" : "rejected";
  const { rows } = await pool.query<ApprovalRow>(
    `update hq.approvals set status = $2, decided_by = $3, decided_at = now(), reason = $4
      where id = $1 and status = 'waiting'
      returning id::text, agent_id, company_id, action, payload, idempotency_key, shadow, status::text`,
    [id, status, decidedBy, reason ?? null],
  );
  const row = rows[0];
  if (!row) {
    const cur = await pool.query<{ status: string }>("select status::text from hq.approvals where id = $1", [id]);
    throw new Error(cur.rows[0] ? `approval ${id} is already ${cur.rows[0].status}` : `approval ${id} not found`);
  }
  if (row.shadow) {
    if (status === "approved") await pool.query("update hq.agents set shadow_approved = shadow_approved + 1 where id = $1", [row.agent_id]);
    return { approval: row, executed: false, note: "shadow proposal: recorded for shadow stats, never executed" };
  }
  if (status === "rejected") return { approval: row, executed: false };
  return executeApproval(pool, id);
}

/** Execute an approved action exactly once. Safe to call repeatedly. */
export async function executeApproval(pool: pg.Pool, id: string): Promise<DecideResult> {
  const { rows } = await pool.query<{ company_id: string; action: string }>(
    "select company_id, action from hq.approvals where id = $1",
    [id],
  );
  const meta = rows[0];
  if (!meta) throw new Error(`approval ${id} not found`);
  const executor = EXECUTORS[meta.action];
  if (!executor) {
    const row = await getApproval(pool, id);
    return { approval: row, executed: false, note: `no executor for ${meta.action} yet; left approved` };
  }
  return withCompanyRole(pool, meta.company_id, async (client) => {
    const claimed = await client.query<ApprovalRow>(
      `update hq.approvals set status = 'executed', executed_at = now()
        where id = $1 and status = 'approved' and not shadow
        returning id::text, agent_id, company_id, action, payload, idempotency_key, shadow, status::text`,
      [id],
    );
    const row = claimed.rows[0];
    if (!row) return { approval: await getApproval(client, id), executed: false, note: "not approved or already executed" };
    const result = await executor(client, row);
    return { approval: row, executed: true, result };
  });
}

async function getApproval(db: Queryable, id: string): Promise<ApprovalRow> {
  const { rows } = await db.query<ApprovalRow>(
    `select id::text, agent_id, company_id, action, payload, idempotency_key, shadow, status::text from hq.approvals where id = $1`,
    [id],
  );
  return rows[0]!;
}
