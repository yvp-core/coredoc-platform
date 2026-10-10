import { describe, expect, it } from 'vitest';
import { formatDurationMs, formatNumber, formatUsd, NO_DATA } from './format.js';

describe('formatNumber', () => {
  it('returns the no-data marker for null/undefined/NaN', () => {
    expect(formatNumber(null)).toBe(NO_DATA);
    expect(formatNumber(undefined)).toBe(NO_DATA);
    expect(formatNumber(Number.NaN)).toBe(NO_DATA);
  });

  it('renders sub-thousand values as plain rounded integers', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(12.6)).toBe('13');
  });

  it('renders compact thousands/millions/billions with trimmed .0', () => {
    expect(formatNumber(1000)).toBe('1K');
    expect(formatNumber(1200)).toBe('1.2K');
    expect(formatNumber(3_400_000)).toBe('3.4M');
    expect(formatNumber(1_500_000_000)).toBe('1.5B');
  });

  it('keeps the sign for negative magnitudes', () => {
    expect(formatNumber(-2500)).toBe('-2.5K');
  });

  it('promotes across the unit boundary instead of emitting 1000K/1000M', () => {
    // 999_999 / 1e3 rounds to 1000.0 — must read "1M", not "1000K".
    expect(formatNumber(999_999)).toBe('1M');
    expect(formatNumber(999_950)).toBe('1M');
    expect(formatNumber(999_949)).toBe('999.9K'); // just below the round-up point stays in K
    expect(formatNumber(999_999_999)).toBe('1B');
  });
});

describe('formatUsd', () => {
  it('returns the no-data marker for null/undefined', () => {
    expect(formatUsd(null)).toBe(NO_DATA);
    expect(formatUsd(undefined)).toBe(NO_DATA);
  });

  it('renders precise cents below the compact threshold', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('renders compact amounts at or above $10k', () => {
    expect(formatUsd(10_000)).toBe('$10K');
    expect(formatUsd(1_200_000)).toBe('$1.2M');
  });

  it('promotes across the unit boundary for near-$1M spend (no $1000K)', () => {
    expect(formatUsd(999_999.5)).toBe('$1M');
  });
});

describe('formatDurationMs', () => {
  it('returns the no-data marker for null/undefined', () => {
    expect(formatDurationMs(null)).toBe(NO_DATA);
    expect(formatDurationMs(undefined)).toBe(NO_DATA);
  });

  it('renders sub-minute durations as seconds', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(45_000)).toBe('45s');
  });

  it('renders minutes with optional trailing seconds', () => {
    expect(formatDurationMs(60_000)).toBe('1m');
    expect(formatDurationMs(200_000)).toBe('3m 20s');
  });

  it('renders hours with optional trailing minutes', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(3_720_000)).toBe('1h 2m');
  });
});
