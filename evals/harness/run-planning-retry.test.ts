// evals/harness/run-planning-retry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { isTransientError, withRetry } from './run-planning.js';

describe('isTransientError', () => {
  it('detects 529 overloaded error', () => {
    expect(isTransientError('API Error: 529 overloaded_error')).toBe(true);
  });

  it('detects 429 rate limit', () => {
    expect(isTransientError('Error 429: rate limit exceeded')).toBe(true);
  });

  it('detects "overloaded" keyword', () => {
    expect(isTransientError('Service is overloaded, please retry')).toBe(true);
  });

  it('detects ECONNRESET', () => {
    expect(isTransientError('read ECONNRESET')).toBe(true);
  });

  it('does NOT flag non-transient errors', () => {
    expect(isTransientError('max turns exceeded')).toBe(false);
  });

  it('does NOT flag null', () => {
    expect(isTransientError(null)).toBe(false);
  });

  it('does NOT flag undefined', () => {
    expect(isTransientError(undefined)).toBe(false);
  });

  it('does NOT flag empty string', () => {
    expect(isTransientError('')).toBe(false);
  });
});

describe('withRetry — thrown transient then succeeds', () => {
  it('retries a transient thrown error and resolves on second attempt', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('529 Overloaded');
      return 'success';
    });

    const result = await withRetry('test-label', attempt, () => null, 3, [0, 0]);
    expect(result).toBe('success');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry — non-transient thrown error is not retried', () => {
  it('rethrows a non-transient error immediately', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('validation failed: schema mismatch');
    });

    await expect(withRetry('test-label', attempt, () => null, 3, [0, 0])).rejects.toThrow(
      'validation failed: schema mismatch',
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — result-based retryable path', () => {
  it('retries when isRetryable returns a message, accepts the fixed result', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      return calls === 1 ? { error: '529' } : { error: null };
    });

    const result = await withRetry(
      'test-label',
      attempt,
      (r) => (r.error ? r.error : null),
      3,
      [0, 0],
    );
    expect(result).toEqual({ error: null });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('returns last result on final attempt even if still retryable', async () => {
    const attempt = vi.fn(async () => ({ error: '529' }));

    const result = await withRetry(
      'test-label',
      attempt,
      (r) => (r.error ? r.error : null),
      2,
      [0],
    );
    // After 2 attempts still error — returns best-effort last result.
    expect(result).toEqual({ error: '529' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
