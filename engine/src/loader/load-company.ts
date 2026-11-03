import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  type Card,
  type CardIssue,
  type CompanyFile,
  companyFileSchema,
  HQ_COMPANY_ID,
  parseCard,
  ROLE_RE,
  zodIssues,
} from "@hq/shared";

const exec = promisify(execFile);

export type LoadedCard = Card & { file: string; version: string };
export type InvalidCard = { file: string; issues: CardIssue[] };

export type CompanyLoadResult = {
  dir: string;
  company: CompanyFile | null;
  /** Problems with company.yaml itself. If non-empty, no cards are loaded. */
  companyIssues: CardIssue[];
  cards: LoadedCard[];
  invalid: InvalidCard[];
};

/**
 * Load and validate one company repo checkout: `company.yaml` + `agents/*.md` (spec §3, §4).
 * Invalid cards are reported, never loaded. Cross-card checks (reports_to, tool scope) run here
 * because they need the whole company.
 */
export async function loadCompanyDir(dir: string): Promise<CompanyLoadResult> {
  const result: CompanyLoadResult = { dir, company: null, companyIssues: [], cards: [], invalid: [] };

  let rawCompany: unknown;
  try {
    rawCompany = parseYaml(await readFile(join(dir, "company.yaml"), "utf8"));
  } catch (e) {
    result.companyIssues.push({ path: "company.yaml", message: (e as Error).message });
    return result;
  }
  const company = companyFileSchema.safeParse(rawCompany ?? {});
  if (!company.success) {
    result.companyIssues = zodIssues(company.error).map((i) => ({ ...i, path: `company.yaml:${i.path}` }));
    return result;
  }
  if (company.data.format === "external") {
    result.companyIssues.push({ path: "company.yaml:format", message: "external companies do not run in HQ" });
    return result;
  }
  if (company.data.id === HQ_COMPANY_ID) {
    result.companyIssues.push({ path: "company.yaml:id", message: `"${HQ_COMPANY_ID}" is reserved for HQ itself` });
    return result;
  }
  result.company = company.data;
  const companyId = company.data.id;

  let files: string[] = [];
  try {
    files = (await readdir(join(dir, "agents"))).filter((f) => f.endsWith(".md")).sort();
  } catch {
    // No agents/ folder yet: a valid company with zero agents.
  }

  const parsed: LoadedCard[] = [];
  for (const f of files) {
    const rel = `agents/${f}`;
    const role = basename(f, ".md");
    const issues: CardIssue[] = [];
    if (!ROLE_RE.test(role)) issues.push({ path: "file", message: `file name "${f}" is not a valid role` });

    const text = await readFile(join(dir, rel), "utf8");
    const card = parseCard(text);
    if (!card.ok) {
      result.invalid.push({ file: rel, issues: [...issues, ...card.issues] });
      continue;
    }
    const c = card.value;
    if (c.company !== companyId) issues.push({ path: "company", message: `must be "${companyId}" (from company.yaml)` });
    if (c.id !== `${companyId}.${role}`) issues.push({ path: "id", message: `must be "${companyId}.${role}" (from file name)` });
    issues.push(...toolScopeIssues(c, companyId));

    if (issues.length) result.invalid.push({ file: rel, issues });
    else parsed.push({ ...c, file: rel, version: await cardVersion(dir, rel, text) });
  }

  // reports_to: managers report to hq.chief; everyone else to a valid card in the same company.
  const ids = new Set(parsed.map((c) => c.id));
  for (const c of parsed) {
    const isManager = c.id === `${companyId}.manager`;
    let issue: string | null = null;
    if (isManager) {
      if (c.reports_to !== "hq.chief") issue = 'the manager must report to "hq.chief"';
    } else if (!c.reports_to) {
      issue = "reports_to is required";
    } else if (!c.reports_to.startsWith(`${companyId}.`)) {
      issue = "must report to an agent in the same company";
    } else if (!ids.has(c.reports_to)) {
      issue = `"${c.reports_to}" has no valid card`;
    }
    if (issue) result.invalid.push({ file: c.file, issues: [{ path: "reports_to", message: issue }] });
    else result.cards.push(c);
  }
  result.invalid.sort((a, b) => a.file.localeCompare(b.file));
  return result;
}

/** A card may only name DB tables in its own company's schema. */
function toolScopeIssues(card: Card, companyId: string): CardIssue[] {
  const issues: CardIssue[] = [];
  for (const t of card.tools) {
    const m = /^db\.(read|write):(.+)$/.exec(t);
    if (!m) continue;
    const target = m[2] ?? "";
    const [schema, table, ...rest] = target.split(".");
    if (!table || rest.length) issues.push({ path: "tools", message: `${t}: expected db.${m[1]}:<schema>.<table>` });
    else if (schema !== companyId) issues.push({ path: "tools", message: `${t}: cards may only use tables in schema "${companyId}"` });
  }
  return issues;
}

/** Card version = sha of the last commit touching the file; content hash if not committed. */
async function cardVersion(dir: string, rel: string, text: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "log", "-1", "--format=%H", "--", rel]);
    const sha = stdout.trim();
    if (sha) {
      const { stdout: dirty } = await exec("git", ["-C", dir, "status", "--porcelain", "--", rel]);
      if (!dirty.trim()) return sha;
    }
  } catch {
    // not a git checkout
  }
  return `local-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}
