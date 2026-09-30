import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { DeliveryEnabledGuard } from './delivery-enabled.guard.js';
import type { PrismaService } from '../../database/prisma.service.js';

function createMockContext(workspaceId: string | undefined = 'ws_1'): ExecutionContext {
  const request = { params: { workspaceId } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockPrisma(workspace: { deliveryEnabled: boolean } | null) {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue(workspace),
    },
  } as unknown as PrismaService & { workspace: { findUnique: ReturnType<typeof vi.fn> } };
}

describe('DeliveryEnabledGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('allows access when the workspace has deliveryEnabled=true (one scoped findUnique)', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const prisma = mockPrisma({ deliveryEnabled: true });
    const guard = new DeliveryEnabledGuard(prisma, reflector);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      select: { deliveryEnabled: true },
    });
  });

  it('throws ForbiddenException with the exact message when deliveryEnabled=false', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new DeliveryEnabledGuard(mockPrisma({ deliveryEnabled: false }), reflector);

    const err = await guard.canActivate(createMockContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe('Delivery intelligence is not enabled for this workspace');
  });

  it('throws ForbiddenException when the workspace is missing (findUnique → null) — fail closed', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new DeliveryEnabledGuard(mockPrisma(null), reflector);
    await expect(guard.canActivate(createMockContext())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes through when @SkipDeliveryEnabled metadata is set — no prisma read', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const prisma = mockPrisma({ deliveryEnabled: false });
    const guard = new DeliveryEnabledGuard(prisma, reflector);

    await expect(guard.canActivate(createMockContext())).resolves.toBe(true);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});
