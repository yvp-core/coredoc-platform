import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { TokenBucketRateLimiter } from '../../libs/token-bucket.js';

const INVITATION_BURST = 10;
const INVITATION_REFILL_PER_SEC = 1 / 30;
const IDLE_EVICT_MS = 10 * 60_000;
const SWEEP_EVERY = 500;

/** Per-admin/workspace ceiling for WorkOS email-producing invite operations. */
@Injectable()
export class InvitationRateLimitGuard implements CanActivate {
  private readonly limiter = new TokenBucketRateLimiter({
    capacity: INVITATION_BURST,
    refillPerSec: INVITATION_REFILL_PER_SEC,
  });
  private calls = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: { id?: string };
      params?: { workspaceId?: string };
      ip?: string;
    }>();
    const principal = req.user?.id ?? req.ip ?? 'anon';
    const key = `${principal}:${req.params?.workspaceId ?? 'unknown'}`;
    if (++this.calls % SWEEP_EVERY === 0) this.limiter.evictFull(IDLE_EVICT_MS);
    if (!this.limiter.tryRemove(key)) {
      throw new HttpException('Too many invitation emails — try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
