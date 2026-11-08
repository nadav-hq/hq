import type { LoadedCard } from "../loader/load-company.ts";

/**
 * Who may hand a task to whom (spec §6 step 6):
 *   worker   → its manager (reports_to) or another worker in the same company
 *   manager  → its own workers (cards with reports_to = manager)
 *   hq.chief → any company manager
 * Returns null if allowed, else the reason.
 */
export function handoffError(
  from: { id: string; reports_to?: string },
  to: string,
  companyCards: LoadedCard[],
): string | null {
  if (to === from.id) return "an agent cannot send a task to itself";
  if (from.id === "hq.chief") return /^[a-z][a-z0-9-]*\.manager$/.test(to) ? null : "hq.chief may only send tasks to managers";

  const company = from.id.split(".")[0]!;
  const target = companyCards.find((c) => c.id === to);
  if (!target) return `"${to}" is not an agent in ${company}`;
  const isManager = from.id === `${company}.manager`;
  if (isManager) return target.reports_to === from.id ? null : `"${to}" does not report to ${from.id}`;
  if (to === from.reports_to) return null;
  if (to === `${company}.manager`) return `you report to ${from.reports_to}, not ${to}`;
  return null; // another worker in the same company
}
