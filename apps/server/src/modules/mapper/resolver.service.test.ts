import { describe, it, expect, vi } from 'vitest';
import { ResolverService } from './resolver.service.js';
import { EMPTY_MAPPER } from './mapper.service.js';
import type { MapperService } from './mapper.service.js';
import type { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { IGraphRepository } from '@coredoc/db';
import type { PushLeaseService } from '../lease/push-lease.service.js';

function createMockRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listAllRepositories: vi.fn().mockResolvedValue([
      { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
      { name: 'users-svc', hash: 'h-users', type: 'backend', parsedAt: '' },
    ]),
    listEntrypoints: vi.fn().mockImplementation(async (_p: unknown, hashes: string[]) => {
      // Batched call — fromTurso now issues one listEntrypoints with all hashes.
      // Node IDs carry the hash prefix so fromTurso can re-derive repoName.
      if (!hashes.includes('h-users')) return [];
      return [
        {
          id: 'h-users:entrypoint:src/users.ts:GET:/users/:id',
          type: 'http',
          method: 'GET',
          path: '/users/:id',
          fullPath: '/users/:id',
          handlerId: 'fn-handler',
          filePath: 'src/users.ts',
          startLine: 10,
        },
      ];
    }),
    getExternalCalls: vi.fn().mockImplementation(async (hashes: string[]) => {
      if (!hashes.includes('h-web')) return [];
      return [
        {
          id: 'h-web:external_call:src/api.ts:fetchUser:1',
          callerId: 'fn-1',
          callerName: 'fetchUser',
          callerFilePath: 'src/api.ts',
          serviceName: 'users-svc',
          method: 'getById',
          protocol: 'http' as const,
          httpMethod: 'GET',
          pathTemplate: '/users/:id',
          filePath: 'src/api.ts',
          startLine: 5,
        },
      ];
    }),
    getPackages: vi.fn().mockResolvedValue([]),
    getMonikeredFunctions: vi.fn().mockResolvedValue([]),
    getPackageLinkerFacts: vi.fn().mockResolvedValue({ files: [], declarations: [] }),
    pushEdges: vi.fn().mockResolvedValue(1),
    deleteEdgesByType: vi.fn().mockResolvedValue(undefined),
    updateResolvedTargetIds: vi.fn().mockResolvedValue(undefined),
    clearResolvedTargetIds: vi.fn().mockResolvedValue(undefined),
    getAppliedGraphSnapshot: vi.fn(async (repoId: string) => ({
      parsedVersion: `parsed-${repoId}`,
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: `commit-${repoId}`,
      totalNodeCount: 1,
      totalEdgeCount: 1,
      mode: 'full',
      executionToken: `execution-${repoId}`,
      nodeCount: 1,
      edgeCount: 1,
      receipt: { nodesAdded: 1, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 },
      appliedAt: '2026-08-11T00:00:00.000Z',
    })),
    ...overrides,
  } as unknown as IGraphRepository;
}

function makeDeps(
  repo: IGraphRepository,
  mapperOverride?: () => Promise<{ mapper: typeof EMPTY_MAPPER; sha256: string | null }>,
) {
  const mapperService = {
    loadOrDefault: vi
      .fn()
      .mockImplementation(mapperOverride ?? (async () => ({ mapper: EMPTY_MAPPER, sha256: null, descriptor: null }))),
  } as unknown as MapperService;
  const workspaceDbPool = {
    getRepository: vi.fn().mockResolvedValue(repo),
    acquire: vi.fn().mockResolvedValue(repo),
    release: vi.fn(),
  } as unknown as WorkspaceDbPoolService;
  const controlPlane = {
    getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws1', slug: 'ws-slug', graphBackend: 'turso' }),
    listRepos: vi.fn().mockResolvedValue([
      { id: 'repo-web', repoKey: 'h-web', repoName: 'web', httpPrefix: null },
      { id: 'repo-users', repoKey: 'h-users', repoName: 'users-svc', httpPrefix: null },
    ]),
  } as unknown as ControlPlaneService;
  const pushLeases = {
    acquireGraphWrite: vi.fn(async (_workspaceId: string, ownerToken: string) => ({ ownerToken, generation: 1n })),
    startRenewal: vi.fn(() => setInterval(() => undefined, 2 ** 30)),
    renewGraphWrite: vi.fn(async () => true),
    releaseGraphWrite: vi.fn(async () => undefined),
  } as unknown as PushLeaseService;
  return {
    mapperService,
    workspaceDbPool,
    controlPlane,
    pushLeases,
  };
}

describe('ResolverService.resolveWorkspace', () => {
  it('returns zero metrics when project has zero repos', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    (deps.controlPlane.listRepos as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    const result = await svc.resolveWorkspace('ws1');
    expect(result.resolved).toBe(0);
    expect(result.total).toBe(0);
    expect(result.legacyEdges).toBe(0);
  });

  it('throws if workspace database is not available', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    (deps.workspaceDbPool.acquire as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    await expect(svc.resolveWorkspace('ws1')).rejects.toThrow();
  });

  it('runs the unified linker, writes RESOLVES_TO edges, returns metrics', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    const result = await svc.resolveWorkspace('ws1');

    expect(result.total).toBe(1);
    expect(result.resolved).toBe(1);

    expect(repo.deleteEdgesByType).toHaveBeenCalledWith('RESOLVES_TO', expect.arrayContaining(['h-web', 'h-users']));
    expect(repo.pushEdges).toHaveBeenCalled();
    const pushed = (repo.pushEdges as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Array<{
      type: string;
      sourceId: string;
      targetId: string;
      id: string;
      createdBy: string;
      properties: Record<string, unknown>;
    }>;
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.type).toBe('RESOLVES_TO');
    expect(pushed[0]?.sourceId).toBe('h-web:external_call:src/api.ts:fetchUser:1');
    expect(pushed[0]?.targetId).toBe('h-users:entrypoint:src/users.ts:GET:/users/:id');
    expect(pushed[0]?.createdBy).toBe('ai');
    expect(pushed[0]?.id).toBe(
      'resolve:h-web:external_call:src/api.ts:fetchUser:1:h-users:entrypoint:src/users.ts:GET:/users/:id',
    );
    expect(Array.isArray(pushed[0]?.properties.chain)).toBe(true);
  });

  it('resolves existing Turso repos when another connected repo has never been pushed', async () => {
    const repo = createMockRepo({
      listAllRepositories: vi.fn().mockResolvedValue([{ name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' }]),
      getAppliedGraphSnapshot: vi.fn(async (repoId: string) =>
        repoId === 'h-web'
          ? {
              parsedVersion: 'parsed-h-web',
              summaryVersion: null,
              embeddingsVersion: null,
              commitSha: null,
            }
          : null,
      ),
    });
    const deps = makeDeps(repo);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);

    await expect(svc.resolveWorkspace('ws1')).resolves.toMatchObject({ resolved: 0, total: 1 });

    expect(repo.listEntrypoints).toHaveBeenCalledWith({}, ['h-web']);
    expect(repo.getExternalCalls).toHaveBeenCalledWith(['h-web']);
    expect(repo.listAllRepositories).toHaveBeenCalledTimes(1);
    expect(repo.deleteEdgesByType).toHaveBeenCalledWith('RESOLVES_TO', ['h-web']);
  });

  it('holds the distributed workspace graph lease for direct resolver calls', async () => {
    const order: string[] = [];
    const repo = createMockRepo({
      listAllRepositories: vi.fn(async () => {
        order.push('read');
        return [
          { name: 'web', hash: 'h-web', type: 'frontend', parsedAt: '' },
          { name: 'users-svc', hash: 'h-users', type: 'backend', parsedAt: '' },
        ];
      }),
      pushEdges: vi.fn(async () => {
        order.push('write');
        return 1;
      }),
    });
    const deps = makeDeps(repo);
    const timer = setInterval(() => undefined, 60_000);
    const leases = {
      acquireGraphWrite: vi.fn(async () => {
        order.push('acquire');
        return { ownerToken: '22222222-2222-4222-8222-222222222222', generation: 1n };
      }),
      startRenewal: vi.fn(() => timer),
      renewGraphWrite: vi.fn(async () => true),
      releaseGraphWrite: vi.fn(async () => {
        order.push('release');
      }),
    } as unknown as PushLeaseService;
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, leases);

    await svc.resolveWorkspace('ws1');

    expect(order).toEqual(['read', 'acquire', 'write', 'release']);
  });

  it('never persists a resolution computed before an applied snapshot changed', async () => {
    let snapshotReads = 0;
    const repo = createMockRepo({
      getAppliedGraphSnapshot: vi.fn(async (repoId: string) => {
        snapshotReads += 1;
        const generation = snapshotReads <= 2 ? 'before' : 'after';
        return {
          parsedVersion: `${generation}-${repoId}`,
          summaryVersion: null,
          embeddingsVersion: null,
          commitSha: null,
        };
      }),
    });
    const deps = makeDeps(repo);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);

    await expect(svc.resolveWorkspace('ws1')).rejects.toMatchObject({
      code: 'graph_resolution_inputs_changed',
      retryable: true,
    });
    expect(repo.deleteEdgesByType).not.toHaveBeenCalled();
    expect(repo.pushEdges).not.toHaveBeenCalled();
  });

  it('never persists a resolution computed before the control-plane repository topology changed', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    const before = [
      { id: 'repo-web', repoKey: 'h-web', repoName: 'web', httpPrefix: null },
      { id: 'repo-users', repoKey: 'h-users', repoName: 'users-svc', httpPrefix: null },
    ];
    const after = before.map((entry) => (entry.id === 'repo-users' ? { ...entry, httpPrefix: '/v2/users' } : entry));
    (deps.controlPlane.listRepos as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);

    await expect(svc.resolveWorkspace('ws1')).rejects.toMatchObject({
      code: 'graph_resolution_inputs_changed',
      retryable: true,
    });
    expect(deps.controlPlane.listRepos).toHaveBeenCalledTimes(2);
    expect(repo.deleteEdgesByType).not.toHaveBeenCalled();
    expect(repo.pushEdges).not.toHaveBeenCalled();
  });

  it('never persists a resolution computed before the mapper descriptor changed', async () => {
    const before = { r2Key: 'ws1/mapper/before.json', sha256: 'a'.repeat(64), sizeBytes: '42' };
    const after = { r2Key: 'ws1/mapper/after.json', sha256: 'b'.repeat(64), sizeBytes: '43' };
    let current = before;
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    (deps.mapperService.loadOrDefault as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      mapper: EMPTY_MAPPER,
      sha256: current.sha256,
      descriptor: current,
    }));
    (deps.pushLeases.acquireGraphWrite as ReturnType<typeof vi.fn>).mockImplementation(
      async (_workspaceId: string, ownerToken: string) => {
        current = after;
        return { ownerToken, generation: 1n };
      },
    );
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);

    await expect(svc.resolveWorkspace('ws1')).rejects.toMatchObject({
      code: 'graph_resolution_inputs_changed',
      retryable: true,
    });
    expect(deps.mapperService.loadOrDefault).toHaveBeenCalledTimes(2);
    expect(repo.deleteEdgesByType).not.toHaveBeenCalled();
    expect(repo.pushEdges).not.toHaveBeenCalled();
  });

  it('treats an unreadable backend on the post-lease re-read as changed inputs, not a 409 backend conflict', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    (deps.controlPlane.getWorkspaceById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'ws1', slug: 'ws-slug', graphBackend: 'turso' })
      .mockResolvedValueOnce({ id: 'ws1', slug: 'ws-slug', graphBackend: 'postgres' });
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);

    await expect(svc.resolveWorkspace('ws1')).rejects.toMatchObject({
      code: 'graph_resolution_inputs_changed',
      retryable: true,
    });
    expect(repo.deleteEdgesByType).not.toHaveBeenCalled();
    expect(repo.pushEdges).not.toHaveBeenCalled();
  });

  it('serializes concurrent resolveWorkspace calls and coalesces queued runs', async () => {
    // The contract: when N pushes (or pushes + mapper PUT) race against the
    // same workspace, the resolver runs them sequentially (so delete-then-
    // insert never interleaves) AND coalesces the queued runs — every caller
    // that arrives while a run is in flight gets the SAME next snapshot.
    // For a burst of 3 calls this collapses 3 passes to 2 (running + queued).
    const repo = createMockRepo();
    const deps = makeDeps(repo);

    let inFlight = 0;
    let maxInFlight = 0;
    (repo.pushEdges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 1;
    });

    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    await Promise.all([svc.resolveWorkspace('ws1'), svc.resolveWorkspace('ws1'), svc.resolveWorkspace('ws1')]);

    expect(maxInFlight).toBe(1);
    // 3 callers coalesced into 2 inner runs (1 running + 1 queued for the others).
    expect(repo.deleteEdgesByType).toHaveBeenCalledTimes(2);
    expect(repo.pushEdges).toHaveBeenCalledTimes(2);
  });

  it('queues subsequent calls even when the previous one fails', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo);
    (repo.pushEdges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(1);

    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    const [first, second] = await Promise.allSettled([svc.resolveWorkspace('ws1'), svc.resolveWorkspace('ws1')]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('passes the loaded mapper override into the linker and reports its sha', async () => {
    const repo = createMockRepo();
    const deps = makeDeps(repo, async () => ({
      mapper: {
        $schemaVersion: 1 as const,
        project: 'demo',
        services: [{ name: 'users-svc', repo: 'users-svc', aliases: [] }],
        sdkMappings: [],
        pathRewriteRules: [],
        unresolvableServices: [],
      },
      sha256: 'sha-xyz',
      descriptor: { r2Key: 'ws1/mapper/sha-xyz.json', sha256: 'sha-xyz', sizeBytes: '42' },
    }));
    const svc = new ResolverService(deps.mapperService, deps.workspaceDbPool, deps.controlPlane, deps.pushLeases);
    const result = await svc.resolveWorkspace('ws1');
    expect(result.mapperSha).toBe('sha-xyz');
    expect(result.resolved).toBe(1);
  });
});
