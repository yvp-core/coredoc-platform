/**
 * Analytics wire contract — the Usage and Delivery v2 response DTOs the web app
 * and the desktop app both read. Mirrors the server contracts
 * (`apps/server/src/modules/analytics/usage-analytics.contract.ts` and
 * `modules/delivery/canonical-delivery-read.contract.ts`) 1:1.
 *
 * Browser-safe like everything under `src/browser/`: no imports, no node APIs,
 * no zod, so a renderer or SPA bundle can value-import it by subpath
 * (`@coredoc/core/browser/analytics`). The package root is NOT browser-safe.
 */

/**
 * Time window shared by the Usage and Delivery views: either one of the day
 * presets or an explicit UTC calendar range. Mirrors the server contract — the
 * reads accept `days=N` or `since=YYYY-MM-DD&until=YYYY-MM-DD`.
 */
export enum AnalyticsWindowKind {
  Days = 'days',
  Custom = 'custom',
}

export type AnalyticsWindow =
  | { kind: AnalyticsWindowKind.Days; days: number }
  /** `since`/`until` are inclusive UTC calendar days, `YYYY-MM-DD`. */
  | { kind: AnalyticsWindowKind.Custom; since: string; until: string };

/** The server's clamp for every analytics read, presets included (LIM-4). */
export const MAX_ANALYTICS_DAYS = 90;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface TimeseriesPoint {
  date: string;
  value: number;
}

/** One UTC-day-aligned window basis shared by every card on the Usage view. */
export interface UsageWindow {
  days: number;
  since: string;
  until: string;
  previousSince: string;
}

/** Current window against the preceding window of equal length. */
export interface UsageCounter {
  current: number;
  previous: number;
}

/** Price-map estimate with explicit unpriced counters. */
export interface UsageSpend {
  currentUsd: number | null;
  previousUsd: number | null;
  unpricedSessions: number;
  sessionsWithoutUsage: number;
}

export interface UsageDevelopers {
  current: number;
  usingCoredoc: number;
}

/** One MCP tool's call quality. `emptyRate` is null when no calls were classified. */
export interface UsageToolRow {
  toolName: string;
  calls: number;
  errorRate: number;
  avgMs: number;
  emptyRate: number | null;
  classifiedCalls: number;
}

export interface UsageAdoption {
  developersUsingCoredoc: number;
  developersActive: number;
  totalCoredocCalls: number;
  coredocSuccessRate: number | null;
  avgCallLatencyMs: number | null;
  medianTokensPerSession: number | null;
}

/** Adoption reach per member — Usage view only (delivery aggregates stay blameless). */
export interface UsageMemberRow {
  userId: string | null;
  userEmail: string | null;
  displayName: string | null;
  sessions: number;
  tokens: number;
  estimatedCostUsd: number | null;
  unpricedSessions: number;
  coredocCalls: number;
  topTool: string | null;
  lastActiveAt: string | null;
}

/** A day with sessions but no priced spend is `null`, never 0. */
export interface SpendPoint {
  date: string;
  value: number | null;
  unpricedSessions: number;
  sessionsWithoutUsage: number;
}

export type FeedbackIssueType = 'noise' | 'incomplete' | 'wrong' | 'misleading_description' | 'slow';

export interface FeedbackRankedIssue {
  tool: string;
  issueType: FeedbackIssueType;
  count: number;
  severityScore: number;
}

export interface FeedbackRankedNeed {
  need: string;
  count: number;
}

export type FeedbackSessionIssueArea =
  | 'workflow-routing'
  | 'skill-instructions'
  | 'task-context'
  | 'mcp-transport'
  | 'agent-behavior'
  | 'host-environment'
  | 'capture'
  | 'other';

export type FeedbackSessionIssueType =
  | 'confusing'
  | 'missing'
  | 'wrong'
  | 'blocked'
  | 'slow'
  | 'hallucination'
  | 'missing_context';

/** A non-tool problem with the session, ranked by area. */
export interface FeedbackRankedSessionIssue {
  area: FeedbackSessionIssueArea;
  issueType: FeedbackSessionIssueType;
  count: number;
  severityScore: number;
}

/** How many agent drafts a user actually reviewed, and how far the two ratings sit apart. */
export interface FeedbackReviewSummary {
  unreviewed: number;
  confirmed: number;
  amended: number;
  /** Mean agent-minus-user rating; positive means the agent over-rated itself. */
  avgSelfAssessmentGap: number | null;
  gapCount: number;
}

export interface FeedbackRatingTrendPoint {
  month: string;
  /** Mean agent self-rating; null when the month has only user ratings. */
  avgRating: number | null;
  count: number;
  avgUserRating: number | null;
  userCount: number;
}

export interface FeedbackRoadmap {
  feedbackCount: number;
  topIssues: FeedbackRankedIssue[];
  topSessionIssues: FeedbackRankedSessionIssue[];
  topMissingTools: FeedbackRankedNeed[];
  ratingTrend: FeedbackRatingTrendPoint[];
  reviews: FeedbackReviewSummary;
}

// ---------------------------------------------------------------------------
// Feedback records (`GET /mcp-feedback/records`)
// ---------------------------------------------------------------------------

export type FeedbackReviewStatus = 'unreviewed' | 'confirmed' | 'amended';

export interface FeedbackToolIssue {
  tool: string;
  issueType: FeedbackIssueType;
  /** 1..5 */
  severity: number;
  description: string;
  exampleQuery?: string;
}

export interface FeedbackSessionIssue {
  area: FeedbackSessionIssueArea;
  issueType: FeedbackSessionIssueType;
  /** 1..5 */
  severity: number;
  description: string;
  skill?: string;
  stageId?: string;
  exampleRedacted?: string;
}

export interface FeedbackMissingCapability {
  need: string;
  useCase?: string;
}

export interface FeedbackMisleadingMetadata {
  toolOrAttr: string;
  why: string;
}

/** One submitted record — the agent draft plus whatever the user amended. */
export interface FeedbackRecord {
  id: string;
  createdAt: string;
  userId: string | null;
  userEmail: string | null;
  sessionId: string | null;
  runId: string | null;
  repoKey: string | null;
  overallRating: number | null;
  userRating: number | null;
  reviewStatus: FeedbackReviewStatus;
  summary: string | null;
  userNotes: string | null;
  perToolIssues: FeedbackToolIssue[];
  sessionIssues: FeedbackSessionIssue[];
  missingCapabilities: FeedbackMissingCapability[];
  misleadingMetadata: FeedbackMisleadingMetadata[];
}

export interface FeedbackRecordsPage {
  items: FeedbackRecord[];
  page: number;
  limit: number;
  total: number;
  window: { days: number; since: string; until: string };
}

export enum FeedbackSort {
  CreatedAt = 'createdAt',
  OverallRating = 'overallRating',
  UserRating = 'userRating',
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

/**
 * Every filter the records read accepts, AND-ed by the server. `mine` and
 * `userId` are mutually exclusive on the wire (the server 400s on both).
 */
export interface FeedbackRecordsFilter {
  area: FeedbackSessionIssueArea | null;
  userId: string | null;
  mine: boolean;
  sort: FeedbackSort;
  order: SortOrder;
  page: number;
  limit: number;
}

/** `GET /analytics/usage` response. */
export interface WorkspaceUsageAnalytics {
  window: UsageWindow;
  priceMap: { version: string; basis: string };
  kpis: { mcpCalls: UsageCounter; sessions: UsageCounter; developers: UsageDevelopers; spend: UsageSpend };
  /** current window only, one point per UTC day, oldest first */
  series: { mcpCalls: TimeseriesPoint[]; sessions: TimeseriesPoint[]; spendUsd: SpendPoint[] };
  /** ordered by calls desc */
  tools: UsageToolRow[];
  adoption: UsageAdoption;
  /** ordered by coredocCalls desc, then email */
  members: UsageMemberRow[];
  feedback: FeedbackRoadmap;
}

// ---------------------------------------------------------------------------
// Delivery v2
// ---------------------------------------------------------------------------

export type CanonicalDeliveryLifecycle = 'active' | 'completed' | 'abandoned';
export type CanonicalDeliveryOutcome = 'success' | 'failed' | 'blocked' | 'abandoned';
export type CanonicalWorkflowOutcome = CanonicalDeliveryOutcome | 'unknown';
export type CanonicalArtifactKind = 'spec' | 'design' | 'implementation_issue';
export type CanonicalArtifactCheckpoint = 'run-finish' | 'session-end' | 'session-start-reconcile';

export type CanonicalAuthority =
  | { kind: 'coredoc' }
  | {
      kind: 'external_ref';
      externalRefId: string;
      provider: string;
      externalId: string;
      externalKey: string | null;
      connected: boolean;
      /** Tracker-issue creation instant; null for refs never observed with one. */
      sourceCreatedAt: string | null;
    };

export interface CanonicalTaskCounts {
  externalRefs: number;
  workflowRuns: number;
  codeChanges: number;
  shipEvidence: number;
  reworkSignals: number;
  artifacts: number;
  /** Linked code changes that merged; `open` includes drafts. */
  mergedCodeChanges: number;
  openCodeChanges: number;
}

/**
 * Ship completeness of a task: `shipped` = ship evidence with no open linked code
 * change, `partial` = ship evidence with at least one still open (a draft PR
 * counts as open, a closed-without-merge PR does not).
 */
export type CanonicalShipState = 'none' | 'partial' | 'shipped';

export interface CanonicalTaskSummary {
  id: string;
  /** Jira summary (authority) or PR-title fallback; null for pre-title rows. */
  title: string | null;
  repositoryKey: string | null;
  lifecycle: CanonicalDeliveryLifecycle;
  authority: CanonicalAuthority;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  everShipped: boolean;
  lastShippedAt: string | null;
  shipState: CanonicalShipState;
  counts: CanonicalTaskCounts;
}

export interface CanonicalTaskDetail extends CanonicalTaskSummary {
  fineEventRetention: {
    policyDays: 90;
    purgedThroughReceivedAt: string | null;
  };
  /** Session cost rollup joined via the task's workflow runs. */
  estimatedCost: {
    totalUsd: number | null;
    sessions: number;
    unpricedSessions: number;
    /** Sessions with no usage telemetry at all — distinct from `unpricedSessions`. */
    sessionsWithoutUsage: number;
  };
}

export interface CanonicalTaskSummariesResponse {
  tasks: CanonicalTaskSummary[];
  nextCursor: string | null;
}

export interface CanonicalCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type DeliveryLifecycleFilter = 'all' | 'shipped' | 'active' | 'rework' | 'runs';

/** `value` is null when the sample is empty. */
export interface SampledMedian {
  value: number | null;
  sampleSize: number;
}

export interface DeliveryStageMedian {
  stageId: string;
  claimedMs: SampledMedian;
  /** Occurrences started whose stage finish never arrived within the staleness window. */
  incomplete: number;
  /** Occurrences started, still unfinished, young enough that the finish may still arrive. */
  inProgress: number;
}

/**
 * The three counted rework sources, always all present and zero-filled in a
 * stable order. Stage re-entries are deliberately not one of them: an
 * `attempt > 1` occurrence is an iteration fact, not rework.
 */
export type CanonicalReworkSourceKind = 'tracker_reopened' | 'review_changes_requested' | 'review_commented';

export interface DeliveryReworkBySource {
  kind: CanonicalReworkSourceKind;
  signals: number;
  tasks: number;
}

/** `GET /delivery/v2/summary` response. */
export interface CanonicalDeliverySummary {
  window: {
    days: number;
    since: string;
    until: string;
    lifecycle: DeliveryLifecycleFilter;
    /** The resolved member the read was scoped to; null = the whole workspace. */
    userId: string | null;
  };
  tasks: { matching: number; shipped: number; partiallyShipped: number; withRework: number; active: number };
  leadTimeMs: SampledMedian;
  reviewStageMs: SampledMedian;
  costPerShippedTaskUsd: SampledMedian & { unpricedTasks: number };
  /** stageId order = first seen */
  stages: DeliveryStageMedian[];
  unclaimedMs: SampledMedian;
  reviewWaitMs: SampledMedian;
  editVerifyRoundsPerRun: SampledMedian;
  rework: { bySource: DeliveryReworkBySource[] };
}

export interface CanonicalExternalRefItem {
  id: string;
  provider: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalState: string | null;
  connectorId: string | null;
  sourceUpdatedAt: string | null;
  lastObservedAt: string | null;
  isAuthority: boolean;
  stateFactCount: number;
}

export interface CanonicalExternalRefStateFactItem {
  id: string;
  fromState: string | null;
  toState: string;
  sourceRef: string;
  occurredAt: string;
  sourceUpdatedAt: string;
  receivedAt: string;
  actorId: string | null;
}

export interface CanonicalRunVerification {
  runs: number | null;
  failures: number | null;
  editVerifyRounds: number | null;
}

/** Provider-neutral work-item identity recorded with a workflow run. */
export interface ActivityWorkflowWorkItem {
  provider: string;
  externalId: string;
  externalKey: string | null;
  linked: boolean;
}

export interface CanonicalRunItem {
  runId: string;
  workflowId: string | null;
  intent: string | null;
  risk: string | null;
  scale: string | null;
  repositoryKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: CanonicalWorkflowOutcome | null;
  verification: CanonicalRunVerification | null;
  workItems: ActivityWorkflowWorkItem[];
}

export interface CanonicalStageOccurrenceItem {
  occurrenceId: string;
  runId: string;
  stageId: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: CanonicalDeliveryOutcome | null;
}

export interface CanonicalCodeChangeItem {
  id: string;
  provider: string;
  repoExternalId: string;
  externalId: string;
  number: number | null;
  title: string | null;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  /** PR lifecycle marks; an older server omits them and they read as `null`. */
  createdAtSource: string | null;
  readyForReviewAt: string | null;
  firstReviewAt: string | null;
  approvedAt: string | null;
  mergedAt: string | null;
  updatedAt: string;
  externalUrl: string | null;
  reviewCount: number | null;
  commentCount: number | null;
  associationSource: 'external_ref' | 'issue_key' | 'run_id';
  associationSourceValue: string;
}

export interface CanonicalShipEvidenceItem {
  id: string;
  source: 'github_pr_merged' | 'connector_transition' | 'coredoc';
  sourceKey: string;
  occurredAt: string;
  receivedAt: string;
  actorId: string | null;
  provider: string | null;
  repoExternalId: string | null;
  externalId: string | null;
}

/** `stage_reentry` is legacy: no longer produced, ignored by every rework figure. */
export type CanonicalReworkSignalKind = CanonicalReworkSourceKind | 'stage_reentry';

export interface CanonicalReworkSignalItem {
  id: string;
  kind: CanonicalReworkSignalKind;
  sourceKey: string;
  sourceRef: string;
  occurredAt: string;
  observedAt: string;
}

export interface CanonicalArtifactItem {
  id: string;
  repositoryKey: string;
  kind: CanonicalArtifactKind;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
}

export interface CanonicalArtifactRevision {
  id: string;
  sha256: string;
  byteCount: number;
  checkpoint: CanonicalArtifactCheckpoint;
  runId: string | null;
  createdAt: string;
  markdown: string;
}

export interface CanonicalArtifactRevisionsResponse {
  artifact: { id: string; taskId: string; repositoryKey: string; kind: CanonicalArtifactKind };
  revisions: CanonicalArtifactRevision[];
}
