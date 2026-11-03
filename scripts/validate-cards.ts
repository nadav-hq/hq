// Usage: pnpm cards:validate <company-repo-dir> [...more]
// Exit code 1 if company.yaml or any card is invalid.
import { loadCompanyDir, type CompanyLoadResult } from "../engine/src/loader/load-company.ts";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: pnpm cards:validate <company-repo-dir> [...]");
  process.exit(2);
}

let bad = false;
for (const dir of dirs) {
  const r = await loadCompanyDir(dir);
  report(r);
  if (r.companyIssues.length || r.invalid.length) bad = true;
}
process.exit(bad ? 1 : 0);

function report(r: CompanyLoadResult): void {
  console.log(`\n${r.dir}  company=${r.company?.id ?? "?"} (${r.company?.format ?? "?"})`);
  for (const i of r.companyIssues) console.log(`  ✗ ${i.path}: ${i.message}`);
  for (const c of r.cards) console.log(`  ✓ ${c.id}  [${c.state}, ${c.model}]  ${c.version.slice(0, 12)}`);
  for (const c of r.invalid) {
    console.log(`  ✗ ${c.file}`);
    for (const i of c.issues) console.log(`      ${i.path || "(card)"}: ${i.message}`);
  }
}
