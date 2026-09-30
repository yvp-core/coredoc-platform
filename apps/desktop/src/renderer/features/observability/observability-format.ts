/**
 * Pure display formatters for the observability surface. Kept dependency-free and
 * side-effect-free so they are trivially unit-tested (no DOM, no IPC).
 *
 * Note: the renderer already has a plain `formatNumber` in lib/utils.ts, but it is
 * a bare `toLocaleString()` (no compact notation). These are the observability
 * variants the KPI tiles need — compact magnitudes, currency, and durations — and
 * deliberately live in the feature so the utils helper's callers are untouched.
 */

/** Rendered for a null/undefined metric — "no data", distinct from a real 0. */
export const NO_DATA = '—';

/** "1 session" / "3 sessions" — the count and its noun, agreeing. Regular plurals only. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Compact magnitude: 999 → "999", 1_200 → "1.2k", 3_400_000 → "3.4M",
 * 1_500_000_000 → "1.5B". Trailing ".0" is trimmed. Negative values keep sign.
 */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return NO_DATA;
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [factor, suffix] of units) {
    // Promote across the unit boundary: 999_999 / 1e3 rounds to 1000.0 at one
    // decimal, which should read "1M", not "1000k". n/factor rounds up to 1000
    // exactly when abs >= factor * 0.99995, so use that as the threshold. (The
    // top unit "B" can only overflow past ~1e12, beyond anything this surface shows.)
    if (abs >= factor * 0.99995) {
      const scaled = (n / factor).toFixed(1).replace(/\.0$/, '');
      return `${scaled}${suffix}`;
    }
  }
  // Unreachable (abs >= 1000 guaranteed above), but keeps the return total.
  return String(Math.round(n));
}

/**
 * USD amount: precise cents under $10k ($12.50), compact above ($15k, $1.2M).
 * The threshold keeps small per-user spends readable while large team spends
 * stay glanceable in a KPI tile.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return NO_DATA;
  if (Math.abs(n) >= 10_000) return `$${formatNumber(n)}`;
  return `$${n.toFixed(2)}`;
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
