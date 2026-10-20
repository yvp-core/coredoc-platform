/**
 * How many callers and reaching entrypoints `find_callers` / `analyze_change_impact` return. Both
 * lists are nearest first. One row beyond the cap is fetched so the answer can say that more exist,
 * instead of presenting a truncated list as the whole impact.
 */
export const CALLER_CAP = 100;
export const ENTRYPOINT_CAP = 100;
/** Entrypoints a text summary lists before "… and N more"; the raw answer carries all of them. */
export const ENTRYPOINT_SUMMARY_ROWS = 20;

/** Rows `fetch(cap + 1)` returned, cut to `cap`, and whether the cut dropped any. */
export async function capped<T>(
  fetch: (limit: number) => Promise<T[]>,
  cap: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const rows = await fetch(cap + 1);
  return { items: rows.slice(0, cap), truncated: rows.length > cap };
}

/**
 * Which caller list a cut shortened. Callers come nearest first, so the cut falls on the
 * transitive list, or on the direct one when every listed caller is direct.
 */
export function callerCuts(
  transitiveCallers: readonly unknown[],
  truncated?: { callers?: true },
): { direct: boolean; transitive: boolean } {
  const cut = !!truncated?.callers;
  return { direct: cut && transitiveCallers.length === 0, transitive: cut && transitiveCallers.length > 0 };
}

export const countLabel = (n: number, truncated?: boolean): string => (truncated ? `${n}+` : String(n));
