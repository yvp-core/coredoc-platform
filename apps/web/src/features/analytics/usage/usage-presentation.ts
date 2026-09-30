/**
 * Pure display logic for the Usage view (UC-1/UC-2). Nothing here touches React,
 * the DOM or the clock, so every rule the cards depend on — delta direction,
 * tool pill thresholds, member sort, degrade captions — is unit-testable without
 * a renderer (the desktop suite runs in the vitest `node` environment, LIM-6).
 *
 * The explicit-degrade rules live here too: a null median or rate becomes
 * `NO_DATA` plus a sample caption, never a zero (BR-11, BR-17, ADR-3).
 */

import type {
  FeedbackRecord,
  FeedbackRecordsFilter,
  FeedbackRoadmap,
  SpendPoint,
  TimeseriesPoint,
  UsageAdoption,
  UsageDevelopers,
  UsageMemberRow,
  UsageSpend,
  UsageToolRow,
  UsageWindow,
  WorkspaceUsageAnalytics,
} from '../types.js';
import type { LineChartPoint } from '../charts/LineChart.js';
import { NO_DATA, formatNumber, plural } from '../format.js';

/** The marker a spend figure carries when the price map could not price it (LIM-1). */
export const UNPRICED_MARKER = 'Unpriced';

/** Sign threshold below which a period-over-period move reads as flat (POC: ±0.5%). */
const FLAT_THRESHOLD = 0.005;

/** Ratio above which the delta is rendered as ">999%" instead of an exact figure. */
const DELTA_CAP = 9.99;

function percent(ratio: number, digits: number): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// KPI delta (BR-2)
// ---------------------------------------------------------------------------

/** up-good: calls/sessions. down-good: spend. neutral: developer headcount. */
export type DeltaDirection = 'up-good' | 'down-good' | 'neutral';

export type DeltaPresentation =
  | { kind: 'no-prior' }
  | { kind: 'delta'; sign: -1 | 0 | 1; tone: 'up' | 'down' | 'flat'; text: string };

/**
 * Period-over-period delta against the immediately preceding window of equal
 * length. Rendered only when the previous value is non-zero — a percentage
 * against a zero baseline is not a fact (BR-2).
 *
 * `days` is part of the signature because the rendered text names the window
 * ("vs prev 30d") and the helper must stay clock-free.
 */
export function deltaPresentation(
  current: number | null,
  previous: number | null,
  direction: DeltaDirection,
  days: number,
): DeltaPresentation {
  if (previous === null || previous <= 0 || current === null) return { kind: 'no-prior' };

  const ratio = (current - previous) / previous;
  const sign: -1 | 0 | 1 = ratio >= FLAT_THRESHOLD ? 1 : ratio <= -FLAT_THRESHOLD ? -1 : 0;

  let tone: 'up' | 'down' | 'flat' = 'flat';
  if (sign !== 0 && direction === 'up-good') tone = sign > 0 ? 'up' : 'down';
  if (sign !== 0 && direction === 'down-good') tone = sign < 0 ? 'up' : 'down';

  const glyph = sign > 0 ? '▲' : sign < 0 ? '▼' : '·';
  // Past ~1000% the exact figure is noise and the tile can no longer hold it on one
  // line; the cap keeps the direction and the magnitude class readable.
  const magnitude = Math.abs(ratio) > DELTA_CAP ? '>999%' : percent(Math.abs(ratio), 0);
  return { kind: 'delta', sign, tone, text: `${glyph} ${magnitude} vs prev ${days}d` };
}

// ---------------------------------------------------------------------------
// Tool quality pills (BR-3)
// ---------------------------------------------------------------------------

/** POC thresholds: an error rate at or above 3% is a problem, below it is neutral. */
const ERROR_PILL_THRESHOLD = 0.03;
/** …and an empty-result rate at or above 15% is worth a warning. */
const EMPTY_PILL_THRESHOLD = 0.15;

/** Tool latency is a raw float on the wire; the table states whole milliseconds. */
export function formatMs(avgMs: number): string {
  return `${Math.round(avgMs)} ms`;
}

export interface ToolPills {
  error: { tone: 'danger' | 'ok'; text: string };
  /** `absent` = no classified calls, so there is no empty rate to state (BR-3, AC-3). */
  empty: { tone: 'warn' | 'ok' | 'absent'; text: string };
}

export function toolPills(row: UsageToolRow): ToolPills {
  return {
    error: {
      tone: row.errorRate >= ERROR_PILL_THRESHOLD ? 'danger' : 'ok',
      text: `${percent(row.errorRate, 1)} err`,
    },
    empty:
      row.emptyRate === null
        ? { tone: 'absent', text: '' }
        : {
            tone: row.emptyRate >= EMPTY_PILL_THRESHOLD ? 'warn' : 'ok',
            // One decimal on both pills so the pair reads as one scale (POC parity).
            text: `${percent(row.emptyRate, 1)} empty`,
          },
  };
}

// ---------------------------------------------------------------------------
// Members table sort
// ---------------------------------------------------------------------------

export type MemberSortKey = 'member' | 'sessions' | 'tokens' | 'spend' | 'coredocCalls';

export interface MemberSort {
  key: MemberSortKey;
  /** 1 ascending, -1 descending. */
  dir: 1 | -1;
}

/** The server already orders by Coredoc calls desc; the table opens on that order. */
export const DEFAULT_MEMBER_SORT: MemberSort = { key: 'coredocCalls', dir: -1 };

/** Name falls back through the identity fields the server may not have resolved. */
export function memberDisplayName(row: UsageMemberRow): string {
  return row.displayName ?? row.userEmail ?? row.userId ?? 'Unattributed';
}

/** A null spend sorts below every priced value rather than reading as $0 (BR-11). */
function numericSortValue(row: UsageMemberRow, key: MemberSortKey): number {
  switch (key) {
    case 'sessions':
      return row.sessions;
    case 'tokens':
      return row.tokens;
    case 'spend':
      return row.estimatedCostUsd ?? Number.NEGATIVE_INFINITY;
    default:
      return row.coredocCalls;
  }
}

export function sortMembers(rows: ReadonlyArray<UsageMemberRow>, key: MemberSortKey, dir: 1 | -1): UsageMemberRow[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((a, b) => {
    const compared =
      key === 'member'
        ? memberDisplayName(a.row).localeCompare(memberDisplayName(b.row))
        : numericSortValue(a.row, key) - numericSortValue(b.row, key);
    // Index tiebreak keeps the server order (calls desc, then email) stable.
    return compared === 0 ? a.index - b.index : dir * compared;
  });
  return indexed.map((entry) => entry.row);
}

/** Clicking the active column flips it; a new column opens desc, except the name (asc). */
export function nextMemberSort(current: MemberSort, key: MemberSortKey): MemberSort {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  return { key, dir: key === 'member' ? 1 : -1 };
}

// ---------------------------------------------------------------------------
// Degrade captions
// ---------------------------------------------------------------------------

/** Names the sessions the spend estimate could not cover; null when it covered all (LIM-1). */
export function spendCaption(spend: UsageSpend): string | null {
  const parts: string[] = [];
  if (spend.unpricedSessions > 0) parts.push(`${plural(spend.unpricedSessions, 'session')} unpriced`);
  if (spend.sessionsWithoutUsage > 0) parts.push(`${spend.sessionsWithoutUsage} without usage`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Caption under the spend series. The "gaps, not zeros" reading only applies when a
 * day actually broke the line; when every day is priced, the unpriced sessions are
 * simply excluded from the totals and the caption must not claim gaps that the chart
 * does not show (BR-17, LIM-1).
 *
 * A gap has two distinct causes, and the caption must name whichever is actually
 * present so a viewer can tell missing usage telemetry from an excluded-cost day:
 * `unpricedSessions` (a session ran on a model the price map does not cover) and
 * `sessionsWithoutUsage` (a session carried no usable token data at all).
 */
export function spendSeriesCaption(
  points: ReadonlyArray<SpendPoint>,
  unpricedSessions: number,
  sessionsWithoutUsage = 0,
): string | null {
  if (unpricedSessions <= 0 && sessionsWithoutUsage <= 0) return null;

  const hasGap = points.some((point) => point.value === null);
  const parts: string[] = [];
  if (unpricedSessions > 0) {
    parts.push(`${plural(unpricedSessions, 'session')} ran on a model the price map does not cover`);
  }
  if (sessionsWithoutUsage > 0) {
    parts.push(`${plural(sessionsWithoutUsage, 'session')} reported no usage data at all`);
  }
  const head = `${parts.join(' and ')} in this window;`;
  return hasGap ? `${head} those days are gaps, not zeros.` : `${head} their cost is excluded.`;
}

const UTC_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** "Aug 3 – Sep 1 · UTC" — the one window basis every card on this view shares (BR-16). */
export function windowCaption(window: UsageWindow): string {
  const since = new Date(window.since);
  const until = new Date(window.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return `${window.days}d · UTC`;
  return `${UTC_DAY.format(since)} – ${UTC_DAY.format(until)} · UTC`;
}

/**
 * Sparkline input from a series. A `null` spend day is dropped rather than
 * flattened to zero — the decorative spark has no gap notation, and drawing a
 * zero there would assert a fact the price map does not have (BR-17).
 */
export function sparkFromSeries(points: ReadonlyArray<TimeseriesPoint | SpendPoint>): TimeseriesPoint[] {
  const out: TimeseriesPoint[] = [];
  for (const point of points) {
    if (point.value === null) continue;
    out.push({ date: point.date, value: point.value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeseries metrics
// ---------------------------------------------------------------------------

export type UsageMetric = 'calls' | 'sessions' | 'spend';

export interface UsageMetricDef {
  title: string;
  subtitle: string;
  /** Column header for the "view as table" rendering. */
  column: string;
  points: (usage: WorkspaceUsageAnalytics) => LineChartPoint[];
  format: (value: number) => string;
  axisFormat: (value: number) => string;
}

const INTEGER = new Intl.NumberFormat('en-US');

export const metricDefs: Record<UsageMetric, UsageMetricDef> = {
  calls: {
    title: 'MCP calls per day',
    subtitle: 'Server-observed tool calls, UTC days',
    column: 'MCP calls',
    points: (usage) => usage.series.mcpCalls.map((p) => ({ date: p.date, value: p.value })),
    format: (value) => INTEGER.format(Math.round(value)),
    axisFormat: (value) => formatNumber(value),
  },
  sessions: {
    title: 'Agent sessions per day',
    subtitle: 'Claude Code and Codex sessions, UTC days',
    column: 'Sessions',
    points: (usage) => usage.series.sessions.map((p) => ({ date: p.date, value: p.value })),
    format: (value) => INTEGER.format(Math.round(value)),
    axisFormat: (value) => formatNumber(value),
  },
  spend: {
    title: 'Assistant spend per day',
    subtitle: 'Session cost at current price map, UTC days',
    column: 'Spend',
    // `value: null` survives: a day whose sessions were all unpriced breaks the
    // line instead of dropping to zero (BR-17).
    points: (usage) => usage.series.spendUsd.map((p) => ({ date: p.date, value: p.value })),
    format: (value) => `$${value.toFixed(2)}`,
    axisFormat: (value) => `$${formatNumber(value)}`,
  },
};

export const METRIC_OPTIONS: ReadonlyArray<{ value: UsageMetric; label: string }> = [
  { value: 'calls', label: 'MCP calls' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'spend', label: 'Spend' },
];

// ---------------------------------------------------------------------------
// Adoption facts
// ---------------------------------------------------------------------------

export interface AdoptionFact {
  label: string;
  value: string;
}

export function adoptionFacts(adoption: UsageAdoption): AdoptionFact[] {
  return [
    { label: 'Coredoc calls', value: formatNumber(adoption.totalCoredocCalls) },
    {
      label: 'Call success rate',
      value: adoption.coredocSuccessRate === null ? NO_DATA : percent(adoption.coredocSuccessRate, 1),
    },
    {
      label: 'Avg call latency',
      value: adoption.avgCallLatencyMs === null ? NO_DATA : `${Math.round(adoption.avgCallLatencyMs)} ms`,
    },
    {
      label: 'Median tokens / session',
      value: adoption.medianTokensPerSession === null ? NO_DATA : formatNumber(adoption.medianTokensPerSession),
    },
  ];
}

/** Active-developers hint; the ratio is server-observed on both sides (BR-3). */
export function developersHint(developers: UsageDevelopers): string {
  return `${developers.usingCoredoc} of ${developers.current} use Coredoc`;
}

/**
 * Adoption meter: the share of active developers who called Coredoc in the window. With no
 * active developer there is no share to state — a dash, never 0 % (BR-11).
 */
export function adoptionMeter(adoption: UsageAdoption): { text: string; widthPct: number } {
  if (adoption.developersActive <= 0) return { text: NO_DATA, widthPct: 0 };
  const rate = adoption.developersUsingCoredoc / adoption.developersActive;
  return { text: percent(rate, 0), widthPct: Math.min(100, Math.max(0, rate * 100)) };
}

// ---------------------------------------------------------------------------
// Members / feedback cells
// ---------------------------------------------------------------------------

/** Two-letter disc initials from whatever identity the row carries. */
export function memberInitials(row: UsageMemberRow): string {
  const name = memberDisplayName(row);
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export type MemberSpendPresentation = { kind: 'amount'; text: string } | { kind: 'unpriced' } | { kind: 'unavailable' };

export function memberSpendPresentation(row: UsageMemberRow): MemberSpendPresentation {
  if (row.estimatedCostUsd !== null) return { kind: 'amount', text: `$${row.estimatedCostUsd.toFixed(2)}` };
  if (row.unpricedSessions > 0) return { kind: 'unpriced' };
  return { kind: 'unavailable' };
}

/**
 * Calendar-day relative label against an explicit `now` (never `Date.now()` inside,
 * so the tests stay deterministic).
 */
export function relativeDayLabel(iso: string | null, now: Date): { text: string; isToday: boolean } {
  if (iso === null) return { text: NO_DATA, isToday: false };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { text: NO_DATA, isToday: false };
  const days = calendarDaysBetween(at, now);
  if (days <= 0) return { text: 'today', isToday: true };
  if (days === 1) return { text: 'yesterday', isToday: false };
  return { text: `${days}d ago`, isToday: false };
}

function calendarDaysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

/** `misleading_description` → `misleading description` (POC). */
export function humanizeIssueType(issueType: string): string {
  return issueType.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Session feedback records
// ---------------------------------------------------------------------------

/** "2026-09-08 14:03" — UTC to the minute, the grain the records list reads at. */
export function formatUtcMinute(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return NO_DATA;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)}`;
}

/**
 * Labels the humanized slug would misread. `mcp-transport` is the MCP area as a
 * whole — the server folds tool-only records (submitted before session feedback
 * existed) into it, so the label must not read as "transport only".
 */
const AREA_LABELS: Record<string, string> = { 'mcp-transport': 'MCP tools & transport' };

/** Only areas whose scope is not obvious from the label carry a hint. */
export const AREA_HINTS: Record<string, string> = {
  'mcp-transport': 'tool issues and transport, including records that only report tool issues',
};

/** `workflow-routing` → `Workflow routing`. */
export function humanizeArea(area: string): string {
  const label = AREA_LABELS[area];
  if (label !== undefined) return label;
  const spaced = area.replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The one-line strip above the records list. Every figure degrades to a dash on
 * its own rather than hiding the whole line (BR-11).
 */
export function feedbackStrip(feedback: FeedbackRoadmap): string {
  const latest = feedback.ratingTrend[feedback.ratingTrend.length - 1] ?? null;
  const rating = (value: number | null | undefined) =>
    value === null || value === undefined ? NO_DATA : value.toFixed(1);
  const reviewed = feedback.reviews.confirmed + feedback.reviews.amended;
  const pct = feedback.feedbackCount > 0 ? ` (${Math.round((reviewed / feedback.feedbackCount) * 100)}%)` : '';
  const gap = feedback.reviews.avgSelfAssessmentGap;
  return [
    plural(feedback.feedbackCount, 'record'),
    `agent ${rating(latest?.avgRating)} / user ${rating(latest?.avgUserRating)}`,
    `reviewed ${reviewed} of ${feedback.feedbackCount}${pct}`,
    `gap ${gap === null ? NO_DATA : `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}`}`,
  ].join(' · ');
}

/** Non-zero content counts of one record, as chip labels: "3 tool · 1 session · 2 asks". */
export function recordCountChips(record: FeedbackRecord): string[] {
  const chips: string[] = [];
  if (record.perToolIssues.length > 0) chips.push(`${record.perToolIssues.length} tool`);
  if (record.sessionIssues.length > 0) chips.push(`${record.sessionIssues.length} session`);
  if (record.missingCapabilities.length > 0) chips.push(`${record.missingCapabilities.length} asks`);
  if (record.misleadingMetadata.length > 0) chips.push(`${record.misleadingMetadata.length} metadata`);
  return chips;
}

/** Names the filters an empty page was requested under, so the zero reads as a filter effect. */
export function activeFilterCaption(filter: FeedbackRecordsFilter, memberLabel: string | null): string | null {
  const parts: string[] = [];
  if (filter.area !== null) parts.push(humanizeArea(filter.area));
  if (filter.mine) parts.push('only mine');
  else if (memberLabel !== null) parts.push(memberLabel);
  return parts.length === 0 ? null : parts.join(' · ');
}
