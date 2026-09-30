export type IssueType = 'noise' | 'incomplete' | 'wrong' | 'misleading_description' | 'slow';

export interface FeedbackToolIssue {
  tool: string;
  issueType: IssueType;
  severity: number; // 1..5
  description: string;
  exampleQuery?: string;
}
export interface MissingCapability {
  need: string;
  useCase?: string;
}
export interface MisleadingMetadata {
  toolOrAttr: string;
  why: string;
}

/** Where a non-tool problem lived. Closed so the roadmap can rank it. */
export const SESSION_ISSUE_AREAS = [
  'workflow-routing',
  'skill-instructions',
  'task-context',
  'mcp-transport',
  'agent-behavior',
  'host-environment',
  'capture',
  'other',
] as const;
export type SessionIssueArea = (typeof SESSION_ISSUE_AREAS)[number];

export const SESSION_ISSUE_TYPES = [
  'confusing',
  'missing',
  'wrong',
  'blocked',
  'slow',
  'hallucination',
  'missing_context',
] as const;
export type SessionIssueType = (typeof SESSION_ISSUE_TYPES)[number];

/** A problem with the session that is not about one MCP tool's output. */
export interface SessionIssue {
  area: SessionIssueArea;
  issueType: SessionIssueType;
  severity: number; // 1..5
  description: string;
  /** Plugin skill involved, e.g. `coredoc-implement`, when one was. */
  skill?: string;
  /** Workflow stage id, when the issue belongs to one routed stage. */
  stageId?: string;
  exampleRedacted?: string;
}

/**
 * Whether a human saw the agent's draft before it was submitted. `unreviewed`
 * is the agent's self-assessment alone; `confirmed` means the user accepted it
 * as-is; `amended` means the user added a rating, notes, or both.
 */
export const REVIEW_STATUSES = ['unreviewed', 'confirmed', 'amended'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface SubmitFeedbackInput {
  workspaceId: string;
  userId?: string | null;
  userEmail?: string | null;
  sessionId?: string | null;
  /** Coredoc workflow run this feedback belongs to, when one produced it. */
  runId?: string | null;
  repoKey?: string | null;
  /** The agent's own 1..5 rating of the session. */
  overallRating?: number | null;
  perToolIssues: FeedbackToolIssue[];
  missingCapabilities: MissingCapability[];
  misleadingMetadata: MisleadingMetadata[];
  sessionIssues: SessionIssue[];
  summary?: string | null;
  /** The user's 1..5 rating, given when they reviewed the draft. */
  userRating?: number | null;
  userNotes?: string | null;
  reviewStatus: ReviewStatus;
}

export interface RankedIssue {
  tool: string;
  issueType: IssueType;
  count: number;
  severityScore: number; // sum of severities across reports
}
export interface RankedNeed {
  need: string;
  count: number;
}
export interface RankedSessionIssue {
  area: SessionIssueArea;
  issueType: SessionIssueType;
  count: number;
  severityScore: number; // sum of severities across reports
}
export interface ReviewSummary {
  unreviewed: number;
  confirmed: number;
  amended: number;
  /**
   * Mean of (overallRating - userRating) over records carrying both, so a
   * positive value means the agent rated the session higher than the user did.
   * A `confirmed` record contributes a gap of 0: the user accepted the agent's
   * self-assessment as-is (and by contract carries no userRating of their own).
   * Null until at least one record contributes a gap.
   */
  avgSelfAssessmentGap: number | null;
  gapCount: number;
}
export interface RoadmapView {
  feedbackCount: number;
  topIssues: RankedIssue[];
  topSessionIssues: RankedSessionIssue[];
  topMissingTools: RankedNeed[];
  ratingTrend: RatingTrendPoint[];
  reviews: ReviewSummary;
}

export interface RatingTrendPoint {
  month: string; // 'YYYY-MM'
  /** Agent self-rating average over records with one; null when none that month. */
  avgRating: number | null;
  count: number;
  /** User rating average over records with one; null when none that month. */
  avgUserRating: number | null;
  userCount: number;
}

export interface IssueCostCorrelation {
  tool: string;
  issueType: IssueType;
  flaggedSessionCount: number;
  medianFlaggedTokens: number;
  medianAllTokens: number;
  medianFlaggedActiveTimeSec: number;
  medianAllActiveTimeSec: number;
}

/** One stored feedback record as the records read returns it. */
export interface FeedbackRecord {
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  userId: string | null;
  userEmail: string | null;
  sessionId: string | null;
  runId: string | null;
  repoKey: string | null;
  overallRating: number | null;
  userRating: number | null;
  reviewStatus: ReviewStatus;
  summary: string | null;
  userNotes: string | null;
  perToolIssues: FeedbackToolIssue[];
  sessionIssues: SessionIssue[];
  missingCapabilities: MissingCapability[];
  misleadingMetadata: MisleadingMetadata[];
}

export interface FeedbackRecordsPage {
  items: FeedbackRecord[];
  page: number;
  limit: number;
  total: number;
  /** Resolved window: `[since, until)` in ISO, `days` is the inclusive span. */
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

/** Already validated at the controller boundary — the service trusts these. */
export interface FeedbackRecordsQuery {
  days: number;
  since: Date;
  untilExclusive: Date;
  page: number;
  limit: number;
  sort: FeedbackSort;
  order: SortOrder;
  reviewStatus: ReviewStatus | null;
  area: SessionIssueArea | null;
  tool: string | null;
  maxRating: number | null;
  /** Workspace-wide read filtered to one member, or null. A `member` caller is self-scoped instead. */
  userId: string | null;
}
