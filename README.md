# NADAV HQ

One agent headquarters for all of Nadav's companies. Full spec: [docs/NADAV_HQ_SPEC.md](docs/NADAV_HQ_SPEC.md).

## Layout (M1 + M2)

| Path | What |
|---|---|
| `db/migrations/` | Plain numbered SQL. `hq` schema, per-company roles + schemas, RLS. |
| `shared/src/` | Card schema (zod), `company.yaml` schema, model ids (`config.ts`, the only place they live). |
| `engine/src/loader/` | Loads a company repo checkout, validates `company.yaml` + `agents/*.md`, upserts `hq.agents`. |
| `engine/src/db/` | Migration runner, `withCompanyRole` (run queries as a company's Postgres role). |
| `engine/src/export/` | Builds a single restorable `.sql` for one company. |
| `engine/src/runner/` | M2 runner: the 8 run steps, tools, approvals, budgets, queue, Claude Agent SDK driver. |
| `engine/src/main.ts` | Railway start command (boot sync; idle in M2). Setup: [docs/RAILWAY.md](docs/RAILWAY.md). |
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
pnpm run-agent <agent_id> [--prompt "..."]   # sync the company's cards, run the agent once
pnpm queue:once [agent_id]            # take the oldest open task (SKIP LOCKED) and run its agent
pnpm approvals list [--all]           # approve <id> [reason] | reject <id> <reason>
pnpm kill-switch stop|resume all|<company>   # or: status
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

## Runner (spec §6, M2)

`runAgent()` in `engine/src/runner/run-agent.ts` runs one agent once. The engine enforces every step:

1. **Trigger:** `manual` / `message` (text from Nadav, trusted), `task` (payload wrapped as untrusted), or `cron`.
2. **State check:**
   - `paused`, `archived` or `draft` → skipped (its task is returned).
   - `all_stopped` or `stopped:<company>` → skipped.
   - **Budget:** the agent's month (`per_month_usd`) or the company's month (`budget_month_usd`), calendar month in Asia/Jerusalem. If either is used up → `budget_stopped`, plus an event and a `needs_owner` status. A missing Anthropic key → skipped.
3. **Load:** last `read_last` memory notes, read as the company role and wrapped as untrusted; only the card's tools, plus `memory_write` / `status_set`; the company's billing key.
4. **Work:** Claude Agent SDK. No built-in tools and no settings files; only our in-process MCP tools. `maxBudgetUsd` = min(per run, agent month left, company month left).
5. **Gate:**
   - Shadow → every side effect is stored as an approval with `shadow=true` and never executed.
   - Active → actions listed in the card's `approvals` (and every external action) wait for Nadav.
   - Approving a waiting approval executes it once: the executor runs in the same transaction that sets `approved → executed`.
   - The idempotency key is sha256(run, action, canonical payload), so the same proposal twice in one run is one row.
6. **Hand-off:**
   - Worker → its manager or another worker in the same company; manager → its workers; chief → managers.
   - `hop` = parent hop + 1. If `hop > 3`, no task is created: Nadav gets a `needs_owner` status and a `hop_limit` event.
7. **Close:** the agent writes memory and a status line; if it doesn't, the engine writes the status line.
8. **Record:** an `hq.runs` row with tokens, cost, summary, `shadow` and `task_id`.

Guards: 2 consecutive failed runs → `paused`, an `agent.auto_paused` event, a `needs_owner` status, and a task to `hq.chief` once that agent exists. Skips and budget stops don't count as failures. Logs are JSON lines.

Implemented tools (`shared/src/tool-catalog.ts`): `memory.write`, `status.set`, `db.read:<company>.<table>`, `db.write:<company>.<table>`, `queue.create_task`, `approval.request`, `test.ping`. The runner skips other tools named in cards (web, GitHub, Telegram) and logs them.

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
