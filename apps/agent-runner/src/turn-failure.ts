import type { RunnerFailureCode } from '@coredoc/core/agent-runner';

/** A failure the runner detects during a turn; it fails the run with this code through `complete`. */
export class TurnFailure extends Error {
  constructor(
    readonly code: RunnerFailureCode,
    reason: string,
  ) {
    super(reason.slice(0, 2_000));
    this.name = 'TurnFailure';
  }
}

/** GitHub calls retry in process up to three times (four attempts), then fail the run. */
export const GITHUB_ATTEMPTS = 4;
/** Retry-After is honoured up to this. */
export const MAX_RETRY_WAIT_MS = 5 * 60_000;

export type RetryDelay = (attempt: number, retryAfterMs: number | null) => number;

export const defaultRetryDelay: RetryDelay = (attempt, retryAfterMs) =>
  Math.min(retryAfterMs ?? 1_000 * attempt, MAX_RETRY_WAIT_MS);

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
