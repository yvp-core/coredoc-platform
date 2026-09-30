/**
 * Tests for GraphService — the thin REST wrapper around the portable MCP
 * handlers. Parity is the product: every endpoint must return the mocked
 * handler's `data` unmodified (assert-deep-equal), never reshaped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkspaceGraphContextError,
  type WorkspaceMcpContextService,
} from '../../mcp/workspace-mcp-context.service.js';
import { WorkspaceFileCacheError } from '../../database/workspace-file-cache.service.js';

const handleSearchSymbols = vi.fn();
const handleListEntrypoints = vi.fn();
const handleListServiceDependencies = vi.fn();

vi.mock('@coredoc/mcp/tools', () => ({
  handleSearchSymbols: (...args: unknown[]) => handleSearchSymbols(...args),
  handleListEntrypoints: (...args: unknown[]) => handleListEntrypoints(...args),
  handleListServiceDependencies: (...args: unknown[]) => handleListServiceDependencies(...args),
}));

const { GraphService } = await import('./graph.service.js');

function makeScope() {
  return {
    currentPath: 'workspace://hashcore',
    resolvedRepos: ['api-server'],
    repoHashes: ['hashcore'],
    crossRepoEnabled: false,
    origin: 'workspace' as const,
  };
}

function makeDeps(graphBackend = 'turso') {
  const repository = {
    findCode: vi.fn(),
    getRepoOverview: vi.fn(),
    getCoverageCounts: vi.fn(),
    getNodesByIds: vi.fn(),
    getNodeWithProperties: vi.fn(),
    getNeighborCounts: vi.fn(),
    getNeighbors: vi.fn(),
    getSubgraph: vi.fn(),
    findDeadNodes: vi.fn(),
    getCrossRepoBridges: vi.fn(),
    listNodesByType: vi.fn(),
    getRepositoryNames: vi.fn().mockResolvedValue([]),
    getEdgesAmong: vi.fn(),
    runReadOnlyCypher: vi.fn(),
  };
  const repos = [{ repoName: 'api-server', repoKey: 'hashcore', lastPushedAt: new Date('2026-07-05T00:00:00Z') }];
  const wsContext = {
    withContextByWorkspaceId: vi
      .fn()
      .mockImplementation(async (_workspaceId, callback) =>
        callback({ repository, scope: makeScope(), repos, versionId: null, graphBackend }),
      ),
  } as unknown as WorkspaceMcpContextService;
  return { repository, repos, wsContext };
}

// GraphService deliberately takes NO MetricsService: explorer/browser REST
// traffic polluting mcp_query_metrics (as `rest:*` tool names) was a bug.
// Only BaseCoredocTool.executeWithMetrics — the real MCP tool path — records
// MCP metrics. The former "records a rest:* metric" tests were removed with
// the injection; this arity check guards against the dependency quietly
// coming back.
describe('GraphService metrics isolation', () => {
  it('constructs with only the workspace-context dependency (no MetricsService)', () => {
    expect(GraphService.length).toBe(1);
  });
});

describe('GraphService.searchSymbols', () => {
  beforeEach(() => {
    handleSearchSymbols.mockReset();
    handleListEntrypoints.mockReset();
    handleListServiceDependencies.mockReset();
  });

  it('returns the handler response data unmodified (parity, no reshaping)', async () => {
    const { wsContext, repository } = makeDeps();
    const handlerResponse = { data: [{ id: 'x:function:foo', name: 'foo' }], metadata: { format: 'raw' } };
    handleSearchSymbols.mockResolvedValue(handlerResponse);

    const service = new GraphService(wsContext);
    const result = await service.searchSymbols('ws-1', { q: 'foo' });

    expect(result).toEqual(handlerResponse.data);
    expect(handleSearchSymbols).toHaveBeenCalledTimes(1);
    const [args, scope, format, , , repo] = handleSearchSymbols.mock.calls[0]!;
    expect(args).toMatchObject({ query: 'foo' });
    expect(scope.repoHashes).toEqual(['hashcore']);
    expect(format).toBe('raw');
    expect(repo).toBe(repository);
  });

  it('passes types filter through as the singular `type` arg when exactly one type is given', async () => {
    const { wsContext } = makeDeps();
    handleSearchSymbols.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.searchSymbols('ws-1', { q: 'foo', types: 'function' });

    const [args] = handleSearchSymbols.mock.calls[0]!;
    expect(args.type).toBe('function');
  });

  it('rejects an unknown type in `types`', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: 'foo', types: 'not-a-real-type' })).rejects.toThrow(
      /Invalid types/,
    );
    expect(handleSearchSymbols).not.toHaveBeenCalled();
  });

  it('rejects multiple comma-separated types (handler accepts only one type at a time)', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: 'foo', types: 'function,class' })).rejects.toThrow(/Invalid types/);
  });

  it('defaults limit to 20 and rejects a negative limit', async () => {
    const { wsContext } = makeDeps();
    handleSearchSymbols.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.searchSymbols('ws-1', { q: 'foo' });
    expect(handleSearchSymbols.mock.calls[0]![0].limit).toBe(20);

    await expect(service.searchSymbols('ws-1', { q: 'foo', limit: '-1' })).rejects.toThrow(/Invalid limit/);
  });

  it('narrows scope with scopeRepo', async () => {
    const { wsContext } = makeDeps();
    handleSearchSymbols.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.searchSymbols('ws-1', { q: 'foo', scopeRepo: 'api-server' });

    const [, scope] = handleSearchSymbols.mock.calls[0]!;
    expect(scope.resolvedRepos).toEqual(['api-server']);
  });

  it('rejects a missing q with 400 BadRequestException', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', {})).rejects.toMatchObject({
      status: 400,
      message: 'q is required',
    });
    expect(handleSearchSymbols).not.toHaveBeenCalled();
  });

  it('rejects a blank q with 400 BadRequestException', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: '   ' })).rejects.toMatchObject({
      status: 400,
      message: 'q is required',
    });
    expect(handleSearchSymbols).not.toHaveBeenCalled();
  });

  it('clamps limit to the REST-only cap of 500 (MCP handler itself stays capless)', async () => {
    const { wsContext } = makeDeps();
    handleSearchSymbols.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.searchSymbols('ws-1', { q: 'foo', limit: '10000' });

    expect(handleSearchSymbols.mock.calls[0]![0].limit).toBe(500);
  });

  it('rejects a duplicated query param (Express string[] on repeated keys) with 400', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: ['foo', 'bar'] as unknown as string })).rejects.toMatchObject({
      status: 400,
    });
    expect(handleSearchSymbols).not.toHaveBeenCalled();
  });

  it('translates an unknown scopeRepo into 400 with the "Available repos" hint intact', async () => {
    const { repos } = makeDeps();
    const wsContext = {
      withContextByWorkspaceId: vi
        .fn()
        .mockImplementation(async (_workspaceId, callback) =>
          callback({ repository: { findCode: vi.fn() }, scope: makeScope(), repos, versionId: null }),
        ),
    } as unknown as WorkspaceMcpContextService;
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: 'foo', scopeRepo: 'no-such-repo' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Available repos'),
    });
  });

  it('does not translate a plain handler error merely because its message starts with "Unknown scope"', async () => {
    const { wsContext } = makeDeps();
    const handlerError = new Error('Unknown scope from an internal repository failure');
    handleSearchSymbols.mockRejectedValue(handlerError);

    await expect(new GraphService(wsContext).searchSymbols('ws-1', { q: 'foo' })).rejects.toBe(handlerError);
  });

  it('translates a missing workspace database into 404', async () => {
    const wsContext = {
      withContextByWorkspaceId: vi
        .fn()
        .mockRejectedValue(
          new WorkspaceGraphContextError('DATABASE_UNAVAILABLE', 'No database available for workspace: acme'),
        ),
    } as unknown as WorkspaceMcpContextService;
    const service = new GraphService(wsContext);

    await expect(service.searchSymbols('ws-1', { q: 'foo' })).rejects.toMatchObject({
      status: 404,
      message: 'No database available for workspace: acme',
    });
  });

  it.each([
    ['ACTIVE_VERSION_MISSING', 'Workspace ws-1 has no active graph version'],
    ['VERSION_NOT_FOUND', 'Graph version not found: ws-1/v1'],
  ] as const)('translates file-snapshot absence %s into 404', async (code, message) => {
    const wsContext = {
      withContextByWorkspaceId: vi.fn().mockRejectedValue(new WorkspaceGraphContextError(code, message)),
    } as unknown as WorkspaceMcpContextService;

    await expect(new GraphService(wsContext).searchSymbols('ws-1', { q: 'foo' })).rejects.toMatchObject({
      status: 404,
      message,
    });
  });

  it.each([
    'NOT_FOUND',
    'DOWNLOAD_TIMEOUT',
    'CACHE_CAPACITY',
    'OPEN_FAILED',
  ] as const)('translates temporary file-cache failure %s into 503', async (code) => {
    const message = `temporary graph cache failure: ${code}`;
    const wsContext = {
      withContextByWorkspaceId: vi.fn().mockRejectedValue(new WorkspaceFileCacheError(code, message)),
    } as unknown as WorkspaceMcpContextService;

    await expect(new GraphService(wsContext).searchSymbols('ws-1', { q: 'foo' })).rejects.toMatchObject({
      status: 503,
      message,
    });
  });
});

describe('GraphService.overview', () => {
  beforeEach(() => {
    handleSearchSymbols.mockReset();
  });

  it('composes getRepoOverview + getCoverageCounts into { repos, coverage } unmodified', async () => {
    const { wsContext, repository } = makeDeps();
    const overview = [{ name: 'api-server', type: 'backend' }];
    const coverage = [{ repoName: 'api-server', entityCount: 3 }];
    (repository.getRepoOverview as any).mockResolvedValue(overview);
    (repository.getCoverageCounts as any).mockResolvedValue(coverage);

    const service = new GraphService(wsContext);
    const result = await service.overview('ws-1', {});

    expect(result).toEqual({ repos: overview, coverage });
  });

  it('does not release the graph context before all repository reads settle', async () => {
    const events: string[] = [];
    const repository = {
      getRepoOverview: vi.fn().mockImplementation(async () => {
        events.push('overview');
        expect(events).not.toContain('release');
        return [];
      }),
      getCoverageCounts: vi.fn().mockImplementation(async () => {
        events.push('coverage');
        expect(events).not.toContain('release');
        return [];
      }),
    };
    const wsContext = {
      withContextByWorkspaceId: vi.fn().mockImplementation(async (_workspaceId, callback) => {
        events.push('acquire');
        try {
          return await callback({ repository, scope: makeScope(), repos: [], versionId: 'v1' });
        } finally {
          events.push('release');
        }
      }),
    } as unknown as WorkspaceMcpContextService;

    await new GraphService(wsContext).overview('ws-1', {});

    expect(events.at(-1)).toBe('release');
  });
});

describe('GraphService.serviceDependencies', () => {
  beforeEach(() => {
    handleListServiceDependencies.mockReset();
  });

  it('returns the handler response data unmodified', async () => {
    const { wsContext } = makeDeps();
    const handlerResponse = { data: [{ service: 'order-service', callCount: 3 }], metadata: {} };
    handleListServiceDependencies.mockResolvedValue(handlerResponse);

    const service = new GraphService(wsContext);
    const result = await service.serviceDependencies('ws-1', {});

    expect(result).toEqual(handlerResponse.data);
    const [, , format] = handleListServiceDependencies.mock.calls[0]!;
    expect(format).toBe('raw');
  });
});

describe('GraphService.entrypoints', () => {
  beforeEach(() => {
    handleListEntrypoints.mockReset();
  });

  it('returns the handler response data unmodified', async () => {
    const { wsContext } = makeDeps();
    const handlerResponse = { data: [{ id: 'x:entrypoint:1', type: 'http' }], metadata: {}, resultCount: 1 };
    handleListEntrypoints.mockResolvedValue(handlerResponse);

    const service = new GraphService(wsContext);
    const result = await service.entrypoints('ws-1', { protocol: 'http' });

    expect(result).toEqual(handlerResponse.data);
    const [args] = handleListEntrypoints.mock.calls[0]!;
    expect(args.type).toBe('http');
  });

  it('rejects an unknown protocol', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.entrypoints('ws-1', { protocol: 'carrier-pigeon' })).rejects.toThrow(/Invalid protocol/);
  });

  it('clamps limit to the handler max of 100', async () => {
    const { wsContext } = makeDeps();
    handleListEntrypoints.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.entrypoints('ws-1', { limit: '500' });

    expect(handleListEntrypoints.mock.calls[0]![0].limit).toBe(100);
  });

  it('accepts protocol=all as an alias for "no filter" (maps to omitted `type`)', async () => {
    const { wsContext } = makeDeps();
    handleListEntrypoints.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.entrypoints('ws-1', { protocol: 'all' });

    expect(handleListEntrypoints.mock.calls[0]![0].type).toBeUndefined();
  });

  it('narrows scope with scopeRepo (renamed from `repo` for param-name consistency)', async () => {
    const { wsContext } = makeDeps();
    handleListEntrypoints.mockResolvedValue({ data: [], metadata: {} });
    const service = new GraphService(wsContext);

    await service.entrypoints('ws-1', { scopeRepo: 'api-server' });

    const [, scope] = handleListEntrypoints.mock.calls[0]!;
    expect(scope.resolvedRepos).toEqual(['api-server']);
  });
});

describe('GraphService.nodeDetail (Tier B)', () => {
  it('returns node + neighbor counts + projected detail from getNodeWithProperties', async () => {
    const { wsContext, repository } = makeDeps();
    const node = { id: 'hashcore:function:a.ts:f', type: 'function', name: 'f', repoName: 'api-server' };
    (repository.getNodeWithProperties as any).mockResolvedValue({
      node,
      properties: { purpose: 'does X', isAsync: true },
    });
    (repository.getNeighborCounts as any).mockResolvedValue([{ edgeType: 'CALLS', direction: 'out', count: 2 }]);

    const service = new GraphService(wsContext);
    const result = await service.nodeDetail('ws-1', 'hashcore:function:a.ts:f');

    expect(result.node).toEqual(node);
    expect(result.neighborCounts).toEqual([{ edgeType: 'CALLS', direction: 'out', count: 2 }]);
    expect(result.detail).toMatchObject({ kind: 'function', purpose: 'does X', isAsync: true });
    expect(repository.getNodeWithProperties).toHaveBeenCalledWith('hashcore:function:a.ts:f', ['hashcore']);
    expect(repository.getNeighborCounts).toHaveBeenCalledWith('hashcore:function:a.ts:f', ['hashcore']);
  });

  it('404s when the id names no node', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.getNodeWithProperties as any).mockResolvedValue(null);
    (repository.getNeighborCounts as any).mockResolvedValue([]);
    const service = new GraphService(wsContext);
    await expect(service.nodeDetail('ws-1', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('400s on an empty id', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.nodeDetail('ws-1', '')).rejects.toMatchObject({ status: 400 });
  });
});

describe('GraphService.listRepos', () => {
  it('returns sorted, deduped workspace repo names', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.getRepositoryNames as any).mockResolvedValue([
      { hash: 'h2', name: 'web' },
      { hash: 'h1', name: 'api' },
      { hash: 'h3', name: 'api' },
    ]);
    const service = new GraphService(wsContext);
    const result = await service.listRepos('ws-1');
    expect(result).toEqual({ repos: [{ name: 'api' }, { name: 'web' }] });
  });
});

describe('GraphService.nodesByType (Tier B browse)', () => {
  it('validates type, clamps limit to 200, and passes the cursor to listNodesByType', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { nodes: [], truncated: false };
    (repository.listNodesByType as any).mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.nodesByType('ws-1', { type: 'entrypoint', limit: '9999', cursor: 'c1' });

    expect(result).toBe(page);
    expect(repository.listNodesByType).toHaveBeenCalledWith('entrypoint', { limit: 200, cursor: 'c1' }, ['hashcore']);
  });

  it('400s on a missing or unknown type', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.nodesByType('ws-1', {})).rejects.toMatchObject({ status: 400 });
    await expect(service.nodesByType('ws-1', { type: 'nonsense' })).rejects.toMatchObject({ status: 400 });
  });

  it('narrows scope with scopeRepo and defaults the limit to 50', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.listNodesByType as any).mockResolvedValue({ nodes: [], truncated: false });
    const service = new GraphService(wsContext);
    await service.nodesByType('ws-1', { type: 'entity', scopeRepo: 'api-server' });
    expect(repository.listNodesByType).toHaveBeenCalledWith('entity', { limit: 50 }, ['hashcore']);
  });
});

describe('GraphService cypher (capability + query)', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('capabilities: cypher is off for a turso workspace (relational store); edgesAmong is always on', async () => {
    const { wsContext } = makeDeps('turso');
    const service = new GraphService(wsContext);
    await expect(service.capabilities('ws-1')).resolves.toEqual({ cypher: false, edgesAmong: true });
  });

  it('capabilities: cypher is on for a file_snapshot workspace with no operator flag (per-workspace file)', async () => {
    const { wsContext } = makeDeps('file_snapshot');
    const service = new GraphService(wsContext);
    await expect(service.capabilities('ws-1')).resolves.toEqual({ cypher: true, edgesAmong: true });
  });

  it('capabilities: a file_snapshot repository without runReadOnlyCypher still reports cypher: false', async () => {
    const { wsContext, repository } = makeDeps('file_snapshot');
    (repository as { runReadOnlyCypher?: unknown }).runReadOnlyCypher = undefined;
    const service = new GraphService(wsContext);
    await expect(service.capabilities('ws-1')).resolves.toEqual({ cypher: false, edgesAmong: true });
  });

  it('capabilities: cypher is on when backend=neo4j AND the operator flag is set', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    process.env.COREDOC_ALLOW_CYPHER = 'true';
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.capabilities('ws-1')).resolves.toEqual({ cypher: true, edgesAmong: true });
  });

  it('capabilities: backend=neo4j without the operator flag keeps cypher off', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    delete process.env.COREDOC_ALLOW_CYPHER;
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.capabilities('ws-1')).resolves.toEqual({ cypher: false, edgesAmong: true });
  });

  it('runCypher 404s for a turso workspace', async () => {
    const { wsContext, repository } = makeDeps('turso');
    const service = new GraphService(wsContext);
    await expect(service.runCypher('ws-1', { query: 'MATCH (n) RETURN n' })).rejects.toMatchObject({ status: 404 });
    expect(repository.runReadOnlyCypher).not.toHaveBeenCalled();
  });

  it('runCypher routes to the file_snapshot repository with no operator flag', async () => {
    const { wsContext, repository } = makeDeps('file_snapshot');
    const res = { nodes: [], edges: [], truncated: false };
    (repository.runReadOnlyCypher as any).mockResolvedValue(res);
    const service = new GraphService(wsContext);
    const result = await service.runCypher('ws-1', { query: 'MATCH (n) RETURN n', limit: '10' });
    expect(result).toBe(res);
    expect(repository.runReadOnlyCypher).toHaveBeenCalledWith('MATCH (n) RETURN n', { limit: 10 });
  });

  it('runCypher clamps the limit to the REST cap', async () => {
    const { wsContext, repository } = makeDeps('file_snapshot');
    (repository.runReadOnlyCypher as any).mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const service = new GraphService(wsContext);
    await service.runCypher('ws-1', { query: 'MATCH (n) RETURN n', limit: 9999 });
    expect(repository.runReadOnlyCypher).toHaveBeenCalledWith('MATCH (n) RETURN n', { limit: 500 });
  });

  it('runCypher 404s when the leased repository cannot run cypher', async () => {
    const { wsContext, repository } = makeDeps('file_snapshot');
    (repository as { runReadOnlyCypher?: unknown }).runReadOnlyCypher = undefined;
    const service = new GraphService(wsContext);
    await expect(service.runCypher('ws-1', { query: 'MATCH (n) RETURN n' })).rejects.toMatchObject({ status: 404 });
  });

  it('runCypher runs the query and returns the graph result when enabled', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    process.env.COREDOC_ALLOW_CYPHER = 'true';
    const { wsContext, repository } = makeDeps();
    const res = { nodes: [], edges: [], truncated: false };
    (repository.runReadOnlyCypher as any).mockResolvedValue(res);
    const service = new GraphService(wsContext);
    const result = await service.runCypher('ws-1', { query: 'MATCH (n) RETURN n', limit: '10' });
    expect(result).toBe(res);
    expect(repository.runReadOnlyCypher).toHaveBeenCalledWith('MATCH (n) RETURN n', { limit: 10 });
  });

  it('runCypher 400s on an empty query when enabled', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    process.env.COREDOC_ALLOW_CYPHER = 'true';
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.runCypher('ws-1', { query: '   ' })).rejects.toMatchObject({ status: 400 });
  });

  it('runCypher translates a read-only violation from the repository into 400', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    process.env.COREDOC_ALLOW_CYPHER = 'true';
    const { wsContext, repository } = makeDeps();
    (repository.runReadOnlyCypher as any).mockRejectedValue(
      new Error('Only read-only Cypher is allowed (found "DELETE")'),
    );
    const service = new GraphService(wsContext);
    await expect(service.runCypher('ws-1', { query: 'MATCH (n) DELETE n' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('GraphService.neighbors (Tier B)', () => {
  it('validates + clamps params and passes them through to getNeighbors', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { nodes: [], edges: [], truncated: false };
    (repository.getNeighbors as any).mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.neighbors('ws-1', 'hashcore:function:a.ts:f', {
      direction: 'out',
      edgeTypes: 'CALLS,MAKES_EXTERNAL_CALL',
      limit: '9999', // clamped to 200
    });

    expect(result).toBe(page);
    expect(repository.getNeighbors).toHaveBeenCalledWith(
      'hashcore:function:a.ts:f',
      { direction: 'out', limit: 200, edgeTypes: ['CALLS', 'MAKES_EXTERNAL_CALL'] },
      ['hashcore'],
    );
  });

  it('defaults direction to both and limit to 50, passing an opaque cursor', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.getNeighbors as any).mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const service = new GraphService(wsContext);

    await service.neighbors('ws-1', 'n', { cursor: 'c9' });

    expect(repository.getNeighbors).toHaveBeenCalledWith('n', { direction: 'both', limit: 50, cursor: 'c9' }, [
      'hashcore',
    ]);
  });

  it('400s on an invalid direction', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.neighbors('ws-1', 'n', { direction: 'sideways' })).rejects.toMatchObject({ status: 400 });
  });

  it('400s on an unknown edge type', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.neighbors('ws-1', 'n', { edgeTypes: 'CALLS,NONSENSE' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('GraphService.subgraph (Tier B traverse)', () => {
  it('validates, clamps depth to the max, and passes params to getSubgraph', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { nodes: [{ id: 'n1' }], edges: [], truncated: false };
    (repository.getSubgraph as any).mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.subgraph('ws-1', 'n0', {
      depth: '99', // clamped to 5
      direction: 'out',
      edgeTypes: 'CALLS,HANDLES',
    });

    expect(result).toBe(page);
    expect(repository.getSubgraph).toHaveBeenCalledWith(
      'n0',
      { depth: 5, direction: 'out', nodeCap: 200, edgeTypes: ['CALLS', 'HANDLES'] },
      ['hashcore'],
    );
  });

  it('defaults depth and direction when omitted', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.getSubgraph as any).mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const service = new GraphService(wsContext);
    await service.subgraph('ws-1', 'n0', {});
    expect(repository.getSubgraph).toHaveBeenCalledWith('n0', { depth: 3, direction: 'both', nodeCap: 200 }, [
      'hashcore',
    ]);
  });

  it('400s on empty id, bad direction, or bad edgeTypes', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.subgraph('ws-1', '', { depth: '2' })).rejects.toMatchObject({ status: 400 });
    await expect(service.subgraph('ws-1', 'n', { direction: 'sideways' })).rejects.toMatchObject({ status: 400 });
    await expect(service.subgraph('ws-1', 'n', { edgeTypes: 'NOPE' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('GraphService.deadCode', () => {
  it('validates types, clamps the limit, and passes params to findDeadNodes', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { nodes: [], truncated: false, lowCoverageRepos: ['thin'] };
    (repository.findDeadNodes as any).mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.deadCode('ws-1', { types: 'function,class', limit: '999' });

    expect(result).toBe(page);
    expect(repository.findDeadNodes).toHaveBeenCalledWith({ types: ['function', 'class'], limit: 200 }, ['hashcore']);
  });

  it('omits the types param when none given (repo applies its default)', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.findDeadNodes as any).mockResolvedValue({ nodes: [], truncated: false, lowCoverageRepos: [] });
    const service = new GraphService(wsContext);
    await service.deadCode('ws-1', {});
    expect(repository.findDeadNodes).toHaveBeenCalledWith({ limit: 50 }, ['hashcore']);
  });

  it('400s on an unknown node type', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.deadCode('ws-1', { types: 'nope' })).rejects.toMatchObject({ status: 400 });
  });
});

// Validation/clamping branches only — the induced-set behavior (which edges
// come back for a given node set, and truncation) is asserted against a real
// SQLite fixture in graph.parity.test.ts, where a mocked repository cannot
// hide an edge-leak bug.
describe('GraphService.edgesAmong (Tier B canvas linking)', () => {
  it('passes the node ids, scope hashes, and the default limit to getEdgesAmong', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { edges: [], truncated: false };
    repository.getEdgesAmong.mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.edgesAmong('ws-1', { nodeIds: ['n1', 'n2'] });

    expect(result).toBe(page);
    expect(repository.getEdgesAmong).toHaveBeenCalledWith(['n1', 'n2'], ['hashcore'], 4000);
  });

  it('clamps a client-supplied limit to the max', async () => {
    const { wsContext, repository } = makeDeps();
    repository.getEdgesAmong.mockResolvedValue({ edges: [], truncated: false });
    const service = new GraphService(wsContext);

    await service.edgesAmong('ws-1', { nodeIds: ['n1'], limit: 99_999 });

    expect(repository.getEdgesAmong).toHaveBeenCalledWith(['n1'], ['hashcore'], 4000);
  });

  it('returns an empty result for an empty node set without touching the repository', async () => {
    const { wsContext, repository } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.edgesAmong('ws-1', { nodeIds: [] })).resolves.toEqual({ edges: [], truncated: false });
    expect(repository.getEdgesAmong).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['a non-array', 'n1'],
    ['a non-string entry', ['n1', 7]],
  ])('400s on %s nodeIds, naming the field', async (_label, nodeIds) => {
    const { wsContext, repository } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.edgesAmong('ws-1', { nodeIds })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('nodeIds'),
    });
    expect(repository.getEdgesAmong).not.toHaveBeenCalled();
  });

  it('400s above the node-id cap (the canvas can never legitimately exceed it)', async () => {
    const { wsContext, repository } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(
      service.edgesAmong('ws-1', { nodeIds: Array.from({ length: 3001 }, (_v, i) => `n${i}`) }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('nodeIds') });
    expect(repository.getEdgesAmong).not.toHaveBeenCalled();
  });

  it('400s on a non-positive-integer limit', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);

    await expect(service.edgesAmong('ws-1', { nodeIds: ['n1'], limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(service.edgesAmong('ws-1', { nodeIds: ['n1'], limit: 'lots' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('GraphService.crossRepo', () => {
  it('resolves workspace-wide and clamps the limit', async () => {
    const { wsContext, repository } = makeDeps();
    const page = { nodes: [], edges: [], truncated: false };
    (repository.getCrossRepoBridges as any).mockResolvedValue(page);
    const service = new GraphService(wsContext);

    const result = await service.crossRepo('ws-1', { limit: '999' });

    expect(result).toBe(page);
    expect(repository.getCrossRepoBridges).toHaveBeenCalledWith({ limit: 200 }, ['hashcore']);
  });

  it('translates scopeRepo into focusRepoHashes WITHOUT narrowing the DB scope', async () => {
    const { wsContext, repository } = makeDeps();
    (repository.getCrossRepoBridges as any).mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const service = new GraphService(wsContext);

    await service.crossRepo('ws-1', { scopeRepo: 'api-server' });

    expect(repository.getCrossRepoBridges).toHaveBeenCalledWith(
      { limit: 50, focusRepoHashes: ['hashcore'] },
      ['hashcore'], // DB scope stays workspace-wide
    );
  });

  it('400s on an unknown scopeRepo', async () => {
    const { wsContext } = makeDeps();
    const service = new GraphService(wsContext);
    await expect(service.crossRepo('ws-1', { scopeRepo: 'ghost' })).rejects.toMatchObject({ status: 400 });
  });
});
