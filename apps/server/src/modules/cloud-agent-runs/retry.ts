/**
 * In-process retries for the server's GitHub and Jira calls in delivery:
 * up to three retries of transient failures, waits capped at 5 minutes.
 */

/** Injected so suites retry without waiting. */
export const CLOUD_AGENT_RUNS_RETRY_DELAY = Symbol('CLOUD_AGENT_RUNS_RETRY_DELAY');

/** The wait before retry `attempt` (1-based), given the provider's requested delay if any. */
export type RetryDelay = (attempt: number, requestedMs: number | null) => number;

export const MAX_RETRY_WAIT_MS = 5 * 60_000;
const RETRIES = 3;

export const defaultRetryDelay: RetryDelay = (attempt, requestedMs) =>
  Math.min(requestedMs ?? 1_000 * attempt, MAX_RETRY_WAIT_MS);

/**
 * Runs `call`, retrying while `transient` says the error is worth another
 * try (returning the provider's requested delay, or null for the default).
 */
export async function withRetries<T>(
  call: () => Promise<T>,
  transient: (error: unknown) => { retryAfterMs: number | null } | false,
  delay: RetryDelay,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const retry = attempt <= RETRIES ? transient(error) : false;
      if (!retry) throw error;
      const ms = Math.min(delay(attempt, retry.retryAfterMs), MAX_RETRY_WAIT_MS);
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}
