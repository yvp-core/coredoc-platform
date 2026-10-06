/**
 * Neo4j Graph Repository Implementation
 *
 * Implements IGraphRepository for Neo4j backend.
 * Uses Cypher queries for all graph operations.
 */

import { toInt, type Neo4jDriver } from './driver.js';
// NodeType/EdgeType are enums (runtime values) — used as values in
// normalizeNodeType's map and the Tier B edge-label mapping.
import { NodeType, EdgeType } from '../types.js';
import { analysisFrom, callResolutionFrom, dbOpResolutionFrom } from '../coverage-record.js';
import { entrypointAddressMatches, staticRouteAnchor } from '../route-path.js';
import { buildVizEdge, buildVizNode, pageSlice } from '../viz-map.js';
import {
  SUBGRAPH_FLOW_EDGE_TYPES,
  DEAD_CODE_DEFAULT_TYPES,
  clampLimit,
  BRIDGE_LIMIT,
  DEAD_NODE_LIMIT,
  EDGES_AMONG_LIMIT,
  ENTRYPOINT_LIST_LIMIT,
  NEIGHBOR_LIMIT,
  NODE_PAGE_LIMIT,
  SUBGRAPH_NODE_CAP,
  SYMBOL_SEARCH_LIMIT,
  deadCodeUsageEdges,
  lowCoverageRepoNames,
} from '../graph-query-defaults.js';
import { type ExternalCallRow, externalCallInfoFromRow } from '../external-call-row.js';
import {
  ENTRYPOINT_ADDRESS_PROPERTY_KEYS,
  type CallerRow,
  type EntrypointHandler,
  type NodeRow,
  callerInfoFromRow,
  codeElementFromRow,
  entityInfoFromRow,
  entrypointInfoFromRow,
  functionInfoFromRow,
  namedDeclarationFromRow,
} from '../node-row.js';
import type {
  IGraphRepository,
  GraphNode,
  GraphEdge,
  CodeElement,
  FunctionInfo,
  ClassInfo,
  InterfaceInfo,
  EnumInfo,
  TypeAliasInfo,
  EntrypointInfo,
  EntityInfo,
  CallerInfo,
  CallTreeNode,
  EntityConsumer,
  TypeUsage,
  TypeUsageKind,
  TypeUseKind,
  RepoOverview,
  RepoSummary,
  RepoNameRow,
  EdgesAmongResult,
  RepoCoverageCounts,
  PathStep,
  FindCodeParams,
  ListEntrypointsParams,
  ExternalCallInfo,
  MessagingExternalCall,
  PackageInfo,
  PackageLinkerFacts,
  PackageLinkerFileInfo,
  PackageLinkerImportInfo,
  PackageLinkerDeclarationKind,
  ResolvesEdgeInfo,
  EmbeddedNode,
  GetNeighborsParams,
  NeighborsResult,
  SubgraphParams,
  DeadCodeParams,
  CrossRepoBridgeParams,
  PackageDependencyRollup,
  ComponentGraphData,
  ComponentGraphNode,
  ComponentGraphEdge,
  ApplyChangesetOptions,
  AppliedGraphSnapshot,
  GraphApplyReceipt,
  NodeMetadataUpdate,
  UnresolvedCallRecord,
} from '../types.js';
import type { DbOperationType } from '@coredoc/core/types';
import type {
  ResolvedHop,
  HopVia,
  VizNode,
  VizEdge,
  NeighborCount,
  EdgeDirection,
  VizNodePage,
  DeadCodePage,
  CypherGraphResult,
} from '@coredoc/core';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { assertReadOnlyCypherAllowlisted, assertQueryDoesNotProjectSource } from '../cypher-guard.js';
import type { CypherScalar, CypherRowsResult } from '../types.js';
import { parseAppliedGraphSnapshot } from '../graph-snapshot.js';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Neo4j rejects maps and arrays-of-maps as node property values. Flatten the
 * transformer-emitted `properties` object so anything that isn't a scalar or a
 * homogeneous array of scalars becomes a JSON string. Reads back via
 * `JSON.parse(node.<key>)` in callers that need the nested shape; non-Cypher
 * consumers (SqliteRepository, MCP tools) read GraphNode.properties directly
 * and are unaffected.
 */
function flattenForNeo4j(props: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      // Arrays of primitives (string[], number[], …) are allowed; arrays
      // containing any object/array element must be JSON-encoded whole.
      const hasComplex = v.some((el) => typeof el === 'object' && el !== null);
      out[k] = hasComplex ? JSON.stringify(v) : v;
      continue;
    }
    if (typeof v === 'object') {
      out[k] = JSON.stringify(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Build WHERE clause for repo hash filtering.
 * Inlined here to avoid a cross-package dependency (the shared
 * cypher-templates module it came from has since been removed).
 */
function buildRepoFilter(nodeAlias: string, hashes: string[], isRepoNode: boolean = false): string {
  if (hashes.length === 0) return 'true';
  if (hashes.length === 1) {
    return `${nodeAlias}.id STARTS WITH '${hashes[0]}${isRepoNode ? '' : ':'}'`;
  }
  const prefixes = hashes.map((h) => `'${h}${isRepoNode ? '' : ':'}'`).join(', ');
  return `ANY(prefix IN [${prefixes}] WHERE ${nodeAlias}.id STARTS WITH prefix)`;
}

/**
 * Read back a node property that `flattenForNeo4j` JSON-encoded (arrays of
 * objects). Returns the parsed array, or undefined when the property is absent
 * (e.g. `indexes`, which most ORM paths never populate).
 */
/**
 * Identity columns of a returned node, with Neo4j `Integer` line numbers coerced
 * at this row boundary so the shared mappers in `node-row.ts` see plain numbers.
 * The node itself doubles as the property bag (Neo4j stores properties flat).
 */
function nodeRow(node: Record<string, unknown>): NodeRow {
  return {
    id: node.id as string,
    name: node.name as string,
    filePath: node.filePath as string,
    startLine: toNumber(node.startLine),
    endLine: toNumber(node.endLine),
    summary: node.summary as string | null | undefined,
  };
}

function parseJsonArrayProp(value: unknown): unknown[] | undefined {
  // An array of objects is stored as a JSON string by flattenForNeo4j, but an
  // *empty* array has no complex elements and is stored natively — accept real
  // arrays directly so `[]` round-trips as `[]` (matching the SQLite whole-blob
  // path) instead of collapsing to undefined.
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map an Entity node (with its flattened properties) to EntityInfo. The schema
 * arrays were JSON-stringified by `flattenForNeo4j` on write, so they are parsed
 * back here — the mirror of the SqliteRepository which reads them from the raw
 * properties blob.
 */
function entityInfoFromNode(node: Record<string, unknown>): EntityInfo {
  // `fields`/`relations`/`indexes` were JSON-stringified by flattenForNeo4j on write.
  return entityInfoFromRow(nodeRow(node), {
    ...node,
    fields: parseJsonArrayProp(node.fields),
    relations: parseJsonArrayProp(node.relations),
    indexes: parseJsonArrayProp(node.indexes),
  });
}

/**
 * Convert Neo4j Integer to number.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value) || 0;
}

/** Default rows per applyChangeset statement (each committed on its own). */
const DEFAULT_APPLY_BATCH_SIZE = 5000;

/** Rows per applyChangeset statement; `COREDOC_NEO4J_APPLY_BATCH_SIZE` overrides the default. */
function applyBatchSize(): number {
  const configured = Number(process.env.COREDOC_NEO4J_APPLY_BATCH_SIZE);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_APPLY_BATCH_SIZE;
}

/** Whether an edge id is the transformer's `source:TYPE:target` form, which names one endpoint pair. */
function isEndpointDerivedEdgeId(edge: Pick<GraphEdge, 'id' | 'sourceId' | 'targetId' | 'type'>): boolean {
  return edge.id === `${edge.sourceId}:${edge.type}:${edge.targetId}`;
}

/**
 * The ONE EntrypointInfo projection for this backend: both entrypoint reads (the
 * `listEntrypoints` scan and `getReachingEntrypoints`) go through it, so a stored address
 * property — `className`/`trigger` and whatever a future entrypoint kind adds — is read
 * back in one place instead of being copy-pasted per query. Mirrors the SQLite backend's
 * `entrypointInfoFromRow` and the Ladybug backend's `entrypointInfo`.
 */
function entrypointInfoFromNode(ep: Record<string, unknown>, handler: EntrypointHandler = {}): EntrypointInfo {
  return entrypointInfoFromRow(
    {
      id: ep.id as string,
      filePath: ep.filePath as string,
      startLine: toNumber(ep.startLine),
      endLine: toNumber(ep.endLine),
    },
    ep,
    handler,
  );
}

/**
 * Normalize a single Cypher cell to the scalar wire contract (`CypherScalar`).
 * Safe integers (JS number, BigInt within MAX_SAFE_INTEGER, in-range Neo4j
 * Integer) become `number`; unsafe integers become a decimal string; anything
 * composite (map/list/node/relationship/temporal/spatial) is rejected with
 * projection guidance — no recursive normalization.
 */
function normalizeCypherScalar(value: unknown): CypherScalar {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'boolean') return value as boolean;
  if (t === 'number') return value as number;
  if (t === 'bigint') {
    const b = value as bigint;
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString();
  }
  if (t === 'object') {
    const obj = value as { inSafeRange?: () => boolean; toNumber?: () => number; toString?: () => string };
    // Neo4j Integer — has inSafeRange()/toNumber()/toString().
    if (typeof obj.inSafeRange === 'function' && typeof obj.toNumber === 'function') {
      return obj.inSafeRange() ? obj.toNumber() : String(obj);
    }
  }
  throw new Error(
    'Cypher rows shape supports scalar cells only; project scalar fields (e.g. RETURN n.name) or use resultShape "graph"',
  );
}

/**
 * Coerce a traversal depth into a safe, non-negative integer. Cypher cannot
 * bind variable-length path bounds (`*1..$depth` is a syntax error), so the
 * value is interpolated into the query string — this guards against `NaN`
 * (which yields the invalid pattern `*1..NaN`) and any non-integer input.
 */
function intDepth(value: number, fallback = 0): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Convert Neo4j node type to lowercase NodeType.
 */
function normalizeNodeType(label: string): NodeType {
  const map: Record<string, NodeType> = {
    Repository: NodeType.Repository,
    Package: NodeType.Package,
    File: NodeType.File,
    Function: NodeType.Function,
    Class: NodeType.Class,
    Interface: NodeType.Interface,
    Entrypoint: NodeType.Entrypoint,
    Entity: NodeType.Entity,
    Component: NodeType.Component,
    TypeAlias: NodeType.TypeAlias,
    Enum: NodeType.Enum,
    Variable: NodeType.Variable,
    ExternalCall: NodeType.ExternalCall,
    Route: NodeType.Route,
    StateStore: NodeType.StateStore,
  };
  return map[label] || NodeType.Function;
}

/**
 * Map NodeType to Neo4j label.
 */
const NODE_TYPE_TO_LABEL: Record<string, string> = {
  repository: 'Repository',
  package: 'Package',
  file: 'File',
  function: 'Function',
  class: 'Class',
  interface: 'Interface',
  entrypoint: 'Entrypoint',
  entity: 'Entity',
  component: 'Component',
  route: 'Route',
  state_store: 'StateStore',
  type_alias: 'TypeAlias',
  enum: 'Enum',
  variable: 'Variable',
  external_call: 'ExternalCall',
};

/**
 * Labels carrying package-export declarations, paired with the NodeType the
 * linker facts report. Ordered like the SQLite projection's `n.type` ordering
 * so the two backends emit the same rows in the same shape.
 */
const PACKAGE_LINKER_DECLARATION_LABELS: ReadonlyArray<[string, PackageLinkerDeclarationKind]> = [
  ['Class', 'class'],
  ['Interface', 'interface'],
  ['TypeAlias', 'type_alias'],
  ['Enum', 'enum'],
  ['Function', 'function'],
  ['Variable', 'variable'],
];

// -----------------------------------------------------------------------------
// Tier B (graph explorer) helpers
// -----------------------------------------------------------------------------

/**
 * Scope filter for a NEIGHBOR node in the explorer. Uses the no-colon id prefix
 * (`STARTS WITH 'hash'`) so it admits BOTH normal nodes (`hash:type:…`) and the
 * repository node itself (`id` === `hash`) — the latter matters for containment
 * neighbors. Empty hashes = no filter (`true`), matching the "empty = all"
 * cross-repo convention. Mirror of the SQLite `buildNeighborRepoFilter`.
 */
function buildNeighborRepoFilterCypher(alias: string, hashes: string[]): string {
  if (hashes.length === 0) return 'true';
  if (hashes.length === 1) return `${alias}.id STARTS WITH '${hashes[0]}'`;
  const prefixes = hashes.map((h) => `'${h}'`).join(', ');
  return `ANY(prefix IN [${prefixes}] WHERE ${alias}.id STARTS WITH prefix)`;
}

/**
 * VizNode RETURN projection — excludes `embedding` and large blobs (parity with
 * the SQLite column pruning / Turso-egress guard). The type label is read as the
 * one non-`CodeNode` label; `repoName` comes from a joined Repository node.
 * `n` = node alias, `rp` = repository-join alias.
 */
function vizNodeReturnCols(n: string, rp: string): string {
  return `${n}.id AS id, [l IN labels(${n}) WHERE l <> 'CodeNode'][0] AS typeLabel, ${n}.name AS name,
       ${rp}.name AS repoName, ${n}.filePath AS filePath, ${n}.startLine AS startLine, ${n}.summary AS summary,
       ${n}.method AS pMethod, ${n}.entrypointType AS pEntrypointType, ${n}.protocol AS pProtocol`;
}

/** Neo4j RETURN row for {@link vizNodeReturnCols}. */
interface Neo4jVizRow {
  id: string;
  typeLabel: string;
  name: string;
  repoName: string | null;
  filePath: string | null;
  startLine: unknown;
  summary: string | null;
  pMethod: unknown;
  pEntrypointType: unknown;
  pProtocol: unknown;
}

/**
 * The identity half of a flattened caller node, coerced at the Neo4j row boundary
 * (`Integer` → `number`) before {@link callerInfoFromRow} projects it. The node itself
 * doubles as the property bag — Neo4j stores properties flat on the node.
 */
function neoCallerRow(node: Record<string, unknown>): CallerRow {
  return {
    id: node.id as string,
    name: node.name as string,
    filePath: node.filePath as string,
    startLine: toNumber(node.startLine),
    endLine: toNumber(node.endLine),
    summary: node.summary as string | null | undefined,
  };
}

function neoVizNode(row: Neo4jVizRow): VizNode {
  return buildVizNode({
    id: row.id,
    type: normalizeNodeType(row.typeLabel),
    name: row.name,
    repoName: row.repoName,
    filePath: (row.filePath as string | null) ?? null,
    startLine: row.startLine != null ? toNumber(row.startLine) : null,
    summary: row.summary,
    pMethod: row.pMethod,
    pEntrypointType: row.pEntrypointType,
    pProtocol: row.pProtocol,
  });
}

// -----------------------------------------------------------------------------
// Read-only Cypher graph extraction (runReadOnlyCypher, Neo4j-only). Neo4j
// returns real Node/Relationship/Path objects; we duck-type them (the raw
// neo4j-driver classes are not re-exported here) and pull out only the graph
// shape (CodeNodes + the relationships among the returned nodes).
// -----------------------------------------------------------------------------

const CYPHER_TIMEOUT_MS = 5000;

interface NeoGraphNodeLike {
  identity: unknown;
  labels: string[];
  properties: Record<string, unknown>;
}
interface NeoGraphRelLike {
  identity: unknown;
  type: string;
  start: unknown;
  end: unknown;
  properties: Record<string, unknown>;
}

function isNeoGraphNode(v: unknown): v is NeoGraphNodeLike {
  const o = v as { labels?: unknown; properties?: unknown } | null;
  return !!o && typeof o === 'object' && Array.isArray(o.labels) && !!o.properties && typeof o.properties === 'object';
}
function isNeoGraphRel(v: unknown): v is NeoGraphRelLike {
  const o = v as { type?: unknown; start?: unknown; end?: unknown; properties?: unknown } | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.type === 'string' &&
    'start' in o &&
    'end' in o &&
    !!o.properties &&
    typeof o.properties === 'object'
  );
}

/** Walk a Cypher return value, yielding any nodes/relationships nested in lists or paths. */
function* graphElements(value: unknown): Generator<NeoGraphNodeLike | NeoGraphRelLike> {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) yield* graphElements(v);
    return;
  }
  const seg = (value as { segments?: unknown }).segments;
  if (Array.isArray(seg)) {
    for (const s of seg as Array<{ start?: unknown; relationship?: unknown; end?: unknown }>) {
      yield* graphElements(s.start);
      yield* graphElements(s.relationship);
      yield* graphElements(s.end);
    }
    return;
  }
  if (isNeoGraphRel(value)) {
    yield value;
  } else if (isNeoGraphNode(value)) {
    yield value;
  }
}

function neoCypherNodeToViz(node: NeoGraphNodeLike): VizNode | null {
  const props = node.properties ?? {};
  const rawId = props.id;
  if (typeof rawId !== 'string' || rawId === '') return null; // non-CodeNode (no string id)
  const typeLabel = node.labels.find((l) => l !== 'CodeNode') ?? 'Function';
  return buildVizNode({
    id: rawId,
    type: normalizeNodeType(typeLabel),
    name: typeof props.name === 'string' ? props.name : rawId,
    repoName: null, // no Repository join available for arbitrary Cypher
    filePath: typeof props.filePath === 'string' ? props.filePath : null,
    startLine: props.startLine != null ? toNumber(props.startLine) : null,
    summary: typeof props.summary === 'string' ? props.summary : null,
    pMethod: props.method,
    pEntrypointType: props.entrypointType,
    pProtocol: props.protocol,
  });
}

/**
 * Normalize a raw Neo4j property map (from `properties(n)`) into the same nested
 * shape SQLite's JSON blob yields: JSON-string values (how Neo4j stores arrays
 * of objects — see the `hasComplex` serialization in this module) are parsed
 * back, neo4j Integers are collapsed to numbers, and `embedding` is dropped.
 */
function normalizeNeoProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(props)) {
    if (k === 'embedding') continue;
    let v = raw;
    if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
      v = (v as { toNumber: () => number }).toNumber();
    } else if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try {
        v = JSON.parse(v);
      } catch {
        /* leave as the original string */
      }
    }
    out[k] = v;
  }
  return out;
}

// =============================================================================
// Neo4j Repository Implementation
// =============================================================================

export class Neo4jRepository implements IGraphRepository {
  constructor(private driver: Neo4jDriver) {}

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async findCode(params: FindCodeParams, repoHashes: string[]): Promise<CodeElement[]> {
    const { pattern, types, includeSource } = params;
    // An explicit `limit: 0` is a misconfiguration, not "unlimited": it clamps to
    // the default here, same as sqlite/ladybug.
    const limit = clampLimit(params.limit ?? 50, SYMBOL_SEARCH_LIMIT.max, SYMBOL_SEARCH_LIMIT.fallback);
    const repoFilter = buildRepoFilter('n', repoHashes);

    // Build type filter. Use NODE_TYPE_TO_LABEL — the same map pushNodes uses —
    // so that requesting `type_alias` matches the `:TypeAlias` label that was
    // written (not the `:Typealias` mis-cased ad-hoc CamelCase would produce).
    let typeFilter = 'true';
    if (types && types.length > 0) {
      const labels = types.map((t) => `n:${NODE_TYPE_TO_LABEL[t] ?? t}`);
      typeFilter = `(${labels.join(' OR ')})`;
    } else {
      typeFilter = '(n:Function OR n:Class OR n:Interface OR n:Entrypoint OR n:Entity)';
    }

    // Convert glob to regex. `(?i)` makes the match case-insensitive to mirror
    // SQLite's `LIKE` (ASCII-case-insensitive by default) — without it, Neo4j's
    // `=~` under-reports mixed-case queries (search_symbols parity). Other regex
    // metacharacters are literal, as in `LIKE`: C# lookups pass globs like `*.Foo(*`.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = `(?i)${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}`;
    // Project source only when requested (it's a flattened node property).
    const sourceReturn = includeSource ? ',\n             n.sourceCode as sourceCode' : '';

    const query = `
      MATCH (n)
      WHERE ${repoFilter}
        AND ${typeFilter}
        AND n.name =~ $pattern
      RETURN n.id as id,
             n.name as name,
             labels(n)[0] as type,
             n.filePath as filePath,
             n.startLine as startLine,
             n.endLine as endLine,
             n.summary as summary,
             n.purpose as purpose${sourceReturn}
      ORDER BY n.name
      LIMIT $limit
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        type: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        purpose?: string | null;
        sourceCode?: string | null;
      }>(query, { pattern: regex, limit: toInt(limit) });
    });

    return results.map((row) =>
      codeElementFromRow({
        ...row,
        type: normalizeNodeType(row.type),
        startLine: toNumber(row.startLine),
        endLine: toNumber(row.endLine),
      }),
    );
  }

  async listSymbolsInFile(filePath: string, repoHashes: string[]): Promise<CodeElement[]> {
    if (repoHashes.length === 0) {
      return [];
    }

    // Match the file by its exact stored path OR by trailing segment, so a
    // caller can pass either the full repo-relative path or just the
    // distinctive tail (`templates.service.ts`).
    const repoFilter = buildRepoFilter('n', repoHashes);
    const query = `
      MATCH (n)
      WHERE ${repoFilter}
        AND (n.filePath = $filePath OR n.filePath ENDS WITH $suffix)
      RETURN n.id as id,
             n.name as name,
             labels(n)[0] as type,
             n.filePath as filePath,
             n.startLine as startLine,
             n.endLine as endLine,
             n.summary as summary
      ORDER BY n.startLine, n.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        type: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
      }>(query, { filePath, suffix: `/${filePath}` });
    });

    return results.map((row) =>
      codeElementFromRow({
        ...row,
        type: normalizeNodeType(row.type),
        startLine: toNumber(row.startLine),
        endLine: toNumber(row.endLine),
      }),
    );
  }

  async findFunction(
    name: string,
    repoHashes: string[],
    fileHint?: string,
    className?: string,
  ): Promise<FunctionInfo | null> {
    const repoFilter = buildRepoFilter('f', repoHashes);

    // Filter the function in the MATCH's own WHERE — BEFORE the OPTIONAL MATCH.
    // A WHERE placed directly after OPTIONAL MATCH is scoped to that optional
    // pattern (it only decides whether `c` binds) and does NOT filter `f`, so
    // `f.name = $name` would be silently ignored and the query would return the
    // first :Function by filePath regardless of name. The owning class is then
    // pulled in optionally to surface className; when a "Class.method" input
    // gave us a className we must require it, but the requiring WHERE needs a
    // `WITH` barrier to break the optional scope (same footgun otherwise).
    const query = `
      MATCH (f:Function)
      WHERE ${repoFilter}
        AND f.name = $name
        ${fileHint ? 'AND f.filePath CONTAINS $fileHint' : ''}
      OPTIONAL MATCH (c:Class { id: f.classId })
      ${className ? 'WITH f, c\n      WHERE c.name = $className' : ''}
      RETURN f, c.name AS className
      ORDER BY f.filePath
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ f: Record<string, unknown>; className: string | null }>(query, {
        name,
        fileHint: fileHint || '',
        className: className || '',
      });
    });

    if (results.length === 0) return null;

    const node = results[0]!.f;
    return functionInfoFromRow(nodeRow(node), node, results[0]!.className ?? undefined);
  }

  async findClass(name: string, repoHashes: string[]): Promise<ClassInfo | null> {
    const repoFilter = buildRepoFilter('c', repoHashes);

    const query = `
      MATCH (c:Class)
      WHERE ${repoFilter}
        AND c.name = $name
      RETURN c
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ c: Record<string, unknown> }>(query, { name });
    });

    if (results.length === 0) return null;

    const node = results[0]!.c;
    // `properties_` was JSON-stringified by flattenForNeo4j on write.
    return namedDeclarationFromRow('class', nodeRow(node), {
      ...node,
      properties_: parseJsonArrayProp(node.properties_),
    });
  }

  async findInterface(name: string, repoHashes: string[]): Promise<InterfaceInfo | null> {
    const repoFilter = buildRepoFilter('i', repoHashes);

    const query = `
      MATCH (i:Interface)
      WHERE ${repoFilter}
        AND i.name = $name
      RETURN i
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ i: Record<string, unknown> }>(query, { name });
    });

    if (results.length === 0) return null;

    const node = results[0]!.i;
    return namedDeclarationFromRow('interface', nodeRow(node), {
      ...node,
      members: parseJsonArrayProp(node.members),
    });
  }

  async findEnum(name: string, repoHashes: string[]): Promise<EnumInfo | null> {
    const repoFilter = buildRepoFilter('e', repoHashes);
    const query = `
      MATCH (e:Enum)
      WHERE ${repoFilter}
        AND e.name = $name
      RETURN e
      LIMIT 1
    `;
    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ e: Record<string, unknown> }>(query, { name });
    });
    if (results.length === 0) return null;

    const node = results[0]!.e;
    return namedDeclarationFromRow('enum', nodeRow(node), {
      ...node,
      members: parseJsonArrayProp(node.members),
    });
  }

  async findTypeAlias(name: string, repoHashes: string[]): Promise<TypeAliasInfo | null> {
    const repoFilter = buildRepoFilter('t', repoHashes);
    const query = `
      MATCH (t:TypeAlias)
      WHERE ${repoFilter}
        AND t.name = $name
      RETURN t
      LIMIT 1
    `;
    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ t: Record<string, unknown> }>(query, { name });
    });
    if (results.length === 0) return null;

    const node = results[0]!.t;
    return namedDeclarationFromRow('type_alias', nodeRow(node), node);
  }

  async findEntity(name: string, repoHashes: string[]): Promise<EntityInfo | null> {
    const repoFilter = buildRepoFilter('e', repoHashes);

    const query = `
      MATCH (e:Entity)
      WHERE ${repoFilter}
        AND (e.name = $name OR e.tableName = $name)
      RETURN e
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ e: Record<string, unknown> }>(query, { name });
    });

    if (results.length === 0) return null;

    return entityInfoFromNode(results[0]!.e);
  }

  async listEntities(repoHashes: string[]): Promise<EntityInfo[]> {
    const repoFilter = buildRepoFilter('e', repoHashes);

    const query = `
      MATCH (e:Entity)
      WHERE ${repoFilter}
      RETURN e
      ORDER BY e.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ e: Record<string, unknown> }>(query, {});
    });

    return results.map((r) => entityInfoFromNode(r.e));
  }

  async listEntrypoints(params: ListEntrypointsParams, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const { type, pathPattern, system, id } = params;
    // Clamped once here so both the Cypher LIMIT and the post-refinement slice
    // below carry the same bound (sqlite clamps the same value at its slice).
    // An explicit `limit: 0` is a misconfiguration, not "unlimited": it clamps to
    // the default here, same as sqlite/ladybug.
    const limit =
      params.limit !== undefined
        ? clampLimit(params.limit, ENTRYPOINT_LIST_LIMIT.max, ENTRYPOINT_LIST_LIMIT.fallback)
        : undefined;
    const normalizedSystem = system?.trim().toLowerCase();
    const repoFilter = buildRepoFilter('ep', repoHashes);

    // Entrypoint type is stored on the `entrypointType` property (see
    // transformEntrypoint), not `type`.
    const typeFilter = type ? `ep.entrypointType = $type` : 'true';
    // Parameter-agnostic path matching: DB-prefilter on the longest literal
    // segment (placeholder-independent), refine in JS with `entrypointAddressMatches`
    // so {id}/:id/<id>/[id] all match. No literal anchor (all-parameter path) →
    // skip the DB path filter and let the JS pass scan the scope. CONTAINS is
    // case-sensitive in Cypher, hence toLower on both sides.
    const pathAnchor = pathPattern ? staticRouteAnchor(pathPattern) : undefined;
    // Prefilter over EVERY address property, not just fullPath: a queue/cron/CLI
    // entrypoint has no path, and anchoring on fullPath alone dropped those rows
    // before the JS refinement could look at destination/topic/schedule.
    //
    // These are the STORED property names written by `transformEntrypoint`, which
    // are NOT the `EntrypointAddress` field names the JS refinement uses: the API
    // `destination`/`destinationValue` are derived below from the stored
    // `messagingDestinationRef`/`messagingDestination`, and an event stores
    // `eventName`/`eventValue`. Prefiltering on the API names matched nothing and
    // dropped every messaging row before the JS pass could see it.
    //
    // `toLower($pathPattern)` is loop-invariant but sits inside `any(...)`, so Cypher recomputes
    // it once per token per row. A leading WITH binds it once for the whole query. The binding is
    // emitted only alongside the filter: `$pathPattern` is not passed when there is no anchor,
    // and referencing an unsupplied parameter is a query error, not an empty result.
    const pathAnchorBinding = pathAnchor ? 'WITH toLower($pathPattern) AS pathAnchorLower' : '';
    const pathFilter = pathAnchor
      ? `any(token IN [${ENTRYPOINT_ADDRESS_PROPERTY_KEYS.map((key) => `ep.${key}`).join(', ')}] ` +
        'WHERE token IS NOT NULL AND toLower(token) CONTAINS pathAnchorLower)'
      : 'true';
    const idFilter = id ? `ep.id = $id` : 'true';
    const messagingTypeFilter = normalizedSystem ? "ep.entrypointType IN ['queue', 'event']" : 'true';
    const systemFilter =
      normalizedSystem === 'unknown'
        ? "trim(coalesce(ep.messagingSystem, ep.emitter, '')) = ''"
        : normalizedSystem
          ? 'toLower(trim(coalesce(ep.messagingSystem, ep.emitter))) = $system'
          : 'true';
    // Path searches cannot be capped before the JS refinement: the Nth actual
    // match may appear after any number of anchor-only candidates.
    const sqlLimit = pathPattern ? undefined : limit;
    const limitClause = sqlLimit ? `LIMIT $limit` : '';

    const query = `
      ${pathAnchorBinding}
      MATCH (ep:Entrypoint)
      WHERE ${repoFilter}
        AND ${typeFilter}
        AND ${pathFilter}
        AND ${idFilter}
        AND ${messagingTypeFilter}
        AND ${systemFilter}
      OPTIONAL MATCH (ep)-[:HANDLES]->(h:Function)
      RETURN ep, h.name as handlerName, h.id as handlerId, h.summary as handlerSummary, h.purpose as handlerPurpose
      ORDER BY ep.entrypointType, ep.fullPath, ep.method
      ${limitClause}
    `;

    const queryParams: Record<string, unknown> = {};
    if (sqlLimit) queryParams.limit = toInt(sqlLimit);
    if (id) queryParams.id = id;
    if (type) queryParams.type = type;
    if (pathAnchor) queryParams.pathPattern = pathAnchor;
    if (normalizedSystem && normalizedSystem !== 'unknown') queryParams.system = normalizedSystem;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        ep: Record<string, unknown>;
        handlerName: string | null;
        handlerId: string | null;
        handlerSummary: string | null;
        handlerPurpose: string | null;
      }>(query, queryParams);
    });

    const entrypointInfos: EntrypointInfo[] = results.map((row) =>
      entrypointInfoFromNode(row.ep, {
        id: row.handlerId,
        name: row.handlerName,
        summary: row.handlerSummary,
        purpose: row.handlerPurpose,
      }),
    );

    // Surface frontend routes (`:Route` nodes) as synthetic HTTP-GET
    // entrypoints — SQLite parity. Without this, list_entrypoints on a
    // frontend repo reports no HTTP surface. Skip for an exact id lookup or a
    // non-http type filter (already covered above).
    if (!id && !normalizedSystem && (!type || type === 'http')) {
      const routeFilter = buildRepoFilter('n', repoHashes);
      const routePathFilter = pathAnchor ? `AND toLower(n.path) CONTAINS toLower($pathPattern)` : '';
      const routeQuery = `
        MATCH (n:Route)
        WHERE ${routeFilter}
          ${routePathFilter}
        OPTIONAL MATCH (c {id: n.componentId})
        WHERE c:Function OR c:Class OR c:Component
        RETURN n.id as id, n.name as name, n.path as path,
               n.componentId as componentId, n.componentName as componentName,
               n.filePath as filePath, n.startLine as startLine, n.endLine as endLine,
               c.name as handlerName, c.summary as handlerSummary, c.purpose as handlerPurpose
        ORDER BY n.path
        ${limitClause}
      `;

      const routeParams: Record<string, unknown> = {};
      if (sqlLimit) routeParams.limit = toInt(sqlLimit);
      if (pathAnchor) routeParams.pathPattern = pathAnchor;

      const routeRows = await this.driver.withReadTransaction(async (tx) => {
        return tx.run<{
          id: string;
          name: string | null;
          path: string | null;
          componentId: string | null;
          componentName: string | null;
          filePath: string;
          startLine: number;
          endLine: number;
          handlerName: string | null;
          handlerSummary: string | null;
          handlerPurpose: string | null;
        }>(routeQuery, routeParams);
      });

      for (const row of routeRows) {
        const routePath = row.path || row.name || row.id;
        entrypointInfos.push({
          id: row.id,
          type: 'http',
          method: 'GET',
          handlerId: row.componentId || '',
          handlerName: row.handlerName || row.componentName || undefined,
          path: routePath,
          fullPath: routePath,
          filePath: row.filePath,
          startLine: toNumber(row.startLine),
          endLine: toNumber(row.endLine),
          summary: row.handlerSummary || undefined,
          purpose: row.handlerPurpose || undefined,
        });
      }
    }

    // Refine with parameter-agnostic matching the DB CONTAINS can't do, then
    // apply the caller's limit (the DB cap was widened for path searches above).
    if (pathPattern) {
      const matched = entrypointInfos.filter((ep) => entrypointAddressMatches(pathPattern, ep));
      return limit !== undefined ? matched.slice(0, limit) : matched;
    }

    return entrypointInfos;
  }

  async getRepoOverview(repoHashes: string[]): Promise<RepoOverview[]> {
    const repoFilter = buildRepoFilter('r', repoHashes, true);

    const query = `
      MATCH (r:Repository)
      WHERE ${repoFilter}
      WITH r
      OPTIONAL MATCH (r)-[:CONTAINS_FILE]->(f:File)
      OPTIONAL MATCH (f)-[:CONTAINS_FUNCTION]->(fn:Function)
      OPTIONAL MATCH (f)-[:CONTAINS_CLASS]->(c:Class)
      OPTIONAL MATCH (f)-[:CONTAINS_ENTITY]->(e:Entity)
      OPTIONAL MATCH (ep:Entrypoint) WHERE ep.id STARTS WITH substring(r.id, 0, 12)
      WITH r,
           count(DISTINCT f) as fileCount,
           count(DISTINCT fn) as functionCount,
           count(DISTINCT c) as classCount,
           count(DISTINCT e) as entityCount,
           collect(DISTINCT ep.entrypointType) as entrypointTypes
      RETURN r.name as name,
             r.type as type,
             r.parsedAt as parsedAt,
             r.summary as summary,
             r.dataModel as dataModel,
             r.externalIntegrations as externalIntegrations,
             r.gitRemoteUrl as gitRemoteUrl,
             r.gitCommitHash as gitCommitHash,
             r.parserVersion as parserVersion,
             fileCount,
             functionCount,
             classCount,
             entityCount,
             entrypointTypes
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        name: string;
        type: string;
        parsedAt: string;
        summary: string | null;
        dataModel: string | null;
        externalIntegrations: string | null;
        gitRemoteUrl: string | null;
        gitCommitHash: string | null;
        parserVersion: string | null;
        fileCount: number;
        functionCount: number;
        classCount: number;
        entityCount: number;
        entrypointTypes: string[];
      }>(query);
    });

    return results.map((row) => ({
      name: row.name,
      type: row.type || 'unknown',
      parsedAt: row.parsedAt || '',
      fileCount: toNumber(row.fileCount),
      functionCount: toNumber(row.functionCount),
      classCount: toNumber(row.classCount),
      entityCount: toNumber(row.entityCount),
      entrypointTypes: row.entrypointTypes || [],
      ...(row.summary && { summary: row.summary }),
      ...(row.dataModel && { dataModel: row.dataModel }),
      ...(row.externalIntegrations && {
        externalIntegrations: JSON.parse(row.externalIntegrations) as string[],
      }),
      ...(row.gitRemoteUrl && { gitRemoteUrl: row.gitRemoteUrl }),
      ...(row.gitCommitHash && { gitCommitHash: row.gitCommitHash }),
      ...(row.parserVersion && { parserVersion: row.parserVersion }),
    }));
  }

  /**
   * Per-repo extraction-coverage counts (SQLite parity). Five grouped queries
   * keyed by the repo-hash id prefix (`split(id, ':')[0]`), merged in JS.
   * Empty `repoHashes` = all repos (buildRepoFilter convention).
   */
  async getCoverageCounts(repoHashes: string[]): Promise<RepoCoverageCounts[]> {
    const repoQuery = `
      MATCH (r:Repository)
      WHERE ${buildRepoFilter('r', repoHashes, true)}
      RETURN r.id AS hash, r.name AS name,
             r.analysis AS analysis,
             r.callSites AS callSites, r.resolvedCalls AS resolvedCalls, r.outOfScopeCalls AS outOfScopeCalls,
             r.dbOpSites AS dbOpSites, r.boundDbOps AS boundDbOps, r.outOfScopeDbOps AS outOfScopeDbOps
    `;

    // Node counts by concrete label, grouped per repo. Repository nodes are
    // bookkeeping, not extracted structure — excluded (their ids also carry no
    // ':' prefix, so the empty-hashes 'true' filter is the only path that
    // would otherwise include them).
    const nodeCountsQuery = `
      MATCH (n:CodeNode)
      WHERE ${buildRepoFilter('n', repoHashes)}
        AND NOT n:Repository
      WITH split(n.id, ':')[0] AS hash, [l IN labels(n) WHERE l <> 'CodeNode'][0] AS label, count(n) AS c
      RETURN hash, label, c
    `;

    const dbOpQuery = `
      MATCH (e:Entity)<-[:OPERATES_ON]-()
      WHERE ${buildRepoFilter('e', repoHashes)}
      RETURN split(e.id, ':')[0] AS hash, count(DISTINCT e) AS n
    `;

    const callsQuery = `
      MATCH (f:Function)-[:CALLS]->()
      WHERE ${buildRepoFilter('f', repoHashes)}
      RETURN split(f.id, ':')[0] AS hash, count(DISTINCT f) AS n
    `;

    const resolvedQuery = `
      MATCH (ec:ExternalCall)-[:RESOLVES_TO]->()
      WHERE ${buildRepoFilter('ec', repoHashes)}
      RETURN split(ec.id, ':')[0] AS hash, count(DISTINCT ec) AS n
    `;

    const [repoRows, countRows, dbOpRows, callRows, resolvedRows] = await this.driver.withReadTransaction(
      async (tx) => {
        return Promise.all([
          tx.run<{
            hash: string;
            name: string;
            callSites: unknown;
            analysis: unknown;
            resolvedCalls: unknown;
            outOfScopeCalls: unknown;
            dbOpSites: unknown;
            boundDbOps: unknown;
            outOfScopeDbOps: unknown;
          }>(repoQuery),
          tx.run<{ hash: string; label: string; c: number }>(nodeCountsQuery),
          tx.run<{ hash: string; n: number }>(dbOpQuery),
          tx.run<{ hash: string; n: number }>(callsQuery),
          tx.run<{ hash: string; n: number }>(resolvedQuery),
        ]);
      },
    );

    const countsByRepo = new Map<string, Record<string, number>>();
    for (const row of countRows) {
      const perType = countsByRepo.get(row.hash) ?? {};
      perType[normalizeNodeType(row.label)] = toNumber(row.c);
      countsByRepo.set(row.hash, perType);
    }
    const byHash = (rows: Array<{ hash: string; n: number }>) =>
      new Map(rows.map((row) => [row.hash, toNumber(row.n)]));
    const dbOpByRepo = byHash(dbOpRows);
    const callsByRepo = byHash(callRows);
    const resolvedByRepo = byHash(resolvedRows);

    return repoRows.map((row) => {
      const nodeCountsByType = countsByRepo.get(row.hash) ?? {};
      const callResolution = callResolutionFrom(row.callSites, row.resolvedCalls, row.outOfScopeCalls);
      const analysis = analysisFrom(row.analysis);
      const dbOpResolution = dbOpResolutionFrom(row.dbOpSites, row.boundDbOps, row.outOfScopeDbOps);
      return {
        repoName: row.name,
        nodeCountsByType,
        entityCount: nodeCountsByType.entity ?? 0,
        entitiesWithDbOps: dbOpByRepo.get(row.hash) ?? 0,
        functionCount: nodeCountsByType.function ?? 0,
        functionsWithCalls: callsByRepo.get(row.hash) ?? 0,
        externalCallCount: nodeCountsByType.external_call ?? 0,
        resolvedExternalCallCount: resolvedByRepo.get(row.hash) ?? 0,
        ...(callResolution ? { callResolution } : {}),
        ...(analysis ? { analysis } : {}),
        ...(dbOpResolution ? { dbOpResolution } : {}),
      };
    });
  }

  async listAllRepositories(nameFilter?: string[]): Promise<RepoSummary[]> {
    const useFilter = Array.isArray(nameFilter);
    if (useFilter && nameFilter!.length === 0) return [];

    const filterClause = useFilter ? 'WHERE r.name IN $names' : '';
    const query = `
      MATCH (r:Repository)
      ${filterClause}
      RETURN r.id AS hash,
             r.name AS name,
             r.type AS type,
             r.parsedAt AS parsedAt,
             r.summary AS summary
      ORDER BY r.name
    `;
    const params = useFilter ? { names: nameFilter } : {};

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        hash: string;
        name: string;
        type: string | null;
        parsedAt: string | null;
        summary: string | null;
      }>(query, params);
    });

    return rows.map((row) => ({
      name: row.name,
      hash: row.hash,
      type: row.type || 'unknown',
      parsedAt: row.parsedAt || '',
      ...(row.summary && { summary: row.summary }),
    }));
  }

  async getRepositoryNames(repoHashes: string[]): Promise<RepoNameRow[]> {
    // Repository node ids ARE the repo hash (no `:type:…` suffix). One query,
    // no per-repo counts (that's getRepoOverview's job).
    const query = `
      MATCH (r:Repository)
      WHERE ${buildRepoFilter('r', repoHashes, true)}
      RETURN r.id AS hash, r.name AS name, r.parserVersion AS parserVersion
    `;

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ hash: string; name: string; parserVersion: string | null }>(query);
    });

    return rows.map((row) => ({
      hash: row.hash,
      name: row.name,
      ...(row.parserVersion && { parserVersion: row.parserVersion }),
    }));
  }

  async getPackages(repoHashes: string[]): Promise<PackageInfo[]> {
    const repoFilter = buildRepoFilter('p', repoHashes);

    // Each Package node sits under its containing Repository via
    // CONTAINS_PACKAGE. We use OPTIONAL MATCH so a stray Package without a
    // repo link still surfaces (just without a repoId).
    const query = `
      MATCH (p:Package)
      WHERE ${repoFilter}
      OPTIONAL MATCH (r:Repository)-[:CONTAINS_PACKAGE]->(p)
      RETURN p.id as id,
             p.name as name,
             p.path as path,
             p.packageType as type,
             p.language as language,
             p.description as description,
             r.id as repoId
      ORDER BY p.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        path: string;
        type: string | null;
        language: string | null;
        description: string | null;
        repoId: string | null;
      }>(query);
    });

    return results.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      type: row.type || undefined,
      language: row.language || undefined,
      description: row.description || undefined,
      ...(row.repoId && { repoId: row.repoId }),
    }));
  }

  /**
   * Package-import linker projection — the Neo4j mirror of the SQLite query.
   * Without it, `parsedReposFromRepository` fails closed for every
   * multi-repository workspace, which is every on-prem (Neo4j) workspace with
   * more than one repo.
   *
   * Two labelled reads instead of one property-join: every `MATCH` carries a
   * label so the `id` range index backs the repo-prefix `STARTS WITH`, and the
   * file ↔ declaration join (which Cypher could only express as an unindexed
   * `d.fileId = f.id` scan) is folded in memory. The rows are exactly the ones
   * SQLite returns, so the linker sees the same inputs on both backends.
   */
  async getPackageLinkerFacts(repoHashes: string[]): Promise<PackageLinkerFacts> {
    if (repoHashes.length === 0) return { files: [], declarations: [] };

    const fileQuery = `
      MATCH (f:File)
      WHERE ${buildRepoFilter('f', repoHashes)}
        AND f.packageId IS NOT NULL
      RETURN f.id AS id,
             f.path AS path,
             f.name AS name,
             f.filePath AS filePath,
             f.packageId AS packageId,
             f.target AS target,
             f.packageImports AS packageImports
    `;

    // One arm per label (each an index seek) UNION ALL'd, rather than an
    // unlabelled `MATCH (d) WHERE d:Class OR …` which would scan the graph.
    // Methods are excluded the same way SQLite does it: only `kind = 'function'`
    // survives on the Function label.
    const declarationQuery = PACKAGE_LINKER_DECLARATION_LABELS.map(
      ([label, kind]) => `
      MATCH (d:${label})
      WHERE ${buildRepoFilter('d', repoHashes)}
        AND d.isExported = true${label === 'Function' ? "\n        AND d.kind = 'function'" : ''}
      RETURN d.id AS id, d.name AS name, d.fileId AS fileId, '${kind}' AS kind
    `,
    ).join('      UNION ALL');

    const [fileRows, declarationRows] = await this.driver.withReadTransaction(async (tx) => {
      const files = await tx.run<{
        id: string;
        path: string | null;
        name: string | null;
        filePath: string | null;
        packageId: unknown;
        target: unknown;
        packageImports: unknown;
      }>(fileQuery);
      const declarations = await tx.run<{
        id: string;
        name: string;
        fileId: unknown;
        kind: PackageLinkerDeclarationKind;
      }>(declarationQuery);
      return [files, declarations] as const;
    });

    // Warn-and-skip, never throw — same policy as the SQLite projection: one
    // malformed row must degrade its own file, not abort resolution for the
    // whole workspace.
    const skipped: string[] = [];
    const filesById = new Map<string, PackageLinkerFileInfo>();
    for (const row of fileRows) {
      const packageId = row.packageId;
      if (typeof packageId !== 'string' || packageId.length === 0) {
        skipped.push(`File ${row.id}: missing packageId`);
        continue;
      }
      const imports = parseJsonArrayProp(row.packageImports);
      if (row.packageImports !== null && row.packageImports !== undefined && imports === undefined) {
        skipped.push(`File ${row.id}: invalid packageImports`);
        continue;
      }
      filesById.set(row.id, {
        id: row.id,
        path: row.path ?? row.filePath ?? row.name ?? '',
        packageId,
        ...(typeof row.target === 'string' ? { target: row.target } : {}),
        imports: (imports ?? []) as PackageLinkerImportInfo[],
      });
    }

    const declarations: PackageLinkerFacts['declarations'] = [];
    const filesWithExports = new Set<string>();
    for (const row of declarationRows) {
      const fileId = row.fileId;
      if (typeof fileId !== 'string' || fileId.length === 0) {
        skipped.push(`declaration ${row.id}: missing fileId`);
        continue;
      }
      // A declaration outside a packaged file is not a package export, so it is
      // dropped rather than skipped — SQLite never selects it in the first place.
      if (!filesById.has(fileId)) continue;
      filesWithExports.add(fileId);
      declarations.push({ id: row.id, name: row.name, fileId, kind: row.kind, isExported: true });
    }

    // Project only the files the linker can use: an importer, or a package
    // export site. A packaged file that is neither is dead weight on the wire.
    const files = [...filesById.values()].filter((file) => file.imports.length > 0 || filesWithExports.has(file.id));

    if (skipped.length > 0) {
      console.warn(
        `[coredoc] package linker: skipped ${skipped.length} malformed row(s) — ${skipped.slice(0, 5).join('; ')}` +
          `${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''}`,
      );
    }
    return { files, declarations };
  }

  // -------------------------------------------------------------------------
  // Traversals
  // -------------------------------------------------------------------------

  async getDirectCallers(targetId: string, repoHashes: string[]): Promise<CallerInfo[]> {
    const repoFilter = buildRepoFilter('caller', repoHashes);

    const query = `
      MATCH (target:Function {id: $targetId})<-[c:CALLS]-(caller:Function)
      WHERE ${repoFilter}
      OPTIONAL MATCH (caller)<-[:HAS_METHOD]-(cls:Class)
      RETURN caller, c.line as callSiteLine, c.isAsync as isAsyncCall, c.provenanceInferred as provenanceInferred, cls.name as className
      ORDER BY caller.filePath, caller.startLine
      LIMIT 100
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        caller: Record<string, unknown>;
        callSiteLine: number | null;
        isAsyncCall: boolean | null;
        provenanceInferred: boolean | null;
        className: string | null;
      }>(query, { targetId });
    });

    return results.map((row) =>
      callerInfoFromRow(neoCallerRow(row.caller), row.caller, {
        distance: 1,
        className: row.className,
        callSiteLine: row.callSiteLine ? toNumber(row.callSiteLine) : null,
        isAsyncCall: row.isAsyncCall,
        provenanceInferred: row.provenanceInferred,
      }),
    );
  }

  async getTransitiveCallers(targetId: string, depth: number, repoHashes: string[]): Promise<CallerInfo[]> {
    const repoFilter = buildRepoFilter('caller', repoHashes);

    const query = `
      MATCH path = (target:Function {id: $targetId})<-[:CALLS*1..${intDepth(depth)}]-(caller:Function)
      WHERE ${repoFilter}
        AND caller.id <> target.id
      // A chain is only as proven as its weakest edge, so one inferred hop makes
      // the path inferred; min() then reports a caller reachable by BOTH a proven
      // and an inferred path as proven, since the proven path is real evidence.
      WITH caller, min(length(path)) as distance,
           min(CASE WHEN any(r IN relationships(path) WHERE r.provenanceInferred) THEN 1 ELSE 0 END) as inferred
      OPTIONAL MATCH (caller)<-[:HAS_METHOD]-(cls:Class)
      RETURN DISTINCT caller, distance, inferred as provenanceInferred, cls.name as className
      ORDER BY distance, caller.filePath
      LIMIT 100
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        caller: Record<string, unknown>;
        distance: number;
        provenanceInferred: number | null;
        className: string | null;
      }>(query, { targetId });
    });

    return results.map((row) =>
      callerInfoFromRow(neoCallerRow(row.caller), row.caller, {
        distance: toNumber(row.distance),
        className: row.className,
        provenanceInferred: row.provenanceInferred,
      }),
    );
  }

  async getReachingEntrypoints(targetId: string, depth: number, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const repoFilter = buildRepoFilter('ep', repoHashes);

    // Prune from the target outward, not from every entrypoint inward. Binding
    // `target` by its indexed id and expanding incoming CALLS (`<-[:CALLS*0..n]-`)
    // walks only the call graph *above* the target — typically a handful of
    // functions — instead of enumerating every entrypoint in scope and probing a
    // variable-length path from each. `*0` keeps the handler-IS-target case.
    const query = `
      MATCH (target:Function {id: $targetId})
      MATCH (handler:Function)-[:CALLS*0..${intDepth(depth) + 3}]->(target)
      WITH DISTINCT handler
      MATCH (ep:Entrypoint)-[:HANDLES]->(handler)
      WHERE ${repoFilter}
      RETURN DISTINCT ep, handler.name as handlerName, handler.id as handlerId
      ORDER BY ep.fullPath
      LIMIT 20
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        ep: Record<string, unknown>;
        handlerName: string;
        handlerId: string;
      }>(query, { targetId });
    });

    return results.map((row) => entrypointInfoFromNode(row.ep, { id: row.handlerId, name: row.handlerName }));
  }

  async findShortestPath(startId: string, endId: string, _repoHashes: string[]): Promise<PathStep[]> {
    // SQLite parity: a node trivially reaches itself with a single-step path.
    // The `*1..10` lower bound below requires at least one CALLS hop, so it
    // would return [] for start === end.
    if (startId === endId) {
      return this.hydratePathSteps([startId]);
    }

    // Anchor each endpoint by its indexed id in its own MATCH. The previous
    // `MATCH (start:Function), (end:Function) WHERE start.id=… AND end.id=…`
    // form is a cartesian product the planner warns on; two id-anchored MATCHes
    // resolve each node by index, then shortestPath walks between them.
    const query = `
      MATCH (start:Function {id: $startId})
      MATCH (end:Function {id: $endId})
      MATCH path = shortestPath((start)-[:CALLS*1..10]->(end))
      WITH path, [n IN nodes(path) | {
        id: n.id,
        name: n.name,
        filePath: n.filePath,
        startLine: n.startLine,
        summary: n.summary,
        classId: n.classId
      }] as steps
      RETURN steps
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ steps: PathStep[] }>(query, { startId, endId });
    });

    if (results.length === 0) return [];

    return results[0]!.steps.map((step) => ({
      id: step.id,
      name: step.name,
      filePath: step.filePath,
      startLine: toNumber(step.startLine),
      summary: step.summary || undefined,
      classId: step.classId || undefined,
    }));
  }

  /**
   * Hydrate `(name, filePath, startLine, summary, classId)` for an ordered id
   * list, preserving order. Used by findShortestPath for the start === end
   * single-node path (mirrors the SQLite helper of the same name).
   */
  private async hydratePathSteps(nodeIds: string[]): Promise<PathStep[]> {
    if (nodeIds.length === 0) return [];

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        summary: string | null;
        classId: string | null;
      }>(
        `
        UNWIND $nodeIds AS nid
        MATCH (n {id: nid})
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.summary AS summary, n.classId AS classId
        `,
        { nodeIds },
      );
    });

    const nodeMap = new Map(rows.map((r) => [r.id, r]));
    return nodeIds.map((id) => {
      const node = nodeMap.get(id);
      if (!node) {
        return { id, name: 'unknown', filePath: '', startLine: 0 };
      }
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        startLine: toNumber(node.startLine),
        summary: node.summary || undefined,
        classId: node.classId || undefined,
      };
    });
  }

  async getCallTree(rootId: string, depth: number, repoHashes: string[]): Promise<CallTreeNode[]> {
    const repoFilter = buildRepoFilter('f', repoHashes);

    const query = `
      MATCH (root:Function {id: $rootId})
      CALL {
        WITH root
        MATCH path = (root)-[:CALLS*0..${intDepth(depth)}]->(f:Function)
        WHERE ${repoFilter}
        WITH f, min(length(path)) as nodeDepth
        RETURN f, nodeDepth
        ORDER BY nodeDepth
        LIMIT 200
      }
      OPTIONAL MATCH (f)<-[:HAS_METHOD]-(cls:Class)
      RETURN f, nodeDepth as depth, cls.name as className
      ORDER BY depth, f.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        f: Record<string, unknown>;
        depth: number;
        className: string | null;
      }>(query, { rootId });
    });

    return results.map((row) => {
      const node = row.f;
      return {
        id: node.id as string,
        name: node.name as string,
        kind: (node.kind as 'function' | 'method') || 'function',
        filePath: node.filePath as string,
        startLine: toNumber(node.startLine),
        className: row.className || undefined,
        summary: node.summary as string | undefined,
        depth: toNumber(row.depth),
      };
    });
  }

  async getDirectCallees(sourceId: string, repoHashes: string[]): Promise<FunctionInfo[]> {
    const repoFilter = buildRepoFilter('callee', repoHashes);

    const query = `
      MATCH (source:Function {id: $sourceId})-[c:CALLS]->(callee:Function)
      WHERE ${repoFilter}
      RETURN callee, c.calleeExpression as callExpression, c.isAsync as isAsync
      ORDER BY c.line
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        callee: Record<string, unknown>;
        callExpression: string | null;
        isAsync: boolean | null;
      }>(query, { sourceId });
    });

    return results.map((row) => functionInfoFromRow(nodeRow(row.callee), row.callee));
  }

  // -------------------------------------------------------------------------
  // Impact Analysis
  // -------------------------------------------------------------------------

  async getClassExtensions(classId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const repoFilter = buildRepoFilter('child', repoHashes);

    const query = `
      MATCH (base:Class {id: $classId})<-[:EXTENDS]-(child:Class)
      WHERE ${repoFilter}
      RETURN child
      ORDER BY child.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ child: Record<string, unknown> }>(query, { classId });
    });

    return results.map((row) =>
      namedDeclarationFromRow('class', nodeRow(row.child), {
        ...row.child,
        properties_: parseJsonArrayProp(row.child.properties_),
      }),
    );
  }

  async getInterfaceImplementations(interfaceId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const repoFilter = buildRepoFilter('c', repoHashes);

    const query = `
      MATCH (i:Interface {id: $interfaceId})<-[:IMPLEMENTS_INTERFACE]-(c:Class)
      WHERE ${repoFilter}
      RETURN c
      ORDER BY c.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ c: Record<string, unknown> }>(query, { interfaceId });
    });

    return results.map((row) =>
      namedDeclarationFromRow('class', nodeRow(row.c), {
        ...row.c,
        properties_: parseJsonArrayProp(row.c.properties_),
      }),
    );
  }

  async getEntityConsumers(
    entityName: string,
    repoHashes: string[],
    operation?: DbOperationType,
  ): Promise<EntityConsumer[]> {
    const repoFilter = buildRepoFilter('f', repoHashes);

    let operationFilter = 'true';
    if (operation) {
      operationFilter = `op.operation = '${operation}'`;
    }

    const query = `
      MATCH (f:Function)-[op:OPERATES_ON]->(e:Entity {name: $entityName})
      WHERE ${repoFilter}
        AND ${operationFilter}
      OPTIONAL MATCH (f)<-[:HAS_METHOD]-(cls:Class)
      RETURN f, op.operation as operation, cls.name as className
      ORDER BY op.operation, f.filePath
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        f: Record<string, unknown>;
        operation: string;
        className: string | null;
      }>(query, { entityName });
    });

    return results.map((row) => {
      const node = row.f;
      return {
        id: node.id as string,
        name: node.name as string,
        kind: (node.kind as 'function' | 'method') || 'function',
        filePath: node.filePath as string,
        startLine: toNumber(node.startLine),
        className: row.className || undefined,
        operation: row.operation as DbOperationType,
      };
    });
  }

  async getTypeUsages(typeId: string, repoHashes: string[]): Promise<TypeUsage[]> {
    const repoFilter = buildRepoFilter('src', repoHashes);
    const query = `
      MATCH (target {id: $typeId})
      MATCH (src)-[r]->(target)
      WHERE ${repoFilter}
        AND (
          type(r) = 'USES_TYPE'
          OR (type(r) = 'RESOLVES_TO' AND r.relation = $packageImportRelation)
        )
      RETURN src, labels(src) AS srcLabels, r.usage AS usage, r.via AS via, r.useKind AS useKind,
             r.member AS member, r.ambiguous AS ambiguous
      ORDER BY src.filePath, src.startLine, src.id
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        src: Record<string, unknown>;
        srcLabels: string[];
        usage: string | null;
        via: string | null;
        useKind: string | null;
        member: string | null;
        ambiguous: boolean | null;
      }>(query, { typeId, packageImportRelation: 'package-import' });
    });

    return results.map((row) => {
      const node = row.src;
      const label = row.srcLabels?.[0] ?? '';
      return {
        id: node.id as string,
        name: node.name as string,
        type: normalizeNodeType(label),
        filePath: node.filePath as string,
        startLine: node.startLine === undefined || node.startLine === null ? 0 : toNumber(node.startLine),
        endLine: node.endLine !== undefined ? toNumber(node.endLine) : undefined,
        usage: (row.usage ?? 'parameter') as TypeUsageKind,
        via: row.via ?? undefined,
        // Value-position member reference metadata; absent on type-position edges.
        useKind: (row.useKind as TypeUseKind | null) ?? undefined,
        member: row.member ?? undefined,
        ambiguous: Boolean(row.ambiguous),
      };
    });
  }

  async getEntitiesForFunctions(
    functionIds: string[],
    _repoHashes: string[],
  ): Promise<
    Array<{
      functionId: string;
      entityName: string;
      tableName: string;
      operation: string;
      entityId: string;
    }>
  > {
    if (functionIds.length === 0) return [];

    const query = `
      MATCH (f:Function)-[op:OPERATES_ON]->(e:Entity)
      WHERE f.id IN $functionIds
      RETURN f.id as functionId, e.name as entityName, e.tableName as tableName, op.operation as operation, e.id as entityId
      ORDER BY f.id, e.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        functionId: string;
        entityName: string;
        tableName: string;
        operation: string;
        entityId: string;
      }>(query, { functionIds });
    });

    return results.map((row) => ({
      functionId: row.functionId,
      entityName: row.entityName,
      tableName: row.tableName || '',
      operation: row.operation || 'unknown',
      entityId: row.entityId,
    }));
  }

  // -------------------------------------------------------------------------
  // Push Operations
  // -------------------------------------------------------------------------

  async pushNodes(nodes: GraphNode[]): Promise<number> {
    if (nodes.length === 0) return 0;

    // Group nodes by type for efficient batch processing
    const nodesByType = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const label = NODE_TYPE_TO_LABEL[node.type] ?? node.type;
      if (!nodesByType.has(label)) {
        nodesByType.set(label, []);
      }
      nodesByType.get(label)!.push(node);
    }

    let total = 0;

    for (const [label, batch] of nodesByType) {
      // SET n:CodeNode tags every node with the shared label so id lookups that
      // don't know the concrete type (pushEdges endpoint MATCH, deleteRepository
      // prefix scan) can use the single :CodeNode(id) index. SET after the MERGE
      // (not in the MERGE pattern) so it never forks a second node on re-push.
      const query = `
        UNWIND $batch AS item
        MERGE (n:${label} {id: item.id})
        ON CREATE SET n = item.props, n.created = timestamp()
        ON MATCH SET n += item.props, n.updated = timestamp()
        SET n:CodeNode
      `;

      const items = batch.map((node) => ({
        id: node.id,
        props: {
          id: node.id,
          name: node.name,
          // Neo4j refuses maps and arrays-of-maps as node properties, so
          // any non-primitive property is serialized to a JSON string. The
          // transformer emits these for class.implements, properties_,
          // constructorParams, decorators, interface.members, type aliases,
          // and methodIds (string[] is OK but normalize for consistency).
          ...flattenForNeo4j(node.properties),
          summary: node.summary,
          embedding: node.embedding,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
        },
      }));

      await this.driver.executeBatch(items, async (batchItems, tx) => {
        await tx.run(query, { batch: batchItems });
      });

      total += batch.length;
    }

    return total;
  }

  async getAppliedGraphSnapshot(repoId: string): Promise<AppliedGraphSnapshot | null> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ snapshot: string }>(`MATCH (meta:CoredocMeta {repoId: $repoId}) RETURN meta.snapshot AS snapshot`, {
        repoId,
      }),
    );
    if (!rows[0]?.snapshot) return null;
    return parseAppliedGraphSnapshot(rows[0].snapshot, repoId);
  }

  async getPendingGraphApply(repoId: string): Promise<string | null> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ pending: unknown }>(
        `MATCH (meta:CoredocMeta {repoId: $repoId}) WHERE meta.applyPending IS NOT NULL RETURN meta.applyPending AS pending`,
        { repoId },
      ),
    );
    const pending = rows[0]?.pending;
    return typeof pending === 'string' ? pending : null;
  }

  async pushEdges(edges: GraphEdge[]): Promise<number> {
    if (edges.length === 0) return 0;

    // Group edges by type for efficient batch processing
    const edgesByType = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      if (!edgesByType.has(edge.type)) {
        edgesByType.set(edge.type, []);
      }
      edgesByType.get(edge.type)!.push(edge);
    }

    let total = 0;

    for (const [type, batch] of edgesByType) {
      // :CodeNode label on the endpoint MATCH so each id lookup hits the
      // :CodeNode(id) index instead of scanning the whole graph — the un-labeled
      // MATCH made large-repo edge pushes degrade super-linearly with graph size.
      const query = `
        UNWIND $batch AS item
        MATCH (from:CodeNode {id: item.sourceId})
        MATCH (to:CodeNode {id: item.targetId})
        MERGE (from)-[r:${type}]->(to)
        ON CREATE SET r = item.props, r.created = timestamp()
        ON MATCH SET r += item.props, r.updated = timestamp()
      `;

      const items = batch.map((edge) => ({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        props: {
          // Relationship properties carry the same Neo4j restriction as node
          // properties — maps and arrays-of-maps are rejected. Flatten so edges
          // like RESOLVES_TO, whose `chain` is an array of hop objects
          // (cross-repo linker), are JSON-encoded instead of throwing at tx.run.
          // getResolvesEdge JSON.parses `chain` back to ResolvedHop[].
          ...flattenForNeo4j(edge.properties),
          id: edge.id,
          confidence: edge.confidence,
          createdBy: edge.createdBy,
        },
      }));

      await this.driver.executeBatch(items, async (batchItems, tx) => {
        await tx.run(query, { batch: batchItems });
      });

      total += batch.length;
    }

    return total;
  }

  /**
   * Apply an incremental changeset to the graph — Neo4j parity with
   * SqliteRepository.applyChangeset, so PushService.applyIncremental stops
   * falling back to a full re-push on the Neo4j backend.
   *
   * Commits in chunks: every statement batch runs in its own write transaction.
   * One transaction for a large repository (100k+ edges, plus summaries and
   * embeddings) holds the whole delete + rewrite in Neo4j transaction state until
   * COMMIT, which then exceeds the transaction memory pool. The consistency
   * contract is instead:
   *  - every phase is idempotent (DETACH DELETE by id, MERGE + full-replace SET),
   *    so re-running the same changeset converges to the same graph;
   *  - a `CoredocMeta.applyPending` mark is written first and cleared by the final
   *    snapshot write, so a stopped apply is visible (getPendingGraphApply) and the
   *    next push replaces the repository in full instead of diffing from a
   *    baseline the graph no longer matches;
   *  - the graph-write lease held by PushService keeps writers serialized.
   * Readers may observe a partly applied repository while an apply is running.
   *
   * Two divergences from the SQLite SQL are forced by the graph model; the net
   * graph state is identical or strictly cleaner:
   *  - Phase 1 uses DETACH DELETE. Neo4j refuses to delete a node that still has
   *    relationships, whereas SQLite leaves them dangling for phase 3 to wipe. To
   *    keep `edgesDeleted` at parity with SQLite — whose phase 3 counts those
   *    dangling edges, because the deleted ids are also in edgeNodeIdsToWipe —
   *    phase 1 counts the relationships it is about to detach and folds them into
   *    `edgesDeleted` BEFORE deleting; phase 3 then measures only the edges that
   *    survive to it (incident to still-present nodes), so the two phases sum to
   *    exactly the set SQLite reports, with no double counting.
   *  - Phases 2/4 use full-replace (`SET n = props` / `SET r = props`) instead of
   *    the additive `+=` of pushNodes/pushEdges: SQLite UPSERT overwrites every
   *    column, so a property dropped in the new version must disappear — `+=` would
   *    leave it stale. The node id `{repoHash}:{type}:{path}:{name}` encodes the
   *    type, so a given id maps to exactly one label and `MERGE (n:Label {id})`
   *    can never orphan a type-changed node (a type change yields a different id,
   *    handled as a delete + add).
   */
  async applyChangeset(
    changeset: {
      /** ParsedRepo.id — carried for cross-repo bookkeeping callers; unused here. */
      repoId: string;
      repoIdsToDelete?: string[];
      nodesToAdd: GraphNode[];
      nodesToUpdate: GraphNode[];
      nodeIdsToDelete: string[];
      edgeNodeIdsToWipe: string[];
      edgeTypesToPreserve?: string[];
      edgesToInsert: GraphEdge[];
      nodeMetadataUpdates?: NodeMetadataUpdate[];
      /** Ignored: Neo4j stores no unresolved calls (see findUnresolvedCallsByNameTail). */
      unresolvedCalls?: readonly UnresolvedCallRecord[];
    },
    options?: ApplyChangesetOptions,
  ): Promise<GraphApplyReceipt> {
    const BATCH_SIZE = applyBatchSize();
    const counts = { nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 0 };
    // One statement, one transaction (see the method doc).
    const write = <T = unknown>(query: string, params: Record<string, unknown>): Promise<T[]> =>
      this.driver.withWriteTransaction((tx) => tx.run<T>(query, params));
    let phaseStart = Date.now();
    const endPhase = (phase: string) => {
      options?.onPhase?.(phase, Date.now() - phaseStart);
      phaseStart = Date.now();
    };
    options?.signal?.throwIfAborted();

    const repoIdsToDelete = [...new Set(changeset.repoIdsToDelete ?? [])];
    const nodeIdsToDelete = changeset.nodeIdsToDelete.filter(
      (nodeId) => !repoIdsToDelete.some((repoId) => nodeId === repoId || nodeId.startsWith(`${repoId}:`)),
    );
    const upsertNodes = [...changeset.nodesToAdd, ...changeset.nodesToUpdate];
    const metadataUpdates = changeset.nodeMetadataUpdates ?? [];
    const writesGraph =
      repoIdsToDelete.length > 0 ||
      nodeIdsToDelete.length > 0 ||
      upsertNodes.length > 0 ||
      changeset.edgeNodeIdsToWipe.length > 0 ||
      changeset.edgesToInsert.length > 0 ||
      metadataUpdates.length > 0;

    // Mark the repository as mid-apply before the first destructive write.
    if (writesGraph && options?.snapshot) {
      await write(`MERGE (meta:CoredocMeta {repoId: $repoId}) SET meta.applyPending = $parsedVersion`, {
        repoId: changeset.repoId,
        parsedVersion: options.snapshot.parsedVersion,
      });
    }

    // 0. Optional full-repository removal. Match only the exact repository
    // id and its `${repoId}:` child-id namespace; never broaden through a
    // display name or the first colon-delimited segment. The `=` and
    // `STARTS WITH` matches are separate statements so each seeks the
    // :CodeNode(id) range index (an `any(... OR ...)` predicate forces a label
    // scan of the whole workspace graph), and deletion runs LIMIT-bounded chunks
    // so no single transaction carries the entire old repository.
    for (const repoId of repoIdsToDelete) {
      const edges = await this.driver.withReadTransaction((tx) =>
        tx.run<{ nodesDeleted: unknown; edgesDeleted: unknown }>(
          `
          CALL {
            MATCH (n:CodeNode {id: $repoId}) RETURN n
            UNION
            MATCH (n:CodeNode) WHERE n.id STARTS WITH $prefix RETURN n
          }
          OPTIONAL MATCH (n)-[r]-()
          RETURN count(DISTINCT n) AS nodesDeleted, count(DISTINCT r) AS edgesDeleted
          `,
          { repoId, prefix: `${repoId}:` },
        ),
      );
      counts.nodesDeleted += toNumber(edges[0]?.nodesDeleted);
      counts.edgesDeleted += toNumber(edges[0]?.edgesDeleted);
      for (;;) {
        options?.signal?.throwIfAborted();
        const rows = await write<{ deleted: unknown }>(
          `
          MATCH (n:CodeNode) WHERE n.id STARTS WITH $prefix
          WITH n LIMIT $limit
          DETACH DELETE n
          RETURN count(*) AS deleted
          `,
          { prefix: `${repoId}:`, limit: toInt(BATCH_SIZE) },
        );
        if (toNumber(rows[0]?.deleted) < BATCH_SIZE) break;
      }
      await write(`MATCH (n:CodeNode {id: $repoId}) DETACH DELETE n`, { repoId });
      // The repository being written keeps its in-flight mark; any other removed
      // repository loses its metadata with its graph.
      await write(
        repoId === changeset.repoId
          ? `MATCH (meta:CoredocMeta {repoId: $repoId}) REMOVE meta.snapshot`
          : `MATCH (meta:CoredocMeta {repoId: $repoId}) DELETE meta`,
        { repoId },
      );
    }
    if (repoIdsToDelete.length > 0) endPhase('neo4j.repoDelete');

    // 1. Delete removed nodes. Neo4j can't plain-delete a node that still has
    //    relationships, so DETACH also clears their incident edges. Count those
    //    first — DISTINCT over the whole to-delete set, BEFORE any delete, so an
    //    edge between two deleted nodes is counted once — and fold them into
    //    edgesDeleted: SQLite leaves these edges for its phase 3 to count, so
    //    without this our phase 3 (which runs after the nodes are gone) would
    //    undercount relative to SQLite.
    if (nodeIdsToDelete.length > 0) {
      const detached = await this.driver.withReadTransaction((tx) =>
        tx.run<{ deleted: unknown }>(
          `
          UNWIND $ids AS nodeId
          MATCH (n:CodeNode {id: nodeId})-[r]-()
          RETURN count(DISTINCT r) AS deleted
          `,
          { ids: nodeIdsToDelete },
        ),
      );
      counts.edgesDeleted += toNumber(detached[0]?.deleted);

      for (let i = 0; i < nodeIdsToDelete.length; i += BATCH_SIZE) {
        options?.signal?.throwIfAborted();
        await write(
          `
          UNWIND $ids AS nodeId
          MATCH (n:CodeNode {id: nodeId})
          DETACH DELETE n
          `,
          { ids: nodeIdsToDelete.slice(i, i + BATCH_SIZE) },
        );
      }
      // Input-length based, mirroring SQLite (counts ids requested, not rows matched).
      counts.nodesDeleted += nodeIdsToDelete.length;
      endPhase('neo4j.nodeDelete');
    }

    // 2. Upsert added + updated nodes. Grouped by concrete label exactly like
    //    pushNodes so reads that match a concrete label (:Entrypoint, :ExternalCall…)
    //    still resolve; full-replace drops props removed in the new version.
    if (upsertNodes.length > 0) {
      let nodeProgress = 0;
      const nodesByLabel = new Map<string, GraphNode[]>();
      for (const node of upsertNodes) {
        const label = NODE_TYPE_TO_LABEL[node.type] ?? node.type;
        if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
        nodesByLabel.get(label)!.push(node);
      }

      for (const [label, batch] of nodesByLabel) {
        // SET n:CodeNode after the MERGE (not in the pattern) so a re-push never
        // forks a second node, matching pushNodes. Full-replace then tags + stamps.
        const query = `
          UNWIND $batch AS item
          MERGE (n:${label} {id: item.id})
          SET n = item.props
          SET n:CodeNode, n.updated = timestamp()
        `;
        for (let i = 0; i < batch.length; i += BATCH_SIZE) {
          options?.signal?.throwIfAborted();
          const items = batch.slice(i, i + BATCH_SIZE).map((node) => ({
            id: node.id,
            props: {
              id: node.id,
              name: node.name,
              ...flattenForNeo4j(node.properties),
              summary: node.summary,
              embedding: node.embedding,
              filePath: node.filePath,
              startLine: node.startLine,
              endLine: node.endLine,
            },
          }));
          await write(query, { batch: items });
          nodeProgress += items.length;
          options?.onBatch?.({ kind: 'nodes', completed: nodeProgress, total: upsertNodes.length });
        }
      }
      counts.nodesAdded = changeset.nodesToAdd.length;
      counts.nodesUpdated = changeset.nodesToUpdate.length;
      endPhase('neo4j.nodeUpsert');
    }

    // 3. Wipe edges incident to still-present affected nodes (source OR target),
    //    measured. Index-driven from each wipe node via :CodeNode(id); DISTINCT
    //    collapses an edge seen from both endpoints so it is counted and deleted
    //    once. Safe across chunks because an edge deleted in an earlier batch is
    //    gone for later ones (no cross-batch double count). `+=`: phase 1 already
    //    folded in the deleted-node edges.
    const edgeTypesToPreserve = [...new Set(changeset.edgeTypesToPreserve ?? [])];
    for (let i = 0; i < changeset.edgeNodeIdsToWipe.length; i += BATCH_SIZE) {
      options?.signal?.throwIfAborted();
      const rows = await write<{ deleted: unknown }>(
        `
        UNWIND $wipe AS wid
        MATCH (n:CodeNode {id: wid})-[r]-()
        WITH DISTINCT r
        WHERE NOT type(r) IN $preservedEdgeTypes
        DELETE r
        RETURN count(r) AS deleted
        `,
        { wipe: changeset.edgeNodeIdsToWipe.slice(i, i + BATCH_SIZE), preservedEdgeTypes: edgeTypesToPreserve },
      );
      counts.edgesDeleted += toNumber(rows[0]?.deleted);
    }
    if (changeset.edgeNodeIdsToWipe.length > 0) endPhase('neo4j.edgeWipe');

    // 4. Insert fresh edges. Grouped by type like pushEdges; endpoints must already
    //    exist (phase 2 ran) — a row whose endpoint is absent no-ops, exactly as
    //    pushEdges does. Full-replace mirrors SQLite UPSERT while preserving
    //    an existing relationship id when only endpoint/type identity matches.
    if (changeset.edgesToInsert.length > 0) {
      let edgeProgress = 0;
      // Full rebuild wiped this repo's graph in phase 0, so no pre-existing
      // relationship can carry an incoming id — the rewire pre-pass below
      // would be a guaranteed-miss property scan per batch. Edge ids are
      // content-derived per repo, so a wipe of the changeset repo is
      // sufficient to skip it.
      const repoWiped = (changeset.repoIdsToDelete ?? []).includes(changeset.repoId);
      const edgesByType = new Map<string, GraphEdge[]>();
      for (const edge of changeset.edgesToInsert) {
        if (!edgesByType.has(edge.type)) edgesByType.set(edge.type, []);
        edgesByType.get(edge.type)!.push(edge);
      }

      for (const [type, batch] of edgesByType) {
        const query = `
          UNWIND $batch AS item
          MATCH (from:CodeNode {id: item.sourceId})
          MATCH (to:CodeNode {id: item.targetId})
          MERGE (from)-[r:${type}]->(to)
          WITH r, item, coalesce(r.id, item.id) AS edgeId
          SET r = item.props, r.id = edgeId, r.updated = timestamp()
        `;
        for (let i = 0; i < batch.length; i += BATCH_SIZE) {
          options?.signal?.throwIfAborted();
          const slice = batch.slice(i, i + BATCH_SIZE);
          const items = slice.map((edge) => ({
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            id: edge.id,
            props: {
              ...flattenForNeo4j(edge.properties),
              confidence: edge.confidence,
              createdBy: edge.createdBy,
            },
          }));
          // SQLite's ON CONFLICT(id) clause moves an existing edge to the
          // incoming endpoints/type. Relationships cannot be rewired in
          // Neo4j, so delete that exact id first when its endpoints differ;
          // the MERGE below recreates it at the requested identity. When the
          // endpoint/type identity already exists under another id, MERGE
          // preserves that existing id via coalesce(r.id, item.id). Backed by
          // the rel_*_id indexes from ensureGraphIndexes. An id derived from its
          // own endpoints (`source:TYPE:target`, the transformer's form) can only
          // ever name an edge between those endpoints, so such a batch has
          // nothing to move.
          if (!repoWiped && !slice.every(isEndpointDerivedEdgeId)) {
            await write(
              `
              UNWIND $batch AS item
              MATCH (oldFrom:CodeNode)-[existing:${type} {id: item.id}]->(oldTo:CodeNode)
              WHERE oldFrom.id <> item.sourceId OR oldTo.id <> item.targetId
              DELETE existing
              `,
              { batch: items },
            );
          }
          await write(query, { batch: items });
          edgeProgress += items.length;
          options?.onBatch?.({ kind: 'edges', completed: edgeProgress, total: changeset.edgesToInsert.length });
        }
      }
      counts.edgesInserted = changeset.edgesToInsert.length;
      endPhase('neo4j.edgeInsert');
    }

    for (let i = 0; i < metadataUpdates.length; i += BATCH_SIZE) {
      options?.signal?.throwIfAborted();
      const batch = metadataUpdates.slice(i, i + BATCH_SIZE).map((update) => ({
        id: update.id,
        hasSummary: update.summary !== undefined,
        summary: update.summary ?? null,
        hasEmbedding: update.embedding !== undefined,
        embedding: update.embedding ?? null,
        props: flattenForNeo4j(update.properties),
      }));
      await write(
        `
        UNWIND $batch AS item
        MATCH (n:CodeNode {id: item.id})
        SET n += item.props, n.updated = timestamp()
        FOREACH (_ IN CASE WHEN item.hasSummary THEN [1] ELSE [] END | SET n.summary = item.summary)
        FOREACH (_ IN CASE WHEN item.hasEmbedding THEN [1] ELSE [] END | SET n.embedding = item.embedding)
        `,
        { batch },
      );
      options?.onBatch?.({
        kind: 'metadata',
        completed: Math.min(i + batch.length, metadataUpdates.length),
        total: metadataUpdates.length,
      });
    }
    counts.nodesUpdated += metadataUpdates.length;
    if (metadataUpdates.length > 0) endPhase('neo4j.metadata');

    const receipt: GraphApplyReceipt = {
      ...counts,
      ...(options?.snapshot
        ? {
            totalNodeCount: options.snapshot.totalNodeCount,
            totalEdgeCount: options.snapshot.totalEdgeCount,
          }
        : {}),
    };

    // The snapshot is the commit marker: written last, it also clears the
    // in-flight mark set above.
    if (options?.snapshot) {
      const snapshot: AppliedGraphSnapshot = {
        ...options.snapshot,
        nodeCount: options.snapshot.totalNodeCount,
        edgeCount: options.snapshot.totalEdgeCount,
        receipt,
        appliedAt: new Date().toISOString(),
      };
      const encoded = JSON.stringify(snapshot);
      const stored = await write<{ snapshot: string }>(
        `
        MATCH (repo:CodeNode {id: $repoId})
        MERGE (meta:CoredocMeta {repoId: $repoId})
        SET meta.snapshot = $snapshot
        REMOVE meta.applyPending
        RETURN meta.snapshot AS snapshot
        `,
        { repoId: changeset.repoId, snapshot: encoded },
      );
      if (stored[0]?.snapshot !== encoded) {
        throw new Error(`Cannot record graph snapshot: repository node ${changeset.repoId} is missing`);
      }
      endPhase('neo4j.snapshot');
    }

    return receipt;
  }

  // -------------------------------------------------------------------------
  // Cross-Repo
  // -------------------------------------------------------------------------

  async getExternalCalls(repoHashes: string[], targetService?: string): Promise<ExternalCallInfo[]> {
    const repoFilter = buildRepoFilter('ec', repoHashes);

    // Only bind $targetService when it is actually used — neo4j-driver rejects
    // `undefined` parameter values, so `{ targetService: undefined }` (the
    // common MCP call with no service filter) would throw at tx.run.
    //
    // Match on the call's EFFECTIVE target: `targetService` is the parser-emitted
    // canonical service, `serviceName` may be the client/SDK identity instead, so
    // filtering on serviceName alone returns nothing for any repo whose profile
    // fills both. The read side uses three levels: targetService first, then the
    // repo the call RESOLVES_TO (`resolvedTargetRepoName` — the only name a
    // Swift/Kotlin client has, since its profile emits an empty serviceName), then
    // serviceName as the fallback for rows that predate targetService. linker.ts
    // and the from-turso mapper adapter are unchanged and still resolve
    // targetService → serviceName only; this wider precedence is read-side only.
    const queryParams: Record<string, unknown> = {};
    let serviceFilter = '';
    if (targetService) {
      serviceFilter = `WHERE coalesce(ec.targetService, resolvedTargetRepoName, ec.serviceName) = $targetService`;
      queryParams.targetService = targetService;
    }

    // The repository node is joined off the persisted `resolvedTargetId` the same way
    // SQLite and Ladybug do it: look the TARGET node up by its indexed id, then take the
    // repo that owns it. Neo4j nodes carry no `repoId` property (upsertNodes writes id,
    // name, flattened properties and the location columns), so the owning repo id is the
    // `{repoHash}:{type}:…` prefix — and for a Repository node, the whole id, which
    // `split(...)[0]` also yields. Going through the target (not a bare `:Repository`
    // label scan matched by prefix) means a DANGLING resolvedTargetId names nothing on
    // every backend, instead of naming a repo on Neo4j alone.
    // REVIEW-ONLY: no in-process Neo4j test exists (see repository-contract.test.ts
    // header); this Cypher is verified by reading, not by execution.
    const query = `
      MATCH (caller:Function)-[:MAKES_EXTERNAL_CALL]->(ec:ExternalCall)
      WHERE ${repoFilter}
      OPTIONAL MATCH (target:CodeNode {id: ec.resolvedTargetId})
      OPTIONAL MATCH (targetRepo:Repository {id: split(target.id, ':')[0]})
      WITH caller, ec, targetRepo.name as resolvedTargetRepoName
      ${serviceFilter}
      RETURN ec.id as id,
             ec.callerId as callerId,
             caller.name as callerName,
             caller.filePath as callerFilePath,
             ec.serviceName as serviceName,
             ec.targetService as targetService,
             ec.sdkName as sdkName,
             ec.method as method,
             ec.protocol as protocol,
             ec.httpMethod as httpMethod,
             ec.pathTemplate as pathTemplate,
             ec.messagingSystem as messagingSystem,
             ec.messagingDestination as messagingDestination,
             ec.messagingDestinationRef as messagingDestinationRef,
             ec.ipcDirection as ipcDirection,
             ec.grpcService as grpcService,
             ec.grpcMethod as grpcMethod,
             ec.graphqlOperationType as graphqlOperationType,
             ec.graphqlOperationName as graphqlOperationName,
             ec.monikerPackage as monikerPackage,
             ec.monikerDescriptor as monikerDescriptor,
             ec.dispatchMethod as dispatchMethod,
             ec.resolvedTargetId as resolvedTargetId,
             resolvedTargetRepoName,
             ec.filePath as filePath,
             ec.startLine as startLine
      ORDER BY caller.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<ExternalCallRow>(query, queryParams);
    });

    return results.map((row) => externalCallInfoFromRow({ ...row, startLine: toNumber(row.startLine) }));
  }

  async getExternalCallsWithMessaging(repoHashes: string[]): Promise<MessagingExternalCall[]> {
    const repoFilter = buildRepoFilter('ec', repoHashes);

    // Destination filter in Cypher and a narrow projection — destination tracing
    // never needs the full external-call row set. No ORDER BY: callers group later.
    const query = `
      MATCH (caller:Function)-[:MAKES_EXTERNAL_CALL]->(ec:ExternalCall)
      WHERE ${repoFilter}
        AND ec.messagingDestination IS NOT NULL
      RETURN ec.id as id,
             caller.name as callerName,
             ec.filePath as filePath,
             ec.startLine as startLine,
             ec.messagingSystem as system,
             ec.messagingDestination as destination,
             ec.messagingDestinationRef as destinationRef
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        callerName: string | null;
        filePath: string;
        startLine: number;
        system: string | null;
        destination: string;
        destinationRef: string | null;
      }>(query);
    });

    return results.map((row) => ({
      id: row.id,
      callerName: row.callerName || 'unknown',
      filePath: row.filePath,
      startLine: toNumber(row.startLine),
      system: row.system || undefined,
      destination: row.destination,
      destinationRef: row.destinationRef || undefined,
    }));
  }

  async getExternalCallsFrom(functionId: string, repoHashes: string[]): Promise<ExternalCallInfo[]> {
    const repoFilter = buildRepoFilter('ec', repoHashes);

    // Same read-time derivation as getExternalCalls: the target node is looked up by its
    // indexed id and the repo that owns it supplies the name, so `explain` names a
    // resolved target on every backend — and a dangling id names nothing on all three.
    const query = `
      MATCH (caller:Function {id: $functionId})-[:MAKES_EXTERNAL_CALL]->(ec:ExternalCall)
      WHERE ${repoFilter}
      OPTIONAL MATCH (target:CodeNode {id: ec.resolvedTargetId})
      OPTIONAL MATCH (targetRepo:Repository {id: split(target.id, ':')[0]})
      WITH caller, ec, targetRepo.name as resolvedTargetRepoName
      RETURN ec.id as id,
             ec.callerId as callerId,
             caller.name as callerName,
             caller.filePath as callerFilePath,
             ec.serviceName as serviceName,
             ec.targetService as targetService,
             ec.sdkName as sdkName,
             ec.method as method,
             ec.protocol as protocol,
             ec.httpMethod as httpMethod,
             ec.pathTemplate as pathTemplate,
             ec.messagingSystem as messagingSystem,
             ec.messagingDestination as messagingDestination,
             ec.messagingDestinationRef as messagingDestinationRef,
             ec.ipcDirection as ipcDirection,
             ec.grpcService as grpcService,
             ec.grpcMethod as grpcMethod,
             ec.graphqlOperationType as graphqlOperationType,
             ec.graphqlOperationName as graphqlOperationName,
             ec.monikerPackage as monikerPackage,
             ec.monikerDescriptor as monikerDescriptor,
             ec.dispatchMethod as dispatchMethod,
             ec.resolvedTargetId as resolvedTargetId,
             resolvedTargetRepoName,
             ec.filePath as filePath,
             ec.startLine as startLine
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<ExternalCallRow>(query, { functionId });
    });

    return results.map((row) => externalCallInfoFromRow({ ...row, startLine: toNumber(row.startLine) }));
  }

  // -------------------------------------------------------------------------
  // Dynamic boundaries (statically unresolved calls)
  // -------------------------------------------------------------------------

  // Intentional empty fallback: Neo4j is a shared, externally-managed store and
  // this changeset writes no unresolved calls to it, so there is nothing to
  // read. Answering empty is the same degradation a pre-feature graph gets —
  // the consuming tools omit their boundary section instead of failing.
  async findUnresolvedCallsByNameTail(): Promise<UnresolvedCallRecord[]> {
    return [];
  }

  async findUnresolvedCallsInFiles(): Promise<UnresolvedCallRecord[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier B — explorer)
  // -------------------------------------------------------------------------

  async getNodesByIds(ids: string[], repoHashes: string[]): Promise<VizNode[]> {
    if (ids.length === 0) return [];
    const query = `
      MATCH (n:CodeNode)
      WHERE n.id IN $ids AND ${buildNeighborRepoFilterCypher('n', repoHashes)}
      OPTIONAL MATCH (rp:Repository { id: head(split(n.id, ':')) })
      RETURN ${vizNodeReturnCols('n', 'rp')}
    `;
    const rows = await this.driver.withReadTransaction(async (tx) => tx.run<Neo4jVizRow>(query, { ids }));
    return rows.map(neoVizNode);
  }

  async getNeighborCounts(nodeId: string, repoHashes: string[]): Promise<NeighborCount[]> {
    const nbFilter = buildNeighborRepoFilterCypher('nb', repoHashes);
    // count(*) auto-groups by the non-aggregated return keys (edgeType,
    // direction). Two directed matches, UNION ALL'd — the literal direction
    // differs so there is nothing to dedup.
    const query = `
      MATCH (focus:CodeNode { id: $nodeId })-[e]->(nb:CodeNode)
      WHERE ${nbFilter}
      RETURN type(e) AS edgeType, 'out' AS direction, count(*) AS count
      UNION ALL
      MATCH (focus:CodeNode { id: $nodeId })<-[e]-(nb:CodeNode)
      WHERE ${nbFilter}
      RETURN type(e) AS edgeType, 'in' AS direction, count(*) AS count
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ edgeType: string; direction: string; count: unknown }>(query, { nodeId }),
    );
    return rows.map((r) => ({
      edgeType: r.edgeType as EdgeType,
      direction: r.direction as EdgeDirection,
      count: toNumber(r.count),
    }));
  }

  async getNeighbors(nodeId: string, params: GetNeighborsParams, repoHashes: string[]): Promise<NeighborsResult> {
    const direction = params.direction ?? 'both';
    const limit = clampLimit(params.limit, NEIGHBOR_LIMIT.max, NEIGHBOR_LIMIT.fallback);
    const nbFilter = buildNeighborRepoFilterCypher('nb', repoHashes);
    // One directed (or, for 'both', undirected) match handles all three
    // directions without a UNION — the SQLite path's two-arm union collapses to
    // a single pattern here. Edge orientation in the projection stays true
    // source→target via startNode/endNode, not focus-relative.
    const arrow = direction === 'out' ? '-[e]->' : direction === 'in' ? '<-[e]-' : '-[e]-';

    const bind: Record<string, unknown> = { nodeId, limitPlus1: toInt(limit + 1) };
    let edgeTypeClause = '';
    if (params.edgeTypes && params.edgeTypes.length > 0) {
      edgeTypeClause = 'AND type(e) IN $edgeTypes';
      bind.edgeTypes = params.edgeTypes;
    }
    let cursorClause = '';
    if (params.cursor) {
      cursorClause = 'AND e.id > $cursor';
      bind.cursor = params.cursor;
    }

    // Keyset-paginate by the unique edge id, fetching limit+1 to learn whether a
    // further page exists.
    const query = `
      MATCH (focus:CodeNode { id: $nodeId })${arrow}(nb:CodeNode)
      WHERE ${nbFilter} ${edgeTypeClause} ${cursorClause}
      OPTIONAL MATCH (rp:Repository { id: head(split(nb.id, ':')) })
      RETURN e.id AS edgeId, startNode(e).id AS edgeSource, endNode(e).id AS edgeTarget,
             type(e) AS edgeType, e.confidence AS confidence, e.createdBy AS createdBy, e.operation AS edgeOperation,
             ${vizNodeReturnCols('nb', 'rp')}
      ORDER BY edgeId
      LIMIT $limitPlus1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<
        Neo4jVizRow & {
          edgeId: string;
          edgeSource: string;
          edgeTarget: string;
          edgeType: string;
          confidence: unknown;
          createdBy: string;
          edgeOperation: string | null;
        }
      >(query, bind),
    );

    const { page, ...pageFacts } = pageSlice(rows, limit, (row) => row.edgeId);

    const nodes: VizNode[] = [];
    const seenNodes = new Set<string>();
    const edges: VizEdge[] = [];
    const seenEdges = new Set<string>();
    for (const row of page) {
      if (!seenEdges.has(row.edgeId)) {
        seenEdges.add(row.edgeId);
        edges.push(
          buildVizEdge({
            id: row.edgeId,
            sourceId: row.edgeSource,
            targetId: row.edgeTarget,
            type: row.edgeType as EdgeType,
            confidence: toNumber(row.confidence),
            createdBy: row.createdBy,
            operation: row.edgeOperation,
          }),
        );
      }
      if (!seenNodes.has(row.id)) {
        seenNodes.add(row.id);
        nodes.push(neoVizNode(row));
      }
    }

    return { nodes, edges, ...pageFacts };
  }

  async listNodesByType(
    type: NodeType,
    params: { limit: number; cursor?: string },
    repoHashes: string[],
  ): Promise<VizNodePage> {
    const label = NODE_TYPE_TO_LABEL[type];
    if (!label) return { nodes: [], truncated: false };
    const limit = clampLimit(params.limit, NODE_PAGE_LIMIT.max, NODE_PAGE_LIMIT.fallback);
    const bind: Record<string, unknown> = { limitPlus1: toInt(limit + 1) };
    let cursorClause = '';
    if (params.cursor) {
      cursorClause = 'AND n.id > $cursor';
      bind.cursor = params.cursor;
    }
    // Label is looked up from the fixed NODE_TYPE_TO_LABEL map (never user
    // input), so interpolating it is safe — Cypher can't parameterize labels.
    const query = `
      MATCH (n:\`${label}\`)
      WHERE ${buildNeighborRepoFilterCypher('n', repoHashes)} ${cursorClause}
      OPTIONAL MATCH (rp:Repository { id: head(split(n.id, ':')) })
      RETURN ${vizNodeReturnCols('n', 'rp')}
      ORDER BY id
      LIMIT $limitPlus1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) => tx.run<Neo4jVizRow>(query, bind));
    const { page, ...pageFacts } = pageSlice(rows, limit, (row) => row.id);
    return { nodes: page.map(neoVizNode), ...pageFacts };
  }

  async getNodeWithProperties(
    id: string,
    repoHashes: string[],
  ): Promise<{ node: VizNode; properties: Record<string, unknown> } | null> {
    const query = `
      MATCH (n:CodeNode { id: $id })
      WHERE ${buildNeighborRepoFilterCypher('n', repoHashes)}
      OPTIONAL MATCH (rp:Repository { id: head(split(n.id, ':')) })
      RETURN ${vizNodeReturnCols('n', 'rp')}, properties(n) AS props
      LIMIT 1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<Neo4jVizRow & { props: Record<string, unknown> | null }>(query, { id }),
    );
    const row = rows[0];
    if (!row) return null;
    return { node: neoVizNode(row), properties: normalizeNeoProperties(row.props ?? {}) };
  }

  /**
   * Public, unfiltered counterpart to the private `edgesAmong` helper below —
   * see the SQLite implementation for why both exist.
   */
  async getEdgesAmong(nodeIds: string[], repoHashes: string[], limit = 2000): Promise<EdgesAmongResult> {
    if (nodeIds.length === 0) return { edges: [], truncated: false };
    limit = clampLimit(limit, EDGES_AMONG_LIMIT.max, EDGES_AMONG_LIMIT.fallback);
    const query = `
      MATCH (a:CodeNode)-[e]->(b:CodeNode)
      WHERE a.id IN $ids AND b.id IN $ids AND ${buildRepoFilter('a', repoHashes)}
      RETURN e.id AS edgeId, startNode(e).id AS edgeSource, endNode(e).id AS edgeTarget,
             type(e) AS edgeType, e.confidence AS confidence, e.createdBy AS createdBy,
             e.operation AS edgeOperation
      ORDER BY e.id
      LIMIT $limitPlus1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        edgeId: string;
        edgeSource: string;
        edgeTarget: string;
        edgeType: string;
        confidence: unknown;
        createdBy: string;
        edgeOperation: string | null;
      }>(query, { ids: nodeIds, limitPlus1: toInt(limit + 1) }),
    );
    const { page, truncated } = pageSlice(rows, limit);
    return {
      truncated,
      edges: page.map((row) =>
        buildVizEdge({
          id: row.edgeId,
          sourceId: row.edgeSource,
          targetId: row.edgeTarget,
          type: row.edgeType as EdgeType,
          confidence: toNumber(row.confidence),
          createdBy: row.createdBy,
          operation: row.edgeOperation,
        }),
      ),
    };
  }

  /** VizEdge projection for the edges among an explicit node-id set (shared by
   *  getSubgraph). Mirror of the SQLite `edgesAmong`. */
  private async edgesAmong(ids: string[], edgeTypes: EdgeType[]): Promise<VizEdge[]> {
    if (ids.length === 0 || edgeTypes.length === 0) return [];
    const query = `
      MATCH (a:CodeNode)-[e]->(b:CodeNode)
      WHERE a.id IN $ids AND b.id IN $ids AND type(e) IN $edgeTypes
      RETURN e.id AS edgeId, startNode(e).id AS edgeSource, endNode(e).id AS edgeTarget,
             type(e) AS edgeType, e.confidence AS confidence, e.createdBy AS createdBy, e.operation AS edgeOperation
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        edgeId: string;
        edgeSource: string;
        edgeTarget: string;
        edgeType: string;
        confidence: unknown;
        createdBy: string;
        edgeOperation: string | null;
      }>(query, { ids, edgeTypes }),
    );
    return rows.map((row) =>
      buildVizEdge({
        id: row.edgeId,
        sourceId: row.edgeSource,
        targetId: row.edgeTarget,
        type: row.edgeType as EdgeType,
        confidence: toNumber(row.confidence),
        createdBy: row.createdBy,
        operation: row.edgeOperation,
      }),
    );
  }

  async getSubgraph(rootId: string, params: SubgraphParams, repoHashes: string[]): Promise<NeighborsResult> {
    const direction = params.direction ?? 'both';
    const nodeCap = clampLimit(params.nodeCap, SUBGRAPH_NODE_CAP.max, SUBGRAPH_NODE_CAP.fallback);
    const edgeTypes =
      params.edgeTypes && params.edgeTypes.length > 0 ? params.edgeTypes : [...SUBGRAPH_FLOW_EDGE_TYPES];
    // Rel types + depth are interpolated (Cypher can't parameterize either); the
    // types are validated enum values and intDepth guards the bound. The root is
    // added back explicitly so it survives the neighbour cap.
    const relTypes = edgeTypes.join('|');
    const d = intDepth(params.depth, 1);
    const arrow =
      direction === 'out'
        ? `-[:${relTypes}*1..${d}]->`
        : direction === 'in'
          ? `<-[:${relTypes}*1..${d}]-`
          : `-[:${relTypes}*1..${d}]-`;

    const idQuery = `
      MATCH path = (root:CodeNode { id: $rootId })${arrow}(nb:CodeNode)
      WITH nb, min(length(path)) AS distance
      RETURN nb.id AS id
      ORDER BY distance, nb.id
      LIMIT $capPlus1
    `;
    const idRows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ id: string }>(idQuery, { rootId, capPlus1: toInt(nodeCap + 1) }),
    );
    const reached = idRows.map((r) => r.id).filter((id) => id !== rootId);
    const truncated = reached.length > nodeCap;
    const ids = [rootId, ...(truncated ? reached.slice(0, nodeCap) : reached)];

    const [nodes, edges] = await Promise.all([this.getNodesByIds(ids, repoHashes), this.edgesAmong(ids, edgeTypes)]);
    return { nodes, edges, truncated };
  }

  async findDeadNodes(params: DeadCodeParams, repoHashes: string[]): Promise<DeadCodePage> {
    const types = params.types && params.types.length > 0 ? params.types : [...DEAD_CODE_DEFAULT_TYPES];
    const limit = clampLimit(params.limit, DEAD_NODE_LIMIT.max, DEAD_NODE_LIMIT.fallback);
    const bind: Record<string, unknown> = { limitPlus1: toInt(limit + 1) };
    if (params.cursor) bind.cursor = params.cursor;

    const labelArms: string[] = [];
    const usageArms: string[] = [];
    types.forEach((t, i) => {
      const label = NODE_TYPE_TO_LABEL[t] ?? t;
      labelArms.push(`n:\`${label}\``);
      bind[`usage${i}`] = [...deadCodeUsageEdges(t)];
      usageArms.push(`(n:\`${label}\` AND NOT EXISTS { MATCH (n)<-[u]-() WHERE type(u) IN $usage${i} })`);
    });
    const cursorClause = params.cursor ? 'AND n.id > $cursor' : '';
    const query = `
      MATCH (n:CodeNode)
      WHERE ${buildRepoFilter('n', repoHashes)}
        AND (${labelArms.join(' OR ')})
        AND coalesce(n.isExported, false) = false
        AND (${usageArms.join(' OR ')})
        ${cursorClause}
      OPTIONAL MATCH (rp:Repository { id: head(split(n.id, ':')) })
      RETURN ${vizNodeReturnCols('n', 'rp')}
      ORDER BY id
      LIMIT $limitPlus1
    `;
    const [rows, coverage] = await Promise.all([
      this.driver.withReadTransaction(async (tx) => tx.run<Neo4jVizRow>(query, bind)),
      this.getCoverageCounts(repoHashes),
    ]);
    const { page, ...pageFacts } = pageSlice(rows, limit, (row) => row.id);
    return {
      nodes: page.map(neoVizNode),
      lowCoverageRepos: lowCoverageRepoNames(coverage),
      ...pageFacts,
    };
  }

  async getCrossRepoBridges(params: CrossRepoBridgeParams, repoHashes: string[]): Promise<NeighborsResult> {
    const limit = clampLimit(params.limit, BRIDGE_LIMIT.max, BRIDGE_LIMIT.fallback);
    const bind: Record<string, unknown> = { limitPlus1: toInt(limit + 1) };

    const scopeFilter =
      repoHashes.length === 0
        ? 'true'
        : `(${buildRepoFilter('ec', repoHashes)} OR ${buildRepoFilter('ep', repoHashes)})`;
    const focusFilter =
      params.focusRepoHashes && params.focusRepoHashes.length > 0
        ? `(${buildRepoFilter('ec', params.focusRepoHashes)} OR ${buildRepoFilter('ep', params.focusRepoHashes)})`
        : 'true';

    // Cap the number of BRIDGES with a WITH…LIMIT before the optional expansions
    // so the caller/handler fan-out can't skew the limit — mirror of the SQLite
    // CTE. "Different repo" = different id hash prefix.
    const query = `
      MATCH (ec:ExternalCall)-[rt:RESOLVES_TO]->(ep:Entrypoint)
      WHERE head(split(ec.id, ':')) <> head(split(ep.id, ':'))
        AND ${scopeFilter}
        AND ${focusFilter}
      WITH ec, ep, rt ORDER BY rt.id LIMIT $limitPlus1
      OPTIONAL MATCH (caller:Function)-[mec:MAKES_EXTERNAL_CALL]->(ec)
      OPTIONAL MATCH (ep)-[hnd:HANDLES]->(handler:Function)
      RETURN rt.id AS rtId, ec.id AS ecId, ep.id AS epId, rt.confidence AS rtConf, rt.createdBy AS rtBy,
             mec.id AS mecId, caller.id AS callerId, mec.confidence AS mecConf, mec.createdBy AS mecBy,
             hnd.id AS hndId, handler.id AS handlerId, hnd.confidence AS hndConf, hnd.createdBy AS hndBy
      ORDER BY rt.id
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        rtId: string;
        ecId: string;
        epId: string;
        rtConf: unknown;
        rtBy: string | null;
        mecId: string | null;
        callerId: string | null;
        mecConf: unknown;
        mecBy: string | null;
        hndId: string | null;
        handlerId: string | null;
        hndConf: unknown;
        hndBy: string | null;
      }>(query, bind),
    );

    const rtOrder: string[] = [];
    const seenRt = new Set<string>();
    for (const r of rows) {
      if (!seenRt.has(r.rtId)) {
        seenRt.add(r.rtId);
        rtOrder.push(r.rtId);
      }
    }
    const truncated = rtOrder.length > limit;
    const keepRt = new Set(rtOrder.slice(0, limit));

    const nodeIds = new Set<string>();
    const edges: VizEdge[] = [];
    const seenEdges = new Set<string>();
    const pushEdge = (
      id: string | null,
      sourceId: string | null,
      targetId: string | null,
      type: EdgeType,
      conf: unknown,
      by: string | null,
    ): void => {
      if (!id || !sourceId || !targetId || seenEdges.has(id)) return;
      seenEdges.add(id);
      edges.push(
        buildVizEdge({
          id,
          sourceId,
          targetId,
          type,
          confidence: conf == null ? 1 : toNumber(conf),
          createdBy: by ?? 'parser',
        }),
      );
    };
    for (const r of rows) {
      if (!keepRt.has(r.rtId)) continue;
      nodeIds.add(r.ecId);
      nodeIds.add(r.epId);
      if (r.callerId) nodeIds.add(r.callerId);
      if (r.handlerId) nodeIds.add(r.handlerId);
      pushEdge(r.mecId, r.callerId, r.ecId, EdgeType.MakesExternalCall, r.mecConf, r.mecBy);
      pushEdge(r.rtId, r.ecId, r.epId, EdgeType.ResolvesTo, r.rtConf, r.rtBy);
      pushEdge(r.hndId, r.epId, r.handlerId, EdgeType.Handles, r.hndConf, r.hndBy);
    }
    const nodes = await this.getNodesByIds([...nodeIds], repoHashes);
    return { nodes, edges, truncated };
  }

  /**
   * Run a read-only Cypher query after the allowlist guard has passed, adding
   * Neo4j's own planner classification as defense-in-depth below the boundary.
   *
   * The allowlist (`assertReadOnlyCypherAllowlisted`) is the security boundary.
   * READ access mode / a read transaction is routing, not a guarantee. `EXPLAIN`
   * plans the query WITHOUT executing it; we require the planner's `queryType`
   * to be exactly `'r'` (read-only) and fail closed on `rw`/`w`/`s`/unknown.
   * `queryType` is not re-exported by the `neo4j-driver` facade, so we compare
   * the string literal directly.
   *
   * When source-in-graph serving is OFF, reject any query that references a
   * source-bearing property BEFORE execution (query-side, not output-scan): an
   * output-scan is bypassable in-engine — `MATCH (n:CodeNode) RETURN
   * n.sourceCode AS s` projects source under a name the scanner never sees.
   * This runs once per query, alongside the classification, below the boundary.
   */
  private async runClassifiedNeoRead(
    query: string,
    params: Record<string, CypherScalar>,
  ): Promise<{
    records: Array<{
      keys: ReadonlyArray<string | number>;
      get: (key: string) => unknown;
      values: () => Iterable<unknown>;
    }>;
  }> {
    if (!allowSourcesInGraph()) assertQueryDoesNotProjectSource(query);
    const driver = await this.driver.getOriginalDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });
    try {
      const explained = await session.executeRead((tx) => tx.run(`EXPLAIN ${query}`, params), {
        timeout: CYPHER_TIMEOUT_MS,
      });
      const queryType = explained.summary?.queryType;
      if (queryType !== 'r') {
        throw new Error(
          `Only read-only Cypher is allowed (Neo4j classified this query as "${queryType ?? 'unknown'}")`,
        );
      }
      return await session.executeRead((tx) => tx.run(query, params), { timeout: CYPHER_TIMEOUT_MS });
    } finally {
      await session.close();
    }
  }

  async runReadOnlyCypher(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherGraphResult> {
    assertReadOnlyCypherAllowlisted(query, 'neo4j');
    // Source protection (when the serve flag is off) is enforced query-side in
    // runClassifiedNeoRead, before execution — an output-scan here would be
    // bypassable by projecting source under an alias.
    const res = await this.runClassifiedNeoRead(query, opts.params ?? {});

    const nodesByOurId = new Map<string, VizNode>();
    const internalToOurId = new Map<string, string>();
    const rawRels: NeoGraphRelLike[] = [];
    let capped = false;

    for (const record of res.records) {
      for (const value of record.values()) {
        for (const el of graphElements(value)) {
          if (isNeoGraphRel(el)) {
            rawRels.push(el);
            continue;
          }
          const viz = neoCypherNodeToViz(el);
          if (!viz) continue;
          internalToOurId.set(String(el.identity), viz.id);
          if (!nodesByOurId.has(viz.id)) {
            if (nodesByOurId.size >= opts.limit) {
              capped = true;
              continue;
            }
            nodesByOurId.set(viz.id, viz);
          }
        }
      }
    }

    const edgesById = new Map<string, VizEdge>();
    for (const rel of rawRels) {
      const src = internalToOurId.get(String(rel.start));
      const tgt = internalToOurId.get(String(rel.end));
      if (!src || !tgt) continue; // endpoint not among the returned nodes
      const props = rel.properties ?? {};
      const edgeId = typeof props.id === 'string' && props.id ? props.id : `${src}|${rel.type}|${tgt}`;
      if (edgesById.has(edgeId)) continue;
      if (edgesById.size >= opts.limit) {
        capped = true;
        continue;
      }
      edgesById.set(
        edgeId,
        buildVizEdge({
          id: edgeId,
          sourceId: src,
          targetId: tgt,
          type: rel.type as EdgeType,
          confidence: props.confidence != null ? toNumber(props.confidence) : 1,
          createdBy: typeof props.createdBy === 'string' ? props.createdBy : 'parser',
        }),
      );
    }

    return { nodes: [...nodesByOurId.values()], edges: [...edgesById.values()], truncated: capped };
  }

  /**
   * Rows shape of a read-only Cypher read: a scalar table. Same boundary as the
   * graph shape (allowlist → EXPLAIN classification). Each cell is normalized to
   * a `CypherScalar`; composite cells (maps/lists/nodes/relationships/temporal/
   * spatial) are rejected with projection guidance.
   */
  async runReadOnlyCypherRows(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherRowsResult> {
    assertReadOnlyCypherAllowlisted(query, 'neo4j');
    // Source protection (when the serve flag is off) is enforced query-side in
    // runClassifiedNeoRead, before execution — see runReadOnlyCypher.
    const res = await this.runClassifiedNeoRead(query, opts.params ?? {});

    const columns = res.records.length > 0 ? res.records[0]!.keys.map(String) : [];
    const rows: CypherScalar[][] = [];
    let truncated = false;
    for (const record of res.records) {
      if (rows.length >= opts.limit) {
        truncated = true;
        break;
      }
      rows.push(columns.map((key) => normalizeCypherScalar(record.get(key))));
    }
    return { columns, rows, truncated };
  }

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier C — C4 architecture view)
  // -------------------------------------------------------------------------

  async getPackageDependencyRollup(repoHashes: string[]): Promise<PackageDependencyRollup[]> {
    // Resolve each CALLS endpoint to its package: function.fileId → File →
    // File.packageId → Package. Aggregate by package pair, excluding
    // intra-package calls. Scope-filter the source function.
    const repoFilter = buildRepoFilter('sfn', repoHashes);
    const query = `
      MATCH (sfn:Function)-[e:CALLS]->(tfn:Function)
      MATCH (sfile:File { id: sfn.fileId })
      MATCH (spkg:Package { id: sfile.packageId })
      MATCH (tfile:File { id: tfn.fileId })
      MATCH (tpkg:Package { id: tfile.packageId })
      WHERE ${repoFilter} AND spkg.id <> tpkg.id
      RETURN spkg.id AS sourcePackageId, spkg.name AS sourcePackageName,
             tpkg.id AS targetPackageId, tpkg.name AS targetPackageName,
             count(*) AS callCount, min(e.confidence) AS minConfidence,
             max(CASE WHEN e.createdBy <> 'parser' THEN 1 ELSE 0 END) AS inferred
      ORDER BY callCount DESC
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        sourcePackageId: string;
        sourcePackageName: string;
        targetPackageId: string;
        targetPackageName: string;
        callCount: unknown;
        minConfidence: unknown;
        inferred: unknown;
      }>(query),
    );
    return rows.map((r) => ({
      sourcePackageId: r.sourcePackageId,
      sourcePackageName: r.sourcePackageName,
      targetPackageId: r.targetPackageId,
      targetPackageName: r.targetPackageName,
      callCount: toNumber(r.callCount),
      minConfidence: toNumber(r.minConfidence),
      inferred: toNumber(r.inferred) === 1,
    }));
  }

  async getComponentGraph(repoHashes: string[]): Promise<ComponentGraphData> {
    const COMPONENT_LABELS = '(n:Entrypoint OR n:Component OR n:Class OR n:StateStore)';
    const nodeFilter = buildRepoFilter('n', repoHashes);
    const nodesQuery = `
      MATCH (n)
      WHERE ${COMPONENT_LABELS} AND ${nodeFilter}
      RETURN n.id AS id, [l IN labels(n) WHERE l <> 'CodeNode'][0] AS typeLabel, n.name AS name,
             n.filePath AS filePath, n.startLine AS startLine, n.summary AS summary
    `;
    const srcFilter = buildRepoFilter('s', repoHashes);
    const edgesQuery = `
      MATCH (s)-[e]->(t)
      WHERE (s:Entrypoint OR s:Component OR s:Class OR s:StateStore)
        AND (t:Entrypoint OR t:Component OR t:Class OR t:StateStore)
        AND ${srcFilter}
      RETURN startNode(e).id AS sourceId, endNode(e).id AS targetId, type(e) AS type,
             e.confidence AS confidence, e.createdBy AS createdBy
    `;
    return this.driver.withReadTransaction(async (tx) => {
      const [nodeRows, edgeRows] = await Promise.all([
        tx.run<{
          id: string;
          typeLabel: string;
          name: string;
          filePath: string | null;
          startLine: unknown;
          summary: string | null;
        }>(nodesQuery),
        tx.run<{ sourceId: string; targetId: string; type: string; confidence: unknown; createdBy: string }>(
          edgesQuery,
        ),
      ]);
      return {
        nodes: nodeRows.map((r) => ({
          id: r.id,
          type: normalizeNodeType(r.typeLabel) as ComponentGraphNode['type'],
          name: r.name,
          filePath: (r.filePath as string | null) ?? null,
          startLine: r.startLine != null ? toNumber(r.startLine) : null,
          ...(r.summary ? { summary: r.summary } : {}),
        })),
        edges: edgeRows.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          type: r.type as EdgeType,
          confidence: toNumber(r.confidence),
          createdBy: r.createdBy as ComponentGraphEdge['createdBy'],
        })),
      };
    });
  }

  async deleteEdgesByType(edgeType: EdgeType, repoIds: string[]): Promise<void> {
    if (repoIds.length === 0) return;

    // Scope the wipe to edges whose SOURCE node belongs to one of `repoIds`,
    // mirroring SQLite (`source_id IN (SELECT id FROM nodes WHERE repo_id IN …)`).
    // A node belongs to repo X iff its id starts with `<X>:` — node ids are
    // `{repoHash}:{type}:…` and `ParsedRepo.id === repoHash` (the value threaded
    // into nodes.repo_id).
    const sourceFilter = buildRepoFilter('source', repoIds);

    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `
        MATCH (source)-[r:${edgeType}]->()
        WHERE ${sourceFilter}
        DELETE r
        `,
        {},
      );
    });
  }

  async updateResolvedTargetIds(updates: Map<string, string>): Promise<void> {
    if (updates.size === 0) return;

    const items = Array.from(updates.entries()).map(([nodeId, targetId]) => ({ nodeId, targetId }));

    await this.driver.executeBatch(items, async (batch, tx) => {
      await tx.run(
        `
        UNWIND $batch AS item
        MATCH (n:ExternalCall {id: item.nodeId})
        SET n.resolvedTargetId = item.targetId
        `,
        { batch },
      );
    });
  }

  async clearResolvedTargetIds(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    await this.driver.executeBatch(nodeIds, async (batch, tx) => {
      await tx.run(
        `
        UNWIND $batch AS nodeId
        MATCH (n:ExternalCall {id: nodeId})
        WHERE n.resolvedTargetId IS NOT NULL
        REMOVE n.resolvedTargetId
        `,
        { batch },
      );
    });
  }

  async getResolvesEdge(sourceCallId: string): Promise<ResolvesEdgeInfo | null> {
    const query = `
      MATCH (src {id: $sourceCallId})-[r:RESOLVES_TO]->(tgt)
      RETURN r.id AS id, src.id AS sourceId, tgt.id AS targetId,
             r.confidence AS confidence, r.via AS via, r.chain AS chain,
             r.sourceRepoName AS sourceRepoName, r.targetRepoName AS targetRepoName,
             r.confidenceLevel AS confidenceLevel
      ORDER BY r.confidence DESC
      LIMIT 1
    `;

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string | null;
        sourceId: string;
        targetId: string;
        confidence: number | null;
        via: string | null;
        chain: string | unknown[] | null;
        sourceRepoName: string | null;
        targetRepoName: string | null;
        confidenceLevel: string | null;
      }>(query, { sourceCallId });
    });

    const row = rows[0];
    if (!row) return null;

    // `chain` is an array of hop objects; flattenForNeo4j JSON-encoded it on
    // push (Neo4j rejects arrays-of-maps). Decode it back to ResolvedHop[].
    let chain: ResolvedHop[] | undefined;
    if (typeof row.chain === 'string') {
      try {
        const parsed = JSON.parse(row.chain);
        if (Array.isArray(parsed)) chain = parsed as ResolvedHop[];
      } catch {
        chain = undefined;
      }
    } else if (Array.isArray(row.chain)) {
      chain = row.chain as ResolvedHop[];
    }

    return {
      id: row.id ?? `resolve:${row.sourceId}:${row.targetId}`,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: toNumber(row.confidence),
      via: (row.via as HopVia) ?? undefined,
      chain,
      sourceRepoName: row.sourceRepoName ?? undefined,
      targetRepoName: row.targetRepoName ?? undefined,
      confidenceLevel: row.confidenceLevel ?? undefined,
    };
  }

  async getMonikeredFunctions(repoHashes: string[]): Promise<FunctionInfo[]> {
    if (repoHashes.length === 0) return [];

    const repoFilter = buildRepoFilter('f', repoHashes);

    // SDK-source exported methods carry a SCIP moniker (monikerPackage) — the
    // subset consumed by the cross-repo symbol hop. monikerPackage/Descriptor
    // are flattened scalar properties on the :Function node (see
    // transformFunction), so they read directly without JSON decoding.
    const query = `
      MATCH (f:Function)
      WHERE ${repoFilter}
        AND f.monikerPackage IS NOT NULL
      RETURN f
      ORDER BY f.filePath, f.startLine
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ f: Record<string, unknown> }>(query, {});
    });

    // `monikerPackage IS NOT NULL` is the WHERE predicate, so the mapper always
    // emits `moniker` for these rows.
    return results.map((row) => functionInfoFromRow(nodeRow(row.f), row.f));
  }

  /**
   * Intra-repo CALLS edges whose target is one of `calleeIds` — the evidence the
   * cross-repo call-edge hop joins on. The callee set is bounded by the caller
   * (the monikered SDK method nodes), so this stays a keyed lookup rather than a
   * full CALLS scan.
   */
  async getInternalCallEdges(
    repoHashes: string[],
    calleeIds: string[],
  ): Promise<{ callerId: string; calleeId: string }[]> {
    if (calleeIds.length === 0) return [];

    const repoFilter = buildRepoFilter('caller', repoHashes);
    const query = `
      MATCH (caller:CodeNode)-[:CALLS]->(callee:CodeNode)
      WHERE callee.id IN $calleeIds
        AND ${repoFilter}
      RETURN DISTINCT caller.id AS callerId, callee.id AS calleeId
      ORDER BY callerId, calleeId
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ callerId: string; calleeId: string }>(query, { calleeIds }),
    );
    return rows.map((row) => ({ callerId: row.callerId, calleeId: row.calleeId }));
  }

  /**
   * Return every node carrying a stored embedding, with per-node provenance.
   * Only function/entrypoint nodes are embedded (transformer.mergeEmbeddings);
   * `embedding` is a native float array property and the provenance props are
   * flattened scalars, so both read back directly. Empty repoHashes = all
   * repos (buildRepoFilter's `true` convention), mirroring SQLite.
   */
  async getEmbeddedNodes(repoHashes: string[]): Promise<EmbeddedNode[]> {
    const repoFilter = buildRepoFilter('n', repoHashes);

    const query = `
      MATCH (n:CodeNode)
      WHERE ${repoFilter}
        AND n.embedding IS NOT NULL
      RETURN n.id AS id,
             [l IN labels(n) WHERE l <> 'CodeNode'][0] AS type,
             n.name AS name,
             n.filePath AS filePath,
             n.startLine AS startLine,
             n.summary AS summary,
             n.embedding AS embedding,
             n.embeddingProvider AS embeddingProvider,
             n.embeddingModel AS embeddingModel
      ORDER BY n.filePath, n.startLine
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        type: string;
        name: string;
        filePath: string;
        startLine: number;
        summary: string | null;
        embedding: number[];
        embeddingProvider: string | null;
        embeddingModel: string | null;
      }>(query, {});
    });

    return results.map((row) => ({
      id: row.id,
      type: normalizeNodeType(row.type),
      name: row.name,
      filePath: row.filePath,
      startLine: toNumber(row.startLine),
      summary: row.summary || undefined,
      embedding: row.embedding.map(toNumber),
      embeddingProvider: row.embeddingProvider || undefined,
      embeddingModel: row.embeddingModel || undefined,
    }));
  }

  async deleteRepository(repoId: string): Promise<void> {
    const prefix = repoId.split(':')[0] + ':';

    // Separate `STARTS WITH` / `=` statements seek the :CodeNode(id) range index
    // (an OR predicate scans the label), and LIMIT-bounded chunks keep each
    // transaction small for large repositories.
    const batchSize = applyBatchSize();
    for (;;) {
      const rows = await this.driver.withWriteTransaction((tx) =>
        tx.run<{ deleted: unknown }>(
          `
          MATCH (n:CodeNode) WHERE n.id STARTS WITH $prefix
          WITH n LIMIT $limit
          DETACH DELETE n
          RETURN count(*) AS deleted
          `,
          { prefix, limit: toInt(batchSize) },
        ),
      );
      if (toNumber(rows[0]?.deleted) < batchSize) break;
    }
    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(`MATCH (n:CodeNode {id: $repoId}) DETACH DELETE n`, { repoId });
      await tx.run(`MATCH (meta:CoredocMeta {repoId: $repoId}) DELETE meta`, { repoId });
    });
  }
}
