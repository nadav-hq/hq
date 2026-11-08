/** Structured JSON-lines logs (spec §6 guards). Railway shows stdout as-is. */
export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export const log: Logger = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
};

export const silent: Logger = () => {};
