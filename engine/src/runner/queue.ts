import type { Queryable } from "../db/pool.ts";

export const MAX_HOP = 3;

export type TaskRow = {
  id: string;
  from_agent: string | null;
  to_agent: string;
  company_id: string;
  payload: Record<string, unknown>;
  hop: number;
  parent_task_id: string | null;
};

export async function insertTask(
  client: Queryable,
  t: { fromAgent: string | null; toAgent: string; companyId: string; payload: Record<string, unknown>; hop: number; parentTaskId: string | null },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into hq.tasks (from_agent, to_agent, company_id, payload, hop, parent_task_id)
     values ($1, $2, $3, $4, $5, $6) returning id::text`,
    [t.fromAgent, t.toAgent, t.companyId, JSON.stringify(t.payload), t.hop, t.parentTaskId],
  );
  return rows[0]!.id;
}

/** Queue worker pick (spec §6 component 3): one open task, never the same one twice. */
export async function takeNextTask(db: Queryable, toAgent?: string): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    `update hq.tasks set status = 'taken', updated_at = now()
      where id = (
        select id from hq.tasks
         where status = 'open' and ($1::text is null or to_agent = $1)
         order by created_at, id
         for update skip locked
         limit 1)
      returning id::text, from_agent, to_agent, company_id, payload, hop, parent_task_id::text`,
    [toAgent ?? null],
  );
  return rows[0] ?? null;
}

export async function finishTask(db: Queryable, id: string, status: "done" | "failed" | "open" | "returned"): Promise<void> {
  await db.query("update hq.tasks set status = $2, updated_at = now() where id = $1", [id, status]);
}
