import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { DriverInput, DriverResult, ModelDriver } from "./driver.ts";

const SERVER = "hq";

/**
 * Runs one agent turn-loop with the Claude Agent SDK (spec §6 "Runner").
 * - No built-in tools (`tools: []`), no settings files, no session persistence.
 * - Only our in-process MCP tools are allowed; everything else is denied (`dontAsk`).
 * - `maxBudgetUsd` is the hard per-run stop; the SDK reports `error_max_budget_usd`.
 */
export class ClaudeAgentDriver implements ModelDriver {
  async run(input: DriverInput): Promise<DriverResult> {
    if (!input.apiKey) {
      return { status: "failed", text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, error: "no Anthropic API key in env" };
    }
    const server = createSdkMcpServer({
      name: SERVER,
      version: "1.0.0",
      tools: input.tools.map((t) =>
        tool(t.name, t.description, t.schema, async (args) => {
          try {
            return { content: [{ type: "text", text: await t.handler(args as Record<string, unknown>) }] };
          } catch (e) {
            return { content: [{ type: "text", text: `ERROR: ${(e as Error).message}` }], isError: true };
          }
        }),
      ),
    });

    let result: DriverResult = { status: "failed", text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, error: "no result" };
    try {
      for await (const msg of query({
        prompt: input.prompt,
        options: {
          model: input.model,
          systemPrompt: input.system,
          tools: [],
          mcpServers: { [SERVER]: server },
          strictMcpConfig: true,
          allowedTools: input.tools.map((t) => `mcp__${SERVER}__${t.name}`),
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          maxTurns: input.maxTurns,
          maxBudgetUsd: input.maxBudgetUsd,
          env: { ...process.env, ANTHROPIC_API_KEY: input.apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: "nadav-hq-engine/0.2" },
        },
      })) {
        if (msg.type !== "result") continue;
        const usage = msg.usage as unknown as Record<string, number | undefined>;
        const tokensIn =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const base = { tokensIn, tokensOut: usage.output_tokens ?? 0, costUsd: msg.total_cost_usd ?? 0 };
        if (msg.subtype === "success") {
          result = { ...base, status: msg.is_error ? "failed" : "succeeded", text: msg.result ?? "" };
          if (msg.is_error) result.error = msg.result || "model returned an error";
        } else if (msg.subtype === "error_max_budget_usd") {
          result = { ...base, status: "budget_stopped", text: "", error: "per-run budget reached" };
        } else {
          result = { ...base, status: "failed", text: "", error: `${msg.subtype}: ${(msg.errors ?? []).join("; ")}` };
        }
      }
    } catch (e) {
      result = { ...result, status: "failed", error: (e as Error).message };
    }
    return result;
  }
}
