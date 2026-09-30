import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard, TokenPermission } from './permissions.guard.js';
import type { ExecutionContext } from '@nestjs/common';

function createMockContext(
  overrides: { serviceTokenWorkspaceId?: string; serviceTokenPermissions?: string[] } = {},
): ExecutionContext {
  const request = {
    serviceTokenWorkspaceId: overrides.serviceTokenWorkspaceId,
    serviceTokenPermissions: overrides.serviceTokenPermissions,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  it('passes when no @RequirePermission decorator is present', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const context = createMockContext({ serviceTokenWorkspaceId: 'ws_1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes when decorator has empty permissions array', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
    const context = createMockContext({ serviceTokenWorkspaceId: 'ws_1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes for JWT user sessions (no serviceTokenWorkspaceId)', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push']);
    const context = createMockContext(); // no service token
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes when service token has required permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['repo:push', 'parser:read'],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes when service token has multiple required permissions', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push', 'parser:read']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['repo:push', 'parser:read', 'parser:write'],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('passes when service token has wildcard (*) permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push', 'parser:write']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['*'],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  describe('wildcard (*) does not expand over intent scopes', () => {
    // A `*` token predates the intent permissions and was never reviewed for
    // product-authority access. Expanding over them would retroactively grant
    // every legacy grant-all token the right to write into the intent overlay.
    it.each([TokenPermission.IntentRead, TokenPermission.IntentPropose])('refuses %s on a wildcard token', (perm) => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([perm]);
      const context = createMockContext({
        serviceTokenWorkspaceId: 'ws_1',
        serviceTokenPermissions: ['*'],
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(perm);
      expect(() => guard.canActivate(context)).toThrow('wildcard does not grant them');
    });

    it('refuses an intent scope even when the wildcard also covers a required legacy scope', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
        TokenPermission.ResultRead,
        TokenPermission.IntentPropose,
      ]);
      const context = createMockContext({
        serviceTokenWorkspaceId: 'ws_1',
        serviceTokenPermissions: ['*'],
      });
      expect(() => guard.canActivate(context)).toThrow('intent:propose');
    });

    it('admits an intent scope listed explicitly alongside the wildcard', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([TokenPermission.IntentPropose]);
      const context = createMockContext({
        serviceTokenWorkspaceId: 'ws_1',
        serviceTokenPermissions: ['*', TokenPermission.IntentPropose],
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('still admits a user session on an intent route — PermissionsGuard never gates humans', () => {
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([TokenPermission.IntentPropose]);
      expect(guard.canActivate(createMockContext())).toBe(true);
    });
  });

  it('throws ForbiddenException when service token is missing required permission', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['parser:read'],
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('repo:push');
  });

  it('throws ForbiddenException listing all missing permissions', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push', 'parser:write']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['parser:read'],
    });
    expect(() => guard.canActivate(context)).toThrow('repo:push, parser:write');
  });

  it('throws when service token has empty permissions array', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: [],
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('throws when service token has no permissions field (undefined)', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['repo:push']);
    const context = createMockContext({
      serviceTokenWorkspaceId: 'ws_1',
      // serviceTokenPermissions is undefined
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
