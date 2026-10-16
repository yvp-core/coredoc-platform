/**
 * Analytics page contract: the wire DTOs live in `@coredoc/core/browser/analytics`
 * (shared with the desktop app); this module adds the web's window helpers.
 */
import { type AnalyticsWindow, AnalyticsWindowKind, MAX_ANALYTICS_DAYS } from '@coredoc/core/browser/analytics';

export * from '@coredoc/core/browser/analytics';

export const DAY_PRESETS = [7, 30, 90];

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC midnight ms for a `YYYY-MM-DD` string, or NaN when it is not one. */
function utcMidnight(date: string): number {
  return ISO_DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
}

/** Today in UTC as `YYYY-MM-DD` — the `max` of both date inputs. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Why the custom range cannot be requested yet, or null when it is valid. The
 * same predicates the server enforces (fail fast there, hint here).
 */
export function customWindowError(since: string, until: string): string | null {
  if (since === '' || until === '') return 'Pick a start and an end date.';
  const from = utcMidnight(since);
  const to = utcMidnight(until);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'Enter both dates as YYYY-MM-DD.';
  if (from > to) return 'The start date must be on or before the end date.';
  if ((to - from) / DAY_MS + 1 > MAX_ANALYTICS_DAYS) return `The range is limited to ${MAX_ANALYTICS_DAYS} days.`;
  return null;
}

/** Inclusive span of the window in days — what the captions name. */
export function windowDays(window: AnalyticsWindow): number {
  if (window.kind === AnalyticsWindowKind.Days) return window.days;
  const from = utcMidnight(window.since);
  const to = utcMidnight(window.until);
  if (Number.isNaN(from) || Number.isNaN(to))
    throw new Error(`Invalid analytics window: ${window.since}..${window.until}`);
  return (to - from) / DAY_MS + 1;
}

/** Query-string fragment for the three windowed reads. */
export function analyticsWindowParams(window: AnalyticsWindow): string {
  return window.kind === AnalyticsWindowKind.Days
    ? `days=${window.days}`
    : new URLSearchParams({ since: window.since, until: window.until }).toString();
}
