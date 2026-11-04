/**
 * Tools the engine implements, keyed by the name used in cards (spec §9).
 * Cards may list tools that are not implemented yet (web_search, github.*, telegram.notify, ...);
 * the runner simply does not expose those and logs them.
 *
 * sideEffect: in shadow mode the call becomes a proposal (approval row with shadow=true).
 * external:   leaves HQ (send / publish / pay); always needs approval in active mode (spec §6 step 5).
 */
export type ToolSpec = { sideEffect: boolean; external: boolean; description: string };

export const TOOL_CATALOG: Record<string, ToolSpec> = {
  "memory.write": { sideEffect: false, external: false, description: "Save a memory note for future runs" },
  "status.set": { sideEffect: false, external: false, description: "Set your one-line status" },
  "db.read": { sideEffect: false, external: false, description: "Read rows from a table in your company schema" },
  "db.write": { sideEffect: true, external: false, description: "Insert a row into a table in your company schema" },
  "queue.create_task": { sideEffect: true, external: false, description: "Hand a task to another agent" },
  "approval.request": { sideEffect: true, external: false, description: "Ask Nadav to approve an action" },
  "test.ping": { sideEffect: true, external: false, description: "Harmless test side effect (writes an hq.events row)" },
};

/** Tools every agent gets regardless of its card: the close step (spec §6 step 7). */
export const ALWAYS_ON_TOOLS = ["memory.write", "status.set"] as const;

/** `db.read:hidden.products` → { base: "db.read", arg: "hidden.products" } */
export function splitToolRef(ref: string): { base: string; arg: string | null } {
  const i = ref.indexOf(":");
  return i < 0 ? { base: ref, arg: null } : { base: ref.slice(0, i), arg: ref.slice(i + 1) };
}
