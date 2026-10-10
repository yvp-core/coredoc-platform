/**
 * Pure display formatters for the analytics surfaces of the web and desktop
 * apps — compact magnitudes, currency and durations. Dependency-free and
 * side-effect-free.
 */

/** Rendered for a null/undefined metric — "no data", distinct from a real 0. */
export const NO_DATA = '—';

/** "1 session" / "3 sessions" — the count and its noun, agreeing. Pass `many` for irregular plurals. */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/** Compact magnitude, whole below 1000: 999 → "999", 1_200 → "1.2K", 3_400_000 → "3.4M". */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return NO_DATA;
  return COMPACT.format(Math.round(n));
}

/**
 * USD amount: precise cents under $10k ($12.50), compact above ($15K, $1.2M).
 * The threshold keeps small per-user spends readable while large team spends
 * stay glanceable in a KPI tile.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return NO_DATA;
  return (Math.abs(n) >= 10_000 ? USD_COMPACT : USD).format(n);
}

/**
 * Millisecond duration → compact "45s" / "3m 20s" / "1h 2m". Sub-minute renders
 * seconds only; the largest two units are shown otherwise.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return NO_DATA;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}
