/**
 * Pure presentation helpers for the Delivery view (UC-3). No React, no DOM, no
 * clock — every input is explicit so the KPI/median/pareto text is deterministic
 * and unit-testable.
 *
 * Every median carries its sample (BR-11): a null value renders the dash plus an
 * "n of N" caption, and a small sample is marked directional through the single
 * `DIRECTIONAL_SAMPLE_MAX` constant below.
 */

import {
  AnalyticsWindowKind,
  type AnalyticsWindow,
  type CanonicalDeliverySummary,
  type CanonicalReworkSignalKind,
  type CanonicalTaskDetail,
  type CanonicalTaskSummary,
  type DeliveryLifecycleFilter,
  type SampledMedian,
} from '../../../../shared/ipc-types.js';
import { formatUsd, NO_DATA, plural } from '../observability-format';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The one small-sample threshold on this surface (BR-11): at or below it, a median is directional. */
export const DIRECTIONAL_SAMPLE_MAX = 4;

/** The stage ramp is sequential pipeline progress (ADR-7); it cycles when a task has more stages. */
const STAGE_TOKEN_COUNT = 5;

/** Neutral token for the unclaimed remainder — deliberately outside the stage ramp (ADR-7). */
export const UNCLAIMED_COLOR = 'var(--color-chart-axis)';

export function stageColor(stageIndex: number): string {
  return `var(--color-chart-stage-${(stageIndex % STAGE_TOKEN_COUNT) + 1})`;
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

  return [
    {
      label: 'Median lead time',
      value: lead.text,
      // The shipped sample is fully shipped tasks only; a partial ship is named
      // beside it rather than folded into a count it is not part of.
      hint:
        summary.tasks.partiallyShipped > 0
          ? `${summary.tasks.shipped} shipped · +${summary.tasks.partiallyShipped} partially`
          : `${summary.tasks.shipped} shipped`,
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

/** Human labels for the rework sources — the same wording in the pareto and in the trace. */
const REWORK_KIND_LABEL: Record<CanonicalReworkSignalKind, string> = {
  tracker_reopened: 'Tracker reopened',
  review_changes_requested: 'Review: changes requested',
  review_commented: 'Review: comments then commits',
  // Legacy rows survive in the trace even though no figure counts them, and they
  // are an iteration fact — never named "rework" on any surface.
  stage_reentry: 'Stage re-entry',
};

export function reworkKindLabel(kind: CanonicalReworkSignalKind): string {
  return REWORK_KIND_LABEL[kind] ?? kind;
}

export interface ReworkEntry {
  key: string;
  name: string;
  count: number;
  tasks: number;
}

/**
 * The rework pareto by source (non-causal facts, BR-9). Every source stays on
 * screen even at zero: a dropped row would read as "not measured" instead of the
 * measured zero it is (ADR-explicit-degrade).
 */
export function reworkEntries(summary: CanonicalDeliverySummary): ReworkEntry[] {
  return summary.rework.bySource.map((row) => ({
    key: row.kind,
    name: reworkKindLabel(row.kind),
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

/**
 * Names the population the KPIs and the task list describe (BR-6, AC-9). Takes the
 * requested selector rather than the response, so the caption still renders from the
 * requested filters when the summary read itself is unavailable.
 */
/**
 * The window phrase every Delivery caption ends with — one wording for both window
 * kinds, so the empty task list names a custom range the same way the population
 * caption above it does instead of inventing a day count for it.
 */
export function windowLabel(window: AnalyticsWindow): string {
  return window.kind === AnalyticsWindowKind.Days
    ? `in the last ${window.days} days`
    : `in ${window.since} – ${window.until}`;
}

export function populationCaption(
  window: AnalyticsWindow,
  lifecycle: DeliveryLifecycleFilter,
  mine: boolean,
  /** The selected member's label; null when the read covers the whole workspace. */
  memberName: string | null = null,
): string {
  return `Tasks updated ${windowLabel(window)} · ${lifecycleLabel(lifecycle)}${scopeSuffix(mine, memberName)} · UTC`;
}

function scopeSuffix(mine: boolean, memberName: string | null): string {
  if (mine) return ' · your tasks';
  return memberName === null ? '' : ` · tasks of ${memberName}`;
}

/** The noun the empty task list uses for the current member scope. */
export function scopeNoun(mine: boolean, memberName: string | null): string {
  if (mine) return 'tasks of yours';
  return memberName === null ? 'tasks' : `tasks of ${memberName}`;
}

/** One workspace member as the delivery member filter offers it. */
export interface DeliveryMemberOption {
  userId: string;
  label: string;
}

/**
 * Real members only: an invite placeholder (`pending:<email>`) has no user id the
 * delivery reads could ever match, so offering it would promise an empty read.
 */
export function memberOptions(
  members: ReadonlyArray<{ userId: string; email: string; displayName: string | null }>,
): DeliveryMemberOption[] {
  return members
    .filter((member) => !member.userId.startsWith('pending:'))
    .map((member) => ({ userId: member.userId, label: member.displayName ?? member.email }));
}

/**
 * The partial-ship chip (ship evidence with code changes still open). Null when the
 * task is not partially shipped, so the caller renders nothing rather than a zero.
 */
export function partialShipChipText(task: CanonicalTaskSummary): string | null {
  if (task.shipState !== 'partial') return null;
  const { mergedCodeChanges, openCodeChanges } = task.counts;
  const total = mergedCodeChanges + openCodeChanges;
  return `Partially shipped · ${mergedCodeChanges} of ${total} PRs`;
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
