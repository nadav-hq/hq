import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../engine/src/db/migrate.ts";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

/**
 * Recreate a database named `name` on the TEST_DATABASE_URL server, owned by a
 * non-superuser with CREATEROLE (like Supabase's `postgres`), and migrate it as that user.
 * Returns the connection string for that user.
 */
export async function freshDatabase(name: string, migrate = true): Promise<string> {
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    const r = await admin.query("select 1 from pg_roles where rolname = 'hq_test_admin'");
    if (!r.rowCount) await admin.query("create role hq_test_admin login createrole password 'hq_test_admin'");
    await admin.query(`create database ${name} owner hq_test_admin`);
  } finally {
    await admin.end();
  }
  const u = new URL(TEST_DB_URL!);
  u.username = "hq_test_admin";
  u.password = "hq_test_admin";
  u.pathname = `/${name}`;
  const url = u.toString();
  if (migrate) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await runMigrations(c, MIGRATIONS_DIR);
    } finally {
      await c.end();
    }
  }
  return url;
}
