import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { TelemetryService } from '../telemetry/telemetry.service.js';
import type { ResolverService } from '../mapper/resolver.service.js';
import { PushService, isConnectionError } from './push.service.js';
import { getConfiguredBackend, ensureGraphIndexes } from '@coredoc/db';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import type { ResultStorageService } from './result-storage.service.js';
import type { DiffEngine } from './diff-engine.js';
import type { ParsedRepo, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';
import type { GraphSnapshotControlPlaneService } from '../graph-snapshot/graph-snapshot-control-plane.service.js';

const mockTransform = vi.hoisted(() =>
  vi.fn(() => ({
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    edges: [{ id: 'e1' }],
  })),
);

const mockNormalizeMetadata = vi.hoisted(() =>
  vi.fn((_repo: unknown, summaryOutput: unknown, embeddingsOutput: unknown) => ({
    summaryOutput,
    embeddingsOutput,
    dropped: { summaries: 0, functionEmbeddings: 0, endpointEmbeddings: 0, total: 0 },
  })),
);

vi.mock('@coredoc/db', () => ({
  GraphApplyMode: { Full: 'full', Incremental: 'incremental', Metadata: 'metadata' },
  transformParsedRepo: mockTransform,
  getTransformStats: vi.fn(() => ({
    nodesByType: { function: 2 },
    edgesByType: { CALLS: 1 },
    totalNodes: 2,
    totalEdges: 1,
    nodesWithSummaries: 0,
    nodesWithEmbeddings: 0,
  })),
  containsSourceCode: vi.fn(() => false),
  embeddingsContainInputText: vi.fn(() => false),
  getConfiguredBackend: vi.fn(() => 'sqlite'),
  ensureGraphIndexes: vi.fn().mockResolvedValue(undefined),
  normalizeMetadataForParsedRepo: mockNormalizeMetadata,
}));

function createMockControlPlane() {
  return {
    getWorkspaceById: vi.fn(),
    listRepos: vi.fn().mockResolvedValue([{ id: 'repo-row-abc', repoKey: 'repo_abc', repoName: 'my-service' }]),
    updateRepoPushMetadata: vi.fn().mockResolvedValue(true),
  };
}

function createMockWorkspaceDbPool() {
  // getRepository preserved for any short-lived-read callers; acquire/release
  // are the new contract for PushService and ResolverService. Tests below
  // mock `acquire` via the same `mockResolvedValue` calls as before
  // (`workspaceDbPool.acquire.mockResolvedValue(repository)`) — easier than
  // ripping every mock. release is a vi.fn() so calls can be asserted if needed.
  return {
    getRepository: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
    closeConnection: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockResultStorage() {
  const storage = {
    uploadResult: vi.fn(),
    uploadSummary: vi.fn(),
    uploadEmbeddings: vi.fn(),
    downloadLatestSummary: vi.fn(),
    getLatestSummaryUrl: vi.fn(),
    downloadResult: vi.fn(),
    downloadSummary: vi.fn(),
    downloadEmbeddings: vi.fn(),
    getManifest: vi.fn(),
    updateManifest: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...storage,
    downloadResultForGraph: vi.fn(async (workspaceId: string, _repoKey: string, repoName: string, version: string) => {
      const value = await storage.downloadResult(workspaceId, repoName, version);
      return value ? { value, registered: true } : null;
    }),
    downloadSummaryForGraph: vi.fn(async (workspaceId: string, _repoKey: string, repoName: string, version: string) => {
      const value = await storage.downloadSummary(workspaceId, repoName, version);
      return value ? { value, registered: true } : null;
    }),
    downloadEmbeddingsForGraph: vi.fn(
      async (workspaceId: string, _repoKey: string, repoName: string, version: string) => {
        const value = await storage.downloadEmbeddings(workspaceId, repoName, version);
        return value ? { value, registered: true } : null;
      },
    ),
  };
}

function createMockDiffEngine() {
  return {
    computeChangeset: vi.fn(),
  };
}

function createMockMetricsService() {
  return {
    recordPushMetrics: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTelemetryService() {
  return {
    trackEvent: vi.fn(),
  };
}

function createMockResolverService() {
  return {
    resolveWorkspace: vi.fn().mockResolvedValue({
      resolved: 0,
      total: 0,
      rate: 0,
      legacyEdges: 0,
      mapperSha: null,
    }),
  };
}

function createMockGraphSnapshotControlPlane() {
  const controlPlane = {
    resolveArtifactRepository: vi.fn().mockResolvedValue({
      workspaceId: 'ws_1',
      repoKey: 'repo_abc',
      repoName: 'my-service',
    }),
    registerArtifact: vi.fn(async (input: unknown) => input),
  };
  return controlPlane;
}

function createMockRepository() {
  return {
    deleteRepository: vi.fn().mockResolvedValue(undefined),
    pushNodes: vi.fn().mockResolvedValue(2),
    pushEdges: vi.fn().mockResolvedValue(1),
    listAllRepositories: vi.fn().mockResolvedValue([]),
    getRepositoryNames: vi.fn().mockResolvedValue([]),
    getAppliedGraphSnapshot: vi.fn().mockResolvedValue(null),
    applyChangeset: vi.fn().mockResolvedValue({
      nodesAdded: 0,
      nodesUpdated: 0,
      nodesDeleted: 0,
      edgesDeleted: 1,
      edgesInserted: 1,
    }),
  };
}

function makeParsedRepo(overrides: Partial<ParsedRepo> = {}): ParsedRepo {
  return {
    id: 'repo_abc',
    name: 'my-service',
    path: '/repo',
    parsedAt: new Date().toISOString(),
    parserVersion: '1.0.0',
    parserId: 'parser-1',
    packages: [],
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 0,
      totalFunctions: 0,
      totalClasses: 0,
      totalEntrypoints: 0,
      parseTimeMs: 0,
    },
    ...overrides,
  } as ParsedRepo;
}

function makeFunction(versionedId = 'fn_1:v1'): ParsedRepo['functions'][number] {
  return {
    id: 'fn_1',
    versionedId,
    name: 'work',
    location: { filePath: 'src/work.ts', startLine: 1, endLine: 3 },
    parameters: [],
    returnType: { raw: 'void' },
    isExported: true,
    isAsync: false,
  } as ParsedRepo['functions'][number];
}

function makeSummaryOutput(overrides: Partial<SummaryOutput> = {}): SummaryOutput {
  return {
    repoId: 'repo_abc',
    repoName: 'my-service',
    generatedAt: '2026-04-02T00:00:00.000Z',
    summarizerVersion: '1.0.0',
    summaries: [],
    stats: {
      totalFunctions: 0,
      summarized: 0,
      skippedCached: 0,
      failedSummarization: 0,
      processingTimeMs: 0,
    },
    ...overrides,
  } as SummaryOutput;
}

function makeEmbeddingsOutput(overrides: Partial<EmbeddingsOutput> = {}): EmbeddingsOutput {
  return {
    repoId: 'repo_abc',
    repoName: 'my-service',
    generatedAt: '2026-04-02T00:00:00.000Z',
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimensions: 2,
    inputStrategy: 'summary',
    functions: [
      {
        functionId: 'fn_1',
        versionedId: 'fn_1:v1',
        name: 'work',
        filePath: 'src/work.ts',
        inputChecksum: 'checksum-1',
        embedding: [0.1, 0.2],
        generatedAt: '2026-04-02T00:00:00.000Z',
      },
    ],
    endpoints: [],
    stats: {},
    ...overrides,
  } as EmbeddingsOutput;
}

describe('isConnectionError', () => {
  it('recognizes Neo4j bolt connection failures by code', () => {
    expect(
      isConnectionError(Object.assign(new Error('Connection was closed by server'), { code: 'ServiceUnavailable' })),
    ).toBe(true);
    expect(isConnectionError(Object.assign(new Error('routing failed'), { code: 'SessionExpired' }))).toBe(true);
  });

  it('recognizes libsql/Turso connection failures by message', () => {
    expect(isConnectionError(new Error('fetch failed'))).toBe(true);
    expect(isConnectionError(new Error('stream closed: TRANSACTION_CLOSED'))).toBe(true);
    expect(isConnectionError(new Error('SERVER_ERROR: 404'))).toBe(true);
  });

  it.each([
    'HRANA_WEBSOCKET_ERROR',
    'HRANA_CLOSED_ERROR',
    'HRANA_PROTO_ERROR',
    'CLIENT_CLOSED',
  ])('recognizes libsql/Turso connection failure code %s', (code) => {
    expect(isConnectionError(Object.assign(new Error('transport failed'), { code }))).toBe(true);
  });

  it('ignores ordinary application errors', () => {
    expect(isConnectionError(new Error('constraint validation failed'))).toBe(false);
    expect(
      isConnectionError(Object.assign(new Error('bad query'), { code: 'Neo.ClientError.Statement.SyntaxError' })),
    ).toBe(false);
    expect(isConnectionError('not an error')).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe('PushService', () => {
  let service: PushService;
  let controlPlane: ReturnType<typeof createMockControlPlane>;
  let workspaceDbPool: ReturnType<typeof createMockWorkspaceDbPool>;
  let resultStorage: ReturnType<typeof createMockResultStorage>;
  let diffEngine: ReturnType<typeof createMockDiffEngine>;
  let metrics: ReturnType<typeof createMockMetricsService>;
  let telemetry: ReturnType<typeof createMockTelemetryService>;
  let resolver: ReturnType<typeof createMockResolverService>;
  let repository: ReturnType<typeof createMockRepository>;
  let graphSnapshotControlPlane: ReturnType<typeof createMockGraphSnapshotControlPlane>;

  beforeEach(() => {
    mockTransform.mockReset();
    mockTransform.mockReturnValue({
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      edges: [{ id: 'e1' }],
    });
    mockNormalizeMetadata.mockClear();
    controlPlane = createMockControlPlane();
    workspaceDbPool = createMockWorkspaceDbPool();
    resultStorage = createMockResultStorage();
    diffEngine = createMockDiffEngine();
    metrics = createMockMetricsService();
    telemetry = createMockTelemetryService();
    resolver = createMockResolverService();
    repository = createMockRepository();
    graphSnapshotControlPlane = createMockGraphSnapshotControlPlane();
    service = new PushService(
      controlPlane as unknown as ControlPlaneService,
      workspaceDbPool as unknown as WorkspaceDbPoolService,
      resultStorage as unknown as ResultStorageService,
      diffEngine as unknown as DiffEngine,
      metrics as unknown as MetricsService,
      telemetry as unknown as TelemetryService,
      resolver as unknown as ResolverService,
      createLeaseFake() as unknown as PushLeaseService,
      graphSnapshotControlPlane as unknown as GraphSnapshotControlPlaneService,
    );
  });

  function arrangeExistingVersion(
    oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' }),
    newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' }),
  ): void {
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockImplementation(
      async (_workspaceId: string, _repoName: string, version: string) => {
        if (version === 'new-version') return newParsed;
        if (version === 'old-version') return oldParsed;
        return null;
      },
    );
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
  }

  it('reads the persisted graph backend and rejects an unknown workspace', async () => {
    controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws_1', graphBackend: 'file_snapshot' });
    await expect(service.getWorkspaceGraphBackend('ws_1')).resolves.toBe('file_snapshot');

    controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws_1' });
    await expect(service.getWorkspaceGraphBackend('ws_1')).resolves.toBe('file_snapshot');

    controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws_1', graphBackend: 'turso' });
    await expect(service.getWorkspaceGraphBackend('ws_1')).resolves.toBe('turso');

    controlPlane.getWorkspaceById.mockResolvedValueOnce(null);
    await expect(service.getWorkspaceGraphBackend('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails a direct file_snapshot mutation after resolving the exact route identity and before graph/storage access', async () => {
    controlPlane.getWorkspaceById.mockResolvedValue({
      id: 'ws_1',
      slug: 'my-workspace',
      graphBackend: 'file_snapshot',
    });
    controlPlane.listRepos.mockResolvedValue([{ repoKey: 'repo_abc', repoName: 'my-service' }]);

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toMatchObject({
      code: 'file_snapshot_requires_worker',
    });
    expect(controlPlane.listRepos).toHaveBeenCalledWith('ws_1');
    expect(workspaceDbPool.acquire).not.toHaveBeenCalled();
    expect(resultStorage.downloadResult).not.toHaveBeenCalled();
    expect(controlPlane.updateRepoPushMetadata).not.toHaveBeenCalled();
  });

  it('resolves exactly one connected repo before upload and records the immutable descriptor only after object storage', async () => {
    resultStorage.uploadResult.mockResolvedValue({
      version: '1'.repeat(16),
      r2Key: 'ws_1/my-service/results/parsed/1111111111111111.json',
      sha256: '1'.repeat(64),
      sizeBytes: 423,
      uploadedAt: '2026-08-11T00:00:00.000Z',
      duplicate: false,
    });

    await service.uploadResult('ws_1', 'my-service', makeParsedRepo());

    expect(graphSnapshotControlPlane.resolveArtifactRepository).toHaveBeenCalledWith('ws_1', 'my-service');
    expect(graphSnapshotControlPlane.registerArtifact).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      repoName: 'my-service',
      kind: 'parsed',
      version: '1'.repeat(16),
      r2Key: 'ws_1/my-service/results/parsed/1111111111111111.json',
      sha256: '1'.repeat(64),
      sizeBytes: 423,
    });
    expect(graphSnapshotControlPlane.resolveArtifactRepository.mock.invocationCallOrder[0]).toBeLessThan(
      resultStorage.uploadResult.mock.invocationCallOrder[0],
    );
    expect(resultStorage.uploadResult.mock.invocationCallOrder[0]).toBeLessThan(
      graphSnapshotControlPlane.registerArtifact.mock.invocationCallOrder[0],
    );
  });

  it.each([
    {
      versionArgs: ['sum_v1', undefined] as const,
      exclusions: { excludeSummaries: true },
      message: /summaryVersion cannot be combined with excludeSummaries/,
    },
    {
      versionArgs: [undefined, 'emb_v1'] as const,
      exclusions: { excludeEmbeddings: true },
      message: /embeddingsVersion cannot be combined with excludeEmbeddings/,
    },
  ])('rejects contradictory metadata selection before acquiring the graph', async ({
    versionArgs,
    exclusions,
    message,
  }) => {
    await expect(
      service.pushByVersion(
        'ws_1',
        'my-service',
        'v1',
        null,
        'user_1',
        versionArgs[0],
        versionArgs[1],
        false,
        false,
        exclusions,
      ),
    ).rejects.toThrow(message);

    expect(controlPlane.getWorkspaceById).not.toHaveBeenCalled();
    expect(workspaceDbPool.acquire).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous route name before acquiring or mutating the graph', async () => {
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    controlPlane.listRepos.mockResolvedValue([
      { repoKey: 'repo_abc', repoName: 'my-service' },
      { repoKey: 'repo_sibling', repoName: 'my-service' },
    ]);

    await expect(service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1')).rejects.toThrow(
      /ambiguous.*Disconnect the duplicate entries/i,
    );

    expect(workspaceDbPool.acquire).not.toHaveBeenCalled();
    expect(resultStorage.downloadResult).not.toHaveBeenCalled();
    expect(repository.applyChangeset).not.toHaveBeenCalled();
  });

  it('rejects a parsed artifact carrying a sibling repo id before graph mutation', async () => {
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(makeParsedRepo({ id: 'repo_sibling' }));

    await expect(service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1')).rejects.toThrow(
      /connected route identity.*Disconnect and reconnect/i,
    );

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('rejects a registered parsed object whose bytes fail full identity verification before graph mutation', async () => {
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResultForGraph.mockRejectedValueOnce(
      Object.assign(new Error('Registered parsed bytes do not match their immutable descriptor'), {
        code: 'artifact_integrity_error',
      }),
    );

    await expect(service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1')).rejects.toMatchObject({
      code: 'artifact_integrity_error',
    });

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('rejects a previous artifact carrying a sibling repo id before diffing', async () => {
    arrangeExistingVersion(makeParsedRepo({ id: 'repo_sibling' }), makeParsedRepo());

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      /Previous parse artifact.*connected route identity/i,
    );

    expect(diffEngine.computeChangeset).not.toHaveBeenCalled();
    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('applies and finalizes a Turso push without a graph-backend transition transaction', async () => {
    const newParsed = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: null,
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: null,
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });

    const result = await service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1', undefined, undefined, true);

    expect(result.resolution).toBeUndefined();
    expect(resolver.resolveWorkspace).not.toHaveBeenCalled();
    expect(repository.getRepositoryNames).toHaveBeenCalledWith(['repo_abc']);
    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo_abc', repoIdsToDelete: ['repo_abc'] }),
      expect.objectContaining({ snapshot: expect.objectContaining({ parsedVersion: 'v1', mode: 'full' }) }),
    );
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ repoKey: 'repo_abc', repoName: 'my-service' }),
      {
        lastParseHash: 'v1',
        lastPushedByUserId: 'user_1',
        nodeCount: 2,
        edgeCount: 1,
        lastParsedVersion: 'v1',
        lastSummaryVersion: null,
        lastEmbedVersion: null,
      },
    );
    expect(repository.applyChangeset.mock.invocationCallOrder[0]).toBeLessThan(
      controlPlane.updateRepoPushMetadata.mock.invocationCallOrder[0]!,
    );
    expect(resultStorage.updateManifest).toHaveBeenCalledWith('ws_1', 'my-service', 'v1', null);
    expect(controlPlane.updateRepoPushMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      resultStorage.updateManifest.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses to publish selections when the connected repository row changed during the push', async () => {
    const newParsed = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    controlPlane.listRepos.mockResolvedValue([{ id: 'repo-row-old', repoKey: 'repo_abc', repoName: 'my-service' }]);
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: null,
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: null,
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    controlPlane.updateRepoPushMetadata.mockResolvedValueOnce(false);

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1', undefined, undefined, true),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });

    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      { id: 'repo-row-old', repoKey: 'repo_abc', repoName: 'my-service' },
      expect.any(Object),
    );
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('does not persist Turso selections when the graph apply fails', async () => {
    const newParsed = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: null,
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: null,
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    repository.applyChangeset.mockRejectedValueOnce(new Error('graph apply failed'));

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1', undefined, undefined, true),
    ).rejects.toThrow('graph apply failed');

    expect(controlPlane.updateRepoPushMetadata).not.toHaveBeenCalled();
  });

  it('ensures Neo4j graph indexes once before writing (memoized across pushes)', async () => {
    vi.mocked(getConfiguredBackend).mockReturnValue('neo4j');
    vi.mocked(ensureGraphIndexes).mockClear();
    try {
      const newParsed = makeParsedRepo();
      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
      workspaceDbPool.acquire.mockResolvedValue(repository);
      resultStorage.downloadResult.mockResolvedValue(newParsed);
      resultStorage.getManifest.mockResolvedValue({
        currentParsed: null,
        currentSummary: null,
        summaryUploadedAt: null,
        commitSha: null,
        updatedAt: '2026-04-01T00:00:00.000Z',
        history: [],
      });

      await service.pushByVersion('ws_1', 'my-service', 'v1', null, 'user_1');
      await service.pushByVersion('ws_1', 'my-service', 'v2', null, 'user_1');

      // Indexed before the write, and memoized: ensured once per process, not per push.
      expect(ensureGraphIndexes).toHaveBeenCalledTimes(1);
      expect(repository.applyChangeset).toHaveBeenCalled();
    } finally {
      // Restore the default so sibling tests keep the SQLite (no-op) path.
      vi.mocked(getConfiguredBackend).mockReturnValue('sqlite');
    }
  });

  it('applies edge-only incremental changes instead of treating them as a no-op', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockImplementation(
      async (_workspaceId: string, _repoName: string, version: string) => {
        if (version === 'new-version') return newParsed;
        if (version === 'old-version') return oldParsed;
        return null;
      },
    );
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    diffEngine.computeChangeset.mockResolvedValue({
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['fn_1'],
      edgesToInsert: [{ id: 'edge_1', sourceId: 'fn_1', targetId: 'fn_2', type: 'CALLS' }],
      totalNodeCount: 2,
      totalEdgeCount: 1,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 1,
        edgesInserted: 1,
      },
    });

    const result = await service.pushByVersion('ws_1', 'my-service', 'new-version', 'def456', 'user_1');

    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      repoName: 'my-service',
      mode: 'incremental',
      edgesInserted: 1,
      edgesDeleted: 1,
      unchanged: 0,
      version: 'new-version',
    });
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ repoKey: 'repo_abc', repoName: 'my-service' }),
      {
        lastParseHash: 'new-version',
        lastPushedByUserId: 'user_1',
        nodeCount: 2,
        edgeCount: 1,
        lastParsedVersion: 'new-version',
        lastSummaryVersion: null,
        lastEmbedVersion: null,
      },
    );
  });

  it('retries an incremental graph write when the Neo4j connection drops, then succeeds', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockImplementation(
      async (_workspaceId: string, _repoName: string, version: string) => {
        if (version === 'new-version') return newParsed;
        if (version === 'old-version') return oldParsed;
        return null;
      },
    );
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    diffEngine.computeChangeset.mockResolvedValue({
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['fn_1'],
      edgesToInsert: [{ id: 'edge_1', sourceId: 'fn_1', targetId: 'fn_2', type: 'CALLS' }],
      totalNodeCount: 2,
      totalEdgeCount: 1,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 1,
        edgesInserted: 1,
      },
    });

    // First attempt hits a dropped pooled bolt connection (ServiceUnavailable);
    // the retry lands on a fresh connection and succeeds.
    const connErr = Object.assign(new Error('Connection was closed by server'), { code: 'ServiceUnavailable' });
    repository.applyChangeset.mockRejectedValueOnce(connErr).mockResolvedValueOnce({
      nodesAdded: 0,
      nodesUpdated: 0,
      nodesDeleted: 0,
      edgesDeleted: 1,
      edgesInserted: 1,
    });

    const result = await service.pushByVersion('ws_1', 'my-service', 'new-version', 'def456', 'user_1');

    expect(repository.applyChangeset).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ mode: 'incremental', edgesInserted: 1, edgesDeleted: 1 });
  });

  it('recognizes an ambiguous commit from the fresh-connection snapshot without reapplying', async () => {
    const executionToken = '11111111-1111-4111-8111-111111111111';
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });
    arrangeExistingVersion(oldParsed, newParsed);
    diffEngine.computeChangeset.mockResolvedValue({
      repoId: 'repo_abc',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['fn_1'],
      edgesToInsert: [{ id: 'edge_1' }],
      totalNodeCount: 2,
      totalEdgeCount: 1,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 1,
        edgesInserted: 1,
      },
    });
    const committed = {
      parsedVersion: 'new-version',
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: 'def456',
      totalNodeCount: 2,
      totalEdgeCount: 1,
      nodeCount: 2,
      edgeCount: 1,
      mode: 'incremental',
      executionToken,
      appliedAt: '2026-08-04T00:00:00.000Z',
      receipt: { nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 1, edgesInserted: 1 },
    };
    repository.getAppliedGraphSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce(committed);
    repository.applyChangeset.mockRejectedValueOnce(
      Object.assign(new Error('commit response lost'), { code: 'ServiceUnavailable' }),
    );

    const result = await service.pushByVersion(
      'ws_1',
      'my-service',
      'new-version',
      'def456',
      'user_1',
      undefined,
      undefined,
      true,
      false,
      {},
      { executionToken, report: vi.fn() },
    );

    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ edgesInserted: 1, edgesDeleted: 1 });
  });

  it('propagates an incremental write error without replacing the repository', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockImplementation(
      async (_workspaceId: string, _repoName: string, version: string) => {
        if (version === 'new-version') return newParsed;
        if (version === 'old-version') return oldParsed;
        return null;
      },
    );
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    diffEngine.computeChangeset.mockResolvedValue({
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['fn_1'],
      edgesToInsert: [{ id: 'edge_1', sourceId: 'fn_1', targetId: 'fn_2', type: 'CALLS' }],
      totalNodeCount: 2,
      totalEdgeCount: 1,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 1,
        edgesInserted: 1,
      },
    });

    // A non-connection error is not retried and must never broaden into a
    // destructive repository replacement.
    repository.applyChangeset.mockRejectedValue(new Error('constraint validation failed'));

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', 'def456', 'user_1')).rejects.toThrow(
      'constraint validation failed',
    );

    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(repository.pushNodes).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('rejects a missing previous artifact without replacing the repository', async () => {
    arrangeExistingVersion();
    resultStorage.downloadResult.mockImplementation(async (_workspaceId: string, _repoName: string, version: string) =>
      version === 'new-version' ? makeParsedRepo() : null,
    );

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      /Previous parse artifact "old-version".*coredoc push my-service --remote --workspace-id ws_1 --rebuild/,
    );

    expect(diffEngine.computeChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('propagates a diff safety rejection without replacing the repository', async () => {
    arrangeExistingVersion();
    diffEngine.computeChangeset.mockRejectedValue(new BadRequestException('mass deletion refused'));

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      'mass deletion refused',
    );

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('propagates an unexpected diff error without replacing the repository', async () => {
    arrangeExistingVersion();
    diffEngine.computeChangeset.mockRejectedValue(new Error('transform failed'));

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      'transform failed',
    );

    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('rejects a missing manifest when the repository graph already exists', async () => {
    const parsedRepo = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.getManifest.mockResolvedValue({ currentParsed: null });
    repository.getRepositoryNames.mockResolvedValue([{ hash: parsedRepo.id, name: parsedRepo.name }]);

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      /parsed pointer.*graph snapshot.*graph is already present.*coredoc push my-service --remote --workspace-id ws_1 --rebuild/i,
    );

    expect(repository.getRepositoryNames).toHaveBeenCalledWith(['repo_abc']);
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('resumes finalization from a matching graph snapshot when the manifest pointer is missing', async () => {
    const parsedRepo = makeParsedRepo();
    const executionToken = '11111111-1111-4111-8111-111111111111';
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.getManifest.mockResolvedValue({ currentParsed: null });
    repository.getAppliedGraphSnapshot.mockResolvedValue({
      parsedVersion: 'new-version',
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: 'def456',
      totalNodeCount: 2,
      totalEdgeCount: 1,
      nodeCount: 2,
      edgeCount: 1,
      mode: 'incremental',
      executionToken,
      appliedAt: '2026-08-04T00:00:00.000Z',
      receipt: { nodesAdded: 1, nodesUpdated: 1, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 },
    });

    const result = await service.pushByVersion(
      'ws_1',
      'my-service',
      'new-version',
      'def456',
      'user_1',
      undefined,
      undefined,
      true,
    );

    expect(result).toMatchObject({ mode: 'incremental', totalNodeCount: 2, totalEdgeCount: 1 });
    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.getRepositoryNames).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).toHaveBeenCalledWith('ws_1', 'my-service', 'new-version', 'def456');
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalled();
    expect(metrics.recordPushMetrics).toHaveBeenCalledWith(expect.objectContaining({ executionToken }));
  });

  it('allows an explicit rebuild and bypasses the diff safety path', async () => {
    arrangeExistingVersion();

    const result = await service.pushByVersion(
      'ws_1',
      'my-service',
      'new-version',
      null,
      'user_1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(result.mode).toBe('full');
    expect(diffEngine.computeChangeset).not.toHaveBeenCalled();
    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo_abc',
        repoIdsToDelete: ['repo_abc'],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
      }),
      expect.objectContaining({ snapshot: expect.objectContaining({ parsedVersion: 'new-version', mode: 'full' }) }),
    );
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(repository.pushNodes).not.toHaveBeenCalled();
    expect(repository.pushEdges).not.toHaveBeenCalled();
  });

  it('replaces the graph in full when an earlier chunked apply left its in-flight mark', async () => {
    arrangeExistingVersion();
    (repository as unknown as { getPendingGraphApply: ReturnType<typeof vi.fn> }).getPendingGraphApply = vi
      .fn()
      .mockResolvedValue('interrupted-version');

    const result = await service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1');

    expect(result.mode).toBe('full');
    expect(diffEngine.computeChangeset).not.toHaveBeenCalled();
    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo_abc', repoIdsToDelete: ['repo_abc'] }),
      expect.objectContaining({ snapshot: expect.objectContaining({ parsedVersion: 'new-version', mode: 'full' }) }),
    );
  });

  it('rejects explicit rebuild after repo-key rotation until control-plane identity is reconnected', async () => {
    arrangeExistingVersion(undefined, makeParsedRepo({ id: 'repo_new' }));

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1', undefined, undefined, false, true),
    ).rejects.toThrow(/Disconnect and reconnect.*key intentionally changed/);

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('preserves manifest-current metadata when an incremental push omits artifact versions', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z', functions: [makeFunction()] });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z', functions: [makeFunction()] });
    const summaryOutput = makeSummaryOutput({
      summaries: [
        {
          functionId: 'fn_1',
          versionedId: 'fn_1:v1',
          detailed_summary: 'Existing summary',
          purpose: 'Do work',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    });
    const embeddingsOutput = makeEmbeddingsOutput();
    arrangeExistingVersion(oldParsed, newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: 'sum_deadbeef',
      summaryUploadedAt: '2026-04-02T00:00:00.000Z',
      currentEmbeddings: 'emb_deadbeef',
      embeddingsUploadedAt: '2026-04-02T00:00:00.000Z',
      commitSha: 'abc123',
      updatedAt: '2026-04-02T00:00:00.000Z',
      history: [],
    });
    resultStorage.downloadSummary.mockResolvedValue(summaryOutput);
    resultStorage.downloadEmbeddings.mockResolvedValue(embeddingsOutput);
    diffEngine.computeChangeset.mockResolvedValue({
      repoId: 'repo_abc',
      nodesToAdd: [],
      nodesToUpdate: [{ id: 'fn_1' }],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['fn_1'],
      edgesToInsert: [],
      totalNodeCount: 2,
      totalEdgeCount: 0,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 0,
        nodesUpdated: 1,
        nodesDeleted: 0,
        edgesWiped: 1,
        edgesInserted: 0,
      },
    });

    await service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1');

    expect(resultStorage.downloadSummary).toHaveBeenCalledWith('ws_1', 'my-service', 'sum_deadbeef');
    expect(resultStorage.downloadEmbeddings).toHaveBeenCalledWith('ws_1', 'my-service', 'emb_deadbeef');
    expect(diffEngine.computeChangeset).toHaveBeenCalledWith(
      oldParsed,
      newParsed,
      summaryOutput,
      embeddingsOutput,
      'coredoc push my-service --remote --workspace-id ws_1 --rebuild',
    );
    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
    expect(repository.applyChangeset.mock.calls[0]![1]).toMatchObject({
      snapshot: { summaryVersion: 'sum_deadbeef', embeddingsVersion: 'emb_deadbeef' },
    });
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ repoKey: 'repo_abc', repoName: 'my-service' }),
      {
        lastParseHash: 'new-version',
        lastPushedByUserId: 'user_1',
        nodeCount: 2,
        edgeCount: 0,
        lastParsedVersion: 'new-version',
        lastSummaryVersion: 'sum_deadbeef',
        lastEmbedVersion: 'emb_deadbeef',
      },
    );
  });

  it('preserves manifest-current metadata during an explicit rebuild when artifact versions are omitted', async () => {
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z', functions: [makeFunction()] });
    const summaryOutput = makeSummaryOutput();
    const embeddingsOutput = makeEmbeddingsOutput();
    arrangeExistingVersion(undefined, newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: 'sum_deadbeef',
      summaryUploadedAt: '2026-04-02T00:00:00.000Z',
      currentEmbeddings: 'emb_deadbeef',
      embeddingsUploadedAt: '2026-04-02T00:00:00.000Z',
      commitSha: 'abc123',
      updatedAt: '2026-04-02T00:00:00.000Z',
      history: [],
    });
    resultStorage.downloadSummary.mockResolvedValue(summaryOutput);
    resultStorage.downloadEmbeddings.mockResolvedValue(embeddingsOutput);
    mockTransform.mockClear();

    await service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1', undefined, undefined, false, true);

    expect(resultStorage.downloadSummary).toHaveBeenCalledWith('ws_1', 'my-service', 'sum_deadbeef');
    expect(resultStorage.downloadEmbeddings).toHaveBeenCalledWith('ws_1', 'my-service', 'emb_deadbeef');
    expect(mockTransform).toHaveBeenCalledWith(newParsed, summaryOutput, embeddingsOutput);
    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo_abc', repoIdsToDelete: ['repo_abc'] }),
      expect.objectContaining({
        snapshot: expect.objectContaining({ summaryVersion: 'sum_deadbeef', embeddingsVersion: 'emb_deadbeef' }),
      }),
    );
  });

  it('explicit metadata exclusions let a rebuild proceed without manifest-current artifacts', async () => {
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z', functions: [makeFunction()] });
    arrangeExistingVersion(undefined, newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: 'sum_missing',
      summaryUploadedAt: '2026-04-02T00:00:00.000Z',
      currentEmbeddings: 'emb_missing',
      embeddingsUploadedAt: '2026-04-02T00:00:00.000Z',
      commitSha: 'abc123',
      updatedAt: '2026-04-02T00:00:00.000Z',
      history: [],
    });
    mockTransform.mockClear();

    await service.pushByVersion(
      'ws_1',
      'my-service',
      'new-version',
      null,
      'user_1',
      undefined,
      undefined,
      false,
      true,
      {
        excludeSummaries: true,
        excludeEmbeddings: true,
      },
    );

    expect(resultStorage.downloadSummary).not.toHaveBeenCalled();
    expect(resultStorage.downloadEmbeddings).not.toHaveBeenCalled();
    expect(mockTransform).toHaveBeenCalledWith(newParsed, null, null);
    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo_abc', repoIdsToDelete: ['repo_abc'] }),
      expect.objectContaining({ snapshot: expect.objectContaining({ summaryVersion: null, embeddingsVersion: null }) }),
    );
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ repoKey: 'repo_abc', repoName: 'my-service' }),
      expect.objectContaining({
        lastParsedVersion: 'new-version',
        lastSummaryVersion: null,
        lastEmbedVersion: null,
      }),
    );
  });

  it('explicit metadata exclusions suppress manifest fallback during an incremental push', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });
    arrangeExistingVersion(oldParsed, newParsed);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: 'sum_missing',
      summaryUploadedAt: '2026-04-02T00:00:00.000Z',
      currentEmbeddings: 'emb_missing',
      embeddingsUploadedAt: '2026-04-02T00:00:00.000Z',
      commitSha: 'abc123',
      updatedAt: '2026-04-02T00:00:00.000Z',
      history: [],
    });
    diffEngine.computeChangeset.mockResolvedValue({
      repoId: 'repo_abc',
      nodesToAdd: [{ id: 'fn-new' }],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      totalNodeCount: 1,
      totalEdgeCount: 0,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 1,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 0,
        edgesInserted: 0,
      },
    });

    await service.pushByVersion(
      'ws_1',
      'my-service',
      'new-version',
      null,
      'user_1',
      undefined,
      undefined,
      false,
      false,
      { excludeSummaries: true, excludeEmbeddings: true },
    );

    expect(resultStorage.downloadSummary).not.toHaveBeenCalled();
    expect(resultStorage.downloadEmbeddings).not.toHaveBeenCalled();
    expect(diffEngine.computeChangeset).toHaveBeenCalledWith(
      oldParsed,
      newParsed,
      null,
      null,
      'coredoc push my-service --remote --workspace-id ws_1 --rebuild',
    );
  });

  it('rejects a backend without atomic changeset support instead of falling back to full push', async () => {
    arrangeExistingVersion();
    diffEngine.computeChangeset.mockResolvedValue({
      repoId: 'repo_abc',
      nodesToAdd: [{ id: 'fn-new' }],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      totalNodeCount: 1,
      totalEdgeCount: 0,
      stats: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesUnchanged: 0,
        nodesAdded: 1,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 0,
        edgesInserted: 0,
      },
    });
    (repository as { applyChangeset?: unknown }).applyChangeset = undefined;

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      /cannot apply atomic incremental changes/,
    );

    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['summary', 'sum_deadbeef', 'downloadSummary'],
    ['embeddings', 'emb_deadbeef', 'downloadEmbeddings'],
  ] as const)('rejects a supplied missing %s artifact before writing the graph', async (_kind, version, method) => {
    const parsedRepo = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: null,
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: null,
      updatedAt: null,
      history: [],
    });
    resultStorage[method].mockResolvedValue(null);

    const summaryVersion = method === 'downloadSummary' ? version : undefined;
    const embeddingsVersion = method === 'downloadEmbeddings' ? version : undefined;
    await expect(
      service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1', summaryVersion, embeddingsVersion),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it.each([
    'summary',
    'embeddings',
  ] as const)('rejects %s metadata owned by another repo before any graph write', async (kind) => {
    const parsedRepo = makeParsedRepo();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.getManifest.mockResolvedValue({ currentParsed: 'same-version' });

    const summaryVersion = kind === 'summary' ? 'sum_wrong' : undefined;
    const embeddingsVersion = kind === 'embeddings' ? 'emb_wrong' : undefined;
    if (kind === 'summary') {
      resultStorage.downloadSummary.mockResolvedValue(
        makeSummaryOutput({ repoId: 'other-repo', repoName: 'other-service' }),
      );
    } else {
      resultStorage.downloadEmbeddings.mockResolvedValue(
        makeEmbeddingsOutput({ repoId: 'other-repo', repoName: 'other-service' }),
      );
    }

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'same-version', null, 'user_1', summaryVersion, embeddingsVersion),
    ).rejects.toThrow(/artifact belongs to repo "other-service" \(other-repo\)/);

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['summary', 'currentSummary', 'sum_deadbeef', 'downloadSummary'],
    ['embeddings', 'currentEmbeddings', 'emb_deadbeef', 'downloadEmbeddings'],
  ] as const)('rejects a missing manifest-current %s artifact before changing the graph', async (_kind, manifestField, version, method) => {
    arrangeExistingVersion();
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'old-version',
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
      [manifestField]: version,
    });
    resultStorage[method].mockResolvedValue(null);

    await expect(service.pushByVersion('ws_1', 'my-service', 'new-version', null, 'user_1')).rejects.toThrow(
      /referenced by the manifest/,
    );

    expect(repository.applyChangeset).not.toHaveBeenCalled();
    expect(repository.deleteRepository).not.toHaveBeenCalled();
    expect(resultStorage.updateManifest).not.toHaveBeenCalled();
  });

  it('skips stale same-version metadata entries instead of failing or writing them', async () => {
    const parsedRepo = makeParsedRepo();
    const staleSummary = makeSummaryOutput({
      summaries: [
        {
          functionId: 'deleted-fn',
          versionedId: 'deleted-fn:v1',
          detailed_summary: 'Stale summary',
          purpose: 'Old purpose',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    });
    const filteredSummary = { ...staleSummary, summaries: [] };
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.downloadSummary.mockResolvedValue(staleSummary);
    resultStorage.getManifest.mockResolvedValue({ currentParsed: 'same-version' });
    mockNormalizeMetadata.mockReturnValueOnce({
      summaryOutput: filteredSummary,
      embeddingsOutput: null,
      dropped: { summaries: 1, functionEmbeddings: 0, endpointEmbeddings: 0, total: 1 },
    });

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'same-version', null, 'user_1', 'sum_1234567890abcdef'),
    ).resolves.toMatchObject({ mode: 'incremental', nodesUpdated: 0 });

    expect(mockTransform).toHaveBeenCalledWith(parsedRepo, filteredSummary, null);
    expect(repository.applyChangeset.mock.calls[0]![0]).toMatchObject({ nodeMetadataUpdates: [] });
    expect(resultStorage.updateManifest).toHaveBeenCalled();
  });

  it('merges summaries on same-version reruns without reapplying the changeset', async () => {
    const parsedRepo = makeParsedRepo({ functions: [makeFunction()] });
    const summaryOutput = makeSummaryOutput({
      repositorySummary: {
        overview: 'Repository overview',
        dataModel: 'Repository data model',
        externalIntegrations: ['redis'],
        generatedAt: '2026-04-02T00:00:00.000Z',
      },
      summaries: [
        {
          functionId: 'fn_1',
          versionedId: 'fn_1:v1',
          detailed_summary: 'Summarized function',
          purpose: 'Do work',
          business_logic: [],
          side_effects: [],
          data_handling: '',
          confidence_level: 'high',
          unknowns: [],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    });

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.downloadSummary.mockResolvedValue(summaryOutput);
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'same-version',
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: 'abc123',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    mockTransform.mockReturnValue({
      nodes: [
        { id: 'repo_abc', summary: 'Repository overview', properties: {} },
        { id: 'fn_1', summary: 'Summarized function', properties: { purpose: 'Do work' } },
      ],
      edges: [{ id: 'e1' }],
    });
    repository.applyChangeset.mockResolvedValue({
      nodesAdded: 0,
      nodesUpdated: 2,
      nodesDeleted: 0,
      edgesDeleted: 0,
      edgesInserted: 0,
    });

    const result = await service.pushByVersion(
      'ws_1',
      'my-service',
      'same-version',
      'def456',
      'user_1',
      'sum_1234567890abcdef',
    );

    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeMetadataUpdates: expect.arrayContaining([expect.objectContaining({ id: 'fn_1' })]),
      }),
      expect.objectContaining({ snapshot: expect.objectContaining({ mode: 'metadata' }) }),
    );
    expect(result).toMatchObject({
      repoName: 'my-service',
      mode: 'incremental',
      nodesUpdated: 2,
      version: 'same-version',
    });
  });

  it('merges embeddings on same-version reruns without replacing existing summaries', async () => {
    const parsedRepo = makeParsedRepo({ functions: [makeFunction()] });
    const embeddingsOutput = {
      repoId: parsedRepo.id,
      repoName: parsedRepo.name,
      generatedAt: '2026-04-02T00:00:00.000Z',
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 2,
      inputStrategy: 'summary',
      functions: [
        {
          functionId: 'fn_1',
          versionedId: 'fn_1:v1',
          name: 'work',
          filePath: 'src/work.ts',
          inputChecksum: 'checksum-1',
          embedding: [0.1, 0.2],
          generatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
      endpoints: [],
      stats: {},
    } as EmbeddingsOutput;

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockResolvedValue(parsedRepo);
    resultStorage.downloadEmbeddings.mockResolvedValue(embeddingsOutput);
    resultStorage.getManifest.mockResolvedValue({ currentParsed: 'same-version' });
    mockTransform.mockReturnValue({
      nodes: [{ id: 'fn_1', embedding: [0.1, 0.2], properties: { embeddingProvider: 'ollama' } }],
      edges: [{ id: 'e1' }],
    });
    repository.applyChangeset.mockResolvedValue({
      nodesAdded: 0,
      nodesUpdated: 1,
      nodesDeleted: 0,
      edgesDeleted: 0,
      edgesInserted: 0,
    });

    const result = await service.pushByVersion(
      'ws_1',
      'my-service',
      'same-version',
      null,
      'user_1',
      undefined,
      'emb_1234567890abcdef',
    );

    expect(repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeMetadataUpdates: [expect.objectContaining({ id: 'fn_1', embedding: [0.1, 0.2] })],
      }),
      expect.objectContaining({ snapshot: expect.objectContaining({ mode: 'metadata' }) }),
    );
    expect(result.nodesUpdated).toBe(1);
  });

  it('returns totalNodeCount and totalEdgeCount from incremental push', async () => {
    const oldParsed = makeParsedRepo({ parsedAt: '2026-04-01T00:00:00.000Z' });
    const newParsed = makeParsedRepo({ parsedAt: '2026-04-02T00:00:00.000Z' });

    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage.downloadResult.mockImplementation(
      async (_workspaceId: string, _repoName: string, version: string) => {
        if (version === 'v2') return newParsed;
        if (version === 'v1') return oldParsed;
        return null;
      },
    );
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'v1',
      currentSummary: null,
      summaryUploadedAt: null,
      commitSha: 'abc',
      updatedAt: '2026-04-01T00:00:00.000Z',
      history: [],
    });
    diffEngine.computeChangeset.mockResolvedValue({
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      totalNodeCount: 10,
      totalEdgeCount: 5,
      stats: {
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
        filesUnchanged: 1,
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesWiped: 0,
        edgesInserted: 0,
      },
    });

    const result = await service.pushByVersion('ws_1', 'my-service', 'v2', 'sha1', 'user_1');

    expect(result.totalNodeCount).toBe(10);
    expect(result.totalEdgeCount).toBe(5);
    expect(controlPlane.updateRepoPushMetadata).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ repoKey: 'repo_abc', repoName: 'my-service' }),
      {
        lastParseHash: 'v2',
        lastPushedByUserId: 'user_1',
        nodeCount: 10,
        edgeCount: 5,
        lastParsedVersion: 'v2',
        lastSummaryVersion: null,
        lastEmbedVersion: null,
      },
    );
  });

  it('uploadSummary blocks concurrent uploads to same repo', async () => {
    // Make the first upload hang until we release it
    let resolveFirst: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });
    resultStorage.uploadSummary.mockImplementation(async () => {
      await firstBlocked;
      return { version: 'sum_abc', sizeBytes: 10, uploadedAt: '2026-04-02T00:00:00.000Z', duplicate: false };
    });

    const summary = makeSummaryOutput();
    const first = service.uploadSummary('ws_1', 'my-service', summary);

    // Give the first call time to acquire the lock
    await new Promise((r) => setTimeout(r, 10));

    // Second concurrent call should throw ConflictException
    await expect(service.uploadSummary('ws_1', 'my-service', summary)).rejects.toThrow(ConflictException);

    // Release the first call and verify it succeeds
    resolveFirst!();
    const result = await first;
    expect(result.version).toBe('sum_abc');
  });

  it('uploadSummary allows sequential uploads to same repo', async () => {
    resultStorage.uploadSummary.mockResolvedValue({
      version: 'sum_abc',
      sizeBytes: 10,
      uploadedAt: '2026-04-02T00:00:00.000Z',
      duplicate: false,
    });

    const summary = makeSummaryOutput();
    await service.uploadSummary('ws_1', 'my-service', summary);
    // Second call after the first completes should succeed
    const result = await service.uploadSummary('ws_1', 'my-service', summary);
    expect(result.version).toBe('sum_abc');
  });

  it('uploadSummary releases lock even on error', async () => {
    resultStorage.uploadSummary.mockRejectedValueOnce(new Error('R2 down'));
    resultStorage.uploadSummary.mockResolvedValueOnce({
      version: 'sum_abc',
      sizeBytes: 10,
      uploadedAt: '2026-04-02T00:00:00.000Z',
      duplicate: false,
    });

    const summary = makeSummaryOutput();
    await expect(service.uploadSummary('ws_1', 'my-service', summary)).rejects.toThrow('R2 down');
    // Lock should be released — next call should succeed
    const result = await service.uploadSummary('ws_1', 'my-service', summary);
    expect(result.version).toBe('sum_abc');
  });

  it('pushByVersion rejects R2 payload that contains sourceCode', async () => {
    const { containsSourceCode } = await import('@coredoc/db');
    (containsSourceCode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const controlPlane = createMockControlPlane();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'w1', slug: 'ws', graphBackend: 'turso' });
    controlPlane.listRepos.mockResolvedValue([{ repoKey: 'repo', repoName: 'repo' }]);
    const workspaceDbPool = createMockWorkspaceDbPool();
    workspaceDbPool.acquire.mockResolvedValue({
      applyChangeset: vi.fn(),
      deleteRepository: vi.fn(),
      pushNodes: vi.fn(),
      pushEdges: vi.fn(),
    });
    const resultStorage = createMockResultStorage();
    resultStorage.downloadResult.mockResolvedValue({
      id: 'repo',
      name: 'repo',
      functions: [{ id: 'f', sourceCode: 'leaked' }],
    });
    resultStorage.getManifest.mockResolvedValue({ currentParsed: null });

    const service = new PushService(
      controlPlane as unknown as ControlPlaneService,
      workspaceDbPool as unknown as WorkspaceDbPoolService,
      resultStorage as unknown as ResultStorageService,
      createMockDiffEngine() as unknown as DiffEngine,
      { recordPushMetrics: vi.fn() } as unknown as MetricsService,
      { trackEvent: vi.fn() } as unknown as TelemetryService,
      createMockResolverService() as unknown as ResolverService,
      createLeaseFake() as unknown as PushLeaseService,
      createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
    );

    await expect(service.pushByVersion('w1', 'repo', 'v1', null, 'user1')).rejects.toThrow('sourceCode');
  });

  it('uploadEmbeddings rejects payload that still carries inputText', async () => {
    const { embeddingsContainInputText } = await import('@coredoc/db');
    (embeddingsContainInputText as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const controlPlane = createMockControlPlane();
    const workspaceDbPool = createMockWorkspaceDbPool();
    const resultStorage = createMockResultStorage();

    const service = new PushService(
      controlPlane as unknown as ControlPlaneService,
      workspaceDbPool as unknown as WorkspaceDbPoolService,
      resultStorage as unknown as ResultStorageService,
      createMockDiffEngine() as unknown as DiffEngine,
      { recordPushMetrics: vi.fn() } as unknown as MetricsService,
      { trackEvent: vi.fn() } as unknown as TelemetryService,
      createMockResolverService() as unknown as ResolverService,
      createLeaseFake() as unknown as PushLeaseService,
      createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
    );

    const embeddings = {
      repoId: 'repo',
      functions: [{ functionId: 'f', inputText: 'function f() { return SECRET; }', embedding: [0.1] }],
      endpoints: [],
    } as unknown as EmbeddingsOutput;

    await expect(service.uploadEmbeddings('w1', 'repo', embeddings)).rejects.toThrow('inputText');
    expect(resultStorage.uploadEmbeddings).not.toHaveBeenCalled();
  });

  it('uploadResult rejects payload containing sourceCode', async () => {
    const { containsSourceCode } = await import('@coredoc/db');
    (containsSourceCode as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const controlPlane = createMockControlPlane();
    const workspaceDbPool = createMockWorkspaceDbPool();
    const resultStorage = createMockResultStorage();

    const service = new PushService(
      controlPlane as unknown as ControlPlaneService,
      workspaceDbPool as unknown as WorkspaceDbPoolService,
      resultStorage as unknown as ResultStorageService,
      createMockDiffEngine() as unknown as DiffEngine,
      { recordPushMetrics: vi.fn() } as unknown as MetricsService,
      { trackEvent: vi.fn() } as unknown as TelemetryService,
      createMockResolverService() as unknown as ResolverService,
      createLeaseFake() as unknown as PushLeaseService,
      createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
    );

    const parsedRepo = { id: 'repo', functions: [{ id: 'f', sourceCode: 'leak' }] } as unknown as ParsedRepo;

    await expect(service.uploadResult('w1', 'repo', parsedRepo)).rejects.toThrow('sourceCode');
    expect(resultStorage.uploadResult).not.toHaveBeenCalled();
  });

  describe('metadata merge on incremental pushes', () => {
    const SUMMARY_VERSION = 'sum_1234567890abcdef';

    /**
     * Stage an incremental push (old-version -> new-version) whose stored snapshot
     * records `snapshotSummaryVersion`, with one summarized function that the merge
     * would otherwise rewrite.
     */
    function arrangeIncrementalWithSnapshot(opts: {
      snapshotSummaryVersion: string | null;
      snapshotParsedVersion?: string;
      snapshotAppliedAt?: string;
    }): void {
      const withFn = () => makeParsedRepo({ functions: [makeFunction()] });
      arrangeExistingVersion(withFn(), withFn());
      resultStorage.downloadSummary.mockResolvedValue(
        makeSummaryOutput({
          summaries: [
            {
              functionId: 'fn_1',
              versionedId: 'fn_1:v1',
              detailed_summary: 'Summarized function',
              purpose: 'Do work',
              business_logic: [],
              side_effects: [],
              data_handling: '',
              confidence_level: 'high',
              unknowns: [],
              generatedAt: '2026-04-02T00:00:00.000Z',
            },
          ],
        }),
      );
      repository.getAppliedGraphSnapshot.mockResolvedValue({
        parsedVersion: opts.snapshotParsedVersion ?? 'old-version',
        summaryVersion: opts.snapshotSummaryVersion,
        embeddingsVersion: null,
        commitSha: 'abc123',
        totalNodeCount: 2,
        totalEdgeCount: 1,
        nodeCount: 2,
        edgeCount: 1,
        mode: 'incremental',
        executionToken: '22222222-2222-4222-8222-222222222222',
        appliedAt: opts.snapshotAppliedAt ?? '2026-04-01T00:00:00.000Z',
        receipt: { nodesAdded: 1, nodesUpdated: 1, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 },
      });
      mockTransform.mockReturnValue({
        nodes: [{ id: 'fn_1', summary: 'Summarized function', properties: { purpose: 'Do work' } }],
        edges: [{ id: 'e1' }],
      });
      // fn_1 is deliberately absent from the structural sets, so it is exactly the
      // "untouched but summarized" node the merge would otherwise rewrite.
      diffEngine.computeChangeset.mockResolvedValue({
        nodesToAdd: [],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: ['fn_1'],
        edgesToInsert: [{ id: 'edge_1', sourceId: 'fn_1', targetId: 'fn_2', type: 'CALLS' }],
        totalNodeCount: 2,
        totalEdgeCount: 1,
        stats: {
          filesAdded: 0,
          filesModified: 1,
          filesDeleted: 0,
          filesUnchanged: 0,
          nodesAdded: 0,
          nodesUpdated: 0,
          nodesDeleted: 0,
        },
      });
      repository.applyChangeset.mockResolvedValue({
        nodesAdded: 0,
        nodesUpdated: 1,
        nodesDeleted: 0,
        edgesDeleted: 0,
        edgesInserted: 1,
      });
    }

    it('skips the merge when the snapshot already records these artifact versions', async () => {
      arrangeIncrementalWithSnapshot({ snapshotSummaryVersion: SUMMARY_VERSION });

      await service.pushByVersion('ws_1', 'my-service', 'new-version', 'abc123', 'user_1', SUMMARY_VERSION);

      // Untouched nodes already carry this summary — rewriting them to their current
      // values is the churn this guard exists to remove.
      expect(repository.applyChangeset.mock.calls[0]![0]).toMatchObject({ nodeMetadataUpdates: [] });
    });

    it('still merges when the snapshot records a different summary version', async () => {
      arrangeIncrementalWithSnapshot({ snapshotSummaryVersion: 'sum_0000000000000000' });

      await service.pushByVersion('ws_1', 'my-service', 'new-version', 'abc123', 'user_1', SUMMARY_VERSION);

      expect(repository.applyChangeset.mock.calls[0]![0]).toMatchObject({
        nodeMetadataUpdates: expect.arrayContaining([expect.objectContaining({ id: 'fn_1' })]),
      });
    });

    it('still merges during a rollback window, where the snapshot is not a trusted baseline', async () => {
      // Snapshot is behind the manifest and older than it — the caller nulls the
      // baseline here, so the guard must fall back to the full merge rather than
      // trusting a snapshot that may not describe the current graph.
      arrangeIncrementalWithSnapshot({
        snapshotSummaryVersion: SUMMARY_VERSION,
        snapshotParsedVersion: 'stale-version',
        snapshotAppliedAt: '2026-03-01T00:00:00.000Z',
      });

      await service.pushByVersion('ws_1', 'my-service', 'new-version', 'abc123', 'user_1', SUMMARY_VERSION);

      expect(repository.applyChangeset.mock.calls[0]![0]).toMatchObject({
        nodeMetadataUpdates: expect.arrayContaining([expect.objectContaining({ id: 'fn_1' })]),
      });
    });
  });

  describe('metrics recording', () => {
    it('should record push metrics after successful pushByVersion', async () => {
      const controlPlane = createMockControlPlane();
      const dbPool = createMockWorkspaceDbPool();
      const storage = createMockResultStorage();
      const diffEngine = createMockDiffEngine();
      const metrics = createMockMetricsService();
      const telemetry = createMockTelemetryService();
      const repo = createMockRepository();

      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'test-ws', graphBackend: 'turso' });
      dbPool.acquire.mockResolvedValue(repo);
      storage.downloadResult.mockResolvedValue(makeParsedRepo());
      storage.getManifest.mockResolvedValue({ currentParsed: null });

      const service = new PushService(
        controlPlane as unknown as ControlPlaneService,
        dbPool as unknown as WorkspaceDbPoolService,
        storage as unknown as ResultStorageService,
        diffEngine as unknown as DiffEngine,
        metrics as unknown as MetricsService,
        telemetry as unknown as TelemetryService,
        createMockResolverService() as unknown as ResolverService,
        createLeaseFake() as unknown as PushLeaseService,
        createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
      );

      await service.pushByVersion('ws-1', 'my-service', 'v1', 'abc123', 'user-1');

      expect(metrics.recordPushMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          repoName: 'my-service',
          pushMode: 'full',
          totalNodes: 2,
          totalEdges: 1,
        }),
      );
    });

    it('should not fail the push if metrics recording fails', async () => {
      const controlPlane = createMockControlPlane();
      const dbPool = createMockWorkspaceDbPool();
      const storage = createMockResultStorage();
      const diffEngine = createMockDiffEngine();
      const metrics = createMockMetricsService();
      const telemetry = createMockTelemetryService();
      const repo = createMockRepository();

      controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws-1', slug: 'test-ws', graphBackend: 'turso' });
      dbPool.acquire.mockResolvedValue(repo);
      storage.downloadResult.mockResolvedValue(makeParsedRepo());
      storage.getManifest.mockResolvedValue({ currentParsed: null });
      metrics.recordPushMetrics.mockRejectedValue(new Error('Metrics DB down'));

      const service = new PushService(
        controlPlane as unknown as ControlPlaneService,
        dbPool as unknown as WorkspaceDbPoolService,
        storage as unknown as ResultStorageService,
        diffEngine as unknown as DiffEngine,
        metrics as unknown as MetricsService,
        telemetry as unknown as TelemetryService,
        createMockResolverService() as unknown as ResolverService,
        createLeaseFake() as unknown as PushLeaseService,
        createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
      );

      await expect(service.pushByVersion('ws-1', 'my-service', 'v1', 'abc123', 'user-1')).resolves.toBeDefined();
    });
  });
});

// =============================================================================
// Distributed leasing (PushLeaseService wired in)
// =============================================================================

import { PushLeaseService } from '../lease/push-lease.service.js';

function createLeaseFake() {
  let graphHolder: string | null = null;
  const waiters: Array<() => void> = [];
  const events: string[] = [];
  return {
    events,
    acquireRepository: vi.fn(async (_ws: string, repoName: string, ownerToken: string) => {
      events.push(`repo-acquire:${repoName}`);
      return { ownerToken, generation: 1n };
    }),
    renewRepository: vi.fn(async () => true),
    releaseRepository: vi.fn(async (_ws: string, repoName: string) => {
      events.push(`repo-release:${repoName}`);
    }),
    acquireGraphWrite: vi.fn(async (_ws: string, ownerToken: string) => {
      while (graphHolder) await new Promise<void>((resolve) => waiters.push(resolve));
      graphHolder = ownerToken;
      events.push(`graph-acquire:${ownerToken}`);
      return { ownerToken, generation: 1n };
    }),
    renewGraphWrite: vi.fn(async () => true),
    releaseGraphWrite: vi.fn(async (_ws: string, lease: { ownerToken: string }) => {
      graphHolder = null;
      events.push(`graph-release:${lease.ownerToken}`);
      waiters.shift()?.();
    }),
    // Inert by default; individual tests override to drive the abort seam.
    startRenewal: vi.fn(() => setInterval(() => undefined, 2 ** 30)),
  };
}

describe('PushService distributed leasing', () => {
  let controlPlane: ReturnType<typeof createMockControlPlane>;
  let workspaceDbPool: ReturnType<typeof createMockWorkspaceDbPool>;
  let resultStorage: ReturnType<typeof createMockResultStorage>;
  let repository: ReturnType<typeof createMockRepository>;
  let leases: ReturnType<typeof createLeaseFake>;
  let service: PushService;

  function buildService(): void {
    service = new PushService(
      controlPlane as unknown as ControlPlaneService,
      workspaceDbPool as unknown as WorkspaceDbPoolService,
      resultStorage as unknown as ResultStorageService,
      createMockDiffEngine() as unknown as DiffEngine,
      createMockMetricsService() as unknown as MetricsService,
      createMockTelemetryService() as unknown as TelemetryService,
      createMockResolverService() as unknown as ResolverService,
      leases as unknown as PushLeaseService,
      createMockGraphSnapshotControlPlane() as unknown as GraphSnapshotControlPlaneService,
    );
  }

  beforeEach(() => {
    mockTransform.mockReset();
    mockTransform.mockReturnValue({ nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1' }] });
    controlPlane = createMockControlPlane();
    controlPlane.getWorkspaceById.mockResolvedValue({ id: 'ws_1', slug: 'my-workspace', graphBackend: 'turso' });
    controlPlane.listRepos.mockResolvedValue([
      { repoKey: 'repo_abc', repoName: 'my-service' },
      { repoKey: 'repo_b', repoName: 'service-b' },
    ]);
    workspaceDbPool = createMockWorkspaceDbPool();
    repository = createMockRepository();
    workspaceDbPool.acquire.mockResolvedValue(repository);
    resultStorage = createMockResultStorage();
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: null,
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: null,
      updatedAt: null,
      history: [],
    });
    resultStorage.downloadResult.mockImplementation(async (_ws: string, repoName: string) =>
      repoName === 'service-b'
        ? makeParsedRepo({ id: 'repo_b', name: 'service-b' })
        : makeParsedRepo({ id: 'repo_abc', name: 'my-service' }),
    );
    leases = createLeaseFake();
    buildService();
  });

  it('deterministically serializes concurrent same-workspace graph writes; both pushes succeed', async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let applyCalls = 0;
    repository.applyChangeset.mockImplementation(async () => {
      applyCalls += 1;
      if (applyCalls === 1) await firstWriteGate;
      return { nodesAdded: 2, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 };
    });

    const pushA = service.pushByVersion('ws_1', 'my-service', 'v-a', null, 'user_1', undefined, undefined, true, true);
    // Let push A reach and hold the graph-write phase before B starts.
    await vi.waitFor(() => expect(applyCalls).toBe(1));
    const pushB = service.pushByVersion('ws_1', 'service-b', 'v-b', null, 'user_1', undefined, undefined, true, true);
    // B pipelines its read phases but must NOT enter the graph write while A holds the lease.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(applyCalls).toBe(1);

    releaseFirstWrite();
    await expect(Promise.all([pushA, pushB])).resolves.toBeDefined();
    expect(applyCalls).toBe(2);

    const graphEvents = leases.events.filter((event) => event.startsWith('graph-'));
    expect(graphEvents).toHaveLength(4);
    expect(graphEvents[0]!.startsWith('graph-acquire:')).toBe(true);
    expect(graphEvents[1]!.replace('graph-release:', '')).toBe(graphEvents[0]!.replace('graph-acquire:', ''));
    expect(graphEvents[2]!.startsWith('graph-acquire:')).toBe(true);
    expect(graphEvents[3]!.replace('graph-release:', '')).toBe(graphEvents[2]!.replace('graph-acquire:', ''));
  });

  it('aborts the graph write at the batch boundary when lease renewal reports loss, still releasing both leases', async () => {
    const leaseLost = new Error('Distributed push lease was lost');
    // First startRenewal call guards the repo lease (stays healthy); the
    // second guards the graph-write lease — that one reports loss, so the
    // abort must land INSIDE the graph-write phase.
    let renewalCalls = 0;
    leases.startRenewal.mockImplementation(
      (_renew: () => Promise<boolean>, abort: (reason: Error) => void): ReturnType<typeof setInterval> => {
        renewalCalls += 1;
        if (renewalCalls === 2) abort(leaseLost);
        return setInterval(() => undefined, 2 ** 30);
      },
    );
    repository.applyChangeset.mockImplementation(async (_changeset: unknown, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.throwIfAborted();
      return { nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 0 };
    });

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'v-a', null, 'user_1', undefined, undefined, true, true),
    ).rejects.toThrow('Distributed push lease was lost');
    expect(leases.releaseGraphWrite).toHaveBeenCalledTimes(1);
    expect(leases.releaseRepository).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume when the committed snapshot belongs to a different execution', async () => {
    repository.applyChangeset.mockRejectedValue(new Error('fetch failed'));
    repository.getAppliedGraphSnapshot
      .mockResolvedValueOnce(null) // pre-write read in pushByVersion
      .mockResolvedValue({
        parsedVersion: 'v-a',
        summaryVersion: null,
        embeddingsVersion: null,
        commitSha: null,
        nodeCount: 2,
        edgeCount: 1,
        mode: 'full',
        executionToken: 'foreign-execution',
        receipt: { nodesAdded: 2, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 },
        appliedAt: '2026-08-04T00:00:00.000Z',
      });

    const error = await service
      .pushByVersion('ws_1', 'my-service', 'v-a', null, 'user_1', undefined, undefined, true, true)
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/committed by a different execution/);
    expect((error as Error).message).not.toContain('foreign-execution');
    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
  });

  it('refuses to retry when the snapshot changed under reconciliation', async () => {
    repository.applyChangeset.mockRejectedValue(new Error('fetch failed'));
    repository.getAppliedGraphSnapshot.mockResolvedValueOnce(null).mockResolvedValue({
      parsedVersion: 'someone-elses-version',
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: null,
      nodeCount: 9,
      edgeCount: 9,
      mode: 'full',
      executionToken: 'other',
      receipt: { nodesAdded: 9, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 9 },
      appliedAt: '2026-08-04T00:00:00.000Z',
    });

    await expect(
      service.pushByVersion('ws_1', 'my-service', 'v-a', null, 'user_1', undefined, undefined, true, true),
    ).rejects.toThrow(/refusing to overwrite newer state/);
    expect(repository.applyChangeset).toHaveBeenCalledTimes(1);
  });

  it('uses a newer manifest baseline after rollback even when snapshot history was pruned', async () => {
    repository.getAppliedGraphSnapshot.mockResolvedValue({
      parsedVersion: 'snapshot-old',
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: null,
      nodeCount: 2,
      edgeCount: 1,
      mode: 'full',
      executionToken: 'snapshot-execution',
      receipt: { nodesAdded: 2, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 1 },
      appliedAt: '2026-08-01T00:00:00.000Z',
    });
    resultStorage.getManifest.mockResolvedValue({
      currentParsed: 'manifest-new',
      currentSummary: null,
      summaryUploadedAt: null,
      currentEmbeddings: null,
      embeddingsUploadedAt: null,
      commitSha: null,
      updatedAt: '2026-08-03T00:00:00.000Z',
      // A rollback window with more than five pushes has pruned snapshot-old.
      history: [
        { parsed: 'v5', commitSha: null, updatedAt: '2026-08-02T05:00:00.000Z' },
        { parsed: 'v4', commitSha: null, updatedAt: '2026-08-02T04:00:00.000Z' },
        { parsed: 'v3', commitSha: null, updatedAt: '2026-08-02T03:00:00.000Z' },
        { parsed: 'v2', commitSha: null, updatedAt: '2026-08-02T02:00:00.000Z' },
        { parsed: 'v1', commitSha: null, updatedAt: '2026-08-02T01:00:00.000Z' },
      ],
    });

    await service.pushByVersion(
      'ws_1',
      'my-service',
      'manifest-new',
      null,
      'user_1',
      undefined,
      undefined,
      true,
      false,
    );

    expect(resultStorage.downloadResult).toHaveBeenCalledWith('ws_1', 'my-service', 'manifest-new');
    expect(resultStorage.downloadResult).not.toHaveBeenCalledWith('ws_1', 'my-service', 'snapshot-old');
  });
});
