import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clampDepth, clampLimit } from './graph-manager.js';

describe('graph-manager clamps', () => {
  it('clampLimit caps at max and floors at 1', () => {
    expect(clampLimit(500, 200)).toBe(200);
    expect(clampLimit(50, 200)).toBe(50);
    expect(clampLimit(0, 200)).toBe(1);
    expect(clampLimit(undefined, 200)).toBe(200); // default = max
  });
  it('clampDepth caps at 5 and floors at 1', () => {
    expect(clampDepth(9)).toBe(5);
    expect(clampDepth(3)).toBe(3);
    expect(clampDepth(0)).toBe(1);
  });
});

// --- Task B2: local handler dispatch -----------------------------------------

const { repo, handleSearchSymbols } = vi.hoisted(() => ({
  repo: {
    getNeighbors: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    getNeighborCounts: vi.fn().mockResolvedValue([]),
    getNodeWithProperties: vi.fn().mockResolvedValue({ node: { id: 'n1', type: 'function' }, properties: {} }),
    getSubgraph: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    listNodesByType: vi.fn().mockResolvedValue({ nodes: [], truncated: false }),
    getRepositoryNames: vi.fn().mockResolvedValue([{ name: 'repo-a' }, { name: 'repo-a' }, { name: 'repo-b' }]),
    getCrossRepoBridges: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    findDeadNodes: vi.fn().mockResolvedValue({ nodes: [], truncated: false, lowCoverageRepos: [] }),
    getEdgesAmong: vi.fn().mockResolvedValue({ edges: [], truncated: false }),
  },
  handleSearchSymbols: vi.fn().mockResolvedValue({ data: [{ id: 's1', name: 'foo' }] }),
}));

// Cloud source delegates to the real cloud-graph REST client (Task E1). Mock it
// so the cloud-branch tests assert the delegation contract (right method, right
// args) without an actual network call — the wrappers themselves are covered by
// cloud-graph.test.ts.
const cloudGraph = vi.hoisted(() => ({
  node: vi.fn().mockResolvedValue({ node: { id: 'cloud-n1' } }),
  cypher: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
  edgesAmong: vi.fn().mockResolvedValue({ edges: [{ id: 'cloud-e1' }], truncated: false }),
}));
vi.mock('./cloud-graph.js', () => ({ cloudGraph }));

// Local reads go through the project-owned database boundary. `databaseOpens`
// records the resolved identity rather than an arbitrary caller-supplied URL.
const databaseOpens = vi.hoisted(
  () => [] as Array<{ configDir: string; projectId: string; options: { mode: string } | undefined }>,
);
const backend = vi.hoisted(() => ({ value: 'sqlite' as string }));
const getRepositorySingleton = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('@coredoc/db', () => ({
  getConfiguredBackend: () => backend.value,
  getRepository: getRepositorySingleton,
  openProjectDatabase: (configDir: string, projectId: string, options?: { mode: string }) => {
    databaseOpens.push({ configDir, projectId, options });
    return Promise.resolve({ graph: repo, operations: {}, metrics: {} });
  },
}));
vi.mock('@coredoc/mcp', () => ({
  resolveScope: () => ({ success: true, scope: { repoHashes: ['h1', 'h2'], resolvedRepos: ['repo-a', 'repo-b'] } }),
  handleSearchSymbols,
  resolveDetailLevel: () => ({}),
}));
vi.mock('./config-manager.js', () => ({ getCurrentConfigPath: () => '/tmp/ws/coredoc.json' }));

// NL→Cypher generation is its own module (own tests). Here we only assert the
// handler wires the right dialect + text into it — no real harness/LLM.
const generateCypherFromNl = vi.hoisted(() => vi.fn().mockResolvedValue({ cypher: 'MATCH (n) RETURN n' }));
vi.mock('./graph-cypher-nl.js', () => ({ generateCypherFromNl }));

import { registerGraphHandlers } from './graph-manager.js';
import { IpcChannels } from '../shared/ipc-types.js';
import type { GraphScope } from '../shared/ipc-types.js';

type Handler = (...a: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>;

function collectHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) };
  registerGraphHandlers(ipcMain as never);
  return handlers;
}

describe('graph-manager local handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const scope: GraphScope = { source: 'local', id: 'proj-1' };
  const evt = {};

  it('neighbors clamps limit to 200 and maps edgeType→edgeTypes', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NEIGHBORS)!;
    const res = await h(evt, scope, 'n1', { direction: 'out', edgeType: 'CALLS', limit: 999 });
    expect(repo.getNeighbors).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ direction: 'out', edgeTypes: ['CALLS'], limit: 200 }),
      ['h1', 'h2'],
    );
    expect(res).toEqual({ success: true, data: { nodes: [], edges: [], truncated: false } });
  });

  it('neighbors rejects an empty id', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NEIGHBORS)!;
    const res = await h(evt, scope, '  ', { direction: 'out', edgeType: 'CALLS' });
    expect(res.success).toBe(false);
    expect(repo.getNeighbors).not.toHaveBeenCalled();
  });

  it('subgraph clamps depth to 5 and passes nodeCap (not limit)', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_SUBGRAPH)!;
    await h(evt, scope, 'n1', { depth: 99, direction: 'both', edgeTypes: ['CALLS'], limit: 999 });
    expect(repo.getSubgraph).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ depth: 5, direction: 'both', edgeTypes: ['CALLS'], nodeCap: 200 }),
      ['h1', 'h2'],
    );
  });

  it('node returns { node, neighborCounts, detail }', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NODE)!;
    const res = (await h(evt, scope, 'n1')) as { success: boolean; data: { node: unknown; detail: unknown } };
    expect(res.success).toBe(true);
    expect(res.data.node).toEqual({ id: 'n1', type: 'function' });
    expect(res.data.detail).toMatchObject({ kind: 'function' });
  });

  it('search delegates to handleSearchSymbols and returns its data', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_SEARCH)!;
    const res = await h(evt, scope, 'foo', 5);
    expect(handleSearchSymbols).toHaveBeenCalledWith(
      { query: 'foo', limit: 5 },
      expect.objectContaining({ repoHashes: ['h1', 'h2'] }),
      'raw',
      'full',
      expect.anything(),
      repo,
    );
    expect(res).toEqual({ success: true, data: [{ id: 's1', name: 'foo' }] });
  });

  it('nodesByType clamps limit and narrows scopeRepo to its hash', async () => {
    // The local browse cap is deliberately above the cloud server's 200 so the
    // type chips can seed a useful slice — see NODES_MAX in graph-manager.
    const h = collectHandlers().get(IpcChannels.GRAPH_NODES_BY_TYPE)!;
    await h(evt, scope, { type: 'entity', scopeRepo: 'repo-b', limit: 99_999 });
    expect(repo.listNodesByType).toHaveBeenCalledWith('entity', expect.objectContaining({ limit: 1000 }), ['h2']);
  });

  it('nodesByType passes a below-cap limit through untouched', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NODES_BY_TYPE)!;
    await h(evt, scope, { type: 'entity', scopeRepo: 'repo-b', limit: 50 });
    expect(repo.listNodesByType).toHaveBeenCalledWith('entity', expect.objectContaining({ limit: 50 }), ['h2']);
  });

  it('nodesByType rejects an unknown scopeRepo', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NODES_BY_TYPE)!;
    const res = await h(evt, scope, { type: 'entity', scopeRepo: 'nope' });
    expect(res.success).toBe(false);
    expect(repo.listNodesByType).not.toHaveBeenCalled();
  });

  it('repos dedupes names', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_REPOS)!;
    const res = (await h(evt, scope)) as { success: boolean; data: { repos: { name: string }[] } };
    expect(res.data.repos).toEqual([{ name: 'repo-a' }, { name: 'repo-b' }]);
  });

  it('crossRepo sets focusRepoHashes from scopeRepo but keeps full scope hashes', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_CROSS_REPO)!;
    await h(evt, scope, { scopeRepo: 'repo-a', limit: 999 });
    expect(repo.getCrossRepoBridges).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, focusRepoHashes: ['h1'] }),
      ['h1', 'h2'],
    );
  });

  it('deadCode clamps limit and passes types', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_DEAD_CODE)!;
    await h(evt, scope, { types: ['function'], limit: 999 });
    expect(repo.findDeadNodes).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, types: ['function'] }), [
      'h1',
      'h2',
    ]);
  });

  it('capabilities reports cypher:false but edgesAmong:true when the backend has no Cypher', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_CAPABILITIES)!;
    expect(await h(evt, scope)).toEqual({ success: true, data: { cypher: false, edgesAmong: true } });
  });

  it('capabilities reports cypher:true when the repository implements runReadOnlyCypher', async () => {
    (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher = vi.fn();
    try {
      const h = collectHandlers().get(IpcChannels.GRAPH_CAPABILITIES)!;
      expect(await h(evt, scope)).toEqual({ success: true, data: { cypher: true, edgesAmong: true } });
    } finally {
      delete (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher;
    }
  });

  it('edgesAmong returns the induced subgraph for local', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_EDGES_AMONG)!;
    await h(evt, scope, ['n1', 'n2']);
    expect(repo.getEdgesAmong).toHaveBeenCalledWith(['n1', 'n2'], ['h1', 'h2'], expect.any(Number));
  });

  it('edgesAmong delegates cloud scopes to the REST client (never the local repository)', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_EDGES_AMONG)!;
    const res = await h(evt, { source: 'cloud', id: 'ws1' }, ['n1', 'n2']);
    expect(cloudGraph.edgesAmong).toHaveBeenCalledWith('ws1', ['n1', 'n2']);
    expect(res).toEqual({ success: true, data: { edges: [{ id: 'cloud-e1' }], truncated: false } });
    expect(repo.getEdgesAmong).not.toHaveBeenCalled();
  });

  it('cypher errors on a local backend without runReadOnlyCypher (sqlite)', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_CYPHER)!;
    const res = await h(evt, scope, 'MATCH (n) RETURN n');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Ladybug or Neo4j/i);
  });

  it('cypher runs runReadOnlyCypher and returns its graph result for a local Cypher backend', async () => {
    const result = { nodes: [{ id: 'n1' }], edges: [], truncated: false };
    const runReadOnlyCypher = vi.fn().mockResolvedValue(result);
    (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher = runReadOnlyCypher;
    try {
      const h = collectHandlers().get(IpcChannels.GRAPH_CYPHER)!;
      const res = await h(evt, scope, 'MATCH (n:GraphNode) RETURN n', 50);
      expect(runReadOnlyCypher).toHaveBeenCalledWith('MATCH (n:GraphNode) RETURN n', { limit: 50 });
      expect(res).toEqual({ success: true, data: result });
    } finally {
      delete (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher;
    }
  });

  it('cypher defaults the limit to 200 when omitted', async () => {
    const runReadOnlyCypher = vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false });
    (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher = runReadOnlyCypher;
    try {
      const h = collectHandlers().get(IpcChannels.GRAPH_CYPHER)!;
      await h(evt, scope, 'MATCH (n) RETURN n');
      expect(runReadOnlyCypher).toHaveBeenCalledWith('MATCH (n) RETURN n', { limit: 200 });
    } finally {
      delete (repo as { runReadOnlyCypher?: unknown }).runReadOnlyCypher;
    }
  });

  it('generateCypher passes text + the ladybug dialect (non-neo4j local backend)', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_GENERATE_CYPHER)!;
    const res = await h(evt, scope, 'functions per repo');
    expect(generateCypherFromNl).toHaveBeenCalledWith({ text: 'functions per repo', dialect: 'ladybug' });
    expect(res).toEqual({ success: true, data: { cypher: 'MATCH (n) RETURN n' } });
  });

  it('generateCypher passes the neo4j dialect on a neo4j backend', async () => {
    backend.value = 'neo4j';
    try {
      const h = collectHandlers().get(IpcChannels.GRAPH_GENERATE_CYPHER)!;
      await h(evt, scope, 'callers of push');
      expect(generateCypherFromNl).toHaveBeenCalledWith({ text: 'callers of push', dialect: 'neo4j' });
    } finally {
      backend.value = 'sqlite';
    }
  });

  it('generateCypher passes the ladybug dialect for cloud scopes', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_GENERATE_CYPHER)!;
    await h(evt, { source: 'cloud', id: 'ws-1' } as GraphScope, 'all entities');
    expect(generateCypherFromNl).toHaveBeenCalledWith({ text: 'all entities', dialect: 'ladybug' });
  });

  it('generateCypher rejects an empty question', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_GENERATE_CYPHER)!;
    const res = await h(evt, scope, '   ');
    expect(res.success).toBe(false);
    expect(generateCypherFromNl).not.toHaveBeenCalled();
  });

  it('cloud source delegates to the cloud-graph REST client', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_NODE)!;
    const res = await h(evt, { source: 'cloud', id: 'ws-1' } as GraphScope, 'n1');
    expect(cloudGraph.node).toHaveBeenCalledWith('ws-1', 'n1');
    expect(res).toEqual({ success: true, data: { node: { id: 'cloud-n1' } } });
    // Cloud dispatch must not touch the local SQLite path.
    expect(repo.getNodeWithProperties).not.toHaveBeenCalled();
  });

  it('cloud cypher delegates query + limit to the REST client', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_CYPHER)!;
    const res = await h(evt, { source: 'cloud', id: 'ws-1' } as GraphScope, 'MATCH (n) RETURN n', 10);
    expect(cloudGraph.cypher).toHaveBeenCalledWith('ws-1', 'MATCH (n) RETURN n', 10);
    expect(res.success).toBe(true);
  });
});

describe('graph-manager project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseOpens.length = 0;
  });
  const evt = {} as unknown;

  it('opens the database belonging to the scoped project', async () => {
    const h = collectHandlers().get(IpcChannels.GRAPH_REPOS)!;
    await h(evt, { source: 'local', id: 'proj-1' } as GraphScope);
    expect(databaseOpens).toEqual([
      { configDir: '/tmp/ws', projectId: 'proj-1', options: { mode: 'read', backend: 'sqlite' } },
    ]);
  });

  it('opens each scoped project separately', async () => {
    const handlers = collectHandlers();
    await handlers.get(IpcChannels.GRAPH_REPOS)!(evt, { source: 'local', id: 'proj-1' } as GraphScope);
    await handlers.get(IpcChannels.GRAPH_REPOS)!(evt, { source: 'local', id: 'proj-2' } as GraphScope);
    expect(databaseOpens.map(({ projectId }) => projectId)).toEqual(['proj-1', 'proj-2']);
  });

  it('leaves a Neo4j workspace on the singleton instead of opening a SQLite file', async () => {
    backend.value = 'neo4j';
    try {
      const h = collectHandlers().get(IpcChannels.GRAPH_REPOS)!;
      await h(evt, { source: 'local', id: 'proj-1' } as GraphScope);

      expect(databaseOpens).toEqual([]);
      expect(getRepositorySingleton).toHaveBeenCalled();
    } finally {
      backend.value = 'sqlite';
    }
  });
});
