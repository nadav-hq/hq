import { describe, expect, it } from "vitest";
import { parseCard } from "./card-schema.ts";
import { companyFileSchema } from "./company-schema.ts";
import { MODELS, resolveModel } from "./config.ts";

const base = `---
id: hidden.seo
name: SEO and GEO
company: hidden
reports_to: hidden.manager
state: shadow
model: sonnet
tools: [web_search, "db.read:hidden.products"]
triggers:
  - cron: "0 7 * * 1"
  - task
approvals: [site.change]
budget: { per_run_usd: 0.5, per_month_usd: 15 }
---
# Instructions
Do the thing.
`;

const withFm = (patch: (fm: string) => string) => base.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${patch(fm)}\n---`);

describe("parseCard", () => {
  it("accepts the spec example and fills defaults", () => {
    const r = parseCard(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.memory.read_last).toBe(20);
    expect(r.value.body).toContain("Do the thing.");
    expect(r.value.triggers).toEqual([{ cron: "0 7 * * 1" }, "task"]);
  });

  it.each([
    ["no frontmatter", () => "# just markdown", "frontmatter"],
    ["empty body", () => base.replace(/# Instructions\nDo the thing.\n/, ""), "empty"],
    ["unknown key", () => withFm((fm) => `${fm}\ncolour: red`), "colour"],
    ["bad model", () => withFm((fm) => fm.replace("model: sonnet", "model: gpt")), "model"],
    ["bad state", () => withFm((fm) => fm.replace("state: shadow", "state: live")), "state"],
    ["6-field cron", () => withFm((fm) => fm.replace('"0 7 * * 1"', '"0 0 7 * * 1"')), "5 fields"],
    ["invalid cron", () => withFm((fm) => fm.replace('"0 7 * * 1"', '"0 25 * * 1"')), "cron"],
    ["unknown trigger", () => withFm((fm) => fm.replace("  - task", "  - webhook")), "triggers"],
    ["id/company mismatch", () => withFm((fm) => fm.replace("id: hidden.seo", "id: milvado.seo")), 'start with "hidden."'],
    ["per_run > per_month", () => withFm((fm) => fm.replace("per_run_usd: 0.5", "per_run_usd: 20")), "exceeds"],
    ["no triggers", () => withFm((fm) => fm.replace(/triggers:\n(  - .*\n)+/, "triggers: []\n")), "trigger"],
    ["bad tool ref", () => withFm((fm) => fm.replace("web_search", "'web search'")), "tool"],
    ["duplicate tool", () => withFm((fm) => fm.replace("web_search", "web_search, web_search")), "duplicate"],
    ["self report", () => withFm((fm) => fm.replace("reports_to: hidden.manager", "reports_to: hidden.seo")), "itself"],
    ["broken yaml", () => withFm((fm) => `${fm}\n  : : :`), ""],
  ])("rejects %s", (_name, make, msg) => {
    const r = parseCard(make());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.path} ${i.message}`).join("\n")).toContain(msg);
  });
});

describe("company.yaml", () => {
  it("requires anthropic_key_env for partner companies", () => {
    const r = companyFileSchema.safeParse({ id: "tpr", name: "TPR", format: "partner", budget_month_usd: 10 });
    expect(r.success).toBe(false);
    const ok = companyFileSchema.safeParse({ id: "tpr", name: "TPR", format: "partner", budget_month_usd: 10, anthropic_key_env: "ANTHROPIC_KEY_TPR" });
    expect(ok.success).toBe(true);
  });

  it("rejects a key value in place of an env var name", () => {
    const r = companyFileSchema.safeParse({ id: "tpr", name: "TPR", format: "partner", budget_month_usd: 10, anthropic_key_env: "sk-ant-xyz" });
    expect(r.success).toBe(false);
  });
});

describe("config", () => {
  it("resolves every alias to a model id", () => {
    for (const alias of Object.keys(MODELS) as (keyof typeof MODELS)[]) expect(resolveModel(alias)).toMatch(/^claude-/);
  });
});
