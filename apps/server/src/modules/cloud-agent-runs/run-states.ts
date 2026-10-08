/**
 * Closed vocabularies of the cloud agent runs module (SF-001). Stored as
 * VarChar, so these constants are the single source; the hand-written partial
 * indexes in migration 20261010120000 repeat the terminal statuses and the
 * pending turn states.
 */
import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

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

/** Outcomes the server records on a completed turn (failed turns record their failure code). */
export const TurnOutcome = {
  /** Ended without a run-control call or a question (the nudge rule counts these). */
  NoOutcome: 'no_outcome',
  /** Ended after a valid `propose_scope`, published at completion. */
  ScopeProposed: 'scope_proposed',
} as const;

/** The closed set of run failure codes, each with the plain-words message the run page and Jira show. */
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
} as const;
export type RunFailureCode = (typeof RunFailureCode)[keyof typeof RunFailureCode];

export const FAILURE_MESSAGES: Record<RunFailureCode, string> = {
  invalid_repository_label: 'A repository label names no eligible workspace repository.',
  too_many_repositories: 'More repositories were named than the run’s cap allows.',
  issue_not_readable: 'The Jira issue could not be read through the workspace’s Jira connector.',
  run_owner_removed: 'The member this run acts as is no longer in the workspace.',
  connector_inactive: 'The workspace’s Jira or GitHub connector is missing or paused.',
  plugin_missing: 'The workflow plugin or its skills did not load in the runner.',
  agent_error: 'The model or Claude Code failed: authentication, unavailable after retries, or crashed.',
  session_mismatch: 'Claude Code reported a different session than the run expects.',
  repository_not_eligible:
    'A repository cannot be used: no durable key, a remote outside the GitHub connector, not readable with the bot’s token, or the bot is an admin or maintainer there.',
  branch_exists: 'The run branch already exists on the remote and this run did not create it.',
  push_rejected: 'Someone else pushed to the run branch during the turn.',
  secret_scan_blocked: 'The secret scan blocked the push twice.',
  no_outcome: 'The agent stopped twice in a row without finishing.',
  budget_exhausted: 'The run reached its spend limit.',
  wall_clock_exceeded: 'The run’s active time reached its limit.',
  waiting_expired: 'Nobody answered or reviewed within the waiting limit.',
  no_changes: 'The agent finished without changing any repository.',
  github_error: 'GitHub refused a request or kept failing while the agent worked.',
  jira_error: 'Jira kept failing while the PRD was being read.',
  archive_too_large: 'The agent’s saved session grew beyond the allowed size.',
  report_limit_exceeded: 'The runner sent more events, proposals or questions than a turn allows.',
  delivery_failed: 'Opening or verifying the pull requests, or posting the Jira done comment, failed.',
  runner_lost: 'The agent runner stopped responding during the same turn three times.',
};

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
} as const;

/** Server-owned timeline events; agent events (`phase`, `todos`, `raw`, `done`) come from the runner contract. */
export const ServerEventType = {
  StatusChanged: 'status_changed',
  TurnStarted: 'turn_started',
  TurnEnded: 'turn_ended',
  RunEvent: 'run_event',
} as const;

/** Upper-snake codes on refusals, which the web app and the runner branch on. */
export const CloudAgentRunErrorCode = {
  ActiveRunExists: 'ACTIVE_RUN_EXISTS',
  AgentRunsDisabled: 'AGENT_RUNS_DISABLED',
  RunNotFound: 'RUN_NOT_FOUND',
  LeaseLost: 'LEASE_LOST',
  RunnerIncompatible: 'RUNNER_INCOMPATIBLE',
  InvalidIssueKey: 'INVALID_ISSUE_KEY',
  IssueNotReadable: 'ISSUE_NOT_READABLE',
  RunTerminal: 'RUN_TERMINAL',
  RunStateConflict: 'RUN_STATE_CONFLICT',
  SpecVersionStale: 'SPEC_VERSION_STALE',
  ArchiveTooLarge: 'ARCHIVE_TOO_LARGE',
  ArchiveNotFound: 'ARCHIVE_NOT_FOUND',
} as const;
export type CloudAgentRunErrorCode = (typeof CloudAgentRunErrorCode)[keyof typeof CloudAgentRunErrorCode];

const ERROR_NAMES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
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

/** Refusal settings show for a runner token. */
export const RunnerRefusal = {
  /** The token's creator left the workspace or is no longer an admin. */
  CreatorNotAdmin: 'creator_not_admin',
  /** The runner's protocol version is not supported by this server. */
  RunnerIncompatible: 'runner_incompatible',
} as const;
