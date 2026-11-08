import type { z } from "zod";

/** One tool as the model sees it. The handler's string is returned to the model as the tool result. */
export type DriverTool = {
  name: string; // model-facing name, [a-z0-9_]
  description: string;
  schema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

export type DriverInput = {
  model: string;
  system: string;
  prompt: string;
  tools: DriverTool[];
  maxBudgetUsd: number;
  maxTurns: number;
  apiKey: string | undefined;
};

export type DriverResult = {
  status: "succeeded" | "failed" | "budget_stopped";
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error?: string;
};

/** The runner talks to the model only through this, so tests can script the model. */
export interface ModelDriver {
  run(input: DriverInput): Promise<DriverResult>;
}
