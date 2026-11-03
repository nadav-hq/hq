-- NADAV HQ core schema (spec §5).
-- Everything lives in schema `hq`. Per-company working tables live in schema "<company_id>" (created by hq.ensure_company_access, 0003).

create schema if not exists hq;

-- Nothing in hq is exposed to Supabase's API roles. The dashboard (M4) gets its own policies.
revoke all on schema hq from public;

create type hq.company_format as enum ('internal', 'solo', 'partner', 'external');
create type hq.member_role    as enum ('owner', 'partner');
create type hq.agent_state    as enum ('draft', 'shadow', 'active', 'paused', 'archived');
create type hq.task_status    as enum ('open', 'taken', 'done', 'failed', 'returned');
create type hq.approval_status as enum ('waiting', 'approved', 'rejected', 'executed', 'expired');
create type hq.run_status     as enum ('running', 'succeeded', 'failed', 'skipped');

create table hq.companies (
  id                text primary key check (id ~ '^[a-z][a-z0-9-]{0,39}$'),
  name              text not null,
  format            hq.company_format not null,
  budget_month_usd  numeric(10,2) not null default 0 check (budget_month_usd >= 0),
  anthropic_key_env text check (anthropic_key_env ~ '^[A-Z][A-Z0-9_]*$'),   -- env var NAME, never the key
  telegram_topic_id bigint,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  check (format <> 'partner' or anthropic_key_env is not null)
);

create table hq.company_members (
  id               bigint generated always as identity primary key,
  company_id       text not null references hq.companies(id) on delete cascade,
  telegram_user_id bigint,
  email            text,
  role             hq.member_role not null,
  created_at       timestamptz not null default now(),
  check (telegram_user_id is not null or email is not null),
  unique (company_id, telegram_user_id),
  unique (company_id, email)
);

create table hq.agents (
  id              text primary key check (id ~ '^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$'),
  company_id      text not null references hq.companies(id),
  card_version    text not null,              -- git sha of the last commit touching the card
  state           hq.agent_state not null default 'draft',
  last_run_at     timestamptz,
  shadow_runs     integer not null default 0 check (shadow_runs >= 0),
  shadow_approved integer not null default 0 check (shadow_approved >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (split_part(id, '.', 1) = company_id),
  unique (id, company_id)                     -- target for composite FKs below
);

-- Tables keyed by agent also carry company_id, pinned to the agent's company by a
-- composite FK. RLS filters on company_id directly; the FK makes it impossible to lie.

create table hq.runs (
  id          bigint generated always as identity primary key,
  agent_id    text not null,
  company_id  text not null,
  trigger     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      hq.run_status not null default 'running',
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  cost_usd    numeric(12,6) not null default 0,
  summary     text,
  error       text,
  foreign key (agent_id, company_id) references hq.agents(id, company_id)
);
create index runs_agent_started on hq.runs (agent_id, started_at desc);
create index runs_company_started on hq.runs (company_id, started_at desc);

create table hq.tasks (
  id             bigint generated always as identity primary key,
  from_agent     text,     -- no FK: may be hq.chief (other company) or null (from Nadav); keeps exports self-contained
  to_agent       text not null,
  company_id     text not null,              -- the company of to_agent
  payload        jsonb not null default '{}',
  status         hq.task_status not null default 'open',
  hop            integer not null default 0 check (hop >= 0),
  parent_task_id bigint references hq.tasks(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (to_agent, company_id) references hq.agents(id, company_id)
);
create index tasks_open on hq.tasks (to_agent, created_at) where status = 'open';

create table hq.approvals (
  id              bigint generated always as identity primary key,
  agent_id        text not null,
  company_id      text not null,
  action          text not null,
  payload         jsonb not null default '{}',
  idempotency_key text not null unique,
  shadow          boolean not null default false,   -- proposed by a shadow run; never executed (spec §6 step 2)
  status          hq.approval_status not null default 'waiting',
  decided_by      text,
  decided_at      timestamptz,
  reason          text,
  tg_message_id   bigint,
  executed_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (not (shadow and status = 'executed')),
  foreign key (agent_id, company_id) references hq.agents(id, company_id)
);
create index approvals_waiting on hq.approvals (created_at) where status = 'waiting';

create table hq.status (
  agent_id    text primary key,
  company_id  text not null,
  line        text not null,
  needs_owner boolean not null default false,
  updated_at  timestamptz not null default now(),
  foreign key (agent_id, company_id) references hq.agents(id, company_id)
);

create table hq.memory (
  id         bigint generated always as identity primary key,
  agent_id   text not null,
  company_id text not null,
  note       text not null,
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (agent_id, company_id) references hq.agents(id, company_id)
);
create index memory_agent_recent on hq.memory (agent_id, created_at desc) where deleted_at is null;

create table hq.events (
  id         bigint generated always as identity primary key,
  company_id text not null references hq.companies(id),
  kind       text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_company_kind on hq.events (company_id, kind, created_at desc);

-- Keys: `all_stopped` (global kill switch) and `stopped:<company_id>` (per company).
create table hq.settings (
  key        text primary key check (key !~ '^stopped' or key ~ '^stopped:[a-z][a-z0-9-]{0,39}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
