/**
 * Renderer console errors the suite tolerates.
 *
 * SHIPS EMPTY AND STAYS THAT WAY BY DEFAULT. Every entry needs a `reason`
 * naming the third-party source and why the app cannot silence it — an entry
 * without one is a real regression being hidden, which is exactly what the
 * console guard exists to catch. Review gate, not a formality.
 */
export interface ConsoleAllowlistEntry {
  pattern: RegExp;
  reason: string;
}

export const consoleAllowlist: ConsoleAllowlistEntry[] = [];

export function isAllowlisted(text: string): boolean {
  return consoleAllowlist.some((entry) => entry.pattern.test(text));
}
