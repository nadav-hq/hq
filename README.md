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
pnpm db:seed                          # companies hq + hidden, owner from env
pnpm cards:validate <company-dir>     # validate company.yaml + cards (exit 1 if invalid)
pnpm cards:sync <company-dir>         # validate, then upsert valid cards into hq.agents
pnpm export-company <id> [out.sql]    # one .sql with the company's schema + its hq.* rows
pnpm typecheck
pnpm test                             # DB tests need TEST_DATABASE_URL (throwaway Postgres)
```

## Company isolation (spec §5)

- Each company gets a NOLOGIN Postgres role `co_<id>` (hyphens → underscores) and its own schema `"<id>"`.
- All company roles are members of `hq_company`. RLS policies on every `hq.*` table limit them to rows of
  `hq.current_company_id()`. They have no DELETE anywhere in `hq.*` and cannot touch other company schemas.
- `hq.chief` runs as `co_hq` (the `internal` pseudo-company `hq`): reads all of `hq.*`, writes only tasks to
  `<company>.manager` and its own memory.
- The engine runs agent queries inside `withCompanyRole(pool, companyId, fn)` (`SET LOCAL ROLE`).
  Agents never get raw SQL; the helper also detects role switches, rolls back and discards the connection.
- Settings keys: `all_stopped`, `stopped:<company_id>`. Companies can read the global key and their own, never write.
