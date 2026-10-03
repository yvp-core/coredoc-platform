import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { UserSessionGuard } from './user-session.guard.js';
import { JwtOnlyGuard } from './jwt-only.guard.js';
import { TokenPermission } from './token-permissions.js';

function ctx(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const user = { id: 'user_1', email: 'dev@example.com' };

describe('UserSessionGuard', () => {
  const guard = new UserSessionGuard();

  // Auth kind × role matrix. A service token authenticates AS its creator, so
  // the role column is identical for both auth kinds — only the auth kind
  // decides. That is the whole point of this guard.
  const roles = ['owner', 'admin', 'product', 'member'] as const;

  it.each(roles)('admits a JWT/bearer user session with role %s', (role) => {
    expect(guard.canActivate(ctx({ user, userWorkspaceRole: role, authVia: 'bearer' }))).toBe(true);
  });

  it.each(roles)('admits a cookie user session with role %s', (role) => {
    expect(guard.canActivate(ctx({ user, userWorkspaceRole: role, authVia: 'cookie' }))).toBe(true);
  });

  it.each(roles)('refuses a service token created by a %s, whatever its role resolves to', (role) => {
    const request = {
      user,
      userWorkspaceRole: role,
      authVia: 'bearer',
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: [TokenPermission.IntentRead, TokenPermission.IntentPropose],
    };
    expect(() => guard.canActivate(ctx(request))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(request))).toThrow('user session, not a service token');
  });

  it('refuses a wildcard service token — permissions cannot substitute for a session', () => {
    expect(() =>
      guard.canActivate(
        ctx({ user, userWorkspaceRole: 'owner', serviceTokenWorkspaceId: 'ws_1', serviceTokenPermissions: ['*'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('refuses a request with no principal at all (guard wired without AuthGuard)', () => {
    expect(() => guard.canActivate(ctx({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({}))).toThrow('authenticated user session');
  });

  it('is the same class as the deprecated JwtOnlyGuard alias — one implementation, no drift', () => {
    expect(JwtOnlyGuard).toBe(UserSessionGuard);
  });
});
