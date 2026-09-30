import { describe, expect, it } from 'vitest';
import { validateAnalyticsWindow } from './analytics-window.js';
import { AnalyticsWindowKind, analyticsWindowParams, windowDays, type AnalyticsWindow } from '../shared/ipc-types.js';

const DAYS: AnalyticsWindow = { kind: AnalyticsWindowKind.Days, days: 30 };
const CUSTOM: AnalyticsWindow = { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' };

describe('analyticsWindowParams', () => {
  it('emits days for a preset and the date pair for a custom range', () => {
    expect(analyticsWindowParams(DAYS)).toEqual({ days: '30' });
    expect(analyticsWindowParams(CUSTOM)).toEqual({ since: '2026-08-01', until: '2026-08-14' });
  });
});

describe('windowDays', () => {
  it('is the preset value, or the inclusive span of a custom range', () => {
    expect(windowDays(DAYS)).toBe(30);
    expect(windowDays(CUSTOM)).toBe(14);
    expect(windowDays({ kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-01' })).toBe(1);
    // Spans a DST change in every non-UTC zone; the basis is UTC, so it stays whole.
    expect(windowDays({ kind: AnalyticsWindowKind.Custom, since: '2026-03-01', until: '2026-03-31' })).toBe(31);
  });
});

describe('validateAnalyticsWindow', () => {
  it('accepts both window kinds and strips anything else off the object', () => {
    expect(validateAnalyticsWindow({ ...DAYS, days: 90 })).toEqual({ kind: AnalyticsWindowKind.Days, days: 90 });
    expect(validateAnalyticsWindow({ ...CUSTOM, mine: true })).toEqual(CUSTOM);
  });

  it.each([
    ['a non-object', 30],
    ['null', null],
    ['an array', []],
    ['an unknown kind', { kind: 'rolling', days: 30 }],
    ['a zero day count', { kind: AnalyticsWindowKind.Days, days: 0 }],
    ['a fractional day count', { kind: AnalyticsWindowKind.Days, days: 1.5 }],
    ['a day count past the ceiling', { kind: AnalyticsWindowKind.Days, days: 91 }],
    ['a missing until', { kind: AnalyticsWindowKind.Custom, since: '2026-08-01' }],
    ['a non-string date', { kind: AnalyticsWindowKind.Custom, since: 20260801, until: '2026-08-14' }],
    ['an unpadded date', { kind: AnalyticsWindowKind.Custom, since: '2026-8-1', until: '2026-08-14' }],
    ['a calendar-invalid date', { kind: AnalyticsWindowKind.Custom, since: '2026-02-31', until: '2026-03-14' }],
    ['a reversed range', { kind: AnalyticsWindowKind.Custom, since: '2026-08-14', until: '2026-08-01' }],
    ['a range past the ceiling', { kind: AnalyticsWindowKind.Custom, since: '2026-01-01', until: '2026-04-01' }],
  ])('refuses %s', (_label, raw) => {
    expect(() => validateAnalyticsWindow(raw)).toThrow(TypeError);
  });

  it('accepts exactly the ceiling span', () => {
    // 2026-08-01 .. 2026-10-29 inclusive is 90 days.
    expect(windowDays(validateAnalyticsWindow({ kind: 'custom', since: '2026-08-01', until: '2026-10-29' }))).toBe(90);
    expect(() => validateAnalyticsWindow({ kind: 'custom', since: '2026-08-01', until: '2026-10-30' })).toThrow();
  });
});
