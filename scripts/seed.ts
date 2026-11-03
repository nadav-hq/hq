// Usage: pnpm db:seed
// Creates the HQ pseudo-company `hq` and `hidden`, and Nadav as owner of both.
// All values come from env; nothing personal is committed. Safe to re-run.
import pg from "pg";
import { loadDotEnv, requireEnv } from "./_env.ts";

loadDotEnv();
const ownerEmail = requireEnv("OWNER_EMAIL");
const ownerTg = process.env.OWNER_TELEGRAM_USER_ID || null;
const hqBudget = Number(requireEnv("HQ_BUDGET_MONTH_USD"));
const hiddenBudget = Number(requireEnv("HIDDEN_BUDGET_MONTH_USD"));
for (const [k, v] of [["HQ_BUDGET_MONTH_USD", hqBudget], ["HIDDEN_BUDGET_MONTH_USD", hiddenBudget]] as const) {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
}

const client = new pg.Client({ connectionString: requireEnv("SUPABASE_DB_URL") });
await client.connect();
try {
  await client.query("begin");
  await client.query("select hq.create_company('hq', 'NADAV HQ', 'internal', $1)", [hqBudget]);
  await client.query("select hq.create_company('hidden', 'Hidden Library', 'solo', $1)", [hiddenBudget]);
  for (const company of ["hq", "hidden"]) {
    await client.query(
      `insert into hq.company_members (company_id, email, telegram_user_id, role)
       values ($1, $2, $3, 'owner')
       on conflict (company_id, email) do update set telegram_user_id = coalesce(excluded.telegram_user_id, hq.company_members.telegram_user_id)`,
      [company, ownerEmail, ownerTg],
    );
  }
  await client.query("commit");
  console.log("seeded companies: hq, hidden");
} catch (e) {
  await client.query("rollback");
  throw e;
} finally {
  await client.end();
}
