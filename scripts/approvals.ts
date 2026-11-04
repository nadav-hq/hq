// Usage:
//   pnpm approvals list [--all]                 waiting approvals (or the last 50 of any status)
//   pnpm approvals approve <id> [reason]        approve; a non-shadow approval executes once
//   pnpm approvals reject <id> <reason>
// Telegram's Approve / Reject buttons (M3) call the same decideApproval().
import { decideApproval } from "../engine/src/runner/approvals.ts";
import { log, openPool } from "./_cli.ts";

const [cmd, id, ...rest] = process.argv.slice(2);
const pool = openPool();
let code = 0;
try {
  if (cmd === "list") {
    const all = process.argv.includes("--all");
    const { rows } = await pool.query(
      `select id, agent_id, action, shadow, status, created_at, decided_by, reason, payload
         from hq.approvals ${all ? "" : "where status = 'waiting'"} order by created_at ${all ? "desc" : "asc"} limit 50`,
    );
    for (const r of rows) log("approval", r);
    if (!rows.length) log("approvals.none", { filter: all ? "all" : "waiting" });
  } else if ((cmd === "approve" || cmd === "reject") && id) {
    const reason = rest.join(" ") || undefined;
    if (cmd === "reject" && !reason) throw new Error("reject needs a reason");
    const out = await decideApproval(pool, id, cmd, process.env.DECIDED_BY || "nadav (cli)", reason);
    log("approval.decided", out);
  } else {
    console.error("usage: pnpm approvals list [--all] | approve <id> [reason] | reject <id> <reason>");
    code = 2;
  }
} catch (e) {
  log("approvals.error", { error: (e as Error).message });
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
