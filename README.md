# NADAV HQ

One agent headquarters for all of Nadav's companies. Full spec: [docs/NADAV_HQ_SPEC.md](docs/NADAV_HQ_SPEC.md).

## Layout (so far: M1)

| Path | What |
|---|---|
| `db/migrations/` | Plain numbered SQL. `hq` schema, per-company roles + schemas, RLS. |
| `shared/src/` | Card schema (zod), `company.yaml` schema, model ids (`config.ts`, the only place they live). |
| `engine/src/loader/` | Loads a company repo checkout, validates `company.yaml` + `agents/*.md`, upserts `hq.agents`. |
| `engine/src/db/` | Migration runner, `withCompanyRole` (run queries as a company's Postgres role). |
| `engine/src/export/` | Builds a single restorable `.sql` for one company. |
| `scripts/` | CLIs below. |

## Commands

```bash
pnpm install
cp .env.example .env    # fill in locally; production values live in Railway/Vercel

pnpm db:migrate                       # apply db/migrations to SUPABASE_DB_URL
pnpm db:seed                          # pseudo-company hq + owner, from env
pnpm cards:validate <company-dir>     # validate company.yaml + cards (exit 1 if invalid)
pnpm cards:sync <company-dir>         # validate; create the company if new; upsert agents + card_errors
pnpm export-company <id> [out.sql]    # one .sql with the company's schema + its hq.* rows (needs pg_dump 17)
pnpm typecheck
pnpm test                             # DB tests need TEST_DATABASE_URL (throwaway Postgres)
```

Requires Postgres 16+ (Supabase runs 17.11); `0001` fails with a clear error on older servers.

## Source of truth

- **Budgets and company settings: the DB.** `company.yaml` only sets the initial values when the loader
  first sees a company (it then also makes the HQ owners its owners). Later edits come from the dashboard
  or Telegram; the loader never overwrites an existing company row.
- **Agent state: the DB.** A card's `state` is used only when the agent is first inserted.
- **Invalid cards: `hq.card_errors`** (one row per file, `<company>/agents/<role>.md`), upserted by the loader
  and deleted once the card is valid. `card.invalid` / `card.valid` rows in `hq.events` keep the history.
  Health (M8) reads `card_errors`.

## Company isolation (spec §5)

- Each company gets a NOLOGIN Postgres role `co_<id>` (hyphens → underscores) and its own schema `"<id>"`.
- All company roles are members of `hq_company`. RLS policies on every `hq.*` table limit them to rows of
  `hq.current_company_id()`. They have no DELETE anywhere in `hq.*` and cannot touch other company schemas.
- `hq.chief` runs as `co_hq` (the `internal` pseudo-company `hq`): reads all of `hq.*`, writes only tasks to
  `<company>.manager` and its own memory.
- The engine runs agent queries inside `withCompanyRole(pool, companyId, fn)` (`SET LOCAL ROLE`).
  Agents never get raw SQL; the helper also detects role switches, rolls back and discards the connection.
  Decision (M1 review): keep this single login + `SET LOCAL ROLE`. Revisit per-company LOGIN roles only if
  a partner ever gets direct DB access.
- Settings keys: `all_stopped`, `stopped:<company_id>`. Companies can read the global key and their own, never write.
