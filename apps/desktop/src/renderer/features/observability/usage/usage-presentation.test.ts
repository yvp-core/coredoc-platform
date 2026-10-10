import { describe, expect, it } from 'vitest';
import type { UsageMemberRow, UsageToolRow } from '../../../../shared/ipc-types.js';
import type { UsageAdoption } from '../../../../shared/ipc-types.js';
import { NO_DATA } from '@coredoc/core/browser/format';
import { USAGE_FIXTURE } from './usage-fixture';
import {
  adoptionFacts,
  adoptionMeter,
  deltaPresentation,
  developersHint,
  formatMs,
  nextMemberSort,
  relativeDayLabel,
  sortMembers,
  sparkFromSeries,
  spendCaption,
  spendSeriesCaption,
  toolPills,
  windowCaption,
} from './usage-presentation';

const tool = (over: Partial<UsageToolRow>): UsageToolRow => ({
  toolName: 't',
  calls: 100,
  errorRate: 0,
  avgMs: 10,
  emptyRate: 0,
  classifiedCalls: 100,
  ...over,
});

const member = (over: Partial<UsageMemberRow>): UsageMemberRow => ({
  userId: null,
  userEmail: null,
  displayName: null,
  sessions: 0,
  tokens: 0,
  estimatedCostUsd: null,
  unpricedSessions: 0,
  coredocCalls: 0,
  topTool: null,
  lastActiveAt: null,
  ...over,
});

describe('deltaPresentation (BR-2)', () => {
  it('reports no prior data when the previous window is zero, rather than an infinite gain', () => {
    expect(deltaPresentation(86, 0, 'up-good', 30)).toEqual({ kind: 'no-prior' });
  });

  it('reports no prior data when the previous spend could not be priced at all', () => {
    expect(deltaPresentation(12, null, 'down-good', 30)).toEqual({ kind: 'no-prior' });
  });

  it('marks a rise in an up-good metric as up and names the compared window', () => {
    expect(deltaPresentation(1240, 980, 'up-good', 30)).toEqual({
      kind: 'delta',
      sign: 1,
      tone: 'up',
      text: '▲ 27% vs prev 30d',
    });
  });

  it('marks a rise in a down-good metric (spend) as down', () => {
    expect(deltaPresentation(120, 100, 'down-good', 7)).toEqual({
      kind: 'delta',
      sign: 1,
      tone: 'down',
      text: '▲ 20% vs prev 7d',
    });
  });

  it('marks a fall in a down-good metric as up', () => {
    expect(deltaPresentation(80, 100, 'down-good', 7)).toEqual({
      kind: 'delta',
      sign: -1,
      tone: 'up',
      text: '▼ 20% vs prev 7d',
    });
  });

  it('treats a move inside ±0.5% as flat in either direction', () => {
    expect(deltaPresentation(1004, 1000, 'up-good', 30)).toEqual({
      kind: 'delta',
      sign: 0,
      tone: 'flat',
      text: '· 0% vs prev 30d',
    });
    expect(deltaPresentation(996, 1000, 'up-good', 30)).toMatchObject({ sign: 0, tone: 'flat' });
  });

  it('crosses into a signed delta exactly at the ±0.5% threshold', () => {
    expect(deltaPresentation(1005, 1000, 'up-good', 30)).toMatchObject({ sign: 1, tone: 'up' });
    expect(deltaPresentation(995, 1000, 'up-good', 30)).toMatchObject({ sign: -1, tone: 'down' });
  });

  it('never colors a neutral metric', () => {
    expect(deltaPresentation(9, 6, 'neutral', 30)).toMatchObject({ sign: 1, tone: 'flat' });
  });

  it('caps an absurd move instead of overflowing the tile with a five-digit percentage', () => {
    expect(deltaPresentation(50_000, 10, 'up-good', 30)).toMatchObject({ text: '▲ >999% vs prev 30d' });
    // Just under the cap still states the exact figure.
    expect(deltaPresentation(1099, 100, 'up-good', 30)).toMatchObject({ text: '▲ 999% vs prev 30d' });
  });
});

describe('toolPills (BR-3, AC-3)', () => {
  it('flags an error rate at or above 3% and leaves a lower one neutral', () => {
    expect(toolPills(tool({ errorRate: 0.03 })).error).toEqual({ tone: 'danger', text: '3.0% err' });
    expect(toolPills(tool({ errorRate: 0.029 })).error).toEqual({ tone: 'ok', text: '2.9% err' });
  });

  it('warns on an empty rate at or above 15% and leaves a lower one neutral', () => {
    expect(toolPills(tool({ emptyRate: 0.15 })).empty).toEqual({ tone: 'warn', text: '15.0% empty' });
    expect(toolPills(tool({ emptyRate: 0.14 })).empty).toEqual({ tone: 'ok', text: '14.0% empty' });
  });

  it('states both pills on one decimal scale', () => {
    const pills = toolPills(tool({ errorRate: 0.027, emptyRate: 0.235 }));
    expect([pills.error.text, pills.empty.text]).toEqual(['2.7% err', '23.5% empty']);
  });

  it('states no empty rate at all when no call was classified', () => {
    expect(toolPills(tool({ emptyRate: null, classifiedCalls: 0 })).empty).toEqual({ tone: 'absent', text: '' });
  });
});

const adoption = (over: Partial<UsageAdoption>): UsageAdoption => ({
  developersUsingCoredoc: 0,
  developersActive: 0,
  totalCoredocCalls: 0,
  coredocSuccessRate: null,
  avgCallLatencyMs: null,
  medianTokensPerSession: null,
  ...over,
});

describe('formatMs', () => {
  it('states whole milliseconds instead of the raw float the server averages to', () => {
    expect(formatMs(40.49315068493151)).toBe('40 ms');
    expect(formatMs(90.5)).toBe('91 ms');
  });
});

describe('adoption presentation (BR-3, BR-11)', () => {
  it('meters the share of active developers that called Coredoc', () => {
    expect(adoptionMeter(adoption({ developersUsingCoredoc: 3, developersActive: 6 }))).toEqual({
      text: '50%',
      widthPct: 50,
    });
  });

  it('shows a dash rather than 0% when nobody was active in the window', () => {
    expect(adoptionMeter(adoption({ developersActive: 0 }))).toEqual({ text: NO_DATA, widthPct: 0 });
  });

  it('degrades the server-observed rates to dashes instead of asserting a perfect run', () => {
    expect(adoptionFacts(adoption({ developersActive: 4 })).map((fact) => fact.value)).toEqual([
      '0',
      NO_DATA,
      NO_DATA,
      NO_DATA,
    ]);
  });

  it('states the observed Coredoc figures, no host-telemetry caveat', () => {
    const facts = adoptionFacts(
      adoption({
        totalCoredocCalls: 1240,
        coredocSuccessRate: 0.974,
        avgCallLatencyMs: 132.4,
        medianTokensPerSession: 84_000,
      }),
    );

    expect(facts).toEqual([
      { label: 'Coredoc calls', value: '1.2K' },
      { label: 'Call success rate', value: '97.4%' },
      { label: 'Avg call latency', value: '132 ms' },
      { label: 'Median tokens / session', value: '84K' },
    ]);
  });

  it('states the developer ratio unconditionally now that both sides are server-observed', () => {
    expect(developersHint({ current: 6, usingCoredoc: 4 })).toBe('4 of 6 use Coredoc');
    expect(developersHint({ current: 0, usingCoredoc: 0 })).toBe('0 of 0 use Coredoc');
  });
});

describe('spendSeriesCaption (BR-17, LIM-1)', () => {
  it('claims gaps only when a day actually broke the line', () => {
    expect(spendSeriesCaption(USAGE_FIXTURE.series.spendUsd, 3)).toBe(
      '3 sessions ran on a model the price map does not cover in this window; those days are gaps, not zeros.',
    );
  });

  it('says the cost is excluded when every day is priced', () => {
    expect(
      spendSeriesCaption([{ date: '2026-09-01', value: 4, unpricedSessions: 1, sessionsWithoutUsage: 0 }], 1),
    ).toBe('1 session ran on a model the price map does not cover in this window; their cost is excluded.');
  });

  it('is absent when the price map covered every session and every session reported usage', () => {
    expect(spendSeriesCaption(USAGE_FIXTURE.series.spendUsd, 0)).toBeNull();
  });

  it('names a gap caused by missing usage telemetry even when the price map covered every session', () => {
    const points = [{ date: '2026-09-01', value: null, unpricedSessions: 0, sessionsWithoutUsage: 2 }];
    expect(spendSeriesCaption(points, 0, 2)).toBe(
      '2 sessions reported no usage data at all in this window; those days are gaps, not zeros.',
    );
  });

  it('names both causes together when a window has both kinds of gap', () => {
    const points = [{ date: '2026-09-01', value: null, unpricedSessions: 1, sessionsWithoutUsage: 2 }];
    expect(spendSeriesCaption(points, 1, 2)).toBe(
      '1 session ran on a model the price map does not cover and 2 sessions reported no usage data at all in this window; those days are gaps, not zeros.',
    );
  });
});

describe('sortMembers', () => {
  const rows = [
    member({ userId: 'c', displayName: 'Carol', coredocCalls: 0, sessions: 4, estimatedCostUsd: null }),
    member({ userId: 'b', displayName: 'Bob', coredocCalls: 310, sessions: 21, estimatedCostUsd: 18.4 }),
    member({ userId: 'a', displayName: 'Alice', coredocCalls: 780, sessions: 33, estimatedCostUsd: 42.75 }),
  ];

  it('opens on Coredoc calls descending', () => {
    expect(sortMembers(rows, 'coredocCalls', -1).map((r) => r.userId)).toEqual(['a', 'b', 'c']);
  });

  it('flips the active column on a repeat click', () => {
    expect(nextMemberSort({ key: 'coredocCalls', dir: -1 }, 'coredocCalls')).toEqual({
      key: 'coredocCalls',
      dir: 1,
    });
    expect(sortMembers(rows, 'coredocCalls', 1).map((r) => r.userId)).toEqual(['c', 'b', 'a']);
  });

  it('opens a numeric column descending and the name column ascending', () => {
    expect(nextMemberSort({ key: 'coredocCalls', dir: -1 }, 'sessions')).toEqual({ key: 'sessions', dir: -1 });
    expect(nextMemberSort({ key: 'coredocCalls', dir: -1 }, 'member')).toEqual({ key: 'member', dir: 1 });
    expect(sortMembers(rows, 'member', 1).map((r) => r.displayName)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('sorts an unpriced spend below every priced one instead of treating it as $0', () => {
    expect(sortMembers(rows, 'spend', -1).map((r) => r.userId)).toEqual(['a', 'b', 'c']);
    expect(sortMembers(rows, 'spend', 1).map((r) => r.userId)).toEqual(['c', 'b', 'a']);
  });
});

describe('spendCaption (LIM-1)', () => {
  it('names both degrade counters', () => {
    expect(spendCaption({ currentUsd: null, previousUsd: null, unpricedSessions: 3, sessionsWithoutUsage: 2 })).toBe(
      '3 sessions unpriced · 2 without usage',
    );
  });

  it('names only the counter that is non-zero, in the singular when it is one', () => {
    expect(spendCaption({ currentUsd: 5, previousUsd: 4, unpricedSessions: 1, sessionsWithoutUsage: 0 })).toBe(
      '1 session unpriced',
    );
  });

  it('is absent when the estimate covered every session', () => {
    expect(spendCaption({ currentUsd: 5, previousUsd: 4, unpricedSessions: 0, sessionsWithoutUsage: 0 })).toBeNull();
  });
});

describe('sparkFromSeries (BR-17)', () => {
  it('drops an all-unpriced day instead of drawing it as zero, and keeps a real zero', () => {
    expect(sparkFromSeries(USAGE_FIXTURE.series.spendUsd)).toEqual([
      { date: '2026-08-30', value: 12.5 },
      { date: '2026-09-01', value: 0 },
    ]);
  });
});

describe('windowCaption (BR-16)', () => {
  it('names the UTC-day-aligned bounds the whole view shares', () => {
    expect(windowCaption(USAGE_FIXTURE.window)).toBe('Aug 3 – Sep 1 · UTC');
  });
});

describe('relativeDayLabel', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('labels calendar days, not 24-hour spans', () => {
    expect(relativeDayLabel('2026-09-01T08:00:00.000Z', now)).toEqual({ text: 'today', isToday: true });
    expect(relativeDayLabel('2026-08-31T23:00:00.000Z', now)).toEqual({ text: 'yesterday', isToday: false });
    expect(relativeDayLabel('2026-08-25T09:00:00.000Z', now)).toEqual({ text: '7d ago', isToday: false });
  });

  it('shows the no-data dash when the member has never been active', () => {
    expect(relativeDayLabel(null, now)).toEqual({ text: '—', isToday: false });
  });
});
