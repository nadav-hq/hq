/** Company id: lowercase, starts with a letter, letters/digits/hyphens (e.g. `hidden`, `media-li`). */
export const COMPANY_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Role: same alphabet as company ids. */
export const ROLE_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Agent id: `<company>.<role>` (e.g. `hidden.seo`, `hq.chief`). */
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/;

export function splitAgentId(id: string): { company: string; role: string } {
  const dot = id.indexOf(".");
  return { company: id.slice(0, dot), role: id.slice(dot + 1) };
}

/** The pseudo-company that owns HQ-level agents such as `hq.chief`. */
export const HQ_COMPANY_ID = "hq";
