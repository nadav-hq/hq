import { resolveModel } from "@hq/shared";
import type pg from "pg";
import { withCompanyRole } from "../db/pool.ts";
import type { LoadedCard } from "../loader/load-company.ts";
import { log as defaultLog, type Logger } from "../log.ts";
import { checkBudget } from "./budget.ts";
import type { ModelDriver } from "./driver.ts";
import { finishTask, insertTask, type TaskRow } from "./queue.ts";
import { buildTools, setStatus, type RunState } from "./tools.ts";
import { UNTRUSTED_RULE, untrusted } from "./untrusted.ts";

export type Trigger = "manual" | "cron" | "task" | "message";

export type RunRequest = {
  agentId: string;
  trigger: Trigger;
  /** Text from Nadav (manual / message triggers). Trusted. */
  prompt?: string;
  /** The task that triggered this run (trigger = task). Its payload is untrusted. */
  task?: TaskRow | null;
};

export type RunDeps = {
  pool: pg.Pool;
  driver: ModelDriver;
  /** All valid cards of the agent's company (from the loader). */
  companyCards: LoadedCard[];
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  /** Tests with a scripted model set this to false. */
  requireApiKey?: boolean;
};

export type RunOutcome = {
  runId: string | null;
  status: "succeeded" | "failed" | "skipped" | "budget_stopped";
  reason?: string;
  shadow: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  summary: string;
  proposals: string[];
  waiting: string[];
  executed: string[];
  autoPaused: boolean;
};

const ENGINE_PREAMBLE = (card: LoadedCard, shadow: boolean) =>
  [
    `You are ${card.name} (${card.id}), an agent in NADAV HQ. You report to ${card.reports_to ?? "Nadav"}.`,
    "Work only through the tools you are given. Side effects go through approvals; the engine enforces this.",
    shadow
      ? "You are in SHADOW mode: act exactly as you would for real. Side-effect tools will answer PROPOSED; that is expected."
      : "",
    UNTRUSTED_RULE,
    "Before you finish: save anything worth remembering with memory_write, and set one short status line with status_set.",
    "Your final message is your run summary for Nadav: short and concrete.",
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Run one agent once (spec §6, the 8 steps). The engine enforces every step; the model only does step 4.
 */
export async function runAgent(req: RunRequest, deps: RunDeps): Promise<RunOutcome> {
  const { pool, driver } = deps;
  const log = deps.log ?? defaultLog;
  const env = deps.env ?? process.env;
  const base = { proposals: [], waiting: [], executed: [], autoPaused: false, costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };

  // 1. Trigger fires.
  const card = deps.companyCards.find((c) => c.id === req.agentId);
  if (!card) throw new Error(`no valid card for ${req.agentId} (is it loaded and valid?)`);
  const company = card.company;
  log("run.trigger", { agent_id: card.id, trigger: req.trigger, task_id: req.task?.id ?? null });

  // 2. State check: agent state, kill switches, budget.
  const agent = (
    await pool.query<{ state: string }>("select state::text from hq.agents where id = $1", [card.id])
  ).rows[0];
  if (!agent) throw new Error(`${card.id} is not in hq.agents (sync the cards first)`);
  const shadow = agent.state === "shadow";

  const skip = async (reason: string, status: "skipped" | "budget_stopped" = "skipped"): Promise<RunOutcome> => {
    const runId = await recordSkip(pool, card, req, reason, status, shadow);
    if (req.task) await finishTask(pool, req.task.id, ["paused", "archived", "draft"].includes(agent.state) ? "returned" : "open");
    log("run.skipped", { agent_id: card.id, run_id: runId, reason, status });
    return { ...base, runId, status, reason, shadow };
  };

  if (agent.state === "paused" || agent.state === "archived" || agent.state === "draft") return skip(`agent is ${agent.state}`);
  const stops = await pool.query<{ key: string }>(
    "select key from hq.settings where key in ('all_stopped', $1) and value = 'true'::jsonb",
    [`stopped:${company}`],
  );
  if (stops.rows.length) return skip(`kill switch: ${stops.rows.map((r) => r.key).join(", ")}`);

  const budget = await checkBudget(pool, card.id, company, card.budget.per_run_usd, card.budget.per_month_usd);
  if (budget.stoppedBy || budget.runCap <= 0) {
    const reason =
      budget.stoppedBy === "company_month"
        ? `company monthly budget used: $${budget.companySpent.toFixed(2)} of $${budget.companyLimit.toFixed(2)}`
        : `agent monthly budget used: $${budget.agentSpent.toFixed(2)} of $${budget.agentLimit.toFixed(2)}`;
    await reportBudgetStop(pool, card, reason);
    return skip(reason, "budget_stopped");
  }

  // Billing key: partner companies use their own env var (spec §2), solo companies ANTHROPIC_API_KEY.
  // A missing key is a setup problem, not an agent failure: skip without counting toward auto-pause.
  const keyEnv =
    (await pool.query<{ k: string | null }>("select anthropic_key_env as k from hq.companies where id = $1", [company])).rows[0]?.k ??
    "ANTHROPIC_API_KEY";
  const apiKey = env[keyEnv];
  if (!apiKey && deps.requireApiKey !== false) return skip(`no Anthropic API key: env ${keyEnv} is not set`);

  const runId = (
    await pool.query<{ id: string }>(
      `insert into hq.runs (agent_id, company_id, trigger, status, shadow, task_id)
       values ($1, $2, $3, 'running', $4, $5) returning id::text`,
      [card.id, company, req.trigger, shadow, req.task?.id ?? null],
    )
  ).rows[0]!.id;
  log("run.start", { agent_id: card.id, run_id: runId, shadow, run_cap_usd: budget.runCap, model: card.model });

  const state: RunState = { statusSet: false, proposals: [], waiting: [], executed: [], hopLimitHit: false };
  let result: Awaited<ReturnType<ModelDriver["run"]>>;
  try {
    // 3. Load: card, last N memory notes (as the company role), only the card's tools, the company's key.
    const memory = await withCompanyRole(pool, company, (c) =>
      c.query<{ note: string; created_at: Date }>(
        `select note, created_at from hq.memory where agent_id = $1 and deleted_at is null
          order by pinned desc, created_at desc limit $2`,
        [card.id, card.memory.read_last],
      ),
    );
    const { tools, unavailable } = buildTools({ pool, runId, card, companyCards: deps.companyCards, shadow, task: req.task ?? null, log, state });
    if (unavailable.length) log("run.tools_unavailable", { agent_id: card.id, run_id: runId, tools: unavailable });
    // 4. Work.
    const parts: string[] = [];
    if (memory.rows.length) {
      parts.push(
        "Your memory notes (newest first):",
        untrusted("memory", memory.rows.map((m) => `- ${m.created_at.toISOString().slice(0, 10)}: ${m.note}`).join("\n")),
      );
    }
    if (req.trigger === "task" && req.task) {
      parts.push(`You received task #${req.task.id} from ${req.task.from_agent ?? "Nadav"} (hop ${req.task.hop}):`, untrusted(`task:${req.task.id}`, req.task.payload));
    } else if (req.trigger === "cron") {
      parts.push("This is your scheduled run.");
    } else {
      parts.push(`Message from Nadav:\n${req.prompt ?? "Run now."}`);
    }

    result = await driver.run({
      model: resolveModel(card.model),
      system: `${ENGINE_PREAMBLE(card, shadow)}\n\n---\n\n${card.body}`,
      prompt: parts.join("\n\n"),
      tools,
      maxBudgetUsd: budget.runCap,
      maxTurns: deps.maxTurns ?? 30,
      apiKey,
    });
  } catch (e) {
    result = { status: "failed", text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, error: (e as Error).message };
  }

  // 7. Close: the agent writes its status line; if it didn't, the engine does.
  if (!state.statusSet) {
    const line = result.status === "succeeded" ? firstLine(result.text) || "run finished" : `run ${result.status}: ${result.error ?? ""}`;
    await setStatus((fn) => withCompanyRole(pool, company, fn), card, line, result.status !== "succeeded" || state.hopLimitHit).catch(
      (e) => log("run.status_error", { run_id: runId, error: (e as Error).message }),
    );
  }

  // 8. Record.
  await pool.query(
    `update hq.runs set finished_at = now(), status = $2, tokens_in = $3, tokens_out = $4, cost_usd = $5, summary = $6, error = $7
      where id = $1`,
    [runId, result.status, result.tokensIn, result.tokensOut, result.costUsd, result.text.slice(0, 4000), result.error ?? null],
  );
  await pool.query(
    "update hq.agents set last_run_at = now(), shadow_runs = shadow_runs + $2::int, updated_at = now() where id = $1",
    [card.id, shadow ? 1 : 0],
  );
  if (req.task) await finishTask(pool, req.task.id, result.status === "succeeded" ? "done" : "failed");

  // Guards: budget stop report, 2 consecutive failures → paused + alert.
  if (result.status === "budget_stopped") await reportBudgetStop(pool, card, `per-run budget $${budget.runCap} reached`);
  const autoPaused = result.status === "failed" ? await pauseAfterTwoFailures(pool, card, log) : false;

  log("run.end", {
    agent_id: card.id,
    run_id: runId,
    status: result.status,
    cost_usd: result.costUsd,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    proposals: state.proposals,
    waiting: state.waiting,
    executed: state.executed,
    error: result.error,
  });
  return {
    runId,
    status: result.status,
    reason: result.error,
    shadow,
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    summary: result.text,
    proposals: state.proposals,
    waiting: state.waiting,
    executed: state.executed,
    autoPaused,
  };
}

async function recordSkip(pool: pg.Pool, card: LoadedCard, req: RunRequest, reason: string, status: string, shadow: boolean) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into hq.runs (agent_id, company_id, trigger, status, shadow, task_id, finished_at, summary)
     values ($1, $2, $3, $4, $5, $6, now(), $7) returning id::text`,
    [card.id, card.company, req.trigger, status, shadow, req.task?.id ?? null, reason],
  );
  return rows[0]!.id;
}

async function reportBudgetStop(pool: pg.Pool, card: LoadedCard, reason: string) {
  await pool.query("insert into hq.events (company_id, kind, payload) values ($1, 'budget.stopped', $2)", [
    card.company,
    JSON.stringify({ agent_id: card.id, reason }),
  ]);
  await setStatus((fn) => withCompanyRole(pool, card.company, fn), card, `stopped: ${reason}`, true);
}

/** Two consecutive failed runs (skips and budget stops don't count) → paused, and hq.chief is told. */
async function pauseAfterTwoFailures(pool: pg.Pool, card: LoadedCard, log: Logger): Promise<boolean> {
  const { rows } = await pool.query<{ status: string }>(
    `select status::text from hq.runs where agent_id = $1 and status in ('succeeded', 'failed')
      order by started_at desc, id desc limit 2`,
    [card.id],
  );
  if (rows.length < 2 || rows.some((r) => r.status !== "failed")) return false;
  const paused = await pool.query("update hq.agents set state = 'paused', updated_at = now() where id = $1 and state <> 'paused'", [card.id]);
  if (!paused.rowCount) return false;
  await pool.query("insert into hq.events (company_id, kind, payload) values ($1, 'agent.auto_paused', $2)", [
    card.company,
    JSON.stringify({ agent_id: card.id, reason: "2 consecutive failed runs" }),
  ]);
  await setStatus((fn) => withCompanyRole(pool, card.company, fn), card, "auto-paused after 2 failed runs", true);
  const chief = await pool.query("select 1 from hq.agents where id = 'hq.chief'");
  if (chief.rowCount) {
    await insertTask(pool, {
      fromAgent: null,
      toAgent: "hq.chief",
      companyId: "hq",
      payload: { alert: "agent.auto_paused", agent_id: card.id, reason: "2 consecutive failed runs" },
      hop: 0,
      parentTaskId: null,
    });
  }
  log("agent.auto_paused", { agent_id: card.id, chief_alerted: Boolean(chief.rowCount) });
  return true;
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200);
}
