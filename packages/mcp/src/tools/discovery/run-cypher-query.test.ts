import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CypherResultShape, type CypherRowsResult, type IGraphReadRepository } from '@coredoc/db';
import type { CypherGraphResult } from '@coredoc/core/types';
import { handleRunCypherQuery } from './run-cypher-query.js';
import { resolveDetailLevel } from '../../detail-level.js';
import type { ScopeContext } from '../../types.js';

const SCOPE: ScopeContext = {
  currentPath: '/repo',
  resolvedRepos: ['test-repo'],
  // Empty on purpose: staleness short-circuits, so no repository read is needed.
  repoHashes: [],
  crossRepoEnabled: false,
} as unknown as ScopeContext;

const ROWS: CypherRowsResult = {
  columns: ['kind', 'total'],
  rows: [
    ['function', 12],
    ['entity', 3],
  ],
  truncated: false,
};

const GRAPH: CypherGraphResult = {
  nodes: [{ id: 'n1', type: 'function', name: 'createUser', repoName: 'test-repo' }] as CypherGraphResult['nodes'],
  edges: [],
  truncated: false,
};

function fakeRepository(overrides: Record<string, unknown> = {}) {
  return {
    runReadOnlyCypherRows: vi.fn().mockResolvedValue(ROWS),
    runReadOnlyCypher: vi.fn().mockResolvedValue(GRAPH),
    ...overrides,
  } as unknown as IGraphReadRepository & {
    runReadOnlyCypherRows: ReturnType<typeof vi.fn>;
    runReadOnlyCypher: ReturnType<typeof vi.fn>;
  };
}

function call(args: Record<string, unknown>, repository: IGraphReadRepository, format: 'summary' | 'raw' = 'summary') {
  return handleRunCypherQuery(args, SCOPE, format, 'full', resolveDetailLevel('full'), repository);
}

describe('handleRunCypherQuery', () => {
  const ORIGINAL_BACKEND = process.env.COREDOC_DB_BACKEND;

  beforeEach(() => {
    process.env.COREDOC_DB_BACKEND = 'ladybug';
  });

  afterEach(() => {
    if (ORIGINAL_BACKEND === undefined) delete process.env.COREDOC_DB_BACKEND;
    else process.env.COREDOC_DB_BACKEND = ORIGINAL_BACKEND;
  });

  it('renders the projected columns and names the serving backend', async () => {
    const repository = fakeRepository();
    const response = await call({ query: 'MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS total' }, repository);

    const text = response.data as string;
    expect(text).toContain('kind');
    expect(text).toContain('total');
    expect(text).toContain('function');
    expect(text).toContain('ladybug');
    expect(response.resultCount).toBe(2);
  });

  it('returns the result JSON with the backend in raw format', async () => {
    const repository = fakeRepository();
    const response = await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' }, repository, 'raw');

    expect(response.data).toMatchObject({ backend: 'ladybug', columns: ['kind', 'total'], truncated: false });
  });

  it('defaults the limit to 200 when absent', async () => {
    const repository = fakeRepository();
    await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' }, repository);

    expect(repository.runReadOnlyCypherRows).toHaveBeenCalledWith(expect.any(String), { limit: 200 });
  });

  it('clamps an over-max limit to 500', async () => {
    const repository = fakeRepository();
    await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name', limit: 9999 }, repository);

    expect(repository.runReadOnlyCypherRows).toHaveBeenCalledWith(expect.any(String), { limit: 500 });
  });

  it('threads scalar params through to the repository', async () => {
    const repository = fakeRepository();
    await call(
      { query: 'MATCH (n:GraphNode) WHERE n.type = $kind RETURN n.name AS name', params: { kind: 'function' } },
      repository,
    );

    expect(repository.runReadOnlyCypherRows).toHaveBeenCalledWith(expect.any(String), {
      limit: 200,
      params: { kind: 'function' },
    });
  });

  it('dispatches the graph shape to runReadOnlyCypher', async () => {
    const repository = fakeRepository();
    const response = await call(
      { query: 'MATCH (a:GraphNode)-[r]->(b:GraphNode) RETURN a, r, b', resultShape: CypherResultShape.Graph },
      repository,
    );

    expect(repository.runReadOnlyCypher).toHaveBeenCalledOnce();
    expect(repository.runReadOnlyCypherRows).not.toHaveBeenCalled();
    expect(response.data as string).toContain('createUser');
  });

  it('dispatches the rows shape to runReadOnlyCypherRows', async () => {
    const repository = fakeRepository();
    await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name', resultShape: CypherResultShape.Rows }, repository);

    expect(repository.runReadOnlyCypherRows).toHaveBeenCalledOnce();
    expect(repository.runReadOnlyCypher).not.toHaveBeenCalled();
  });

  it('reports a capability error naming the backend when the method is absent', async () => {
    const repository = { getRepoOverview: vi.fn() } as unknown as IGraphReadRepository;

    await expect(call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' }, repository)).rejects.toThrow(
      /runReadOnlyCypherRows.*ladybug|ladybug.*runReadOnlyCypherRows/s,
    );
  });

  it('passes a read-only guard rejection through unchanged', async () => {
    const repository = fakeRepository({
      runReadOnlyCypherRows: vi
        .fn()
        .mockRejectedValue(new Error('Only read-only Cypher is allowed: MERGE is rejected')),
    });

    await expect(call({ query: 'MERGE (n:GraphNode)' }, repository)).rejects.toThrow(
      'Only read-only Cypher is allowed: MERGE is rejected',
    );
  });

  it('passes the composite-cell rejection through unchanged', async () => {
    const repository = fakeRepository({
      runReadOnlyCypherRows: vi.fn().mockRejectedValue(new Error('The rows shape supports scalar cells only')),
    });

    await expect(call({ query: 'MATCH (n:GraphNode) RETURN n' }, repository)).rejects.toThrow(
      'The rows shape supports scalar cells only',
    );
  });

  it('names the serving backend when an engine error is wrapped', async () => {
    const repository = fakeRepository({
      runReadOnlyCypherRows: vi.fn().mockRejectedValue(new Error('Parser exception at line 1')),
    });

    await expect(call({ query: 'MATCH ((' }, repository)).rejects.toThrow(/ladybug.*Parser exception/s);
  });

  it('appends the graph vocabulary when the engine rejected the query names', async () => {
    // Measured agent misses: `(f:Function)`, `t.file`, `type(r)` — all guesses
    // at a property-graph schema this graph does not use.
    const repository = fakeRepository({
      runReadOnlyCypherRows: vi.fn().mockRejectedValue(new Error('Binder exception: Table Function does not exist.')),
    });

    await expect(call({ query: 'MATCH (f:Function) RETURN f.name AS name' }, repository)).rejects.toThrow(
      /GraphNode.*`type` property.*filePath.*label\(r\)/s,
    );
  });

  it('does not append the vocabulary hint to a plain syntax error', async () => {
    const repository = fakeRepository({
      runReadOnlyCypherRows: vi.fn().mockRejectedValue(new Error('Parser exception at line 1')),
    });

    await expect(call({ query: 'MATCH ((' }, repository)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Graph vocabulary') }),
    );
  });

  it('rejects an empty query with actionable guidance', async () => {
    const repository = fakeRepository();
    await expect(call({ query: '  ' }, repository)).rejects.toThrow(/query/i);
  });

  it('rejects array params explicitly instead of silently dropping them', async () => {
    const repository = fakeRepository();
    await expect(
      call({ query: 'MATCH (n:GraphNode) WHERE n.type = $kind RETURN n.name AS name', params: ['a', 'b'] }, repository),
    ).rejects.toThrow(/params.*object.*map of scalars|object\/map of scalars/is);

    expect(repository.runReadOnlyCypherRows).not.toHaveBeenCalled();
  });

  it('uses the supplied backend override for metadata and the capability error', async () => {
    const repository = fakeRepository();
    const response = await handleRunCypherQuery(
      { query: 'MATCH (n:GraphNode) RETURN n.name AS name' },
      SCOPE,
      'raw',
      'full',
      resolveDetailLevel('full'),
      repository,
      'turso',
    );

    expect(response.data).toMatchObject({ backend: 'turso' });
  });

  it('names the override backend in the capability error, not the process backend', async () => {
    const repository = { getRepoOverview: vi.fn() } as unknown as IGraphReadRepository;

    await expect(
      handleRunCypherQuery(
        { query: 'MATCH (n:GraphNode) RETURN n.name AS name' },
        SCOPE,
        'summary',
        'full',
        resolveDetailLevel('full'),
        repository,
        'turso',
      ),
    ).rejects.toThrow(/turso/);
  });
});
