import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InvitationRateLimitGuard } from './invitation-rate-limit.guard.js';

function context(userId: string, workspaceId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { id: userId }, params: { workspaceId } }) }),
  } as unknown as ExecutionContext;
}

describe('InvitationRateLimitGuard', () => {
  it('limits one principal within one workspace', () => {
    const guard = new InvitationRateLimitGuard();
    for (let i = 0; i < 10; i++) expect(guard.canActivate(context('user-1', 'ws-1'))).toBe(true);
    expect(() => guard.canActivate(context('user-1', 'ws-1'))).toThrow(HttpException);
  });

  it('isolates buckets by principal and workspace', () => {
    const guard = new InvitationRateLimitGuard();
    for (let i = 0; i < 10; i++) guard.canActivate(context('user-1', 'ws-1'));
    expect(guard.canActivate(context('user-2', 'ws-1'))).toBe(true);
    expect(guard.canActivate(context('user-1', 'ws-2'))).toBe(true);
  });
});
