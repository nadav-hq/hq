import { z } from "zod";
import cron from "node-cron";
import { parse as parseYaml } from "yaml";
import { MODEL_ALIASES } from "./config.ts";
import { AGENT_ID_RE, COMPANY_ID_RE } from "./ids.ts";

/** Agent states (spec §4). The DB value overrides the card at runtime. */
export const AGENT_STATES = ["draft", "shadow", "active", "paused", "archived"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * Tool reference as written in a card: `name` or `name:arg`.
 * Examples: `web_search`, `gsc.read`, `db.read:hidden.products`,
 * `github.trigger_workflow:nadav-hq/site/scout.yml`.
 */
export const TOOL_REF_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(:[A-Za-z0-9_.\/-]+)?$/;

/** Approval action names, e.g. `site.change`. */
export const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const cronExpr = z
  .string()
  .refine((s) => s.trim().split(/\s+/).length === 5, "cron must have exactly 5 fields (min hour dom month dow)")
  .refine((s) => cron.validate(s), "invalid cron expression");

export const triggerSchema = z.union([
  z.strictObject({ cron: cronExpr }),
  z.literal("task"),
  z.literal("message"),
]);
export type Trigger = z.infer<typeof triggerSchema>;

const usd = z.number().positive();

/** Card frontmatter (spec §4). Unknown keys are rejected so typos never pass silently. */
export const cardFrontmatterSchema = z
  .strictObject({
    id: z.string().regex(AGENT_ID_RE, "must be <company>.<role>"),
    name: z.string().min(1),
    company: z.string().regex(COMPANY_ID_RE),
    reports_to: z.string().regex(AGENT_ID_RE).optional(),
    state: z.enum(AGENT_STATES).default("draft"),
    model: z.enum(MODEL_ALIASES),
    tools: z.array(z.string().regex(TOOL_REF_RE, "invalid tool reference")).default([]),
    triggers: z.array(triggerSchema).min(1, "at least one trigger"),
    approvals: z.array(z.string().regex(ACTION_RE, "invalid action name")).default([]),
    budget: z.strictObject({ per_run_usd: usd, per_month_usd: usd }),
    memory: z.strictObject({ read_last: z.number().int().min(0).max(200) }).default({ read_last: 20 }),
  })
  .superRefine((c, ctx) => {
    if (!c.id.startsWith(`${c.company}.`)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `id must start with "${c.company}."` });
    }
    if (c.budget.per_run_usd > c.budget.per_month_usd) {
      ctx.addIssue({ code: "custom", path: ["budget", "per_run_usd"], message: "per_run_usd exceeds per_month_usd" });
    }
    if (c.reports_to === c.id) {
      ctx.addIssue({ code: "custom", path: ["reports_to"], message: "an agent cannot report to itself" });
    }
    const dupes = c.tools.filter((t, i) => c.tools.indexOf(t) !== i);
    if (dupes.length) {
      ctx.addIssue({ code: "custom", path: ["tools"], message: `duplicate tools: ${[...new Set(dupes)].join(", ")}` });
    }
  });

export type CardFrontmatter = z.infer<typeof cardFrontmatterSchema>;
export type Card = CardFrontmatter & { body: string };

export type CardIssue = { path: string; message: string };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: CardIssue[] };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse and validate one card file's text (frontmatter + markdown body). */
export function parseCard(text: string): ParseResult<Card> {
  const m = FRONTMATTER_RE.exec(text.replace(/^﻿/, ""));
  if (!m) return { ok: false, issues: [{ path: "", message: "missing YAML frontmatter (--- ... ---)" }] };
  let raw: unknown;
  try {
    raw = parseYaml(m[1] ?? "");
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `YAML error: ${(e as Error).message}` }] };
  }
  const parsed = cardFrontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const body = (m[2] ?? "").trim();
  if (!body) return { ok: false, issues: [{ path: "body", message: "instructions (markdown body) are empty" }] };
  return { ok: true, value: { ...parsed.data, body } };
}

export function zodIssues(err: z.ZodError): CardIssue[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
