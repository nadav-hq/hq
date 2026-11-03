import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Queryable } from "../db/pool.ts";

const exec = promisify(execFile);

/** hq tables holding company rows, in insert order (FK dependencies first). */
const HQ_TABLES: { table: string; where: string; order: string }[] = [
  { table: "companies", where: "id = $1", order: "id" },
  { table: "company_members", where: "company_id = $1", order: "id" },
  { table: "agents", where: "company_id = $1", order: "id" },
  { table: "runs", where: "company_id = $1", order: "id" },
  { table: "tasks", where: "company_id = $1", order: "id" },
  { table: "approvals", where: "company_id = $1", order: "id" },
  { table: "status", where: "company_id = $1", order: "agent_id" },
  { table: "memory", where: "company_id = $1", order: "id" },
  { table: "events", where: "company_id = $1", order: "id" },
  { table: "settings", where: "key = 'stopped:' || $1", order: "key" },
];

const IDENTITY_TABLES = ["company_members", "runs", "tasks", "approvals", "memory", "events"];

export type ExportOptions = {
  /** Connection string for pg_dump (same database as `client`). */
  databaseUrl: string;
  /** pg_dump binary; its major version must be >= the server's. */
  pgDump?: string;
};

/**
 * Build a single restorable .sql file for one company (spec §2 rule 2):
 *   1. its hq.companies row,
 *   2. its own schema "<id>" (DDL + data, via pg_dump),
 *   3. its rows from every other hq.* table,
 *   4. hq.ensure_company_access(<id>) to recreate its role and grants.
 * Restore with `psql -v ON_ERROR_STOP=1 -f <file>` into a database where db/migrations have been applied.
 */
export async function exportCompany(client: Queryable, companyId: string, opts: ExportOptions): Promise<string> {
  const { rows } = await client.query<{ format: string }>("select format from hq.companies where id = $1", [companyId]);
  const format = rows[0]?.format;
  if (!format) throw new Error(`unknown company "${companyId}"`);

  const out: string[] = [
    `-- NADAV HQ company export: ${companyId} (${format})`,
    `-- Generated ${new Date().toISOString()}`,
    "-- Restore: psql -v ON_ERROR_STOP=1 -f <this file>  (target must have db/migrations applied)",
    "",
    "begin;",
    "",
  ];

  const [companies, ...rest] = HQ_TABLES;
  out.push(...(await tableInserts(client, companies!, companyId)));

  if (format !== "internal") {
    out.push(`-- ---- schema "${companyId}" (pg_dump) ----`);
    const { stdout } = await exec(
      opts.pgDump ?? "pg_dump",
      ["--dbname", opts.databaseUrl, "--schema", `"${companyId}"`, "--no-owner", "--no-privileges", "--quote-all-identifiers"],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
    out.push(stripPsqlMeta(stdout), "set search_path = public;", "");
  }

  for (const t of rest) out.push(...(await tableInserts(client, t, companyId)));

  out.push("-- ---- identity sequences ----");
  for (const t of IDENTITY_TABLES) {
    out.push(
      `select setval(pg_get_serial_sequence('hq.${t}', 'id'), coalesce((select max(id) from hq.${t}), 0) + 1, false);`,
    );
  }
  out.push("", "-- ---- role, schema grants ----", `select hq.ensure_company_access(${literal(companyId)});`, "", "commit;", "");
  return out.join("\n");
}

async function tableInserts(
  client: Queryable,
  t: { table: string; where: string; order: string },
  companyId: string,
): Promise<string[]> {
  const overriding = IDENTITY_TABLES.includes(t.table) ? " overriding system value" : "";
  const { rows } = await client.query<{ stmt: string }>(
    `select format('insert into hq.%I${overriding} select * from json_populate_record(null::hq.%I, %L);',
                   '${t.table}', '${t.table}', row_to_json(x)::text) as stmt
       from hq.${t.table} x where ${t.where} order by ${t.order}`,
    [companyId],
  );
  return [`-- ---- hq.${t.table}: ${rows.length} row(s) ----`, ...rows.map((r) => r.stmt), ""];
}

/** pg_dump may emit psql meta-commands (\restrict in newer versions) that break inside our file. */
function stripPsqlMeta(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !/^\\(restrict|unrestrict)\b/.test(l))
    .join("\n");
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
