# Railway: engine service + first shadow test run (M2)

M2 runs one test agent, `hidden.test`, once in **shadow** against the real Supabase project.
There's no scheduler, queue loop or Telegram yet. The service boots, syncs the hidden cards and stays idle.

## 1. Create the service

1. Railway → **New Project** → **Deploy from GitHub repo** → `nadav-hq/hq`.
   (If Railway doesn't list the repo, give the Railway GitHub app access to the `nadav-hq` org.)
2. Service → **Settings**:
   - **Root Directory**: leave empty (repo root). `railway.json` and `Dockerfile` are at the root.
   - **Builder**: Dockerfile (comes from `railway.json`).
   - **Pre-deploy command**: `pnpm railway:predeploy` (from `railway.json`). It runs the migrations, then the seed. Both are safe to repeat.
   - **Start command**: `pnpm engine:start` (from `railway.json`).
   - **Branch**: `main`. Deploy after merging the M2 PR, or temporarily point the service at the PR branch `claude/nice-feynman-g1k2gn`.
   - No public domain or port is needed.

## 2. Variables (Service → Variables)

Paste the values yourself; nothing goes into the repo.

| Name | Required | Value |
|---|---|---|
| `SUPABASE_DB_URL` | yes | Supabase → **Connect** → **Session pooler** URI (IPv4, port 5432, user `postgres.<project-ref>`), with your DB password. Don't use the direct `db.<ref>.supabase.co` host, which is IPv6-only. |
| `SUPABASE_CA_CERT` | recommended | Full PEM text of Supabase's root certificate: Supabase → Database settings → **SSL Configuration** → Download certificate, then paste the whole file. TLS is then verified. Without it, append `?sslmode=require&uselibpqcompat=true` to `SUPABASE_DB_URL` (encrypted, but the server certificate is not verified). |
| `ANTHROPIC_API_KEY` | yes | Your key (the $50/month-capped one). Used for solo companies (`hidden`). |
| `OWNER_EMAIL` | yes | Your email (seed: owner of `hq`, copied to new companies). |
| `OWNER_TELEGRAM_USER_ID` | optional | Your numeric Telegram id (needed in M3). |
| `HQ_BUDGET_MONTH_USD` | yes | `10` (hq.chief's company budget; initial value only). |
| `HQ_COMPANIES` | optional | `hidden` (default). Companies whose cards are synced on boot. |
| `HQ_RUN_ON_BOOT` | for the test | `hidden.test`: run this agent once after each deploy. **Remove it after the test**, or every restart runs it again. |

`PG_DUMP` is already set inside the image (pg_dump 17).

## 3. Run the shadow test

**Option A, no CLI (recommended):** set `HQ_RUN_ON_BOOT=hidden.test` and deploy (or redeploy). Then remove the variable.

**Option B, Railway CLI:** run `railway ssh` into the running service, then:

```bash
pnpm run-agent hidden.test
pnpm approvals list
pnpm approvals approve <id>
pnpm kill-switch status
```

`pnpm approvals approve <id>` on a shadow proposal only counts toward shadow stats; it never executes.

## 4. Where to read the logs

- **Pre-deploy (migrations + seed):** Deployments → the deployment → **Deploy Logs** (the top part). Look for `applied 000X_...` and `seeded company hq with owner`.
- **The run:** same **Deploy Logs**. Every line is JSON. Look for, in order:
  `engine.db_ok` → `cards.synced` → `run.trigger` → `run.start` → `approval.requested` (×2, `shadow: true`) → `run.end` → `run.result` → `engine.idle`.
- **Build problems:** **Build Logs**.

Send back the lines from `engine.db_ok` to `engine.idle`. They contain no secrets: ids, costs, token counts, statuses and the agent's summary.

## What a good shadow run looks like

- `run.result.status = "succeeded"`, `shadow: true`, `costUsd` > 0 and ≤ 0.05.
- `proposals`: 2 ids (the `test.ping` and the hand-off to `hidden.manager`), `executed: []`.
- In Supabase: one `hq.runs` row with tokens + cost, two `hq.approvals` rows with `shadow = true`, no `test.ping` event, no new task, one `hq.memory` note, one `hq.status` line.

If the key is missing, the run is **skipped** (`no Anthropic API key`) and doesn't count as a failure. Two real failures in a row auto-pause the agent. To un-pause after fixing the cause, run this in the Supabase SQL editor (M3 adds `/on` for this):

```sql
update hq.agents set state = 'shadow' where id = 'hidden.test';
```
