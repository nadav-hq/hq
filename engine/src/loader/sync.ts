import type { Queryable } from "../db/pool.ts";
import type { CompanyLoadResult } from "./load-company.ts";

export type SyncResult = {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  /** Agents in the DB for this company whose card is missing or invalid in the repo. Not touched. */
  missingCards: string[];
  /** True if the company row was created from company.yaml during this sync. */
  companyCreated: boolean;
  /** hq.card_errors after this sync: newly invalid / still invalid / cleared (valid again or removed). */
  cardErrors: { added: string[]; changed: string[]; unchanged: string[]; cleared: string[] };
};

/**
 * Upsert valid cards into hq.agents (spec §6, card loader).
 * - New agent: inserted with the card's state.
 * - Existing agent: only card_version changes. The DB state wins at runtime (spec §4).
 * - Company: created from company.yaml if missing (initial budget, topic, key env), with the HQ
 *   owners as its owners. After that the
 *   DB is the source of truth: the loader never updates an existing company row. Its format must match.
 * - Invalid cards: upserted into hq.card_errors; rows for cards that are valid again are deleted.
 *   Changes are also recorded in hq.events (`card.invalid`, `card.valid`).
 */
export async function syncAgents(client: Queryable, loaded: CompanyLoadResult): Promise<SyncResult> {
  const company = loaded.company;
  if (!company) throw new Error(`${loaded.dir}: company.yaml is invalid, nothing to sync`);

  const created = await client.query<{ created: boolean }>(
    `select not exists (select 1 from hq.companies where id = $1) as created`,
    [company.id],
  );
  const companyCreated = created.rows[0]?.created === true;
  if (companyCreated) {
    await client.query("select hq.create_company($1, $2, $3, $4, $5, $6)", [
      company.id,
      company.name,
      company.format,
      company.budget_month_usd,
      company.anthropic_key_env ?? null,
      company.telegram_topic_id ?? null,
    ]);
    // HQ owners (Nadav) own every new company; partners are added later (spec §2 rule 4).
    await client.query(
      `insert into hq.company_members (company_id, telegram_user_id, email, role)
       select $1, telegram_user_id, email, 'owner' from hq.company_members where company_id = 'hq' and role = 'owner'`,
      [company.id],
    );
  }
  const { rows } = await client.query<{ format: string }>("select format from hq.companies where id = $1", [company.id]);
  const row = rows[0];
  if (!row) throw new Error(`company "${company.id}" could not be created`);
  if (row.format !== company.format) {
    throw new Error(`company "${company.id}": company.yaml format "${company.format}" != DB format "${row.format}"`);
  }

  const out: SyncResult = {
    inserted: [],
    updated: [],
    unchanged: [],
    missingCards: [],
    companyCreated,
    cardErrors: { added: [], changed: [], unchanged: [], cleared: [] },
  };
  for (const c of loaded.cards) {
    const r = await client.query<{ inserted: boolean }>(
      `insert into hq.agents (id, company_id, card_version, state)
       values ($1, $2, $3, $4)
       on conflict (id) do update
         set card_version = excluded.card_version, updated_at = now()
         where hq.agents.card_version is distinct from excluded.card_version
       returning (xmax = 0) as inserted`,
      [c.id, company.id, c.version, c.state],
    );
    const res = r.rows[0];
    if (!res) out.unchanged.push(c.id);
    else if (res.inserted) out.inserted.push(c.id);
    else out.updated.push(c.id);
  }

  const valid = loaded.cards.map((c) => c.id);
  const missing = await client.query<{ id: string }>(
    "select id from hq.agents where company_id = $1 and not (id = any($2::text[])) and state <> 'archived' order by id",
    [company.id, valid],
  );
  out.missingCards = missing.rows.map((r) => r.id);
  out.cardErrors = await syncCardErrors(client, loaded);
  return out;
}

async function syncCardErrors(client: Queryable, loaded: CompanyLoadResult): Promise<SyncResult["cardErrors"]> {
  const companyId = loaded.company!.id;
  const res: SyncResult["cardErrors"] = { added: [], changed: [], unchanged: [], cleared: [] };
  const current: string[] = [];

  for (const inv of loaded.invalid) {
    const file = `${companyId}/${inv.file}`;
    const error = inv.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    current.push(file);
    const prev = await client.query<{ error: string }>("select error from hq.card_errors where file = $1", [file]);
    const before = prev.rows[0]?.error;
    await client.query(
      `insert into hq.card_errors (file, company_id, error) values ($1, $2, $3)
       on conflict (file) do update set error = excluded.error, last_seen = now()`,
      [file, companyId, error],
    );
    if (before === undefined) res.added.push(file);
    else if (before !== error) res.changed.push(file);
    else res.unchanged.push(file);
    if (before !== error) {
      await client.query("insert into hq.events (company_id, kind, payload) values ($1, 'card.invalid', $2)", [
        companyId,
        JSON.stringify({ file, error }),
      ]);
    }
  }

  const cleared = await client.query<{ file: string }>(
    "delete from hq.card_errors where company_id = $1 and not (file = any($2::text[])) returning file",
    [companyId, current],
  );
  for (const { file } of cleared.rows.sort((a, b) => a.file.localeCompare(b.file))) {
    res.cleared.push(file);
    await client.query("insert into hq.events (company_id, kind, payload) values ($1, 'card.valid', $2)", [
      companyId,
      JSON.stringify({ file }),
    ]);
  }
  return res;
}
