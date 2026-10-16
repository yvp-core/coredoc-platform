import { type CanActivate, type ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { TokenBucketRateLimiter } from '../../libs/token-bucket.js';
import { CloudAgentRunErrorCode, cloudAgentRunError } from './run-states.js';

export const RUNNER_RATE_LIMIT = Symbol('RUNNER_RATE_LIMIT');

export interface RunnerRateLimit {
  burst: number;
  refillPerSec: number;
  now?: () => number;
}

/**
 * Generous for honest runners sharing one token across replicas: each claims
 * every 5 s, heartbeats every 20 s and batches its events.
 */
const DEFAULT_RUNNER_RATE_LIMIT: RunnerRateLimit = { burst: 300, refillPerSec: 10 };
const IDLE_EVICT_MS = 10 * 60_000;
const SWEEP_EVERY = 1_000;

/** Per process, like the other token buckets: with several API replicas the limit is per replica. */
@Injectable()
export class RunnerRateLimitGuard implements CanActivate {
  private readonly limiter: TokenBucketRateLimiter;
  private readonly retryAfterSeconds: string;
  private calls = 0;

  constructor(@Optional() @Inject(RUNNER_RATE_LIMIT) limit: RunnerRateLimit = DEFAULT_RUNNER_RATE_LIMIT) {
    this.limiter = new TokenBucketRateLimiter({
      capacity: limit.burst,
      refillPerSec: limit.refillPerSec,
      now: limit.now,
    });
    this.retryAfterSeconds = String(Math.max(1, Math.ceil(1 / limit.refillPerSec)));
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const { serviceTokenId } = http.getRequest<{ serviceTokenId?: string }>();
    if (++this.calls % SWEEP_EVERY === 0) this.limiter.evictFull(IDLE_EVICT_MS);
    if (!this.limiter.tryRemove(serviceTokenId ?? 'none')) {
      http
        .getResponse<{ setHeader(name: string, value: string): void }>()
        .setHeader('Retry-After', this.retryAfterSeconds);
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.RateLimited,
        'Too many runner requests for this token; slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
