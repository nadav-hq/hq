import { TIMEZONE } from "@hq/shared";
import type { Queryable } from "../db/pool.ts";

/** Start of the current calendar month in Asia/Jerusalem, as a SQL expression. */
const MONTH_START = `(date_trunc('month', now() at time zone '${TIMEZONE}') at time zone '${TIMEZONE}')`;

export type BudgetCheck = {
  agentSpent: number;
  agentLimit: number;
  companySpent: number;
  companyLimit: number;
  perRunLimit: number;
  /** Hard cap for this run: min(per run, agent remaining, company remaining). <= 0 means stop. */
  runCap: number;
  /** Which limit stops the run, if any. */
  stoppedBy: "agent_month" | "company_month" | null;
};

export async function checkBudget(
  db: Queryable,
  agentId: string,
  companyId: string,
  perRunUsd: number,
  perMonthUsd: number,
): Promise<BudgetCheck> {
  const { rows } = await db.query<{ agent: string; company: string; limit: string }>(
    `select
       coalesce((select sum(cost_usd) from hq.runs where agent_id = $1 and started_at >= ${MONTH_START}), 0) as agent,
       coalesce((select sum(cost_usd) from hq.runs where company_id = $2 and started_at >= ${MONTH_START}), 0) as company,
       (select budget_month_usd from hq.companies where id = $2) as limit`,
    [agentId, companyId],
  );
  const r = rows[0]!;
  const agentSpent = Number(r.agent);
  const companySpent = Number(r.company);
  const companyLimit = Number(r.limit);
  const agentLeft = perMonthUsd - agentSpent;
  const companyLeft = companyLimit - companySpent;
  const runCap = round6(Math.min(perRunUsd, agentLeft, companyLeft));
  return {
    agentSpent,
    agentLimit: perMonthUsd,
    companySpent,
    companyLimit,
    perRunLimit: perRunUsd,
    runCap,
    stoppedBy: agentLeft <= 0 ? "agent_month" : companyLeft <= 0 ? "company_month" : null,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
