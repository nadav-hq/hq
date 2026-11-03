/**
 * The only place model ids live (spec §13).
 * Cards refer to models by alias; the engine resolves them here.
 */
export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export type ModelAlias = keyof typeof MODELS;

export const MODEL_ALIASES = Object.keys(MODELS) as [ModelAlias, ...ModelAlias[]];

export function resolveModel(alias: ModelAlias): string {
  return MODELS[alias];
}

/** All cron triggers are interpreted in this timezone. */
export const TIMEZONE = "Asia/Jerusalem";
