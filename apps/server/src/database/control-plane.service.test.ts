import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ControlPlaneService } from './control-plane.service.js';
import type { PrismaService } from './prisma.service.js';

/**
 * Two surfaces under test:
 *
 *   1. addRepo — create-only. POST /workspaces/:id/repos is idempotent in the
 *      "already connected" sense (server surfaces Prisma's unique-constraint
 *      throw as 409) but does NOT mutate fields on re-connect.
 *
 *   2. updateRepo — partial update with tri-state semantics:
 *        - `undefined` → field omitted from payload (leave stored value alone)
 *        - `null`      → set stored value to null (clear)
 *        - string      → set stored value
 *
 *      The desktop relies on this for httpPrefix removal propagation. gitUrl
 *      uses "omit-when-undefined" on the desktop side so a value the desktop
 *      never owns is not silently wiped on every sync.
 */
function createPrismaMock() {
  const prisma = {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({}),
    },
    workspaceRepo: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    workspaceGraphVersion: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const $transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) => operation(prisma));

  return Object.assign(prisma, { $transaction }) as unknown as PrismaService & {
    $executeRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
    workspace: { findUnique: ReturnType<typeof vi.fn> };
    workspaceRepo: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    workspaceGraphVersion: { findUnique: ReturnType<typeof vi.fn> };
  };
}

function createRepoMutationLockMock() {
  const workspaceRepo = {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  const executeRaw = vi.fn().mockResolvedValue(1);
  const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
    operation({ $executeRaw: executeRaw, workspaceRepo }),
  );
  return {
    prisma: { $transaction: transaction, workspaceRepo } as unknown as PrismaService,
    workspaceRepo,
    executeRaw,
    transaction,
  };
}

describe('ControlPlaneService graph-version reads', () => {
  it('reads metadata only by the workspace/version compound identity', async () => {
    const prisma = createPrismaMock();
    prisma.workspaceGraphVersion.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      versionId: 'version-1',
      engine: 'ladybug',
      r2Key: 'ws-1/graphs/version-1.lbug',
      sha256: 'a'.repeat(64),
      sizeBytes: 123n,
      storageFormatVersion: 1,
    });
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);

    await expect(svc.getWorkspaceGraphVersion('ws-1', 'version-1')).resolves.toMatchObject({
      workspaceId: 'ws-1',
      versionId: 'version-1',
      engine: 'ladybug',
    });
    expect(prisma.workspaceGraphVersion.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_versionId: { workspaceId: 'ws-1', versionId: 'version-1' } },
      select: {
        workspaceId: true,
        versionId: true,
        engine: true,
        r2Key: true,
        sha256: true,
        sizeBytes: true,
        storageFormatVersion: true,
        // Selected because `builderVersion` has no column of its own — a reader
        // needs it to tell a pre-phase4 snapshot apart from a current one.
        manifest: true,
      },
    });
  });
});

describe('ControlPlaneService transaction-scoped readers', () => {
  it('uses the supplied transaction client instead of the outer Prisma client', async () => {
    const prisma = createPrismaMock();
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);
    const transaction = {
      workspace: { findUnique: vi.fn().mockResolvedValue({ id: 'ws-1' }) },
      workspaceRepo: { findMany: vi.fn().mockResolvedValue([{ repoName: 'api' }]) },
    };

    await expect(svc.getWorkspaceById('ws-1', transaction as never)).resolves.toEqual({ id: 'ws-1' });
    await expect(svc.listRepos('ws-1', transaction as never)).resolves.toEqual([{ repoName: 'api' }]);

    expect(transaction.workspace.findUnique).toHaveBeenCalledWith({ where: { id: 'ws-1' } });
    expect(transaction.workspaceRepo.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { repoName: 'asc' },
    });
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.workspaceRepo.findMany).not.toHaveBeenCalled();
  });
});

describe('ControlPlaneService.addRepo (create-only)', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let svc: ControlPlaneService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new ControlPlaneService(prisma as unknown as PrismaService);
  });

  it('creates a row with all fields, coercing missing optionals to null', async () => {
    await svc.addRepo('ws', 'key', 'name');
    const args = prisma.workspaceRepo.create.mock.calls[0]![0];
    expect(args.data).toMatchObject({
      workspaceId: 'ws',
      repoKey: 'key',
      repoName: 'name',
      gitUrl: null,
      repoType: null,
      httpPrefix: null,
    });
  });

  it('passes through explicit string values', async () => {
    await svc.addRepo('ws', 'key', 'name', 'https://example/repo.git', 'backend', '/v1/api');
    const args = prisma.workspaceRepo.create.mock.calls[0]![0];
    expect(args.data.gitUrl).toBe('https://example/repo.git');
    expect(args.data.repoType).toBe('backend');
    expect(args.data.httpPrefix).toBe('/v1/api');
  });

  it('does NOT call update (re-connect should throw via unique constraint, surfaced as 409)', async () => {
    await svc.addRepo('ws', 'key', 'name');
    expect(prisma.workspaceRepo.update).not.toHaveBeenCalled();
  });
});

describe('ControlPlaneService.updateRepo tri-state', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let svc: ControlPlaneService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new ControlPlaneService(prisma as unknown as PrismaService);
  });

  it('omits gitUrl/repoType/httpPrefix from update payload when undefined (preserves stored values)', async () => {
    await svc.updateRepo('ws', 'key', {});
    const args = prisma.workspaceRepo.update.mock.calls[0]![0];
    expect(args.data).not.toHaveProperty('gitUrl');
    expect(args.data).not.toHaveProperty('repoType');
    expect(args.data).not.toHaveProperty('httpPrefix');
  });

  it('clears gitUrl/repoType/httpPrefix when passed explicit null', async () => {
    await svc.updateRepo('ws', 'key', { gitUrl: null, repoType: null, httpPrefix: null });
    const args = prisma.workspaceRepo.update.mock.calls[0]![0];
    expect(args.data.gitUrl).toBeNull();
    expect(args.data.repoType).toBeNull();
    expect(args.data.httpPrefix).toBeNull();
  });

  it('sets fields when passed string values', async () => {
    await svc.updateRepo('ws', 'key', {
      gitUrl: 'https://example/repo.git',
      repoType: 'backend',
      httpPrefix: '/v1/api',
    });
    const args = prisma.workspaceRepo.update.mock.calls[0]![0];
    expect(args.data.gitUrl).toBe('https://example/repo.git');
    expect(args.data.repoType).toBe('backend');
    expect(args.data.httpPrefix).toBe('/v1/api');
  });

  it('mixed: clears httpPrefix while leaving gitUrl alone (real desktop sync pattern)', async () => {
    // Desktop: send `null` to clear httpPrefix when local config removed it, but
    // omit gitUrl because the desktop never owns that field.
    await svc.updateRepo('ws', 'key', { httpPrefix: null });
    const args = prisma.workspaceRepo.update.mock.calls[0]![0];
    expect(args.data).not.toHaveProperty('gitUrl');
    expect(args.data).not.toHaveProperty('repoType');
    expect(args.data.httpPrefix).toBeNull();
  });

  it('carries productionBranch tri-state — omitted leaves it, null restores the connector default', async () => {
    await svc.updateRepo('ws', 'key', {});
    expect(prisma.workspaceRepo.update.mock.calls[0]![0].data).not.toHaveProperty('productionBranch');

    await svc.updateRepo('ws', 'key', { productionBranch: 'release' });
    expect(prisma.workspaceRepo.update.mock.calls[1]![0].data.productionBranch).toBe('release');

    await svc.updateRepo('ws', 'key', { productionBranch: null });
    expect(prisma.workspaceRepo.update.mock.calls[2]![0].data.productionBranch).toBeNull();
  });

  it('targets the correct row via (workspaceId, repoKey)', async () => {
    await svc.updateRepo('ws-xyz', 'repo-abc', { httpPrefix: '/v2' });
    const args = prisma.workspaceRepo.update.mock.calls[0]![0];
    expect(args.where).toEqual({ workspaceId_repoKey: { workspaceId: 'ws-xyz', repoKey: 'repo-abc' } });
  });
});

describe('ControlPlaneService repository identity serialization', () => {
  it.each([
    ['create', (service: ControlPlaneService) => service.addRepo('ws-lock', 'repo-key', 'repo-name')],
    ['update', (service: ControlPlaneService) => service.updateRepo('ws-lock', 'repo-key', { gitUrl: 'owner/repo' })],
    ['delete', (service: ControlPlaneService) => service.removeRepo('ws-lock', 'repo-id')],
  ])('takes the workspace advisory lock before repository %s', async (_operation, invoke) => {
    const { prisma, workspaceRepo, executeRaw, transaction } = createRepoMutationLockMock();
    const service = new ControlPlaneService(prisma);

    await invoke(service);

    expect(transaction).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(String(executeRaw.mock.calls[0]?.[0]?.join('?'))).toContain('pg_advisory_xact_lock');
    const mutation =
      workspaceRepo.create.mock.invocationCallOrder[0] ??
      workspaceRepo.update.mock.invocationCallOrder[0] ??
      workspaceRepo.delete.mock.invocationCallOrder[0];
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mutation as number);
  });
});

describe('ControlPlaneService.updateRepoPushMetadata identity', () => {
  it('refuses to attach an old push to a reconnected repository row', async () => {
    const prisma = createPrismaMock();
    prisma.workspaceRepo.updateMany.mockResolvedValue({ count: 0 });
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);

    await expect(
      svc.updateRepoPushMetadata(
        'ws-xyz',
        { id: 'repo-row-old', repoKey: 'repo-abc', repoName: 'service-a' } as never,
        {
          lastParseHash: 'parse-v2',
          lastPushedByUserId: 'user-1',
          nodeCount: 12,
          edgeCount: 20,
          lastParsedVersion: 'parse-v2',
        },
      ),
    ).resolves.toBe(false);

    expect(prisma.workspaceRepo.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'repo-row-old',
        workspaceId: 'ws-xyz',
        repoKey: 'repo-abc',
        repoName: 'service-a',
      },
      data: expect.objectContaining({ lastParsedVersion: 'parse-v2' }),
    });
    expect(prisma.workspaceRepo.update).not.toHaveBeenCalled();
  });

  it('updates exactly one workspace repo by its resolved connection identity', async () => {
    const prisma = createPrismaMock();
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);

    await svc.updateRepoPushMetadata(
      'ws-xyz',
      { id: 'repo-row-abc', repoKey: 'repo-abc', repoName: 'api' },
      {
        lastParseHash: 'parse-v2',
        lastPushedByUserId: 'user-1',
        nodeCount: 12,
        edgeCount: 20,
        lastParsedVersion: 'parse-v2',
        lastSummaryVersion: 'sum-v2',
        lastEmbedVersion: 'emb-v2',
      },
    );

    const args = prisma.workspaceRepo.updateMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      id: 'repo-row-abc',
      workspaceId: 'ws-xyz',
      repoKey: 'repo-abc',
      repoName: 'api',
    });
    expect(args.where).not.toHaveProperty('OR');
    expect(args.data).toMatchObject({
      lastParseHash: 'parse-v2',
      lastPushedByUserId: 'user-1',
      nodeCount: 12,
      edgeCount: 20,
      lastParsedVersion: 'parse-v2',
      lastSummaryVersion: 'sum-v2',
      lastEmbedVersion: 'emb-v2',
    });
  });

  it('preserves omitted selections and clears selections passed as explicit null', async () => {
    const prisma = createPrismaMock();
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);
    const pushMetadata = {
      lastParseHash: 'parse-v2',
      lastPushedByUserId: 'user-1',
      nodeCount: 12,
      edgeCount: 20,
      lastParsedVersion: 'parse-v2',
    };

    const identity = { id: 'repo-row-abc', repoKey: 'repo-abc', repoName: 'api' };
    await svc.updateRepoPushMetadata('ws-xyz', identity, pushMetadata);
    expect(prisma.workspaceRepo.updateMany.mock.calls[0]![0].data.lastParsedVersion).toBe('parse-v2');
    expect(prisma.workspaceRepo.updateMany.mock.calls[0]![0].data).not.toHaveProperty('lastSummaryVersion');
    expect(prisma.workspaceRepo.updateMany.mock.calls[0]![0].data).not.toHaveProperty('lastEmbedVersion');

    await svc.updateRepoPushMetadata('ws-xyz', identity, {
      ...pushMetadata,
      lastSummaryVersion: null,
      lastEmbedVersion: null,
    });
    expect(prisma.workspaceRepo.updateMany.mock.calls[1]![0].data).toMatchObject({
      lastParsedVersion: 'parse-v2',
      lastSummaryVersion: null,
      lastEmbedVersion: null,
    });
  });

  it('writes selected versions through the supplied fenced transaction', async () => {
    const prisma = createPrismaMock();
    const transaction = { workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);

    await svc.updateRepoPushMetadata(
      'ws-xyz',
      { id: 'repo-row-abc', repoKey: 'repo-abc', repoName: 'api' },
      {
        lastParseHash: 'parse-v2',
        lastPushedByUserId: 'user-1',
        nodeCount: 12,
        edgeCount: 20,
        lastParsedVersion: 'parse-v2',
      },
      transaction as never,
    );

    expect(transaction.workspaceRepo.updateMany).toHaveBeenCalledOnce();
    expect(prisma.workspaceRepo.updateMany).not.toHaveBeenCalled();
  });
});

describe('ControlPlaneService installation telemetry tokens', () => {
  const input = {
    workspaceId: 'ws-1',
    name: 'capture-agent:11111111-1111-4111-8111-111111111111',
    tokenHash: 'a'.repeat(64),
    tokenPrefix: 'cdt_aaaaaaaa',
    tokenEncrypted: null,
    createdBy: 'user-1',
    permissions: ['telemetry:write'],
    expiresAt: null,
    lastUsedAt: null,
  };

  it('rotates the existing caller-owned exact-purpose row and resets last use', async () => {
    const serviceToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: 'token-1',
        createdBy: 'user-1',
        permissions: ['telemetry:write'],
      }),
      update: vi.fn().mockResolvedValue({
        id: 'token-1',
        name: input.name,
        permissions: ['telemetry:write'],
      }),
      create: vi.fn(),
    };
    const prisma = {
      $transaction: vi.fn((work: (tx: unknown) => unknown) => work({ serviceToken })),
    };
    const service = new ControlPlaneService(prisma as unknown as PrismaService);

    await expect(service.replaceInstallationTelemetryToken(input)).resolves.toMatchObject({
      kind: 'replaced',
      token: { id: 'token-1' },
    });
    expect(serviceToken.update).toHaveBeenCalledWith({
      where: { id: 'token-1' },
      data: expect.objectContaining({ tokenHash: input.tokenHash, lastUsedAt: null, tokenEncrypted: null }),
    });
    expect(serviceToken.create).not.toHaveBeenCalled();
  });

  it('does not replace a derived name owned by another actor', async () => {
    const serviceToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: 'foreign',
        createdBy: 'user-2',
        permissions: ['telemetry:write'],
      }),
      update: vi.fn(),
      create: vi.fn(),
    };
    const prisma = {
      $transaction: vi.fn((work: (tx: unknown) => unknown) => work({ serviceToken })),
    };
    const service = new ControlPlaneService(prisma as unknown as PrismaService);

    await expect(service.replaceInstallationTelemetryToken(input)).resolves.toEqual({ kind: 'conflict' });
    expect(serviceToken.update).not.toHaveBeenCalled();
    expect(serviceToken.create).not.toHaveBeenCalled();
  });

  it('deletes only an exact actor, workspace, name, and permission match', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new ControlPlaneService({ serviceToken: { deleteMany } } as unknown as PrismaService);

    await expect(
      service.deleteInstallationTelemetryToken({
        workspaceId: input.workspaceId,
        name: input.name,
        createdBy: input.createdBy,
        permissions: input.permissions,
      }),
    ).resolves.toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: input.workspaceId,
        name: input.name,
        createdBy: input.createdBy,
        permissions: { equals: ['telemetry:write'] },
      },
    });
  });
});

describe('ControlPlaneService.getWorkspaceOwnerWorkosIdentity', () => {
  it('selects the oldest actual WorkOS owner with a stable user-id tie break', async () => {
    const prisma = {
      workspaceMember: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'github-owner' }, { userId: 'workos-owner' }]),
      },
      oAuthUserProfile: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ profile_id: 'workos-owner', provider: 'workos', provider_user_id: 'workos-user-1' }]),
      },
    };
    const svc = new ControlPlaneService(prisma as unknown as PrismaService);

    await expect(svc.getWorkspaceOwnerWorkosIdentity('ws-1')).resolves.toEqual({
      provider: 'workos',
      provider_user_id: 'workos-user-1',
    });
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] }),
    );
    expect(prisma.oAuthUserProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profile_id: { in: ['github-owner', 'workos-owner'] }, provider: 'workos' },
      }),
    );
  });
});
