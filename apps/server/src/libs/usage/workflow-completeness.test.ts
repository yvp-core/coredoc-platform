import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_STALENESS_WINDOW_MS,
  foldWorkflowRunCompleteness,
  stalenessCutoff,
  workflowCompleteness,
} from './workflow-completeness.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;

/** Started this long ago, so still inside the 17-day window. */
function fresh(): Date {
  return new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS + HOUR);
}

/** Started this long ago, so past the window: no client will ever deliver the finish. */
function stale(): Date {
  return new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS - HOUR);
}

describe('workflowCompleteness', () => {
  // 14 d is the longest legitimate suspension (awaiting spec acceptance), 72 h the margin for
  // the lazy sweep that ends one — not a second stage of the same clock.
  it('is 17 days: the longest legitimate suspension (14 d) plus a 72 h sweep margin', () => {
    expect(WORKFLOW_STALENESS_WINDOW_MS).toBe((72 + 14 * 24) * HOUR);
  });

  it('classifies a started run with no finish by its age against the staleness window', () => {
    expect(workflowCompleteness(fresh(), null, NOW)).toBe('in_progress');
    expect(workflowCompleteness(stale(), null, NOW)).toBe('incomplete');
  });

  it('keeps a run exactly at the window boundary in progress', () => {
    expect(workflowCompleteness(new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS), null, NOW)).toBe('in_progress');
  });

  it('is finished whenever a finish arrived, however old the run', () => {
    expect(workflowCompleteness(stale(), new Date(NOW.getTime() - HOUR), NOW)).toBe('finished');
  });

  it('cannot age a span with no observed start, so it stays in progress', () => {
    expect(workflowCompleteness(null, null, NOW)).toBe('in_progress');
  });
});

describe('stalenessCutoff', () => {
  /** What the SQL bound the service filters on (`startedAt < cutoff`) says about a run. */
  const sqlSaysIncomplete = (startedAt: Date) => startedAt.getTime() < stalenessCutoff(NOW).getTime();

  it('agrees with workflowCompleteness at the boundary and on either side of it', () => {
    const boundary = new Date(NOW.getTime() - WORKFLOW_STALENESS_WINDOW_MS);
    for (const startedAt of [
      new Date(boundary.getTime() - 1),
      boundary,
      new Date(boundary.getTime() + 1),
      fresh(),
      stale(),
    ]) {
      expect(sqlSaysIncomplete(startedAt), startedAt.toISOString()).toBe(
        workflowCompleteness(startedAt, null, NOW) === 'incomplete',
      );
    }
  });
});

describe('foldWorkflowRunCompleteness', () => {
  it('counts unfinished runs apart from the outcome breakdown at both ages', () => {
    expect(
      foldWorkflowRunCompleteness(
        [
          { startedAt: stale(), finishedAt: new Date(NOW.getTime() - HOUR), outcome: 'success' },
          { startedAt: fresh(), finishedAt: new Date(NOW.getTime() - HOUR), outcome: 'success' },
          { startedAt: fresh(), finishedAt: new Date(NOW.getTime() - HOUR), outcome: 'failed' },
          // Finished without a reported outcome: still a finished run, never an incomplete one.
          { startedAt: fresh(), finishedAt: new Date(NOW.getTime() - HOUR), outcome: null },
          { startedAt: fresh(), finishedAt: null, outcome: null },
          { startedAt: stale(), finishedAt: null, outcome: null },
          { startedAt: stale(), finishedAt: null, outcome: null },
        ],
        NOW,
      ),
    ).toEqual({
      byOutcome: { success: 2, failed: 1, unknown: 1 },
      inProgress: 1,
      incomplete: 2,
    });
  });

  it('reports an empty breakdown rather than a fabricated outcome for a population of unfinished runs', () => {
    expect(
      foldWorkflowRunCompleteness(
        [
          { startedAt: stale(), finishedAt: null, outcome: null },
          { startedAt: fresh(), finishedAt: null, outcome: null },
        ],
        NOW,
      ),
    ).toEqual({ byOutcome: {}, inProgress: 1, incomplete: 1 });
  });
});
