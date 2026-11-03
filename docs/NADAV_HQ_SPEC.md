# NADAV HQ — Build Spec

> For Claude Code. New GitHub org `nadav-hq`, repo `hq` (this spec) + one repo per company.
> Owner: Nadav. Read the whole file first. Work milestone by milestone (section 12), one PR per milestone, stop for review after each.
> Related: Hidden Library rebuild (`HAYDEN_REBUILD_SPEC.md`) is done; its jobs run in GitHub Actions in the Hidden Library site repo. HQ supervises them, it does not rebuild them.

---

## 1. What this is

One agent headquarters for all of Nadav's companies:
- **Agents are cards** (markdown + YAML) stored in each company's repo.
- **One engine** (Railway) loads the cards and runs the agents with Claude.
- **One database** (Supabase project `nadav-hq`) holds state, memory, task queue, approvals, runs and costs.
- **One Telegram group** is how Nadav talks to every agent in every company and approves actions.
- **One dashboard** (Vercel) shows everything.

Hierarchy: `hq.chief` → one manager per company (`<company>.manager`) → workers (`<company>.<role>`).

## 2. Company formats (multi-tenancy)

**Only Nadav operates HQ.** Partners exist in some companies but do not use HQ (no Telegram access, no dashboard login) for now. The format decides billing and how cleanly a company can be separated later, not who talks to the agents.

| Format | Companies today | Telegram | Billing | Separation |
|---|---|---|---|---|
| `solo` | milvado, hidden | Topic in the one group "NADAV HQ" | Nadav's Anthropic key | Not needed |
| `partner` | scola, media-li, tpr | Topic in the **same** group "NADAV HQ" | **Separate Anthropic API key per company** | Must be separable at any time (rules below) |
| `external` | shuki | Not in HQ. Shuki lives in PitStop's own HQ and Telegram, run by Nadav's partner there | — | — |

Rules for `partner` companies, so they can be split off at any time:
1. Own repo (transferable to the company's GitHub).
2. Own DB schema (exportable with one command, `scripts/export-company.ts <id>`).
3. Own Anthropic key and own budget, so costs are attributable per company.
4. `company_members` exists in the schema with only Nadav as `owner` today; partner access (Telegram or dashboard) can be added later without schema changes. Do not build partner UI now.

## 3. Repos

```
nadav-hq/
├── hq/
│   ├── engine/      → Railway: Telegram bot, scheduler, queue worker, agent runner
│   ├── dashboard/   → Vercel: Next.js
│   ├── db/          → SQL migrations, RLS policies
│   ├── shared/      → card schema, tool library, prompt fragments
│   ├── agents/      → hq.chief card (+ future control agents)
│   └── templates/company/  → skeleton for /company new
├── hidden/  agents/*.md · skills/*.md · tools/*.ts · company.yaml
├── milvado/ ...
└── (one per company)
```

`company.yaml`: `id`, `name`, `format`, `telegram_topic_id`, `budget_month_usd`, `anthropic_key_env` (partner).

The engine pulls company repos on deploy and on a GitHub push webhook (fine-grained token, contents:read on the org). A card change = a commit = a new card version.

## 4. Agent card

File: `<company-repo>/agents/<role>.md`. YAML frontmatter + markdown body (the instructions).

```yaml
---
id: hidden.seo              # <company>.<role>, unique
name: SEO and GEO
company: hidden
reports_to: hidden.manager
state: shadow               # draft | shadow | active | paused | archived  (DB overrides at runtime)
model: sonnet               # opus | sonnet | haiku → resolved in shared/config.ts
tools:                      # names from shared/tools or <repo>/tools
  - web_search
  - gsc.read
  - db.read:hidden.products
  - db.write:hidden.recommendations
  - queue.create_task
triggers:
  - cron: "0 7 * * 1"       # Asia/Jerusalem
  - cron: "0 7 1 * *"
  - task                    # tasks from its manager
  - message                 # direct mention in Telegram
approvals:                  # actions that always go to the approvals table
  - site.change
budget:
  per_run_usd: 0.50
  per_month_usd: 15
memory:
  read_last: 20             # notes loaded at start
---
# Instructions (markdown)
...
```

Validation: `shared/card-schema.ts` (zod). The engine refuses to load an invalid card and reports it in Health.

## 5. Database (`hq` schema, Supabase, Frankfurt)

| Table | Key columns |
|---|---|
| `companies` | id, name, format, budget_month_usd, active |
| `company_members` | company_id, telegram_user_id, email, role (`owner` \| `partner`) |
| `agents` | id, company_id, card_version (git sha), state, last_run_at, shadow_runs, shadow_approved |
| `runs` | id, agent_id, trigger, started_at, finished_at, status, tokens_in, tokens_out, cost_usd, summary, error |
| `tasks` | id, from_agent, to_agent, company_id, payload, status (`open` \| `taken` \| `done` \| `failed` \| `returned`), hop, parent_task_id |
| `approvals` | id, agent_id, company_id, action, payload, idempotency_key, status (`waiting` \| `approved` \| `rejected` \| `executed` \| `expired`), decided_by, reason, tg_message_id |
| `status` | agent_id (pk), line, needs_owner (bool), updated_at |
| `memory` | id, agent_id, note, created_at, pinned, deleted_at |
| `events` | id, company_id, kind, payload, created_at (inputs for event triggers) |
| `settings` | key, value (`all_stopped`, per-company `stopped`) |

Per-company working tables live in schema `<company_id>` (e.g. `hidden.recommendations`).

**RLS / keys:** the engine runs each agent with a per-company Postgres role (or service key scoped by RLS on `company_id`) so a worker physically cannot read/write another company. `hq.chief` gets read on all `hq.*`, write only on `tasks` (to managers) and its own `memory`. Dashboard uses Supabase Auth, Nadav only.

## 6. Engine (`hq/engine`, Node/TypeScript, Railway)

Components in one process:
1. **Card loader**: pulls repos, validates cards, upserts `agents`.
2. **Scheduler**: node-cron per card trigger, timezone Asia/Jerusalem.
3. **Queue worker**: picks `tasks` with `FOR UPDATE SKIP LOCKED`.
4. **Telegram bot** (grammY): routes messages by chat + topic + @mention.
5. **Runner**: runs one agent once (8 steps below). Built on the **Claude Agent SDK** (TypeScript), tools exposed as SDK tools/MCP.

Run steps (enforced by the engine, not the model):
1. Trigger fires.
2. State check: `paused`/`archived` → skip; `settings.all_stopped` or company stopped → skip. `shadow` → run, but every side-effect tool returns "proposed" and writes an approval with `shadow=true` instead of executing.
3. Load: card, last N memory notes, company-scoped DB credentials, only the tools in the card.
4. Work: Claude with the card body as system prompt. Content from the web, email or files is wrapped and labeled as untrusted data.
5. Gate: any tool listed in `approvals` (and every external send/publish/pay) creates an `approvals` row and posts to Telegram with Approve / Reject buttons. Execution happens only after approval, exactly once (idempotency_key).
6. Hand-off: `queue.create_task` only to allowed targets (worker → its manager or next worker in same company; manager → its workers; chief → managers). `hop > 3` → stop and send to Nadav.
7. Close: agent writes memory notes + one status line.
8. Record: `runs` row with tokens and cost.

Guards: budget per run and per month (stop + report), 2 consecutive failures → auto `paused` + alert to `hq.chief`, structured logs.

## 7. Telegram

**One group, "NADAV HQ", with forum topics:** General → `hq.chief`; one topic per company (solo and partner alike) → that company's manager. Only Nadav's Telegram user is allowed; the bot ignores everyone else.

**Addressing any agent from the same group** (Telegram bots cannot have one username per agent, so the bot parses the text):
| What Nadav types | Goes to |
|---|---|
| plain message in a company topic | that company's manager |
| plain message in General | `hq.chief` |
| `@scout ...` inside the Hidden topic | `hidden.scout` (short role name resolves inside the topic's company) |
| `@hidden.scout ...` anywhere | `hidden.scout` (full id works from any topic) |
| `/hidden_scout ...` anywhere | `hidden.scout` (slash form; dots become underscores) |

- The bot registers its command menu from the loaded cards (`setMyCommands`), so typing `/` shows every active agent and command with autocomplete. Re-register when cards change.
- The answer is posted in the topic where the question was asked, prefixed with the agent's name.
- A worker addressed directly answers and also logs the exchange for its manager (managers are never bypassed silently).
- Approval messages carry Approve / Reject (+ reason reply), posted in the company's topic.

Commands:

| Command | Effect |
|---|---|
| `/new <company> <one line role>` | manager drafts a card from the template → PR to the company repo → on merge the agent appears in `shadow` |
| `/on <agent>` | shadow → active (shows shadow stats first) |
| `/off <agent>` | → paused; its open tasks return to its manager |
| `/edit <agent> <change>` | manager proposes a card diff as a PR |
| `/merge <a> <b>` | merged card as PR, starts in shadow; on `/on`, a and b archived, memory copied |
| `/clone <agent> <company>` | copy card to another company, empty memory, shadow |
| `/archive <agent>` · `/restore <agent>` | archive keeps memory and history; restore → paused |
| `/run <agent>` | run now |
| `/stop all` · `/stop <company>` · `/resume ...` | kill switch |
| `/company new <id> <format>` | repo from template, schema, new topic in the group, manager in shadow; `partner` also requires an `anthropic_key_env` |
| `/status [company]` | one line per agent (in a company topic: that company only) |
| `/agents` | list of all agents with state, grouped by company |

## 8. Dashboard (`hq/dashboard`, Next.js, Vercel, Supabase Auth)

Header line on every screen: agents running now · approvals waiting · month spend · open problems.

| Screen | Shows | Actions |
|---|---|---|
| Live map | hierarchy graph, running agents pulse, tasks as edges, color by state; filter hour/day/week; replay | click → agent card |
| Waiting for you | approvals oldest first | approve, reject with reason |
| Agent | 7 components, state, recent runs, cost, shadow approval rate, memory | on, off, shadow, archive, run now, delete a memory note |
| Costs | per company and agent vs budget, month to date | change budget |
| Health | failures, paused agents, broken connections, invalid cards, agents with no value in 30 days | retry, open card |

Nadav only. Same actions as in Telegram, same permission rules. Costs screen splits by billing key (Nadav vs each partner company).

## 9. Shared tool library (`hq/shared/tools`)

Start with: `web_search`, `web_fetch`, `db.read:<table>`, `db.write:<table>`, `queue.create_task`, `approval.request`, `telegram.notify`, `memory.write`, `github.trigger_workflow:<repo>/<workflow>`, `github.open_pr:<repo>`. Every tool checks the calling agent's company and card before doing anything.

## 10. Hidden Library inside HQ (first company)

Hidden Library's production routines already exist in the site repo (GitHub Actions: scout, produce, optimize; state in the site's Supabase). HQ adds a supervising layer, not a second pipeline:
- `hidden.manager` (opus): reads the site's `job_runs`, `topic_candidates`, `products`, `pins`, `optimization_log` (read-only key); can trigger the site workflows (`github.trigger_workflow`, fine-grained token: actions:write on that repo only); can toggle the site's `settings.pipeline_enabled` and `require_approval` (approval required); posts a weekly summary to the Hidden topic.
- `hidden.seo` (sonnet, shadow first): Search Console page-2 queries + AI-engine visibility checks → recommendations in `hidden.recommendations` → manager forwards to the site's optimize job.
- The other Hidden Library roles (scout/writer/designer/publisher) are **not separate HQ agents** now: they are the site's jobs. Represent them on the map as "routines" (read from `job_runs`), not as agents.

## 11. hq.chief and the morning brief

- 07:30 Asia/Jerusalem daily, plus messages in General, plus approvals waiting > 24 h.
- Reads `status`, `runs` (last 24 h), `approvals`, `companies`; per company 1–3 lines; then "waiting for you"; then 3 decisions for today. ≤ 25 lines.
- All HQ companies (solo and partner) appear in the brief, grouped by company.

## 12. Milestones (one PR each, stop for review)

| # | Milestone | Done when |
|---|---|---|
| M0 | Accounts (Nadav) | Railway Hobby, org `nadav-hq` with `hq` + `hidden`, Supabase `nadav-hq` (Frankfurt), Anthropic key with $50 monthly cap, Telegram bot (BotFather) + one group "NADAV HQ" with topics enabled (General, Hidden; other company topics are created by `/company new`), bot admin |
| M1 | DB + cards | Migrations + RLS; card schema; loader validates `hidden` cards; `scripts/export-company.ts` |
| M2 | Engine core | Runner with the 8 steps, budget, shadow, approvals, idempotency, kill switch; a test agent runs end to end from CLI |
| M3 | Telegram | Routing by group/topic/mention, approve buttons, all commands in section 7, roles |
| M4 | Dashboard v1 | Header line, Waiting for you, Agent screen, Costs. Live map can be a simple tree in v1 |
| M5 | Hidden Library in HQ | `hidden.manager` + `hidden.seo` in shadow, workflows triggered from Telegram, weekly summary |
| M6 | Chief | `hq.chief` + morning brief at 07:30 |
| M7 | Formats | `/company new` for solo and partner; partner = separate key + exportable schema, tested with a dummy company and `export-company` |
| M8 | Live map + Health | Full map with replay, Health screen |

After M8: Milvado (solo), then TPR (first partner-format company), Media Li, Scola. Each from the cards in "אפיון סוכני NADAV HQ".

## 13. Ground rules

- No secrets in repos. `.env.example` lists names only. Railway/Vercel hold values.
- Every side effect idempotent and recorded before the next step.
- Model ids only in `shared/config.ts`.
- English for code and logs; agent-facing Telegram text in Hebrew unless the card says otherwise.
- Tests for: permission checks (cross-company read/write must fail), hop limit, budget stop, shadow never executes, approval executes once.

## 14. Open questions (ask Nadav, do not guess)

1. For each partner-format company (Scola, Media Li, TPR): which Anthropic account/key pays for it?
2. Morning brief time 07:30 OK? Days (Sun–Thu or daily)?
3. Total monthly cap across all companies.

Resolved: one Telegram group for everything; only Nadav operates HQ; Shuki stays in PitStop's HQ.
