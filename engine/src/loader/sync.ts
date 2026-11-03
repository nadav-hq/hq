import type { Queryable } from "../db/pool.ts";
import type { CompanyLoadResult } from "./load-company.ts";

export type SyncResult = {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  /** Agents in the DB for this company whose card is missing or invalid in the repo. Not touched. */
  missingCards: string[];
};

/**
 * Upsert valid cards into hq.agents (spec §6, card loader).
 * - New agent: inserted with the card's state.
 * - Existing agent: only card_version changes. The DB state wins at runtime (spec §4).
 * - Company row must already exist with a matching format; the loader never creates companies.
 */
export async function syncAgents(client: Queryable, loaded: CompanyLoadResult): Promise<SyncResult> {
  const company = loaded.company;
  if (!company) throw new Error(`${loaded.dir}: company.yaml is invalid, nothing to sync`);

  const { rows } = await client.query<{ format: string; active: boolean }>(
    "select format, active from hq.companies where id = $1",
    [company.id],
  );
  const row = rows[0];
  if (!row) throw new Error(`company "${company.id}" is not in hq.companies (seed it first)`);
  if (row.format !== company.format) {
    throw new Error(`company "${company.id}": company.yaml format "${company.format}" != DB format "${row.format}"`);
  }

  const out: SyncResult = { inserted: [], updated: [], unchanged: [], missingCards: [] };
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
  return out;
}
