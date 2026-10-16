/**
 * Cloud graph source — thin REST wrappers over the cloud
 * `/api/v1/workspaces/:wsId/graph/*` endpoints.
 *
 * One method per `graph:*` IPC handler. Each mirrors the URL + query-string
 * construction of the web graph factory (`apps/web/src/api/queries/graph.ts`)
 * VERBATIM so a desktop cloud request is byte-equivalent to what the web app
 * sends — with one deliberate exception: `edgesAmong` is desktop-only, because
 * the web explorer has no canvas auto-linking and a web method with no caller
 * would be dead code. Each issues its request through `server-api.apiRequest` —
 * the same authenticated fetch primitive the rest of the desktop cloud client
 * uses (base URL from `getConfiguredServerUrl()`, `Authorization: Bearer
 * <token>` from `getValidTokens()`, single 401-retry, throw on non-2xx).
 *
 * Methods return the raw typed JSON; the graph-manager handler wraps it in the
 * `{ success, data }` IPC envelope. On an HTTP error `apiRequest` throws, so a
 * failed cloud call surfaces as `{ success:false, error }` rather than silent
 * empty data.
 */

import type {
  VizEdge,
  NeighborPage,
  NodeDetail,
  VizNodePage,
  WorkspaceRepoRef,
  GraphCapabilities,
  CypherGraphResult,
} from '@coredoc/core';
import type { GraphOverview, GraphSearchHit } from '../shared/ipc-types.js';
import { apiRequest } from './server-api.js';

interface NeighborsArgs {
  direction: 'in' | 'out';
  edgeType: string;
  limit?: number;
  cursor?: string;
}

interface SubgraphArgs {
  depth: number;
  direction?: 'in' | 'out' | 'both';
  edgeTypes?: string[];
  limit?: number;
}

interface NodesByTypeArgs {
  type: string;
  scopeRepo?: string;
  limit?: number;
  cursor?: string;
}

const base = (wsId: string) => `/api/v1/workspaces/${wsId}/graph`;

/** Append a query string to a graph path only when there are params (matches web). */
function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export const cloudGraph = {
  // GET /graph/node?id=<enc>
  node: (wsId: string, nodeId: string): Promise<NodeDetail> =>
    apiRequest<NodeDetail>('GET', `${base(wsId)}/node?id=${encodeURIComponent(nodeId)}`),

  // GET /graph/neighbors?id&direction&edgeTypes&limit[&cursor]
  neighbors: (wsId: string, nodeId: string, args: NeighborsArgs): Promise<NeighborPage> => {
    const params = new URLSearchParams({
      id: nodeId,
      direction: args.direction,
      edgeTypes: args.edgeType,
      limit: String(args.limit ?? 50),
    });
    if (args.cursor) params.set('cursor', args.cursor);
    return apiRequest<NeighborPage>('GET', withQuery(`${base(wsId)}/neighbors`, params));
  },

  // GET /graph/subgraph?id&depth[&direction][&edgeTypes][&limit]
  subgraph: (wsId: string, nodeId: string, args: SubgraphArgs): Promise<NeighborPage> => {
    const params = new URLSearchParams({ id: nodeId, depth: String(args.depth) });
    if (args.direction) params.set('direction', args.direction);
    if (args.edgeTypes?.length) params.set('edgeTypes', args.edgeTypes.join(','));
    if (args.limit) params.set('limit', String(args.limit));
    return apiRequest<NeighborPage>('GET', withQuery(`${base(wsId)}/subgraph`, params));
  },

  // GET /graph/search?q&limit
  search: (wsId: string, q: string, limit = 25): Promise<GraphSearchHit[]> => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return apiRequest<GraphSearchHit[]>('GET', withQuery(`${base(wsId)}/search`, params));
  },

  // GET /graph/nodes?type[&scopeRepo][&limit][&cursor]
  nodesByType: (wsId: string, args: NodesByTypeArgs): Promise<VizNodePage> => {
    const params = new URLSearchParams({ type: args.type });
    if (args.scopeRepo) params.set('scopeRepo', args.scopeRepo);
    if (args.limit) params.set('limit', String(args.limit));
    if (args.cursor) params.set('cursor', args.cursor);
    return apiRequest<VizNodePage>('GET', withQuery(`${base(wsId)}/nodes`, params));
  },

  // GET /graph/repos
  repos: (wsId: string): Promise<{ repos: WorkspaceRepoRef[] }> =>
    apiRequest<{ repos: WorkspaceRepoRef[] }>('GET', `${base(wsId)}/repos`),

  /**
   * GET /graph/overview — returns `{ repos, coverage }`. The route has shipped
   * since before this client existed; only the wrapper was missing.
   *
   * The response shape is declared structurally here (as with NeighborsArgs et
   * al.) rather than importing RepoCoverageCounts from @coredoc/db, which has no
   * business in the desktop main process's HTTP client.
   */
  overview: async (wsId: string): Promise<GraphOverview> => {
    const res = await apiRequest<{
      repos?: Array<{ name: string; gitRemoteUrl?: string }>;
      coverage?: Array<{ repoName: string; nodeCountsByType?: Record<string, number> }>;
    }>('GET', `${base(wsId)}/overview`);

    // A server that predates the coverage half returns repos only — render
    // "unknown", never a fabricated zero.
    const countsByRepo = new Map((res.coverage ?? []).map((c) => [c.repoName, c.nodeCountsByType ?? {}]));
    return {
      repos: (res.repos ?? []).map((r) => ({
        name: r.name,
        countsByType: countsByRepo.get(r.name) ?? {},
        gitRemoteUrl: r.gitRemoteUrl,
      })),
    };
  },

  // GET /graph/capabilities
  capabilities: async (wsId: string): Promise<GraphCapabilities> => {
    const caps = await apiRequest<Partial<GraphCapabilities>>('GET', `${base(wsId)}/capabilities`);
    // A server predating a flag must read as "cannot", never as a capability
    // conjured out of `undefined`.
    return { cypher: caps.cypher ?? false, edgesAmong: caps.edgesAmong ?? false };
  },

  /**
   * POST /graph/edges-among — the induced subgraph over the canvas's node set.
   * The ids ride in the body: they embed `/` and `:` and a full canvas sends
   * thousands, so no query string would carry them. `limit` is deliberately
   * omitted — the server's default already equals the local EDGES_AMONG_MAX, so
   * cloud and local canvases truncate at the same point.
   *
   * The `{ edges, truncated }` shape is declared structurally (as with
   * NeighborsArgs et al.) rather than importing EdgesAmongResult from
   * @coredoc/db, which has no business in the main process's HTTP client.
   */
  edgesAmong: (wsId: string, nodeIds: string[]): Promise<{ edges: VizEdge[]; truncated: boolean }> =>
    apiRequest<{ edges: VizEdge[]; truncated: boolean }>('POST', `${base(wsId)}/edges-among`, { nodeIds }),

  // POST /graph/cypher — the query rides in the body
  cypher: (wsId: string, query: string, limit?: number): Promise<CypherGraphResult> =>
    apiRequest<CypherGraphResult>('POST', `${base(wsId)}/cypher`, limit ? { query, limit } : { query }),
};
