/**
 * Observability Manager — desktop MAIN-process IPC surface for cloud
 * observability dashboards (`observability:*`): read cloud metrics/sessions for
 * the Analytics views, and open the web dashboard externally. Deliberately
 * separate from telemetry-manager.ts (the PostHog product-analytics adapter).
 *
 * Every handler returns the repo's standard `{ success, data?, error? }`
 * envelope; a failed cloud read fails the whole snapshot (one renderer loading
 * state).
 */

import { shell, type IpcMain } from 'electron';
import { validateAnalyticsWindow } from './analytics-window.js';
import { BUNDLED_COREDOC_WEB_URL } from './build-env.js';
import { getFeedbackRecords, getUsageAnalytics } from './server-api.js';
import {
  IpcChannels,
  type FeedbackIssueType,
  type FeedbackMisleadingMetadata,
  type FeedbackMissingCapability,
  type FeedbackRecord,
  type FeedbackRecordsFilter,
  type FeedbackRecordsPage,
  type FeedbackReviewStatus,
  type FeedbackReviewSummary,
  type FeedbackRoadmap,
  type FeedbackSessionIssue,
  type FeedbackSessionIssueArea,
  type FeedbackSessionIssueType,
  type FeedbackToolIssue,
  type SpendPoint,
  type TimeseriesPoint,
  type UsageAdoption,
  type UsageCounter,
  type UsageMemberRow,
  type UsageToolRow,
  type WorkspaceUsageAnalytics,
  FeedbackSort,
  MAX_ANALYTICS_DAYS,
  SortOrder,
} from '../shared/ipc-types.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Usage analytics trust boundary
// ---------------------------------------------------------------------------
// The validators below intentionally duplicate the small helper set in
// delivery-manager.ts rather than sharing one module: each boundary owns its
// own refusal message, and a shared helper would have to carry the message as a
// parameter for no observable gain (Rule of Three — two call sites).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UTC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MONTH_RE = /^\d{4}-\d{2}$/;
// Both halves of the widest window, one point per UTC day, plus a leap day.
const MAX_SERIES_POINTS = 2 * 366;
const MAX_TOOL_ROWS = 200;
const MAX_MEMBER_ROWS = 500;
const MAX_FEEDBACK_ROWS = 100;
const FEEDBACK_ISSUE_TYPES = [
  'noise',
  'incomplete',
  'wrong',
  'misleading_description',
  'slow',
] as const satisfies readonly FeedbackIssueType[];
const FEEDBACK_SESSION_AREAS = [
  'workflow-routing',
  'skill-instructions',
  'task-context',
  'mcp-transport',
  'agent-behavior',
  'host-environment',
  'capture',
  'other',
] as const satisfies readonly FeedbackSessionIssueArea[];
const FEEDBACK_SESSION_ISSUE_TYPES = [
  'confusing',
  'missing',
  'wrong',
  'blocked',
  'slow',
  'hallucination',
  'missing_context',
] as const satisfies readonly FeedbackSessionIssueType[];
const FEEDBACK_REVIEW_STATUSES = [
  'unreviewed',
  'confirmed',
  'amended',
] as const satisfies readonly FeedbackReviewStatus[];
const FEEDBACK_SORTS = Object.values(FeedbackSort);
const FEEDBACK_ORDERS = Object.values(SortOrder);

// Records-read bounds. The page itself is capped at the server's max limit, and
// every nested list inside a record at a length no honest submission reaches, so
// one hostile row cannot hand the renderer an unbounded array to render.
const MAX_RECORDS_PER_PAGE = 100;
const MAX_RECORD_ISSUES = 50;
const MAX_RECORD_TEXT = 2_000;
const MAX_TOOL_NAME = 128;
const MAX_MEMBER_ID = 128;

function invalid(): never {
  // One message for every read this boundary owns (usage aggregate and feedback
  // records): they share the validator set, so they share the refusal.
  throw new TypeError('Invalid observability response');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum = 4_096): string {
  if (typeof value !== 'string' || value.length > maximum) invalid();
  return value as string;
}

function nullableBoundedString(value: unknown, maximum: number): string | null {
  return value === null ? null : string(value, maximum);
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid();
  return value;
}

function nullableFiniteNumber(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): number | null {
  return value === null ? null : finiteNumber(value, minimum, maximum);
}

/** A rate the server derives from a ratio: outside [0,1] the two sides disagree. */
function rate(value: unknown): number {
  return finiteNumber(value, 0, 1);
}

function nullableRate(value: unknown): number | null {
  return value === null ? null : rate(value);
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}

function matching(value: unknown, pattern: RegExp): string {
  const candidate = string(value);
  if (!pattern.test(candidate)) invalid();
  return candidate;
}

/**
 * `Date` rolls out-of-range components over (2026-02-30 parses as 2026-03-02),
 * so the regex alone would accept a date that does not exist. Compare the
 * claimed calendar fields against the instant they produce.
 */
function assertCalendarDate(candidate: string): void {
  const year = Number(candidate.slice(0, 4));
  const month = Number(candidate.slice(5, 7));
  const day = Number(candidate.slice(8, 10));
  const rolled = new Date(Date.UTC(year, month - 1, day));
  if (rolled.getUTCFullYear() !== year || rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) {
    invalid();
  }
}

function timestamp(value: unknown): string {
  const candidate = matching(value, ISO_TIMESTAMP_RE);
  assertCalendarDate(candidate);
  const hour = Number(candidate.slice(11, 13));
  const minute = Number(candidate.slice(14, 16));
  const second = Number(candidate.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(candidate))) invalid();
  return candidate;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

/** A UTC day bucket key (`YYYY-MM-DD`) — the series grain, not an instant. */
function utcDay(value: unknown): string {
  const candidate = matching(value, UTC_DAY_RE);
  assertCalendarDate(candidate);
  return candidate;
}

function member<T extends string>(value: unknown, values: readonly T[]): T {
  const candidate = string(value);
  if (!values.includes(candidate as T)) invalid();
  return candidate as T;
}

function projectCounter(value: unknown): UsageCounter {
  const counter = object(value);
  return { current: integer(counter.current), previous: integer(counter.previous) };
}

function projectTimeseriesPoint(value: unknown): TimeseriesPoint {
  const point = object(value);
  return { date: utcDay(point.date), value: finiteNumber(point.value) };
}

function projectSpendPoint(value: unknown): SpendPoint {
  const point = object(value);
  return {
    date: utcDay(point.date),
    value: nullableFiniteNumber(point.value),
    unpricedSessions: integer(point.unpricedSessions),
    sessionsWithoutUsage: integer(point.sessionsWithoutUsage),
  };
}

function projectToolRow(value: unknown): UsageToolRow {
  const tool = object(value);
  return {
    toolName: string(tool.toolName, 128),
    calls: integer(tool.calls),
    errorRate: rate(tool.errorRate),
    avgMs: finiteNumber(tool.avgMs),
    emptyRate: nullableRate(tool.emptyRate),
    classifiedCalls: integer(tool.classifiedCalls),
  };
}

function projectAdoption(value: unknown): UsageAdoption {
  const adoption = object(value);
  return {
    developersUsingCoredoc: integer(adoption.developersUsingCoredoc),
    developersActive: integer(adoption.developersActive),
    totalCoredocCalls: integer(adoption.totalCoredocCalls),
    coredocSuccessRate: nullableRate(adoption.coredocSuccessRate),
    avgCallLatencyMs: nullableFiniteNumber(adoption.avgCallLatencyMs),
    medianTokensPerSession: nullableFiniteNumber(adoption.medianTokensPerSession),
  };
}

function projectMemberRow(value: unknown): UsageMemberRow {
  const row = object(value);
  return {
    userId: nullableBoundedString(row.userId, 128),
    userEmail: nullableBoundedString(row.userEmail, 320),
    displayName: nullableBoundedString(row.displayName, 256),
    sessions: integer(row.sessions),
    tokens: integer(row.tokens),
    estimatedCostUsd: nullableFiniteNumber(row.estimatedCostUsd),
    unpricedSessions: integer(row.unpricedSessions),
    coredocCalls: integer(row.coredocCalls),
    topTool: nullableBoundedString(row.topTool, 128),
    lastActiveAt: nullableTimestamp(row.lastActiveAt),
  };
}

function projectFeedback(value: unknown): FeedbackRoadmap {
  const feedback = object(value);
  return {
    feedbackCount: integer(feedback.feedbackCount),
    topIssues: list(feedback.topIssues, MAX_FEEDBACK_ROWS).map((entry) => {
      const issue = object(entry);
      return {
        tool: string(issue.tool, 128),
        issueType: member(issue.issueType, FEEDBACK_ISSUE_TYPES),
        count: integer(issue.count),
        severityScore: finiteNumber(issue.severityScore),
      };
    }),
    // The session-scope fields arrived with the feedback widening; a server
    // that predates it omits them, which is an older server, not a hostile
    // payload. Present-but-malformed still fails the envelope.
    topSessionIssues: list(feedback.topSessionIssues ?? [], MAX_FEEDBACK_ROWS).map((entry) => {
      const issue = object(entry);
      return {
        area: member(issue.area, FEEDBACK_SESSION_AREAS),
        issueType: member(issue.issueType, FEEDBACK_SESSION_ISSUE_TYPES),
        count: integer(issue.count),
        severityScore: finiteNumber(issue.severityScore),
      };
    }),
    topMissingTools: list(feedback.topMissingTools, MAX_FEEDBACK_ROWS).map((entry) => {
      const need = object(entry);
      return { need: string(need.need, 512), count: integer(need.count) };
    }),
    ratingTrend: list(feedback.ratingTrend, MAX_FEEDBACK_ROWS).map((entry) => {
      const point = object(entry);
      return {
        month: matching(point.month, UTC_MONTH_RE),
        // Null when the month holds only user-reviewed sessions with no agent
        // self-rating — an absent measurement, not a zero.
        avgRating: nullableFiniteNumber(point.avgRating),
        count: integer(point.count),
        avgUserRating: nullableFiniteNumber(point.avgUserRating ?? null),
        userCount: integer(point.userCount ?? 0),
      };
    }),
    reviews: projectReviews(feedback.reviews),
  };
}

function projectReviews(value: unknown): FeedbackReviewSummary {
  if (value === undefined) {
    return { unreviewed: 0, confirmed: 0, amended: 0, avgSelfAssessmentGap: null, gapCount: 0 };
  }
  const reviews = object(value);
  return {
    unreviewed: integer(reviews.unreviewed),
    confirmed: integer(reviews.confirmed),
    amended: integer(reviews.amended),
    avgSelfAssessmentGap: nullableFiniteNumber(reviews.avgSelfAssessmentGap, -4, 4),
    gapCount: integer(reviews.gapCount),
  };
}

/**
 * Optional on the server (`exampleQuery?`), always present across IPC: an absent
 * field is projected to null so the renderer has one shape to read.
 */
function optionalText(value: unknown, maximum = MAX_RECORD_TEXT): string | null {
  return value === undefined || value === null ? null : string(value, maximum);
}

function projectToolIssue(value: unknown): FeedbackToolIssue {
  const issue = object(value);
  return {
    tool: string(issue.tool, MAX_TOOL_NAME),
    issueType: member(issue.issueType, FEEDBACK_ISSUE_TYPES),
    severity: integer(issue.severity, 1, 5),
    description: string(issue.description, MAX_RECORD_TEXT),
    exampleQuery: optionalText(issue.exampleQuery),
  };
}

function projectSessionIssue(value: unknown): FeedbackSessionIssue {
  const issue = object(value);
  return {
    area: member(issue.area, FEEDBACK_SESSION_AREAS),
    issueType: member(issue.issueType, FEEDBACK_SESSION_ISSUE_TYPES),
    severity: integer(issue.severity, 1, 5),
    description: string(issue.description, MAX_RECORD_TEXT),
    skill: optionalText(issue.skill, MAX_TOOL_NAME),
    stageId: optionalText(issue.stageId, MAX_TOOL_NAME),
    exampleRedacted: optionalText(issue.exampleRedacted),
  };
}

function projectMissingCapability(value: unknown): FeedbackMissingCapability {
  const capability = object(value);
  return { need: string(capability.need, MAX_RECORD_TEXT), useCase: optionalText(capability.useCase) };
}

function projectMisleadingMetadata(value: unknown): FeedbackMisleadingMetadata {
  const entry = object(value);
  return { toolOrAttr: string(entry.toolOrAttr, MAX_TOOL_NAME), why: string(entry.why, MAX_RECORD_TEXT) };
}

function projectFeedbackRecord(value: unknown): FeedbackRecord {
  const record = object(value);
  return {
    id: string(record.id, MAX_MEMBER_ID),
    createdAt: timestamp(record.createdAt),
    userId: nullableBoundedString(record.userId, MAX_MEMBER_ID),
    userEmail: nullableBoundedString(record.userEmail, 320),
    sessionId: nullableBoundedString(record.sessionId, MAX_MEMBER_ID),
    runId: nullableBoundedString(record.runId, MAX_MEMBER_ID),
    repoKey: nullableBoundedString(record.repoKey, 256),
    overallRating: record.overallRating === null ? null : integer(record.overallRating, 1, 5),
    userRating: record.userRating === null ? null : integer(record.userRating, 1, 5),
    reviewStatus: member(record.reviewStatus, FEEDBACK_REVIEW_STATUSES),
    summary: nullableBoundedString(record.summary, MAX_RECORD_TEXT),
    userNotes: nullableBoundedString(record.userNotes, MAX_RECORD_TEXT),
    perToolIssues: list(record.perToolIssues, MAX_RECORD_ISSUES).map(projectToolIssue),
    sessionIssues: list(record.sessionIssues, MAX_RECORD_ISSUES).map(projectSessionIssue),
    missingCapabilities: list(record.missingCapabilities, MAX_RECORD_ISSUES).map(projectMissingCapability),
    misleadingMetadata: list(record.misleadingMetadata, MAX_RECORD_ISSUES).map(projectMisleadingMetadata),
  };
}

/** Trust boundary for the records page — same contract as `projectUsageAnalytics`. */
export function projectFeedbackRecords(value: unknown): FeedbackRecordsPage {
  const page = object(value);
  const window = object(page.window);
  return {
    items: list(page.items, MAX_RECORDS_PER_PAGE).map(projectFeedbackRecord),
    page: integer(page.page, 1),
    limit: integer(page.limit, 1, MAX_RECORDS_PER_PAGE),
    total: integer(page.total),
    window: {
      days: integer(window.days, 1, MAX_ANALYTICS_DAYS),
      since: timestamp(window.since),
      until: timestamp(window.until),
    },
  };
}

/**
 * Trust boundary for the records *request*. Nothing is clamped: a malformed knob
 * is a renderer bug, and answering it would silently pick a scope or a page the
 * user never asked for. `mine` is sugar for the caller's own id, so it is
 * mutually exclusive with `userId` (same rule as delivery-manager's memberFilter).
 */
export function validateFeedbackRecordsFilter(raw: unknown): FeedbackRecordsFilter {
  const filter = object(raw);
  if (typeof filter.mine !== 'boolean') invalid();
  const userId = filter.userId === null ? null : string(filter.userId, MAX_MEMBER_ID);
  if (userId !== null && (userId.length === 0 || filter.mine)) invalid();
  return {
    area: filter.area === null ? null : member(filter.area, FEEDBACK_SESSION_AREAS),
    userId,
    mine: filter.mine,
    sort: member(filter.sort, FEEDBACK_SORTS),
    order: member(filter.order, FEEDBACK_ORDERS),
    page: integer(filter.page, 1),
    limit: integer(filter.limit, 1, MAX_RECORDS_PER_PAGE),
  };
}

/**
 * Trust boundary for the usage aggregate: only bounded, well-typed fields cross
 * IPC, so a malformed or hostile payload fails the envelope instead of reaching
 * the renderer half-rendered. Mirrors the delivery-manager projector pattern.
 */
export function projectUsageAnalytics(value: unknown): WorkspaceUsageAnalytics {
  const analytics = object(value);
  const window = object(analytics.window);
  const priceMap = object(analytics.priceMap);
  const kpis = object(analytics.kpis);
  const developers = object(kpis.developers);
  const spend = object(kpis.spend);
  const series = object(analytics.series);
  return {
    window: {
      days: integer(window.days, 1, MAX_ANALYTICS_DAYS),
      since: timestamp(window.since),
      until: timestamp(window.until),
      previousSince: timestamp(window.previousSince),
    },
    priceMap: { version: string(priceMap.version, 64), basis: string(priceMap.basis, 128) },
    kpis: {
      mcpCalls: projectCounter(kpis.mcpCalls),
      sessions: projectCounter(kpis.sessions),
      developers: { current: integer(developers.current), usingCoredoc: integer(developers.usingCoredoc) },
      spend: {
        currentUsd: nullableFiniteNumber(spend.currentUsd),
        previousUsd: nullableFiniteNumber(spend.previousUsd),
        unpricedSessions: integer(spend.unpricedSessions),
        sessionsWithoutUsage: integer(spend.sessionsWithoutUsage),
      },
    },
    series: {
      mcpCalls: list(series.mcpCalls, MAX_SERIES_POINTS).map(projectTimeseriesPoint),
      sessions: list(series.sessions, MAX_SERIES_POINTS).map(projectTimeseriesPoint),
      spendUsd: list(series.spendUsd, MAX_SERIES_POINTS).map(projectSpendPoint),
    },
    tools: list(analytics.tools, MAX_TOOL_ROWS).map(projectToolRow),
    adoption: projectAdoption(analytics.adoption),
    members: list(analytics.members, MAX_MEMBER_ROWS).map(projectMemberRow),
    feedback: projectFeedback(analytics.feedback),
  };
}

/**
 * Resolve the cloud web dashboard base URL: runtime env wins over the build-time
 * bundled default; `null` when neither is set. Unset is a documented safe
 * fallback — the observability dashboard link simply hides, it is not an error.
 */
export function resolveWebUrl(): string | null {
  return process.env.COREDOC_WEB_URL?.trim() || BUNDLED_COREDOC_WEB_URL || null;
}

export function registerObservabilityHandlers(ipcMain: IpcMain): void {
  // One aggregate read per (workspace, window) for the Analytics Usage view. The
  // payload is projected before it crosses IPC — nothing partial reaches the
  // renderer when the server answers with a malformed shape.
  ipcMain.handle(
    IpcChannels.OBSERVABILITY_GET_USAGE_ANALYTICS,
    async (
      _event,
      workspaceId: unknown,
      window: unknown,
    ): Promise<{ success: boolean; data?: WorkspaceUsageAnalytics; error?: string }> => {
      try {
        const read = await getUsageAnalytics(matching(workspaceId, UUID_RE), validateAnalyticsWindow(window));
        return { success: true, data: projectUsageAnalytics(read) };
      } catch (err) {
        return { success: false, error: message(err) };
      }
    },
  );

  // Open the cloud web dashboard externally. The URL is composed in main from
  // the trusted base — the renderer only supplies the workspace slug, never a
  // full URL — so a compromised renderer cannot redirect the browser off-origin.
  ipcMain.handle(
    IpcChannels.OBSERVABILITY_OPEN_DASHBOARD,
    async (_event, workspaceSlug: string): Promise<{ success: boolean; error?: string }> => {
      const webUrl = resolveWebUrl();
      if (!webUrl) return { success: false, error: 'Web dashboard URL is not configured.' };
      try {
        await shell.openExternal(`${webUrl}/w/${workspaceSlug}/dashboards`);
        return { success: true };
      } catch (err) {
        return { success: false, error: message(err) };
      }
    },
  );

  // The paged records behind the roadmap aggregates. Both the request knobs and
  // the response cross a projector, so neither a hostile renderer nor a hostile
  // server reaches the other half-validated.
  ipcMain.handle(
    IpcChannels.OBSERVABILITY_GET_FEEDBACK_RECORDS,
    async (
      _event,
      workspaceId: unknown,
      window: unknown,
      filter: unknown,
    ): Promise<{ success: boolean; data?: FeedbackRecordsPage; error?: string }> => {
      try {
        const read = await getFeedbackRecords(
          matching(workspaceId, UUID_RE),
          validateAnalyticsWindow(window),
          validateFeedbackRecordsFilter(filter),
        );
        return { success: true, data: projectFeedbackRecords(read) };
      } catch (err) {
        return { success: false, error: message(err) };
      }
    },
  );
}
