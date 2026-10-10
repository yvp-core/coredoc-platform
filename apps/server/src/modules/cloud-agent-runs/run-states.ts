/**
 * Stored as VarChar; the hand-written partial indexes in migration
 * 20261010120000 repeat the terminal statuses and the pending turn states.
 */
import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import {
  QuestionsPolicy,
  RunFailureCode,
  type RunnerStartupProblemCode,
  ScopeAcceptancePolicy,
  TurnKind,
} from '@coredoc/core/agent-runner';

export enum RunStatus {
  Queued = 'queued',
  Scoping = 'scoping',
  AwaitingAnswer = 'awaiting_answer',
  AwaitingScopeAcceptance = 'awaiting_scope_acceptance',
  Implementing = 'implementing',
  Delivering = 'delivering',
  Done = 'done',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [RunStatus.Done, RunStatus.Failed, RunStatus.Cancelled];

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** A run's phase is the kind of turn it runs. */
export { TurnKind as RunPhase };

export enum RunTrigger {
  JiraLabel = 'jira_label',
  Manual = 'manual',
  Rerun = 'rerun',
}

export enum TurnState {
  Queued = 'queued',
  Claimed = 'claimed',
  Completed = 'completed',
  Abandoned = 'abandoned',
}

/** Counted at claim, so a re-queued turn (lost lease, unavailable model) consumes an attempt. */
export const MAX_TURN_ATTEMPTS = 3;

export enum TurnOutcome {
  NoOutcome = 'no_outcome',
  ScopeProposed = 'scope_proposed',
  QuestionAsked = 'question_asked',
  /** Neither counted by nor resetting the nudge rule. */
  Checkpoint = 'checkpoint',
  ResultSubmitted = 'result_submitted',
  Delivered = 'delivered',
  RepositoryRequested = 'repository_requested',
  RunnerLost = 'runner_lost',
  ModelUnavailable = 'model_unavailable',
}

export enum QuestionKind {
  Clarification = 'clarification',
  RepositoryRequest = 'repository_request',
}

export enum QuestionState {
  Open = 'open',
  Answered = 'answered',
  AutoAnswered = 'auto_answered',
  Cancelled = 'cancelled',
}

export { QuestionsPolicy, RunFailureCode, ScopeAcceptancePolicy };

/** `draft` is the running turn's proposal, hidden from people. */
export enum SpecStatus {
  Draft = 'draft',
  Proposed = 'proposed',
  Accepted = 'accepted',
  ChangesRequested = 'changes_requested',
  Superseded = 'superseded',
}

export enum RunEventCode {
  ScopeProposed = 'scope_proposed',
  ScopeAccepted = 'scope_accepted',
  ChangesRequested = 'changes_requested',
  BranchPushed = 'branch_pushed',
  WorkflowDiffWithheld = 'workflow_diff_withheld',
  PullRequestOpened = 'pull_request_opened',
  JiraCommented = 'jira_commented',
  JiraTransitioned = 'jira_transitioned',
  TransitionSkipped = 'transition_skipped',
  Warning = 'warning',
  RepositoryAdded = 'repository_added',
  RepositoryDeclined = 'repository_declined',
}

/** Agent event types come from the runner contract. */
export enum ServerEventType {
  StatusChanged = 'status_changed',
  TurnStarted = 'turn_started',
  TurnEnded = 'turn_ended',
  RunEvent = 'run_event',
  Question = 'question',
  QuestionResolved = 'question_resolved',
}

/** Upper-snake codes on refusals, which the web app and the runner branch on. */
export enum CloudAgentRunErrorCode {
  ActiveRunExists = 'ACTIVE_RUN_EXISTS',
  AgentRunsDisabled = 'AGENT_RUNS_DISABLED',
  AgentRunsUnavailable = 'AGENT_RUNS_UNAVAILABLE',
  IssueNotReadable = 'ISSUE_NOT_READABLE',
  JiraUnavailable = 'JIRA_UNAVAILABLE',
  UnknownRepository = 'UNKNOWN_REPOSITORY',
  TooManyRepositories = 'TOO_MANY_REPOSITORIES',
  RunNotTerminal = 'RUN_NOT_TERMINAL',
  RunNotFound = 'RUN_NOT_FOUND',
  LeaseLost = 'LEASE_LOST',
  RunnerIncompatible = 'RUNNER_INCOMPATIBLE',
  InvalidIssueKey = 'INVALID_ISSUE_KEY',
  RunTerminal = 'RUN_TERMINAL',
  RunStateConflict = 'RUN_STATE_CONFLICT',
  SpecVersionStale = 'SPEC_VERSION_STALE',
  QuestionAlreadyAnswered = 'QUESTION_ALREADY_ANSWERED',
  QuestionNotFound = 'QUESTION_NOT_FOUND',
  ArchiveTooLarge = 'ARCHIVE_TOO_LARGE',
  ArchiveNotFound = 'ARCHIVE_NOT_FOUND',
  TranscriptNotFound = 'TRANSCRIPT_NOT_FOUND',
  TranscriptTooLarge = 'TRANSCRIPT_TOO_LARGE',
  InvalidReport = 'INVALID_REPORT',
  RateLimited = 'RATE_LIMITED',
}

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

export enum RunnerRefusal {
  CreatorNotAdmin = 'creator_not_admin',
  RunnerIncompatible = 'runner_incompatible',
  StartupCheckFailed = 'startup_check_failed',
}

/** What settings show as a runner token's last report; `agent_runner_seen.last_action` holds 16 characters. */
export enum RunnerSeenAction {
  Claim = 'claim',
  Heartbeat = 'heartbeat',
  StartupCheck = 'startup_check',
}

/**
 * Narrows a VarChar column to its enum. The server writes only enum values,
 * so anything else is a corrupt row and fails loudly instead of being guessed.
 */
export function fromColumn<E extends Record<string, string>>(values: E, raw: string): E[keyof E] {
  if ((Object.values(values) as string[]).includes(raw)) return raw as E[keyof E];
  throw new Error(`Unexpected stored value ${JSON.stringify(raw)}`);
}
