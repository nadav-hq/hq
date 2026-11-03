import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

/**
 * Apply db/migrations/*.sql in filename order, each in its own transaction.
 * Applied files are recorded in hq.schema_migrations; already-applied files are skipped.
 */
export async function runMigrations(
  client: pg.ClientBase,
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  await client.query("create schema if not exists hq");
  await client.query(
    "create table if not exists hq.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(
    (await client.query<{ name: string }>("select name from hq.schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into hq.schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
    log(`applied ${f}`);
    applied.push(f);
  }
  return applied;
}
