/**
 * Closed vocabularies of the cloud agent runs module. Stored as
 * VarChar, so these constants are the single source; the hand-written partial
 * indexes in migration 20261010120000 repeat the terminal statuses and the
 * pending turn states.
 */
import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import type { RunFailureCode as ContractFailureCode, RunnerStartupProblemCode } from '@coredoc/core/agent-runner';

export const RunStatus = {
  Queued: 'queued',
  Scoping: 'scoping',
  AwaitingAnswer: 'awaiting_answer',
  AwaitingScopeAcceptance: 'awaiting_scope_acceptance',
  Implementing: 'implementing',
  Delivering: 'delivering',
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [RunStatus.Done, RunStatus.Failed, RunStatus.Cancelled];

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const RunPhase = { Scope: 'scope', Implement: 'implement', Delivery: 'delivery' } as const;

export const RunTrigger = { JiraLabel: 'jira_label', Manual: 'manual', Rerun: 'rerun' } as const;

export const TurnState = {
  Queued: 'queued',
  Claimed: 'claimed',
  Completed: 'completed',
  Abandoned: 'abandoned',
} as const;
export type TurnState = (typeof TurnState)[keyof typeof TurnState];

/**
 * Attempts are counted at claim. A turn re-queued for a lost lease or an
 * unavailable model fails the run on its third attempt.
 */
export const MAX_TURN_ATTEMPTS = 3;

/** Outcomes the server records on a completed turn (failed turns record their failure code). */
export const TurnOutcome = {
  /** Ended without a run-control call or a question (the nudge rule counts these). */
  NoOutcome: 'no_outcome',
  /** Ended after a valid `propose_scope`, published at completion. */
  ScopeProposed: 'scope_proposed',
  /** Ended with a question parked for a person (pause policy). */
  QuestionAsked: 'question_asked',
  /** Reached the duration limit or the SDK turn cap: continued, neither counted nor resetting the nudge rule. */
  Checkpoint: 'checkpoint',
  /** Ended after a valid `submit_result`. */
  ResultSubmitted: 'result_submitted',
  /** A delivery turn whose pull requests were all verified; the done comment follows. */
  Delivered: 'delivered',
  /** Ended after `request_repo` under required acceptance: a person decides. */
  RepositoryRequested: 'repository_requested',
  /** The lease expired without a completion: the turn was re-queued, or the run failed on the third loss. */
  RunnerLost: 'runner_lost',
  /** The model stayed unavailable through Claude Code's retries: re-queued like a lost lease, attempt consumed. */
  ModelUnavailable: 'model_unavailable',
} as const;

export const QuestionKind = { Clarification: 'clarification', RepositoryRequest: 'repository_request' } as const;

export const QuestionState = {
  Open: 'open',
  Answered: 'answered',
  /** Answered by the runner at once under the assume policy. */
  AutoAnswered: 'auto_answered',
  /** The run ended while the question was open. */
  Cancelled: 'cancelled',
} as const;

/** Named run failure codes; the closed set and its messages are in the shared contract and failure-codes.ts. */
export const RunFailureCode = {
  InvalidRepositoryLabel: 'invalid_repository_label',
  TooManyRepositories: 'too_many_repositories',
  IssueNotReadable: 'issue_not_readable',
  RunOwnerRemoved: 'run_owner_removed',
  ConnectorInactive: 'connector_inactive',
  PluginMissing: 'plugin_missing',
  AgentError: 'agent_error',
  SessionMismatch: 'session_mismatch',
  RepositoryNotEligible: 'repository_not_eligible',
  BranchExists: 'branch_exists',
  PushRejected: 'push_rejected',
  SecretScanBlocked: 'secret_scan_blocked',
  NoOutcome: 'no_outcome',
  BudgetExhausted: 'budget_exhausted',
  WallClockExceeded: 'wall_clock_exceeded',
  WaitingExpired: 'waiting_expired',
  NoChanges: 'no_changes',
  GithubError: 'github_error',
  JiraError: 'jira_error',
  ArchiveTooLarge: 'archive_too_large',
  ReportLimitExceeded: 'report_limit_exceeded',
  DeliveryFailed: 'delivery_failed',
  RunnerLost: 'runner_lost',
} as const satisfies Record<string, ContractFailureCode>;
export type RunFailureCode = ContractFailureCode;

/** Spec version lifecycle; `draft` is the running turn's proposal, hidden from people. */
export const SpecStatus = {
  Draft: 'draft',
  Proposed: 'proposed',
  Accepted: 'accepted',
  ChangesRequested: 'changes_requested',
  Superseded: 'superseded',
} as const;

/** Codes of the generic `run_event` timeline entry. */
export const RunEventCode = {
  ScopeProposed: 'scope_proposed',
  ScopeAccepted: 'scope_accepted',
  ChangesRequested: 'changes_requested',
  BranchPushed: 'branch_pushed',
  WorkflowDiffWithheld: 'workflow_diff_withheld',
  PullRequestOpened: 'pull_request_opened',
  JiraCommented: 'jira_commented',
  JiraTransitioned: 'jira_transitioned',
  TransitionSkipped: 'transition_skipped',
  Warning: 'warning',
  RepositoryAdded: 'repository_added',
  RepositoryDeclined: 'repository_declined',
} as const;

/** Server-owned timeline events; agent events (`phase`, `todos`, `message`, `tool`, `skill`, `result`, `raw`, `done`) come from the runner contract. */
export const ServerEventType = {
  StatusChanged: 'status_changed',
  TurnStarted: 'turn_started',
  TurnEnded: 'turn_ended',
  RunEvent: 'run_event',
  /** A question the agent asked, open or answered at once. */
  Question: 'question',
  /** A person answered, or the run ended while it was open. */
  QuestionResolved: 'question_resolved',
} as const;

/** Upper-snake codes on refusals, which the web app and the runner branch on. */
export const CloudAgentRunErrorCode = {
  ActiveRunExists: 'ACTIVE_RUN_EXISTS',
  AgentRunsDisabled: 'AGENT_RUNS_DISABLED',
  AgentRunsUnavailable: 'AGENT_RUNS_UNAVAILABLE',
  IssueNotReadable: 'ISSUE_NOT_READABLE',
  /** Jira kept failing while a manual start read the issue. */
  JiraUnavailable: 'JIRA_UNAVAILABLE',
  UnknownRepository: 'UNKNOWN_REPOSITORY',
  TooManyRepositories: 'TOO_MANY_REPOSITORIES',
  RunNotTerminal: 'RUN_NOT_TERMINAL',
  RunNotFound: 'RUN_NOT_FOUND',
  LeaseLost: 'LEASE_LOST',
  RunnerIncompatible: 'RUNNER_INCOMPATIBLE',
  InvalidIssueKey: 'INVALID_ISSUE_KEY',
  RunTerminal: 'RUN_TERMINAL',
  RunStateConflict: 'RUN_STATE_CONFLICT',
  SpecVersionStale: 'SPEC_VERSION_STALE',
  QuestionAlreadyAnswered: 'QUESTION_ALREADY_ANSWERED',
  QuestionNotFound: 'QUESTION_NOT_FOUND',
  ArchiveTooLarge: 'ARCHIVE_TOO_LARGE',
  ArchiveNotFound: 'ARCHIVE_NOT_FOUND',
  /** The run's state archive holds no transcript for the phase, or there is no archive yet. */
  TranscriptNotFound: 'TRANSCRIPT_NOT_FOUND',
  /** The transcript is over MAX_TRANSCRIPT_BYTES; it is not downloaded. */
  TranscriptTooLarge: 'TRANSCRIPT_TOO_LARGE',
  /** A runner report that contradicts the run (a repository outside it, a push to an unreserved branch). */
  InvalidReport: 'INVALID_REPORT',
  /** The runner token sent more requests than its rate limit allows. */
  RateLimited: 'RATE_LIMITED',
} as const;
export type CloudAgentRunErrorCode = (typeof CloudAgentRunErrorCode)[keyof typeof CloudAgentRunErrorCode];

const ERROR_NAMES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

/** A typed refusal: `{ statusCode, error, code, message }`, the shape the web client parses. */
export function cloudAgentRunError(
  code: CloudAgentRunErrorCode,
  message: string,
  status: HttpStatus = HttpStatus.CONFLICT,
): HttpException {
  const body = { statusCode: status, error: ERROR_NAMES[status] ?? 'Error', code, message };
  return status === HttpStatus.CONFLICT ? new ConflictException(body) : new HttpException(body, status);
}

/** How settings word each start-up problem a runner reports; runner text is only ever the masked detail. */
export const RUNNER_STARTUP_PROBLEM_TEXT: Record<RunnerStartupProblemCode, string> = {
  sdk_unusable: 'The Agent SDK could not start Claude Code in the runner image.',
  plugin_missing: 'Claude Code did not load the coredoc-workflows plugin from its configured path.',
  plugin_errors: 'The coredoc-workflows plugin loaded with errors.',
  plugin_skills_missing: 'The coredoc-workflows plugin loaded without its skills.',
  bot_admin:
    'The bot account has admin or maintain permission on a repository it can see; give it the Write role only.',
  bot_unreadable:
    "GitHub refused or failed to list the bot account's repositories; check the bot token and the GitHub API URL.",
  registry_config_invalid: 'COREDOC_PACKAGE_REGISTRIES in the runner Secret is not valid.',
};

/** Refusal settings show for a runner token. */
export const RunnerRefusal = {
  /** The token's creator left the workspace or is no longer an admin. */
  CreatorNotAdmin: 'creator_not_admin',
  /** The runner's protocol version is not supported by this server. */
  RunnerIncompatible: 'runner_incompatible',
  /** The runner's start-up check failed (the plugin does not load, the bot is an admin, …); it claims nothing. */
  StartupCheckFailed: 'startup_check_failed',
} as const;
