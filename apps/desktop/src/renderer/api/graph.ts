import { queryOptions } from '@tanstack/react-query';
import type {
  NeighborPage,
  NodeDetail,
  VizNodePage,
  WorkspaceRepoRef,
  GraphCapabilities,
  GraphScope,
  GraphSearchHit,
  GraphOverview,
  VizEdge,
  CypherGraphResult,
} from '../../shared/ipc-types.js';

async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const res = await p;
  if (!res.success || res.data === undefined) throw new Error(res.error ?? 'Graph query failed');
  return res.data;
}

// Tier A search (parity wrapper over handleSearchSymbols). Seeds the explorer:
// results are a pick-list, clicking one adds it to the canvas.
export const graphSearchQueryOptions = (scope: GraphScope, q: string, limit = 25) =>
  queryOptions({
    queryKey: ['graph', scope.source, scope.id, 'search', q, limit] as const,
    queryFn: () => unwrap<GraphSearchHit[]>(window.electronAPI.graphSearch(scope, q, limit)),
    staleTime: 30_000,
    enabled: q.trim().length > 0,
  });

// Tier B focus node + its per-relation neighbor tallies (count-labeled chevrons).
export const graphNodeQueryOptions = (scope: GraphScope, nodeId: string) =>
  queryOptions({
    queryKey: ['graph', scope.source, scope.id, 'node', nodeId] as const,
    queryFn: () => unwrap<NodeDetail>(window.electronAPI.graphNode(scope, nodeId)),
    staleTime: 60_000,
  });

export interface NeighborsArgs {
  direction: 'in' | 'out';
  edgeType: string;
  limit?: number;
  cursor?: string;
}

// Tier B one-hop expansion for a specific (edgeType, direction) group.
export const graphNeighborsQueryOptions = (scope: GraphScope, nodeId: string, args: NeighborsArgs) =>
  queryOptions({
    queryKey: [
      'graph',
      scope.source,
      scope.id,
      'neighbors',
      nodeId,
      args.direction,
      args.edgeType,
      args.cursor ?? null,
    ] as const,
    queryFn: () => unwrap<NeighborPage>(window.electronAPI.graphNeighbors(scope, nodeId, args)),
    staleTime: 60_000,
  });

export interface SubgraphArgs {
  depth: number;
  direction?: 'in' | 'out' | 'both';
  edgeTypes?: string[];
  limit?: number;
}

// Tier B bounded depth-N traverse from a focus node (click-to-traverse). Reuses
// the NeighborPage shape (nodes + edges), but the subgraph is one server walk.
export const graphSubgraphQueryOptions = (scope: GraphScope, nodeId: string, args: SubgraphArgs) =>
  queryOptions({
    queryKey: [
      'graph',
      scope.source,
      scope.id,
      'subgraph',
      nodeId,
      args.depth,
      args.direction ?? 'both',
      (args.edgeTypes ?? []).join(','),
    ] as const,
    queryFn: () => unwrap<NeighborPage>(window.electronAPI.graphSubgraph(scope, nodeId, args)),
    staleTime: 60_000,
  });

// All workspace repos — feeds the always-on repo filter + the browse scope.
export const graphReposQueryOptions = (scope: GraphScope) =>
  queryOptions({
    queryKey: ['graph', scope.source, scope.id, 'repos'] as const,
    queryFn: () => unwrap<{ repos: WorkspaceRepoRef[] }>(window.electronAPI.graphRepos(scope)),
    staleTime: 60_000,
  });

// Repo identity + per-type node tallies — feeds the left panel's chip counts.
export const graphOverviewQueryOptions = (scope: GraphScope) =>
  queryOptions({
    queryKey: ['graph', scope.source, scope.id, 'overview'] as const,
    queryFn: () => unwrap<GraphOverview>(window.electronAPI.graphOverview(scope)),
    staleTime: 60_000,
  });

/**
 * Edges among an explicit node set. Imperative (not a query) because the input
 * is the live canvas — caching it by node-id list would be a cache entry per
 * distinct canvas.
 */
export async function fetchEdgesAmong(
  scope: GraphScope,
  nodeIds: string[],
): Promise<{ edges: VizEdge[]; truncated: boolean }> {
  return unwrap(window.electronAPI.graphEdgesAmong(scope, nodeIds));
}

/**
 * Turn a natural-language question into a read-only Cypher query. Imperative
 * (not a cached query) because it is a one-shot LLM generation the user triggers
 * from a button, mirroring `fetchEdgesAmong`: call the bridge, unwrap the
 * envelope so a generation failure throws rather than resolving to `undefined`.
 */
export async function fetchGenerateCypher(scope: GraphScope, text: string): Promise<{ cypher: string }> {
  return unwrap(window.electronAPI.graphGenerateCypher(scope, text));
}

/**
 * Execute a (possibly user-edited) read-only Cypher query and get back the
 * graph-shaped result the canvas renders. Imperative for the same reason as
 * `fetchEdgesAmong`: the query is live user input, not a cache key. The
 * read-only guard runs inside the main handler, so an unsafe or invalid query
 * surfaces here as a thrown error.
 */
export async function fetchCypher(scope: GraphScope, query: string, limit?: number): Promise<CypherGraphResult> {
  return unwrap(window.electronAPI.graphCypher(scope, query, limit));
}

export const graphCapabilitiesQueryOptions = (scope: GraphScope) =>
  queryOptions({
    queryKey: ['graph', scope.source, scope.id, 'capabilities'] as const,
    queryFn: () => unwrap<GraphCapabilities>(window.electronAPI.graphCapabilities(scope)),
    staleTime: Number.POSITIVE_INFINITY,
  });

export interface NodesByTypeArgs {
  type: string;
  scopeRepo?: string;
  limit?: number;
  cursor?: string;
}

// Browse: a page of all nodes of one type (optionally scoped to a repo).
// `limit` is part of the key: the caller sizes each page from a budget it splits
// across repos, so the same (type, repo) is legitimately asked for at different
// sizes, and a cached short page must not answer a request for a longer one.
export const graphNodesByTypeQueryOptions = (scope: GraphScope, args: NodesByTypeArgs) =>
  queryOptions({
    queryKey: [
      'graph',
      scope.source,
      scope.id,
      'nodes',
      args.type,
      args.scopeRepo ?? null,
      args.limit ?? null,
      args.cursor ?? null,
    ] as const,
    queryFn: () => unwrap<VizNodePage>(window.electronAPI.graphNodesByType(scope, args)),
    staleTime: 60_000,
  });
