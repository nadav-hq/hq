import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCompanyDir } from "../src/loader/load-company.ts";

const HIDDEN = fileURLToPath(new URL("./fixtures/hidden", import.meta.url));

function card(fm: Record<string, string>, body = "# Instructions\nx\n"): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const manager = {
  id: "acme.manager",
  name: "Manager",
  company: "acme",
  reports_to: "hq.chief",
  model: "opus",
  triggers: "[task]",
  budget: "{ per_run_usd: 1, per_month_usd: 10 }",
};

async function companyDir(companyYaml: string, cards: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hq-loader-"));
  await writeFile(join(dir, "company.yaml"), companyYaml);
  await mkdir(join(dir, "agents"));
  for (const [f, text] of Object.entries(cards)) await writeFile(join(dir, "agents", f), text);
  return dir;
}

const ACME = "id: acme\nname: Acme\nformat: solo\nbudget_month_usd: 5\n";

describe("loadCompanyDir", () => {
  it("validates the hidden fixture", async () => {
    const r = await loadCompanyDir(HIDDEN);
    expect(r.companyIssues).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.company?.id).toBe("hidden");
    expect(r.cards.map((c) => c.id)).toEqual(["hidden.manager", "hidden.seo"]);
    for (const c of r.cards) expect(c.version).toMatch(/^([0-9a-f]{40}|local-[0-9a-f]{12})$/);
  });

  it("reports invalid cards and keeps the valid ones", async () => {
    const dir = await companyDir(ACME, {
      "manager.md": card(manager),
      "writer.md": card({ ...manager, id: "acme.writer", reports_to: "acme.manager" }),
      "misnamed.md": card({ ...manager, id: "acme.other", reports_to: "acme.manager" }),
      "orphan.md": card({ ...manager, id: "acme.orphan", reports_to: "acme.ghost" }),
      "outsider.md": card({ ...manager, id: "acme.outsider", reports_to: "hidden.manager" }),
      "spy.md": card({ ...manager, id: "acme.spy", reports_to: "acme.manager", tools: '["db.read:hidden.products"]' }),
      "noboss.md": card({ ...manager, id: "acme.noboss", reports_to: "acme.manager" }).replace("reports_to: acme.manager\n", ""),
      "broken.md": "no frontmatter",
    });
    const r = await loadCompanyDir(dir);
    expect(r.cards.map((c) => c.id)).toEqual(["acme.manager", "acme.writer"]);
    const byFile = Object.fromEntries(r.invalid.map((i) => [i.file, i.issues.map((x) => x.message).join("; ")]));
    expect(Object.keys(byFile).sort()).toEqual(
      ["broken", "misnamed", "noboss", "orphan", "outsider", "spy"].map((f) => `agents/${f}.md`),
    );
    expect(byFile["agents/misnamed.md"]).toContain('must be "acme.misnamed"');
    expect(byFile["agents/orphan.md"]).toContain("no valid card");
    expect(byFile["agents/outsider.md"]).toContain("same company");
    expect(byFile["agents/spy.md"]).toContain('schema "acme"');
    expect(byFile["agents/noboss.md"]).toContain("required");
  });

  it("requires the manager to report to hq.chief", async () => {
    const dir = await companyDir(ACME, { "manager.md": card({ ...manager, reports_to: "acme.writer" }) });
    const r = await loadCompanyDir(dir);
    expect(r.cards).toEqual([]);
    expect(r.invalid[0]?.issues[0]?.message).toContain("hq.chief");
  });

  it("refuses external companies, the reserved hq id, and a bad company.yaml", async () => {
    for (const yaml of [
      "id: shuki\nname: Shuki\nformat: external\nbudget_month_usd: 0\n",
      "id: hq\nname: HQ\nformat: solo\nbudget_month_usd: 0\n",
      "id: Bad Id\nname: x\nformat: solo\nbudget_month_usd: 0\n",
      "id: tpr\nname: TPR\nformat: partner\nbudget_month_usd: 5\n",
    ]) {
      const r = await loadCompanyDir(await companyDir(yaml, { "manager.md": card(manager) }));
      expect(r.company).toBeNull();
      expect(r.companyIssues.length).toBeGreaterThan(0);
      expect(r.cards).toEqual([]);
    }
  });
});
