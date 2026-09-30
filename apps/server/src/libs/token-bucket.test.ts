import { describe, it, expect } from 'vitest';
import { TokenBucketRateLimiter } from './token-bucket.js';

describe('TokenBucketRateLimiter', () => {
  it('allows up to capacity in a burst, then rejects', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSec: 1, now: () => 1000 });
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(false);
  });

  it('isolates buckets per key', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 });
    expect(limiter.tryRemove('a')).toBe(true);
    expect(limiter.tryRemove('a')).toBe(false);
    // A different principal has its own full bucket.
    expect(limiter.tryRemove('b')).toBe(true);
  });

  it('refills over elapsed time, capped at capacity', () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 1, now: () => clock });
    expect(limiter.tryRemove('u1')).toBe(true); // 1 left
    expect(limiter.tryRemove('u1')).toBe(true); // 0 left
    expect(limiter.tryRemove('u1')).toBe(false); // empty

    clock = 1000; // +1s → +1 token
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(false);

    clock = 100_000; // long idle → refill clamps at capacity (2), not unbounded
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(true);
    expect(limiter.tryRemove('u1')).toBe(false);
  });

  it('evictFull drops only buckets idle past the threshold', () => {
    let clock = 0;
    // refillPerSec 0 isolates eviction from time-based refill: the only way the
    // bucket comes back is being evicted and recreated full.
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSec: 0, now: () => clock });
    limiter.tryRemove('u1'); // spend the one token
    clock = 5000;
    limiter.evictFull(10_000); // u1 idle 5s < 10s → kept (still empty, no refill)
    expect(limiter.tryRemove('u1')).toBe(false);

    clock = 20_000;
    limiter.evictFull(10_000); // u1 idle 15s ≥ 10s → evicted, fresh full bucket
    expect(limiter.tryRemove('u1')).toBe(true);
  });
});
