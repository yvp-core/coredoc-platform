import type { IntentReleaseTrigger } from './intent-release-types.js';
import type {
  IntentReleaseAction,
  IntentReleaseHistory,
  IntentReleasePreview,
  IntentReleaseWrite,
} from './intent-release-types.js';
/**
 * IPC Types for Electron communication between main and renderer processes
 */

import type { AnalysisRecord, CloudSyncState } from '@coredoc/core';
import type {
  VizNode,
  VizEdge,
  NeighborCount,
  NodeDetail,
  NeighborPage,
  VizNodePage,
  GraphCapabilities,
  WorkspaceRepoRef,
  CypherGraphResult,
} from '@coredoc/core';
import {
  type AnalyticsWindow,
  AnalyticsWindowKind,
  type CanonicalArtifactCheckpoint,
  type CanonicalArtifactItem,
  type CanonicalArtifactKind,
  type CanonicalArtifactRevisionsResponse,
  type CanonicalCodeChangeItem,
  type CanonicalCursorPage,
  type CanonicalDeliveryLifecycle,
  type CanonicalDeliveryOutcome,
  type CanonicalDeliverySummary,
  type CanonicalExternalRefItem,
  type CanonicalExternalRefStateFactItem,
  type CanonicalReworkSignalItem,
  type CanonicalRunItem,
  type CanonicalShipEvidenceItem,
  type CanonicalStageOccurrenceItem,
  type CanonicalTaskDetail,
  type CanonicalTaskSummariesResponse,
  type CanonicalWorkflowOutcome,
  type DeliveryLifecycleFilter,
  type FeedbackIssueType,
  type FeedbackMisleadingMetadata,
  type FeedbackRecordsFilter,
  type FeedbackReviewStatus,
  type FeedbackSessionIssueArea,
  type FeedbackSessionIssueType,
  FeedbackSort,
  MAX_ANALYTICS_DAYS,
  SortOrder,
  type WorkspaceUsageAnalytics,
} from '@coredoc/core/browser/analytics';
import type { AgentRunAnswer, AgentRunEventEnvelope } from './agent-run-types';
import type {
  IntentAnchorRefreshInput,
  IntentAnchorRefreshResponse,
  IntentArchiveInput,
  IntentContextQuery,
  IntentContextResponse,
  IntentDeleteInput,
  IntentDeleteResponse,
  IntentDimensionsQuery,
  IntentDimensionsResponse,
  IntentDomainCreateInput,
  IntentDomainMutationResponse,
  IntentDomainUpdateInput,
  IntentFeatureCreateInput,
  IntentFeatureMutationResponse,
  IntentFeatureSeedsResponse,
  IntentFeatureUpdateInput,
  IntentFeaturesQuery,
  IntentFeaturesResponse,
  IntentItemsQuery,
  IntentSourcesResponse,
  IntentItemsResponse,
  IntentResult,
  IntentReviewQueueQuery,
  IntentReviewQueueResponse,
  IntentReviewRequest,
  IntentReviewResponse,
  IntentSeedDeleteInput,
  IntentSeedMutationResponse,
  IntentSeedPutInput,
  IntentTransitionsQuery,
  IntentTransitionsResponse,
  IntentTreeQuery,
  IntentTreeResponse,
} from './intent-types';

export type { AgentRunAnswer, AgentRunEventEnvelope };

// =============================================================================
// Config IPC
// =============================================================================

export interface ConfigLoadResult {
  success: boolean;
  config?: CoredocConfigSerialized;
  /** Project ids whose retained local database files must not be rebound. */
  reservedProjectIds?: string[];
  error?: string;
}

export interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

export interface ConfigValidateResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
}

export interface RemoveRepositoryResult {
  success: boolean;
  error?: string;
}

export interface CoredocConfigSerialized {
  version: '2.0';
  projects: ProjectConfigSerialized[];
  sharedPackages?: SharedPackageSerialized[];
  output: OutputConfigSerialized;
  parserStorage: string;
  exclude?: string[];
}

export interface ProjectConfigSerialized {
  id: string;
  name: string;
  wizardCompleted?: boolean;
  graphReadyModalShown?: boolean;
  repos: RepoConfigSerialized[];
  sharedPackages?: SharedPackageSerialized[];
  cloud?: CloudSyncState;
}

export type { CloudSyncState };

/**
 * One repository in a cloud-sync request.
 *
 * `key` is `RepoConfigSerialized.key` — the durable identity the intent
 * knowledge base binds anchors, seeds and imports on. It must travel with the
 * request: graph node ids hash from it (defaulting to the name), so a repo with
 * an explicit key that the client omits can only be bound through the server's
 * `hash(name)` fallback, which such a repo never satisfies.
 */
export interface SyncToCloudRepoInput {
  repoName: string;
  parsedRepoPath: string;
  httpPrefix?: string;
  key?: string;
}

export interface SyncToCloudResult {
  synced: Array<{ repoName: string; nodesInserted: number; edgesInserted: number }>;
  skipped: Array<{ repoName: string; reason: string }>;
  errors: Array<{ repoName: string; error: string }>;
  /**
   * Batch publication is still running server-side: artifacts are uploaded but
   * NOT yet published. Repos listed here are neither synced nor failed — the
   * renderer must not advance freshness (lastSyncedAt / cloudOutdated) until a
   * later sync observes the terminal state.
   */
  publishing?: { jobId: string | null; repoNames: string[] };
}

export interface RepoStateResponse {
  repoKey: string;
  repoName: string;
  lastParseHash: string | null;
  lastPushedAt: string | null;
  lastPushedByUserId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  currentSummaryVersion: string | null;
  summaryUploadedAt: string | null;
}

export interface RepoConfigSerialized {
  name: string;
  path: string;
  /**
   * Canonical identity key, mirroring `RepoConfig.key` from packages/core.
   * Graph node ids are hashed from it (defaulting to `name`), so anything
   * addressing this repo's rows must hash the same value.
   */
  key?: string;
  type?: 'backend' | 'frontend' | 'mobile' | 'library';
  exclude?: string[];
  /**
   * Per-repo URL prefix (e.g. '/v1/public/api-gateway'). Mirrors
   * `RepoConfig.httpPrefix` from packages/core. Forwarded to the cloud
   * workspace on connect so the server-side resolver indexes entrypoints
   * under both raw and prefix-stripped paths.
   */
  httpPrefix?: string;
}

export interface SharedPackageSerialized {
  name: string;
  path: string;
  type?: 'schemas' | 'types' | 'utils' | 'sdk' | 'other';
  description?: string;
  clientMappings?: Record<string, string>;
}

export interface OutputConfigSerialized {
  dir: string;
  format: 'json';
  prettyPrint?: boolean;
}

// =============================================================================
// State IPC
// =============================================================================

export interface RepoState {
  name: string;
  parsed: FileState & { stats?: ParseStats };
  summarized: FileState & { count?: number };
  embedded: FileState & { count?: number };
  docs: FileState & { mode?: string };
  neo4jSynced: { synced: boolean; timestamp?: string };
}

export interface FileState {
  exists: boolean;
  timestamp?: string;
}

export interface ParseStats {
  analysis?: AnalysisRecord[];
  totalFiles: number;
  parsedFiles: number;
  totalFunctions: number;
  totalClasses: number;
  totalEntrypoints: number;
  totalEntities: number;
}

export interface AllStatesResult {
  states: RepoState[];
  outputDir: string;
}

export interface OperationTimestamps {
  lastGenerated?: string; // ISO 8601
  lastParsed?: string;
  lastSummarized?: string;
  lastPushed?: string;
  lastDocs?: string;
}

export interface GitRevision {
  commitHash: string;
  commitShortHash: string;
  branch: string;
  isDirty: boolean;
  commitDate?: string;
}

/**
 * One repository as the explorer sees it: identity plus its node tallies.
 *
 * `countsByType` is keyed by raw NodeType string values ('state_store',
 * 'entrypoint', …) — the same keys `nodeColor()` and `humanizeType()` take, so
 * no @coredoc/core enum has to be value-imported into the renderer bundle.
 * Repository nodes are excluded from the tallies.
 */
export interface GraphOverviewRepo {
  name: string;
  countsByType: Record<string, number>;
  /** `origin` URL captured at parse time; absent outside a git remote. */
  gitRemoteUrl?: string;
}

export interface GraphOverview {
  repos: GraphOverviewRepo[];
}

export interface RepoStalenessInfo {
  isStale: boolean;
  reason?: 'new_commits' | 'dirty_worktree';
  currentCommitHash?: string;
  parsedCommitHash?: string;
  isDirty?: boolean;
  /**
   * Commits HEAD is ahead of the parsed snapshot. Tri-state, per
   * ADR-20260724-explicit-degrade-no-silent-zeros:
   *   absent → not applicable (the repo is not stale)
   *   null   → stale, but the count could not be measured (no git, shallow
   *            clone, unknown parsed commit) — render "new commits", never "0"
   *   number → measured
   */
  commitsBehind?: number | null;
}

export interface RepoDetailState {
  name: string;
  parserExists: boolean;
  parserPath: string;
  parsedOutputPath?: string;
  parsed: FileState & { stats?: ParseStats };
  summarized: FileState & { count?: number };
  neo4jSynced: { synced: boolean; timestamp?: string };
  operations?: OperationTimestamps;
  parsedRevision?: GitRevision;
  staleness?: RepoStalenessInfo;
  approval?: ApprovalStatus;
}

/** List/sidebar state, without parsing graph artifacts or verifying output contents. */
export type RepoStatusState = Pick<
  RepoDetailState,
  'name' | 'parserExists' | 'parsed' | 'summarized' | 'neo4jSynced' | 'staleness'
> & { approval?: Omit<ApprovalStatus, 'outputMatchesParser'> };

// =============================================================================
// Command IPC
// =============================================================================

export type CommandName =
  | 'generate'
  | 'parse'
  | 'summarize'
  | 'embed'
  | 'push'
  | 'docs'
  | 'cloud-docs'
  | 'resolve'
  | 'call-graph'
  | 'dependency-graph'
  | 'external-calls'
  | 'topology';

export type AnalysisChoice = 'retry' | 'basic' | 'cancel' | 'install' | 'run';
export interface AnalysisPrompt {
  id: string;
  commandId: string;
  projectId: string;
  repoName: string;
  /** Display label from the trusted host; omitted by existing C# callers. */
  language?: string;
  message: string;
  canUseBasic: boolean;
  canInstall?: boolean;
  phase?: 'prerequisites' | 'execution' | 'installing';
}

export interface CommandRunOptions {
  command: CommandName;
  projectId: string;
  repo?: string;
  args?: Record<string, unknown>;
}

export interface CommandRunResult {
  id: string;
  started: boolean;
  error?: string;
}

export interface RunningCommandInfo {
  id: string;
  /** Project the command belongs to. Required to scope state across projects. */
  projectId: string;
  repoName: string;
  action: string;
  startedAt: string;
}

export interface CommandOutput {
  id: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface CommandProgress {
  id: string;
  current: number;
  total: number;
  message?: string;
}

export interface CommandCompleted {
  id: string;
  success: boolean;
  exitCode: number;
  error?: string;
}

export interface PtyData {
  id: string;
  data: string;
}

export interface PtyExit {
  id: string;
  exitCode: number;
  signal?: number;
}

// Agent-run event contract lives in ./agent-run-types (harness-agnostic).

// =============================================================================
// MCP IPC
// =============================================================================

export interface McpInfoResult {
  success: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  error?: string;
}

// =============================================================================
// Chat Context
// =============================================================================

/**
 * Context for chat messages - distinguishes between project-level and repo-level scoping
 */
export interface ChatContext {
  /** Stable project id (or legacy display name) - scopes to all repos in the group */
  project?: string;
  /** Single repo name - scopes to that repo only */
  repo?: string;
  /** Optional explicit working directory */
  cwd?: string;
  /** Cloud member mode — use cloud MCP instead of local */
  cloudMember?: boolean;
  /** Workspace ID for cloud member context */
  workspaceId?: string;
  /** Repo names available in the cloud workspace */
  cloudRepoNames?: string[];
  /** Map of repoName → local folder path for linked repos */
  linkedRepoPaths?: Record<string, string>;
}

// =============================================================================
// Linked Repos & Cloud State
// =============================================================================

export interface LinkedRepo {
  workspaceId: string;
  repoName: string;
  localPath: string;
}

export interface LinkedRepoLinkResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
}

export interface CloudRepoState {
  repoName: string;
  nodeCount: number | null;
  edgeCount: number | null;
  lastPushedAt: string | null;
  repoKey: string;
}

// =============================================================================
// Chat Streaming IPC
// =============================================================================

export interface ChatDocCard {
  id: string; // "{repoName}:{relativePath}"
  repoName: string;
  title: string;
  category: string;
  generatedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  toolCalls?: ChatToolCall[];
  docCards?: ChatDocCard[];
  timestamp: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'error';
  output?: string;
  error?: string;
}

export interface ChatStreamDelta {
  sessionId: string;
  messageId: string;
  delta: string;
}

export interface ChatStreamToolUpdate {
  sessionId: string;
  messageId: string;
  toolCall: ChatToolCall;
}

export interface ChatStreamEnd {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
}

// =============================================================================
// Chat Sessions IPC
// =============================================================================

export interface ChatSession {
  id: string; // UUID v4
  projectId: string; // Stable project id from config
  name: string; // User-defined name
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  messages: ChatMessage[]; // Full message history including tool calls
}

export interface ChatSessionMeta {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionListResult {
  success: boolean;
  sessions?: ChatSessionMeta[];
  error?: string;
}

export interface SessionLoadResult {
  success: boolean;
  session?: ChatSession;
  error?: string;
}

export interface SessionSaveResult {
  success: boolean;
  session?: ChatSessionMeta;
  error?: string;
}

export interface SessionDeleteResult {
  success: boolean;
  error?: string;
}

export interface SessionRenameResult {
  success: boolean;
  session?: ChatSessionMeta;
  error?: string;
}

// =============================================================================
// Docs IPC
// =============================================================================

export interface DocFileInfo {
  id: string; // "{repoName}:{relativePath}"
  repoName: string;
  title: string; // Humanized filename
  relativePath: string; // Path within {repoName}-docs/
  promptName?: string; // Prompt key from frontmatter/file stem
  category: string; // "analysis" | "database" | "overview"
  generatedAt?: string; // ISO 8601
  contentHash?: string;
  sizeBytes: number;
}

export interface DocsListResult {
  success: boolean;
  docs?: DocFileInfo[];
  error?: string;
}

// =============================================================================
// Graph explorer IPC
// =============================================================================

// Graph explorer — the scope every graph query runs against. `source` selects
// the backend the main-process dispatcher routes to; `id` is a local projectId
// (source='local') or a cloud workspaceId (source='cloud').
export interface GraphScope {
  source: 'local' | 'cloud';
  id: string;
}

// Re-export the @coredoc/core viz contract used across the graph IPC seam so the
// renderer imports these as *types* from shared (avoids value-importing core
// enums into the renderer bundle).
export type {
  VizNode,
  VizEdge,
  NeighborCount,
  NodeDetail,
  NeighborPage,
  VizNodePage,
  GraphCapabilities,
  WorkspaceRepoRef,
  CypherGraphResult,
};

// Mirror of apps/web/src/api/types.ts GraphSearchHit — a Tier-A search result.
export interface GraphSearchHit {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  summary?: string;
}

// =============================================================================
// Review IPC
// =============================================================================

export interface GraphReviewData {
  entrypoints: ReviewEntrypoint[];
  entities: ReviewEntity[];
  externalCalls: ReviewExternalCall[];
  stateStores: ReviewStateStore[];
  routes: ReviewRoute[];
}

export interface ReviewEntrypoint {
  id: string;
  location: string; // "filePath:startLine"
  type: string; // http | graphql | queue | grpc | websocket | cron | event | cli
  // HTTP
  method?: string;
  fullPath?: string;
  // Queue
  system?: string;
  topic?: string;
  pattern?: string;
  // GraphQL
  operationType?: string;
  fieldName?: string;
  parentType?: string;
  // gRPC
  serviceName?: string;
  methodName?: string;
  streaming?: string;
  // WebSocket
  event?: string;
  namespace?: string;
  // Cron
  schedule?: string;
  // Event
  eventName?: string;
  // CLI
  command?: string;
}

export interface ReviewEntity {
  id: string;
  name: string;
  location: string;
  ormType: string;
  tableName: string;
  fields: { name: string; columnName: string; type: string; isPrimaryKey: boolean }[];
  relations: { name: string; type: string; targetEntityName: string }[];
}

export interface ReviewExternalCall {
  id: string;
  serviceName: string;
  method: string;
  location: string;
  targetDescriptor?: {
    protocol: string;
    http?: { method: string; pathTemplate: string };
    messaging?: { system: string; destination: string; destinationValue?: string };
    grpc?: { service: string; method: string };
    graphql?: { operationType: string; operationName: string };
    targetService?: string;
  };
}

export interface ReviewStateStore {
  id: string;
  name: string;
  library: string;
  location: string;
}

export interface ReviewRoute {
  id: string;
  path: string;
  componentName: string;
  location: string;
}

export interface ApprovalStatus {
  approved: boolean;
  approvedAt?: string;
  approvedParserHash?: string;
  isStale: boolean;
  outputMatchesParser: boolean;
}

// =============================================================================
// Settings IPC
// =============================================================================

export interface TelemetryStatusResult {
  enabled: boolean;
  installId: string;
  posthogConfigured: boolean;
  posthogKey?: string;
  posthogHost?: string;
  /**
   * True once a consent surface (the first-run card) has been shown. The card
   * reads this to render exactly once; it says nothing about opt-in.
   */
  consentPrompted: boolean;
}

export type HarnessProvider = 'claude-code' | 'codex';
export type HarnessAuthMode = 'subscription' | 'api-token';

export interface HarnessCredentialStatus {
  isSet: boolean;
  maskedValue?: string;
}

export interface HarnessSettingsStatus {
  provider: HarnessProvider;
  authMode: HarnessAuthMode;
  credentials: Record<HarnessProvider, HarnessCredentialStatus>;
}

export interface HarnessSettingsUpdate {
  provider?: HarnessProvider;
  authMode?: HarnessAuthMode;
  credential?: { provider: HarnessProvider; value: string };
}

export interface HarnessSettingsUpdateResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// CLI Alias IPC
// =============================================================================

export interface CliAliasStatus {
  /** True when the `coredoc` launcher file exists at the install path. */
  installed: boolean;
  /** Absolute path where the launcher is/would be installed. */
  path: string;
  /** Platform-specific hint shown in the UI (e.g. "needs admin password"). */
  hint?: string;
  /** True when `installPath`'s containing dir is on the user's PATH (best effort). */
  inPath?: boolean;
  /** Set when the runtime cannot resolve a stable target (e.g. AppImage not integrated). */
  unsupportedReason?: string;
}

export interface CliAliasResult {
  success: boolean;
  /** Final status after the operation, regardless of success — UI re-renders from this. */
  status: CliAliasStatus;
  /** Present when success is false. */
  error?: string;
  /** Free-form note surfaced to the user (e.g. "open a new terminal for PATH to update"). */
  note?: string;
}

// =============================================================================
// Update IPC
// =============================================================================

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatusInfo {
  status: UpdateStatus;
  version?: string;
  downloadProgress?: number;
  error?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  error?: string;
}

// =============================================================================
// Dialog IPC
// =============================================================================

export interface DialogSelectFoldersResult {
  success: boolean;
  paths?: string[];
  canceled?: boolean;
  error?: string;
}

export interface DialogSelectTemplateDagResult {
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface DialogSelectTemplateFileResult {
  success: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

// =============================================================================
// Observability IPC (cloud dashboards + Claude Code OTLP telemetry)
// =============================================================================

// The Usage and Delivery v2 wire DTOs are shared with the web app. Every field is
// projected at the MAIN trust boundary before it crosses IPC; the declarations
// below are the desktop-only additions and the IPC shapes that differ from the wire.
export * from '@coredoc/core/browser/analytics';

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function utcDayMs(day: string): number | null {
  if (!UTC_DAY_PATTERN.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  // Round-trip catches calendar-invalid days (2026-02-31 parses as March 3).
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? parsed : null;
}

/**
 * The one place the custom-range rules live: the renderer renders this as a hint,
 * MAIN throws on it at the trust boundary, and the server re-validates independently.
 * `null` = valid.
 */
export function analyticsWindowError(since: string, until: string): string | null {
  const sinceMs = utcDayMs(since);
  const untilMs = utcDayMs(until);
  if (sinceMs === null || untilMs === null) return 'Pick a From and To date (YYYY-MM-DD).';
  if (sinceMs > untilMs) return 'From must be on or before To.';
  if ((untilMs - sinceMs) / DAY_MS + 1 > MAX_ANALYTICS_DAYS)
    return `Range must be ${MAX_ANALYTICS_DAYS} days or fewer.`;
  return null;
}

/** Inclusive span of the window in days — what every "last N days" caption names. */
export function windowDays(window: AnalyticsWindow): number {
  if (window.kind === AnalyticsWindowKind.Days) return window.days;
  const sinceMs = utcDayMs(window.since);
  const untilMs = utcDayMs(window.until);
  if (sinceMs === null || untilMs === null) throw new TypeError('Invalid analytics window');
  return (untilMs - sinceMs) / DAY_MS + 1;
}

/** Query-string form of the window: `days=N`, or `since=…&until=…` (both required together). */
export function analyticsWindowParams(window: AnalyticsWindow): Record<string, string> {
  return window.kind === AnalyticsWindowKind.Days
    ? { days: String(window.days) }
    : { since: window.since, until: window.until };
}

/** Mirrors the server `FeedbackToolIssue`. Server optionals arrive as null across IPC. */
export interface FeedbackToolIssue {
  tool: string;
  issueType: FeedbackIssueType;
  /** 1..5 */
  severity: number;
  description: string;
  exampleQuery: string | null;
}

/** Mirrors the server `SessionIssue`. */
export interface FeedbackSessionIssue {
  area: FeedbackSessionIssueArea;
  issueType: FeedbackSessionIssueType;
  /** 1..5 */
  severity: number;
  description: string;
  skill: string | null;
  stageId: string | null;
  exampleRedacted: string | null;
}

/** Mirrors the server `MissingCapability`. */
export interface FeedbackMissingCapability {
  need: string;
  useCase: string | null;
}

/** One stored record — mirrors the server `FeedbackRecord`. */
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
  reviewStatus: FeedbackReviewStatus;
  summary: string | null;
  userNotes: string | null;
  perToolIssues: FeedbackToolIssue[];
  sessionIssues: FeedbackSessionIssue[];
  missingCapabilities: FeedbackMissingCapability[];
  misleadingMetadata: FeedbackMisleadingMetadata[];
}

/** `GET mcp-feedback/records` response — mirrors the server `FeedbackRecordsPage`. */
export interface FeedbackRecordsPage {
  items: FeedbackRecord[];
  page: number;
  limit: number;
  total: number;
  /** Resolved window: `[since, until)` in ISO, `days` is the inclusive span. */
  window: { days: number; since: string; until: string };
}

/** Page size of the records list. Fixed: the footer states "1–25 of N", not a picker. */
export const FEEDBACK_RECORDS_PAGE_SIZE = 25;

export const DEFAULT_FEEDBACK_RECORDS_FILTER: FeedbackRecordsFilter = {
  area: null,
  userId: null,
  mine: false,
  sort: FeedbackSort.CreatedAt,
  order: SortOrder.Desc,
  page: 1,
  limit: FEEDBACK_RECORDS_PAGE_SIZE,
};

// =============================================================================
// Canonical Delivery v2 IPC (JWT-only admin timeline + explicit artifact drilldown)
// =============================================================================

export interface CanonicalTaskExternalRef {
  provider: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalState: string | null;
}

export interface CanonicalDeclaredStage {
  stageId: string;
  after: string[];
}

export interface CanonicalStageOccurrence {
  occurrenceId: string;
  stageId: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: CanonicalDeliveryOutcome | null;
}

export interface CanonicalWorkflowRun {
  runId: string;
  actorId: string;
  workflowId: string | null;
  intent: string | null;
  risk: string | null;
  scale: string | null;
  repositoryKey: string | null;
  declaredStages: CanonicalDeclaredStage[] | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: CanonicalWorkflowOutcome | null;
  stageOccurrences: CanonicalStageOccurrence[];
}

export interface CanonicalArtifactRevisionMetadata {
  id: string;
  sha256: string;
  byteCount: number;
  checkpoint: CanonicalArtifactCheckpoint;
  runId: string | null;
  createdAt: string;
}

export interface CanonicalDeliveryArtifact {
  id: string;
  taskId: string;
  repositoryKey: string;
  kind: CanonicalArtifactKind;
  createdAt: string;
  updatedAt: string;
  revisions: CanonicalArtifactRevisionMetadata[];
}

export interface CanonicalDeliveryTask {
  id: string;
  repositoryKey: string | null;
  lifecycle: CanonicalDeliveryLifecycle;
  authority: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  externalRefs: CanonicalTaskExternalRef[];
  workflowRuns: CanonicalWorkflowRun[];
  artifacts: CanonicalDeliveryArtifact[];
}

export interface CanonicalDeliveryTasksResponse {
  tasks: CanonicalDeliveryTask[];
}

export const CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED = 'CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED';
export const CANONICAL_DELIVERY_UNAVAILABLE = 'CANONICAL_DELIVERY_UNAVAILABLE';

/** Clean HTTPS target validated by main before opening in the OS browser. */
export type DeliveryExternalTarget = { externalUrl: string };

// =============================================================================
// Server connection
// =============================================================================

/** Which layer of `main/server-url.ts` supplied the resolved server URL. */
export enum ServerUrlSource {
  /** Pinned by a fleet-managed config file; the user cannot change it. */
  Managed = 'managed',
  /** Set for this session (stored tokens on boot, e2e harness, a just-saved URL). */
  Override = 'override',
  Env = 'env',
  /** Persisted user choice in `desktop-settings.json`. */
  User = 'user',
  /** Build-time default baked in by electron-vite. */
  Bundled = 'bundled',
  /** Last-resort `http://localhost:3000`. */
  Default = 'default',
}

export interface ServerConfigInfo {
  url: string;
  source: ServerUrlSource;
}

export interface SetServerUrlResult extends ServerConfigInfo {
  /**
   * The installed `coredoc` terminal launcher bakes COREDOC_SERVER_URL in at
   * install time, so it still points at the previous server. True when a
   * launcher is installed and therefore stale; the renderer tells the user to
   * reinstall it (re-rendering it here would mean an admin prompt on macOS).
   */
  requiresCliReinstall: boolean;
}

/**
 * Verdict of the version handshake against `GET /api/v1/meta`. Advisory only:
 * the app stays fully usable in every state (reads may well still work), the
 * renderer just tells the truth about the mismatch.
 */
export enum ServerCompatState {
  /** Server version >= MIN_SERVER_VERSION and this app >= server's minClientVersion. */
  Compatible = 'compatible',
  /** Server below MIN_SERVER_VERSION, or too old to serve /api/v1/meta at all. */
  ServerTooOld = 'serverTooOld',
  /** This app is below the server's advertised minClientVersion. */
  ClientTooOld = 'clientTooOld',
}

export interface ServerCompatInfo {
  state: ServerCompatState;
  /** `null` when the server predates the meta endpoint (404). */
  serverVersion: string | null;
  clientVersion: string;
}

// =============================================================================
// IPC Channel Names
// =============================================================================

export const IpcChannels = {
  // Config
  CONFIG_LOAD: 'config:load',
  CONFIG_SAVE: 'config:save',
  CONFIG_VALIDATE: 'config:validate',
  CONFIG_REMOVE_REPO: 'config:removeRepo',

  // Dialog
  DIALOG_SELECT_FOLDERS: 'dialog:selectFolders',
  DIALOG_SELECT_TEMPLATE_DAG: 'dialog:selectTemplateDag',
  DIALOG_SELECT_TEMPLATE_FILE: 'dialog:selectTemplateFile',

  // State
  STATE_GET_ALL: 'state:getAll',
  STATE_GET_DETAIL: 'state:getDetail',
  STATE_GET_STATUS: 'state:getStatus',

  // Shell
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:showItemInFolder',

  // Command
  ANALYSIS_PROMPTS: 'analysis:prompts',
  ANALYSIS_ANSWER: 'analysis:answer',
  ANALYSIS_CHANGED: 'analysis:changed',
  COMMAND_RUN: 'command:run',
  COMMAND_CANCEL: 'command:cancel',
  COMMAND_GET_RUNNING: 'command:getRunning',
  COMMAND_OUTPUT: 'command:output',
  COMMAND_PROGRESS: 'command:progress',
  COMMAND_COMPLETED: 'command:completed',

  // PTY
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',

  // Agent runs (profile authoring)
  AGENT_RUN_EVENT: 'agentRun:event',
  AGENT_RUN_ANSWER: 'agentRun:answer',

  // MCP configuration
  MCP_GET_INFO: 'mcp:getInfo',

  // Chat Streaming
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_CLEAR: 'chat:clear',
  CHAT_STREAM_DELTA: 'chat:stream:delta',
  CHAT_STREAM_TOOL: 'chat:stream:tool',
  CHAT_STREAM_END: 'chat:stream:end',

  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_CREATE: 'session:create',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
  SESSION_DELETE_PROJECT: 'session:deleteProject',

  // Docs
  DOCS_LIST: 'docs:list',

  // Review
  REVIEW_GET_GRAPH_DATA: 'review:getGraphData',
  REVIEW_APPROVE: 'review:approve',
  REVIEW_GET_APPROVAL: 'review:getApproval',

  // Graph explorer
  GRAPH_NODE: 'graph:node',
  GRAPH_NEIGHBORS: 'graph:neighbors',
  GRAPH_SUBGRAPH: 'graph:subgraph',
  GRAPH_SEARCH: 'graph:search',
  GRAPH_NODES_BY_TYPE: 'graph:nodesByType',
  GRAPH_REPOS: 'graph:repos',
  GRAPH_OVERVIEW: 'graph:overview',
  GRAPH_EDGES_AMONG: 'graph:edgesAmong',
  GRAPH_CAPABILITIES: 'graph:capabilities',
  GRAPH_CYPHER: 'graph:cypher',
  GRAPH_GENERATE_CYPHER: 'graph:generateCypher',

  // Settings
  SETTINGS_GET_HARNESS: 'settings:getHarness',
  SETTINGS_UPDATE_HARNESS: 'settings:updateHarness',

  // CLI alias (terminal command)
  CLI_ALIAS_GET_STATUS: 'cliAlias:getStatus',
  CLI_ALIAS_INSTALL: 'cliAlias:install',
  CLI_ALIAS_UNINSTALL: 'cliAlias:uninstall',

  // Update
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  UPDATE_GET_STATUS: 'update:getStatus',
  UPDATE_GET_APP_VERSION: 'update:getAppVersion',

  // Workspace & Auth
  WORKSPACE_GET_SERVER_CONFIG: 'workspace:getServerConfig',
  WORKSPACE_SET_SERVER_URL: 'workspace:setServerUrl',
  WORKSPACE_GET_SERVER_COMPAT: 'workspace:getServerCompat',

  // Cloud Sync

  // Parser Upload

  // Telemetry
  TELEMETRY_GET_STATUS: 'telemetry:getStatus',
  TELEMETRY_SET_ENABLED: 'telemetry:setEnabled',
  TELEMETRY_MARK_CONSENT_PROMPTED: 'telemetry:markConsentPrompted',

  // Observability (cloud dashboards)
  OBSERVABILITY_GET_USAGE_ANALYTICS: 'observability:getUsageAnalytics',
  OBSERVABILITY_OPEN_DASHBOARD: 'observability:openDashboard',

  // Feedback
  OBSERVABILITY_GET_FEEDBACK_RECORDS: 'observability:getFeedbackRecords',

  // Canonical Delivery
  DELIVERY_OPEN_EXTERNAL: 'delivery:openExternal',
  DELIVERY_GET_CANONICAL_TASKS: 'delivery:getCanonicalTasks',
  DELIVERY_GET_CANONICAL_TASK_SUMMARIES: 'delivery:getCanonicalTaskSummaries',
  DELIVERY_GET_CANONICAL_SUMMARY: 'delivery:getCanonicalSummary',
  DELIVERY_GET_CANONICAL_TASK_DETAIL: 'delivery:getCanonicalTaskDetail',
  DELIVERY_GET_CANONICAL_TASK_EXTERNAL_REFS: 'delivery:getCanonicalTaskExternalRefs',
  DELIVERY_GET_CANONICAL_EXTERNAL_REF_STATE_HISTORY: 'delivery:getCanonicalExternalRefStateHistory',
  DELIVERY_GET_CANONICAL_TASK_RUNS: 'delivery:getCanonicalTaskRuns',
  DELIVERY_GET_CANONICAL_RUN_STAGE_OCCURRENCES: 'delivery:getCanonicalRunStageOccurrences',
  DELIVERY_GET_CANONICAL_TASK_CODE_CHANGES: 'delivery:getCanonicalTaskCodeChanges',
  DELIVERY_GET_CANONICAL_TASK_SHIP_EVIDENCE: 'delivery:getCanonicalTaskShipEvidence',
  DELIVERY_GET_CANONICAL_TASK_REWORK_SIGNALS: 'delivery:getCanonicalTaskReworkSignals',
  DELIVERY_GET_CANONICAL_TASK_ARTIFACTS: 'delivery:getCanonicalTaskArtifacts',
  DELIVERY_GET_CANONICAL_ARTIFACT_REVISIONS: 'delivery:getCanonicalArtifactRevisions',

  // Linked Repos
  LINKED_REPOS_GET: 'linkedRepos:get',
  LINKED_REPOS_LINK: 'linkedRepos:link',
  LINKED_REPOS_REMOVE: 'linkedRepos:remove',

  // Cloud Project
  CLOUD_PROJECT_STATES: 'cloud:projectStates',

  // Invited-User Onboarding
  ONBOARDING_LIST_SEEN: 'onboarding:listSeen',
  ONBOARDING_MARK_SEEN: 'onboarding:markSeen',

  // Intent knowledge base (cloud workspaces only)
  INTENT_LIST_SOURCES: 'intent:listSources',
  INTENT_RELEASE_PREVIEW: 'intent:releasePreview',
  INTENT_RELEASE_PREVIEWS: 'intent:releasePreviews',
  INTENT_RELEASE_LIST: 'intent:releaseList',
  INTENT_RELEASE_WRITE: 'intent:releaseWrite',
  INTENT_GET_TREE: 'intent:getTree',
  INTENT_LIST_DIMENSIONS: 'intent:listDimensions',
  INTENT_LIST_FEATURES: 'intent:listFeatures',
  INTENT_LIST_FEATURE_SEEDS: 'intent:listFeatureSeeds',
  INTENT_LIST_ITEMS: 'intent:listItems',
  INTENT_REVIEW_QUEUE: 'intent:reviewQueue',
  INTENT_GET_CONTEXT: 'intent:getContext',
  INTENT_LIST_ITEM_TRANSITIONS: 'intent:listItemTransitions',
  INTENT_LIST_TRANSITIONS: 'intent:listTransitions',
  INTENT_REVIEW_ITEMS: 'intent:reviewItems',
  INTENT_CREATE_DOMAIN: 'intent:createDomain',
  INTENT_UPDATE_DOMAIN: 'intent:updateDomain',
  INTENT_ARCHIVE_DOMAIN: 'intent:archiveDomain',
  INTENT_DELETE_DOMAIN: 'intent:deleteDomain',
  INTENT_CREATE_FEATURE: 'intent:createFeature',
  INTENT_UPDATE_FEATURE: 'intent:updateFeature',
  INTENT_ARCHIVE_FEATURE: 'intent:archiveFeature',
  INTENT_DELETE_FEATURE: 'intent:deleteFeature',
  INTENT_PUT_SEED: 'intent:putSeed',
  INTENT_DELETE_SEED: 'intent:deleteSeed',
  INTENT_REFRESH_ANCHOR: 'intent:refreshAnchor',
} as const;

// =============================================================================
// Preload API type
// =============================================================================

export interface ElectronAPI {
  intentReleasePreviews: (workspaceId: string, itemIds: string[]) => Promise<IntentResult<IntentReleasePreview[]>>;
  intentReleasePreview: (workspaceId: string, itemId: string) => Promise<IntentResult<IntentReleasePreview>>;
  intentReleaseList: (workspaceId: string, beforeSeq?: number) => Promise<IntentResult<IntentReleaseHistory>>;
  intentReleaseWrite: (
    workspaceId: string,
    action: IntentReleaseAction,
    body: IntentReleaseWrite,
  ) => Promise<IntentResult<unknown>>;

  platform: string;
  // Config
  loadConfig: (configPath?: string) => Promise<ConfigLoadResult>;
  saveConfig: (config: CoredocConfigSerialized) => Promise<ConfigSaveResult>;
  validateConfig: () => Promise<ConfigValidateResult>;
  removeRepository: (projectId: string, repoName: string) => Promise<RemoveRepositoryResult>;

  // State
  getRepoDetailState: (projectId: string, name: string) => Promise<RepoDetailState | null>;
  getRepoStatusState: (projectId: string, name: string) => Promise<RepoStatusState | null>;
  getAllStates: () => Promise<AllStatesResult>;

  // Shell
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => Promise<void>;

  // Commands
  getAnalysisPrompts: () => Promise<AnalysisPrompt[]>;
  answerAnalysisPrompt: (id: string, choice: AnalysisChoice) => Promise<boolean>;
  onAnalysisPromptsChanged: (callback: () => void) => () => void;
  runCommand: (options: CommandRunOptions) => Promise<CommandRunResult>;
  cancelCommand: (id: string) => Promise<boolean>;
  getRunningCommands: () => Promise<RunningCommandInfo[]>;
  onCommandOutput: (callback: (output: CommandOutput) => void) => () => void;
  onCommandProgress: (callback: (progress: CommandProgress) => void) => () => void;
  onCommandCompleted: (callback: (result: CommandCompleted) => void) => () => void;

  // PTY
  onPtyData: (callback: (data: PtyData) => void) => () => void;
  onPtyExit: (callback: (data: PtyExit) => void) => () => void;

  // Agent runs (profile authoring)
  onAgentRunEvent: (callback: (data: AgentRunEventEnvelope) => void) => () => void;
  answerAgentRun: (id: string, answer: AgentRunAnswer) => Promise<boolean>;

  // MCP configuration
  getMcpInfo: (projectId: string) => Promise<McpInfoResult>;

  // Chat Streaming
  sendChatMessage: (message: string, context?: ChatContext) => Promise<{ messageId: string }>;
  cancelChat: () => Promise<void>;
  clearChat: () => Promise<void>;
  onChatStreamDelta: (callback: (data: ChatStreamDelta) => void) => () => void;
  onChatStreamTool: (callback: (data: ChatStreamToolUpdate) => void) => () => void;
  onChatStreamEnd: (callback: (data: ChatStreamEnd) => void) => () => void;

  // Sessions
  listSessions: (projectId: string) => Promise<SessionListResult>;
  loadSession: (sessionId: string) => Promise<SessionLoadResult>;
  createSession: (projectId: string, name?: string) => Promise<SessionSaveResult>;
  saveSession: (session: ChatSession) => Promise<SessionSaveResult>;
  deleteSession: (sessionId: string) => Promise<SessionDeleteResult>;
  renameSession: (sessionId: string, newName: string) => Promise<SessionRenameResult>;
  deleteProjectSessions: (projectId: string) => Promise<{ success: boolean; error?: string }>;

  // Docs
  listDocs: (projectId: string, repoNames: string[], workspaceId?: string) => Promise<DocsListResult>;

  // Review
  getGraphReviewData: (
    projectId: string,
    repoName: string,
  ) => Promise<{ success: boolean; data?: GraphReviewData; error?: string }>;
  approveParser: (projectId: string, repoName: string) => Promise<{ success: boolean; error?: string }>;
  getApprovalStatus: (
    projectId: string,
    repoName: string,
  ) => Promise<{ success: boolean; status?: ApprovalStatus; error?: string }>;

  // Graph explorer
  graphNode: (scope: GraphScope, nodeId: string) => Promise<{ success: boolean; data?: NodeDetail; error?: string }>;
  graphNeighbors: (
    scope: GraphScope,
    nodeId: string,
    args: { direction: 'in' | 'out'; edgeType: string; limit?: number; cursor?: string },
  ) => Promise<{ success: boolean; data?: NeighborPage; error?: string }>;
  graphSubgraph: (
    scope: GraphScope,
    nodeId: string,
    args: { depth: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[]; limit?: number },
  ) => Promise<{ success: boolean; data?: NeighborPage; error?: string }>;
  graphSearch: (
    scope: GraphScope,
    q: string,
    limit?: number,
  ) => Promise<{ success: boolean; data?: GraphSearchHit[]; error?: string }>;
  graphNodesByType: (
    scope: GraphScope,
    args: { type: string; scopeRepo?: string; limit?: number; cursor?: string },
  ) => Promise<{ success: boolean; data?: VizNodePage; error?: string }>;
  graphRepos: (
    scope: GraphScope,
  ) => Promise<{ success: boolean; data?: { repos: WorkspaceRepoRef[] }; error?: string }>;
  graphOverview: (scope: GraphScope) => Promise<{ success: boolean; data?: GraphOverview; error?: string }>;
  graphEdgesAmong: (
    scope: GraphScope,
    nodeIds: string[],
  ) => Promise<{ success: boolean; data?: { edges: VizEdge[]; truncated: boolean }; error?: string }>;
  graphCapabilities: (scope: GraphScope) => Promise<{ success: boolean; data?: GraphCapabilities; error?: string }>;
  graphCypher: (
    scope: GraphScope,
    query: string,
    limit?: number,
  ) => Promise<{ success: boolean; data?: CypherGraphResult; error?: string }>;
  graphGenerateCypher: (
    scope: GraphScope,
    text: string,
  ) => Promise<{ success: boolean; data?: { cypher: string }; error?: string }>;
  /**
   * Repos to re-push so this project's local Ladybug graph catches up with the
   * pre-Ladybug sqlite one. `[]` when no migration is needed. At most one
   * non-empty plan per project per app session.
   */

  // Settings
  getHarnessSettings: () => Promise<HarnessSettingsStatus>;
  updateHarnessSettings: (update: HarnessSettingsUpdate) => Promise<HarnessSettingsUpdateResult>;

  // CLI alias
  getCliAliasStatus: () => Promise<CliAliasStatus>;
  installCliAlias: () => Promise<CliAliasResult>;
  uninstallCliAlias: () => Promise<CliAliasResult>;

  // Update
  checkForUpdate: () => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<void>;
  getUpdateStatus: () => Promise<UpdateStatusInfo>;
  onUpdateStatus: (callback: (status: UpdateStatusInfo) => void) => () => void;
  getAppVersion: () => Promise<string>;

  // Telemetry
  getTelemetryStatus: () => Promise<TelemetryStatusResult>;
  setTelemetryEnabled: (enabled: boolean) => Promise<void>;
  /** Stamp the first-run consent as shown (once-only gate). Never enables telemetry. */
  markTelemetryConsentPrompted: () => Promise<void>;

  // Observability (cloud dashboards + Claude Code OTLP telemetry)
  getUsageAnalytics: (
    workspaceId: string,
    window: AnalyticsWindow,
  ) => Promise<{ success: boolean; data?: WorkspaceUsageAnalytics; error?: string }>;
  openObservabilityDashboard: (workspaceSlug: string) => Promise<{ success: boolean; error?: string }>;

  // Feedback
  /** One paged, filtered read of the raw feedback records behind the roadmap aggregates. */
  getFeedbackRecords: (
    workspaceId: string,
    window: AnalyticsWindow,
    filter: FeedbackRecordsFilter,
  ) => Promise<{ success: boolean; data?: FeedbackRecordsPage; error?: string }>;

  // Canonical Delivery
  openDeliveryExternal: (target: DeliveryExternalTarget) => Promise<{ success: boolean; error?: string }>;
  getCanonicalDeliveryTasks: (
    workspaceId: string,
  ) => Promise<{ success: boolean; data?: CanonicalDeliveryTasksResponse; error?: string }>;
  getDeliverySummary: (
    workspaceId: string,
    window: AnalyticsWindow,
    lifecycle: DeliveryLifecycleFilter,
    /** Self-scope sugar; mutually exclusive with `userId` (MAIN rejects both). */
    mine: boolean,
    /** A workspace member to scope the read to — admins/owners only, server-enforced. */
    userId: string | null,
  ) => Promise<{ success: boolean; data?: CanonicalDeliverySummary; error?: string }>;
  /**
   * `window` / `lifecycle` / `mine` / `userId` are appended, not required: omitting
   * them preserves the server's current population and cursor scope (BR-6).
   */
  getCanonicalTaskSummaries: (
    workspaceId: string,
    limit: number,
    cursor?: string,
    window?: AnalyticsWindow,
    lifecycle?: DeliveryLifecycleFilter,
    mine?: boolean,
    userId?: string | null,
  ) => Promise<{ success: boolean; data?: CanonicalTaskSummariesResponse; error?: string }>;
  getCanonicalTaskDetail: (
    workspaceId: string,
    taskId: string,
  ) => Promise<{ success: boolean; data?: CanonicalTaskDetail; error?: string }>;
  getCanonicalTaskExternalRefs: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalExternalRefItem>; error?: string }>;
  getCanonicalExternalRefStateHistory: (
    workspaceId: string,
    taskId: string,
    externalRefId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalExternalRefStateFactItem>; error?: string }>;
  getCanonicalTaskRuns: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalRunItem>; error?: string }>;
  getCanonicalRunStageOccurrences: (
    workspaceId: string,
    taskId: string,
    runId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalStageOccurrenceItem>; error?: string }>;
  getCanonicalTaskCodeChanges: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalCodeChangeItem>; error?: string }>;
  getCanonicalTaskShipEvidence: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalShipEvidenceItem>; error?: string }>;
  getCanonicalTaskReworkSignals: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalReworkSignalItem>; error?: string }>;
  getCanonicalTaskArtifacts: (
    workspaceId: string,
    taskId: string,
    limit: number,
    cursor?: string,
  ) => Promise<{ success: boolean; data?: CanonicalCursorPage<CanonicalArtifactItem>; error?: string }>;
  getCanonicalArtifactRevisions: (
    workspaceId: string,
    artifactId: string,
  ) => Promise<{ success: boolean; data?: CanonicalArtifactRevisionsResponse; error?: string }>;

  // Dialog
  selectFolders: () => Promise<DialogSelectFoldersResult>;
  selectTemplateDag: () => Promise<DialogSelectTemplateDagResult>;
  selectTemplateFile: () => Promise<DialogSelectTemplateFileResult>;

  // Workspace & Auth
  /** Resolved Coredoc server URL plus the layer it came from. */
  workspaceGetServerConfig: () => Promise<ServerConfigInfo>;
  /** Persist the user's server choice; rejects when a managed config pins it. */
  workspaceSetServerUrl: (url: string) => Promise<SetServerUrlResult>;
  /** Version-handshake verdict; `null` when the server could not be reached. */
  workspaceGetServerCompat: () => Promise<ServerCompatInfo | null>;
  workspaceLogin: () => Promise<{ pending: true }>;
  workspaceLogout: () => Promise<void>;
  getWorkspaceAuthStatus: () => Promise<{ isLoggedIn: boolean; email: string | null; userId: string | null }>;
  workspaceListWorkspaces: () => Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      createdAt: string;
      role: string;
      isCloud?: boolean;
      ciCdEnabled?: boolean;
      /** Workspace release trigger (amendment §2); absent on older servers = `manual`. */
      intentReleaseTrigger?: IntentReleaseTrigger;
      deliveryEnabled?: boolean;
      /** Per-workspace intent flag; gates the Intent tab. */
      intentEnabled?: boolean;
    }>
  >;
  workspaceCreateWorkspace: (
    name: string,
    slug: string,
  ) => Promise<{ id: string; name: string; slug: string; createdAt: string }>;
  workspaceDeleteWorkspace: (workspaceId: string) => Promise<void>;
  workspaceListMembers: (workspaceId: string) => Promise<
    Array<{
      userId: string;
      email: string;
      displayName: string | null;
      role: string;
      pending: boolean;
      joinedAt: string;
    }>
  >;
  workspaceInviteMember: (
    workspaceId: string,
    email: string,
    role?: string,
  ) => Promise<{ invited: true; emailSent: boolean; expiresAt: string | null; signInUrl: string }>;
  workspaceRemoveMember: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ removed: true; providerCleanupSucceeded: boolean | null }>;
  workspaceListInvites: (workspaceId: string) => Promise<
    Array<{
      id: string;
      email: string;
      role: string;
      state: 'pending' | 'expired';
      emailSent: boolean;
      createdAt: string;
      invitedAt: string;
      expiresAt: string | null;
      lastSentAt: string | null;
    }>
  >;
  workspaceRevokeInvite: (
    workspaceId: string,
    invitationId: string,
  ) => Promise<{ revoked: true; emailRevoked: boolean | null }>;
  workspaceResendInvite: (
    workspaceId: string,
    invitationId: string,
  ) => Promise<{ resent: boolean; emailSent: boolean; expiresAt: string | null; signInUrl: string }>;
  workspaceListRepos: (workspaceId: string) => Promise<
    Array<{
      id: string;
      repoKey: string;
      repoName: string;
      gitUrl: string | null;
      /** Branch whose merges count as production for intent releases; null = connector default. */
      productionBranch?: string | null;
      intentRepoKey?: string | null;
      intentReleaseTrigger?: IntentReleaseTrigger | null;
      createdAt: string;
    }>
  >;
  workspaceConnectRepo: (
    workspaceId: string,
    repoKey: string,
    repoName: string,
    gitUrl?: string,
  ) => Promise<{ id: string; repoKey: string; repoName: string; gitUrl: string | null; createdAt: string }>;
  workspaceDisconnectRepo: (workspaceId: string, repoId: string) => Promise<void>;
  onAuthChange: (
    callback: (status: { isLoggedIn: boolean; email: string | null; userId: string | null; reason?: string }) => void,
  ) => () => void;

  // Cloud Sync
  workspaceEnableCloud: (workspaceId: string, opts?: { ciCdEnabled?: boolean }) => Promise<void>;
  workspaceSetCiCdEnabled: (workspaceId: string, enabled: boolean) => Promise<void>;
  /** Workspace release trigger (amendment §2); admin-only server-side. */
  workspaceSetIntentReleaseTrigger: (workspaceId: string, trigger: IntentReleaseTrigger) => Promise<void>;
  /** Per-repository production branch; `null` restores the connector-reported default. */
  workspaceSetProductionBranch: (workspaceId: string, repoKey: string, branch: string | null) => Promise<void>;
  workspaceSetRepoReleaseTrigger: (
    workspaceId: string,
    repoKey: string,
    trigger: IntentReleaseTrigger | null,
  ) => Promise<void>;
  workspaceSyncToCloud: (
    workspaceId: string,
    repos: SyncToCloudRepoInput[],
    force?: boolean,
  ) => Promise<SyncToCloudResult>;
  workspaceCheckCloudDelta: (
    workspaceId: string,
    repos: Array<{ repoName: string; parsedRepoPath: string }>,
  ) => Promise<{ outdated: boolean }>;
  workspaceGetMcpConfig: (workspaceId: string, tool?: string) => Promise<Record<string, unknown>>;
  workspaceUpdateName: (workspaceId: string, name: string) => Promise<void>;
  workspaceUpdateMemberRole: (workspaceId: string, userId: string, role: string) => Promise<void>;

  // Service Tokens
  workspaceListTokens: (workspaceId: string) => Promise<
    Array<{
      id: string;
      name: string;
      tokenPrefix: string | null;
      permissions: string[];
      expiresAt: string | null;
      createdBy: string;
      createdAt: string;
      lastUsedAt: string | null;
    }>
  >;
  workspaceCreateToken: (
    workspaceId: string,
    name: string,
  ) => Promise<{ id: string; token: string; name: string; permissions: string[] }>;
  workspaceGetTokenValue: (workspaceId: string, tokenId: string) => Promise<{ token: string }>;
  workspaceRevokeToken: (workspaceId: string, tokenId: string) => Promise<void>;

  // Parser Upload
  workspaceUploadParsers: (workspaceId: string) => Promise<{
    uploaded: number;
    skipped: number;
    errors: string[];
  }>;

  // Linked Repos
  getLinkedRepos: (workspaceId: string) => Promise<LinkedRepo[]>;
  linkRepo: (workspaceId: string, repoName: string) => Promise<LinkedRepoLinkResult>;
  removeLinkedRepo: (workspaceId: string, repoName: string) => Promise<void>;

  // Cloud Project
  getCloudRepoStates: (workspaceId: string) => Promise<CloudRepoState[]>;

  // Invited-User Onboarding
  onboardingListSeen: (userId: string) => Promise<string[]>;
  onboardingMarkSeen: (userId: string, workspaceId: string) => Promise<void>;

  // Intent knowledge base (cloud workspaces only). Every method resolves an
  // `IntentResult`, whose `detail` carries the server's structured error body
  // verbatim when a mutation is refused (spec §12).
  intentGetTree: (workspaceId: string, query: IntentTreeQuery) => Promise<IntentResult<IntentTreeResponse>>;
  /** Read-only registry list (intent-dimensions spec); no create/edit/archive method exists here. */
  intentListDimensions: (
    workspaceId: string,
    query: IntentDimensionsQuery,
  ) => Promise<IntentResult<IntentDimensionsResponse>>;
  intentListFeatures: (
    workspaceId: string,
    query: IntentFeaturesQuery,
  ) => Promise<IntentResult<IntentFeaturesResponse>>;
  intentListFeatureSeeds: (
    workspaceId: string,
    featureId: string,
    query: IntentTreeQuery,
  ) => Promise<IntentResult<IntentFeatureSeedsResponse>>;
  intentListSources: (workspaceId: string, search: string) => Promise<IntentResult<IntentSourcesResponse>>;
  intentListItems: (workspaceId: string, query: IntentItemsQuery) => Promise<IntentResult<IntentItemsResponse>>;
  /**
   * One page of waiting candidates plus the workspace summary. This is what a
   * reviewer's tab reads; the size of the queue arrives with the first page
   * instead of being counted by walking it.
   */
  intentReviewQueue: (
    workspaceId: string,
    query: IntentReviewQueueQuery,
  ) => Promise<IntentResult<IntentReviewQueueResponse>>;
  intentGetContext: (workspaceId: string, query: IntentContextQuery) => Promise<IntentResult<IntentContextResponse>>;
  intentListItemTransitions: (
    workspaceId: string,
    itemId: string,
    query: IntentTransitionsQuery,
  ) => Promise<IntentResult<IntentTransitionsResponse>>;
  intentListTransitions: (
    workspaceId: string,
    query: IntentTransitionsQuery,
  ) => Promise<IntentResult<IntentTransitionsResponse>>;
  intentReviewItems: (workspaceId: string, body: IntentReviewRequest) => Promise<IntentResult<IntentReviewResponse>>;
  intentCreateDomain: (
    workspaceId: string,
    body: IntentDomainCreateInput,
  ) => Promise<IntentResult<IntentDomainMutationResponse>>;
  intentUpdateDomain: (
    workspaceId: string,
    body: IntentDomainUpdateInput,
  ) => Promise<IntentResult<IntentDomainMutationResponse>>;
  intentArchiveDomain: (
    workspaceId: string,
    body: IntentArchiveInput,
  ) => Promise<IntentResult<IntentDomainMutationResponse>>;
  intentDeleteDomain: (workspaceId: string, body: IntentDeleteInput) => Promise<IntentResult<IntentDeleteResponse>>;
  intentCreateFeature: (
    workspaceId: string,
    body: IntentFeatureCreateInput,
  ) => Promise<IntentResult<IntentFeatureMutationResponse>>;
  intentUpdateFeature: (
    workspaceId: string,
    body: IntentFeatureUpdateInput,
  ) => Promise<IntentResult<IntentFeatureMutationResponse>>;
  intentArchiveFeature: (
    workspaceId: string,
    body: IntentArchiveInput,
  ) => Promise<IntentResult<IntentFeatureMutationResponse>>;
  intentDeleteFeature: (workspaceId: string, body: IntentDeleteInput) => Promise<IntentResult<IntentDeleteResponse>>;
  intentPutSeed: (workspaceId: string, body: IntentSeedPutInput) => Promise<IntentResult<IntentSeedMutationResponse>>;
  intentDeleteSeed: (workspaceId: string, body: IntentSeedDeleteInput) => Promise<IntentResult<IntentDeleteResponse>>;
  /** Re-capture one anchor's baseline against the current snapshot (admin/owner). */
  intentRefreshAnchor: (
    workspaceId: string,
    body: IntentAnchorRefreshInput,
  ) => Promise<IntentResult<IntentAnchorRefreshResponse>>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
