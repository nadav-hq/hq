-- Invalid cards, for Health (M8). The loader upserts one row per invalid card file and
-- deletes the row once the card is valid again (or the file is gone). History goes to hq.events
-- (kinds `card.invalid` and `card.valid`).
--
-- `file` is repo-qualified: "<company_id>/agents/<role>.md", so it is unique across companies.

create table hq.card_errors (
  file       text primary key check (file ~ '^[a-z][a-z0-9-]{0,39}/'),
  company_id text not null references hq.companies(id),
  error      text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  check (split_part(file, '/', 1) = company_id)
);
create index card_errors_company on hq.card_errors (company_id);

alter table hq.card_errors enable row level security;
grant select on hq.card_errors to hq_company;
create policy company_read on hq.card_errors for select to hq_company using (company_id = hq.current_company_id());
create policy chief_read   on hq.card_errors for select to hq_company using (hq.is_chief());
