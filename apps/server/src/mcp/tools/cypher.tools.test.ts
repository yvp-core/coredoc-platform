/**
 * Hosted `run_cypher_query` tool.
 *
 * The gate under test is S8/acceptance 7: on a workspace whose graph cannot
 * serve Cypher (Turso), or with the operator opt-in off, the call must come
 * back as a VISIBLE tool error — never an exception escaping into mcp-nest's
 * 500 path. The mock repositories therefore genuinely OMIT the optional Cypher
 * methods, and the tool is driven through the real WorkspaceMcpContextService
 * so the leased facade (not a hand-built stub) decides what is callable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import { buildCypherDescription } from '@coredoc/mcp';
import type { Request } from 'express';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import type { WorkspaceFileCacheService } from '../../database/workspace-file-cache.service.js';
import type { MetricsService } from '../../modules/metrics/metrics.service.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { CypherTools, HOSTED_CYPHER_DESCRIPTION } from './cypher.tools.js';

const VERSION = {
  workspaceId: 'ws-1',
  versionId: 'v1',
  engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
  r2Key: 'ws-1/v1.graph',
  sha256: 'a'.repeat(64),
  sizeBytes: 42n,
  storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
};

const OVERVIEW = [{ repoName: 'api-server', parsedAt: '2026-08-20T00:00:00.000Z' }];

function makeDeps() {
  const workspaceDbPool = { getRepository: vi.fn() } as unknown as WorkspaceDbPoolService;
  const controlPlane = {
    getWorkspaceById: vi.fn(),
    getWorkspaceGraphVersion: vi.fn().mockResolvedValue(VERSION),
    listRepos: vi.fn().mockResolvedValue([{ repoName: 'api-server', repoKey: 'hashcore' }]),
  } as unknown as ControlPlaneService;
  const fileCache = {
    acquire: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceFileCacheService;
  return { workspaceDbPool, controlPlane, fileCache };
}

/** A Turso-shaped repository: graph reads only, no Cypher capability at all. */
function tursoRepository() {
  return { getRepoOverview: vi.fn().mockResolvedValue(OVERVIEW) };
}

/** A Ladybug-shaped repository: carries both optional Cypher methods. */
function cypherRepository() {
  return {
    getRepoOverview: vi.fn().mockResolvedValue(OVERVIEW),
    runReadOnlyCypherRows: vi.fn().mockResolvedValue({
      columns: ['kind', 'total'],
      rows: [
        ['function', 12],
        ['class', 3],
      ],
      truncated: false,
    }),
    runReadOnlyCypher: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
  };
}

function request(): Request {
  return { headers: {}, workspaceId: 'ws-1', user: { id: 'user-1' } } as unknown as Request;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

describe('CypherTools (hosted run_cypher_query)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let recordMcpQuery: ReturnType<typeof vi.fn>;
  let tool: CypherTools;
  // The opt-in is read once, at construction, from the validated config — so a
  // test that changes it rebuilds the tool.
  let rebuildTool: () => void;
  const originalOptIn = process.env.COREDOC_ALLOW_CYPHER;

  beforeEach(() => {
    deps = makeDeps();
    recordMcpQuery = vi.fn().mockResolvedValue(undefined);
    const wsContext = new WorkspaceMcpContextService(deps.workspaceDbPool, deps.controlPlane, deps.fileCache);
    rebuildTool = () => {
      tool = new CypherTools(wsContext, { recordMcpQuery } as unknown as MetricsService);
    };
    process.env.COREDOC_ALLOW_CYPHER = 'true';
    rebuildTool();
  });

  afterEach(() => {
    if (originalOptIn === undefined) delete process.env.COREDOC_ALLOW_CYPHER;
    else process.env.COREDOC_ALLOW_CYPHER = originalOptIn;
  });

  function useFileSnapshot(repository: object) {
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.fileCache.acquire as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository,
      versionId: 'v1',
    });
  }

  function useTurso(repository: object) {
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
      activeGraphVersionId: null,
    });
    (deps.workspaceDbPool.getRepository as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(repository);
  }

  const call = (args: Record<string, unknown>) =>
    tool.runCypherQuery(args, {} as never, request()) as Promise<ToolResult>;

  it('serves a rows query on a Cypher-capable workspace graph', async () => {
    const repository = cypherRepository();
    useFileSnapshot(repository);

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS total', limit: 10 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('kind | total');
    expect(result.content[0].text).toContain('function | 12');
    expect(repository.runReadOnlyCypherRows).toHaveBeenCalledWith(
      'MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS total',
      { limit: 10 },
    );
    expect(recordMcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'run_cypher_query', success: true }),
    );
  });

  it('returns a visible capability error naming the backend when the workspace graph cannot serve Cypher', async () => {
    const repository = tursoRepository();
    useTurso(repository);

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('turso');
    expect(result.content[0].text).toContain('cannot serve Cypher');
    expect(result.content[0].text).toContain('runReadOnlyCypherRows');
  });

  it('records the failed call in metrics instead of swallowing it silently', async () => {
    useTurso(tursoRepository());

    await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' });

    expect(recordMcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'run_cypher_query', success: false }),
    );
  });

  it('reports the graph shape as unsupported when only the rows method is implemented', async () => {
    const repository = {
      getRepoOverview: vi.fn().mockResolvedValue(OVERVIEW),
      runReadOnlyCypherRows: vi.fn(),
    };
    useFileSnapshot(repository);

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n', resultShape: 'graph' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('runReadOnlyCypher');
    expect(repository.runReadOnlyCypherRows).not.toHaveBeenCalled();
  });

  it('refuses with an opt-in error, without touching the graph, when the operator has not enabled Cypher', async () => {
    delete process.env.COREDOC_ALLOW_CYPHER;
    rebuildTool();
    const repository = cypherRepository();
    useFileSnapshot(repository);

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('COREDOC_ALLOW_CYPHER');
    expect(result.content[0].text).toContain('not enabled for this deployment');
    expect(repository.runReadOnlyCypherRows).not.toHaveBeenCalled();
    expect(repository.runReadOnlyCypher).not.toHaveBeenCalled();
  });

  it('treats any non-"true" opt-in value as off (fail closed)', async () => {
    process.env.COREDOC_ALLOW_CYPHER = 'TRUE';
    rebuildTool();
    useFileSnapshot(cypherRepository());

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('COREDOC_ALLOW_CYPHER');
  });

  it('surfaces a repository read-only rejection as a visible tool error, verbatim', async () => {
    const repository = cypherRepository();
    repository.runReadOnlyCypherRows.mockRejectedValue(
      new Error('Only read-only Cypher is allowed: clause "CREATE" is not permitted.'),
    );
    useFileSnapshot(repository);

    const result = await call({ query: 'CREATE (n:GraphNode)' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('clause "CREATE" is not permitted');
  });

  it('never lets a workspace-resolution failure escape as an unhandled error', async () => {
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await call({ query: 'MATCH (n:GraphNode) RETURN n.name AS name' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Workspace not found');
  });

  it('names the workspace backend in the response, not the server-process backend', async () => {
    // A workspace whose declared backend ('turso') differs from whatever the
    // server process's own COREDOC_DB_BACKEND happens to be set to — the
    // response must report the honest per-workspace value, not the process one.
    const repository = cypherRepository();
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
      activeGraphVersionId: null,
    });
    (deps.workspaceDbPool.getRepository as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(repository);

    const result = await call({
      query: 'MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS total',
      format: 'raw',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"backend": "turso"');
  });

  it('documents the Ladybug dialect only — hosted can never serve a Neo4j graph', () => {
    expect(HOSTED_CYPHER_DESCRIPTION).toBe(buildCypherDescription({ dialects: ['ladybug'] }));
    expect(HOSTED_CYPHER_DESCRIPTION).toContain('Ladybug/Kùzu');
    expect(HOSTED_CYPHER_DESCRIPTION).not.toContain('Query shape (Neo4j)');
  });
});
