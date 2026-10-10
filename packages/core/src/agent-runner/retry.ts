/** The wait before retry `attempt` (1-based), given the provider's Retry-After if any. */
export type RetryDelay = (attempt: number, retryAfterMs: number | null) => number;

export const MAX_RETRY_WAIT_MS = 5 * 60_000;

export const defaultRetryDelay: RetryDelay = (attempt, retryAfterMs) =>
  Math.min(retryAfterMs ?? 1_000 * attempt, MAX_RETRY_WAIT_MS);
