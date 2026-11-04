import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCompanyRole } from "../engine/src/db/pool.ts";
import { exportCompany } from "../engine/src/export/export-company.ts";
import { loadCompanyDir } from "../engine/src/loader/load-company.ts";
import { syncAgents } from "../engine/src/loader/sync.ts";
import { freshDatabase, TEST_DB_URL } from "./db.ts";

const exec = promisify(execFile);
const HIDDEN = fileURLToPath(new URL("../engine/test/fixtures/hidden", import.meta.url));
const PG_DUMP = process.env.PG_DUMP || "pg_dump";
const PSQL = process.env.PSQL || "psql";

describe.skipIf(!TEST_DB_URL)("loader sync + export-company", () => {
  let url: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    url = await freshDatabase("hq_test_sync");
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`
      select hq.create_company('hq', 'NADAV HQ', 'internal', 5);
      select hq.create_company('hidden', 'Hidden Library', 'solo', 20);
      select hq.create_company('milvado', 'Milvado', 'solo', 10);
      insert into hq.agents (id, company_id, card_version) values ('hq.chief', 'hq', 'v'), ('milvado.manager', 'milvado', 'v');
    `);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("upserts valid cards; DB state wins; new commit = new version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-hidden-"));
    await cp(HIDDEN, dir, { recursive: true });
    const git = (...a: string[]) => exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
    await git("init", "-q");
    await git("add", ".");
    await git("commit", "-qm", "cards");

    const first = await syncAgents(pool, await loadCompanyDir(dir));
    expect(first.inserted).toEqual(["hidden.manager", "hidden.seo", "hidden.test"]);
    const { rows } = await pool.query("select id, state, card_version from hq.agents where company_id = 'hidden' order by id");
    expect(rows.map((r) => r.state)).toEqual(["draft", "shadow", "shadow"]);
    expect(rows[0].card_version).toMatch(/^[0-9a-f]{40}$/);

    const again = await syncAgents(pool, await loadCompanyDir(dir));
    expect(again.unchanged).toEqual(["hidden.manager", "hidden.seo", "hidden.test"]);

    // Nadav turns seo on; then the card changes in a new commit.
    await pool.query("update hq.agents set state = 'active' where id = 'hidden.seo'");
    await writeFile(join(dir, "agents/seo.md"), (await readFile(join(HIDDEN, "agents/seo.md"), "utf8")) + "\nMore.\n");
    await git("commit", "-qam", "edit seo");
    const third = await syncAgents(pool, await loadCompanyDir(dir));
    expect(third.updated).toEqual(["hidden.seo"]);
    expect(third.unchanged).toEqual(["hidden.manager", "hidden.test"]);
    const seo = (await pool.query("select state, card_version from hq.agents where id = 'hidden.seo'")).rows[0];
    expect(seo.state).toBe("active");
    expect(seo.card_version).not.toBe(rows[1].card_version);
  });

  it("refuses to sync when company.yaml's format differs from the DB", async () => {
    const loaded = await loadCompanyDir(HIDDEN);
    await expect(syncAgents(pool, { ...loaded, company: { ...loaded.company!, format: "partner", anthropic_key_env: "X" } })).rejects.toThrow(/format/);
  });

  it("creates a missing company from company.yaml once; afterwards the DB budget wins", async () => {
    await pool.query("insert into hq.company_members (company_id, email, role) values ('hq', 'nadav@example.com', 'owner')");
    const dir = await mkdtemp(join(tmpdir(), "hq-acme-"));
    await mkdir(join(dir, "agents"));
    const yaml = (budget: number) => `id: acme\nname: Acme\nformat: solo\nbudget_month_usd: ${budget}\n`;
    await writeFile(join(dir, "company.yaml"), yaml(7));
    const first = await syncAgents(pool, await loadCompanyDir(dir));
    expect(first.companyCreated).toBe(true);
    const company = async () =>
      (await pool.query("select budget_month_usd::float b, db_role from hq.companies where id = 'acme'")).rows[0];
    expect(await company()).toEqual({ b: 7, db_role: "co_acme" });
    expect((await pool.query("select email, role from hq.company_members where company_id = 'acme'")).rows).toEqual([
      { email: "nadav@example.com", role: "owner" },
    ]);
    // Budget changed in the dashboard, then company.yaml edited: the DB value stays.
    await pool.query("update hq.companies set budget_month_usd = 12 where id = 'acme'");
    await writeFile(join(dir, "company.yaml"), yaml(99));
    const second = await syncAgents(pool, await loadCompanyDir(dir));
    expect(second.companyCreated).toBe(false);
    expect((await company()).b).toBe(12);
  });

  it("tracks invalid cards in hq.card_errors and clears them when fixed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-cards-"));
    await cp(HIDDEN, dir, { recursive: true });
    const seo = await readFile(join(HIDDEN, "agents/seo.md"), "utf8");
    const errors = async () =>
      (await pool.query("select file, error, first_seen, last_seen from hq.card_errors where company_id = 'hidden' order by file")).rows;
    const events = async () =>
      (await pool.query("select kind, payload->>'file' f from hq.events where kind like 'card.%' order by id")).rows;

    await writeFile(join(dir, "agents/seo.md"), seo.replace("model: sonnet", "model: gpt"));
    await writeFile(join(dir, "agents/bad.md"), "no frontmatter");
    let r = await syncAgents(pool, await loadCompanyDir(dir));
    expect(r.cardErrors.added).toEqual(["hidden/agents/bad.md", "hidden/agents/seo.md"]);
    const e1 = await errors();
    expect(e1.map((e) => e.file)).toEqual(["hidden/agents/bad.md", "hidden/agents/seo.md"]);
    expect(e1[1].error).toContain("model");

    // Same errors again: last_seen moves, no new events.
    r = await syncAgents(pool, await loadCompanyDir(dir));
    expect(r.cardErrors.unchanged).toHaveLength(2);
    const e2 = await errors();
    expect(e2[0].first_seen).toEqual(e1[0].first_seen);
    expect(e2[0].last_seen.getTime()).toBeGreaterThanOrEqual(e1[0].last_seen.getTime());
    expect(await events()).toHaveLength(2);

    // seo gets a different error, bad.md is deleted.
    await writeFile(join(dir, "agents/seo.md"), seo.replace("state: shadow", "state: live"));
    await rm(join(dir, "agents/bad.md"));
    r = await syncAgents(pool, await loadCompanyDir(dir));
    expect(r.cardErrors).toEqual({ added: [], changed: ["hidden/agents/seo.md"], unchanged: [], cleared: ["hidden/agents/bad.md"] });

    // seo fixed.
    await writeFile(join(dir, "agents/seo.md"), seo);
    r = await syncAgents(pool, await loadCompanyDir(dir));
    expect(r.cardErrors.cleared).toEqual(["hidden/agents/seo.md"]);
    expect(await errors()).toEqual([]);
    expect(await events()).toEqual([
      { kind: "card.invalid", f: "hidden/agents/bad.md" },
      { kind: "card.invalid", f: "hidden/agents/seo.md" },
      { kind: "card.invalid", f: "hidden/agents/seo.md" },
      { kind: "card.valid", f: "hidden/agents/bad.md" },
      { kind: "card.valid", f: "hidden/agents/seo.md" },
    ]);

    // Leave one error behind for the export test; company roles see only their own.
    await writeFile(join(dir, "agents/bad.md"), "no frontmatter");
    await syncAgents(pool, await loadCompanyDir(dir));
    await withCompanyRole(pool, "milvado", async (c) => {
      expect((await c.query("select count(*)::int n from hq.card_errors")).rows[0].n).toBe(0);
    });
    await withCompanyRole(pool, "hq", async (c) => {
      expect((await c.query("select count(*)::int n from hq.card_errors")).rows[0].n).toBe(1);
    });
  });

  it("exports one company to a .sql file that restores into an empty HQ database", async () => {
    // Activity in hidden and in milvado (which must not leak into the export).
    await withCompanyRole(pool, "hidden", async (c) => {
      await c.query("create table hidden.recommendations (id serial primary key, note text)");
      await c.query("insert into hidden.recommendations (note) values ('rec 1'), ('rec 2')");
      await c.query("insert into hq.memory (agent_id, company_id, note) values ('hidden.seo', 'hidden', 'remember')");
      await c.query("insert into hq.tasks (from_agent, to_agent, company_id) values ('hidden.manager', 'hidden.seo', 'hidden')");
      await c.query("insert into hq.approvals (agent_id, company_id, action, idempotency_key) values ('hidden.seo', 'hidden', 'site.change', 'exp-1')");
      await c.query("insert into hq.status (agent_id, company_id, line) values ('hidden.seo', 'hidden', 'ok')");
      await c.query("insert into hq.events (company_id, kind) values ('hidden', 'gsc.weekly')");
    });
    await withCompanyRole(pool, "hq", (c) =>
      c.query("insert into hq.tasks (from_agent, to_agent, company_id) values ('hq.chief', 'hidden.manager', 'hidden')"),
    );
    await pool.query(`
      insert into hq.runs (agent_id, company_id, trigger, cost_usd) values ('hidden.seo', 'hidden', 'cron', 0.12), ('milvado.manager', 'milvado', 'cron', 1);
      insert into hq.memory (agent_id, company_id, note) values ('milvado.manager', 'milvado', 'milvado only');
      insert into hq.company_members (company_id, email, role) values ('hidden', 'owner@example.com', 'owner');
      insert into hq.settings (key, value) values ('stopped:hidden', 'false'), ('stopped:milvado', 'true');
    `);

    const sql = await exportCompany(pool, "hidden", { databaseUrl: url, pgDump: PG_DUMP });
    expect(sql).not.toContain("milvado");
    const file = join(await mkdtemp(join(tmpdir(), "hq-export-")), "hidden.sql");
    await writeFile(file, sql);

    const target = await freshDatabase("hq_test_restore");
    await exec(PSQL, ["-v", "ON_ERROR_STOP=1", "-q", "-d", target, "-f", file]);

    const t = new pg.Pool({ connectionString: target });
    try {
      const q = async (s: string) => (await t.query(s)).rows;
      expect(await q("select id, format, budget_month_usd::float b from hq.companies")).toEqual([{ id: "hidden", format: "solo", b: 20 }]);
      expect((await q("select id from hq.agents order by id")).map((r) => r.id)).toEqual(["hidden.manager", "hidden.seo", "hidden.test"]);
      expect(await q("select count(*)::int n from hq.tasks")).toEqual([{ n: 2 }]);
      expect(await q("select note from hq.memory")).toEqual([{ note: "remember" }]);
      expect(await q("select count(*)::int n from hq.runs")).toEqual([{ n: 1 }]);
      expect(await q("select key from hq.settings")).toEqual([{ key: "stopped:hidden" }]);
      expect(await q("select count(*)::int n from hq.approvals")).toEqual([{ n: 1 }]);
      expect(await q("select count(*)::int n from hq.status")).toEqual([{ n: 1 }]);
      expect(await q("select count(*)::int n from hq.events where kind = 'gsc.weekly'")).toEqual([{ n: 1 }]);
      expect(await q("select file from hq.card_errors")).toEqual([{ file: "hidden/agents/bad.md" }]);
      expect(await q("select count(*)::int n from hq.company_members")).toEqual([{ n: 1 }]);
      expect((await q("select note from hidden.recommendations order by id")).map((r) => r.note)).toEqual(["rec 1", "rec 2"]);
      // identity sequences continue after restored ids; company role works on the target
      await t.query("insert into hq.memory (agent_id, company_id, note) values ('hidden.seo', 'hidden', 'after restore')");
      await withCompanyRole(t, "hidden", async (c) => {
        await c.query("insert into hidden.recommendations (note) values ('rec 3')");
        expect((await c.query("select count(*)::int n from hq.memory")).rows[0].n).toBe(2);
      });
    } finally {
      await t.end();
    }
  });

  it("refuses a pg_dump older than the server", async () => {
    const fake = join(await mkdtemp(join(tmpdir(), "hq-pgdump-")), "pg_dump");
    await writeFile(fake, "#!/bin/sh\necho 'pg_dump (PostgreSQL) 15.8'\n");
    await chmod(fake, 0o755);
    await expect(exportCompany(pool, "hidden", { databaseUrl: url, pgDump: fake })).rejects.toThrow(/version 15, server is \d+/);
  });

  it("refuses unknown companies", async () => {
    await expect(exportCompany(pool, "nope", { databaseUrl: url })).rejects.toThrow(/unknown company/);
  });
});
