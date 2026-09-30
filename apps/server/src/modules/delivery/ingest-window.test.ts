import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOOKBACK_DAYS,
  lookbackIso,
  normalizeSince,
  resolveLookbackDays,
  resolveWindowStart,
  storedIngestWindow,
} from './ingest-window.js';

describe('lookbackIso', () => {
  it('returns the ISO cutoff `days` days before now (pure but for Date.now)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    try {
      expect(lookbackIso(30)).toBe(new Date('2026-06-22T00:00:00Z').toISOString());
      expect(lookbackIso(14)).toBe(new Date('2026-07-08T00:00:00Z').toISOString());
      expect(lookbackIso(1)).toBe(new Date('2026-07-21T00:00:00Z').toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveLookbackDays', () => {
  it('reads a positive numeric window from the connector config', () => {
    expect(resolveLookbackDays({ lookbackDays: 14 })).toBe(14);
    expect(resolveLookbackDays({ lookbackDays: 7.9 })).toBe(7); // floored
  });

  it('falls back to the default for absent, non-numeric, or non-positive values', () => {
    for (const config of [
      undefined,
      null,
      'not-an-object',
      [],
      {},
      { lookbackDays: '30' },
      { lookbackDays: 0 },
      { lookbackDays: -5 },
      { lookbackDays: Number.NaN },
      { lookbackDays: Number.POSITIVE_INFINITY },
    ]) {
      expect(resolveLookbackDays(config)).toBe(DEFAULT_LOOKBACK_DAYS);
    }
  });
});

describe('normalizeSince', () => {
  it('normalizes parseable instants to ISO, including date-only input', () => {
    expect(normalizeSince('2026-08-01T09:30:00.000Z')).toBe('2026-08-01T09:30:00.000Z');
    expect(normalizeSince('2026-08-01')).toBe('2026-08-01T00:00:00.000Z');
    expect(normalizeSince('2026-08-01T12:00:00+02:00')).toBe('2026-08-01T10:00:00.000Z');
  });

  it('returns null for absent or unparseable values', () => {
    for (const value of [undefined, null, '', 'yesterday', 42, {}, ['2026-08-01']]) {
      expect(normalizeSince(value)).toBeNull();
    }
  });
});

describe('resolveWindowStart', () => {
  it('prefers an absolute since over the relative window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    try {
      expect(resolveWindowStart({ since: '2026-08-01' })).toBe('2026-08-01T00:00:00.000Z');
      // since wins even when a lookbackDays also survives in stored config
      expect(resolveWindowStart({ since: '2026-08-01', lookbackDays: 1 })).toBe('2026-08-01T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the window when since is absent or corrupt — never wedges the connector', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    try {
      expect(resolveWindowStart({ lookbackDays: 7 })).toBe('2026-08-28T00:00:00.000Z');
      expect(resolveWindowStart({ since: 'not-a-date', lookbackDays: 7 })).toBe('2026-08-28T00:00:00.000Z');
      expect(resolveWindowStart({})).toBe(lookbackIso(DEFAULT_LOOKBACK_DAYS));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('storedIngestWindow', () => {
  it('reads back whichever single form the connector has stored', () => {
    expect(storedIngestWindow({ since: '2026-08-01T00:00:00.000Z' })).toEqual({
      since: '2026-08-01T00:00:00.000Z',
    });
    expect(storedIngestWindow({ lookbackDays: 7 })).toEqual({ lookbackDays: 7 });
    // Defensive: a config carrying both (hand-edited) resolves the same way the
    // importers do — since wins.
    expect(storedIngestWindow({ since: '2026-08-01', lookbackDays: 7 })).toEqual({
      since: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns null when no usable floor is stored, so the caller can apply its default', () => {
    for (const config of [undefined, null, {}, { repos: ['o/r'] }, { since: 'nope' }, { lookbackDays: 0 }]) {
      expect(storedIngestWindow(config)).toBeNull();
    }
    // A corrupt `since` still yields the window stored beside it.
    expect(storedIngestWindow({ since: 'nope', lookbackDays: 7 })).toEqual({ lookbackDays: 7 });
  });
});
