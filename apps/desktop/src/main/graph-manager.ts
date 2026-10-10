/**
 * Graph Manager - Main-process handlers for the local graph IPC surface.
 *
 * Resolves a project id to its local SQLite graph repository + repo-hash
 * scope (mirroring the MCP server's project-level scope resolution) and
 * registers the 10 `graph:*` IPC handlers. Each handler reproduces the cloud
 * REST graph.service's validation + clamping + result assembly, minus the
 * NestJS exception wrapping — it throws a plain `Error` and the envelope maps
 * it to `{ success:false, error }`.
 *
 * Dispatch is by `scope.source`: `'local'` hits the SQLite repository directly;
 * `'cloud'` delegates to `cloudGraph` (thin REST wrappers over the cloud
 * `/graph/*` endpoints — see `cloud-graph.ts`).
 */

import type { IpcMain } from 'electron';
import * as path from 'node:path';
import { getConfiguredBackend, getRepository, openProjectDatabase } from '@coredoc/db';
import type { IGraphRepository, GetNeighborsParams, SubgraphParams } from '@coredoc/db';
import { resolveScope, resolveDetailLevel, handleSearchSymbols } from '@coredoc/mcp';
import type { ScopeContext } from '@coredoc/mcp';
import type { EdgeType, EdgeDirection, NodeType } from '@coredoc/core';
import { IpcChannels } from '../shared/ipc-types.js';
import type { GraphScope } from '../shared/ipc-types.js';
import { getCurrentConfigPath } from './config-manager.js';
import { projectNodeDetail } from './graph-node-detail.js';
import { cloudGraph } from './cloud-graph.js';
import { generateCypherFromNl, type CypherNlDialect } from './graph-cypher-nl.js';

/** Read-only Cypher page cap for the local runReadOnlyCypher path. */
const CYPHER_DEFAULT_LIMIT = 200;

/**
 * The active local graph dialect for prompt/query composition: the Neo4j
 * server backend speaks Neo4j Cypher, every file backend (Ladybug) speaks the
 * Ladybug/Kùzu shape. Cloud is always Ladybug (hosted file_snapshot).
 */
function localDialect(): CypherNlDialect {
  return getConfiguredBackend() === 'neo4j' ? 'neo4j' : 'ladybug';
}

// Response-size boundaries. These were byte-identical to the cloud
// graph.service caps so local and cloud responses stayed bounded the same way
// (docs §3.2) — NODES_MAX is now the one deliberate exception, see below.
const NEIGHBORS_MAX = 200;
const SUBGRAPH_NODE_CAP = 200;

/**
 * Cap for browse-by-type, which the redesigned left panel's type chips drive.
 *
 * Raised from 200 so a chip labelled "Function 12,908" seeds something worth
 * looking at. Two caveats, both deliberate:
 *
 *  1. **This is local-only.** `apps/server`'s NODES_MAX_LIMIT is still 200, so a
 *     cloud-scoped seed is clamped server-side regardless of this value. Raising
 *     the cloud side is a deployed-service change with version-skew consequences
 *     and is not bundled into a desktop redesign.
 *  2. **The binding constraint is canvas paint, not this number.** The explorer
 *     paints nodes, edges and their captions on a 2D canvas (Cytoscape, see
 *     explorer-canvas.tsx). JS-side ingest is flat to 4k
 *     nodes (~2.6ms), so the ceiling is paint/layout — measure that on real
 *     hardware with a real graph before moving this again. The UI shows
 *     "showing N of TOTAL" so the boundary is never silent.
 */
const NODES_MAX = 1000;

/** Edge ceiling for one induced-subgraph fill. Truncation is surfaced in the UI. */
const EDGES_AMONG_MAX = 4000;

// search_symbols' detail projection. The MCP handler + cloud graph.service both
// run it at detailLevel 'full'; resolveDetailLevel('full') is the config object
// that produces the same field set (FULL_DETAIL_CONFIG is server-local, not an
// @coredoc/mcp export — so it is computed here the same way graph.service does).
const FULL_DETAIL_CONFIG = resolveDetailLevel('full');
const SEARCH_DEFAULT_LIMIT = 25;

/** Clamp a page limit to [1, max]; undefined → max (server default). */
export function clampLimit(n: number | undefined, max: number): number {
  if (n === undefined) return max;
  return Math.max(1, Math.min(n, max));
}

/** Clamp a subgraph depth to [1, 5] (server cap). */
export function clampDepth(n: number): number {
  return Math.max(1, Math.min(n, 5));
}

/**
 * Resolve the local SQLite graph repository + the project's repo-hash scope.
 *
 * Mirrors the MCP server's `resolveScope('project:<id>', ...)` project-level
 * resolution: the scope is every repo in the project's pushed graph. Passes
 * the desktop's already-loaded config path explicitly (`getCurrentConfigPath`)
 * rather than relying on `resolveScope`'s `process.cwd()`-based config search,
 * since the Electron main process's cwd is not the workspace root.
 *
 * Returns the full {@link ScopeContext} alongside `repoHashes` because
 * `handleSearchSymbols` needs the whole scope object, and `scopeRepo` narrowing
 * needs the parallel `resolvedRepos ↔ repoHashes` mapping it carries.
 */
async function resolveLocalScope(
  projectId: string,
): Promise<{ repository: IGraphRepository; repoHashes: string[]; scope: ScopeContext }> {
  const configPath = getCurrentConfigPath();
  if (!configPath) throw new Error('No local workspace config available');

  const resolved = resolveScope(`project:${projectId}`, { configPath });
  if (!resolved.success) {
    throw new Error(resolved.error ?? `Failed to resolve scope for project "${projectId}"`);
  }

  // File backends (sqlite AND ladybug) live in per-project files under the
  // workspace config dir — only the server-based neo4j backend goes through
  // the global env-configured repository. Routing ladybug into getRepository()
  // opened a default-path (empty) database and the explorer showed nothing.
  const backend = getConfiguredBackend();
  const repository =
    backend === 'neo4j'
      ? await getRepository()
      : (await openProjectDatabase(path.dirname(configPath), projectId, { mode: 'read', backend })).graph;
  const graphRepos = await repository.getRepositoryNames(resolved.scope.repoHashes);
  if (graphRepos.length === 0) {
    throw new Error(
      `No graph data for project "${projectId}". Run \`coredoc push --config "${configPath}" --project ${projectId}\`.`,
    );
  }
  return { repository, repoHashes: resolved.scope.repoHashes, scope: resolved.scope };
}

/**
 * Narrow a `scopeRepo` (a repo NAME from the explorer's repo filter) to that
 * repo's hash(es) within the already-resolved scope — the local equivalent of
 * the cloud graph.service's `resolveWorkspaceScope(repos, scopeRepo)`. Matches
 * by name against the scope's parallel `resolvedRepos ↔ repoHashes` arrays and
 * throws the same "Unknown scope" shape on a repo outside the scope, so an
 * unknown filter fails fast instead of silently widening to the whole project.
 */
function narrowToScopeRepo(scope: ScopeContext, scopeRepo: string): string[] {
  const idx = scope.resolvedRepos.indexOf(scopeRepo);
  if (idx === -1) {
    throw new Error(`Unknown scope "${scopeRepo}". Available repos: ${scope.resolvedRepos.join(', ')}`);
  }
  return [scope.repoHashes[idx]!];
}

/** Wrap a handler body in the shared `{ success, data|error }` IPC envelope. */
async function ok<T>(fn: () => Promise<T>): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    return { success: true as const, data: await fn() };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerGraphHandlers(ipcMain: IpcMain): void {
  // -- node: focus node + neighbor tallies + typed detail projection ----------
  ipcMain.handle(IpcChannels.GRAPH_NODE, (_e, scope: GraphScope, nodeId: string) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.node(scope.id, nodeId);
      if (!nodeId?.trim()) throw new Error('id is required');
      const { repository, repoHashes } = await resolveLocalScope(scope.id);
      const [full, neighborCounts] = await Promise.all([
        repository.getNodeWithProperties(nodeId, repoHashes),
        repository.getNeighborCounts(nodeId, repoHashes),
      ]);
      if (!full) throw new Error(`Node not found: ${nodeId}`);
      return { node: full.node, neighborCounts, detail: projectNodeDetail(full.node.type, full.properties) };
    }),
  );

  // -- neighbors: one depth-1 expansion ---------------------------------------
  ipcMain.handle(
    IpcChannels.GRAPH_NEIGHBORS,
    (
      _e,
      scope: GraphScope,
      nodeId: string,
      args: { direction: 'in' | 'out'; edgeType: string; limit?: number; cursor?: string },
    ) =>
      ok(async () => {
        if (scope.source === 'cloud') return cloudGraph.neighbors(scope.id, nodeId, args);
        if (!nodeId?.trim()) throw new Error('id is required');
        const { repository, repoHashes } = await resolveLocalScope(scope.id);
        const params: GetNeighborsParams = {
          direction: args.direction as EdgeDirection | 'both',
          limit: clampLimit(args.limit, NEIGHBORS_MAX),
        };
        if (args.edgeType) params.edgeTypes = [args.edgeType as EdgeType];
        if (args.cursor) params.cursor = args.cursor;
        return repository.getNeighbors(nodeId, params, repoHashes);
      }),
  );

  // -- subgraph: bounded depth-N walk -----------------------------------------
  ipcMain.handle(
    IpcChannels.GRAPH_SUBGRAPH,
    (
      _e,
      scope: GraphScope,
      nodeId: string,
      args: { depth: number; direction?: 'in' | 'out' | 'both'; edgeTypes?: string[]; limit?: number },
    ) =>
      ok(async () => {
        if (scope.source === 'cloud') return cloudGraph.subgraph(scope.id, nodeId, args);
        if (!nodeId?.trim()) throw new Error('id is required');
        const { repository, repoHashes } = await resolveLocalScope(scope.id);
        const params: SubgraphParams = {
          depth: clampDepth(args.depth),
          direction: (args.direction ?? 'both') as EdgeDirection | 'both',
          nodeCap: clampLimit(args.limit, SUBGRAPH_NODE_CAP),
        };
        if (args.edgeTypes?.length) params.edgeTypes = args.edgeTypes as EdgeType[];
        return repository.getSubgraph(nodeId, params, repoHashes);
      }),
  );

  // -- search: parity wrapper over the MCP search_symbols handler -------------
  ipcMain.handle(IpcChannels.GRAPH_SEARCH, (_e, scope: GraphScope, q: string, limit?: number) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.search(scope.id, q, limit);
      if (!q?.trim()) throw new Error('query is required');
      const { repository, scope: scopeCtx } = await resolveLocalScope(scope.id);
      const response = await handleSearchSymbols(
        { query: q, limit: limit ?? SEARCH_DEFAULT_LIMIT },
        scopeCtx,
        'raw',
        'full',
        FULL_DETAIL_CONFIG,
        repository,
      );
      return response.data;
    }),
  );

  // -- nodesByType: page of all nodes of one NodeType (optionally per-repo) ----
  ipcMain.handle(
    IpcChannels.GRAPH_NODES_BY_TYPE,
    (_e, scope: GraphScope, args: { type: string; scopeRepo?: string; limit?: number; cursor?: string }) =>
      ok(async () => {
        if (scope.source === 'cloud') return cloudGraph.nodesByType(scope.id, args);
        if (!args.type?.trim()) throw new Error('type is required');
        const { repository, repoHashes, scope: scopeCtx } = await resolveLocalScope(scope.id);
        const hashes = args.scopeRepo ? narrowToScopeRepo(scopeCtx, args.scopeRepo) : repoHashes;
        const params: { limit: number; cursor?: string } = { limit: clampLimit(args.limit, NODES_MAX) };
        if (args.cursor) params.cursor = args.cursor;
        return repository.listNodesByType(args.type as NodeType, params, hashes);
      }),
  );

  // -- repos: all repo names in scope, deduped --------------------------------
  ipcMain.handle(IpcChannels.GRAPH_REPOS, (_e, scope: GraphScope) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.repos(scope.id);
      const { repository, repoHashes } = await resolveLocalScope(scope.id);
      const rows = await repository.getRepositoryNames(repoHashes);
      const seen = new Set<string>();
      const repos: { name: string }[] = [];
      for (const r of rows) {
        if (r.name && !seen.has(r.name)) {
          seen.add(r.name);
          repos.push({ name: r.name });
        }
      }
      repos.sort((a, b) => a.name.localeCompare(b.name));
      return { repos };
    }),
  );

  // -- overview: repo identity + per-type node tallies ------------------------
  // Separate channel from GRAPH_REPOS on purpose: different cloud endpoint,
  // different lifecycle (repos change on add, counts on every push), and a
  // different cost — getCoverageCounts is a full GROUP BY over nodes, while
  // GRAPH_REPOS runs on every explorer mount and has to stay cheap.
  ipcMain.handle(IpcChannels.GRAPH_OVERVIEW, (_e, scope: GraphScope) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.overview(scope.id);
      const { repository, repoHashes } = await resolveLocalScope(scope.id);
      const [overview, coverage] = await Promise.all([
        repository.getRepoOverview(repoHashes),
        repository.getCoverageCounts(repoHashes),
      ]);

      // Join by name, but never drop a repo that only one side knows about —
      // a missing tally must read as "unknown", not as zero nodes.
      const countsByRepo = new Map(coverage.map((c) => [c.repoName, c.nodeCountsByType]));
      const remoteByRepo = new Map(overview.map((r) => [r.name, r.gitRemoteUrl]));
      const names = [...new Set([...remoteByRepo.keys(), ...countsByRepo.keys()])].sort();

      return {
        repos: names.map((name) => ({
          name,
          countsByType: countsByRepo.get(name) ?? {},
          gitRemoteUrl: remoteByRepo.get(name),
        })),
      };
    }),
  );

  // -- edgesAmong: the induced subgraph over the canvas's node set ------------
  // Turns a browse-by-type seed into an actual graph. Never introduces a node
  // the caller did not already have.
  // The cloud route takes no `limit`: its server-side default already equals
  // EDGES_AMONG_MAX below, so both sources truncate at the same edge count.
  ipcMain.handle(IpcChannels.GRAPH_EDGES_AMONG, (_e, scope: GraphScope, nodeIds: string[]) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.edgesAmong(scope.id, nodeIds);
      const { repository, repoHashes } = await resolveLocalScope(scope.id);
      return repository.getEdgesAmong(nodeIds, repoHashes, EDGES_AMONG_MAX);
    }),
  );

  // -- capabilities: Cypher is available only on a Cypher-capable backend -----
  ipcMain.handle(IpcChannels.GRAPH_CAPABILITIES, (_e, scope: GraphScope) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.capabilities(scope.id);
      // Ladybug/Neo4j implement runReadOnlyCypher; SQLite does not. edgesAmong
      // always links the canvas locally regardless of Cypher support.
      const { repository } = await resolveLocalScope(scope.id);
      return { cypher: typeof repository.runReadOnlyCypher === 'function', edgesAmong: true };
    }),
  );

  // -- cypher: read-only query on a Ladybug/Neo4j graph (sqlite has none) -----
  ipcMain.handle(IpcChannels.GRAPH_CYPHER, (_e, scope: GraphScope, query: string, limit?: number) =>
    ok(async () => {
      if (scope.source === 'cloud') return cloudGraph.cypher(scope.id, query, limit);
      const { repository } = await resolveLocalScope(scope.id);
      if (typeof repository.runReadOnlyCypher !== 'function') {
        throw new Error('Cypher needs a Ladybug or Neo4j graph — this project is on SQLite.');
      }
      return repository.runReadOnlyCypher(query, { limit: limit ?? CYPHER_DEFAULT_LIMIT });
    }),
  );

  // -- generateCypher: NL → Cypher via a one-shot harness turn ----------------
  ipcMain.handle(IpcChannels.GRAPH_GENERATE_CYPHER, (_e, scope: GraphScope, text: string) =>
    ok(async () => {
      if (!text?.trim()) throw new Error('Enter a question to generate a Cypher query.');
      const dialect: CypherNlDialect = scope.source === 'cloud' ? 'ladybug' : localDialect();
      return generateCypherFromNl({ text, dialect });
    }),
  );
}
