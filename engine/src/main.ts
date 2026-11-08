// Engine service entry point (Railway start command).
// M2: syncs the configured companies' cards on boot and stays up, so CLI commands can be run in the
// service with `railway ssh`. Scheduler, queue loop and Telegram come in later milestones.
import { loadAndSync, log, openPool } from "../../scripts/_cli.ts";
import { describeDbUrl, errorInfo } from "./log.ts";
import type { LoadedCard } from "./loader/load-company.ts";
import { ClaudeAgentDriver } from "./runner/claude-driver.ts";
import { runAgent } from "./runner/run-agent.ts";

const companies = (process.env.HQ_COMPANIES || "hidden").split(",").map((s) => s.trim()).filter(Boolean);
const pool = openPool();
log("engine.db_connect", { ...describeDbUrl(process.env.SUPABASE_DB_URL), ca_cert: Boolean(process.env.SUPABASE_CA_CERT) });

try {
  const { rows } = await pool.query<{ v: string; u: string }>("select current_setting('server_version') v, current_user u");
  log("engine.db_ok", { server_version: rows[0]?.v, user: rows[0]?.u });
  const cards: LoadedCard[] = [];
  for (const c of companies) {
    try {
      cards.push(...(await loadAndSync(pool, c)).cards);
    } catch (e) {
      log("engine.sync_failed", { company: c, error: errorInfo(e) });
    }
  }
  // HQ_RUN_ON_BOOT=hidden.test runs those agents once after each deploy (manual trigger), so a test
  // run needs no CLI. Remove the variable afterwards, or every restart runs them again.
  for (const agentId of (process.env.HQ_RUN_ON_BOOT || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const companyCards = cards.filter((c) => c.company === agentId.split(".")[0]);
      const out = await runAgent(
        { agentId, trigger: "manual", prompt: "Run now (HQ_RUN_ON_BOOT)." },
        { pool, driver: new ClaudeAgentDriver(), companyCards },
      );
      log("run.result", out);
    } catch (e) {
      log("run.error", { agent_id: agentId, error: errorInfo(e) });
    }
  }
} catch (e) {
  log("engine.db_error", { error: errorInfo(e) });
}

log("engine.idle", { companies, note: "M2: no scheduler / queue loop / Telegram yet; run CLI commands via railway ssh" });
const beat = setInterval(() => log("engine.heartbeat"), 10 * 60 * 1000);

const stop = async (sig: string) => {
  log("engine.stop", { signal: sig });
  clearInterval(beat);
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
