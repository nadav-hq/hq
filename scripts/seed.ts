// Usage: pnpm db:seed
// Creates the HQ pseudo-company `hq` (for hq.chief) with Nadav as owner.
// Real companies are created by the loader from their company.yaml (`pnpm cards:sync <dir>`),
// which also makes the HQ owners their owners. All values come from env. Safe to re-run.
import pg from "pg";
import { poolConfig } from "../engine/src/db/pool.ts";
import { loadDotEnv, requireEnv } from "./_env.ts";

loadDotEnv();
const ownerEmail = requireEnv("OWNER_EMAIL");
const ownerTg = process.env.OWNER_TELEGRAM_USER_ID || null;
const hqBudget = Number(requireEnv("HQ_BUDGET_MONTH_USD"));
if (!Number.isFinite(hqBudget) || hqBudget < 0) throw new Error("HQ_BUDGET_MONTH_USD must be a non-negative number");

const client = new pg.Client(poolConfig(requireEnv("SUPABASE_DB_URL")));
await client.connect();
try {
  await client.query("begin");
  // Initial value only: an existing hq row (and its budget) is left as is.
  await client.query("select hq.create_company('hq', 'NADAV HQ', 'internal', $1)", [hqBudget]);
  await client.query(
    `insert into hq.company_members (company_id, email, telegram_user_id, role)
     values ('hq', $1, $2, 'owner')
     on conflict (company_id, email) do update set telegram_user_id = coalesce(excluded.telegram_user_id, hq.company_members.telegram_user_id)`,
    [ownerEmail, ownerTg],
  );
  await client.query("commit");
  console.log("seeded company hq with owner");
} catch (e) {
  await client.query("rollback");
  throw e;
} finally {
  await client.end();
}
