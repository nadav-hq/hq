// Usage: pnpm run-agent <agent_id> [--prompt "text from Nadav"]
// Syncs the agent's company cards, then runs the agent once (manual trigger) with Claude.
// Exit code: 0 succeeded / skipped, 1 failed or budget-stopped.
import { ClaudeAgentDriver } from "../engine/src/runner/claude-driver.ts";
import { runAgent } from "../engine/src/runner/run-agent.ts";
import { flag, loadAndSync, log, openPool } from "./_cli.ts";
import { errorInfo } from "../engine/src/log.ts";

const args = process.argv.slice(2);
const agentId = args[0];
if (!agentId || agentId.startsWith("--")) {
  console.error('usage: pnpm run-agent <agent_id> [--prompt "..."]');
  process.exit(2);
}

const pool = openPool();
let code = 0;
try {
  const loaded = await loadAndSync(pool, agentId.split(".")[0]!);
  const out = await runAgent(
    { agentId, trigger: "manual", prompt: flag(args, "prompt") ?? "Run now." },
    { pool, driver: new ClaudeAgentDriver(), companyCards: loaded.cards },
  );
  log("run.result", out);
  code = out.status === "succeeded" || out.status === "skipped" ? 0 : 1;
} catch (e) {
  log("run.error", { error: errorInfo(e) });
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
