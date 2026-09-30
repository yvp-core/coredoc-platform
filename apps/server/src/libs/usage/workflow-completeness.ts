/**
 * Read-side completeness classification for workflow runs and stage occurrences.
 *
 * Nothing persisted encodes "unfinished": `workflow.run.started` creates the row and only
 * `workflow.run.finished` sets `finishedAt`/`outcome`, so a run whose finish never arrived is
 * indistinguishable from one still running — except by age. Classification is therefore
 * computed here at read time, never stored (no contract change, no migration).
 *
 * The window is the LONGEST legitimate suspension — 14 d, a run parked awaiting spec
 * acceptance; the ordinary suspended-run TTL of 72 h is the other alternative, not an earlier
 * stage of the same clock — plus a 72 h margin, because the sweep that ends a suspension is
 * lazy (another session's `route-task` performs it, whenever one next runs). Until that has
 * elapsed the client can still deliver a finish, so the run is `in_progress`; past it, no
 * client will ever finish it and it is `incomplete`.
 */
export const WORKFLOW_STALENESS_WINDOW_MS = 17 * 24 * 60 * 60 * 1_000;

export type WorkflowCompleteness = 'finished' | 'in_progress' | 'incomplete';

/**
 * The instant a run must have started at or before to be `incomplete` — the same rule as
 * `workflowCompleteness`, expressed as a bound a database can filter on.
 *
 * `workflowCompleteness` calls a run stale on `now - startedAt > window` — STRICTLY older —
 * so the equivalent SQL bound is `startedAt < cutoff`, i.e. Prisma `lt`, NOT `lte`: a run
 * started exactly `window` ago is `in_progress` under the TS rule, and `lte` would call that
 * one instant `incomplete`. The boundary test in this module's suite pins the two together.
 */
export function stalenessCutoff(now: Date): Date {
  return new Date(now.getTime() - WORKFLOW_STALENESS_WINDOW_MS);
}

/**
 * `startedAt` is the instant the staleness clock runs from. A run row can exist without one
 * (a stage event created it before its own `workflow.run.started` arrived); callers pass the
 * row's `createdAt` as the fallback, since that is the earliest instant the server observed it.
 * With neither there is no age to judge, so the span stays `in_progress` rather than being
 * called stale on no evidence.
 */
export function workflowCompleteness(startedAt: Date | null, finishedAt: Date | null, now: Date): WorkflowCompleteness {
  if (finishedAt !== null) return 'finished';
  if (startedAt === null) return 'in_progress';
  return now.getTime() - startedAt.getTime() > WORKFLOW_STALENESS_WINDOW_MS ? 'incomplete' : 'in_progress';
}

/**
 * Outcome breakdown of a run population with the two unfinished classes counted beside it.
 * `byOutcome` covers finished runs only, so an incomplete run never lands in an outcome bucket
 * and never contributes a duration (`durationMs` needs both ends observed).
 */
export interface WorkflowRunCompletenessBreakdown {
  /** Finished runs per reported outcome; a finish that carried none counts under `unknown`. */
  byOutcome: Record<string, number>;
  /** Started, never finished, older than the staleness window — excluded from every aggregate. */
  incomplete: number;
  /** Started, never finished, still inside the window: the run may yet finish. */
  inProgress: number;
}

export function foldWorkflowRunCompleteness(
  runs: readonly { startedAt: Date | null; finishedAt: Date | null; outcome: string | null }[],
  now: Date,
): WorkflowRunCompletenessBreakdown {
  const byOutcome: Record<string, number> = {};
  let incomplete = 0;
  let inProgress = 0;
  for (const run of runs) {
    const status = workflowCompleteness(run.startedAt, run.finishedAt, now);
    if (status === 'incomplete') incomplete += 1;
    else if (status === 'in_progress') inProgress += 1;
    else {
      const key = run.outcome ?? 'unknown';
      byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    }
  }
  return { byOutcome, incomplete, inProgress };
}
