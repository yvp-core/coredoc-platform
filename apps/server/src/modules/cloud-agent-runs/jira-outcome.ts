/**
 * What the run sweep did on Jira for a run, kept in `cloud_agent_runs.jira_outcome`:
 * the done and failure comments, the done transition, and the transitions of
 * the other run events. Each entry is settled at most once.
 */
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import type { JiraTransition } from '../delivery/jira-client.js';

/** One Jira comment's progress on the run (done or failure). */
export interface JiraCommentOutcome {
  state: 'pending' | 'posted' | 'not_posted' | 'skipped';
  attempts: number;
  nextAttemptAt: string | null;
  commentId?: string | null;
  reason?: string | null;
}

/** Run events whose transition the sweep applies on its own; done goes with the done comment. */
export const StatusEvent = { Started: 'started', Failed: 'failed', Cancelled: 'cancelled' } as const;
export type StatusEvent = (typeof StatusEvent)[keyof typeof StatusEvent];

/** One event's transition: queued with the status configured when the event happened. */
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

/**
 * The outcome with this event's transition queued, due now; unchanged when no
 * status is configured (no Jira call at all) or the event already has one.
 */
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

/**
 * A run that ends while its started transition is still pending drops it: a
 * late retry must not move the issue back after the end-of-run transition.
 */
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
