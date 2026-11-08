/** Structured JSON-lines logs (spec §6 guards). Railway shows stdout as-is. */
export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export const log: Logger = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
};

export const silent: Logger = () => {};

/** Everything useful about an error, including codes and AggregateError parts (whose message is empty). */
export function errorInfo(e: unknown): Record<string, unknown> {
  const err = e as Error & { code?: string; errors?: unknown[]; address?: string; port?: number };
  const info: Record<string, unknown> = { name: err?.name, message: err?.message || String(e) };
  if (err?.code) info.code = err.code;
  if (err?.address) info.address = err.address;
  if (err?.port) info.port = err.port;
  if (Array.isArray(err?.errors)) info.errors = err.errors.map((x) => errorInfo(x));
  return info;
}

/** Connection target without the password, for logs. */
export function describeDbUrl(url: string | undefined): Record<string, unknown> {
  if (!url) return { set: false };
  try {
    const u = new URL(url);
    return { set: true, host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username), database: u.pathname.slice(1), params: [...u.searchParams.keys()] };
  } catch {
    return { set: true, parse_error: "SUPABASE_DB_URL is not a valid URL" };
  }
}
