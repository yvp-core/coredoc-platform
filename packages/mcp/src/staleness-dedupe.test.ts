/**
 * Tests for the session-scoped staleness-banner dedupe (staleness-dedupe.ts).
 */

import { describe, it, expect } from 'vitest';
import { shouldRenderFullBanner, STALENESS_REFRESH_INTERVAL, STALENESS_SESSION_CAP } from './staleness-dedupe.js';

// Each test uses its own session key(s) — the module keeps process-lifetime
// state, so reusing a key across tests would leak state between them.
let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `test-session-${keyCounter}`;
}

const repo = (name: string, parsedAt: string, parsedCommit?: string) => ({ name, parsedAt, parsedCommit });

describe('shouldRenderFullBanner', () => {
  it('renders full on the first mention of a repo in a session', () => {
    const key = freshKey();
    expect(shouldRenderFullBanner(key, [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')])).toBe(true);
  });

  it('renders compact on a repeat mention with unchanged state', () => {
    const key = freshKey();
    const repos = [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')];
    expect(shouldRenderFullBanner(key, repos)).toBe(true);
    expect(shouldRenderFullBanner(key, repos)).toBe(false);
  });

  it('renders full again when the repo parse state changed', () => {
    const key = freshKey();
    expect(shouldRenderFullBanner(key, [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')])).toBe(true);
    expect(shouldRenderFullBanner(key, [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')])).toBe(false);
    // Same repo, new commit — parse state changed.
    expect(shouldRenderFullBanner(key, [repo('r1', '2024-01-16T10:30:00.000Z', 'def456')])).toBe(true);
  });

  it('renders full for the whole banner when a second repo joins the scope mid-session', () => {
    const key = freshKey();
    const r1 = repo('r1', '2024-01-15T10:30:00.000Z', 'abc123');
    const r2 = repo('r2', '2024-01-15T10:30:00.000Z', 'zzz999');
    expect(shouldRenderFullBanner(key, [r1])).toBe(true);
    expect(shouldRenderFullBanner(key, [r1])).toBe(false);
    // r1 unchanged, but r2 is new to the session — any-new forces full for both.
    expect(shouldRenderFullBanner(key, [r1, r2])).toBe(true);
  });

  it('always renders full when no session key is available', () => {
    const repos = [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')];
    expect(shouldRenderFullBanner(undefined, repos)).toBe(true);
    expect(shouldRenderFullBanner(undefined, repos)).toBe(true);
  });

  it('forces a full refresh every STALENESS_REFRESH_INTERVAL-th emission', () => {
    const key = freshKey();
    const repos = [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')];
    const results: boolean[] = [];
    for (let i = 0; i < STALENESS_REFRESH_INTERVAL; i++) {
      results.push(shouldRenderFullBanner(key, repos));
    }
    // First emission full (new), 2..19 compact (unchanged), 20th forced full.
    expect(results[0]).toBe(true);
    expect(results.slice(1, STALENESS_REFRESH_INTERVAL - 1)).toEqual(
      new Array(STALENESS_REFRESH_INTERVAL - 2).fill(false),
    );
    expect(results[STALENESS_REFRESH_INTERVAL - 1]).toBe(true);
  });

  it('evicts the oldest session once the tracked-session cap is hit', () => {
    const firstKey = freshKey();
    const repos = [repo('r1', '2024-01-15T10:30:00.000Z', 'abc123')];
    expect(shouldRenderFullBanner(firstKey, repos)).toBe(true);

    // Push the cap's worth of *other* sessions through so `firstKey` becomes
    // the oldest tracked entry and gets evicted.
    for (let i = 0; i < STALENESS_SESSION_CAP; i++) {
      shouldRenderFullBanner(freshKey(), repos);
    }

    // Evicted: the session forgot firstKey's state, so its state looks "new"
    // again rather than the module growing unbounded state for it forever.
    expect(shouldRenderFullBanner(firstKey, repos)).toBe(true);
  });
});
