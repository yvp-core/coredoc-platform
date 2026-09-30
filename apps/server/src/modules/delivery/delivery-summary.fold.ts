import {
  COUNTED_REWORK_KINDS,
  type CanonicalDeliverySummary,
  type CountedReworkKind,
  type DeliveryReworkBySource,
  type DeliveryStageMedian,
  deliveryShipState,
  type SampledMedian,
} from './canonical-delivery-read.contract.js';
import { workflowCompleteness } from '../../libs/usage/workflow-completeness.js';

/**
 * The delivery summary fold (BR-7..BR-10). Everything here is a pure function over rows the
 * canonical reads produce, so the medians can be proven against hand-computed fixtures without
 * a database; the SQL that yields the rows is proven separately by the PostgreSQL integration.
 */

export interface DeliverySummaryTaskRow {
  id: string;
  createdAt: Date;
  /** Tracker-issue creation instant from the authority external ref; null when unknown. */
  sourceCreatedAt: Date | null;
  updatedAt: Date;
  lifecycle: string;
  /** Latest ship-evidence `occurredAt`; null when the task never shipped. */
  lastShippedAt: Date | null;
  /** Linked code changes still open; any of them downgrades a ship to `partial`. */
  openCodeChanges: number;
}

export interface DeliverySummaryStageOccurrenceRow {
  stageId: string;
  attempt: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * One distinct (task, run) pair. A run associated with a task through both branches appears
 * once; a run associated with two tasks appears once per task (BR-8).
 */
export interface DeliverySummaryRunRow {
  taskId: string;
  runId: string;
  /** The run's own start; a stage event can create the row first, hence nullable. */
  startedAt: Date | null;
  /** Non-null once `workflow.run.finished` arrived — the fact that settles its open stages. */
  finishedAt: Date | null;
  /** Earliest instant the server observed the run; the clock when `startedAt` is null. */
  createdAt: Date;
  stageOccurrences: DeliverySummaryStageOccurrenceRow[];
  editVerifyRounds: number | null;
}

export interface DeliverySummaryReworkSignalRow {
  taskId: string;
  kind: string;
}

export interface DeliverySummaryCodeChangeRow {
  codeChangeId: string;
  readyForReviewAt: Date | null;
  firstReviewAt: Date | null;
}

export interface DeliverySummaryTaskCostRow {
  taskId: string;
  /** Sessions joined to the task that reported usage, whether or not any of them could be priced. */
  sessions: number;
  /** Sum over the priced sessions; null when the task has no priced session at all. */
  pricedTotalUsd: number | null;
}

export interface DeliverySummaryInput {
  /** Read instant the stage-occurrence staleness classification is measured against. */
  now: Date;
  tasks: DeliverySummaryTaskRow[];
  runs: DeliverySummaryRunRow[];
  reworkSignals: DeliverySummaryReworkSignalRow[];
  codeChanges: DeliverySummaryCodeChangeRow[];
  taskCosts: DeliverySummaryTaskCostRow[];
}

export type DeliverySummaryFacts = Omit<CanonicalDeliverySummary, 'window'>;

const EMPTY_MEDIAN: SampledMedian = { value: null, sampleSize: 0 };

function median(samples: number[]): SampledMedian {
  if (samples.length === 0) return { ...EMPTY_MEDIAN };
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const value = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { value, sampleSize: sorted.length };
}

/**
 * Claimed time only counts occurrences with both ends observed (BR-8). A negative interval
 * leaves the sample entirely rather than being clamped to zero, which would assert a
 * same-instant stage that never happened (explicit-degrade ADR).
 */
function claimedMs(occurrence: DeliverySummaryStageOccurrenceRow): number | null {
  if (occurrence.startedAt === null || occurrence.finishedAt === null) return null;
  const claimed = occurrence.finishedAt.getTime() - occurrence.startedAt.getTime();
  return claimed >= 0 ? claimed : null;
}

export function foldDeliverySummary(input: DeliverySummaryInput): DeliverySummaryFacts {
  const matchingTaskIds = new Set(input.tasks.map((task) => task.id));

  // Stage identity is ordered by first appearance in the row stream (BR-8 "first seen").
  const stageOrder: string[] = [];
  const claimedByTaskAndStage = new Map<string, Map<string, number>>();
  // Counted per stage, not per task: an unfinished occurrence has no claimed time to fold into
  // a task total, so it would otherwise vanish from the summary entirely. Keyed by occurrence
  // so a run linked to two tasks — which appears once per task (BR-8) — is still one occurrence.
  const incompleteByStage = new Map<string, number>();
  const inProgressByStage = new Map<string, number>();
  const countedOccurrences = new Set<string>();
  const editVerifyRoundsByRun = new Map<string, number>();

  /**
   * BR-9: rework is signal evidence only. A stage occurrence with `attempt > 1` is an
   * iteration fact — the agent re-entered a stage — and no longer counts as rework, so
   * `stage_reentry` signals (which are no longer produced) are ignored here too.
   */
  const reworkTaskIdsByKind = new Map<CountedReworkKind, Set<string>>();
  const signalsByKind = new Map<CountedReworkKind, number>();
  const reworkTaskIds = new Set<string>();
  for (const signal of input.reworkSignals) {
    if (!matchingTaskIds.has(signal.taskId)) continue;
    const kind = COUNTED_REWORK_KINDS.find((counted) => counted === signal.kind);
    if (kind === undefined) continue;
    signalsByKind.set(kind, (signalsByKind.get(kind) ?? 0) + 1);
    let tasks = reworkTaskIdsByKind.get(kind);
    if (!tasks) {
      tasks = new Set<string>();
      reworkTaskIdsByKind.set(kind, tasks);
    }
    tasks.add(signal.taskId);
    reworkTaskIds.add(signal.taskId);
  }

  for (const run of input.runs) {
    if (!matchingTaskIds.has(run.taskId)) continue;
    // Keyed by run: a run linked to two tasks is still one sample for the per-run counter.
    if (run.editVerifyRounds !== null) editVerifyRoundsByRun.set(run.runId, run.editVerifyRounds);
    for (const occurrence of run.stageOccurrences) {
      if (!stageOrder.includes(occurrence.stageId)) stageOrder.push(occurrence.stageId);
      const occurrenceKey = `${run.runId}\u0000${occurrence.stageId}\u0000${occurrence.attempt}`;
      if (!countedOccurrences.has(occurrenceKey)) {
        countedOccurrences.add(occurrenceKey);
        // A stage still open on a run that FINISHED is incomplete the moment the run finishes:
        // no further stage event is coming for it, so aging it against the staleness window
        // would park a known-dead occurrence in `inProgress` for another 17 days. An occurrence
        // with no start of its own is aged on the run's clock (`startedAt`, or the instant the
        // server first observed the run) rather than escaping classification entirely.
        const status =
          occurrence.finishedAt === null && run.finishedAt !== null
            ? 'incomplete'
            : workflowCompleteness(
                occurrence.startedAt ?? run.startedAt ?? run.createdAt,
                occurrence.finishedAt,
                input.now,
              );
        if (status === 'incomplete') {
          incompleteByStage.set(occurrence.stageId, (incompleteByStage.get(occurrence.stageId) ?? 0) + 1);
        } else if (status === 'in_progress') {
          inProgressByStage.set(occurrence.stageId, (inProgressByStage.get(occurrence.stageId) ?? 0) + 1);
        }
      }
      const claimed = claimedMs(occurrence);
      if (claimed === null) continue;
      let stages = claimedByTaskAndStage.get(run.taskId);
      if (!stages) {
        stages = new Map<string, number>();
        claimedByTaskAndStage.set(run.taskId, stages);
      }
      stages.set(occurrence.stageId, (stages.get(occurrence.stageId) ?? 0) + claimed);
    }
  }

  const leadTimes: number[] = [];
  const unclaimed: number[] = [];
  let shipped = 0;
  let partiallyShipped = 0;
  let withRework = 0;
  let active = 0;
  for (const task of input.tasks) {
    const lastShippedAt = task.lastShippedAt;
    const shipState = deliveryShipState(lastShippedAt !== null, task.openCodeChanges);
    if (shipState === 'partial') partiallyShipped += 1;
    // Every "shipped" sample below is fully-shipped only: a task with an open linked code
    // change has not finished delivering, so its lead time would measure a partial delivery.
    if (shipState === 'shipped' && lastShippedAt !== null) {
      shipped += 1;
      // Lead starts at the tracker issue's creation, falling back to the task row only
      // when the authority ref carries none: a backfilled issue shipped before the
      // connector was linked would otherwise measure against a task row created after
      // its own ship evidence. That span is still unmeasurable when it stays negative,
      // so it leaves the sample entirely rather than being clamped to zero, which would
      // assert a same-instant delivery that never happened (explicit-degrade ADR, BR-7).
      const lead = lastShippedAt.getTime() - (task.sourceCreatedAt ?? task.createdAt).getTime();
      if (lead >= 0) leadTimes.push(lead);
    }
    if (reworkTaskIds.has(task.id)) withRework += 1;
    if (task.lifecycle === 'active') active += 1;
    const span = (task.lastShippedAt ?? task.updatedAt).getTime() - task.createdAt.getTime();
    let claimedTotal = 0;
    for (const stageClaimed of claimedByTaskAndStage.get(task.id)?.values() ?? []) claimedTotal += stageClaimed;
    // Same guard for the span: a negative span has no unclaimed remainder to state (BR-8).
    if (span >= 0) unclaimed.push(Math.max(0, span - claimedTotal));
  }

  const stages: DeliveryStageMedian[] = stageOrder.map((stageId) => {
    const samples: number[] = [];
    for (const task of input.tasks) {
      const claimed = claimedByTaskAndStage.get(task.id)?.get(stageId);
      if (claimed !== undefined) samples.push(claimed);
    }
    return {
      stageId,
      claimedMs: median(samples),
      incomplete: incompleteByStage.get(stageId) ?? 0,
      inProgress: inProgressByStage.get(stageId) ?? 0,
    };
  });

  // Always all three rows, zero-filled and in a stable order: a missing row would read as
  // "this source was not measured" rather than "this source produced nothing".
  const bySource: DeliveryReworkBySource[] = COUNTED_REWORK_KINDS.map((kind) => ({
    kind,
    signals: signalsByKind.get(kind) ?? 0,
    tasks: reworkTaskIdsByKind.get(kind)?.size ?? 0,
  }));

  // Keyed by code change: one linked to two matching tasks is one review wait (BR-10).
  const reviewWaits = new Map<string, number>();
  for (const codeChange of input.codeChanges) {
    if (codeChange.readyForReviewAt === null || codeChange.firstReviewAt === null) continue;
    // Same guard as the lead time and the stage claim: a negative wait is unmeasurable, so it
    // leaves the sample rather than being clamped to zero (explicit-degrade ADR).
    const wait = codeChange.firstReviewAt.getTime() - codeChange.readyForReviewAt.getTime();
    if (wait < 0) continue;
    reviewWaits.set(codeChange.codeChangeId, wait);
  }

  const taskCosts: number[] = [];
  let unpricedTasks = 0;
  for (const cost of input.taskCosts) {
    if (cost.sessions === 0) continue;
    if (cost.pricedTotalUsd === null) unpricedTasks += 1;
    else taskCosts.push(cost.pricedTotalUsd);
  }

  return {
    tasks: { matching: input.tasks.length, shipped, partiallyShipped, withRework, active },
    leadTimeMs: median(leadTimes),
    reviewStageMs: stages.find((stage) => stage.stageId === 'review')?.claimedMs ?? { ...EMPTY_MEDIAN },
    costPerShippedTaskUsd: { ...median(taskCosts), unpricedTasks },
    stages,
    unclaimedMs: median(unclaimed),
    reviewWaitMs: median([...reviewWaits.values()]),
    editVerifyRoundsPerRun: median([...editVerifyRoundsByRun.values()]),
    rework: { bySource },
  };
}
