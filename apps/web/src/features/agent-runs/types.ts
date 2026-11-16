/** Restated from apps/server cloud-agent-runs: server modules are not importable from the browser bundle. */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_answer'
  | 'awaiting_scope_acceptance'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'cancelled';

/** A phase id of the run's workflow, or `delivery`. */
export type TurnKind = string;

export interface WorkflowPhase {
  id: string;
  /** `acceptance`: the phase ends with a proposal a person accepts or sends back. */
  gate: 'acceptance' | 'none';
  model?: string;
  effort?: string;
}

/** The workflow a run started with. */
export interface RunWorkflow {
  id: string;
  title: string;
  repositories: 'write' | 'none';
  delivery: 'pull-request' | 'none';
  phases: WorkflowPhase[];
}

export type WorkflowAccess = { minRole: 'member' | 'admin' } | { members: string[] };

/** A workflow the workspace's runners advertise; `startable` and `reason` are for the calling member. */
export interface AgentRunWorkflow extends RunWorkflow {
  access: WorkflowAccess;
  startable: boolean;
  reason: string | null;
}

/** A failed turn records its failure code instead. */
export type TurnOutcome =
  | 'no_outcome'
  | 'scope_proposed'
  | 'question_asked'
  | 'checkpoint'
  | 'result_submitted'
  | 'delivered'
  | 'repository_requested'
  | 'runner_lost'
  | 'model_unavailable';
type TurnState = 'queued' | 'claimed' | 'completed' | 'abandoned';

interface AgentRunTurn {
  id: string;
  kind: TurnKind;
  state: TurnState;
  ordinal: number;
  attempt: number;
  queuedAt: string;
  claimedAt: string | null;
}

export type QuestionsPolicy = 'pause' | 'assume';

export interface AgentRun {
  id: string;
  issueKey: string;
  workflow: RunWorkflow;
  status: RunStatus;
  phase: TurnKind;
  trigger: 'jira_label' | 'manual' | 'rerun';
  startedBy: string | null;
  previousRunId: string | null;
  runOwner: { userId: string; email: string | null };
  scopeQuestionsPolicy: QuestionsPolicy;
  implementQuestionsPolicy: QuestionsPolicy;
  scopeAcceptancePolicy: 'required' | 'automatic';
  model: string | null;
  branch: string;
  /** Repository keys named by labels or the start request. */
  seeds: string[];
  notes: string | null;
  failureCode: string | null;
  failureReason: string | null;
  continuations: number;
  spend: { usd: number; maxUsd: number; unknownTurns: number };
  /** The queued or claimed turn, if any. */
  currentTurn: AgentRunTurn | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface SpecRepository {
  key: string;
  reason: string;
  changes: string;
  mergeOrder: number;
  eligible: boolean;
  ineligibleReason: string | null;
  /** Absent for the default branch. */
  baseBranch?: string;
}

export interface AgentRunSpec {
  version: number;
  status: 'proposed' | 'accepted' | 'changes_requested' | 'superseded';
  title: string;
  summary: string;
  markdown: string;
  repositories: SpecRepository[];
  risks: string[];
  intentReferences: string[];
  assumptions: string[];
  droppedSeeds: Array<{ key: string; reason: string }>;
  /** Product questions the PRD leaves open, each with what it blocks. */
  candidates: Array<{ question: string; blocks: string }>;
  proposedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewText: string | null;
  autoAccepted: boolean;
}

/** One clarification in Claude Code's AskUserQuestion shape. */
export interface AskedQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

/** Per question, in order: the chosen option labels and an optional free-text "Other". */
export interface QuestionAnswer {
  labels: string[];
  other?: string;
}

export interface AgentRunQuestion {
  requestId: string;
  kind: 'clarification' | 'repository_request';
  phase: TurnKind;
  state: 'open' | 'answered' | 'auto_answered' | 'cancelled';
  questions: AskedQuestion[];
  answers: QuestionAnswer[] | null;
  askedAt: string;
  answeredAt: string | null;
  /** Null when answered automatically. */
  answeredBy: string | null;
  /** The turn that asked; absent from servers that predate it. */
  askedInTurnId?: string | null;
}

interface AgentRunAssumption {
  phase: TurnKind;
  text: string;
}

interface RunRepository {
  key: string;
  reason: string;
  mergeOrder: number;
  origin: string;
  eligible: boolean;
  /** True once the run pushed its branch here. */
  touched?: boolean;
  lastPushedHead?: string | null;
  /** The agent's reason when it could not build or test the repository in the runner. */
  notBuiltOrTested?: string | null;
  /** Paths the latest implement turn left out of the push. */
  withheldPaths?: string[];
}

export interface AgentRunResult {
  summary: string;
  repositories: Array<{ key: string; summary: string }>;
  notes: string;
}

/** A pull request the server read back from GitHub and confirmed is the run branch's. */
export interface AgentRunPullRequest {
  repository: string;
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  created: boolean;
  verifiedAt: string;
}

export interface AgentRunJiraComment {
  state: 'pending' | 'posted' | 'not_posted' | 'skipped';
  attempts: number;
  nextAttemptAt: string | null;
  commentId?: string | null;
  reason?: string | null;
}

export interface AgentRunJiraOutcome {
  done?: AgentRunJiraComment;
  failure?: AgentRunJiraComment;
  transition?: { outcome: string; reason?: string | null };
}

export interface AgentRunDetail extends AgentRun {
  /** The issue on the Jira connector's site; null when the connector has no site URL. */
  issueUrl: string | null;
  latestSpec: AgentRunSpec | null;
  repositories: RunRepository[];
  result?: AgentRunResult | null;
  pullRequests?: AgentRunPullRequest[];
  jiraOutcome?: AgentRunJiraOutcome;
  droppedSeeds: Array<{ key: string; reason: string }>;
  assumptions: AgentRunAssumption[];
  openQuestion: AgentRunQuestion | null;
  /** Every question of the run, oldest first. */
  questions: AgentRunQuestion[];
}

export interface AgentRunList {
  runs: AgentRun[];
  nextOffset: number | null;
}

export interface AgentRunEvent {
  seq: number;
  /** The turn whose runner reported it, or which it records; null for run-level events. */
  turnId?: string | null;
  type: string;
  payload: Record<string, unknown>;
  truncated: boolean;
  createdAt: string;
}

export interface AgentRunTurnActivity {
  id: string;
  ordinal: number;
  kind: TurnKind;
  state: 'queued' | 'claimed' | 'completed' | 'abandoned';
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  spendUsd: number | null;
  toolCalls: number;
  failedToolCalls: number;
}

/** An intent item the agent read or proposed; the nulls are an item that no longer exists. */
export interface AgentRunIntentRef {
  id: string;
  title: string | null;
  kind: string | null;
  authority: 'candidate' | 'accepted' | 'rejected' | 'superseded' | null;
  /** The domain and feature titles, joined; null for a product-level item. */
  location: string | null;
}

export interface AgentRunActivity {
  turns: AgentRunTurnActivity[];
  skills: Array<{ name: string; count: number }>;
  /** `server` is set for MCP tools. */
  tools: Array<{ name: string; server: string | null; count: number }>;
  /** Absent from servers that predate it. */
  intent?: { read: AgentRunIntentRef[]; proposed: AgentRunIntentRef[] };
}

export interface AgentRunEventPage {
  events: AgentRunEvent[];
  lastSeq: number;
}

type RunnerRefusal = 'creator_not_admin' | 'runner_incompatible' | 'startup_check_failed';

export interface RunnerTokenStatus {
  id: string;
  name: string;
  tokenPrefix: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastAction: 'claim' | 'heartbeat' | 'startup_check' | null;
  protocolVersion: number | null;
  versions: {
    runner?: string;
    sdk?: string;
    claudeCode?: string;
    plugin?: string;
    manifest?: {
      digest?: string;
      plugins: Array<{ name: string; version?: string }>;
      /** Absent from rows a runner reported before workflows. */
      workflows?: Array<Pick<AgentRunWorkflow, 'id' | 'title' | 'phases'>>;
    };
  } | null;
  refusal: RunnerRefusal | null;
  refusalDetail: string | null;
}

export interface AvailabilityReason {
  code: string;
  message: string;
}

export interface RepositoryEligibility {
  /** The durable repository key; null until pushed with a current CLI or desktop. */
  key: string | null;
  name: string;
  eligible: boolean;
  reason: string | null;
}

export interface AgentRunSettings {
  enabled: boolean;
  runOwner: { userId: string; email: string | null; valid: boolean } | null;
  triggerLabel: string;
  /** Jira status names the issue moves to on each run event; null leaves Jira unchanged. */
  startedStatus: string | null;
  doneStatus: string | null;
  failedStatus: string | null;
  cancelledStatus: string | null;
  scopeQuestionsPolicy: QuestionsPolicy;
  implementQuestionsPolicy: QuestionsPolicy;
  scopeAcceptancePolicy: 'required' | 'automatic';
  maxSpendUsd: number;
  maxTurnDurationSeconds: number;
  maxActiveSeconds: number;
  waitingLimitSeconds: number;
  maxStartedRuns: number;
  maxRepositories: number;
  model: string | null;
  /** A workflow left out is open to every member. */
  workflowAccess: Record<string, WorkflowAccess>;
  /** Start, re-run and promotion need this. */
  availability: { available: boolean; reasons: AvailabilityReason[] };
  /** The Jira trigger additionally needs a valid run owner and a project key. */
  trigger: { ready: boolean; projectKeys: string[]; reasons: AvailabilityReason[] };
  repositories: RepositoryEligibility[];
  runnerTokens: RunnerTokenStatus[];
}

export type AgentRunSettingsUpdate = Partial<
  Pick<
    AgentRunSettings,
    | 'triggerLabel'
    | 'startedStatus'
    | 'doneStatus'
    | 'failedStatus'
    | 'cancelledStatus'
    | 'scopeQuestionsPolicy'
    | 'implementQuestionsPolicy'
    | 'scopeAcceptancePolicy'
    | 'maxSpendUsd'
    | 'maxTurnDurationSeconds'
    | 'maxActiveSeconds'
    | 'waitingLimitSeconds'
    | 'maxStartedRuns'
    | 'maxRepositories'
    | 'model'
    | 'workflowAccess'
  >
> & { takeOverOwnership?: true };

export interface JiraStatusChoices {
  statuses: string[];
}
