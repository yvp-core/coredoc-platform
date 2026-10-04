import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import type { IntentConfig } from '../../config/app-config.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';

/** `extra` is what the earlier guards attach: `WorkspaceRoleGuard`'s role, `AuthGuard`'s token binding. */
function createMockContext(workspaceId?: string, extra: Record<string, unknown> = {}): ExecutionContext {
  const request = { params: { workspaceId }, ...extra };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockPrisma(workspace: { intentEnabled: boolean } | null) {
  return {
    workspace: { findUnique: vi.fn().mockResolvedValue(workspace) },
  } as unknown as PrismaService & { workspace: { findUnique: ReturnType<typeof vi.fn> } };
}

describe('IntentEnabledGuard', () => {
  it('allows the request when the workspace has intentEnabled=true', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledGuard(prisma);

    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(true);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      select: { intentEnabled: true },
    });
  });

  it('throws intent_disabled (409) when intentEnabled=false', async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: false }));
    expect.assertions(3);
    try {
      await guard.canActivate(createMockContext('ws_1'));
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      expect((error as IntentPublicException).getStatus()).toBe(409);
      expect((error as IntentPublicException).publicError.code).toBe(IntentErrorCode.IntentDisabled);
    }
  });

  it('throws intent_disabled when the workspace is missing — fail closed', async () => {
    const guard = new IntentEnabledGuard(mockPrisma(null));
    await expect(guard.canActivate(createMockContext('ws_1'))).rejects.toThrow(IntentPublicException);
  });

  it('allows the request through without touching prisma when there is no workspaceId param', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledGuard(prisma);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});

describe('IntentEnabledGuard — temporary INTENT_ROLES rollout', () => {
  const PRODUCT_FIRST: IntentConfig = {
    rolloutRoles: [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Product],
  };

  async function refusal(guard: IntentEnabledGuard, context: ExecutionContext): Promise<IntentPublicException> {
    try {
      await guard.canActivate(context);
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      return error as IntentPublicException;
    }
    throw new Error('expected the guard to refuse');
  }

  it('allows an in-list role on an intent-enabled workspace', async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    await expect(
      guard.canActivate(createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Product })),
    ).resolves.toBe(true);
  });

  it('answers an out-of-list role with the same 409 intent_disabled body as a workspace with intent off', async () => {
    const outsider = await refusal(
      new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST),
      createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Member }),
    );
    const off = await refusal(
      new IntentEnabledGuard(mockPrisma({ intentEnabled: false }), {}),
      createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Owner }),
    );

    expect(outsider.getStatus()).toBe(409);
    expect(outsider.publicError).toEqual(off.publicError);
    expect(outsider.publicError.code).toBe(IntentErrorCode.IntentDisabled);
  });

  it('fails closed when no role was resolved for the request', async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    await refusal(guard, createMockContext('ws_1'));
  });

  it("keeps today's behaviour when INTENT_ROLES is unset: any member role passes", async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), {});
    await expect(
      guard.canActivate(createMockContext('ws_1', { userWorkspaceRole: WorkspaceMemberRole.Member })),
    ).resolves.toBe(true);
  });

  // A service token authenticates as its creator: WorkspaceRoleGuard resolves
  // `userWorkspaceRole` from the CREATOR's membership, so the gate follows them.
  it('lets a CI token through while its creator is an in-list admin', async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const context = createMockContext('ws_1', {
      userWorkspaceRole: WorkspaceMemberRole.Admin,
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['intent:release'],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses a service token whose creator is outside the list', async () => {
    const guard = new IntentEnabledGuard(mockPrisma({ intentEnabled: true }), PRODUCT_FIRST);
    const context = createMockContext('ws_1', {
      userWorkspaceRole: WorkspaceMemberRole.Member,
      serviceTokenWorkspaceId: 'ws_1',
      serviceTokenPermissions: ['intent:read', 'intent:propose'],
    });
    expect((await refusal(guard, context)).publicError.code).toBe(IntentErrorCode.IntentDisabled);
  });
});
