/**
 * Visualization DTOs — the wire contract between the `modules/graph` REST layer
 * (Tier B explorer) and the `apps/web` frontend.
 *
 * Type-only by construction: every symbol here is an interface or a type alias,
 * so the whole module is erased at build. The server imports it to shape its
 * responses; the web app imports the same types (via `@coredoc/core`, a
 * type-only devDependency) so the two ends cannot drift. Nothing runtime-heavy
 * — no enums, no classes — enters the browser bundle.
 *
 * These are deliberately NARROWER than the storage shapes in `graph.ts`
 * (`GraphNode`/`GraphEdge`): the explorer never needs the raw `properties`
 * blob, the embedding vector, or source payloads, and the graph endpoints
 * exclude those columns at the SELECT level (a response-size and Turso-egress
 * guard — see docs/web-ui-plan-2026-07.md §3.2). What survives into a Viz*
 * DTO is exactly what a node/edge card renders.
 */

import type { EdgeType, GraphEdge, NodeType } from './graph.js';

/**
 * Edge provenance — reused verbatim from {@link GraphEdge.createdBy} so the two
 * cannot diverge. `parser` = a deterministic parser fact (confidence 1.0);
 * `ai` = an AI-inferred edge (confidence < 1.0); `human` = a manual override.
 */
export type EdgeProvenance = GraphEdge['createdBy'];

/** Direction of a neighbor relative to a focus node in the explorer. */
export type EdgeDirection = 'in' | 'out';

// =============================================================================
// Tier B — graph explorer (id-centric)
// =============================================================================

/**
 * A single graph node projected for visualization. Carries only what a node
 * card renders — never the `properties` blob, embedding, or source.
 */
export interface VizNode {
  /** Stable node ID ({repoHash}:{type}:{path}:{name}). */
  id: string;
  /** Node kind, as stored (`NodeType` enum value). Drives the card style + color legend. */
  type: NodeType;
  /** Human-readable symbol name. */
  name: string;
  /** Repository name this node belongs to (resolved from the repo-hash prefix). */
  repoName: string;
  /** Source file path, when the node has a location. */
  filePath?: string;
  /** Declaration line, when known. */
  startLine?: number;
  /** AI-generated one-line summary, when present. */
  summary?: string;
  /**
   * Short type-specific chip rendered on the card — e.g. an entrypoint's HTTP
   * method (`GET`), an external call's protocol (`kafka`), a function's `async`
   * marker. Purely presentational; absent when there is nothing to badge.
   */
  badge?: string;
}

/**
 * A single graph edge projected for visualization. Confidence + provenance are
 * first-class so the frontend can style edges (solid = parser 1.0, dashed =
 * AI-inferred, opacity ∝ confidence) and surface a provenance popover.
 */
export interface VizEdge {
  /** Stable edge ID. */
  id: string;
  /** Source node ID. */
  sourceId: string;
  /** Target node ID. */
  targetId: string;
  /** Edge kind, as stored (`EdgeType` enum value). */
  type: EdgeType;
  /** Confidence score (1.0 for parser facts, <1.0 for AI inferences). */
  confidence: number;
  /** Who created this edge. */
  createdBy: EdgeProvenance;
  /** Optional edge label (e.g. an OPERATES_ON operation, a call-site hint). */
  label?: string;
}

/**
 * A per-relation neighbor tally for a focus node — the counts the explorer
 * fetches BEFORE any expansion so it can render count-labeled expand chevrons
 * without pulling the neighbors themselves.
 */
export interface NeighborCount {
  /** The edge kind connecting the focus node to these neighbors. */
  edgeType: EdgeType;
  /** Whether the neighbors are on the incoming or outgoing side of the edge. */
  direction: EdgeDirection;
  /** How many neighbors sit behind this (edgeType, direction) group. */
  count: number;
}

/**
 * Response of `GET /graph/nodes/:nodeId` — the focus node plus its per-relation
 * neighbor tallies. No neighbors are materialized here; the frontend expands
 * one (edgeType, direction) group at a time via the neighbors endpoint.
 */
export interface NodeDetail {
  node: VizNode;
  neighborCounts: NeighborCount[];
  /**
   * Type-specific detail projected server-side from the node's stored
   * `properties` — what the explorer's detail drawer renders beyond the bare
   * VizNode. Absent when the node kind has nothing extra to show.
   */
  detail?: NodeDetailData;
}

// -----------------------------------------------------------------------------
// Type-specific node detail (drawer). Discriminated by `kind`; for the mapped
// kinds `kind` equals the node's NodeType value, else `'generic'`. Projected
// from `GraphNode.properties` (see packages/db/src/transformer.ts) so the wire
// stays a clean typed shape rather than the raw properties blob.
// -----------------------------------------------------------------------------

export interface EntrypointDetail {
  kind: 'entrypoint';
  /** http | graphql | grpc | cron | queue | event | cli | websocket */
  entrypointType?: string;
  method?: string;
  path?: string;
  fullPath?: string;
  schedule?: string;
  topic?: string;
  fieldName?: string;
  operationType?: string;
  purpose?: string;
  documentation?: string;
}

export interface FunctionDetail {
  kind: 'function';
  purpose?: string;
  businessLogic?: string;
  sideEffects?: string;
  isAsync?: boolean;
  visibility?: string;
  complexity?: number;
  documentation?: string;
}

/** A class field or interface member. */
export interface MemberDetail {
  name: string;
  /** 'property' | 'method' | 'index' for interface members; absent for class fields. */
  kind?: string;
  typeText?: string;
  returnTypeText?: string;
  isOptional?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  visibility?: string;
}

export interface ClassDetail {
  kind: 'class';
  extendsName?: string;
  implements?: string[];
  fields: MemberDetail[];
  constructorParams?: Array<{ name: string; typeText?: string }>;
  documentation?: string;
}

export interface InterfaceDetail {
  kind: 'interface';
  members: MemberDetail[];
  documentation?: string;
}

export interface EnumDetail {
  kind: 'enum';
  members: Array<{ name: string; value?: string | number }>;
  documentation?: string;
}

export interface EntityFieldDetail {
  name: string;
  columnName?: string;
  typeText?: string;
  dbType?: string;
  isPrimaryKey?: boolean;
  isNullable?: boolean;
  isUnique?: boolean;
}

export interface EntityDetail {
  kind: 'entity';
  ormType?: string;
  tableName?: string;
  schema?: string;
  fields: EntityFieldDetail[];
  relations: Array<{ name: string; type?: string; targetEntityName?: string }>;
  indexes?: Array<{ name?: string; columns: string[]; isUnique?: boolean }>;
  documentation?: string;
}

export interface ExternalCallDetail {
  kind: 'external_call';
  serviceName?: string;
  targetService?: string;
  method?: string;
  protocol?: string;
  httpMethod?: string;
  pathTemplate?: string;
  messagingSystem?: string;
  messagingDestination?: string;
  messagingDestinationRef?: string;
  ipcDirection?: string;
}

/** Fallback for kinds with no special projection (repository/package/file/route/…). */
export interface GenericDetail {
  kind: 'generic';
  documentation?: string;
}

export type NodeDetailData =
  | EntrypointDetail
  | FunctionDetail
  | ClassDetail
  | InterfaceDetail
  | EnumDetail
  | EntityDetail
  | ExternalCallDetail
  | GenericDetail;

/**
 * Response of `GET /graph/nodes?type=&scopeRepo=&cursor=` — a page of all nodes
 * of one NodeType (optionally scoped to a repo), keyset-paginated by node id.
 * Powers the explorer's "browse all entrypoints/entities of a repo" flow.
 */
export interface VizNodePage {
  nodes: VizNode[];
  nextCursor?: string;
  truncated: boolean;
}

/**
 * Response of `GET /graph/dead-code` — a page of candidate unreferenced nodes
 * (functions/classes with no inbound *usage* edge, entrypoint-handlers and
 * exported symbols excluded), keyset-paginated by node id like {@link VizNodePage}.
 *
 * `lowCoverageRepos` names repos whose call-graph extraction is sparse enough
 * that a missing inbound edge is more likely a profile gap than true death — the
 * explorer labels results from those repos "suspect" rather than confirmed dead,
 * so a thin profile never reads as a pile of dead code.
 */
export interface DeadCodePage {
  nodes: VizNode[];
  nextCursor?: string;
  truncated: boolean;
  lowCoverageRepos: string[];
}

/** One workspace repository, for the explorer's always-on repo filter. */
export interface WorkspaceRepoRef {
  name: string;
}

/** What optional graph features the backend supports (drives conditional UI). */
export interface GraphCapabilities {
  /** True only when the data plane is Neo4j AND the operator enabled Cypher. */
  cypher: boolean;
  /**
   * True when the backend can return every edge among an arbitrary set of
   * on-canvas nodes (`getEdgesAmong`). Drives the explorer's auto-linking: a
   * backend without it can only show isolated nodes after a browse-by-type
   * seed, so the UI says so rather than quietly drawing nothing.
   */
  edgesAmong: boolean;
}

/**
 * Result of a read-only Cypher query (`POST /graph/cypher`, Neo4j-only). Only
 * the graph-shaped part of the result is surfaced: CodeNode nodes and the
 * relationships among them, mapped to the explorer's Viz shapes. Scalar/tabular
 * projections that aren't nodes/relationships are dropped.
 */
export interface CypherGraphResult {
  nodes: VizNode[];
  edges: VizEdge[];
  /** True when the node/edge set was capped at the server limit. */
  truncated: boolean;
}

/**
 * Response of `GET /graph/nodes/:nodeId/neighbors` — one depth-1 expansion.
 * Deep traversal is repeated expansion, never one request (there is no depth
 * parameter by design). `nodes` includes the freshly reached neighbors;
 * `edges` are the edges connecting them to the focus node.
 */
export interface NeighborPage {
  nodes: VizNode[];
  edges: VizEdge[];
  /** Opaque cursor for the next page of this same expansion, when more remain. */
  nextCursor?: string;
  /** True when the neighbor set was capped (limit reached) — more exist. */
  truncated: boolean;
}
