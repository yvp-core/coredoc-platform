import { MAX_RETRY_WAIT_MS, type RetryDelay } from '@coredoc/core/agent-runner';
import { setTimeout as sleep } from 'node:timers/promises';

export const CLOUD_AGENT_RUNS_RETRY_DELAY = Symbol('CLOUD_AGENT_RUNS_RETRY_DELAY');

const RETRIES = 3;

/** `transient` returns the provider's requested delay, or null for the default. */
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
      if (ms > 0) await sleep(ms);
    }
  }
}
