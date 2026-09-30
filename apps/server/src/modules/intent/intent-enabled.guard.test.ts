import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import type { PrismaService } from '../../database/prisma.service.js';

function createMockContext(workspaceId?: string): ExecutionContext {
  const request = { params: { workspaceId } };
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
