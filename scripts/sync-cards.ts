// Usage: pnpm cards:sync <company-repo-dir>
// Validates the company's cards and upserts the valid ones into hq.agents.
import pg from "pg";
import { loadCompanyDir } from "../engine/src/loader/load-company.ts";
import { syncAgents } from "../engine/src/loader/sync.ts";
import { loadDotEnv, requireEnv } from "./_env.ts";

loadDotEnv();
const dir = process.argv[2];
if (!dir) {
  console.error("usage: pnpm cards:sync <company-repo-dir>");
  process.exit(2);
}
const loaded = await loadCompanyDir(dir);
for (const i of loaded.companyIssues) console.error(`✗ ${i.path}: ${i.message}`);
for (const c of loaded.invalid) console.error(`✗ ${c.file}: ${c.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
if (!loaded.company) process.exit(1);

const client = new pg.Client({ connectionString: requireEnv("SUPABASE_DB_URL") });
await client.connect();
try {
  await client.query("begin");
  const r = await syncAgents(client, loaded);
  await client.query("commit");
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  await client.query("rollback");
  throw e;
} finally {
  await client.end();
}
process.exit(loaded.invalid.length ? 1 : 0);
