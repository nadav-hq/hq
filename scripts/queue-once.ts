// Usage: pnpm queue:once [agent_id]
// Takes the oldest open task (optionally for one agent) with FOR UPDATE SKIP LOCKED and runs its agent.
import { ClaudeAgentDriver } from "../engine/src/runner/claude-driver.ts";
import { takeNextTask } from "../engine/src/runner/queue.ts";
import { runAgent } from "../engine/src/runner/run-agent.ts";
import { loadAndSync, log, openPool } from "./_cli.ts";

const pool = openPool();
try {
  const task = await takeNextTask(pool, process.argv[2]);
  if (!task) {
    log("queue.empty", { agent_id: process.argv[2] ?? null });
  } else {
    log("queue.taken", { task_id: task.id, to_agent: task.to_agent, hop: task.hop });
    const loaded = await loadAndSync(pool, task.company_id);
    const out = await runAgent({ agentId: task.to_agent, trigger: "task", task }, { pool, driver: new ClaudeAgentDriver(), companyCards: loaded.cards });
    log("run.result", out);
  }
} finally {
  await pool.end();
}
