import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnalyticsWindowKind, MAX_ANALYTICS_DAYS, analyticsWindowError } from '../../../shared/ipc-types.js';
import { dateToDay, dayToDate, presetRange, windowLabel } from '../../components/ui/date-range-picker';
import { WindowSelector, customRangeLabel, todayUtcDay } from './WindowSelector';

// Static markup only: the desktop suite runs in the vitest 'node' environment, so
// the open popover (a Radix portal into document.body) cannot be rendered here.
// What the closed control promises is asserted below; what the *open* one does —
// the three presets, a custom pick, Update blocked past the clamp — is asserted
// against the same component design in apps/web's analytics-render.test.tsx, and
// the arithmetic those depend on is pure and covered here.
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('WindowSelector', () => {
  it('names the preset on a single trigger that opens a dialog', () => {
    const html = render(
      createElement(WindowSelector, {
        value: { kind: AnalyticsWindowKind.Days, days: 30 },
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('Last 30 days');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    // The header holds the trigger and nothing else: no fields, no segmented row.
    expect(html).not.toContain('aria-label="From date"');
    expect(html).not.toContain('7d');
  });

  it('names the range itself when the window is a custom one', () => {
    const html = render(
      createElement(WindowSelector, {
        value: { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' },
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('1 Aug – 14 Aug');
    expect(html).not.toContain('Last 30 days');
  });
});

describe('windowLabel', () => {
  it('is the preset by name, and the range itself otherwise', () => {
    expect(windowLabel({ kind: AnalyticsWindowKind.Days, days: 7 })).toBe('Last 7 days');
    expect(windowLabel({ kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' })).toBe(
      '1 Aug – 14 Aug',
    );
  });
});

describe('presetRange', () => {
  it('is the last N UTC days ending today inclusive, for each of the three presets', () => {
    expect(presetRange(7, '2026-08-14')).toEqual({ since: '2026-08-08', until: '2026-08-14' });
    expect(presetRange(30, '2026-08-14')).toEqual({ since: '2026-07-16', until: '2026-08-14' });
    expect(presetRange(MAX_ANALYTICS_DAYS, '2026-08-14')).toEqual({ since: '2026-05-17', until: '2026-08-14' });
  });

  it('spans exactly the preset, so the widest preset is not itself over the clamp', () => {
    const { since, until } = presetRange(MAX_ANALYTICS_DAYS, '2026-03-31'); // across a DST boundary
    expect(analyticsWindowError(since, until)).toBeNull();
  });

  it('defaults to today in UTC', () => {
    expect(presetRange(7).until).toBe(todayUtcDay());
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

describe('customRangeLabel', () => {
  it('is day and month within one year, and carries the year when the range crosses one', () => {
    expect(customRangeLabel('2026-08-01', '2026-08-14')).toBe('1 Aug – 14 Aug');
    expect(customRangeLabel('2025-12-28', '2026-01-03')).toBe('28 Dec 25 – 3 Jan');
  });
});

describe('analyticsWindowError', () => {
  it('names the one thing that is wrong, and passes a valid range', () => {
    expect(analyticsWindowError('2026-08-01', '2026-08-14')).toBeNull();
    expect(analyticsWindowError('', '')).toMatch(/Pick a From and To date/);
    expect(analyticsWindowError('2026-08-01', '')).toMatch(/Pick a From and To date/);
    expect(analyticsWindowError('2026-08-14', '2026-08-01')).toMatch(/on or before/);
    expect(analyticsWindowError('2026-01-01', '2026-12-31')).toBe(`Range must be ${MAX_ANALYTICS_DAYS} days or fewer.`);
  });
});
