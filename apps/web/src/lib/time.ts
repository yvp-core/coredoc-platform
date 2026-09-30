/**
 * Small relative-time formatter built on `Intl.RelativeTimeFormat` — no
 * dayjs/date-fns dependency for a single call site (YAGNI).
 */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
];

/**
 * Formats an ISO timestamp relative to `now` (defaults to `new Date()`).
 * Returns `'never'` for `null` — the caller's "never pushed" state.
 */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'never';

  const diffMs = new Date(iso).getTime() - now.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) return 'just now';

  for (const { unit, ms } of UNITS) {
    if (absMs >= ms || unit === 'minute') {
      const value = Math.round(diffMs / ms);
      return rtf.format(value, unit);
    }
  }

  // Unreachable: the loop's last entry (minute) always matches.
  return 'just now';
}
