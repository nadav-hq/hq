import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "../engine/src/db/pool.ts";
import { loadCompanyDir, type CompanyLoadResult } from "../engine/src/loader/load-company.ts";
import { syncAgents } from "../engine/src/loader/sync.ts";
import { log } from "../engine/src/log.ts";
import { loadDotEnv, requireEnv } from "./_env.ts";

export { log };

export function openPool(): pg.Pool {
  loadDotEnv();
  return createPool(requireEnv("SUPABASE_DB_URL"));
}

/**
 * Where a company's repo checkout lives. M2: env COMPANY_DIR_<ID> (e.g. COMPANY_DIR_HIDDEN), else the
 * test fixture in this repo. Pulling company repos from GitHub comes with the engine service.
 */
export function companyDir(companyId: string): string {
  const env = process.env[`COMPANY_DIR_${companyId.toUpperCase().replace(/-/g, "_")}`];
  return env || fileURLToPath(new URL(`../engine/test/fixtures/${companyId}`, import.meta.url));
}

/** Load + validate + sync a company (company row, agents, card_errors) in one transaction. */
export async function loadAndSync(pool: pg.Pool, companyId: string): Promise<CompanyLoadResult> {
  const dir = companyDir(companyId);
  const loaded = await loadCompanyDir(dir);
  for (const i of loaded.companyIssues) log("cards.company_invalid", { dir, path: i.path, message: i.message });
  if (!loaded.company) throw new Error(`${dir}: company.yaml is invalid`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await syncAgents(client, loaded);
    await client.query("commit");
    log("cards.synced", { company: companyId, dir, ...r });
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  return loaded;
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
