-- Company isolation (spec §5 "RLS / keys"): one Postgres role per company.
--
--   hq_company        group role; every company role is a member. All company-scoped RLS
--                     policies are written once, against this group, using hq.current_company_id().
--   co_<id>           one NOLOGIN role per company (hyphens become underscores: media-li → co_media_li).
--                     The engine runs each agent inside `SET LOCAL ROLE co_<id>`.
--   co_hq             the HQ pseudo-company's role, used for hq.chief. Extra policies in 0003.
--
-- Company roles cannot SET ROLE to the group or to each other, so a worker physically
-- cannot read or write another company's rows or schema.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hq_company') then
    create role hq_company nologin;
  end if;
end $$;

alter table hq.companies add column db_role text unique;

create function hq.company_role_name(company_id text) returns text
language sql immutable as $$ select 'co_' || replace(company_id, '-', '_') $$;

-- Company of the role currently in effect (null for anything that is not a company role).
-- Two steps because inside a SECURITY DEFINER function current_user is the function owner:
-- the invoker function captures current_user, the definer function reads hq.companies past RLS.
create function hq.company_for_role(p_role name) returns text
language sql stable security definer set search_path = pg_catalog, hq as $$
  select id from hq.companies where db_role = p_role
$$;
revoke all on function hq.company_for_role(name) from public;
grant execute on function hq.company_for_role(name) to hq_company;

create function hq.current_company_id() returns text
language sql stable as $$ select hq.company_for_role(current_user) $$;

-- Idempotent: creates/refreshes the company role, its schema (not for `internal`), and grants.
-- Run as the migration/engine user (on Supabase: `postgres`, which has CREATEROLE).
create function hq.ensure_company_access(p_company_id text) returns void
language plpgsql as $$
declare
  v_role   text;
  v_format hq.company_format;
begin
  select format into v_format from hq.companies where id = p_company_id;
  if v_format is null then
    raise exception 'unknown company %', p_company_id;
  end if;
  if v_format = 'external' then
    raise exception 'company % is external and does not run in HQ', p_company_id;
  end if;

  v_role := hq.company_role_name(p_company_id);
  if not exists (select 1 from pg_roles where rolname = v_role) then
    execute format('create role %I nologin', v_role);
  end if;
  update hq.companies set db_role = v_role where id = p_company_id;

  -- The company role gets the group's privileges, but may not SET ROLE to the group.
  execute format('grant hq_company to %I with inherit true, set false', v_role);
  -- The connecting user (engine / migrations) may switch into the company role, and can read/dump
  -- objects the company role created in its schema.
  execute format('grant %I to %I with inherit true, set true', v_role, current_user);

  if v_format <> 'internal' then
    execute format('create schema if not exists %I', p_company_id);
    execute format('revoke all on schema %I from public', p_company_id);
    execute format('grant usage, create on schema %I to %I', p_company_id, v_role);
    execute format('grant all on all tables in schema %I to %I', p_company_id, v_role);
    execute format('grant all on all sequences in schema %I to %I', p_company_id, v_role);
    execute format('alter default privileges in schema %I grant all on tables to %I', p_company_id, v_role);
    execute format('alter default privileges in schema %I grant all on sequences to %I', p_company_id, v_role);
  end if;
end $$;

-- Convenience for seeding and `/company new` (M7).
create function hq.create_company(
  p_id text, p_name text, p_format hq.company_format, p_budget_month_usd numeric,
  p_anthropic_key_env text default null, p_telegram_topic_id bigint default null
) returns void
language plpgsql as $$
begin
  insert into hq.companies (id, name, format, budget_month_usd, anthropic_key_env, telegram_topic_id)
  values (p_id, p_name, p_format, p_budget_month_usd, p_anthropic_key_env, p_telegram_topic_id)
  on conflict (id) do nothing;
  perform hq.ensure_company_access(p_id);
end $$;
