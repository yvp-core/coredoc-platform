/** Each entry is settled at most once. */
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import type { JiraTransition } from '../delivery/jira-client.js';

export interface JiraCommentOutcome {
  state: 'pending' | 'posted' | 'not_posted' | 'skipped';
  attempts: number;
  nextAttemptAt: string | null;
  commentId?: string | null;
  reason?: string | null;
}

/** The done transition is not here: it goes with the done comment. */
export enum StatusEvent {
  Started = 'started',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/** `status` is the one configured when the event happened. */
export interface StatusTransitionOutcome {
  status: string;
  /** `superseded`: the run ended before a started transition went out, so it never will. */
  state: 'pending' | 'transitioned' | 'already_in_status' | 'skipped' | 'warning' | 'superseded';
  attempts: number;
  nextAttemptAt: string | null;
  reason?: string | null;
}

export interface RunJiraOutcome {
  done?: JiraCommentOutcome;
  failure?: JiraCommentOutcome;
  /** The done transition. */
  transition?: { outcome: string; reason?: string | null };
  transitions?: Partial<Record<StatusEvent, StatusTransitionOutcome>>;
}

export function jiraOutcomeOf(run: Pick<CloudAgentRun, 'jiraOutcome'>): RunJiraOutcome {
  const value = run.jiraOutcome;
  return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as RunJiraOutcome;
}

/** Unchanged when no status is configured or the event already has one. */
export function queueStatusTransition(
  outcome: RunJiraOutcome,
  event: StatusEvent,
  status: string | null | undefined,
  at: Date,
): RunJiraOutcome {
  if (!status || outcome.transitions?.[event]) return outcome;
  const queued: StatusTransitionOutcome = { status, state: 'pending', attempts: 0, nextAttemptAt: at.toISOString() };
  return { ...outcome, transitions: { ...outcome.transitions, [event]: queued } };
}

/** A late retry must not move the issue back after the end-of-run transition. */
export function supersedeStartedTransition(outcome: RunJiraOutcome): RunJiraOutcome {
  const started = outcome.transitions?.started;
  if (started?.state !== 'pending') return outcome;
  return {
    ...outcome,
    transitions: { ...outcome.transitions, started: { ...started, state: 'superseded', nextAttemptAt: null } },
  };
}

/** Jira status names compare without regard to case. */
export function sameStatusName(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The transition to the status with this name, preferring one without a screen. */
export function transitionTo(transitions: JiraTransition[], status: string): JiraTransition | undefined {
  return transitions
    .filter((transition) => sameStatusName(transition.to?.name, status))
    .sort((a, b) => Number(Boolean(a.hasScreen)) - Number(Boolean(b.hasScreen)))[0];
}
