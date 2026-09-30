import { BadRequestException } from '@nestjs/common';

/** LIM-4: the largest day selector value; caps the window in days every analytics read may span. */
export const MAX_ANALYTICS_DAYS = 90;

/**
 * The one custom-range parser shared by the usage and delivery reads: `since`/`until` are
 * inclusive UTC calendar days, and the resolved window is `[since, untilExclusive)` so every
 * consumer bounds the same way. Invalid input throws instead of clamping — a silently widened
 * or narrowed range would show numbers nobody asked for (fail fast).
 */

const DAY_MS = 86_400_000;
const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CustomWindowBounds {
  /** Inclusive span in days (`until - since + 1`). */
  days: number;
  since: Date;
  /** Exclusive end: UTC midnight of the day after `until`. */
  untilExclusive: Date;
}

function calendarDayMs(raw: string, name: string): number {
  if (!CALENDAR_DAY_RE.test(raw)) throw new BadRequestException(`${name} must be a YYYY-MM-DD calendar day`);
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  const ms = parsed.getTime();
  // Rejects real-looking but non-existent days (2026-02-30) that Date would roll over.
  if (!Number.isFinite(ms) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new BadRequestException(`${name} must be a valid calendar day`);
  }
  return ms;
}

/**
 * Returns null when neither bound is given (the caller falls back to its `days` window);
 * throws `BadRequestException` for a half-specified, malformed, inverted or oversized range.
 */
export function parseCustomWindow(rawSince: unknown, rawUntil: unknown): CustomWindowBounds | null {
  const since = rawSince === undefined || rawSince === null || rawSince === '' ? null : String(rawSince);
  const until = rawUntil === undefined || rawUntil === null || rawUntil === '' ? null : String(rawUntil);
  if (since === null && until === null) return null;
  if (since === null || until === null) {
    throw new BadRequestException('since and until must be provided together');
  }

  const sinceMs = calendarDayMs(since, 'since');
  const untilMs = calendarDayMs(until, 'until');
  // A future `until` cannot be answered: it widens the range past the data that exists and
  // makes every per-day average divide by days nobody could have worked. Today (UTC) is
  // allowed — the current, still-incomplete day is a legitimate end.
  if (untilMs > Math.floor(Date.now() / DAY_MS) * DAY_MS) {
    throw new BadRequestException('until must not be in the future');
  }
  if (sinceMs > untilMs) throw new BadRequestException('since must not be after until');
  const days = (untilMs - sinceMs) / DAY_MS + 1;
  if (days > MAX_ANALYTICS_DAYS) {
    throw new BadRequestException(`the since..until range must span at most ${MAX_ANALYTICS_DAYS} days`);
  }
  return { days, since: new Date(sinceMs), untilExclusive: new Date(untilMs + DAY_MS) };
}
