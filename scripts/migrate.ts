// Usage: pnpm db:migrate
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../engine/src/db/migrate.ts";
import { loadDotEnv, requireEnv } from "./_env.ts";

loadDotEnv();
const client = new pg.Client({ connectionString: requireEnv("SUPABASE_DB_URL") });
await client.connect();
try {
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const applied = await runMigrations(client, dir, console.log);
  console.log(applied.length ? `done: ${applied.length} migration(s)` : "up to date");
} finally {
  await client.end();
}
