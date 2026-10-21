/**
 * Tests for the session-scoped staleness-banner dedupe (staleness-dedupe.ts).
 */

import { describe, it, expect } from 'vitest';
import { isRepeatBanner, STALENESS_REFRESH_INTERVAL, STALENESS_SESSION_CAP } from './staleness-dedupe.js';

// Each test uses its own session key(s) — the module keeps process-lifetime
// state, so reusing a key across tests would leak state between them.
let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `test-session-${keyCounter}`;
}

const banner = '> snapshot r1@abc1234 · 2024-01-15\n';

describe('isRepeatBanner', () => {
  it('shows a banner the first time and suppresses an exact repeat', () => {
    const key = freshKey();
    expect(isRepeatBanner(key, banner)).toBe(false);
    expect(isRepeatBanner(key, banner)).toBe(true);
  });

  it('shows a changed banner again', () => {
    const key = freshKey();
    isRepeatBanner(key, banner);
    expect(isRepeatBanner(key, '> snapshot r1@def5678 · 2024-01-16\n')).toBe(false);
  });

  it('never suppresses without a session key', () => {
    expect(isRepeatBanner(undefined, banner)).toBe(false);
    expect(isRepeatBanner(undefined, banner)).toBe(false);
  });

  it('keeps sessions apart', () => {
    isRepeatBanner(freshKey(), banner);
    expect(isRepeatBanner(freshKey(), banner)).toBe(false);
  });

  it('re-shows an unchanged banner every STALENESS_REFRESH_INTERVAL-th emission', () => {
    const key = freshKey();
    const results: boolean[] = [];
    for (let i = 0; i < STALENESS_REFRESH_INTERVAL; i++) results.push(isRepeatBanner(key, banner));
    expect(results[0]).toBe(false);
    expect(results.slice(1, STALENESS_REFRESH_INTERVAL - 1)).toEqual(
      new Array(STALENESS_REFRESH_INTERVAL - 2).fill(true),
    );
    expect(results[STALENESS_REFRESH_INTERVAL - 1]).toBe(false);
  });

  it('evicts the oldest session once the tracked-session cap is hit', () => {
    const firstKey = freshKey();
    isRepeatBanner(firstKey, banner);
    for (let i = 0; i < STALENESS_SESSION_CAP; i++) isRepeatBanner(freshKey(), banner);
    expect(isRepeatBanner(firstKey, banner)).toBe(false);
  });
});
