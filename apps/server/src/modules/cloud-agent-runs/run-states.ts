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

/** Outcomes the server records on a completed turn. */
export const TurnOutcome = {
  /** Ended without a run-control call or a question (the nudge rule counts these). */
  NoOutcome: 'no_outcome',
} as const;

/** Server-owned timeline events; agent events (`phase`, `todos`, `raw`, `done`) come from the runner contract. */
export const ServerEventType = {
  StatusChanged: 'status_changed',
  TurnStarted: 'turn_started',
  TurnEnded: 'turn_ended',
} as const;

/** Upper-snake codes on refusals, which the web app and the runner branch on. */
export const CloudAgentRunErrorCode = {
  ActiveRunExists: 'ACTIVE_RUN_EXISTS',
  AgentRunsDisabled: 'AGENT_RUNS_DISABLED',
  RunNotFound: 'RUN_NOT_FOUND',
  LeaseLost: 'LEASE_LOST',
  RunnerIncompatible: 'RUNNER_INCOMPATIBLE',
  InvalidIssueKey: 'INVALID_ISSUE_KEY',
} as const;
export type CloudAgentRunErrorCode = (typeof CloudAgentRunErrorCode)[keyof typeof CloudAgentRunErrorCode];

const ERROR_NAMES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
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
