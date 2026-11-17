import { describe, expect, it } from 'vitest';
import { parseSubscriptionKeys, planUsageOf, SubscriptionKeys, usageLimitReached } from './subscription-keys.js';

describe('parseSubscriptionKeys', () => {
  it('reads labelled tokens and labels a bare token by its position', () => {
    expect(parseSubscriptionKeys('alice:tok-a, tok-b ,')).toEqual([
      { label: 'alice', token: 'tok-a' },
      { label: 'key-2', token: 'tok-b' },
    ]);
  });

  it('refuses repeated labels and empty tokens', () => {
    expect(() => parseSubscriptionKeys('a:tok-a,a:tok-b')).toThrow('distinct labels');
    expect(() => parseSubscriptionKeys('a:')).toThrow('non-empty tokens');
  });
});

describe('usageLimitReached', () => {
  it.each([
    "You've hit your session limit · resets 3pm",
    "You've reached your weekly limit",
    'Claude usage limit reached',
  ])('recognises "%s"', (text) => expect(usageLimitReached(text)).toBe(true));

  it('leaves a brief rate limit to the ordinary retry', () => {
    expect(usageLimitReached('API Error: Request rejected (429) · rate limit')).toBe(false);
  });
});

describe('SubscriptionKeys', () => {
  const HOUR = 3_600_000;
  const keys = (now: () => number) =>
    new SubscriptionKeys(
      [
        { label: 'a', token: 'tok-a' },
        { label: 'b', token: 'tok-b' },
      ],
      now,
    );

  it('uses the first key until it is exhausted, and returns to it once its limit resets', () => {
    let now = 1_000_000;
    const pool = keys(() => now);
    expect(pool.current()?.label).toBe('a');

    pool.markExhausted('a', now + HOUR);
    expect(pool.current()?.label).toBe('b');
    pool.markExhausted('b', now + 2 * HOUR);
    expect(pool.current()).toBeNull();
    expect(pool.nextResetAt()).toEqual(new Date(1_000_000 + HOUR));

    now += HOUR;
    expect(pool.current()?.label).toBe('a');
    expect(pool.report()[0]).toMatchObject({ label: 'a', active: true, exhaustedUntil: null });
  });

  it('keeps a key aside until its other full window resets too', () => {
    const now = 1_000_000;
    const pool = keys(() => now);
    const weekly = new Date(now + 30 * HOUR).toISOString();
    pool.recordUsage('a', { sevenDay: { utilization: 100, resetsAt: weekly } });
    pool.markExhausted('a', now + HOUR);

    expect(pool.report()[0]).toMatchObject({ label: 'a', exhaustedUntil: weekly });
  });

  it('takes the reset time from the full window when the stream gave none, else waits an hour', () => {
    const now = 1_000_000;
    const pool = keys(() => now);
    const resetsAt = new Date(now + 3 * HOUR).toISOString();
    pool.recordUsage('a', { fiveHour: { utilization: 40, resetsAt: null }, sevenDay: { utilization: 100, resetsAt } });
    pool.markExhausted('a', null);
    pool.markExhausted('b', null);

    expect(pool.report()).toMatchObject([
      { label: 'a', exhaustedUntil: resetsAt, fiveHour: { utilization: 40 }, sevenDay: { utilization: 100 } },
      { label: 'b', exhaustedUntil: new Date(now + HOUR).toISOString(), fiveHour: null, checkedAt: null },
    ]);
  });

  it("records the stream's window as a percentage with its reset time", () => {
    const pool = keys(() => 1_000_000);
    pool.recordRateLimit('a', {
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.82,
      resetsAt: 2_000,
    });

    expect(pool.report()[0]).toMatchObject({
      sevenDay: { utilization: 82, resetsAt: new Date(2_000_000).toISOString() },
      fiveHour: null,
    });
  });
});

describe('planUsageOf', () => {
  it('keeps the five-hour and seven-day windows, and is null without plan limits', () => {
    expect(
      planUsageOf({
        rate_limits: { five_hour: { utilization: 12.5, resets_at: '2026-11-17T18:00:00+00:00' }, seven_day: null },
      }),
    ).toEqual({ fiveHour: { utilization: 12.5, resetsAt: '2026-11-17T18:00:00.000Z' }, sevenDay: null });
    expect(planUsageOf({ rate_limits: null })).toBeNull();
  });
});
