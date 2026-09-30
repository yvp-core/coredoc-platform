/**
 * A tiny in-memory token-bucket rate limiter — the DoS boundary the browser-
 * reachable `/graph/*` surface needs (docs/web-ui-plan-2026-07.md §3.2, risk 2).
 * No Redis (rejected — not in the stack), no npm dep: a `Map` of per-key buckets
 * with lazy time-based refill.
 *
 * Deliberately per-process: on the single-replica on-prem deployment it is the
 * whole story; on a future multi-replica SaaS it degrades to per-replica limits,
 * which is a safe, strictly-more-permissive fallback, not a correctness bug. The
 * clock is injectable so the refill math is unit-testable without wall-clock
 * flake.
 */

export interface TokenBucketOptions {
  /** Bucket capacity — the maximum burst of requests allowed at once. */
  capacity: number;
  /** Sustained refill rate, in tokens per second. */
  refillPerSec: number;
  /** Injectable clock (ms). Defaults to Date.now; override in tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  /** Last refill timestamp (ms). */
  updatedAt: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Try to spend one token for `key`. Returns true when allowed (token spent),
   * false when the bucket is empty (caller should reject with 429). Refills
   * lazily based on elapsed time since the last touch.
   */
  tryRemove(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      // First hit for this key: full bucket, spend one.
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Drop buckets that have sat untouched long enough to have fully refilled —
   * they carry no state worth keeping, so evicting them bounds memory under a
   * churn of distinct keys. Call opportunistically; not required for correctness.
   */
  evictFull(maxIdleMs: number): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= maxIdleMs) this.buckets.delete(key);
    }
  }
}
