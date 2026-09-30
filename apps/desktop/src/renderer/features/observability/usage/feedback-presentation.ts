/**
 * Pure display logic for the Session feedback card. No React, no DOM, no clock —
 * every string the card renders is derived here so it stays unit-testable in the
 * vitest `node` environment (LIM-6).
 *
 * Explicit-degrade throughout: an absent rating is the dash plus the "n of N"
 * idiom, never a fabricated 0 (BR-11, ADR-3).
 */

import {
  FeedbackSort,
  SortOrder,
  type FeedbackRecord,
  type FeedbackRecordsFilter,
  type FeedbackRoadmap,
  type FeedbackSessionIssueArea,
  type FeedbackReviewStatus,
} from '../../../../shared/ipc-types.js';
import type { ChipTone } from '../delivery/Chip';
import { NO_DATA, plural } from '../observability-format';

/** Human labels for the closed session-issue area set (the raw slugs read as internals). */
export const SESSION_AREA_LABELS: Record<FeedbackSessionIssueArea, string> = {
  'workflow-routing': 'Workflow routing',
  'skill-instructions': 'Skill instructions',
  'task-context': 'Task context',
  'mcp-transport': 'MCP tools & transport',
  'agent-behavior': 'Agent behavior',
  'host-environment': 'Host environment',
  capture: 'Capture',
  other: 'Other',
};

export const ALL = 'all';

export interface FilterOption {
  value: string;
  label: string;
  /** Hover text where the label alone understates what the option matches. */
  title?: string;
}

/** The one area whose scope is wider than its label: pre-session-feedback records report tools only. */
const AREA_TITLES: Partial<Record<FeedbackSessionIssueArea, string>> = {
  'mcp-transport': 'tool issues and transport, including records that only report tool issues',
};

export const AREA_OPTIONS: ReadonlyArray<FilterOption> = [
  { value: ALL, label: 'All areas' },
  ...(Object.keys(SESSION_AREA_LABELS) as FeedbackSessionIssueArea[]).map((area) => ({
    value: area,
    label: SESSION_AREA_LABELS[area],
    title: AREA_TITLES[area],
  })),
];

/** Sort is one control on the wire's two fields; the value is the encoded pair. */
export const SORT_OPTIONS: ReadonlyArray<FilterOption> = [
  { value: `${FeedbackSort.CreatedAt}:${SortOrder.Desc}`, label: 'Newest first' },
  { value: `${FeedbackSort.CreatedAt}:${SortOrder.Asc}`, label: 'Oldest first' },
  { value: `${FeedbackSort.OverallRating}:${SortOrder.Asc}`, label: 'Lowest agent rating' },
  { value: `${FeedbackSort.OverallRating}:${SortOrder.Desc}`, label: 'Highest agent rating' },
  { value: `${FeedbackSort.UserRating}:${SortOrder.Asc}`, label: 'Lowest user rating' },
];

export function encodeSort(filter: FeedbackRecordsFilter): string {
  return `${filter.sort}:${filter.order}`;
}

export function decodeSort(value: string): { sort: FeedbackSort; order: SortOrder } {
  const [sort, order] = value.split(':');
  return { sort: sort as FeedbackSort, order: order as SortOrder };
}

/**
 * Apply one filter change. Every change resets to page 1: page N of the previous
 * filter is not a page of this one, and the server would answer it with unrelated
 * rows. An explicit `page` in the patch is the pagination footer and wins.
 */
export function nextFilter(
  current: FeedbackRecordsFilter,
  patch: Partial<FeedbackRecordsFilter>,
): FeedbackRecordsFilter {
  return { ...current, page: 1, ...patch };
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

function rating(value: number | null): string {
  return value === null ? NO_DATA : value.toFixed(1);
}

/**
 * One line over the roadmap aggregates: volume, the latest agent/user rating pair,
 * review coverage and the self-assessment gap. The rating pair is the latest trend
 * point, which is the only month the aggregate states a mean for.
 */
export function summaryStrip(feedback: FeedbackRoadmap): string {
  const latest = feedback.ratingTrend[feedback.ratingTrend.length - 1] ?? null;
  const reviewed = feedback.reviews.confirmed + feedback.reviews.amended;
  const total = feedback.feedbackCount;
  const share = total === 0 ? NO_DATA : `${Math.round((reviewed / total) * 100)}%`;
  const gap = feedback.reviews.avgSelfAssessmentGap;
  return [
    plural(total, 'record'),
    `agent ${rating(latest?.avgRating ?? null)} / user ${rating(latest?.avgUserRating ?? null)}`,
    `reviewed ${reviewed} of ${total} (${share})`,
    `gap ${gap === null ? NO_DATA : `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}`}`,
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// Record row
// ---------------------------------------------------------------------------

/** `2026-09-08 14:03` in UTC — the same basis every other analytics figure uses (BR-16). */
export function recordDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return NO_DATA;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)}`;
}

/** Who submitted it, resolved through the members list when the workspace exposes one. */
export function recordWho(record: FeedbackRecord, members: ReadonlyArray<{ userId: string; label: string }>): string {
  const resolved = record.userId === null ? null : (members.find((m) => m.userId === record.userId)?.label ?? null);
  return resolved ?? record.userEmail ?? record.userId ?? 'Unattributed';
}

/** `agent 4 → user 2`; a missing side is the dash, never a zero. */
export function ratingPair(record: FeedbackRecord): string {
  const agent = record.overallRating === null ? NO_DATA : String(record.overallRating);
  const user = record.userRating === null ? NO_DATA : String(record.userRating);
  return `agent ${agent} → user ${user}`;
}

export function reviewTone(status: FeedbackReviewStatus): ChipTone {
  if (status === 'confirmed') return 'completed';
  if (status === 'amended') return 'partial';
  return 'default';
}

/** `3 tool · 1 session · 2 asks` — a zero carries no information, so it is omitted. */
export function countChips(record: FeedbackRecord): string[] {
  const chips: string[] = [];
  if (record.perToolIssues.length > 0) chips.push(`${record.perToolIssues.length} tool`);
  if (record.sessionIssues.length > 0) chips.push(`${record.sessionIssues.length} session`);
  if (record.missingCapabilities.length > 0) chips.push(`${record.missingCapabilities.length} asks`);
  if (record.misleadingMetadata.length > 0) chips.push(`${record.misleadingMetadata.length} metadata`);
  return chips;
}

// ---------------------------------------------------------------------------
// Pagination + empty state
// ---------------------------------------------------------------------------

/** `1–25 of 312`; an empty page has no range to state. */
export function pageRange(page: { page: number; limit: number; total: number }): string {
  if (page.total === 0) return '0 records';
  const first = (page.page - 1) * page.limit + 1;
  return `${first}–${Math.min(page.total, first + page.limit - 1)} of ${page.total}`;
}

export function hasNextPage(page: { page: number; limit: number; total: number }): boolean {
  return page.page * page.limit < page.total;
}

/**
 * Names the filters actually narrowing the read, so an empty list says which knob
 * to loosen instead of claiming there is no feedback at all. Null when nothing is set.
 */
export function activeFilterSummary(filter: FeedbackRecordsFilter, memberName: string | null): string | null {
  const parts: string[] = [];
  if (filter.area !== null) parts.push(SESSION_AREA_LABELS[filter.area]);
  if (filter.mine) parts.push('only mine');
  if (filter.userId !== null) parts.push(memberName ?? filter.userId);
  return parts.length === 0 ? null : parts.join(' · ');
}
