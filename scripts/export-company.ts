// Usage: pnpm export-company <company_id> [out.sql]
// Writes one .sql file with everything that belongs to the company (spec §2 rule 2).
// Default output: exports/<id>-<timestamp>.sql (git-ignored). Needs pg_dump on PATH (or PG_DUMP=/path),
// with a major version >= the server's.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import { exportCompany } from "../engine/src/export/export-company.ts";
import { poolConfig } from "../engine/src/db/pool.ts";
import { loadDotEnv, requireEnv } from "./_env.ts";

loadDotEnv();
const id = process.argv[2];
if (!id) {
  console.error("usage: pnpm export-company <company_id> [out.sql]");
  process.exit(2);
}
const out = process.argv[3] ?? `exports/${id}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
const url = requireEnv("SUPABASE_DB_URL");

const client = new pg.Client(poolConfig(url));
await client.connect();
try {
  // Repeatable read: all hq rows come from one snapshot.
  await client.query("begin isolation level repeatable read read only");
  const sql = await exportCompany(client, id, { databaseUrl: url, pgDump: process.env.PG_DUMP });
  await client.query("commit");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, sql);
  console.log(`wrote ${out}`);
} finally {
  await client.end();
}
