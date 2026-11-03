// Spec §13: "cross-company read/write must fail". Runs against a real Postgres (TEST_DATABASE_URL).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCompanyRole } from "../engine/src/db/pool.ts";
import { freshDatabase, TEST_DB_URL } from "./db.ts";

describe.skipIf(!TEST_DB_URL)("company isolation (RLS + roles)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase("hq_test_rls") });
    await pool.query(`
      select hq.create_company('hq', 'NADAV HQ', 'internal', 5);
      select hq.create_company('hidden', 'Hidden Library', 'solo', 20);
      select hq.create_company('media-li', 'Media Li', 'partner', 10, 'ANTHROPIC_KEY_MEDIA_LI');
      insert into hq.agents (id, company_id, card_version, state) values
        ('hq.chief', 'hq', 'v', 'active'),
        ('hidden.manager', 'hidden', 'v', 'active'), ('hidden.seo', 'hidden', 'v', 'shadow'),
        ('media-li.manager', 'media-li', 'v', 'active'), ('media-li.writer', 'media-li', 'v', 'active');
      insert into hq.memory (agent_id, company_id, note) values ('media-li.writer', 'media-li', 'secret note');
      insert into hq.runs (agent_id, company_id, trigger) values ('media-li.writer', 'media-li', 'task');
      insert into hq.settings (key, value) values ('all_stopped', 'false'), ('stopped:media-li', 'true'), ('stopped:hidden', 'false');
      create table "media-li".clients (id int primary key, name text);
      insert into "media-li".clients values (1, 'Client A');
      create table hidden.recommendations (id serial primary key, note text);
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const as = <T>(company: string, fn: (c: pg.PoolClient) => Promise<T>) => withCompanyRole(pool, company, fn);
  const count = async (c: pg.PoolClient, sql: string) => Number((await c.query(sql)).rows[0].n);

  describe("a worker company (hidden)", () => {
    it("sees only its own rows in hq.*", async () => {
      await as("hidden", async (c) => {
        expect((await c.query("select id from hq.companies")).rows).toEqual([{ id: "hidden" }]);
        expect((await c.query("select id from hq.agents order by id")).rows.map((r) => r.id)).toEqual(["hidden.manager", "hidden.seo"]);
        expect(await count(c, "select count(*) n from hq.memory")).toBe(0);
        expect(await count(c, "select count(*) n from hq.runs")).toBe(0);
      });
    });

    it("sees the global kill switch and its own, not other companies'", async () => {
      await as("hidden", async (c) => {
        const keys = (await c.query("select key from hq.settings order by key")).rows.map((r) => r.key);
        expect(keys).toEqual(["all_stopped", "stopped:hidden"]);
      });
    });

    it("can write its own tasks, memory, status, approvals and its own schema", async () => {
      await as("hidden", async (c) => {
        await c.query("insert into hq.tasks (from_agent, to_agent, company_id, payload) values ('hidden.manager', 'hidden.seo', 'hidden', '{}')");
        await c.query("insert into hq.memory (agent_id, company_id, note) values ('hidden.seo', 'hidden', 'ok')");
        await c.query("insert into hq.status (agent_id, company_id, line) values ('hidden.seo', 'hidden', 'fine')");
        await c.query("insert into hq.approvals (agent_id, company_id, action, idempotency_key, shadow) values ('hidden.seo', 'hidden', 'site.change', 'k1', true)");
        await c.query("insert into hidden.recommendations (note) values ('page 2')");
        await c.query("create table hidden.scratch (x int)");
      });
    });

    it.each([
      ["read another company's schema", `select * from "media-li".clients`],
      ["write another company's schema", `insert into "media-li".clients values (2, 'x')`],
      ["create a table in another company's schema", `create table "media-li".evil (x int)`],
      ["insert a task for another company", "insert into hq.tasks (to_agent, company_id) values ('media-li.writer', 'media-li')"],
      ["insert a task claiming its own company but targeting another", "insert into hq.tasks (to_agent, company_id) values ('media-li.writer', 'hidden')"],
      ["insert memory for another company", "insert into hq.memory (agent_id, company_id, note) values ('media-li.writer', 'media-li', 'x')"],
      ["insert an approval for another company", "insert into hq.approvals (agent_id, company_id, action, idempotency_key) values ('media-li.writer', 'media-li', 'x', 'k2')"],
      ["write status for another company", "insert into hq.status (agent_id, company_id, line) values ('media-li.writer', 'media-li', 'x')"],
      ["insert an event for another company", "insert into hq.events (company_id, kind) values ('media-li', 'x')"],
      ["change its own agent state", "update hq.agents set state = 'active' where id = 'hidden.seo'"],
      ["insert an agent", "insert into hq.agents (id, company_id, card_version) values ('hidden.x', 'hidden', 'v')"],
      ["record runs", "insert into hq.runs (agent_id, company_id, trigger) values ('hidden.seo', 'hidden', 'x')"],
      ["flip a kill switch", "update hq.settings set value = 'false' where key = 'all_stopped'"],
      ["create a role", "create role sneaky"],
      ["read the migrations table", "select * from hq.schema_migrations"],
    ])("cannot %s", async (_name, sql) => {
      await expect(as("hidden", (c) => c.query(sql))).rejects.toThrow(/permission denied|row-level security|violates/);
    });

    it("cannot move or edit another company's rows (updates silently match nothing)", async () => {
      await as("hidden", async (c) => {
        expect((await c.query("update hq.memory set note = 'pwned' where company_id = 'media-li'")).rowCount).toBe(0);
      });
      // hard deletes are not granted at all (memory uses deleted_at)
      await expect(as("hidden", (c) => c.query("delete from hq.memory where company_id = 'media-li'"))).rejects.toThrow(/permission denied/);
      // and cannot move its own rows into another company
      await expect(
        as("hidden", (c) => c.query("update hq.memory set company_id = 'media-li', agent_id = 'media-li.writer' where agent_id = 'hidden.seo'")),
      ).rejects.toThrow(/row-level security/);
      const { rows } = await pool.query("select note from hq.memory where company_id = 'media-li'");
      expect(rows).toEqual([{ note: "secret note" }]);
    });
  });

  it.each(["set role co_media_li", "set role hq_company", "reset role", "set local role co_media_li"])(
    "a role switch inside a run (%s) is detected, rolled back, and the connection discarded",
    async (sql) => {
      await expect(
        as("hidden", async (c) => {
          await c.query(sql);
          // after a successful switch this write would land in media-li; it must be rolled back
          await c.query("insert into hq.events (company_id, kind) values ('media-li', 'escape-attempt')").catch(() => {});
        }),
      ).rejects.toThrow(/role escape detected|permission denied/);
      expect((await pool.query("select count(*)::int n from hq.events where kind = 'escape-attempt'")).rows[0].n).toBe(0);
      expect((await pool.query("select current_user u")).rows[0].u).toBe("hq_test_admin");
    },
  );

  describe("hq.chief (co_hq)", () => {
    it("reads all of hq.*", async () => {
      await as("hq", async (c) => {
        expect(await count(c, "select count(*) n from hq.companies")).toBe(3);
        expect(await count(c, "select count(*) n from hq.agents")).toBe(5);
        expect(await count(c, "select count(*) n from hq.memory where company_id = 'media-li'")).toBe(1);
        expect(await count(c, "select count(*) n from hq.settings")).toBe(3);
      });
    });

    it("can send tasks to managers and write its own memory", async () => {
      await as("hq", async (c) => {
        await c.query("insert into hq.tasks (from_agent, to_agent, company_id) values ('hq.chief', 'media-li.manager', 'media-li')");
        await c.query("insert into hq.memory (agent_id, company_id, note) values ('hq.chief', 'hq', 'brief sent')");
      });
    });

    it.each([
      ["send a task to a worker", "insert into hq.tasks (from_agent, to_agent, company_id) values ('hq.chief', 'media-li.writer', 'media-li')"],
      ["send a task as someone else", "insert into hq.tasks (from_agent, to_agent, company_id) values ('hidden.seo', 'hidden.manager', 'hidden')"],
      ["write another agent's memory", "insert into hq.memory (agent_id, company_id, note) values ('hidden.manager', 'hidden', 'x')"],
      ["create approvals", "insert into hq.approvals (agent_id, company_id, action, idempotency_key) values ('hq.chief', 'hq', 'x', 'k3')"],
      ["write status", "insert into hq.status (agent_id, company_id, line) values ('hq.chief', 'hq', 'x')"],
      ["read a company schema", `select * from "media-li".clients`],
    ])("cannot %s", async (_name, sql) => {
      await expect(as("hq", (c) => c.query(sql))).rejects.toThrow(/permission denied|row-level security|violates/);
    });

    it("cannot update or delete tasks or other memory", async () => {
      await as("hq", async (c) => {
        expect((await c.query("update hq.tasks set status = 'done'")).rowCount).toBe(0);
        expect((await c.query("update hq.memory set note = 'x' where agent_id <> 'hq.chief'")).rowCount).toBe(0);
      });
      await expect(as("hq", (c) => c.query("delete from hq.memory"))).rejects.toThrow(/permission denied/);
    });
  });

  it("shadow approvals can never be marked executed", async () => {
    await expect(
      pool.query("update hq.approvals set status = 'executed' where shadow"),
    ).rejects.toThrow(/check constraint/);
  });

  it("the role resets after the transaction (no leak on pooled connections)", async () => {
    await as("hidden", async () => {});
    const { rows } = await pool.query("select current_user u, hq.current_company_id() c");
    expect(rows[0].c).toBeNull();
  });
});
