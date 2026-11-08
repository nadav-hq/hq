-- M2 runner additions.

-- A run the engine stopped because a budget (per run, agent month, company month) ran out.
-- Not a failure: it does not count toward the 2-failures auto-pause.
alter type hq.run_status add value if not exists 'budget_stopped';

alter table hq.runs
  add column shadow  boolean not null default false,   -- the agent was in shadow mode for this run
  add column task_id bigint references hq.tasks(id);   -- the task that triggered the run, if any

create index runs_agent_month on hq.runs (agent_id, started_at) where cost_usd > 0;

