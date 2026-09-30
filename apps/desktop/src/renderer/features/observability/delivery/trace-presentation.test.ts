import { describe, expect, it } from 'vitest';
import type {
  CanonicalArtifactItem,
  CanonicalCodeChangeItem,
  CanonicalExternalRefItem,
  CanonicalExternalRefStateFactItem,
  CanonicalReworkSignalItem,
  CanonicalRunItem,
  CanonicalShipEvidenceItem,
  CanonicalStageOccurrenceItem,
  CanonicalTaskSummary,
} from '../../../../shared/ipc-types.js';
import { layoutGantt } from '../charts/chart-geometry';
import {
  buildGanttLanes,
  claimedByStage,
  journeyEvents,
  journeyRows,
  stageOrderOf,
  taskStageEntries,
  type TraceSources,
} from './trace-presentation';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

/**
 * The AC-8 fixture: tracker states including a reopen, two runs (listed out of
 * chronological order) with a stage re-entry and a failed stage, a PR carrying
 * all five marks, an artifact with created/updated marks, ship evidence, and
 * timestamps deliberately interleaved across lanes so per-lane concatenation
 * cannot pass.
 */
function fixture(): TraceSources {
  const task: CanonicalTaskSummary = {
    id: 'task-1',
    title: 'Ship the thing',
    repositoryKey: 'repo',
    lifecycle: 'completed',
    authority: {
      kind: 'external_ref',
      externalRefId: 'ref-1',
      provider: 'jira',
      externalId: 'PROJ-7',
      externalKey: 'PROJ-7',
      connected: true,
      sourceCreatedAt: null,
    },
    createdBy: 'user',
    createdAt: at(0),
    updatedAt: at(120),
    everShipped: true,
    lastShippedAt: at(100),
    shipState: 'shipped',
    counts: {
      externalRefs: 1,
      workflowRuns: 2,
      codeChanges: 1,
      mergedCodeChanges: 1,
      openCodeChanges: 0,
      shipEvidence: 1,
      reworkSignals: 2,
      artifacts: 1,
    },
  };

  const ref: CanonicalExternalRefItem = {
    id: 'ref-1',
    provider: 'jira',
    externalId: 'PROJ-7',
    externalKey: 'PROJ-7',
    externalUrl: null,
    externalState: 'Done',
    connectorId: 'conn-1',
    sourceUpdatedAt: at(98),
    lastObservedAt: at(98),
    isAuthority: true,
    stateFactCount: 4,
  };

  const fact = (
    id: string,
    fromState: string | null,
    toState: string,
    hours: number,
  ): CanonicalExternalRefStateFactItem => ({
    id,
    fromState,
    toState,
    sourceRef: 'jira',
    occurredAt: at(hours),
    sourceUpdatedAt: at(hours),
    receivedAt: at(hours),
    actorId: null,
  });

  const run = (
    runId: string,
    intent: string,
    startHours: number,
    endHours: number,
    failures: number,
  ): CanonicalRunItem => ({
    runId,
    workflowId: 'wf',
    intent,
    risk: 'low',
    scale: 'small',
    repositoryKey: 'repo',
    startedAt: at(startHours),
    finishedAt: at(endHours),
    outcome: 'success',
    verification: failures === 0 ? null : { runs: 2, failures, editVerifyRounds: 3 },
    workItems: [],
  });

  const stage = (
    occurrenceId: string,
    runId: string,
    stageId: string,
    startHours: number,
    endHours: number,
    attempt: number,
    outcome: CanonicalStageOccurrenceItem['outcome'],
  ): CanonicalStageOccurrenceItem => ({
    occurrenceId,
    runId,
    stageId,
    attempt,
    startedAt: at(startHours),
    finishedAt: at(endHours),
    outcome,
  });

  const codeChange: CanonicalCodeChangeItem = {
    id: 'cc-1',
    provider: 'github',
    repoExternalId: 'org/repo',
    externalId: 'pr-42',
    number: 42,
    title: 'Ship the thing',
    state: 'merged',
    isDraft: false,
    sourceBranch: 'feat/thing',
    targetBranch: 'main',
    createdAtSource: at(25),
    readyForReviewAt: at(30),
    firstReviewAt: at(36),
    approvedAt: at(45),
    mergedAt: at(99),
    updatedAt: at(99),
    externalUrl: null,
    reviewCount: 2,
    commentCount: 3,
    associationSource: 'external_ref',
    associationSourceValue: 'PROJ-7',
  };

  const artifact: CanonicalArtifactItem = {
    id: 'art-1',
    repositoryKey: 'repo',
    kind: 'spec',
    createdBy: 'user',
    createdAt: at(3),
    updatedAt: at(55),
    revisionCount: 4,
  };

  const ship: CanonicalShipEvidenceItem = {
    id: 'ship-1',
    source: 'github_pr_merged',
    sourceKey: 'org/repo#42',
    occurredAt: at(100),
    receivedAt: at(100),
    actorId: null,
    provider: 'github',
    repoExternalId: 'org/repo',
    externalId: 'pr-42',
  };

  const reworkSignals: CanonicalReworkSignalItem[] = [
    {
      id: 'rw-1',
      kind: 'stage_reentry',
      sourceKey: 'occ-impl2',
      sourceRef: 'occ-impl2',
      occurredAt: at(21),
      observedAt: at(21),
    },
    {
      id: 'rw-2',
      kind: 'tracker_reopened',
      sourceKey: 'PROJ-7',
      sourceRef: 'PROJ-7',
      occurredAt: at(60),
      observedAt: at(60),
    },
  ];

  return {
    task,
    externalRefs: [ref],
    refHistory: {
      'ref-1': [
        fact('f1', null, 'In Progress', 1),
        fact('f2', 'In Progress', 'Done', 50),
        fact('f3', 'Done', 'In Progress', 60),
        fact('f4', 'In Progress', 'Done', 98),
      ],
    },
    // Deliberately not in start order — lanes must sort, not concatenate.
    runs: [run('run-b', 'review', 40, 70, 0), run('run-a', 'implement', 2, 30, 1)],
    runStages: {
      'run-a': [
        stage('occ-spec', 'run-a', 'spec', 2, 6, 1, 'success'),
        stage('occ-impl1', 'run-a', 'implement', 6, 20, 1, 'failed'),
        stage('occ-impl2', 'run-a', 'implement', 21, 29, 2, 'success'),
      ],
      'run-b': [stage('occ-review', 'run-b', 'review', 40, 48, 1, 'success')],
    },
    codeChanges: [codeChange],
    artifacts: [artifact],
    shipEvidence: [ship],
    reworkSignals,
  };
}

describe('buildGanttLanes', () => {
  it('orders lanes tracker → runs by start → PRs → artifacts → ship', () => {
    const { lanes } = buildGanttLanes(fixture());
    expect(lanes.map((lane) => `${lane.kind}:${lane.label}`)).toEqual([
      'tracker:PROJ-7',
      'run:implement run · 1 verification failures',
      'run:review run',
      'pr:PR #42 · wait 6.0h',
      'artifact:spec artifact',
      'ship:ship',
    ]);
  });

  it('places every segment and mark inside the window it reports', () => {
    const { lanes, start, end } = buildGanttLanes(fixture());
    expect(start).toBe(T0);
    // The span ends at the last ship (100h) plus the edge pad; the task row's later
    // `updatedAt` (120h) is a resync timestamp, not a fact on the axis.
    expect(end).toBe(T0 + 102 * HOUR);

    const layout = layoutGantt({ lanes, start, end, width: 900, gutter: 130, rowHeight: 30, axisHeight: 26 });
    const times = layout.rows.flatMap((row) => [
      ...row.segments.flatMap((segment) => [segment.startMs, segment.endMs]),
      ...row.marks.map((mark) => mark.atMs),
    ]);
    expect(times.length).toBeGreaterThan(0);
    for (const ms of times) {
      expect(ms).toBeGreaterThanOrEqual(start);
      expect(ms).toBeLessThanOrEqual(end);
    }
  });

  it('bounds the window by the facts when the task record postdates its evidence', () => {
    const sources = fixture();
    // Connector-projected task: created and resynced weeks after the facts it points at.
    const projected = { ...sources, task: { ...sources.task, createdAt: at(700), updatedAt: at(720) } };
    const { start, end } = buildGanttLanes(projected);

    const facts = buildGanttLanes({ ...projected, task: { ...projected.task, lastShippedAt: null } });
    expect(start).toBe(facts.start);
    expect(end).toBe(T0 + 102 * HOUR);
    expect(end).toBeLessThan(T0 + 700 * HOUR);
  });

  it('marks the tracker reopen, the stage re-entry, the failed stage and all five PR marks', () => {
    const { lanes, start, end } = buildGanttLanes(fixture());
    const layout = layoutGantt({ lanes, start, end, width: 900, gutter: 130, rowHeight: 30, axisHeight: 26 });
    const kinds = layout.rows.flatMap((row) => row.marks.map((mark) => mark.kind));
    expect(kinds.filter((kind) => kind === 'tracker-reopened')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'stage-reentry')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'stage-failed')).toHaveLength(1);
    expect(kinds).toEqual(
      expect.arrayContaining(['pr-opened', 'pr-ready', 'pr-first-review', 'pr-approved', 'pr-merged']),
    );
    expect(kinds.filter((kind) => kind === 'artifact-created')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'artifact-updated')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'ship')).toHaveLength(1);
  });

  it('reports the stage colour order the gantt paints', () => {
    const { lanes } = buildGanttLanes(fixture());
    expect(stageOrderOf(lanes)).toEqual(['spec', 'implement', 'review']);
  });
});

describe('claimedByStage / taskStageEntries', () => {
  it('sums distinct occurrences per stage and leaves the rest of the span unclaimed', () => {
    const sources = fixture();
    const occurrences = Object.values(sources.runStages).flat();
    const claimed = claimedByStage([...occurrences, ...occurrences]);
    expect(claimed.byStage).toEqual([
      { stageId: 'spec', ms: 4 * HOUR },
      { stageId: 'implement', ms: 22 * HOUR },
      { stageId: 'review', ms: 8 * HOUR },
    ]);
    expect(claimed.total).toBe(34 * HOUR);

    const { entries, footnote } = taskStageEntries(sources.task, claimed, ['spec', 'implement', 'review']);
    expect(entries.map((entry) => [entry.key, entry.ms])).toEqual([
      ['spec', 4 * HOUR],
      ['implement', 22 * HOUR],
      ['review', 8 * HOUR],
      ['unclaimed', 66 * HOUR],
    ]);
    expect(entries.map((entry) => entry.color)).toEqual([
      'var(--color-chart-stage-1)',
      'var(--color-chart-stage-2)',
      'var(--color-chart-stage-3)',
      'var(--color-chart-axis)',
    ]);
    expect(footnote).toBe(
      'Claimed 34h of 4.2d total span. Gaps between recorded intervals are unclaimed, not attributed.',
    );
  });

  it('states the span as unavailable, with no unclaimed row, when the task record postdates its evidence', () => {
    const sources = fixture();
    // Connector-projected task: created after the stages and the ship it points at.
    const task = { ...sources.task, createdAt: at(200), updatedAt: at(201), lastShippedAt: at(100) };
    const claimed = claimedByStage(Object.values(sources.runStages).flat());

    const { entries, footnote } = taskStageEntries(task, claimed, ['spec', 'implement', 'review']);

    expect(entries.map((entry) => entry.key)).toEqual(['spec', 'implement', 'review']);
    expect(footnote).toBe(
      'Claimed 34h across recorded stages; the task span is unavailable (task record created after its evidence).',
    );
  });

  it('names the overrun, not a missing span, when the stages outlast a measurable task span', () => {
    const sources = fixture();
    // A measurable 10h span that the 34h of recorded stages cannot fit into: the
    // stages overlap or run past the task's last update, which is a different fact
    // from a task record that postdates its evidence.
    const task = { ...sources.task, createdAt: at(0), updatedAt: at(10), lastShippedAt: at(10) };
    const claimed = claimedByStage(Object.values(sources.runStages).flat());

    const { entries, footnote } = taskStageEntries(task, claimed, ['spec', 'implement', 'review']);

    expect(entries.map((entry) => entry.key)).toEqual(['spec', 'implement', 'review']);
    expect(footnote).toBe(
      "Claimed 34h across recorded stages; recorded stages overlap or extend past the task's last update.",
    );
  });
});

describe('journeyEvents', () => {
  it('interleaves kinds chronologically with a deterministic tiebreak', () => {
    const events = journeyEvents(fixture());
    expect(events.map((event) => event.at)).toEqual([...events.map((event) => event.at)].sort((a, b) => a - b));

    const atHour = (hours: number) => events.filter((event) => event.at === T0 + hours * HOUR);
    // Equal timestamps across kinds sort by kind, not by the collection they came from.
    expect(atHour(21).map((event) => event.kind)).toEqual(['rework', 'stage']);
    expect(atHour(60).map((event) => event.kind)).toEqual(['ref', 'rework']);

    expect(events[0]).toMatchObject({ kind: 'ref', label: 'Unavailable → In Progress', detail: 'PROJ-7' });
    expect(events[events.length - 1]).toMatchObject({
      kind: 'ship',
      label: 'ship evidence · github pr merged',
      detail: 'org/repo#42',
    });
    expect(events.filter((event) => event.kind === 'code').map((event) => event.label)).toEqual([
      'PR #42 opened',
      'PR #42 ready for review',
      'PR #42 first review',
      'PR #42 approved',
      'PR #42 merged',
    ]);
  });
});

describe('journeyEvents · tracker no-ops', () => {
  it('drops a state fact that re-states the state it came from', () => {
    const sources = fixture();
    const history = sources.refHistory['ref-1'] ?? [];
    const noop = { ...history[0]!, id: 'f0', fromState: 'To Do', toState: 'To Do' };
    const events = journeyEvents({ ...sources, refHistory: { 'ref-1': [noop, ...history] } });

    expect(events.map((event) => event.id)).not.toContain('f0');
    expect(events.filter((event) => event.kind === 'ref')).toHaveLength(history.length);
  });
});

describe('journeyRows', () => {
  it('renders a gap row for every silence longer than twelve hours', () => {
    const rows = journeyRows(journeyEvents(fixture()));
    const gaps = rows.filter((row) => row.type === 'gap');
    expect(gaps).toEqual([
      { type: 'gap', ms: 14 * HOUR, id: 'occ-impl1:end' },
      { type: 'gap', ms: 38 * HOUR, id: 'f4' },
    ]);
    expect(rows.filter((row) => row.type === 'event')).toHaveLength(journeyEvents(fixture()).length);
  });
});
