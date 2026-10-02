/**
 * Pure presentation helpers for the Delivery view (UC-3). No React, no DOM, no
 * clock — every input is explicit so the KPI/median/pareto text is deterministic
 * and unit-testable.
 *
 * Every median carries its sample (BR-11): a null value renders the dash plus an
 * "n of N" caption, and a small sample is marked directional through the single
 * `DIRECTIONAL_SAMPLE_MAX` constant below.
 */

import { type AnalyticsWindow, AnalyticsWindowKind } from '../types.js';
import type {
  CanonicalDeliverySummary,
  CanonicalReworkSignalKind,
  CanonicalReworkSourceKind,
  CanonicalTaskDetail,
  CanonicalTaskSummary,
  DeliveryLifecycleFilter,
  SampledMedian,
} from '../types.js';
import { formatUsd, NO_DATA, plural } from '../format.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The one small-sample threshold on this surface (BR-11): at or below it, a median is directional. */
export const DIRECTIONAL_SAMPLE_MAX = 4;

/** The stage ramp is sequential pipeline progress (ADR-7); it cycles when a task has more stages. */
const STAGE_TOKEN_COUNT = 5;

/** Neutral token for the unclaimed remainder — deliberately outside the stage ramp (ADR-7). */
export const UNCLAIMED_COLOR = 'var(--color-axis)';

export function stageColor(stageIndex: number): string {
  return `var(--color-stage-${(stageIndex % STAGE_TOKEN_COUNT) + 1})`;
}

/**
 * Delivery durations run from minutes to days, coarser than the seconds the shared
 * `formatDurationMs` keeps: ≥48h reads "1.2d", ≥10h "14h", ≥1h "3h 30m", else "6m".
 * Below 10h the unit is whole minutes, never a fraction of an hour — "0.1h" was
 * read as 10 minutes, and a 2-minute stage printed as "0.0h" beside a 0.1h total.
 */
export function formatDurationShort(ms: number): string {
  // A negative span is real (ship evidence predating its task row) but not a
  // duration: clamping it would print "0m", which reads as a measured zero.
  if (!Number.isFinite(ms) || ms < 0) return NO_DATA;
  const hours = ms / HOUR_MS;
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 10) return `${Math.round(hours)}h`;
  if (ms > 0 && ms < MINUTE_MS) return '<1m';
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

export function formatCountValue(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function formatUsdValue(value: number): string {
  return `$${value.toFixed(2)}`;
}

export interface SampledMedianText {
  text: string;
  /** "n of N" when the median is null, "directional" for a small sample, else nothing to say. */
  caption: string | null;
}

export function sampledMedianText(
  median: SampledMedian,
  population: number,
  format: (value: number) => string = formatDurationShort,
  /** Names the population when it is not the matching-task count (lead time samples shipped tasks). */
  populationLabel?: string,
): SampledMedianText {
  if (median.value === null) {
    const suffix = populationLabel === undefined ? '' : ` ${populationLabel}`;
    return { text: NO_DATA, caption: `${median.sampleSize} of ${population}${suffix}` };
  }
  if (median.sampleSize <= DIRECTIONAL_SAMPLE_MAX) return { text: format(median.value), caption: 'directional' };
  return { text: format(median.value), caption: null };
}

export interface DeliveryKpi {
  label: string;
  value: string;
  hint: string;
  caption: string | null;
}

/** The four Delivery KPI tiles, in POC order. Rates are population facts, so they carry no sample caption. */
export function deliveryKpis(summary: CanonicalDeliverySummary): DeliveryKpi[] {
  const matching = summary.tasks.matching;
  // Lead time is measured on shipped tasks only (BR-7), so its sample caption is
  // relative to the shipped count: "0 of 17" against 2 shipped reads as a far
  // worse coverage fact than the read actually is.
  const lead = sampledMedianText(summary.leadTimeMs, summary.tasks.shipped, formatDurationShort, 'shipped');
  const review = sampledMedianText(summary.reviewStageMs, matching);
  const cost = sampledMedianText(summary.costPerShippedTaskUsd, summary.tasks.shipped, formatUsdValue);
  const reworkRate = matching === 0 ? NO_DATA : `${Math.round((summary.tasks.withRework / matching) * 100)}%`;

  // "shipped" is fully shipped only (BR-7); a task whose ship evidence still has an
  // open PR is named separately rather than folded into either number.
  const partially = summary.tasks.partiallyShipped;

  return [
    {
      label: 'Median lead time',
      value: lead.text,
      hint: `${summary.tasks.shipped} shipped${partially > 0 ? ` · +${partially} partially` : ''}`,
      caption: lead.caption,
    },
    {
      label: 'Tasks with rework',
      value: reworkRate,
      hint: `${summary.tasks.withRework} of ${matching} tasks`,
      caption: null,
    },
    {
      label: 'Median review stage',
      value: review.text,
      hint: 'claimed review intervals',
      caption: review.caption,
    },
    {
      label: 'Median cost / shipped task',
      value: cost.text,
      hint: `priced sessions only · unpriced: ${summary.costPerShippedTaskUsd.unpricedTasks}`,
      caption: cost.caption,
    },
  ];
}

export interface StageBarEntry {
  key: string;
  name: string;
  /** Stage ids are identifiers and render mono; the unclaimed remainder is prose. */
  mono: boolean;
  ms: number;
  color: string;
  text: string;
  caption: string | null;
}

/**
 * Stage medians plus the unclaimed remainder. The colour index follows the
 * server's first-seen stage order (`summary.stages`), not the filtered row
 * order, so a stage keeps its colour when another stage's median is empty.
 */
export function stageBarEntries(summary: CanonicalDeliverySummary): StageBarEntry[] {
  const matching = summary.tasks.matching;
  const entries: StageBarEntry[] = [];
  summary.stages.forEach((stage, index) => {
    if (stage.claimedMs.value === null) return;
    const rendered = sampledMedianText(stage.claimedMs, matching);
    entries.push({
      key: stage.stageId,
      name: stage.stageId,
      mono: true,
      ms: stage.claimedMs.value,
      color: stageColor(index),
      text: rendered.text,
      caption: rendered.caption,
    });
  });

  const unclaimed = sampledMedianText(summary.unclaimedMs, matching);
  entries.push({
    key: 'unclaimed',
    name: 'unclaimed',
    mono: false,
    ms: summary.unclaimedMs.value ?? 0,
    color: UNCLAIMED_COLOR,
    text: unclaimed.text,
    caption: unclaimed.caption,
  });
  return entries;
}

/** Human labels for the three counted rework sources (card rows and trace journey alike). */
export const REWORK_SOURCE_LABELS: Record<CanonicalReworkSourceKind, string> = {
  tracker_reopened: 'Tracker reopened',
  review_changes_requested: 'Review: changes requested',
  review_commented: 'Review: comments then commits',
};

/** A trace signal's label; `stage_reentry` is legacy data and is named as the iteration fact it is. */
export function reworkSignalLabel(kind: CanonicalReworkSignalKind): string {
  return kind === 'stage_reentry' ? 'Stage re-entry (legacy)' : REWORK_SOURCE_LABELS[kind];
}

export interface ReworkEntry {
  key: string;
  name: string;
  count: number;
  tasks: number;
}

/**
 * The rework pareto by source (non-causal facts, BR-9). The server always sends all
 * three rows zero-filled in a stable order, so a source with no signals renders as an
 * explicit zero rather than disappearing.
 */
export function reworkEntries(summary: CanonicalDeliverySummary): ReworkEntry[] {
  return summary.rework.bySource.map((row) => ({
    key: row.kind,
    name: REWORK_SOURCE_LABELS[row.kind],
    count: row.signals,
    tasks: row.tasks,
  }));
}

/**
 * The task's session-cost rollup as one line (LIM-1). A null total is "No priced
 * usage", never $0.00, and the session counters stay visible so
 * `sessions === priced + unpriced + withoutUsage` remains checkable by eye.
 */
export function estimatedCostLine(estimatedCost: CanonicalTaskDetail['estimatedCost']): string {
  const { totalUsd, sessions, unpricedSessions, sessionsWithoutUsage } = estimatedCost;
  if (sessions === 0) return "No sessions are linked to this task's runs.";
  if (sessionsWithoutUsage === sessions) {
    return `Session cost is unavailable · ${plural(sessions, 'session')} without usage telemetry · joined via workflow runs`;
  }
  const head = totalUsd === null ? 'No priced usage' : formatUsd(totalUsd);
  const unpriced = unpricedSessions > 0 ? ` · ${unpricedSessions} unpriced` : '';
  const withoutUsage = sessionsWithoutUsage > 0 ? ` · ${sessionsWithoutUsage} without usage` : '';
  return `${head} across ${plural(sessions, 'session')}${unpriced}${withoutUsage} · joined via workflow runs`;
}

export const LIFECYCLE_OPTIONS: ReadonlyArray<{ value: DeliveryLifecycleFilter; label: string }> = [
  { value: 'all', label: 'All tasks' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'active', label: 'Active' },
  { value: 'rework', label: 'With rework' },
  { value: 'runs', label: 'With runs' },
];

export function lifecycleLabel(lifecycle: DeliveryLifecycleFilter): string {
  return LIFECYCLE_OPTIONS.find((option) => option.value === lifecycle)?.label ?? lifecycle;
}

/** Names the window in prose: a preset span, or the explicit custom range. */
export function windowLabel(window: AnalyticsWindow): string {
  return window.kind === AnalyticsWindowKind.Days
    ? `in the last ${window.days} days`
    : `between ${window.since} and ${window.until}`;
}

/**
 * Names the population the KPIs and the task list describe (BR-6, AC-9). Reads the
 * requested filters rather than the summary response, so the caption still renders
 * when the summary read itself is unavailable.
 */
export function populationCaption(
  window: AnalyticsWindow,
  lifecycle: DeliveryLifecycleFilter,
  /** The member scope in prose ("your tasks", "tasks of Ada"); null = the whole workspace. */
  scope: string | null,
): string {
  return `${scope ?? 'Tasks'} updated ${windowLabel(window)} · ${lifecycleLabel(lifecycle)} · UTC`;
}

/**
 * The chip text for a partially shipped task: ship evidence exists but at least one
 * linked code change is still open. Merged/open are counts of linked code changes,
 * so a closed-without-merge PR is in neither.
 */
export function partialShipLabel(task: CanonicalTaskSummary): string {
  const { mergedCodeChanges, openCodeChanges } = task.counts;
  return `Partially shipped · ${mergedCodeChanges} of ${mergedCodeChanges + openCodeChanges} PRs`;
}

/**
 * Lead time for one task (BR-7); null while the task has no ship evidence. Starts at the
 * tracker issue's creation when the authority ref carries one, so a backfilled issue is not
 * measured from the Coredoc task row that the connector created after it had already shipped.
 */
export function leadTimeOf(task: CanonicalTaskSummary): number | null {
  if (task.lastShippedAt === null) return null;
  const start =
    task.authority.kind === 'external_ref' && task.authority.sourceCreatedAt
      ? task.authority.sourceCreatedAt
      : task.createdAt;
  const shipped = Date.parse(task.lastShippedAt);
  const created = Date.parse(start);
  if (!Number.isFinite(shipped) || !Number.isFinite(created)) return null;
  return shipped - created;
}

/**
 * Client-side text filter over the task pages already loaded (BR-14): the server
 * owns the `(days, lifecycle)` population, this only narrows what is on screen,
 * which is why the empty state says "loaded". Relocated from the deleted
 * `CanonicalDeliveryTimeline.tsx` with its behaviour unchanged.
 */
export function filterCanonicalTasks(tasks: CanonicalTaskSummary[], query: string): CanonicalTaskSummary[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return tasks;
  return tasks.filter((task) => {
    const authority =
      task.authority.kind === 'coredoc'
        ? 'coredoc'
        : `${task.authority.provider} ${task.authority.externalId} ${task.authority.externalKey ?? ''} ${task.authority.externalRefId}`;
    return [task.title, task.id, task.repositoryKey, task.lifecycle, task.createdBy, authority]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLowerCase().includes(normalized));
  });
}
