/**
 * Per-principal rate limiter for the browser-reachable `/graph/*` surface — the
 * DoS boundary docs/web-ui-plan-2026-07.md §3.2 (risk 2) requires. Runs LAST in
 * the graph guard stack so it keys on the already-authenticated principal
 * (service-token workspace id, else user id, else remote ip).
 *
 * Generous burst so an interactive explorer session (a flurry of neighbor
 * expansions) never trips; the sustained rate is the actual abuse ceiling.
 */

import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { TokenBucketRateLimiter } from '../../libs/token-bucket.js';

const GRAPH_BURST = 120;
const GRAPH_REFILL_PER_SEC = 20;
const IDLE_EVICT_MS = 60_000;
const SWEEP_EVERY = 1000;

@Injectable()
export class GraphRateLimitGuard implements CanActivate {
  private readonly limiter = new TokenBucketRateLimiter({ capacity: GRAPH_BURST, refillPerSec: GRAPH_REFILL_PER_SEC });
  private calls = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: { id?: string };
      serviceTokenWorkspaceId?: string;
      ip?: string;
    }>();
    const key = req.serviceTokenWorkspaceId ?? req.user?.id ?? req.ip ?? 'anon';

    // Opportunistic memory bound under a churn of distinct principals: sweep
    // fully-refilled (stateless) buckets periodically. Not correctness-critical.
    if (++this.calls % SWEEP_EVERY === 0) this.limiter.evictFull(IDLE_EVICT_MS);

    if (!this.limiter.tryRemove(key)) {
      throw new HttpException('Too many graph requests — slow down.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
