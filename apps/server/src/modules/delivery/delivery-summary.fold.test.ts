import { describe, expect, it } from 'vitest';
import { WORKFLOW_STALENESS_WINDOW_MS } from '../../libs/usage/workflow-completeness.js';
import { type DeliverySummaryInput, foldDeliverySummary } from './delivery-summary.fold.js';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const HOUR = 60 * 60 * 1_000;

function at(hours: number): Date {
  return new Date(T0 + hours * HOUR);
}

/** Read instant of every fold below: hours after the fixture, so no occurrence is stale yet. */
const NOW = at(12);

const TASK_A = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_B = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_C = 'cdt_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_D = 'cdt_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK_OUTSIDE = 'cdt_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/**
 * AC-6 fixture. Interleaved stage occurrences, ship evidence, rework signals and code changes,
 * including one run linked to two tasks, a code change linked to two matching tasks, and rows
 * belonging to a task the population read did not return.
 */
function fixture(): DeliverySummaryInput {
  return {
    now: NOW,
    tasks: [
      {
        id: TASK_A,
        createdAt: at(0),
        updatedAt: at(10),
        lifecycle: 'completed',
        lastShippedAt: at(8),
        openCodeChanges: 0,
      },
      {
        id: TASK_B,
        createdAt: at(1),
        updatedAt: at(5),
        lifecycle: 'active',
        lastShippedAt: null,
        openCodeChanges: 0,
      },
      {
        id: TASK_C,
        createdAt: at(2),
        updatedAt: at(3),
        lifecycle: 'completed',
        lastShippedAt: at(6),
        openCodeChanges: 0,
      },
      {
        id: TASK_D,
        createdAt: at(3),
        updatedAt: at(4),
        lifecycle: 'completed',
        lastShippedAt: at(4),
        // Shipped something with a PR still open: partially shipped, so out of every
        // fully-shipped sample below.
        openCodeChanges: 1,
      },
    ],
    runs: [
      {
        taskId: TASK_A,
        runId: 'run-1',
        startedAt: null,
        finishedAt: null,
        createdAt: at(0),
        editVerifyRounds: null,
        stageOccurrences: [
          { stageId: 'spec', attempt: 1, startedAt: at(0), finishedAt: at(1) },
          { stageId: 'review', attempt: 1, startedAt: at(2), finishedAt: at(3) },
          { stageId: 'review', attempt: 2, startedAt: at(4), finishedAt: at(4.5) },
        ],
      },
      // run-2 is associated with two tasks: one claimed interval and one re-entry each.
      {
        taskId: TASK_A,
        runId: 'run-2',
        startedAt: null,
        finishedAt: null,
        createdAt: at(0),
        editVerifyRounds: 3,
        stageOccurrences: [
          { stageId: 'build', attempt: 1, startedAt: at(5), finishedAt: null },
          { stageId: 'build', attempt: 2, startedAt: at(6), finishedAt: at(6.5) },
        ],
      },
      {
        taskId: TASK_B,
        runId: 'run-2',
        startedAt: null,
        finishedAt: null,
        createdAt: at(0),
        editVerifyRounds: 3,
        stageOccurrences: [
          { stageId: 'build', attempt: 1, startedAt: at(5), finishedAt: null },
          { stageId: 'build', attempt: 2, startedAt: at(6), finishedAt: at(6.5) },
        ],
      },
      {
        taskId: TASK_C,
        runId: 'run-3',
        startedAt: null,
        finishedAt: null,
        createdAt: at(0),
        editVerifyRounds: 1,
        stageOccurrences: [
          { stageId: 'spec', attempt: 1, startedAt: at(2), finishedAt: at(2.5) },
          { stageId: 'review', attempt: 1, startedAt: at(3), finishedAt: at(5) },
        ],
      },
      {
        taskId: TASK_OUTSIDE,
        runId: 'run-4',
        startedAt: null,
        finishedAt: null,
        createdAt: at(0),
        editVerifyRounds: 99,
        stageOccurrences: [{ stageId: 'deploy', attempt: 2, startedAt: at(0), finishedAt: at(9) }],
      },
    ],
    reworkSignals: [
      // Legacy kind: still stored, counted by nothing.
      { taskId: TASK_A, kind: 'stage_reentry' },
      { taskId: TASK_A, kind: 'tracker_reopened' },
      { taskId: TASK_A, kind: 'review_changes_requested' },
      { taskId: TASK_B, kind: 'review_changes_requested' },
      { taskId: TASK_B, kind: 'review_commented' },
      { taskId: TASK_C, kind: 'tracker_reopened' },
      { taskId: TASK_OUTSIDE, kind: 'tracker_reopened' },
    ],
    codeChanges: [
      { codeChangeId: 'cc-1', readyForReviewAt: at(1), firstReviewAt: at(3) },
      { codeChangeId: 'cc-1', readyForReviewAt: at(1), firstReviewAt: at(3) },
      { codeChangeId: 'cc-2', readyForReviewAt: at(0), firstReviewAt: at(1) },
      { codeChangeId: 'cc-3', readyForReviewAt: null, firstReviewAt: at(2) },
    ],
    taskCosts: [
      { taskId: TASK_A, sessions: 2, pricedTotalUsd: 1.5 },
      { taskId: TASK_C, sessions: 1, pricedTotalUsd: null },
      { taskId: TASK_D, sessions: 0, pricedTotalUsd: null },
    ],
  };
}

describe('foldDeliverySummary', () => {
  it('folds hand-computed medians, sample sizes, rework sources and review wait over the fixture', () => {
    expect(foldDeliverySummary(fixture())).toEqual({
      // withRework: a counted signal kind and nothing else — A, B, C. D has no signal, and the
      // attempt>1 occurrences on A/B are iteration facts, not rework.
      // shipped: A and C; D shipped with an open PR, so it is partial.
      tasks: { matching: 4, shipped: 2, partiallyShipped: 1, withRework: 3, active: 1 },
      // fully-shipped lead times: 8h, 4h (D's 1h is a partial ship and leaves the sample)
      leadTimeMs: { value: 6 * HOUR, sampleSize: 2 },
      reviewStageMs: { value: 1.75 * HOUR, sampleSize: 2 },
      costPerShippedTaskUsd: { value: 1.5, sampleSize: 1, unpricedTasks: 1 },
      stages: [
        // spec: A 1h, C 30m
        { stageId: 'spec', claimedMs: { value: 0.75 * HOUR, sampleSize: 2 }, incomplete: 0, inProgress: 0 },
        // review: A 1h + 30m, C 2h
        { stageId: 'review', claimedMs: { value: 1.75 * HOUR, sampleSize: 2 }, incomplete: 0, inProgress: 0 },
        // build: A 30m, B 30m (the unfinished first attempt claims nothing)
        // The unfinished first attempt is one occurrence, not two, although run-2 is linked
        // to two tasks; it is younger than the staleness window, so it is still in progress.
        { stageId: 'build', claimedMs: { value: 0.5 * HOUR, sampleSize: 2 }, incomplete: 0, inProgress: 1 },
      ],
      // spans 8h/4h/4h/1h minus claimed 3h/0.5h/2.5h/0h => 5h, 3.5h, 1.5h, 1h
      unclaimedMs: { value: 2.5 * HOUR, sampleSize: 4 },
      reviewWaitMs: { value: 1.5 * HOUR, sampleSize: 2 },
      editVerifyRoundsPerRun: { value: 2, sampleSize: 2 },
      rework: {
        bySource: [
          { kind: 'tracker_reopened', signals: 2, tasks: 2 },
          { kind: 'review_changes_requested', signals: 2, tasks: 2 },
          { kind: 'review_commented', signals: 1, tasks: 1 },
        ],
      },
    });
  });

  it('counts rework from the three counted signal kinds only, never from a stage re-entry', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        // Re-entry evidence only: an attempt>1 occurrence AND a legacy stage_reentry signal.
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
        // A counted signal kind.
        {
          id: TASK_B,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
        // Neither.
        {
          id: TASK_C,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [
        {
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [
            { stageId: 'build', attempt: 1, startedAt: at(0), finishedAt: at(1) },
            { stageId: 'build', attempt: 2, startedAt: at(1), finishedAt: at(2) },
          ],
        },
        {
          taskId: TASK_C,
          runId: 'run-2',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: at(0), finishedAt: at(1) }],
        },
      ],
      reworkSignals: [
        { taskId: TASK_A, kind: 'stage_reentry' },
        { taskId: TASK_B, kind: 'review_commented' },
      ],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.tasks.withRework).toBe(1);
    expect(facts.rework.bySource).toEqual([
      { kind: 'tracker_reopened', signals: 0, tasks: 0 },
      { kind: 'review_changes_requested', signals: 0, tasks: 0 },
      { kind: 'review_commented', signals: 1, tasks: 1 },
    ]);
  });

  it('ignores rework signals belonging to a task outside the population', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [
        {
          taskId: TASK_OUTSIDE,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'build', attempt: 2, startedAt: at(0), finishedAt: at(1) }],
        },
      ],
      reworkSignals: [{ taskId: TASK_OUTSIDE, kind: 'tracker_reopened' }],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.tasks).toEqual({ matching: 1, shipped: 0, partiallyShipped: 0, withRework: 0, active: 1 });
  });

  it('separates an unfinished stage occurrence past the staleness window from a younger one', () => {
    const task = {
      id: TASK_A,
      createdAt: at(0),
      sourceCreatedAt: null,
      updatedAt: at(2),
      lifecycle: 'active',
      lastShippedAt: null,
      openCodeChanges: 0,
    };
    const stale = new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS - HOUR);
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [task],
      runs: [
        {
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [
            // Started, never finished, past the window: no client will finish it.
            { stageId: 'build', attempt: 1, startedAt: stale, finishedAt: null },
            // Started, never finished, still inside the window.
            { stageId: 'build', attempt: 2, startedAt: at(1), finishedAt: null },
            { stageId: 'build', attempt: 3, startedAt: at(1), finishedAt: at(2) },
          ],
        },
      ],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    // Only the finished occurrence is a duration sample; the other two are counted, not folded.
    expect(facts.stages).toEqual([
      { stageId: 'build', claimedMs: { value: 1 * HOUR, sampleSize: 1 }, incomplete: 1, inProgress: 1 },
    ]);
  });

  it('counts a run linked to two tasks once per task for claimed time and once overall per run counter', () => {
    const input = fixture();
    const withoutSecondTask: DeliverySummaryInput = {
      ...input,
      runs: input.runs.filter((run) => !(run.runId === 'run-2' && run.taskId === TASK_B)),
    };

    const both = foldDeliverySummary(input);
    const single = foldDeliverySummary(withoutSecondTask);

    expect(both.stages.find((stage) => stage.stageId === 'build')?.claimedMs).toEqual({
      value: 0.5 * HOUR,
      sampleSize: 2,
    });
    expect(single.stages.find((stage) => stage.stageId === 'build')?.claimedMs).toEqual({
      value: 0.5 * HOUR,
      sampleSize: 1,
    });
    // The shared run's counter is one sample either way.
    expect(both.editVerifyRoundsPerRun).toEqual(single.editVerifyRoundsPerRun);
  });

  it('reports a stage nobody finished as an empty sample instead of zero claimed time', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [
        {
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: at(0), finishedAt: null }],
        },
      ],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.stages).toEqual([
      { stageId: 'build', claimedMs: { value: null, sampleSize: 0 }, incomplete: 0, inProgress: 1 },
    ]);
    expect(facts.unclaimedMs).toEqual({ value: 2 * HOUR, sampleSize: 1 });
    expect(facts.reviewStageMs).toEqual({ value: null, sampleSize: 0 });
  });

  const oneTaskOneRun = (run: DeliverySummaryInput['runs'][number]): DeliverySummaryInput => ({
    now: NOW,
    tasks: [
      {
        id: TASK_A,
        createdAt: at(0),
        sourceCreatedAt: null,
        updatedAt: at(2),
        lifecycle: 'active',
        lastShippedAt: null,
        openCodeChanges: 0,
      },
    ],
    runs: [run],
    reworkSignals: [],
    codeChanges: [],
    taskCosts: [],
  });

  it('calls a stage still open on a FINISHED run incomplete at once, without waiting out the window', () => {
    const facts = foldDeliverySummary(
      oneTaskOneRun({
        taskId: TASK_A,
        runId: 'run-1',
        startedAt: at(0),
        // The run reported its finish an hour in; no further stage event is coming.
        finishedAt: at(1),
        createdAt: at(0),
        editVerifyRounds: null,
        stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: at(0), finishedAt: null }],
      }),
    );

    expect(facts.stages).toEqual([
      { stageId: 'build', claimedMs: { value: null, sampleSize: 0 }, incomplete: 1, inProgress: 0 },
    ]);
  });

  it("ages an occurrence with no start of its own on the run's clock", () => {
    const stale = (clock: Partial<DeliverySummaryInput['runs'][number]>) =>
      foldDeliverySummary(
        oneTaskOneRun({
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: null, finishedAt: null }],
          ...clock,
        }),
      ).stages[0];

    const longAgo = new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS - HOUR);
    // Without the fallback this occurrence has no age at all and stays in progress forever.
    expect(stale({ startedAt: longAgo })).toMatchObject({ incomplete: 1, inProgress: 0 });
    // `createdAt` is the fallback when the run never reported a start of its own.
    expect(stale({ startedAt: null, createdAt: longAgo })).toMatchObject({ incomplete: 1, inProgress: 0 });
    // Young on either clock: still in progress.
    expect(stale({})).toMatchObject({ incomplete: 0, inProgress: 1 });
  });

  it('floors unclaimed time at zero when claimed stage time exceeds the task span', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(1),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [
        {
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'spec', attempt: 1, startedAt: at(0), finishedAt: at(5) }],
        },
      ],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.unclaimedMs).toEqual({ value: 0, sampleSize: 1 });
  });

  it('excludes a task whose ship evidence predates its creation from the lead-time sample', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        // Backdated: the connector projected ship evidence recorded before the task row.
        {
          id: TASK_A,
          createdAt: at(10),
          updatedAt: at(12),
          lifecycle: 'completed',
          lastShippedAt: at(4),
          openCodeChanges: 0,
        },
        {
          id: TASK_B,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'completed',
          lastShippedAt: at(2),
          openCodeChanges: 0,
        },
        {
          id: TASK_C,
          createdAt: at(0),
          updatedAt: at(6),
          lifecycle: 'completed',
          lastShippedAt: at(6),
          openCodeChanges: 0,
        },
      ],
      runs: [],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    // Still shipped (the evidence exists), but out of both timing samples.
    expect(facts.tasks.shipped).toBe(3);
    expect(facts.leadTimeMs).toEqual({ value: 4 * HOUR, sampleSize: 2 });
    expect(facts.unclaimedMs).toEqual({ value: 4 * HOUR, sampleSize: 2 });

    // The same backdated task measures again once the authority ref carries the tracker
    // issue's own creation: lead starts there, not at the later Coredoc task row.
    const backfilled = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(10),
          sourceCreatedAt: at(2),
          updatedAt: at(12),
          lifecycle: 'completed',
          lastShippedAt: at(4),
          openCodeChanges: 0,
        },
      ],
      runs: [],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });
    expect(backfilled.leadTimeMs).toEqual({ value: 2 * HOUR, sampleSize: 1 });
  });

  it('reports no lead time or unclaimed time at all when every shipped task is backdated', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(10),
          updatedAt: at(12),
          lifecycle: 'completed',
          lastShippedAt: at(4),
          openCodeChanges: 0,
        },
        {
          id: TASK_B,
          createdAt: at(8),
          updatedAt: at(9),
          lifecycle: 'completed',
          lastShippedAt: at(1),
          openCodeChanges: 0,
        },
      ],
      runs: [],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.leadTimeMs).toEqual({ value: null, sampleSize: 0 });
    expect(facts.unclaimedMs).toEqual({ value: null, sampleSize: 0 });
  });

  it('excludes a stage occurrence that finished before it started from the stage and claimed totals', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(4),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
        {
          id: TASK_B,
          createdAt: at(0),
          updatedAt: at(6),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [
        {
          taskId: TASK_A,
          runId: 'run-1',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: at(1), finishedAt: at(2) }],
        },
        {
          taskId: TASK_B,
          runId: 'run-2',
          startedAt: null,
          finishedAt: null,
          createdAt: at(0),
          editVerifyRounds: null,
          // Backwards interval: unmeasurable, so TASK_B contributes no build sample at all.
          stageOccurrences: [{ stageId: 'build', attempt: 1, startedAt: at(5), finishedAt: at(4) }],
        },
      ],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.stages).toEqual([
      { stageId: 'build', claimedMs: { value: 1 * HOUR, sampleSize: 1 }, incomplete: 0, inProgress: 0 },
    ]);
    // TASK_A claims 1h of its 4h span; TASK_B claims nothing of its 6h span.
    expect(facts.unclaimedMs).toEqual({ value: 4.5 * HOUR, sampleSize: 2 });
  });

  it('excludes a code change reviewed before it was ready from the review-wait sample', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(4),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 0,
        },
      ],
      runs: [],
      reworkSignals: [],
      codeChanges: [
        { codeChangeId: 'cc-1', readyForReviewAt: at(1), firstReviewAt: at(3) },
        { codeChangeId: 'cc-2', readyForReviewAt: at(5), firstReviewAt: at(4) },
      ],
      taskCosts: [],
    });

    expect(facts.reviewWaitMs).toEqual({ value: 2 * HOUR, sampleSize: 1 });
  });

  it('returns null medians with empty samples for an empty population', () => {
    expect(
      foldDeliverySummary({
        now: NOW,
        tasks: [],
        runs: [],
        reworkSignals: [],
        codeChanges: [],
        taskCosts: [],
      }),
    ).toEqual({
      tasks: { matching: 0, shipped: 0, partiallyShipped: 0, withRework: 0, active: 0 },
      leadTimeMs: { value: null, sampleSize: 0 },
      reviewStageMs: { value: null, sampleSize: 0 },
      costPerShippedTaskUsd: { value: null, sampleSize: 0, unpricedTasks: 0 },
      stages: [],
      unclaimedMs: { value: null, sampleSize: 0 },
      reviewWaitMs: { value: null, sampleSize: 0 },
      editVerifyRoundsPerRun: { value: null, sampleSize: 0 },
      // Always all three rows, zero-filled, in a stable order.
      rework: {
        bySource: [
          { kind: 'tracker_reopened', signals: 0, tasks: 0 },
          { kind: 'review_changes_requested', signals: 0, tasks: 0 },
          { kind: 'review_commented', signals: 0, tasks: 0 },
        ],
      },
    });
  });

  it('reports a ship with an open code change as partial and keeps it out of every shipped sample', () => {
    const facts = foldDeliverySummary({
      now: NOW,
      tasks: [
        {
          id: TASK_A,
          createdAt: at(0),
          updatedAt: at(4),
          lifecycle: 'completed',
          lastShippedAt: at(4),
          openCodeChanges: 2,
        },
        {
          id: TASK_B,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'completed',
          lastShippedAt: at(2),
          openCodeChanges: 0,
        },
        // Never shipped: an open code change alone is not a partial ship.
        {
          id: TASK_C,
          createdAt: at(0),
          updatedAt: at(2),
          lifecycle: 'active',
          lastShippedAt: null,
          openCodeChanges: 1,
        },
      ],
      runs: [],
      reworkSignals: [],
      codeChanges: [],
      taskCosts: [],
    });

    expect(facts.tasks).toEqual({ matching: 3, shipped: 1, partiallyShipped: 1, withRework: 0, active: 1 });
    // Only TASK_B's 2h lead is measured.
    expect(facts.leadTimeMs).toEqual({ value: 2 * HOUR, sampleSize: 1 });
  });
});
