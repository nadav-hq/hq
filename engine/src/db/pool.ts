import pg from "pg";

export function databaseUrl(): string {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (see .env.example)");
  return url;
}

/**
 * Pool for the engine. If SUPABASE_CA_CERT (PEM text of Supabase's root certificate) is set, TLS is
 * verified against it; any sslmode in the URL is then ignored so the CA setting wins.
 */
export function createPool(url = databaseUrl(), max = 5): pg.Pool {
  return new pg.Pool(poolConfig(url, max));
}

export function poolConfig(url: string, max = 5): pg.PoolConfig {
  const ca = process.env.SUPABASE_CA_CERT?.replace(/\\n/g, "\n");
  if (!ca) return { connectionString: url, max, connectionTimeoutMillis: 20_000 };
  const u = new URL(url);
  for (const k of ["sslmode", "sslrootcert", "uselibpqcompat"]) u.searchParams.delete(k);
  return { connectionString: u.toString(), max, connectionTimeoutMillis: 20_000, ssl: { ca, rejectUnauthorized: true } };
}

/**
 * Run `fn` inside a transaction as the company's Postgres role (spec §5).
 * Every query in `fn` is limited by that company's grants and RLS policies.
 *
 * Limitation: Postgres checks SET ROLE against the *session* user (the engine), so SQL text
 * that itself runs `SET ROLE` / `RESET ROLE` could leave the company role. Agents therefore
 * never get raw SQL: DB tools issue fixed, parameterized queries. As a backstop this helper
 * verifies the role after `fn`; on any mismatch it rolls back and discards the connection.
 */
export async function withCompanyRole<T>(
  pool: pg.Pool,
  companyId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("begin");
    const { rows } = await client.query<{ db_role: string | null }>(
      "select db_role from hq.companies where id = $1 and active",
      [companyId],
    );
    const role = rows[0]?.db_role;
    if (!role) throw new Error(`company ${companyId} has no active DB role`);
    await client.query(`set local role ${client.escapeIdentifier(role)}`);
    const result = await fn(client);
    const now = await client.query<{ u: string }>("select current_user as u");
    if (now.rows[0]?.u !== role) {
      discard = true;
      throw new Error(`role escape detected: expected ${role}, got ${now.rows[0]?.u}; rolled back`);
    }
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {
      discard = true;
    });
    throw e;
  } finally {
    if (!discard) {
      // SET LOCAL ends with the transaction, but a plain SET ROLE would survive it.
      await client.query("reset role").catch(() => {
        discard = true;
      });
    }
    client.release(discard);
  }
}

/** Anything that can run a query: a Pool, Client or PoolClient. */
export type Queryable = pg.Pool | pg.ClientBase;
