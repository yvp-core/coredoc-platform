import { type ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RunnerRateLimitGuard } from './runner-rate-limit.guard.js';

function context(serviceTokenId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ serviceTokenId }) }),
  } as unknown as ExecutionContext;
}

function refused(guard: RunnerRateLimitGuard, tokenId: string): number | null {
  try {
    guard.canActivate(context(tokenId));
    return null;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
}

describe('RunnerRateLimitGuard', () => {
  it('answers 429 once a runner token spends its burst, and admits it again after the refill', () => {
    let now = 0;
    const guard = new RunnerRateLimitGuard({ burst: 3, refillPerSec: 1, now: () => now });
    for (let call = 0; call < 3; call += 1) expect(refused(guard, 'token-a')).toBeNull();
    expect(refused(guard, 'token-a')).toBe(HttpStatus.TOO_MANY_REQUESTS);

    now += 1_000;
    expect(refused(guard, 'token-a')).toBeNull();
  });

  it('keeps one bucket per runner token', () => {
    const guard = new RunnerRateLimitGuard({ burst: 1, refillPerSec: 1, now: () => 0 });
    expect(refused(guard, 'token-a')).toBeNull();
    expect(refused(guard, 'token-a')).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(refused(guard, 'token-b')).toBeNull();
  });
});
