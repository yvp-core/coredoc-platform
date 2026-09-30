/**
 * Graph Service
 *
 * Thin REST wrapper around the portable @coredoc/mcp handlers — the exact
 * same handlers the MCP tools invoke. Parity is the requirement: every method
 * here returns the handler's `data` unmodified, with `format: 'raw'` (the
 * MCP OutputFormat that yields structured JSON rather than markdown prose —
 * see packages/mcp/src/types.ts `OutputFormat = 'summary' | 'raw'`).
 *
 * Repository access is callback-scoped so immutable file handles remain leased
 * for the complete graph operation and never escape into controller state.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  IGraphCypherReadRepository,
  IGraphReadRepository,
  GetNeighborsParams,
  NeighborsResult,
  SubgraphParams,
  DeadCodeParams,
  CrossRepoBridgeParams,
  EdgesAmongResult,
} from '@coredoc/db';
import { getConfiguredBackend } from '@coredoc/db';
import { STORAGE_CONFIG, type StorageConfig, storageConfigFromEnv } from '../../config/app-config.js';
import { EdgeType, NodeType } from '@coredoc/core';
import type {
  NodeDetail,
  NeighborPage,
  EdgeDirection,
  VizNodePage,
  DeadCodePage,
  WorkspaceRepoRef,
  GraphCapabilities,
  CypherGraphResult,
} from '@coredoc/core';
import { projectNodeDetail } from './node-detail.js';
import type { ScopeContext } from '@coredoc/mcp';
import { resolveDetailLevel, SYMBOL_TYPES, ENTRYPOINT_TYPES } from '@coredoc/mcp';
import { handleSearchSymbols, handleListEntrypoints, handleListServiceDependencies } from '@coredoc/mcp/tools';

import {
  WorkspaceGraphContextError,
  WorkspaceMcpContextService,
  type WorkspaceContext,
} from '../../mcp/workspace-mcp-context.service.js';
import { WorkspaceFileCacheError } from '../../database/workspace-file-cache.service.js';
import { GraphBackend } from '../../database/graph-backend.js';
import { UnknownWorkspaceScopeError, resolveWorkspaceScope } from '../../mcp/workspace-scope-resolver.js';

// SYMBOL_TYPES / ENTRYPOINT_TYPES now come straight from @coredoc/mcp's public
// surface (packages/mcp/src/tool-schemas.ts) — single source of truth, no more
// hand-copied literal to keep in sync by inspection.
type SymbolType = (typeof SYMBOL_TYPES)[number];
type EntrypointProtocol = (typeof ENTRYPOINT_TYPES)[number];

// search_symbols (packages/mcp/src/tools/discovery/search-symbols.ts) has no
// upper bound of its own — `Math.floor(Number(args.limit)) || 20` — so the
// only requirement mirrored here is "positive integer, default 20". The MCP
// transport stays capless by design (a trusted agent caller); this REST
// surface is browser-reachable, so it adds its OWN cap below
// (SEARCH_REST_MAX_LIMIT) purely as a DoS boundary — a deliberate, documented
// divergence from the MCP handler, not a parity break (see §3.2 in
// docs/web-ui-plan-2026-07.md).
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_REST_MAX_LIMIT = 500;

// list_entrypoints (packages/mcp/src/tools/discovery/list-entrypoints.ts)
// clamps to `Math.min(..., 100)` with a default of 20 — copied verbatim.
const ENTRYPOINTS_DEFAULT_LIMIT = 20;
const ENTRYPOINTS_MAX_LIMIT = 100;

// Tier B explorer neighbor expansion. The hard cap (≤200 per §3.2) is the
// response-size boundary; one hop only (depth is fixed at 1 in the repository).
const NEIGHBORS_DEFAULT_LIMIT = 50;
const NEIGHBORS_MAX_LIMIT = 200;
const NEIGHBOR_DIRECTIONS: ReadonlySet<string> = new Set(['in', 'out', 'both']);
// Byte-identical to the stored EdgeType values — used to reject unknown
// `?edgeTypes=` filters at the browser boundary before they reach SQL/Cypher.
const VALID_EDGE_TYPES: ReadonlySet<string> = new Set(Object.values(EdgeType));
// Same for the browse-by-type `?type=` param (list all nodes of a NodeType).
const VALID_NODE_TYPES: ReadonlySet<string> = new Set(Object.values(NodeType));

// Browse-by-type page (Tier B) — same ≤200 response-size boundary as neighbors.
const NODES_DEFAULT_LIMIT = 50;
const NODES_MAX_LIMIT = 200;

// Depth-N subgraph traverse. `depth` is capped hard (a depth-5 walk over dense
// edges could otherwise explode); `nodeCap` is the same ≤200 response-size
// boundary as neighbors/browse. The default depth is a middle ground that shows
// meaningful reach without pulling a huge subgraph on the first click.
const SUBGRAPH_DEFAULT_DEPTH = 3;
const SUBGRAPH_MAX_DEPTH = 5;
const SUBGRAPH_MAX_NODES = 200;

// Dead-code scan page — same ≤200 response-size boundary.
const DEADCODE_DEFAULT_LIMIT = 50;
const DEADCODE_MAX_LIMIT = 200;

// Cross-repo bridge page — a "bridge" is one RESOLVES_TO link plus its
// caller/handler neighbours, so the ≤200 cap counts bridges, not raw nodes.
const CROSSREPO_DEFAULT_LIMIT = 50;
const CROSSREPO_MAX_LIMIT = 200;

// Induced subgraph over the explorer canvas's node set. The default EQUALS the
// max deliberately: the desktop sends no `limit`, and the effective cap must
// match the local handler's EDGES_AMONG_MAX (apps/desktop/src/main/graph-manager.ts)
// or a cloud canvas would truncate where the same canvas on a local project
// does not. A deliberate exception to the 100–500 caps of the sibling routes
// above, bounded by response size (~4000 edges ≈ high-hundreds KB).
const EDGES_AMONG_DEFAULT_LIMIT = 4000;
const EDGES_AMONG_MAX_LIMIT = 4000;
// Node-id cap = the canvas's own CANVAS_NODE_CAP
// (apps/desktop/src/renderer/features/explorer/explorer-graph.ts): a legitimate
// client can never exceed it, and it keeps the worst-case request body (~250
// chars per id) under the 1 MB default body limit (libs/body-limits.ts).
const EDGES_AMONG_MAX_NODE_IDS = 3000;

// Read-only Cypher power feature. The node/edge cap is the response-size
// boundary; the repository also enforces a statement timeout.
const CYPHER_DEFAULT_LIMIT = 200;
const CYPHER_MAX_LIMIT = 500;

/**
 * Deployment policy for arbitrary read-only Cypher, decided PER WORKSPACE
 * because tenancy — not the feature's existence — is what makes it safe:
 *  - `file_snapshot`: the workspace is served from its OWN immutable Ladybug
 *    file. A query cannot reach another tenant's data because no other tenant's
 *    data is in the file, and the repository enforces a read-only allowlist plus
 *    node/edge and timeout limits. Safe by construction → no operator opt-in.
 *  - a Neo4j-backed deployment: ONE graph holds every workspace, so arbitrary
 *    Cypher sees across tenants. That stays behind the explicit
 *    `COREDOC_ALLOW_CYPHER` operator opt-in (a single-tenant/self-hosted call).
 *  - `turso`: a relational store — Cypher is impossible, not merely disallowed.
 */
function cypherPolicyAllows(graphBackend: GraphBackend, allowCypher: boolean): boolean {
  if (graphBackend === GraphBackend.FileSnapshot) return true;
  if (getConfiguredBackend() === 'neo4j') return allowCypher;
  return false;
}

/** Policy + feature detection on the workspace's actually-leased repository. */
function cypherAvailable(graphBackend: GraphBackend, repository: IGraphReadRepository, allowCypher: boolean): boolean {
  return (
    cypherPolicyAllows(graphBackend, allowCypher) &&
    typeof cypherCapability(repository).runReadOnlyCypher === 'function'
  );
}

function cypherCapability(repository: IGraphReadRepository): Partial<IGraphCypherReadRepository> {
  return repository as Partial<IGraphCypherReadRepository>;
}

// REST never accepts a detailLevel param (parity is about the DATA shape;
// detail-level tiering is an MCP-agent-context concept with no REST use case
// yet — YAGNI), so 'full' is resolved once here and every REST read serves the
// complete projection. This deliberately DIVERGES from the MCP default: over
// there search_symbols and list_entrypoints are basic-by-default
// (getDefaultDetailLevel's BASIC_BY_DEFAULT_TOOLS set) because a list payload
// dominated the agent token budget — a constraint REST clients do not have.
const FULL_DETAIL_CONFIG = resolveDetailLevel('full');

export interface SearchSymbolsQuery {
  q?: string;
  types?: string;
  scopeRepo?: string;
  limit?: string;
}

export interface OverviewQuery {
  scopeRepo?: string;
}

export interface ServiceDependenciesQuery {
  scopeRepo?: string;
}

export interface EntrypointsQuery {
  scopeRepo?: string;
  protocol?: string;
  limit?: string;
}

export interface NeighborsQuery {
  direction?: string;
  edgeTypes?: string;
  limit?: string;
  cursor?: string;
}

export interface SubgraphQuery {
  direction?: string;
  edgeTypes?: string;
  depth?: string;
  limit?: string;
}

export interface DeadCodeQuery {
  types?: string;
  scopeRepo?: string;
  limit?: string;
  cursor?: string;
}

export interface CrossRepoQuery {
  scopeRepo?: string;
  limit?: string;
}

/** POST body of `graph/edges-among` — client-supplied, so every field is unknown. */
export interface EdgesAmongBody {
  nodeIds?: unknown;
  limit?: unknown;
}

/** Parse a `?limit=` string into a positive integer, or throw if invalid. */
function parsePositiveIntOrThrow(raw: string | undefined, paramName: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException(`Invalid ${paramName}: "${raw}" (must be a positive integer)`);
  }
  return parsed;
}

/**
 * Reject a duplicated query param. Express parses `?q=a&q=b` into `string[]`,
 * not `string` — every param read below must be guarded so a repeated key
 * 400s instead of reaching `.split`/`.trim` on an array and 500ing.
 */
function rejectDuplicateParam(raw: unknown, paramName: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new BadRequestException(`Invalid ${paramName}: expected a single value, got multiple`);
  }
  return raw;
}

type ScopedWorkspaceContext = Omit<WorkspaceContext, 'scope'> & { scope: ScopeContext };

@Injectable()
export class GraphService {
  constructor(
    private readonly wsContext: WorkspaceMcpContextService,
    @Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = storageConfigFromEnv(),
  ) {}

  /**
   * Resolve the workspace context and, when `scopeRepo` is given, narrow the
   * scope within the workspace exactly like BaseCoredocTool.buildToolContext
   * narrows on `args.scope` — same resolveWorkspaceScope call, same
   * unknown-repo hard-error semantics.
   *
   * Context availability failures carry stable codes and map to 404. Scope
   * validation is typed and maps to 400:
   *  - `resolveWorkspaceScope` (../../mcp/workspace-scope-resolver.js) throws
   *    `UnknownWorkspaceScopeError` for a
   *    scopeRepo/repo naming no workspace repo — a client mistake, not a
   *    server fault, and the "Available repos" hint is exactly what the
   *    caller needs to self-correct, so it must survive verbatim → 400.
   *  - `WorkspaceMcpContextService.withContextByWorkspaceId` reports a missing
   *    workspace, Turso database, active snapshot pointer, or pointed version
   *    as a typed not-found state → 404.
   *  - a cold file-snapshot cache miss that cannot reach/open the immutable
   *    object is a typed temporary availability failure → 503. Integrity and
   *    format failures remain faults and propagate unchanged.
   * Anything else falls through to the global exception filter's 500 path.
   */
  private async withScope<T>(
    workspaceId: string,
    scopeRepo: string | undefined,
    callback: (context: ScopedWorkspaceContext) => Promise<T> | T,
  ): Promise<T> {
    try {
      return await this.wsContext.withContextByWorkspaceId(workspaceId, async (context) => {
        let scope = context.scope;
        if (scopeRepo) scope = resolveWorkspaceScope(context.repos, scopeRepo);
        return callback({ ...context, scope });
      });
    } catch (err) {
      if (
        err instanceof WorkspaceGraphContextError &&
        ['WORKSPACE_NOT_FOUND', 'DATABASE_UNAVAILABLE', 'ACTIVE_VERSION_MISSING', 'VERSION_NOT_FOUND'].includes(
          err.code,
        )
      ) {
        throw new NotFoundException(err.message);
      }
      if (
        err instanceof WorkspaceFileCacheError &&
        ['NOT_FOUND', 'DOWNLOAD_TIMEOUT', 'CACHE_CAPACITY', 'OPEN_FAILED'].includes(err.code)
      ) {
        throw new ServiceUnavailableException(err.message);
      }
      if (err instanceof WorkspaceFileCacheError && err.code === 'UNSUPPORTED_FORMAT') {
        throw new ConflictException(err.message);
      }
      if (err instanceof UnknownWorkspaceScopeError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  // NOTE: this REST surface deliberately does NOT write mcp_query_metrics —
  // those metrics mean "an agent called an MCP tool" (recorded by
  // BaseCoredocTool.executeWithMetrics). Explorer/browser traffic polluting
  // that signal was a bug; REST traffic is intentionally unrecorded.

  async searchSymbols(workspaceId: string, query: SearchSymbolsQuery): Promise<unknown> {
    const q = rejectDuplicateParam(query.q, 'q');
    if (q === undefined || q.trim() === '') {
      throw new BadRequestException('q is required');
    }
    const typesRaw = rejectDuplicateParam(query.types, 'types');
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');

    let type: SymbolType | undefined;
    if (typesRaw !== undefined) {
      const parts = typesRaw.split(',').map((t) => t.trim());
      if (parts.length !== 1 || !SYMBOL_TYPES.includes(parts[0] as SymbolType)) {
        throw new BadRequestException(
          `Invalid types: "${typesRaw}" (expected exactly one of: ${SYMBOL_TYPES.join(', ')})`,
        );
      }
      type = parts[0] as SymbolType;
    }
    // Browser-reachable endpoint gets its own DoS-boundary cap
    // (SEARCH_REST_MAX_LIMIT); the MCP transport itself stays capless — see
    // the const's citation above and docs/web-ui-plan-2026-07.md §3.2.
    const limit = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', SEARCH_DEFAULT_LIMIT), SEARCH_REST_MAX_LIMIT);

    const args: Record<string, unknown> = { query: q, limit };
    if (type) args.type = type;

    return this.withScope(workspaceId, scopeRepoRaw, async ({ scope, repository }) => {
      const response = await handleSearchSymbols(args, scope, 'raw', 'full', FULL_DETAIL_CONFIG, repository);
      // NOTE: response.resultCount / any skip/pagination metadata is
      // deliberately dropped here — Tier A returns only `data`.
      return response.data;
    });
  }

  async overview(workspaceId: string, query: OverviewQuery): Promise<{ repos: unknown; coverage: unknown }> {
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    return this.withScope(workspaceId, scopeRepoRaw, async ({ scope, repository }) => {
      const [repos, coverage] = await Promise.all([
        repository.getRepoOverview(scope.repoHashes),
        repository.getCoverageCounts(scope.repoHashes),
      ]);
      return { repos, coverage };
    });
  }

  async serviceDependencies(workspaceId: string, query: ServiceDependenciesQuery): Promise<unknown> {
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    return this.withScope(workspaceId, scopeRepoRaw, async ({ scope, repository }) => {
      const response = await handleListServiceDependencies({}, scope, 'raw', undefined, undefined, repository);
      return response.data;
    });
  }

  async entrypoints(workspaceId: string, query: EntrypointsQuery): Promise<unknown> {
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    const protocolRaw = rejectDuplicateParam(query.protocol, 'protocol');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');

    let protocol: EntrypointProtocol | undefined;
    if (protocolRaw !== undefined && protocolRaw !== 'all') {
      // 'all' is the MCP schema's own explicit alias for "no filter" (zod
      // `.enum([...ENTRYPOINT_TYPES, 'all'])`) — map it to undefined rather
      // than rejecting it, since a B2 dropdown will send it as its "no
      // filter" option value.
      if (!ENTRYPOINT_TYPES.includes(protocolRaw as EntrypointProtocol)) {
        throw new BadRequestException(
          `Invalid protocol: "${protocolRaw}" (expected one of: ${ENTRYPOINT_TYPES.join(', ')}, all)`,
        );
      }
      protocol = protocolRaw as EntrypointProtocol;
    }
    const rawLimit = parsePositiveIntOrThrow(limitRaw, 'limit', ENTRYPOINTS_DEFAULT_LIMIT);
    const limit = Math.min(rawLimit, ENTRYPOINTS_MAX_LIMIT);

    const args: Record<string, unknown> = { limit };
    if (protocol) args.type = protocol;

    return this.withScope(workspaceId, scopeRepoRaw, async ({ scope, repository }) => {
      const response = await handleListEntrypoints(args, scope, 'raw', 'full', FULL_DETAIL_CONFIG, repository);
      return response.data;
    });
  }

  // -------------------------------------------------------------------------
  // Tier B — graph explorer (id-centric; no MCP handler equivalent)
  // -------------------------------------------------------------------------

  /**
   * A focus node + its per-relation neighbor tallies — the explorer fetches this
   * first to render count-labeled expand chevrons before any expansion. 404s
   * when the id names no node in the workspace. Workspace-wide (no `scopeRepo`):
   * the explorer's default vantage is the whole workspace graph (§3.2).
   */
  async nodeDetail(workspaceId: string, nodeId: string): Promise<NodeDetail> {
    if (!nodeId || nodeId.trim() === '') throw new BadRequestException('id is required');
    return this.withScope(workspaceId, undefined, async ({ scope, repository }) => {
      const [full, neighborCounts] = await Promise.all([
        repository.getNodeWithProperties(nodeId, scope.repoHashes),
        repository.getNeighborCounts(nodeId, scope.repoHashes),
      ]);
      if (!full) throw new NotFoundException(`Node not found: ${nodeId}`);
      return { node: full.node, neighborCounts, detail: projectNodeDetail(full.node.type, full.properties) };
    });
  }

  /**
   * One depth-1 neighbor expansion. Validates + clamps the browser-supplied
   * params (direction, edgeTypes, limit ≤ 200) before they reach the repository;
   * `cursor` is opaque and passed through for keyset pagination.
   */
  async neighbors(workspaceId: string, nodeId: string, query: NeighborsQuery): Promise<NeighborPage> {
    if (!nodeId || nodeId.trim() === '') throw new BadRequestException('id is required');

    const directionRaw = rejectDuplicateParam(query.direction, 'direction');
    const edgeTypesRaw = rejectDuplicateParam(query.edgeTypes, 'edgeTypes');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');
    const cursor = rejectDuplicateParam(query.cursor, 'cursor');

    let direction: EdgeDirection | 'both' = 'both';
    if (directionRaw !== undefined) {
      if (!NEIGHBOR_DIRECTIONS.has(directionRaw)) {
        throw new BadRequestException(`Invalid direction: "${directionRaw}" (expected one of: in, out, both)`);
      }
      direction = directionRaw as EdgeDirection | 'both';
    }

    let edgeTypes: EdgeType[] | undefined;
    if (edgeTypesRaw !== undefined && edgeTypesRaw.trim() !== '') {
      const parts = edgeTypesRaw.split(',').map((t) => t.trim());
      const invalid = parts.filter((p) => !VALID_EDGE_TYPES.has(p));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid edgeTypes: ${invalid.join(', ')}`);
      }
      edgeTypes = parts as EdgeType[];
    }

    const limit = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', NEIGHBORS_DEFAULT_LIMIT), NEIGHBORS_MAX_LIMIT);

    const params: GetNeighborsParams = { direction, limit };
    if (edgeTypes) params.edgeTypes = edgeTypes;
    if (cursor) params.cursor = cursor;
    return this.withScope(workspaceId, undefined, ({ scope, repository }) =>
      repository.getNeighbors(nodeId, params, scope.repoHashes),
    );
  }

  /**
   * All repositories in the workspace, for the explorer's always-on repo filter.
   * Workspace-wide (no scopeRepo) and lightweight — names only, sorted + deduped.
   */
  async listRepos(workspaceId: string): Promise<{ repos: WorkspaceRepoRef[] }> {
    return this.withScope(workspaceId, undefined, async ({ scope, repository }) => {
      const rows = await repository.getRepositoryNames(scope.repoHashes);
      const seen = new Set<string>();
      const repos: WorkspaceRepoRef[] = [];
      for (const r of rows) {
        if (r.name && !seen.has(r.name)) {
          seen.add(r.name);
          repos.push({ name: r.name });
        }
      }
      repos.sort((a, b) => a.name.localeCompare(b.name));
      return { repos };
    });
  }

  /**
   * A page of all nodes of one NodeType (optionally scoped to a repo),
   * keyset-paginated by node id — the "browse all entrypoints/entities of a
   * repo" flow. Validates the type + clamps the limit before the repository.
   */
  async nodesByType(
    workspaceId: string,
    query: { type?: string; scopeRepo?: string; limit?: string; cursor?: string },
  ): Promise<VizNodePage> {
    const typeRaw = rejectDuplicateParam(query.type, 'type');
    if (typeRaw === undefined || typeRaw.trim() === '') throw new BadRequestException('type is required');
    if (!VALID_NODE_TYPES.has(typeRaw)) throw new BadRequestException(`Invalid type: "${typeRaw}"`);
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');
    const cursor = rejectDuplicateParam(query.cursor, 'cursor');
    const limit = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', NODES_DEFAULT_LIMIT), NODES_MAX_LIMIT);
    const params: { limit: number; cursor?: string } = { limit };
    if (cursor) params.cursor = cursor;
    return this.withScope(workspaceId, scopeRepoRaw, ({ scope, repository }) =>
      repository.listNodesByType(typeRaw as NodeType, params, scope.repoHashes),
    );
  }

  /**
   * A bounded depth-N subgraph from a focus node — the click-to-traverse flow.
   * One server-side recursive walk instead of the client firing N depth-1
   * neighbor requests. Workspace-wide (no scopeRepo narrowing) so a walk that
   * follows the RESOLVES_TO bridge crosses repos; `depth` is capped hard and the
   * node set is bounded so a dense graph can't blow the response.
   */
  async subgraph(workspaceId: string, nodeId: string, query: SubgraphQuery): Promise<NeighborsResult> {
    if (!nodeId || nodeId.trim() === '') throw new BadRequestException('id is required');

    const directionRaw = rejectDuplicateParam(query.direction, 'direction');
    const edgeTypesRaw = rejectDuplicateParam(query.edgeTypes, 'edgeTypes');
    const depthRaw = rejectDuplicateParam(query.depth, 'depth');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');

    let direction: EdgeDirection | 'both' = 'both';
    if (directionRaw !== undefined) {
      if (!NEIGHBOR_DIRECTIONS.has(directionRaw)) {
        throw new BadRequestException(`Invalid direction: "${directionRaw}" (expected one of: in, out, both)`);
      }
      direction = directionRaw as EdgeDirection | 'both';
    }

    let edgeTypes: EdgeType[] | undefined;
    if (edgeTypesRaw !== undefined && edgeTypesRaw.trim() !== '') {
      const parts = edgeTypesRaw.split(',').map((t) => t.trim());
      const invalid = parts.filter((p) => !VALID_EDGE_TYPES.has(p));
      if (invalid.length > 0) throw new BadRequestException(`Invalid edgeTypes: ${invalid.join(', ')}`);
      edgeTypes = parts as EdgeType[];
    }

    const depth = Math.min(parsePositiveIntOrThrow(depthRaw, 'depth', SUBGRAPH_DEFAULT_DEPTH), SUBGRAPH_MAX_DEPTH);
    const nodeCap = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', SUBGRAPH_MAX_NODES), SUBGRAPH_MAX_NODES);

    const params: SubgraphParams = { depth, direction, nodeCap };
    if (edgeTypes) params.edgeTypes = edgeTypes;
    return this.withScope(workspaceId, undefined, ({ scope, repository }) =>
      repository.getSubgraph(nodeId, params, scope.repoHashes),
    );
  }

  /**
   * Candidate dead code — functions/classes with no inbound usage edge, roots
   * (entrypoint handlers, exported symbols) excluded. `lowCoverageRepos` in the
   * response flags repos whose call-graph extraction is thin, so the UI can mark
   * those results "suspect" rather than confirmed dead. Optionally scoped to one
   * repo via `scopeRepo`.
   */
  async deadCode(workspaceId: string, query: DeadCodeQuery): Promise<DeadCodePage> {
    const typesRaw = rejectDuplicateParam(query.types, 'types');
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');
    const cursor = rejectDuplicateParam(query.cursor, 'cursor');

    let types: NodeType[] | undefined;
    if (typesRaw !== undefined && typesRaw.trim() !== '') {
      const parts = typesRaw.split(',').map((t) => t.trim());
      const invalid = parts.filter((p) => !VALID_NODE_TYPES.has(p));
      if (invalid.length > 0) throw new BadRequestException(`Invalid types: ${invalid.join(', ')}`);
      types = parts as NodeType[];
    }

    const limit = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', DEADCODE_DEFAULT_LIMIT), DEADCODE_MAX_LIMIT);

    const params: DeadCodeParams = { limit };
    if (types) params.types = types;
    if (cursor) params.cursor = cursor;
    return this.withScope(workspaceId, scopeRepoRaw, ({ scope, repository }) =>
      repository.findDeadNodes(params, scope.repoHashes),
    );
  }

  /**
   * The cross-repo bridges in the workspace — each `caller → external_call →
   * entrypoint → handler` chain that crosses a repo boundary via a materialized
   * RESOLVES_TO edge — projected to viz nodes+edges. Resolved workspace-wide (the
   * whole point is to span repos); `scopeRepo`, when given, keeps only bridges
   * that touch that repo rather than narrowing the DB scope.
   */
  async crossRepo(workspaceId: string, query: CrossRepoQuery): Promise<NeighborsResult> {
    const scopeRepoRaw = rejectDuplicateParam(query.scopeRepo, 'scopeRepo');
    const limitRaw = rejectDuplicateParam(query.limit, 'limit');
    const limit = Math.min(parsePositiveIntOrThrow(limitRaw, 'limit', CROSSREPO_DEFAULT_LIMIT), CROSSREPO_MAX_LIMIT);

    const params: CrossRepoBridgeParams = { limit };
    return this.withScope(workspaceId, undefined, ({ scope, repository, repos }) => {
      if (scopeRepoRaw) {
        // Translate the repo name to hashes without narrowing the DB scope: a
        // bridge necessarily spans repositories.
        try {
          params.focusRepoHashes = resolveWorkspaceScope(repos, scopeRepoRaw).repoHashes;
        } catch (err) {
          if (err instanceof UnknownWorkspaceScopeError) {
            throw new BadRequestException(err.message);
          }
          throw err;
        }
      }
      return repository.getCrossRepoBridges(params, scope.repoHashes);
    });
  }

  /**
   * The induced subgraph over an explicit node set — every edge whose BOTH
   * endpoints are in `nodeIds`. The desktop explorer calls this after each
   * canvas change to link the nodes it already has; it never introduces a node
   * the caller did not send. Workspace-wide (no `scopeRepo`), like
   * `node`/`neighbors`/`subgraph`: the caller already named the exact nodes.
   */
  async edgesAmong(workspaceId: string, body: EdgesAmongBody): Promise<EdgesAmongResult> {
    const raw = body.nodeIds;
    if (!Array.isArray(raw)) {
      throw new BadRequestException('nodeIds is required and must be an array of node ids');
    }
    if (raw.length > EDGES_AMONG_MAX_NODE_IDS) {
      throw new BadRequestException(`nodeIds must hold at most ${EDGES_AMONG_MAX_NODE_IDS} ids`);
    }
    if (!raw.every((id): id is string => typeof id === 'string')) {
      throw new BadRequestException('nodeIds must contain only strings');
    }
    const nodeIds: string[] = raw;
    let limit = EDGES_AMONG_DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      const parsed = Number(body.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new BadRequestException('limit must be a positive integer');
      limit = Math.min(parsed, EDGES_AMONG_MAX_LIMIT);
    }
    // An empty canvas has no edges by definition — answer without leasing a
    // graph context (the repositories short-circuit the same way).
    if (nodeIds.length === 0) return { edges: [], truncated: false };

    return this.withScope(workspaceId, undefined, ({ scope, repository }) =>
      repository.getEdgesAmong(nodeIds, scope.repoHashes, limit),
    );
  }

  /**
   * What optional graph features THIS workspace supports (drives conditional
   * UI). Resolved per workspace, not per deployment: the workspace's own
   * backend decides whether Cypher is offered — see `cypherPolicyAllows`.
   */
  async capabilities(workspaceId: string): Promise<GraphCapabilities> {
    // `edgesAmong` is unconditional: `getEdgesAmong` is a required member of
    // IGraphReadRepository — the MissingGraphReadMethod exhaustiveness check in
    // ../../mcp/workspace-mcp-context.service.ts fails the build if a backend
    // omits it — so every resolvable backend can serve the route below. The
    // desktop explorer reads this to decide between auto-linking the canvas and
    // telling the user it cannot.
    return this.withScope(workspaceId, undefined, ({ repository, graphBackend }) => ({
      cypher: cypherAvailable(graphBackend, repository, this.storage.allowCypher),
      edgesAmong: true,
    }));
  }

  /**
   * Run a read-only Cypher query. 404s when this workspace's backend/policy
   * does not offer it or the leased repository can't run it; 400s on a
   * write/empty query (assertReadOnlyCypher, in the repository). Result is
   * node/edge-capped and runs under a statement timeout.
   */
  async runCypher(workspaceId: string, body: { query?: unknown; limit?: unknown }): Promise<CypherGraphResult> {
    const query = typeof body.query === 'string' ? body.query : '';
    if (query.trim() === '') throw new BadRequestException('query is required');
    let limit = CYPHER_DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      const parsed = Number(body.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new BadRequestException('limit must be a positive integer');
      limit = Math.min(parsed, CYPHER_MAX_LIMIT);
    }
    try {
      return await this.withScope(workspaceId, undefined, async ({ repository, graphBackend }) => {
        if (!cypherPolicyAllows(graphBackend, this.storage.allowCypher)) {
          throw new NotFoundException('Cypher querying is not enabled for this deployment');
        }
        const cypherRepository = cypherCapability(repository);
        if (typeof cypherRepository.runReadOnlyCypher !== 'function') {
          throw new NotFoundException('Cypher querying is not supported by this backend');
        }
        return cypherRepository.runReadOnlyCypher(query, { limit });
      });
    } catch (err) {
      // assertReadOnlyCypher throws a plain Error — surface as 400, not 500.
      if (err instanceof Error && /read-only|empty/i.test(err.message)) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
