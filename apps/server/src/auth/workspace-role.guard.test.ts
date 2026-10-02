import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRoleGuard } from './workspace-role.guard.js';
import type { ExecutionContext } from '@nestjs/common';
import type { ControlPlaneService } from '../database/control-plane.service.js';

function createMockContext(workspaceRole?: string): ExecutionContext {
  const request = {
    user: { id: 'user_1', email: 'test@example.com' },
    params: { workspaceId: 'ws_1' },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function createMockControlPlane(role?: string): ControlPlaneService {
  return {
    getMember: vi
      .fn()
      .mockResolvedValue(role ? { workspaceId: 'ws_1', userId: 'user_1', role, email: 'test@example.com' } : null),
  } as unknown as ControlPlaneService;
}

describe('WorkspaceRoleGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('allows access when no @WorkspaceRole decorator is present', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    const result = await guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it('throws ForbiddenException when user is not a workspace member', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane(undefined));

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });

  it('allows member when member role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    const result = await guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it('allows admin when member role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('admin'));

    const result = await guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it('allows owner when admin role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('admin');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('owner'));

    const result = await guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it('ranks product with member: admitted to member routes, refused admin ones', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    await expect(
      new WorkspaceRoleGuard(reflector, createMockControlPlane('product')).canActivate(createMockContext()),
    ).resolves.toBe(true);

    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('admin');
    await expect(
      new WorkspaceRoleGuard(reflector, createMockControlPlane('product')).canActivate(createMockContext()),
    ).rejects.toThrow(ForbiddenException);
  });

  it('denies member when admin role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('admin');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });

  it('denies member when owner role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('owner');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(/Requires owner role, you have member/);
  });

  it('denies admin when owner role required', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('owner');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('admin'));

    await expect(guard.canActivate(createMockContext())).rejects.toThrow(ForbiddenException);
  });

  it('denies cross-workspace service token usage', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    const context = createMockContext();
    const request = context.switchToHttp().getRequest() as Record<string, unknown>;
    request.serviceTokenWorkspaceId = 'ws_other'; // Different from ws_1

    await expect(guard.canActivate(context)).rejects.toThrow(/Service token is not authorized for this workspace/);
  });

  it('allows service token when workspace matches', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('member');
    const guard = new WorkspaceRoleGuard(reflector, createMockControlPlane('member'));

    const context = createMockContext();
    const request = context.switchToHttp().getRequest() as Record<string, unknown>;
    request.serviceTokenWorkspaceId = 'ws_1'; // Same as params.workspaceId

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
