-- Row-level security on every hq table.
-- The connecting user (table owner: migrations/engine) is not subject to RLS.
-- Company roles (members of hq_company) see and write only rows of hq.current_company_id().
-- hq.chief runs as co_hq: read on all of hq.*, write only tasks to managers + its own memory.

grant usage on schema hq to hq_company;

alter table hq.companies       enable row level security;
alter table hq.company_members enable row level security;
alter table hq.agents          enable row level security;
alter table hq.runs            enable row level security;
alter table hq.tasks           enable row level security;
alter table hq.approvals       enable row level security;
alter table hq.status          enable row level security;
alter table hq.memory          enable row level security;
alter table hq.events          enable row level security;
alter table hq.settings        enable row level security;

-- ---------- Table privileges for company roles (rows are then filtered by RLS) ----------
grant select                 on hq.companies, hq.company_members, hq.agents, hq.runs, hq.settings to hq_company;
grant select, insert, update on hq.tasks, hq.approvals, hq.status, hq.memory to hq_company;
grant select, insert         on hq.events to hq_company;
grant usage on all sequences in schema hq to hq_company;

-- ---------- Company-scoped policies (every company role, including co_hq for its own rows) ----------
create policy company_read on hq.companies       for select to hq_company using (id = hq.current_company_id());
create policy company_read on hq.company_members for select to hq_company using (company_id = hq.current_company_id());
create policy company_read on hq.agents          for select to hq_company using (company_id = hq.current_company_id());
create policy company_read on hq.runs            for select to hq_company using (company_id = hq.current_company_id());
create policy company_read on hq.events          for select to hq_company using (company_id = hq.current_company_id());

-- Kill switches: a company sees the global one and its own, nothing else. Read-only.
create policy company_read on hq.settings for select to hq_company
  using (key = 'all_stopped' or key = 'stopped:' || hq.current_company_id());

-- Workers write within their own company. co_hq is excluded here and gets narrower rules below.
create policy company_rw on hq.tasks for all to hq_company
  using      (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq')
  with check (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq');
create policy company_rw on hq.approvals for all to hq_company
  using      (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq')
  with check (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq');
create policy company_rw on hq.status for all to hq_company
  using      (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq')
  with check (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq');
create policy company_rw on hq.memory for all to hq_company
  using      (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq')
  with check (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq');
create policy company_insert on hq.events for insert to hq_company
  with check (company_id = hq.current_company_id() and hq.current_company_id() <> 'hq');

-- ---------- hq.chief (co_hq) ----------
create function hq.is_chief() returns boolean
language sql stable as $$ select hq.current_company_id() = 'hq' $$;

-- Read everything in hq.*.
create policy chief_read on hq.companies       for select to hq_company using (hq.is_chief());
create policy chief_read on hq.company_members for select to hq_company using (hq.is_chief());
create policy chief_read on hq.agents          for select to hq_company using (hq.is_chief());
create policy chief_read on hq.runs            for select to hq_company using (hq.is_chief());
create policy chief_read on hq.tasks           for select to hq_company using (hq.is_chief());
create policy chief_read on hq.approvals       for select to hq_company using (hq.is_chief());
create policy chief_read on hq.status          for select to hq_company using (hq.is_chief());
create policy chief_read on hq.memory          for select to hq_company using (hq.is_chief());
create policy chief_read on hq.events          for select to hq_company using (hq.is_chief());
create policy chief_read on hq.settings        for select to hq_company using (hq.is_chief());

-- Write: tasks from hq.chief to a company manager only.
create policy chief_task_insert on hq.tasks for insert to hq_company
  with check (hq.is_chief() and from_agent = 'hq.chief' and to_agent = company_id || '.manager');

-- Write: its own memory only.
create policy chief_memory_insert on hq.memory for insert to hq_company
  with check (hq.is_chief() and agent_id = 'hq.chief');
create policy chief_memory_update on hq.memory for update to hq_company
  using (hq.is_chief() and agent_id = 'hq.chief')
  with check (hq.is_chief() and agent_id = 'hq.chief');
