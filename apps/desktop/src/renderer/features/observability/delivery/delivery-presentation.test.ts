import { describe, expect, it } from 'vitest';
import {
  AnalyticsWindowKind,
  type CanonicalDeliverySummary,
  type CanonicalTaskSummary,
} from '../../../../shared/ipc-types.js';
import {
  deliveryKpis,
  DIRECTIONAL_SAMPLE_MAX,
  estimatedCostLine,
  filterCanonicalTasks,
  formatDurationShort,
  leadTimeOf,
  memberOptions,
  partialShipChipText,
  populationCaption,
  reworkEntries,
  scopeNoun,
  sampledMedianText,
  stageBarEntries,
  windowLabel,
} from './delivery-presentation';
import { NO_DATA } from '../observability-format';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function summary(overrides: Partial<CanonicalDeliverySummary> = {}): CanonicalDeliverySummary {
  return {
    window: {
      days: 30,
      since: '2026-08-04T00:00:00.000Z',
      until: '2026-09-03T00:00:00.000Z',
      lifecycle: 'all',
      userId: null,
    },
    tasks: { matching: 10, shipped: 6, partiallyShipped: 0, withRework: 3, active: 4 },
    leadTimeMs: { value: 72 * HOUR, sampleSize: 6 },
    reviewStageMs: { value: 12 * HOUR, sampleSize: 8 },
    costPerShippedTaskUsd: { value: 4.5, sampleSize: 6, unpricedTasks: 2 },
    stages: [
      { stageId: 'spec', claimedMs: { value: 5 * HOUR, sampleSize: 9 }, incomplete: 0, inProgress: 0 },
      { stageId: 'implement', claimedMs: { value: null, sampleSize: 0 }, incomplete: 0, inProgress: 1 },
      { stageId: 'review', claimedMs: { value: 12 * HOUR, sampleSize: 8 }, incomplete: 0, inProgress: 0 },
    ],
    unclaimedMs: { value: 30 * HOUR, sampleSize: 10 },
    reviewWaitMs: { value: 3 * HOUR, sampleSize: 7 },
    editVerifyRoundsPerRun: { value: 2, sampleSize: 11 },
    rework: {
      bySource: [
        { kind: 'tracker_reopened', signals: 2, tasks: 2 },
        { kind: 'review_changes_requested', signals: 4, tasks: 3 },
        { kind: 'review_commented', signals: 0, tasks: 0 },
      ],
    },
    ...overrides,
  };
}

function task(overrides: Partial<CanonicalTaskSummary> = {}): CanonicalTaskSummary {
  return {
    id: 'task-1',
    title: 'Ship the thing',
    repositoryKey: 'repo',
    lifecycle: 'completed',
    authority: { kind: 'coredoc' },
    createdBy: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    everShipped: true,
    lastShippedAt: '2026-08-03T00:00:00.000Z',
    shipState: 'shipped',
    counts: {
      externalRefs: 1,
      workflowRuns: 2,
      codeChanges: 1,
      mergedCodeChanges: 1,
      openCodeChanges: 0,
      shipEvidence: 1,
      reworkSignals: 0,
      artifacts: 1,
    },
    ...overrides,
  };
}

describe('formatDurationShort', () => {
  it('reads days at 48h and above, whole hours at 10h and above, hours and minutes below', () => {
    expect(formatDurationShort(72 * HOUR)).toBe('3.0d');
    expect(formatDurationShort(48 * HOUR)).toBe('2.0d');
    expect(formatDurationShort(47.9 * HOUR)).toBe('48h');
    expect(formatDurationShort(14 * HOUR)).toBe('14h');
    expect(formatDurationShort(10 * HOUR)).toBe('10h');
    expect(formatDurationShort(3.5 * HOUR)).toBe('3h 30m');
    expect(formatDurationShort(2 * HOUR)).toBe('2h');
    expect(formatDurationShort(59.7 * MINUTE)).toBe('1h');
  });

  it('reads sub-hour durations in whole minutes, never a fraction of an hour', () => {
    expect(formatDurationShort(6 * MINUTE)).toBe('6m');
    expect(formatDurationShort(5 * MINUTE + 10_000)).toBe('5m');
    expect(formatDurationShort(2 * MINUTE)).toBe('2m');
    expect(formatDurationShort(20_000)).toBe('<1m');
    expect(formatDurationShort(0)).toBe('0m');
  });

  it('dashes a negative or non-finite span instead of printing a measured zero', () => {
    expect(formatDurationShort(-1 * HOUR)).toBe(NO_DATA);
    expect(formatDurationShort(Number.NaN)).toBe(NO_DATA);
  });
});

describe('sampledMedianText', () => {
  it('renders the dash plus an "n of N" caption for an empty sample (BR-11)', () => {
    expect(sampledMedianText({ value: null, sampleSize: 0 }, 12)).toEqual({ text: '—', caption: '0 of 12' });
  });

  it('marks a small sample directional and says nothing about a healthy one', () => {
    expect(sampledMedianText({ value: 5 * HOUR, sampleSize: DIRECTIONAL_SAMPLE_MAX }, 12)).toEqual({
      text: '5h',
      caption: 'directional',
    });
    expect(sampledMedianText({ value: 5 * HOUR, sampleSize: DIRECTIONAL_SAMPLE_MAX + 1 }, 12)).toEqual({
      text: '5h',
      caption: null,
    });
  });
});

describe('deliveryKpis', () => {
  it('renders the four tiles with their hints', () => {
    expect(deliveryKpis(summary())).toEqual([
      { label: 'Median lead time', value: '3.0d', hint: '6 shipped', caption: null },
      { label: 'Tasks with rework', value: '30%', hint: '3 of 10 tasks', caption: null },
      { label: 'Median review stage', value: '12h', hint: 'claimed review intervals', caption: null },
      {
        label: 'Median cost / shipped task',
        value: '$4.50',
        hint: 'priced sessions only · unpriced: 2',
        caption: null,
      },
    ]);
  });

  it('dashes every median and the rate on an empty population, with the sample captions', () => {
    const empty = summary({
      tasks: { matching: 0, shipped: 0, partiallyShipped: 0, withRework: 0, active: 0 },
      leadTimeMs: { value: null, sampleSize: 0 },
      reviewStageMs: { value: null, sampleSize: 0 },
      costPerShippedTaskUsd: { value: null, sampleSize: 0, unpricedTasks: 0 },
    });
    const kpis = deliveryKpis(empty);
    expect(kpis.map((kpi) => kpi.value)).toEqual(['—', '—', '—', '—']);
    expect(kpis.map((kpi) => kpi.caption)).toEqual(['0 of 0 shipped', null, '0 of 0', '0 of 0']);
  });

  it('measures the lead-time sample against shipped tasks, not the whole matching population (BR-7)', () => {
    // 17 matching tasks, 2 of them shipped, neither measurable: "0 of 17" would
    // report the sample against a population lead time never samples.
    const kpis = deliveryKpis(
      summary({
        tasks: { matching: 17, shipped: 2, partiallyShipped: 0, withRework: 3, active: 8 },
        leadTimeMs: { value: null, sampleSize: 0 },
      }),
    );
    expect(kpis[0]).toEqual({ label: 'Median lead time', value: '—', hint: '2 shipped', caption: '0 of 2 shipped' });
  });
});

describe('stageBarEntries', () => {
  it('keeps the server stage colour order across an empty median and appends unclaimed', () => {
    const entries = stageBarEntries(summary());
    expect(entries.map((entry) => entry.key)).toEqual(['spec', 'review', 'unclaimed']);
    // 'implement' has no median, but 'review' keeps the third ramp step it was assigned.
    expect(entries.map((entry) => entry.color)).toEqual([
      'var(--color-chart-stage-1)',
      'var(--color-chart-stage-3)',
      'var(--color-chart-axis)',
    ]);
    expect(entries.map((entry) => entry.text)).toEqual(['5h', '12h', '30h']);
  });
});

describe('reworkEntries', () => {
  it('labels every source and keeps a zero row rather than dropping it', () => {
    expect(reworkEntries(summary())).toEqual([
      { key: 'tracker_reopened', name: 'Tracker reopened', count: 2, tasks: 2 },
      { key: 'review_changes_requested', name: 'Review: changes requested', count: 4, tasks: 3 },
      { key: 'review_commented', name: 'Review: comments then commits', count: 0, tasks: 0 },
    ]);
  });
});

describe('memberOptions', () => {
  it('keeps real members with their display name or email and drops invite placeholders', () => {
    expect(
      memberOptions([
        { userId: 'user_42', email: 'ada@example.test', displayName: 'Ada Lovelace' },
        { userId: 'user_7', email: 'grace@example.test', displayName: null },
        { userId: 'pending:new@example.test', email: 'new@example.test', displayName: null },
      ]),
    ).toEqual([
      { userId: 'user_42', label: 'Ada Lovelace' },
      { userId: 'user_7', label: 'grace@example.test' },
    ]);
  });
});

describe('partialShipChipText', () => {
  it('names the merged share of the linked PRs for a partially shipped task', () => {
    expect(
      partialShipChipText(
        task({
          shipState: 'partial',
          counts: { ...task().counts, codeChanges: 3, mergedCodeChanges: 2, openCodeChanges: 1 },
        }),
      ),
    ).toBe('Partially shipped · 2 of 3 PRs');
  });

  it('renders nothing for a fully shipped or unshipped task', () => {
    expect(partialShipChipText(task())).toBeNull();
    expect(partialShipChipText(task({ shipState: 'none' }))).toBeNull();
  });
});

describe('populationCaption', () => {
  it('names the window and the active filter (AC-9)', () => {
    expect(populationCaption({ kind: AnalyticsWindowKind.Days, days: 30 }, 'rework', false)).toBe(
      'Tasks updated in the last 30 days · With rework · UTC',
    );
  });

  it('names the selected member instead of the whole workspace', () => {
    expect(populationCaption({ kind: AnalyticsWindowKind.Days, days: 7 }, 'all', false, 'Ada Lovelace')).toBe(
      'Tasks updated in the last 7 days · All tasks · tasks of Ada Lovelace · UTC',
    );
  });

  it('names a custom range and the self-scope when they are on', () => {
    expect(
      populationCaption({ kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' }, 'all', true),
    ).toBe('Tasks updated in 2026-08-01 – 2026-08-14 · All tasks · your tasks · UTC');
  });
});

describe('windowLabel', () => {
  it('names a preset window as a day count and a custom window as its range', () => {
    expect(windowLabel({ kind: AnalyticsWindowKind.Days, days: 30 })).toBe('in the last 30 days');
    expect(windowLabel({ kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' })).toBe(
      'in 2026-08-01 – 2026-08-14',
    );
  });
});

describe('scopeNoun', () => {
  it('names the population the empty task list is about', () => {
    expect(scopeNoun(false, null)).toBe('tasks');
    expect(scopeNoun(true, null)).toBe('tasks of yours');
    expect(scopeNoun(false, 'Ada Lovelace')).toBe('tasks of Ada Lovelace');
    // `mine` is the caller's own scope, so it wins over any member label handed alongside it.
    expect(scopeNoun(true, 'Ada Lovelace')).toBe('tasks of yours');
  });
});

describe('leadTimeOf', () => {
  it('measures ship evidence minus creation, and is null while unshipped', () => {
    expect(leadTimeOf(task())).toBe(48 * HOUR);
    expect(leadTimeOf(task({ lastShippedAt: null }))).toBeNull();
  });
});

describe('estimatedCostLine', () => {
  it('never renders $0.00 for a null total and keeps the session counters (LIM-1)', () => {
    expect(estimatedCostLine({ totalUsd: null, sessions: 3, unpricedSessions: 1, sessionsWithoutUsage: 2 })).toBe(
      'No priced usage across 3 sessions · 1 unpriced · 2 without usage · joined via workflow runs',
    );
    expect(estimatedCostLine({ totalUsd: 12.5, sessions: 4, unpricedSessions: 0, sessionsWithoutUsage: 0 })).toBe(
      '$12.50 across 4 sessions · joined via workflow runs',
    );
    expect(estimatedCostLine({ totalUsd: null, sessions: 2, unpricedSessions: 0, sessionsWithoutUsage: 2 })).toBe(
      'Session cost is unavailable · 2 sessions without usage telemetry · joined via workflow runs',
    );
  });

  it('agrees the session noun with its count', () => {
    expect(estimatedCostLine({ totalUsd: 0.29, sessions: 1, unpricedSessions: 0, sessionsWithoutUsage: 0 })).toBe(
      '$0.29 across 1 session · joined via workflow runs',
    );
    expect(estimatedCostLine({ totalUsd: null, sessions: 1, unpricedSessions: 0, sessionsWithoutUsage: 1 })).toBe(
      'Session cost is unavailable · 1 session without usage telemetry · joined via workflow runs',
    );
  });
});

// Relocated with `filterCanonicalTasks` from the deleted CanonicalDeliveryTimeline.tsx.
describe('filterCanonicalTasks', () => {
  it('filters loaded tasks across title, id, repository, lifecycle, and authority', () => {
    const active = task({
      id: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Rebuild the parser',
      repositoryKey: 'acme/server',
      lifecycle: 'active',
      authority: {
        kind: 'external_ref',
        provider: 'jira',
        externalId: '10001',
        externalKey: 'SCRUM-1',
        externalRefId: 'ref-1',
        connected: true,
        sourceCreatedAt: null,
      },
    });
    const completed = task({
      id: 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Ship observability filters',
      repositoryKey: 'acme/desktop',
      lifecycle: 'completed',
      authority: {
        kind: 'external_ref',
        provider: 'jira',
        externalId: '10021',
        externalKey: 'SCRUM-21',
        externalRefId: 'ref-2',
        connected: false,
        sourceCreatedAt: null,
      },
    });
    const tasks = [active, completed];

    expect(filterCanonicalTasks(tasks, 'OBSERVABILITY')).toEqual([completed]);
    expect(filterCanonicalTasks(tasks, 'COMPLETED')).toEqual([completed]);
    expect(filterCanonicalTasks(tasks, '10021')).toEqual([completed]);
    expect(filterCanonicalTasks(tasks, 'scrum-21')).toEqual([completed]);
    expect(filterCanonicalTasks(tasks, 'CDT_BBBB')).toEqual([completed]);
    expect(filterCanonicalTasks(tasks, 'acme/desktop')).toEqual([completed]);
  });

  it('returns every loaded task for a blank query rather than an empty list', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })];
    expect(filterCanonicalTasks(tasks, '   ')).toEqual(tasks);
  });
});
