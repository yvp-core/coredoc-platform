import { describe, expect, it } from 'vitest';
import {
  type AnalyticsWindow,
  AnalyticsWindowKind,
  analyticsWindowParams,
  customWindowError,
  windowDays,
} from './types.js';
import { dateToDay, dayToDate, presetRange, windowLabel } from '@/components/ui/date-range-picker';
import { customRangeLabel } from './WindowSelector.js';

const custom = (since: string, until: string): AnalyticsWindow => ({
  kind: AnalyticsWindowKind.Custom,
  since,
  until,
});

describe('analyticsWindowParams', () => {
  it('sends days for a preset window', () => {
    expect(analyticsWindowParams({ kind: AnalyticsWindowKind.Days, days: 30 })).toBe('days=30');
  });

  it('sends since/until for a custom window', () => {
    expect(analyticsWindowParams(custom('2026-01-01', '2026-01-31'))).toBe('since=2026-01-01&until=2026-01-31');
  });
});

describe('windowDays', () => {
  it('is the preset itself', () => {
    expect(windowDays({ kind: AnalyticsWindowKind.Days, days: 7 })).toBe(7);
  });

  it('is the inclusive span of a custom window', () => {
    expect(windowDays(custom('2026-01-01', '2026-01-01'))).toBe(1);
    expect(windowDays(custom('2026-01-01', '2026-01-31'))).toBe(31);
    // across a DST boundary — the window is UTC calendar days, not local ones
    expect(windowDays(custom('2026-03-28', '2026-03-31'))).toBe(4);
  });

  it('throws on a malformed custom window rather than reporting a bogus span', () => {
    expect(() => windowDays(custom('nope', '2026-01-31'))).toThrow(/Invalid analytics window/);
  });
});

describe('customWindowError', () => {
  it('accepts a valid range up to the 90-day clamp', () => {
    expect(customWindowError('2026-01-01', '2026-01-31')).toBeNull();
    expect(customWindowError('2026-01-01', '2026-03-31')).toBeNull(); // 90 days inclusive
  });

  it('rejects empty, malformed, inverted and over-long ranges', () => {
    expect(customWindowError('', '2026-01-31')).toMatch(/Pick a start/);
    expect(customWindowError('2026-13-01', '2026-01-31')).toMatch(/YYYY-MM-DD/);
    expect(customWindowError('2026-02-01', '2026-01-31')).toMatch(/on or before/);
    expect(customWindowError('2026-01-01', '2026-04-01')).toMatch(/90 days/); // 91 days inclusive
  });
});

describe('customRangeLabel', () => {
  it('is day and month within one year, and carries the year when the range crosses one', () => {
    expect(customRangeLabel('2026-08-01', '2026-08-14')).toBe('1 Aug – 14 Aug');
    expect(customRangeLabel('2025-12-28', '2026-01-03')).toBe('28 Dec 25 – 3 Jan');
  });
});

describe('presetRange', () => {
  it('is the last N UTC days ending today inclusive, for each of the three presets', () => {
    expect(presetRange(7, '2026-08-14')).toEqual({ since: '2026-08-08', until: '2026-08-14' });
    expect(presetRange(30, '2026-08-14')).toEqual({ since: '2026-07-16', until: '2026-08-14' });
    expect(presetRange(90, '2026-08-14')).toEqual({ since: '2026-05-17', until: '2026-08-14' });
  });

  it('spans exactly the preset, so the widest preset is not itself over the clamp', () => {
    const { since, until } = presetRange(90, '2026-03-31'); // across a DST boundary
    expect(customWindowError(since, until)).toBeNull();
    expect(windowDays(custom(since, until))).toBe(90);
  });
});

describe('day ↔ Date conversion', () => {
  it('round-trips every calendar day unchanged, whatever the host timezone', () => {
    for (const day of ['2026-01-01', '2026-03-29', '2026-08-14', '2025-12-31', '2026-10-25']) {
      expect(dateToDay(dayToDate(day))).toBe(day);
    }
  });

  it('reads back the calendar fields the day names, not a UTC projection of them', () => {
    const date = dayToDate('2026-08-01');
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([2026, 8, 1]);
  });
});

describe('windowLabel', () => {
  it('is the preset by name, and the range itself otherwise', () => {
    expect(windowLabel({ kind: AnalyticsWindowKind.Days, days: 7 })).toBe('Last 7 days');
    expect(windowLabel(custom('2026-08-01', '2026-08-14'))).toBe('1 Aug – 14 Aug');
  });
});
