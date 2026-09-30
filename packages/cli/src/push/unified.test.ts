import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingsOutput, SummaryOutput } from '@coredoc/core';
import type { RuntimeConfig } from '@coredoc/core/types';

const mocks = vi.hoisted(() => {
  const repository = {
    deleteRepository: vi.fn(async () => undefined),
    listAllRepositories: vi.fn(async () => [] as Array<{ hash: string; name: string }>),
    pushNodes: vi.fn(async () => 2),
    pushEdges: vi.fn(async () => 1),
    applyChangeset: vi.fn(async () => ({
      nodesAdded: 2,
      nodesUpdated: 0,
      nodesDeleted: 0,
      edgesDeleted: 0,
      edgesInserted: 1,
    })),
  };

  return {
    repository,
    bindProjectDatabase: vi.fn(async () => undefined),
    closeDriver: vi.fn(async () => undefined),
    createNeo4jVectorIndexes: vi.fn(async () => undefined),
    ensureNeo4jGraphIndexes: vi.fn(async () => undefined),
    findEmbeddingsFile: vi.fn(() => null),
    findParsedRepo: vi.fn(() => '/workspace/coredoc-output/alpha/svc-a.json'),
    findSummariesFile: vi.fn(() => null),
    getConfiguredBackend: vi.fn(() => 'sqlite' as const),
    getDriver: vi.fn(async () => ({})),
    getRepository: vi.fn(async () => repository),
    getTransformStats: vi.fn(),
    loadEmbeddings: vi.fn<(path: string) => EmbeddingsOutput | null>(() => null),
    loadSummaries: vi.fn<(path: string) => SummaryOutput | null>(() => null),
    readFileSync: vi.fn(),
    resolveProjectCrossRepo: vi.fn(async () => null),
    trackOperation: vi.fn(
      async (_projectId: string, _repoName: string, _operation: string, fn: () => Promise<unknown>) => fn(),
    ),
    normalizeMetadataForParsedRepo: vi.fn(),
    transformParsedRepo: vi.fn(),
  };
});

vi.mock('fs', () => ({ readFileSync: mocks.readFileSync }));

vi.mock('@coredoc/db', () => ({
  closeDriver: mocks.closeDriver,
  createVectorIndexes: mocks.createNeo4jVectorIndexes,
  ensureGraphIndexes: mocks.ensureNeo4jGraphIndexes,
  getConfiguredBackend: mocks.getConfiguredBackend,
  getDriver: mocks.getDriver,
  getRepository: mocks.getRepository,
  getTransformStats: mocks.getTransformStats,
  normalizeMetadataForParsedRepo: mocks.normalizeMetadataForParsedRepo,
  transformParsedRepo: mocks.transformParsedRepo,
}));

vi.mock('./helpers.js', () => ({
  findEmbeddingsFile: mocks.findEmbeddingsFile,
  findParsedRepo: mocks.findParsedRepo,
  findSummariesFile: mocks.findSummariesFile,
  loadEmbeddings: mocks.loadEmbeddings,
  loadSummaries: mocks.loadSummaries,
}));

vi.mock('./cross-repo.js', () => ({ resolveProjectCrossRepo: mocks.resolveProjectCrossRepo }));
vi.mock('../operations-tracker.js', () => ({ trackOperation: mocks.trackOperation }));
vi.mock('../db-scope.js', () => ({ bindProjectDatabase: mocks.bindProjectDatabase }));

import { buildPushMetadata, resolveMetadataInclusion, runUnifiedPush, type UnifiedPushResult } from './unified.js';

const config = {
  configDir: '/workspace',
  projects: [
    {
      id: 'alpha',
      name: 'Alpha',
      repos: [{ name: 'svc-a', path: '/workspace/svc-a' }],
    },
  ],
  resolvedOutputDir: '/workspace/coredoc-output',
} as RuntimeConfig;

const parsedRepo = {
  id: '645fcba02891',
  name: 'svc-a',
  files: [],
  functions: [],
  classes: [],
};

const transformResult = {
  nodes: [
    { id: parsedRepo.id, type: 'repository', name: parsedRepo.name, properties: {} },
    { id: `${parsedRepo.id}:function:src/a.ts:run`, type: 'function', name: 'run', properties: {} },
  ],
  edges: [
    {
      id: `${parsedRepo.id}:edge:1`,
      sourceId: `${parsedRepo.id}:function:src/a.ts:run`,
      targetId: parsedRepo.id,
      type: 'CALLS',
      properties: {},
    },
  ],
};

const stats = {
  totalNodes: 2,
  totalEdges: 1,
  nodesByType: { repository: 1, function: 1 },
  edgesByType: { CALLS: 1 },
  nodesWithSummaries: 0,
  nodesWithEmbeddings: 0,
};

const pushOptions = {
  config: '/workspace/coredoc.config.json',
  backend: 'sqlite' as const,
  includeSummaries: false,
  includeEmbeddings: false,
  crossRepo: false,
  skipClose: true,
};

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  mocks.findParsedRepo.mockReturnValue('/workspace/coredoc-output/alpha/svc-a.json');
  mocks.findSummariesFile.mockReturnValue(null);
  mocks.findEmbeddingsFile.mockReturnValue(null);
  mocks.loadSummaries.mockReturnValue(null);
  mocks.loadEmbeddings.mockReturnValue(null);
  mocks.readFileSync.mockReturnValue(JSON.stringify(parsedRepo));
  mocks.normalizeMetadataForParsedRepo.mockImplementation((_repo, summaryOutput, embeddingsOutput) => ({
    summaryOutput,
    embeddingsOutput,
    dropped: { summaries: 0, functionEmbeddings: 0, endpointEmbeddings: 0, total: 0 },
  }));
  mocks.transformParsedRepo.mockReturnValue(transformResult);
  mocks.getTransformStats.mockReturnValue(stats);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

function makeResult(overrides?: Partial<UnifiedPushResult>): UnifiedPushResult {
  return {
    success: true,
    backend: 'sqlite',
    repositoryName: 'svc-a',
    totalNodes: 120,
    totalEdges: 340,
    nodesByType: {},
    edgesByType: {},
    nodesWithSummaries: 0,
    nodesWithEmbeddings: 0,
    durationMs: 5000,
    errors: [],
    ...overrides,
  };
}

describe('buildPushMetadata', () => {
  it('records local push counts and duration', () => {
    expect(buildPushMetadata(makeResult())).toEqual({
      backend: 'sqlite',
      totalNodes: 120,
      totalEdges: 340,
      target: 'local',
      duration_ms: 5000,
    });
  });

  it('reports target=local for either local backend', () => {
    expect(buildPushMetadata(makeResult({ backend: 'neo4j' }))).toMatchObject({
      backend: 'neo4j',
      target: 'local',
    });
  });
});

describe('resolveMetadataInclusion', () => {
  it('lets Commander negative flags override the positive compatibility fields', () => {
    expect(
      resolveMetadataInclusion({
        includeSummaries: true,
        summaries: false,
        includeEmbeddings: true,
        embeddings: false,
      }),
    ).toEqual({ includeSummaries: false, includeEmbeddings: false });
  });

  it('includes both artifact kinds by default', () => {
    expect(resolveMetadataInclusion({})).toEqual({ includeSummaries: true, includeEmbeddings: true });
  });
});

describe('runUnifiedPush project binding and replacement ordering', () => {
  it('does not load metadata when negative flags accompany positive defaults', async () => {
    mocks.findSummariesFile.mockReturnValue('/workspace/coredoc-output/alpha/svc-a-summaries.json');
    mocks.findEmbeddingsFile.mockReturnValue('/workspace/coredoc-output/alpha/svc-a-embeddings.json');

    await runUnifiedPush(
      'alpha',
      'svc-a',
      {
        ...pushOptions,
        includeSummaries: true,
        summaries: false,
        includeEmbeddings: true,
        embeddings: false,
      },
      config,
    );

    expect(mocks.findSummariesFile).not.toHaveBeenCalled();
    expect(mocks.findEmbeddingsFile).not.toHaveBeenCalled();
    expect(mocks.loadSummaries).not.toHaveBeenCalled();
    expect(mocks.loadEmbeddings).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary JSON path even when the caller supplies a project', async () => {
    await expect(runUnifiedPush('alpha', '/tmp/svc-a.json', pushOptions, config)).rejects.toThrow(
      /Local push accepts configured repo names, not JSON paths/,
    );

    expect(mocks.findParsedRepo).not.toHaveBeenCalled();
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
  });

  it('rejects a parsed artifact produced with a stale repo key and tells the user to reparse', async () => {
    const changedKeyConfig = {
      ...config,
      projects: [
        {
          ...config.projects[0],
          repos: [{ ...config.projects[0].repos[0], key: 'svc-a-v2' }],
        },
      ],
    } as RuntimeConfig;

    await expect(runUnifiedPush('alpha', 'svc-a', pushOptions, changedKeyConfig)).rejects.toThrow(
      /Parsed artifact.*expected project\/repo "alpha\/svc-a".*coredoc parse svc-a --project alpha/,
    );

    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
  });

  it('rejects a parsed artifact whose embedded repo name does not match the configured pair', async () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({ ...parsedRepo, name: 'svc-b' }));

    await expect(runUnifiedPush('alpha', 'svc-a', pushOptions, config)).rejects.toThrow(
      /Parsed artifact.*belongs to repo "svc-b".*Refusing to mix project artifacts/,
    );

    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
  });

  it('rejects duplicate repo keys within one project before reading or deleting graph data', async () => {
    const duplicateKeyConfig = {
      ...config,
      projects: [
        {
          ...config.projects[0],
          repos: [config.projects[0].repos[0], { name: 'svc-b', key: 'svc-a', path: '/workspace/svc-b' }],
        },
      ],
    } as RuntimeConfig;

    await expect(runUnifiedPush('alpha', 'svc-a', pushOptions, duplicateKeyConfig)).rejects.toThrow(
      /Repo key "svc-a" is duplicated in project "alpha"/,
    );

    expect(mocks.findParsedRepo).not.toHaveBeenCalled();
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
  });

  it('rejects duplicate repo names because the local command cannot disambiguate them', async () => {
    const duplicateNameConfig = {
      ...config,
      projects: [
        {
          ...config.projects[0],
          repos: [config.projects[0].repos[0], { name: 'svc-a', key: 'svc-a-copy', path: '/workspace/svc-a-copy' }],
        },
      ],
    } as RuntimeConfig;

    await expect(runUnifiedPush('alpha', 'svc-a', pushOptions, duplicateNameConfig)).rejects.toThrow(
      /Repo name "svc-a" is duplicated in project "alpha"/,
    );

    expect(mocks.findParsedRepo).not.toHaveBeenCalled();
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
  });

  it('rejects summaries that belong to another repository', async () => {
    mocks.findSummariesFile.mockReturnValue('/workspace/coredoc-output/alpha/svc-a-summaries.json');
    mocks.loadSummaries.mockReturnValue({
      repoId: 'other-id',
      repoName: 'svc-b',
      summaries: [],
    } as SummaryOutput);

    await expect(runUnifiedPush('alpha', 'svc-a', { ...pushOptions, includeSummaries: true }, config)).rejects.toThrow(
      /Summary artifact.*belongs to repo "svc-b".*coredoc summarize svc-a --project alpha/,
    );

    expect(mocks.transformParsedRepo).not.toHaveBeenCalled();
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
  });

  it('pushes the filtered metadata snapshot and warns about stale entries', async () => {
    const staleSummary = {
      repoId: parsedRepo.id,
      repoName: parsedRepo.name,
      summaries: [{ functionId: 'deleted-fn', versionedId: 'deleted-fn:v1' }],
    } as SummaryOutput;
    const filteredSummary = { ...staleSummary, summaries: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.findSummariesFile.mockReturnValue('/workspace/coredoc-output/alpha/svc-a-summaries.json');
    mocks.loadSummaries.mockReturnValue(staleSummary);
    mocks.normalizeMetadataForParsedRepo.mockReturnValueOnce({
      summaryOutput: filteredSummary,
      embeddingsOutput: null,
      dropped: { summaries: 1, functionEmbeddings: 0, endpointEmbeddings: 0, total: 1 },
    });

    try {
      await runUnifiedPush('alpha', 'svc-a', { ...pushOptions, includeSummaries: true }, config);

      expect(mocks.transformParsedRepo).toHaveBeenCalledWith(parsedRepo, filteredSummary, null);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 1 stale entry'));
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects embeddings that belong to another repository', async () => {
    mocks.findEmbeddingsFile.mockReturnValue('/workspace/coredoc-output/alpha/svc-a-embeddings.json');
    mocks.loadEmbeddings.mockReturnValue({
      repoId: 'other-id',
      repoName: 'svc-b',
      functions: [],
      endpoints: [],
    } as EmbeddingsOutput);

    await expect(runUnifiedPush('alpha', 'svc-a', { ...pushOptions, includeEmbeddings: true }, config)).rejects.toThrow(
      /Embeddings artifact.*belongs to repo "svc-b".*coredoc embed svc-a --project alpha/,
    );

    expect(mocks.transformParsedRepo).not.toHaveBeenCalled();
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
  });

  it('binds the selected project before initializing the database', async () => {
    await runUnifiedPush('alpha', 'svc-a', pushOptions, config);

    expect(mocks.bindProjectDatabase).toHaveBeenCalledWith(config, 'alpha');
    expect(mocks.getDriver).toHaveBeenCalledWith('sqlite');
    expect(mocks.bindProjectDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getDriver.mock.invocationCallOrder[0]!,
    );
  });

  it('replaces the repository and writes its snapshot through one atomic changeset', async () => {
    await runUnifiedPush('alpha', 'svc-a', pushOptions, config);

    expect(mocks.repository.applyChangeset).toHaveBeenCalledWith({
      repoId: parsedRepo.id,
      repoIdsToDelete: [parsedRepo.id],
      nodesToAdd: transformResult.nodes,
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgeTypesToPreserve: [],
      edgesToInsert: transformResult.edges,
    });
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.repository.pushNodes).not.toHaveBeenCalled();
    expect(mocks.repository.pushEdges).not.toHaveBeenCalled();
  });

  it('removes an older SQLite repo hash in the same atomic re-keyed replacement', async () => {
    mocks.repository.listAllRepositories.mockResolvedValueOnce([{ hash: 'old-repo-hash', name: parsedRepo.name }]);

    await runUnifiedPush('alpha', 'svc-a', pushOptions, config);

    expect(mocks.repository.listAllRepositories).toHaveBeenCalledWith([parsedRepo.name]);
    expect(mocks.repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoIdsToDelete: ['old-repo-hash', parsedRepo.id] }),
    );
  });

  it('keeps --rebuild as a single-replacement compatibility alias locally', async () => {
    await runUnifiedPush('alpha', 'svc-a', { ...pushOptions, rebuild: true }, config);

    expect(mocks.repository.applyChangeset).toHaveBeenCalledOnce();
    expect(mocks.repository.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ repoIdsToDelete: [parsedRepo.id] }),
    );
  });

  it('refuses a backend without atomic replacement support', async () => {
    const applyChangeset = mocks.repository.applyChangeset;
    (mocks.repository as { applyChangeset?: typeof applyChangeset }).applyChangeset = undefined;

    try {
      await expect(runUnifiedPush('alpha', 'svc-a', pushOptions, config)).rejects.toThrow(
        /cannot atomically replace repo "svc-a"/,
      );
    } finally {
      mocks.repository.applyChangeset = applyChangeset;
    }

    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.repository.pushNodes).not.toHaveBeenCalled();
    expect(mocks.repository.pushEdges).not.toHaveBeenCalled();
  });

  it('rejects an unparsed selected repo before starting a Ladybug project replacement', async () => {
    mocks.findParsedRepo.mockReturnValue(null);
    await expect(runUnifiedPush('alpha', 'svc-a', { ...pushOptions, backend: 'ladybug' }, config)).rejects.toThrow(
      /Parsed repo not found/,
    );
    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
  });

  it('does not open or mutate a database during a dry run', async () => {
    await runUnifiedPush('alpha', 'svc-a', { ...pushOptions, dryRun: true }, config);

    expect(mocks.bindProjectDatabase).not.toHaveBeenCalled();
    expect(mocks.getDriver).not.toHaveBeenCalled();
    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.repository.pushNodes).not.toHaveBeenCalled();
    expect(mocks.repository.pushEdges).not.toHaveBeenCalled();
    expect(mocks.repository.applyChangeset).not.toHaveBeenCalled();
  });

  it('rejects a shared Neo4j repo key before deleting any graph data', async () => {
    const sharedConfig = {
      ...config,
      projects: [
        config.projects[0],
        {
          id: 'beta',
          name: 'Beta',
          repos: [{ name: 'other-name', key: 'svc-a', path: '/workspace/other-name' }],
        },
      ],
    } as RuntimeConfig;

    await expect(runUnifiedPush('alpha', 'svc-a', { ...pushOptions, backend: 'neo4j' }, sharedConfig)).rejects.toThrow(
      /exists in multiple projects/,
    );

    expect(mocks.repository.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.repository.pushNodes).not.toHaveBeenCalled();
    expect(mocks.repository.pushEdges).not.toHaveBeenCalled();
    expect(mocks.repository.applyChangeset).not.toHaveBeenCalled();
  });
});
