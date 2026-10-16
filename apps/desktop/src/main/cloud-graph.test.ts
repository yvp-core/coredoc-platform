import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the auth primitive so server-api's apiRequest attaches a known Bearer
// token without pulling in electron / the real WorkOS flow. `fetch` is the
// transport we assert against (URL + method + Authorization header).
vi.mock('./auth-manager.js', () => ({
  getValidTokens: vi.fn().mockResolvedValue({ accessToken: 'tok123' }),
}));

import { cloudGraph } from './cloud-graph.js';

const fetchMock = vi.fn();

function jsonOk(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function httpError(status: number, body = 'boom'): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Extract the (url, init) the single fetch call was made with. */
function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

describe('cloudGraph — URL + param mapping vs the web graph factory', () => {
  it('neighbors issues an authenticated GET with id/direction/edgeTypes/limit', async () => {
    const page = { nodes: [], edges: [], truncated: false };
    fetchMock.mockResolvedValue(jsonOk(page));

    const res = await cloudGraph.neighbors('ws1', 'n1', { direction: 'out', edgeType: 'CALLS', limit: 50 });

    const { url, init } = lastCall();
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
    expect(url).toBe(
      'http://localhost:3000/api/v1/workspaces/ws1/graph/neighbors?id=n1&direction=out&edgeTypes=CALLS&limit=50',
    );
    expect(res).toEqual(page);
  });

  it('neighbors appends cursor when present and defaults limit to 50', async () => {
    fetchMock.mockResolvedValue(jsonOk({ nodes: [], edges: [], truncated: false }));
    await cloudGraph.neighbors('ws1', 'n1', { direction: 'in', edgeType: 'CALLS', cursor: 'c9' });
    expect(lastCall().url).toBe(
      'http://localhost:3000/api/v1/workspaces/ws1/graph/neighbors?id=n1&direction=in&edgeTypes=CALLS&limit=50&cursor=c9',
    );
  });

  it('node GETs /graph/node with an encoded id', async () => {
    fetchMock.mockResolvedValue(jsonOk({ node: { id: 'a/b' } }));
    await cloudGraph.node('ws1', 'a/b');
    expect(lastCall().url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/node?id=a%2Fb');
  });

  it('subgraph maps depth + joins edgeTypes with commas', async () => {
    fetchMock.mockResolvedValue(jsonOk({ nodes: [], edges: [], truncated: false }));
    await cloudGraph.subgraph('ws1', 'n1', {
      depth: 3,
      direction: 'both',
      edgeTypes: ['CALLS', 'IMPORTS'],
      limit: 100,
    });
    expect(lastCall().url).toBe(
      'http://localhost:3000/api/v1/workspaces/ws1/graph/subgraph?id=n1&depth=3&direction=both&edgeTypes=CALLS%2CIMPORTS&limit=100',
    );
  });

  it('search maps q + limit', async () => {
    fetchMock.mockResolvedValue(jsonOk([]));
    await cloudGraph.search('ws1', 'foo', 5);
    expect(lastCall().url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/search?q=foo&limit=5');
  });

  it('nodesByType maps type/scopeRepo/limit/cursor', async () => {
    fetchMock.mockResolvedValue(jsonOk({ nodes: [], truncated: false }));
    await cloudGraph.nodesByType('ws1', { type: 'entity', scopeRepo: 'repo-b', limit: 100, cursor: 'c1' });
    expect(lastCall().url).toBe(
      'http://localhost:3000/api/v1/workspaces/ws1/graph/nodes?type=entity&scopeRepo=repo-b&limit=100&cursor=c1',
    );
  });

  it('repos GETs /graph/repos with no query string', async () => {
    fetchMock.mockResolvedValue(jsonOk({ repos: [] }));
    await cloudGraph.repos('ws1');
    expect(lastCall().url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/repos');
  });

  it('capabilities GETs /graph/capabilities', async () => {
    fetchMock.mockResolvedValue(jsonOk({ cypher: true, edgesAmong: true }));
    const res = await cloudGraph.capabilities('ws1');
    expect(lastCall().url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/capabilities');
    expect(res).toEqual({ cypher: true, edgesAmong: true });
  });

  it('capabilities defaults a flag the server omits to false, not undefined', async () => {
    // A deployed server predating edgesAmong must read as "cannot", not as a
    // truthy-by-absence capability.
    fetchMock.mockResolvedValue(jsonOk({ cypher: true }));
    expect(await cloudGraph.capabilities('ws1')).toEqual({ cypher: true, edgesAmong: false });
  });

  it('edgesAmong POSTs the node ids in the body (ids embed / and : — never a query string)', async () => {
    const page = { edges: [], truncated: false };
    fetchMock.mockResolvedValue(jsonOk(page));

    const res = await cloudGraph.edgesAmong('ws1', ['h:function:src/a.ts:f', 'h:function:src/b.ts:g']);

    const { url, init } = lastCall();
    expect(init.method).toBe('POST');
    expect(url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/edges-among');
    expect(JSON.parse(init.body as string)).toEqual({
      nodeIds: ['h:function:src/a.ts:f', 'h:function:src/b.ts:g'],
    });
    expect(res).toEqual(page);
  });

  it('cypher POSTs the query (and limit) in the body', async () => {
    fetchMock.mockResolvedValue(jsonOk({ nodes: [], edges: [], truncated: false }));
    await cloudGraph.cypher('ws1', 'MATCH (n) RETURN n', 10);
    const { url, init } = lastCall();
    expect(url).toBe('http://localhost:3000/api/v1/workspaces/ws1/graph/cypher');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'MATCH (n) RETURN n', limit: 10 });
  });

  it('cypher omits limit from the body when not given', async () => {
    fetchMock.mockResolvedValue(jsonOk({ nodes: [], edges: [], truncated: false }));
    await cloudGraph.cypher('ws1', 'MATCH (n) RETURN n');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ query: 'MATCH (n) RETURN n' });
  });

  it('throws on an HTTP error response', async () => {
    fetchMock.mockResolvedValue(httpError(500, 'server exploded'));
    await expect(cloudGraph.node('ws1', 'n1')).rejects.toThrow(/500/);
  });
});
