import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { IntentEnabledToolGuard } from './intent-enabled.tool-guard.js';
import type { PrismaService } from '../database/prisma.service.js';

function createMockContext(workspaceId?: string): ExecutionContext {
  const request = { workspaceId };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockPrisma(workspace: { intentEnabled: boolean } | null) {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue(workspace),
    },
  } as unknown as PrismaService & { workspace: { findUnique: ReturnType<typeof vi.fn> } };
}

describe('IntentEnabledToolGuard', () => {
  it('allows the tool when the workspace has intentEnabled=true (one scoped findUnique)', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledToolGuard(prisma);

    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(true);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      select: { intentEnabled: true },
    });
  });

  it('returns false (never throws) when intentEnabled=false', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma({ intentEnabled: false }));
    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(false);
  });

  it('returns false when the workspace is missing (findUnique → null) — fail closed', async () => {
    const guard = new IntentEnabledToolGuard(mockPrisma(null));
    await expect(guard.canActivate(createMockContext('ws_1'))).resolves.toBe(false);
  });

  it('returns false without touching prisma when the request carries no workspaceId', async () => {
    const prisma = mockPrisma({ intentEnabled: true });
    const guard = new IntentEnabledToolGuard(prisma);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(false);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});
