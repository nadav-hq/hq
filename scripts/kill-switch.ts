// Usage: pnpm kill-switch stop|resume all|<company_id>     |  pnpm kill-switch status
// `all` sets hq.settings.all_stopped; a company sets stopped:<company_id>. Runs check both (spec §6 step 2).
import { log, openPool } from "./_cli.ts";

const [cmd, target] = process.argv.slice(2);
const pool = openPool();
let code = 0;
try {
  if ((cmd === "stop" || cmd === "resume") && target) {
    const key = target === "all" ? "all_stopped" : `stopped:${target}`;
    if (key !== "all_stopped") {
      const c = await pool.query("select 1 from hq.companies where id = $1", [target]);
      if (!c.rowCount) throw new Error(`unknown company ${target}`);
    }
    await pool.query(
      `insert into hq.settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, cmd === "stop" ? "true" : "false"],
    );
    log("kill_switch", { key, stopped: cmd === "stop" });
  } else if (cmd === "status") {
    const { rows } = await pool.query("select key, value, updated_at from hq.settings where key = 'all_stopped' or key like 'stopped:%' order by key");
    log("kill_switch.status", { settings: rows });
  } else {
    console.error("usage: pnpm kill-switch stop|resume all|<company_id> | status");
    code = 2;
  }
} finally {
  await pool.end();
}
process.exit(code);
