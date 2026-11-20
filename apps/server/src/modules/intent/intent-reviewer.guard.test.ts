import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { IntentReviewerGuard } from './intent-reviewer.guard.js';

const as = (userWorkspaceRole?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ userWorkspaceRole }) }) }) as unknown as ExecutionContext;

describe('IntentReviewerGuard', () => {
  const guard = new IntentReviewerGuard();

  it.each(['owner', 'admin', 'product', 'member'])('lets %s change intent', (role) => {
    expect(guard.canActivate(as(role))).toBe(true);
  });

  it.each(['support', 'intern', undefined])('refuses %s, which may only read it', (role) => {
    expect(() => guard.canActivate(as(role))).toThrow(ForbiddenException);
  });
});
