/**
 * Pure composition of one task's trace (UC-4): the gantt lanes, the per-task
 * stage claim, and the merged journey. Nothing here fetches, renders or reads
 * the clock — `TaskTrace` hands it the first page of each collection and gets
 * back a deterministic layout (AC-8).
 *
 * Facts that cannot be placed on a time axis (a run with no timestamps at all,
 * a stage occurrence without `startedAt`) are dropped rather than pinned to an
 * invented time; the collection lists remain the place to see them.
 */

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
} from '../types.js';
import type { GanttLane, GanttRunStage, GanttTrackerState } from '../charts/chart-geometry.js';
import {
  formatDurationShort,
  reworkSignalLabel,
  stageColor,
  UNCLAIMED_COLOR,
  type StageBarEntry,
} from './delivery-presentation.js';

const HOUR_MS = 60 * 60 * 1000;

/** POC padding so a mark on the last fact is not clipped by the plot edge. */
const END_PAD_MS = 2 * HOUR_MS;

/** A journey gap wider than this renders as its own "+Xh gap" row instead of silent whitespace. */
export const JOURNEY_GAP_MS = 12 * HOUR_MS;

/**
 * The first page of every collection the trace composes (BR-12/LIM-8), keyed by
 * parent for the nested reads. Absent keys are absent evidence, not zeros.
 */
export interface TraceSources {
  task: CanonicalTaskSummary;
  externalRefs: CanonicalExternalRefItem[];
  /** externalRefId → its first page of state facts. */
  refHistory: Record<string, CanonicalExternalRefStateFactItem[]>;
  runs: CanonicalRunItem[];
  /** runId → its first page of stage occurrences. */
  runStages: Record<string, CanonicalStageOccurrenceItem[]>;
  codeChanges: CanonicalCodeChangeItem[];
  artifacts: CanonicalArtifactItem[];
  shipEvidence: CanonicalShipEvidenceItem[];
  reworkSignals: CanonicalReworkSignalItem[];
}

function parse(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function humanize(value: string | null): string {
  if (value === null) return 'unavailable';
  return value.replace(/[._:-]+/g, ' ');
}

function refLabel(ref: CanonicalExternalRefItem): string {
  return ref.externalKey ?? ref.externalId;
}

function codeChangeLabel(change: CanonicalCodeChangeItem): string {
  return change.number === null ? `${humanize(change.provider)} ${change.externalId}` : `PR #${change.number}`;
}

/** Stable sort by time; equal times keep input order so a re-run produces the same lanes. */
function sortedBy<T>(items: ReadonlyArray<T>, at: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map((entry) => entry.item);
}

export interface GanttLanesResult {
  lanes: GanttLane[];
  start: number;
  end: number;
}

/**
 * Lane order is fixed — tracker refs, runs by start, pull requests, artifacts,
 * ship evidence — so two renders of the same facts produce the same chart.
 */
export function buildGanttLanes(sources: TraceSources): GanttLanesResult {
  const stamps: number[] = [];
  const push = (ms: number | null) => {
    if (ms !== null) stamps.push(ms);
  };

  // The task span (BR-8) widens the axis only when it is a measurable fact, so the
  // unclaimed gap the "Time by stage" card reports is visible on the same axis. A
  // connector-projected task record (created after its evidence, `updatedAt` bumped by
  // every resync) has no span and must not smear one minute of facts across a month.
  const span = taskSpan(sources.task);
  if (span !== null) {
    push(span.start);
    push(span.end);
  }
  push(parse(sources.task.lastShippedAt));

  const trackerLanes: GanttLane[] = [];
  for (const ref of sources.externalRefs) {
    const facts = sources.refHistory[ref.id] ?? [];
    const states: GanttTrackerState[] = [];
    for (const fact of facts) {
      const at = parse(fact.occurredAt);
      if (at === null) continue;
      push(at);
      states.push({ state: fact.toState, from: fact.fromState, at });
    }
    if (states.length === 0) continue;
    trackerLanes.push({ kind: 'tracker', label: refLabel(ref), states: sortedBy(states, (state) => state.at) });
  }

  interface RunDraft {
    lane: GanttLane;
    start: number;
  }
  const runDrafts: RunDraft[] = [];
  for (const run of sources.runs) {
    const stages: GanttRunStage[] = [];
    for (const occurrence of sources.runStages[run.runId] ?? []) {
      const stageStart = parse(occurrence.startedAt);
      if (stageStart === null) continue;
      const stageEnd = parse(occurrence.finishedAt) ?? stageStart;
      push(stageStart);
      push(stageEnd);
      stages.push({
        stageId: occurrence.stageId,
        start: stageStart,
        end: Math.max(stageStart, stageEnd),
        attempt: occurrence.attempt,
        outcome: occurrence.outcome,
      });
    }
    const stageStarts = stages.map((stage) => stage.start);
    const runStart = parse(run.startedAt) ?? (stageStarts.length > 0 ? Math.min(...stageStarts) : null);
    if (runStart === null) continue;
    const stageEnds = stages.map((stage) => stage.end);
    const runEnd = parse(run.finishedAt) ?? (stageEnds.length > 0 ? Math.max(...stageEnds) : runStart);
    push(runStart);
    push(runEnd);
    const failures = run.verification?.failures ?? 0;
    const label = `${run.intent === null ? 'workflow' : humanize(run.intent)} run${
      failures > 0 ? ` · ${failures} verification failures` : ''
    }`;
    runDrafts.push({
      start: runStart,
      lane: {
        kind: 'run',
        label,
        start: runStart,
        end: Math.max(runStart, runEnd),
        outcome: run.outcome,
        stages: sortedBy(stages, (stage) => stage.start),
      },
    });
  }
  const runLanes = sortedBy(runDrafts, (draft) => draft.start).map((draft) => draft.lane);

  const prLanes: GanttLane[] = [];
  for (const change of sources.codeChanges) {
    const opened = parse(change.createdAtSource) ?? parse(change.updatedAt);
    if (opened === null) continue;
    const ready = parse(change.readyForReviewAt);
    const firstReview = parse(change.firstReviewAt);
    const approved = parse(change.approvedAt);
    const merged = parse(change.mergedAt);
    for (const mark of [opened, ready, firstReview, approved, merged]) push(mark);
    const wait = ready !== null && firstReview !== null ? ` · wait ${formatDurationShort(firstReview - ready)}` : '';
    prLanes.push({
      kind: 'pr',
      label: `${codeChangeLabel(change)}${wait}`,
      opened,
      ready,
      firstReview,
      approved,
      merged,
    });
  }

  const artifactLanes: GanttLane[] = [];
  for (const artifact of sources.artifacts) {
    const artifactCreated = parse(artifact.createdAt);
    if (artifactCreated === null) continue;
    const updated = parse(artifact.updatedAt);
    push(artifactCreated);
    push(updated);
    artifactLanes.push({
      kind: 'artifact',
      label: `${humanize(artifact.kind)} artifact`,
      createdAt: artifactCreated,
      updatedAt: updated === null || updated === artifactCreated ? null : updated,
      revisionCount: artifact.revisionCount,
    });
  }

  const shipLanes: GanttLane[] = [];
  for (const evidence of sortedBy(sources.shipEvidence, (item) => parse(item.occurredAt) ?? 0)) {
    const at = parse(evidence.occurredAt);
    if (at === null) continue;
    push(at);
    shipLanes.push({ kind: 'ship', label: 'ship', at });
  }

  const createdAt = parse(sources.task.createdAt) ?? 0;
  const start = stamps.length > 0 ? Math.min(...stamps) : createdAt;
  const end = (stamps.length > 0 ? Math.max(...stamps) : createdAt) + END_PAD_MS;
  return { lanes: [...trackerLanes, ...runLanes, ...prLanes, ...artifactLanes, ...shipLanes], start, end };
}

/**
 * Stage ids in the order the gantt paints them (lane order, then stage start) —
 * the colour key the legend and the per-task bars must agree with, so one stage
 * is never two colours on one screen.
 */
export function stageOrderOf(lanes: ReadonlyArray<GanttLane>): string[] {
  const order: string[] = [];
  for (const lane of lanes) {
    if (lane.kind !== 'run') continue;
    for (const stage of lane.stages) if (!order.includes(stage.stageId)) order.push(stage.stageId);
  }
  return order;
}

export interface ClaimedStages {
  /** Stage ids in first-seen order (earliest start wins), matching the gantt's colour key. */
  byStage: Array<{ stageId: string; ms: number }>;
  total: number;
}

/**
 * Claimed stage time for this task (BR-8): occurrences carrying both timestamps,
 * deduplicated by occurrence id because one run can be associated with the task
 * through more than one branch.
 */
export function claimedByStage(occurrences: ReadonlyArray<CanonicalStageOccurrenceItem>): ClaimedStages {
  const seen = new Set<string>();
  const totals = new Map<string, number>();
  let total = 0;
  for (const occurrence of sortedBy(occurrences, (item) => parse(item.startedAt) ?? 0)) {
    if (seen.has(occurrence.occurrenceId)) continue;
    seen.add(occurrence.occurrenceId);
    const started = parse(occurrence.startedAt);
    const finished = parse(occurrence.finishedAt);
    if (started === null || finished === null || finished < started) continue;
    const ms = finished - started;
    totals.set(occurrence.stageId, (totals.get(occurrence.stageId) ?? 0) + ms);
    total += ms;
  }
  return { byStage: [...totals].map(([stageId, ms]) => ({ stageId, ms })), total };
}

export interface TaskStageEntries {
  entries: StageBarEntry[];
  footnote: string;
}

/**
 * The task span of BR-8: `(lastShippedAt ?? updatedAt) − createdAt`, or null when the
 * record postdates its evidence (span ≤ 0). One rule for the stage card and the gantt axis.
 */
export function taskSpan(task: CanonicalTaskSummary): { start: number; end: number } | null {
  const created = parse(task.createdAt);
  if (created === null) return null;
  const end = parse(task.lastShippedAt) ?? parse(task.updatedAt) ?? created;
  return end > created ? { start: created, end } : null;
}

/** Per-task stage bars plus the unclaimed remainder of the task's span (BR-8). */
export function taskStageEntries(
  task: CanonicalTaskSummary,
  claimed: ClaimedStages,
  stageOrder: ReadonlyArray<string> = [],
): TaskStageEntries {
  const taskWindow = taskSpan(task);
  const span = taskWindow === null ? 0 : taskWindow.end - taskWindow.start;
  // A task row created after the evidence it points at (a connector projecting history)
  // has no measurable span, so there is no remainder to call unclaimed: stating
  // "claimed 6m of 0m" would be arithmetic on an unavailable fact (explicit-degrade ADR).
  const spanMeasurable = span > 0 && claimed.total <= span;
  const unclaimed = spanMeasurable ? span - claimed.total : 0;

  const entries: StageBarEntry[] = claimed.byStage.map((stage, index) => ({
    key: stage.stageId,
    name: stage.stageId,
    mono: true,
    ms: stage.ms,
    color: stageColor(
      stageOrder.indexOf(stage.stageId) >= 0 ? stageOrder.indexOf(stage.stageId) : stageOrder.length + index,
    ),
    text: formatDurationShort(stage.ms),
    caption: null,
  }));
  if (spanMeasurable) {
    entries.push({
      key: 'unclaimed',
      name: 'unclaimed',
      mono: false,
      ms: unclaimed,
      color: UNCLAIMED_COLOR,
      text: formatDurationShort(unclaimed),
      caption: null,
    });
  }

  // The two ways a span can fail to hold the claimed time are different facts and
  // must not share one sentence: no span at all vs. a span the stages overrun.
  const unmeasurableCause =
    span <= 0
      ? 'the task span is unavailable (task record created after its evidence)'
      : "recorded stages overlap or extend past the task's last update";

  return {
    entries,
    footnote: spanMeasurable
      ? `Claimed ${formatDurationShort(claimed.total)} of ${formatDurationShort(
          span,
        )} total span. Gaps between recorded intervals are unclaimed, not attributed.`
      : `Claimed ${formatDurationShort(claimed.total)} across recorded stages; ${unmeasurableCause}.`,
  };
}

export type TraceJourneyKind = 'ref' | 'stage' | 'code' | 'artifact' | 'rework' | 'ship';

export interface TraceJourneyEvent {
  id: string;
  kind: TraceJourneyKind;
  at: number;
  label: string;
  detail: string | null;
}

/**
 * One chronological stream over every loaded collection. Ordering is by time,
 * then kind, then id, so equal timestamps across kinds interleave the same way
 * on every render instead of collapsing into per-collection runs.
 */
export function journeyEvents(sources: TraceSources): TraceJourneyEvent[] {
  const events: TraceJourneyEvent[] = [];
  const add = (event: TraceJourneyEvent | null) => {
    if (event !== null) events.push(event);
  };
  const at = (value: string | null, build: (ms: number) => TraceJourneyEvent): TraceJourneyEvent | null => {
    const ms = parse(value);
    return ms === null ? null : build(ms);
  };

  for (const ref of sources.externalRefs) {
    for (const fact of sources.refHistory[ref.id] ?? []) {
      // A tracker update that re-states the same state ("To Do → To Do") carries no
      // transition; it is a sync artefact, not a step in the journey.
      if (fact.fromState === fact.toState) continue;
      add(
        at(fact.occurredAt, (ms) => ({
          id: fact.id,
          kind: 'ref',
          at: ms,
          label: `${fact.fromState ?? 'Unavailable'} → ${fact.toState}`,
          detail: refLabel(ref),
        })),
      );
    }
  }

  for (const run of sources.runs) {
    for (const occurrence of sources.runStages[run.runId] ?? []) {
      const started = parse(occurrence.startedAt);
      if (started === null) continue;
      const head = `${occurrence.stageId} · attempt ${occurrence.attempt}`;
      add({
        id: `${occurrence.occurrenceId}:start`,
        kind: 'stage',
        at: started,
        label: `${head} started`,
        detail: run.runId,
      });
      const finished = parse(occurrence.finishedAt);
      if (finished === null) continue;
      add({
        id: `${occurrence.occurrenceId}:end`,
        kind: 'stage',
        at: finished,
        label: `${head} ${occurrence.outcome ?? 'finished'}`,
        detail: `${formatDurationShort(Math.max(0, finished - started))} claimed`,
      });
    }
  }

  for (const change of sources.codeChanges) {
    const marks: Array<[string, string | null]> = [
      ['opened', change.createdAtSource],
      ['ready for review', change.readyForReviewAt],
      ['first review', change.firstReviewAt],
      ['approved', change.approvedAt],
      ['merged', change.mergedAt],
    ];
    for (const [name, value] of marks) {
      add(
        at(value, (ms) => ({
          id: `${change.id}:${name}`,
          kind: 'code',
          at: ms,
          label: `${codeChangeLabel(change)} ${name}`,
          detail: change.sourceBranch,
        })),
      );
    }
  }

  for (const artifact of sources.artifacts) {
    const created = parse(artifact.createdAt);
    const updated = parse(artifact.updatedAt);
    const detail = `${artifact.revisionCount} revisions`;
    if (created !== null) {
      add({
        id: `${artifact.id}:created`,
        kind: 'artifact',
        at: created,
        label: `${humanize(artifact.kind)} artifact created`,
        detail,
      });
    }
    if (updated !== null && updated !== created) {
      add({
        id: `${artifact.id}:updated`,
        kind: 'artifact',
        at: updated,
        label: `${humanize(artifact.kind)} artifact updated`,
        detail,
      });
    }
  }

  for (const signal of sources.reworkSignals) {
    add(
      at(signal.occurredAt, (ms) => ({
        id: signal.id,
        kind: 'rework',
        at: ms,
        label: reworkSignalLabel(signal.kind),
        detail: signal.sourceRef,
      })),
    );
  }

  for (const evidence of sources.shipEvidence) {
    add(
      at(evidence.occurredAt, (ms) => ({
        id: evidence.id,
        kind: 'ship',
        at: ms,
        label: `ship evidence · ${humanize(evidence.source)}`,
        detail: evidence.sourceKey,
      })),
    );
  }

  return events.sort(
    (a, b) =>
      a.at - b.at || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export type JourneyRow =
  /** `id` is the following event's id, so the row has a stable key without an array index. */
  { type: 'gap'; ms: number; id: string } | { type: 'event'; event: TraceJourneyEvent };

/** Long silences are rendered, not skipped — a "+Xh gap" row keeps the axis honest. */
export function journeyRows(events: ReadonlyArray<TraceJourneyEvent>, gapMs: number = JOURNEY_GAP_MS): JourneyRow[] {
  const rows: JourneyRow[] = [];
  let previous: number | null = null;
  for (const event of events) {
    if (previous !== null && event.at - previous > gapMs) {
      rows.push({ type: 'gap', ms: event.at - previous, id: event.id });
    }
    rows.push({ type: 'event', event });
    previous = event.at;
  }
  return rows;
}
