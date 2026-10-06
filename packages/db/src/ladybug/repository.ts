import { EdgeType, NodeType } from '@coredoc/core';
import type {
  CypherGraphResult,
  DeadCodePage,
  GraphEdge,
  GraphNode,
  HopVia,
  NeighborCount,
  ResolvedHop,
  ResolvesEdgeInfo,
  VizEdge,
  VizNode,
  VizNodePage,
} from '@coredoc/core';
import type { DbOperationType } from '@coredoc/core/types';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { assertQueryDoesNotProjectSource, assertReadOnlyCypherAllowlisted } from '../cypher-guard.js';
import {
  DEAD_CODE_DEFAULT_TYPES,
  SUBGRAPH_FLOW_EDGE_TYPES,
  UNRESOLVED_CALL_DEFAULT_LIMIT,
  UNRESOLVED_CALL_LIMIT,
  clampLimit,
  BRIDGE_LIMIT,
  DEAD_NODE_LIMIT,
  EDGES_AMONG_LIMIT,
  ENTRYPOINT_LIST_LIMIT,
  NEIGHBOR_LIMIT,
  NODE_PAGE_LIMIT,
  SUBGRAPH_EXPANSION_LIMIT,
  SUBGRAPH_NODE_CAP,
  SYMBOL_SEARCH_LIMIT,
  deadCodeUsageEdges,
  lowCoverageRepoNames,
} from '../graph-query-defaults.js';
import { parseAppliedGraphSnapshot } from '../graph-snapshot.js';
import { ByteMultiPatternMatcher } from '../multi-pattern.js';
import { analysisFrom, callResolutionFrom, dbOpResolutionFrom } from '../coverage-record.js';
import { entrypointAddressMatches } from '../route-path.js';
// Aliased: this file's own `NodeRow` is the raw storage row, not the mapper's input.
import {
  type CodeElementRow,
  type NodeRow as SharedNodeRow,
  callerInfoFromRow,
  codeElementFromRow,
  entityInfoFromRow,
  entrypointInfoFromRow,
  functionInfoFromRow,
  namedDeclarationFromRow,
  unresolvedCallFromRow,
} from '../node-row.js';
import type {
  AppliedGraphSnapshot,
  ApplyChangesetOptions,
  BatchExpandParams,
  BatchNodeIdsResult,
  CallerInfo,
  CypherRowsResult,
  CypherScalar,
  CallTreeNode,
  ClassInfo,
  CodeElement,
  ComponentGraphData,
  ComponentGraphEdge,
  ComponentGraphNode,
  CrossRepoBridgeParams,
  DeadCodeParams,
  EdgesAmongResult,
  EmbeddedNode,
  EntityConsumer,
  EntityInfo,
  EntrypointInfo,
  ExternalCallInfo,
  FindCodeParams,
  FunctionInfo,
  GetNeighborsParams,
  GraphApplyReceipt,
  IGraphBatchTraversalRepository,
  IGraphFileValidationRepository,
  IGraphRepository,
  InterfaceInfo,
  ITransaction,
  ListEntrypointsParams,
  MessagingExternalCall,
  NeighborsResult,
  NodeMetadataUpdate,
  PackageDependencyRollup,
  PackageInfo,
  PackageLinkerDeclarationKind,
  PackageLinkerFacts,
  PackageLinkerImportInfo,
  PathStep,
  RepoCoverageCounts,
  RepoNameRow,
  RepoOverview,
  RepoSummary,
  SubgraphParams,
  StoredGraphValidationEdge,
  StoredGraphValidationNode,
  TypeAliasInfo,
  TypeUsage,
  TypeUsageKind,
  TypeUseKind,
  EnumInfo,
  UnresolvedCallRecord,
  UnresolvedCallQueryOptions,
} from '../types.js';
import { buildVizEdge, buildVizNode, pageSlice } from '../viz-map.js';
import type { LadybugDriver } from './driver.js';
import {
  LADYBUG_EDGE_TYPES,
  LADYBUG_FTS_INDEX_NAME,
  LADYBUG_NODE_TABLE,
  LADYBUG_UNRESOLVED_CALL_TABLE,
  ladybugUnresolvedCallId,
} from './schema.js';
import { compareCodeUnits } from '@coredoc/core/utils';

export interface LadybugFtsHit {
  id: string;
  name: string;
  score: number;
}

interface NodeRow extends Record<string, unknown> {
  id: string;
  type: string;
  name: string;
  properties: string | null;
  summary: string | null;
  embedding: number[] | null;
  repoId: string | null;
  filePath: string | null;
  startLine: number | bigint | null;
  endLine: number | bigint | null;
}

interface NodeTextRow extends Record<string, unknown> {
  id: string;
  name: string;
  properties: string | null;
  summary: string | null;
  filePath: string | null;
}

interface EdgeRow extends Record<string, unknown> {
  id: string | null;
  sourceId: string;
  targetId: string;
  confidence: number | null;
  createdBy: string | null;
  properties: string | null;
}

interface IndexedEdge {
  id?: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
}

interface EdgeIndex {
  byId: Map<string, IndexedEdge>;
  byIdentity: Map<string, IndexedEdge>;
}

type StoredNode = GraphNode;
type StoredEdge = GraphEdge;

const MAX_TRAVERSAL_DEPTH = 10;
const CALLER_LIMIT = 100;
const STORED_NODE_TYPES = new Set<string>(Object.values(NodeType));

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : 0;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseValidationProperties(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid stored graph ${label} properties`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid stored graph ${label} properties`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid stored graph ${label} properties`);
  }
  return parsed as Record<string, unknown>;
}

function valueContainsNodeText(value: unknown, matcher: ByteMultiPatternMatcher): boolean {
  if (typeof value === 'string') return matcher.matches(value);
  if (Array.isArray(value)) return value.some((entry) => valueContainsNodeText(entry, matcher));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) => valueContainsNodeText(key, matcher) || valueContainsNodeText(entry, matcher),
  );
}

function nodeTextRowContains(row: NodeTextRow, matcher: ByteMultiPatternMatcher): boolean {
  if (typeof row.id !== 'string' || typeof row.name !== 'string') {
    throw new Error('Invalid stored node identity prevents logical text inspection');
  }
  for (const value of [row.id, row.name, row.summary, row.filePath]) {
    if (value !== null && typeof value !== 'string') {
      throw new Error('Invalid stored node text prevents logical text inspection');
    }
    if (typeof value === 'string' && valueContainsNodeText(value, matcher)) return true;
  }
  if (row.properties === null || row.properties === '') return false;
  if (typeof row.properties !== 'string') {
    throw new Error('Invalid stored node properties prevent logical text inspection');
  }
  if (valueContainsNodeText(row.properties, matcher)) return true;
  let properties: unknown;
  try {
    properties = JSON.parse(row.properties);
  } catch (error) {
    throw new Error('Invalid stored node properties prevent logical text inspection', { cause: error });
  }
  return valueContainsNodeText(properties, matcher);
}

function decodeNode(row: NodeRow): StoredNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    name: row.name,
    properties: parseObject(row.properties),
    ...(row.summary != null ? { summary: row.summary } : {}),
    ...(Array.isArray(row.embedding) ? { embedding: row.embedding.map(toNumber) } : {}),
    ...(row.repoId != null ? { repoId: row.repoId } : {}),
    ...(row.filePath != null ? { filePath: row.filePath } : {}),
    ...(row.startLine != null ? { startLine: toNumber(row.startLine) } : {}),
    ...(row.endLine != null ? { endLine: toNumber(row.endLine) } : {}),
  };
}

function decodeEdge(type: EdgeType, row: EdgeRow): StoredEdge {
  return {
    id: row.id ?? `${row.sourceId}|${type}|${row.targetId}`,
    sourceId: row.sourceId,
    targetId: row.targetId,
    type,
    confidence: row.confidence ?? 1,
    createdBy: (row.createdBy ?? 'parser') as GraphEdge['createdBy'],
    properties: parseObject(row.properties),
  };
}

function edgeIdentity(sourceId: string, targetId: string, type: EdgeType): string {
  return JSON.stringify([sourceId, targetId, type]);
}

function clampDepth(value: number, fallback = 1): number {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer)) return fallback;
  return Math.min(MAX_TRAVERSAL_DEPTH, Math.max(1, integer));
}

function stringProp(node: StoredNode, key: string): string | undefined {
  const value = node.properties[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Identity columns for the shared mappers in `node-row.ts`. `decodeNode` already
 * coerced Ladybug's `bigint` line numbers, so nothing is coerced again here.
 */
function nodeRow(node: StoredNode): SharedNodeRow {
  return {
    id: node.id,
    name: node.name,
    filePath: node.filePath ?? '',
    startLine: node.startLine ?? 0,
    endLine: node.endLine ?? 0,
    ...(node.summary !== undefined ? { summary: node.summary } : {}),
  };
}

/** The identity half of a {@link CodeElementRow} from a decoded node. */
function codeElementIdentity(node: StoredNode): CodeElementRow {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    filePath: node.filePath ?? '',
    startLine: node.startLine ?? 0,
    endLine: node.endLine,
    summary: node.summary,
  };
}

function functionInfo(node: StoredNode, className?: string): FunctionInfo {
  return functionInfoFromRow(nodeRow(node), node.properties, className);
}

function callerInfo(node: StoredNode, distance: number, className?: string, edge?: StoredEdge): CallerInfo {
  const callSiteLine = edge?.properties.line ?? edge?.properties.callSiteLine;
  return callerInfoFromRow(
    {
      id: node.id,
      name: node.name,
      filePath: node.filePath ?? '',
      startLine: node.startLine ?? 0,
      endLine: node.endLine,
      summary: node.summary,
    },
    node.properties,
    {
      distance,
      className,
      callSiteLine: typeof callSiteLine === 'number' ? callSiteLine : null,
      isAsyncCall: edge?.properties.isAsync === true,
      provenanceInferred: edge?.properties.provenanceInferred === true,
    },
  );
}

function assertEdgeType(value: EdgeType | string): EdgeType {
  if (!LADYBUG_EDGE_TYPES.includes(value as EdgeType)) {
    throw new Error(`Unsupported Ladybug relationship type: ${String(value)}`);
  }
  return value as EdgeType;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function globMatches(pattern: string, value: string): boolean {
  let expression = '';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, 'i').test(value);
}

function classInfo(node: StoredNode): ClassInfo {
  return namedDeclarationFromRow('class', nodeRow(node), node.properties);
}

function entityInfo(node: StoredNode): EntityInfo {
  return entityInfoFromRow(nodeRow(node), node.properties);
}

function entrypointInfo(node: StoredNode, handler?: StoredNode): EntrypointInfo {
  return entrypointInfoFromRow(
    {
      id: node.id,
      filePath: node.filePath ?? '',
      startLine: node.startLine ?? 0,
      ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
    },
    node.properties,
    handler
      ? {
          id: handler.id,
          name: handler.name,
          summary: handler.summary,
          purpose: optionalString(handler.properties.purpose),
        }
      : {},
  );
}

function repoHash(node: StoredNode): string {
  return node.repoId ?? node.id.split(':', 1)[0] ?? node.id;
}

function vizEdge(edge: StoredEdge): VizEdge {
  return buildVizEdge({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    type: edge.type,
    confidence: edge.confidence,
    createdBy: edge.createdBy,
    operation: optionalString(edge.properties.operation),
  });
}

function externalCallInfo(node: StoredNode, caller?: StoredNode): ExternalCallInfo {
  const props = node.properties;
  const monikerPackage = optionalString(props.monikerPackage);
  return {
    id: node.id,
    callerId: optionalString(props.callerId) ?? caller?.id ?? '',
    callerName: caller?.name ?? '',
    callerFilePath: caller?.filePath ?? '',
    serviceName: optionalString(props.serviceName) ?? '',
    ...(optionalString(props.targetService) ? { targetService: optionalString(props.targetService) } : {}),
    ...(optionalString(props.sdkName) ? { sdkName: optionalString(props.sdkName) } : {}),
    method: optionalString(props.method) ?? '',
    protocol: (optionalString(props.protocol) ?? 'http') as ExternalCallInfo['protocol'],
    ...(optionalString(props.httpMethod) ? { httpMethod: optionalString(props.httpMethod) } : {}),
    ...(optionalString(props.pathTemplate) ? { pathTemplate: optionalString(props.pathTemplate) } : {}),
    ...(optionalString(props.messagingSystem) ? { messagingSystem: optionalString(props.messagingSystem) } : {}),
    ...(optionalString(props.messagingDestination)
      ? { messagingDestination: optionalString(props.messagingDestination) }
      : {}),
    ...(optionalString(props.messagingDestinationRef)
      ? { messagingDestinationRef: optionalString(props.messagingDestinationRef) }
      : {}),
    ...(optionalString(props.ipcDirection) ? { ipcDirection: optionalString(props.ipcDirection) } : {}),
    ...(optionalString(props.grpcService) ? { grpcService: optionalString(props.grpcService) } : {}),
    ...(optionalString(props.grpcMethod) ? { grpcMethod: optionalString(props.grpcMethod) } : {}),
    ...(optionalString(props.graphqlOperationType)
      ? { graphqlOperationType: optionalString(props.graphqlOperationType) }
      : {}),
    ...(optionalString(props.graphqlOperationName)
      ? { graphqlOperationName: optionalString(props.graphqlOperationName) }
      : {}),
    ...(monikerPackage
      ? { moniker: { packageName: monikerPackage, descriptor: optionalString(props.monikerDescriptor) ?? '' } }
      : {}),
    ...(optionalString(props.dispatchMethod) ? { dispatchMethod: optionalString(props.dispatchMethod) } : {}),
    ...(optionalString(props.resolvedTargetId) ? { resolvedTargetId: optionalString(props.resolvedTargetId) } : {}),
    filePath: node.filePath ?? '',
    startLine: node.startLine ?? 0,
  };
}

const NODE_RETURN =
  'n.id AS id, n.type AS type, n.name AS name, n.properties AS properties, n.summary AS summary, ' +
  'n.embedding AS embedding, n.repoId AS repoId, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine';

function nodeReturn(alias: string): string {
  return (
    `${alias}.id AS id, ${alias}.type AS type, ${alias}.name AS name, ${alias}.properties AS properties, ` +
    `${alias}.summary AS summary, ${alias}.embedding AS embedding, ${alias}.repoId AS repoId, ` +
    `${alias}.filePath AS filePath, ${alias}.startLine AS startLine, ${alias}.endLine AS endLine`
  );
}

function repoClause(alias: string, repoHashes: readonly string[], includeRepositoryNode = false): string {
  if (repoHashes.length === 0) return 'true';
  return includeRepositoryNode
    ? `(list_contains($repoHashes, ${alias}.repoId) OR list_contains($repoHashes, ${alias}.id))`
    : `list_contains($repoHashes, ${alias}.repoId)`;
}

// ---------------------------------------------------------------------------
// Read-only Cypher (run_cypher_query substrate)
// ---------------------------------------------------------------------------

/** Query-scoped bound for a caller-supplied Cypher read. */
const CYPHER_TIMEOUT_MS = 5_000;

const CYPHER_COMPOSITE_CELL_ERROR =
  'Cypher rows shape supports scalar cells only; project scalar fields (e.g. RETURN n.name) or use resultShape "graph"';

/**
 * Kùzu internal element identity (`_id`, `_src`, `_dst` on node/rel values).
 * Relationship endpoints are expressed as these, never as our node ids, so the
 * graph shape has to key nodes by them to reattach edges.
 */
interface LadybugInternalId {
  offset: number | bigint;
  table: number | bigint;
}

/** A node value as returned by a Cypher `RETURN n` — stored columns + `_label`/`_id`. */
type LadybugNodeValue = NodeRow & { _label: string; _id: LadybugInternalId };

/** A relationship value as returned by a Cypher `RETURN r` — stored columns + `_src`/`_dst`/`_label`/`_id`. */
interface LadybugRelValue extends Record<string, unknown> {
  id: string | null;
  confidence: number | null;
  createdBy: string | null;
  properties: string | null;
  _label: string;
  _src: LadybugInternalId;
  _dst: LadybugInternalId;
}

function internalIdKey(id: LadybugInternalId): string {
  return `${String(id.table)}:${String(id.offset)}`;
}

function isLadybugNodeValue(value: unknown): value is LadybugNodeValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate._label === 'string' && candidate._id !== undefined && candidate._src === undefined;
}

function isLadybugRelValue(value: unknown): value is LadybugRelValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate._label === 'string' && candidate._src !== undefined && candidate._dst !== undefined;
}

/**
 * Normalize one Cypher cell into a JSON-safe scalar.
 *
 * The Neo4j repository carries an equivalent function for its own value types
 * (Neo4j `Integer` objects); this one is deliberately local and Kùzu-specific —
 * two call sites do not justify a shared abstraction, and the two value models
 * have nothing in common beyond the output contract.
 */
function normalizeLadybugCypherScalar(value: unknown): CypherScalar {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean' || kind === 'number') return value as CypherScalar;
  if (kind === 'bigint') {
    const integer = value as bigint;
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : integer.toString();
  }
  // Maps, lists, temporal/interval values, nodes and relationships all arrive as
  // objects — none of them fit the scalar wire contract.
  throw new Error(CYPHER_COMPOSITE_CELL_ERROR);
}

interface LadybugCypherGraphAccumulator {
  /** Returned nodes keyed by their Kùzu internal id (edge endpoints reference those). */
  nodes: Map<string, LadybugNodeValue>;
  rels: LadybugRelValue[];
  truncated: boolean;
}

/**
 * Walk one returned Cypher cell, collecting graph elements. Lists and
 * recursive-rel/path values (`{_nodes, _rels}`) are traversed; everything else
 * is not a graph element and is ignored.
 *
 * Both capped sets are bounded DURING collection: nodes at `limit` (keyed by
 * internal id) and rels at `limit` (positionally). Either cap biting sets
 * `truncated`, so `MATCH ()-[r]->() RETURN r` never materializes every
 * relationship in the graph before the outer cap — memory stays ≤ limit for
 * each set regardless of how the row consumer breaks.
 */
function collectLadybugGraphElements(value: unknown, limit: number, accumulator: LadybugCypherGraphAccumulator): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectLadybugGraphElements(entry, limit, accumulator);
    return;
  }
  if (isLadybugNodeValue(value)) {
    const key = internalIdKey(value._id);
    if (accumulator.nodes.has(key)) return;
    if (accumulator.nodes.size >= limit) {
      accumulator.truncated = true;
      return;
    }
    accumulator.nodes.set(key, value);
    return;
  }
  if (isLadybugRelValue(value)) {
    if (accumulator.rels.length >= limit) {
      accumulator.truncated = true;
      return;
    }
    accumulator.rels.push(value);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const nested of [record._nodes, record._rels]) {
      if (Array.isArray(nested)) collectLadybugGraphElements(nested, limit, accumulator);
    }
  }
}

export class LadybugRepository
  implements IGraphRepository, IGraphFileValidationRepository, IGraphBatchTraversalRepository
{
  constructor(private readonly driver: LadybugDriver) {}

  async containsNodeText(needles: readonly string[], repoHashes: string[]): Promise<boolean> {
    const uniqueNeedles = [...new Set(needles)];
    if (uniqueNeedles.length === 0) return false;
    if (uniqueNeedles.some((needle) => typeof needle !== 'string' || needle.length === 0)) {
      throw new Error('Logical node text needles must be non-empty strings');
    }
    const matcher = new ByteMultiPatternMatcher(uniqueNeedles.map((needle) => Buffer.from(needle, 'utf8')));
    const query =
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE ${repoClause('n', repoHashes, true)} ` +
      'RETURN n.id AS id, n.name AS name, n.properties AS properties, ' +
      'n.summary AS summary, n.filePath AS filePath';
    const params = repoHashes.length > 0 ? { repoHashes } : {};
    for await (const row of this.driver.streamReadRows<NodeTextRow>(query, params)) {
      if (nodeTextRowContains(row, matcher)) return true;
    }
    return false;
  }

  async *scanStoredNodes(): AsyncIterable<StoredGraphValidationNode> {
    const query =
      `MATCH (n:${LADYBUG_NODE_TABLE}) ` +
      'RETURN n.id AS id, n.type AS type, n.name AS name, n.properties AS properties, ' +
      'n.summary AS summary, n.embedding AS embedding, n.repoId AS repoId, n.filePath AS filePath, ' +
      'n.startLine AS startLine, n.endLine AS endLine ORDER BY n.id';
    for await (const row of this.driver.streamReadRows<NodeRow>(query)) {
      if (
        typeof row.id !== 'string' ||
        typeof row.type !== 'string' ||
        !STORED_NODE_TYPES.has(row.type) ||
        typeof row.name !== 'string' ||
        (row.repoId !== null && typeof row.repoId !== 'string') ||
        (row.filePath !== null && typeof row.filePath !== 'string')
      ) {
        throw new Error('Invalid stored graph node projection');
      }
      yield {
        id: row.id,
        type: row.type as NodeType,
        name: row.name,
        properties: parseValidationProperties(row.properties, 'node'),
        repoId: row.repoId,
        filePath: row.filePath,
      };
    }
  }

  async *scanStoredEdges(): AsyncIterable<StoredGraphValidationEdge> {
    for (const type of LADYBUG_EDGE_TYPES) {
      const query =
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
        'RETURN r.id AS id, source.id AS sourceId, target.id AS targetId, r.confidence AS confidence, ' +
        'r.createdBy AS createdBy, r.properties AS properties ORDER BY r.id';
      for await (const row of this.driver.streamReadRows<EdgeRow>(query)) {
        if (
          typeof row.id !== 'string' ||
          typeof row.sourceId !== 'string' ||
          typeof row.targetId !== 'string' ||
          typeof row.confidence !== 'number' ||
          !Number.isFinite(row.confidence) ||
          (row.createdBy !== 'parser' && row.createdBy !== 'ai' && row.createdBy !== 'human')
        ) {
          throw new Error('Invalid stored graph edge projection');
        }
        yield {
          id: row.id,
          sourceId: row.sourceId,
          targetId: row.targetId,
          type,
          confidence: row.confidence,
          createdBy: row.createdBy,
          properties: parseValidationProperties(row.properties, 'edge'),
        };
      }
    }
  }

  /** Engine-specific FTS capability used to prove the immutable serving path. */
  async queryFtsIndex(query: string, repoHashes: string[], limit = 20): Promise<LadybugFtsHit[]> {
    if (query.trim().length === 0) return [];
    const boundedLimit = clampLimit(limit, 100, 20);
    const rows = await this.driver.withReadTransaction((transaction) =>
      transaction.run<{ id: string; name: string; score: number | bigint }>(
        `CALL QUERY_FTS_INDEX('${LADYBUG_NODE_TABLE}', '${LADYBUG_FTS_INDEX_NAME}', $query) ` +
          `WHERE ${repoClause('node', repoHashes)} ` +
          `RETURN node.id AS id, node.name AS name, score ORDER BY score DESC, node.id LIMIT ${boundedLimit}`,
        { query, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => ({ id: row.id, name: row.name, score: toNumber(row.score) }));
  }

  private async queryNodes(query: string, params: Record<string, unknown> = {}): Promise<StoredNode[]> {
    const rows = await this.driver.withReadTransaction((tx) => tx.run<NodeRow>(query, params));
    return rows.map(decodeNode);
  }

  private async queryNodesInTransaction(
    tx: ITransaction,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<StoredNode[]> {
    return (await tx.run<NodeRow>(query, params)).map(decodeNode);
  }

  private async findTypedNode(type: NodeType, name: string, repoHashes: string[]): Promise<StoredNode | null> {
    const rows = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND n.name = $name AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.filePath, n.id LIMIT 1`,
      { type, name, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return rows[0] ?? null;
  }

  private async queryEdgesInTransaction(
    tx: ITransaction,
    typeValue: EdgeType,
    where = 'true',
    params: Record<string, unknown> = {},
    suffix = 'ORDER BY r.id',
  ): Promise<StoredEdge[]> {
    const type = assertEdgeType(typeValue);
    const rows = await tx.run<EdgeRow>(
      `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) WHERE ${where} ` +
        'RETURN r.id AS id, source.id AS sourceId, target.id AS targetId, r.confidence AS confidence, ' +
        `r.createdBy AS createdBy, r.properties AS properties ${suffix}`,
      params,
    );
    return rows.map((row) => decodeEdge(type, row));
  }

  private async queryEdgesAcrossTypesInTransaction(
    tx: ITransaction,
    edgeTypes: readonly EdgeType[],
    where = 'true',
    params: Record<string, unknown> = {},
    suffix = 'ORDER BY r.id',
  ): Promise<StoredEdge[]> {
    if (edgeTypes.length === 0) return [];
    const types = [...new Set(edgeTypes.map(assertEdgeType))];
    const rows = await tx.run<EdgeRow & { type: string }>(
      `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
        `WHERE list_contains($edgeTypes, label(r)) AND ${where} ` +
        'RETURN r.id AS id, source.id AS sourceId, target.id AS targetId, label(r) AS type, ' +
        `r.confidence AS confidence, r.createdBy AS createdBy, r.properties AS properties ${suffix}`,
      { ...params, edgeTypes: types },
    );
    return rows.map((row) => decodeEdge(assertEdgeType(row.type), row));
  }

  private async repoNameMap(repoHashes: string[] = []): Promise<Map<string, string>> {
    const repositories = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.id`,
      { type: NodeType.Repository, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return new Map(repositories.map((repository) => [repository.id, repository.name]));
  }

  private async vizNodes(nodes: StoredNode[]): Promise<VizNode[]> {
    if (nodes.length === 0) return [];
    const names = await this.repoNameMap([...new Set(nodes.map(repoHash))]);
    return nodes.map((node) =>
      buildVizNode({
        id: node.id,
        type: node.type,
        name: node.name,
        repoName: names.get(repoHash(node)) ?? '',
        filePath: node.filePath ?? null,
        startLine: node.startLine ?? null,
        summary: node.summary ?? null,
        pMethod: node.properties.method,
        pEntrypointType: node.properties.entrypointType,
        pProtocol: node.properties.protocol,
      }),
    );
  }

  async findCode(params: FindCodeParams, repoHashes: string[]): Promise<CodeElement[]> {
    const types = params.types?.length
      ? params.types
      : [NodeType.Function, NodeType.Class, NodeType.Interface, NodeType.Entrypoint, NodeType.Entity];
    const limit = clampLimit(params.limit ?? 50, SYMBOL_SEARCH_LIMIT.max, SYMBOL_SEARCH_LIMIT.fallback);
    const literals = params.pattern
      .split(/[*?]+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const needle = literals[0] ?? '';
    const exact = /^[^*?]+$/.test(params.pattern);
    const prefix = /^[^*?]+\*$/.test(params.pattern);
    const suffix = /^\*[^*?]+$/.test(params.pattern);
    const contains = /^\*[^*?]+\*$/.test(params.pattern);
    const all = /^\*+$/.test(params.pattern);
    const exactDbPredicate = exact
      ? 'AND lower(n.name) = lower($pattern)'
      : prefix
        ? 'AND starts_with(lower(n.name), lower($simpleNeedle))'
        : suffix
          ? 'AND ends_with(lower(n.name), lower($simpleNeedle))'
          : contains
            ? 'AND contains(lower(n.name), lower($simpleNeedle))'
            : '';
    const canLimitBeforeGlob = !params.exportedVariablesOnly && (exact || prefix || suffix || contains || all);
    const query = `
      MATCH (n:${LADYBUG_NODE_TABLE})
      WHERE list_contains($types, n.type) AND ${repoClause('n', repoHashes)}
        ${exactDbPredicate || (needle ? 'AND contains(lower(n.name), lower($needle))' : '')}
      RETURN ${NODE_RETURN}
      ORDER BY n.name, n.id
      ${canLimitBeforeGlob ? `LIMIT ${limit}` : ''}
    `;
    const queryParams = {
      types,
      ...(repoHashes.length > 0 ? { repoHashes } : {}),
      ...(exact ? { pattern: params.pattern } : {}),
      ...(prefix || suffix || contains ? { simpleNeedle: params.pattern.replaceAll('*', '') } : {}),
      ...(!canLimitBeforeGlob && needle ? { needle } : {}),
    };
    const matches: StoredNode[] = [];
    for await (const row of this.driver.streamReadRows<NodeRow>(query, queryParams)) {
      const node = decodeNode(row);
      if (!globMatches(params.pattern, node.name)) continue;
      if (params.exportedVariablesOnly && node.type === NodeType.Variable && node.properties.isExported !== true) {
        continue;
      }
      matches.push(node);
      if (matches.length === limit) break;
    }
    return matches.map((node) =>
      codeElementFromRow({
        ...codeElementIdentity(node),
        purpose: optionalString(node.properties.purpose),
        ...(params.includeSource ? { sourceCode: optionalString(node.properties.sourceCode) } : {}),
      }),
    );
  }

  async listSymbolsInFile(filePath: string, repoHashes: string[]): Promise<CodeElement[]> {
    if (repoHashes.length === 0) return [];
    const rows = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE ${repoClause('n', repoHashes)} ` +
        'AND (n.filePath = $filePath OR ends_with(n.filePath, $suffix)) ' +
        `RETURN ${NODE_RETURN} ORDER BY n.startLine, n.name, n.id`,
      { repoHashes, filePath, suffix: `/${filePath}` },
    );
    return rows.map((node) => codeElementFromRow(codeElementIdentity(node)));
  }

  async findFunction(
    name: string,
    repoHashes: string[],
    fileHint?: string,
    className?: string,
  ): Promise<FunctionInfo | null> {
    const query = `
      MATCH (f:${LADYBUG_NODE_TABLE})
      WHERE f.type = $functionType AND f.name = $name AND ${repoClause('f', repoHashes)}
        ${fileHint ? 'AND contains(f.filePath, $fileHint)' : ''}
      OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(f)
      WHERE owner.type = $classType
      WITH f, owner
      ${className ? 'WHERE owner.name = $className' : ''}
      RETURN ${nodeReturn('f')}, owner.name AS className
      ORDER BY f.filePath, f.id
      LIMIT 1
    `;
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<NodeRow & { className: string | null }>(query, {
        functionType: NodeType.Function,
        classType: NodeType.Class,
        name,
        repoHashes,
        ...(fileHint ? { fileHint } : {}),
        ...(className ? { className } : {}),
      }),
    );
    const first = rows[0];
    return first ? functionInfo(decodeNode(first), first.className ?? undefined) : null;
  }

  async findClass(name: string, repoHashes: string[]): Promise<ClassInfo | null> {
    const node = await this.findTypedNode(NodeType.Class, name, repoHashes);
    return node ? classInfo(node) : null;
  }

  async findInterface(name: string, repoHashes: string[]): Promise<InterfaceInfo | null> {
    const node = await this.findTypedNode(NodeType.Interface, name, repoHashes);
    return node ? namedDeclarationFromRow('interface', nodeRow(node), node.properties) : null;
  }

  async findEnum(name: string, repoHashes: string[]): Promise<EnumInfo | null> {
    const node = await this.findTypedNode(NodeType.Enum, name, repoHashes);
    return node ? namedDeclarationFromRow('enum', nodeRow(node), node.properties) : null;
  }

  async findTypeAlias(name: string, repoHashes: string[]): Promise<TypeAliasInfo | null> {
    const node = await this.findTypedNode(NodeType.TypeAlias, name, repoHashes);
    return node ? namedDeclarationFromRow('type_alias', nodeRow(node), node.properties) : null;
  }

  async findEntity(name: string, repoHashes: string[]): Promise<EntityInfo | null> {
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Entity, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    const match = nodes.find((node) => node.name === name || node.properties.tableName === name);
    return match ? entityInfo(match) : null;
  }

  async listEntities(repoHashes: string[]): Promise<EntityInfo[]> {
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Entity, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return nodes.map(entityInfo);
  }

  async listEntrypoints(params: ListEntrypointsParams, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const normalizedSystem = params.system?.trim().toLowerCase();
    const [entrypointRows, handleRows] = await this.driver.withReadTransaction(async (tx) => {
      const entries = await tx.run<NodeRow>(
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
          `${params.id ? 'AND n.id = $id ' : ''}` +
          `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
        {
          type: NodeType.Entrypoint,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
          ...(params.id ? { id: params.id } : {}),
        },
      );
      const handles = await tx.run<{ sourceId: string; targetId: string }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[:HANDLES]->(target:${LADYBUG_NODE_TABLE}) ` +
          `WHERE source.type = $entrypointType AND ${repoClause('source', repoHashes)} ` +
          'RETURN source.id AS sourceId, target.id AS targetId',
        {
          entrypointType: NodeType.Entrypoint,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      );
      return [entries, handles] as const;
    });
    const entrypoints = entrypointRows.map(decodeNode);
    const handlerIds = [...new Set(handleRows.map((row) => row.targetId))];
    const handlers = handlerIds.length
      ? await this.queryNodes(`MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) RETURN ${NODE_RETURN}`, {
          ids: handlerIds,
        })
      : [];
    const handlerById = new Map(handlers.map((node) => [node.id, node]));
    const handleByEntrypoint = new Map(handleRows.map((row) => [row.sourceId, handlerById.get(row.targetId)]));
    let result = entrypoints
      .map((node) => entrypointInfo(node, handleByEntrypoint.get(node.id)))
      .filter((entrypoint) => !params.type || entrypoint.type === params.type)
      .filter((entrypoint) => {
        if (!normalizedSystem) return true;
        if (entrypoint.type !== 'queue' && entrypoint.type !== 'event') return false;
        const system = entrypoint.system?.trim().toLowerCase();
        return normalizedSystem === 'unknown' ? !system : system === normalizedSystem;
      });

    result.sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        (a.fullPath ?? a.path ?? '').localeCompare(b.fullPath ?? b.path ?? '') ||
        (a.method ?? '').localeCompare(b.method ?? '') ||
        a.id.localeCompare(b.id),
    );

    if (!params.id && !normalizedSystem && (!params.type || params.type === 'http')) {
      const routes = await this.queryNodes(
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
          `RETURN ${NODE_RETURN}`,
        { type: NodeType.Route, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      );
      routes.sort(
        (a, b) =>
          (optionalString(a.properties.path) ?? a.name).localeCompare(optionalString(b.properties.path) ?? b.name) ||
          a.id.localeCompare(b.id),
      );
      const componentIds = routes
        .map((route) => optionalString(route.properties.componentId))
        .filter(Boolean) as string[];
      const components = componentIds.length
        ? await this.queryNodes(
            `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) RETURN ${NODE_RETURN}`,
            {
              ids: [...new Set(componentIds)],
            },
          )
        : [];
      const componentsById = new Map(components.map((node) => [node.id, node]));
      for (const route of routes) {
        const path = optionalString(route.properties.path) ?? route.name;
        const handler = componentsById.get(optionalString(route.properties.componentId) ?? '');
        result.push({
          id: route.id,
          type: 'http',
          method: 'GET',
          handlerId: optionalString(route.properties.componentId) ?? '',
          ...(handler ? { handlerName: handler.name } : {}),
          path,
          fullPath: path,
          filePath: route.filePath ?? '',
          startLine: route.startLine ?? 0,
          ...(route.endLine !== undefined ? { endLine: route.endLine } : {}),
          ...(handler?.summary ? { summary: handler.summary } : {}),
          ...(handler && optionalString(handler.properties.purpose)
            ? { purpose: optionalString(handler.properties.purpose) }
            : {}),
        });
      }
    }

    if (params.pathPattern) {
      // Matches every address token (path, destination, topic, schedule,
      // command, GraphQL field) — a queue entrypoint has no path to filter on.
      result = result.filter((entrypoint) => entrypointAddressMatches(params.pathPattern as string, entrypoint));
    }
    return params.limit !== undefined
      ? result.slice(0, clampLimit(params.limit, ENTRYPOINT_LIST_LIMIT.max, ENTRYPOINT_LIST_LIMIT.fallback))
      : result;
  }

  async getRepoOverview(repoHashes: string[]): Promise<RepoOverview[]> {
    const repositories = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Repository, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return this.driver.withReadTransaction(async (tx) => {
      const overviews: RepoOverview[] = [];
      for (const repository of repositories) {
        const counts = await tx.run<{ type: string; count: number | bigint }>(
          `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.repoId = $repoId RETURN n.type AS type, count(*) AS count ORDER BY type`,
          { repoId: repository.id },
        );
        const entrypoints = await tx.run<{ properties: string | null }>(
          `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.repoId = $repoId AND n.type = $type RETURN n.properties AS properties`,
          { repoId: repository.id, type: NodeType.Entrypoint },
        );
        const byType = new Map(counts.map((row) => [row.type, toNumber(row.count)]));
        const props = repository.properties;
        const externalIntegrations = Array.isArray(props.externalIntegrations)
          ? (props.externalIntegrations as string[])
          : undefined;
        overviews.push({
          name: repository.name,
          type: optionalString(props.type) ?? 'unknown',
          parsedAt: optionalString(props.parsedAt) ?? '',
          fileCount: byType.get(NodeType.File) ?? 0,
          functionCount: byType.get(NodeType.Function) ?? 0,
          classCount: byType.get(NodeType.Class) ?? 0,
          entityCount: byType.get(NodeType.Entity) ?? 0,
          entrypointTypes: [
            ...new Set(
              entrypoints
                .map((row) => optionalString(parseObject(row.properties).entrypointType))
                .filter(Boolean) as string[],
            ),
          ].sort(),
          ...(repository.summary ? { summary: repository.summary } : {}),
          ...(optionalString(props.dataModel) ? { dataModel: optionalString(props.dataModel) } : {}),
          ...(externalIntegrations ? { externalIntegrations } : {}),
          ...(optionalString(props.gitRemoteUrl) ? { gitRemoteUrl: optionalString(props.gitRemoteUrl) } : {}),
          ...(optionalString(props.gitCommitHash) ? { gitCommitHash: optionalString(props.gitCommitHash) } : {}),
          ...(optionalString(props.parserVersion) ? { parserVersion: optionalString(props.parserVersion) } : {}),
        });
      }
      return overviews;
    });
  }

  async getCoverageCounts(repoHashes: string[]): Promise<RepoCoverageCounts[]> {
    const repositories = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Repository, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return this.driver.withReadTransaction(async (tx) => {
      const output: RepoCoverageCounts[] = [];
      for (const repository of repositories) {
        const countRows = await tx.run<{ type: string; count: number | bigint }>(
          `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.repoId = $repoId RETURN n.type AS type, count(*) AS count ORDER BY type`,
          { repoId: repository.id },
        );
        const [entityRows, functionRows, resolvedRows] = await (async () => {
          const entities = await tx.run<{ count: number | bigint }>(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[:OPERATES_ON]->(target:${LADYBUG_NODE_TABLE}) ` +
              'WHERE target.type = $entityType AND target.repoId = $repoId RETURN count(DISTINCT target.id) AS count',
            { entityType: NodeType.Entity, repoId: repository.id },
          );
          const functions = await tx.run<{ count: number | bigint }>(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[:CALLS]->(target:${LADYBUG_NODE_TABLE}) ` +
              'WHERE source.type = $functionType AND source.repoId = $repoId RETURN count(DISTINCT source.id) AS count',
            { functionType: NodeType.Function, repoId: repository.id },
          );
          const resolved = await tx.run<{ count: number | bigint }>(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[:RESOLVES_TO]->(target:${LADYBUG_NODE_TABLE}) ` +
              'WHERE source.type = $externalType AND source.repoId = $repoId RETURN count(DISTINCT source.id) AS count',
            { externalType: NodeType.ExternalCall, repoId: repository.id },
          );
          return [entities, functions, resolved] as const;
        })();
        const nodeCountsByType = Object.fromEntries(countRows.map((row) => [row.type, toNumber(row.count)])) as Record<
          string,
          number
        >;
        const repoProps = repository.properties;
        const analysis = analysisFrom(repoProps.analysis);
        const callResolution = callResolutionFrom(
          repoProps.callSites,
          repoProps.resolvedCalls,
          repoProps.outOfScopeCalls,
        );
        const dbOpResolution = dbOpResolutionFrom(repoProps.dbOpSites, repoProps.boundDbOps, repoProps.outOfScopeDbOps);
        output.push({
          repoName: repository.name,
          nodeCountsByType,
          entityCount: nodeCountsByType[NodeType.Entity] ?? 0,
          entitiesWithDbOps: toNumber(entityRows[0]?.count),
          functionCount: nodeCountsByType[NodeType.Function] ?? 0,
          functionsWithCalls: toNumber(functionRows[0]?.count),
          externalCallCount: nodeCountsByType[NodeType.ExternalCall] ?? 0,
          resolvedExternalCallCount: toNumber(resolvedRows[0]?.count),
          ...(callResolution ? { callResolution } : {}),
          ...(analysis ? { analysis } : {}),
          ...(dbOpResolution ? { dbOpResolution } : {}),
        });
      }
      return output;
    });
  }

  async listAllRepositories(nameFilter?: string[]): Promise<RepoSummary[]> {
    if (nameFilter && nameFilter.length === 0) return [];
    const repositories = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type ${nameFilter ? 'AND list_contains($names, n.name)' : ''} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Repository, ...(nameFilter ? { names: nameFilter } : {}) },
    );
    return repositories.map((repository) => ({
      name: repository.name,
      hash: repository.id,
      type: optionalString(repository.properties.type) ?? 'unknown',
      parsedAt: optionalString(repository.properties.parsedAt) ?? '',
      ...(repository.summary ? { summary: repository.summary } : {}),
    }));
  }

  async getRepositoryNames(repoHashes: string[]): Promise<RepoNameRow[]> {
    const repositories = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Repository, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return repositories.map((repository) => ({
      hash: repository.id,
      name: repository.name,
      ...(optionalString(repository.properties.parserVersion)
        ? { parserVersion: optionalString(repository.properties.parserVersion) }
        : {}),
    }));
  }

  async getPackages(repoHashes: string[]): Promise<PackageInfo[]> {
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.name, n.id`,
      { type: NodeType.Package, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return nodes.map((node) => ({
      id: node.id,
      name: node.name,
      path: optionalString(node.properties.path) ?? node.filePath ?? '',
      ...(optionalString(node.properties.packageType) ? { type: optionalString(node.properties.packageType) } : {}),
      ...(optionalString(node.properties.language) ? { language: optionalString(node.properties.language) } : {}),
      ...(optionalString(node.properties.description)
        ? { description: optionalString(node.properties.description) }
        : {}),
      ...(node.repoId ? { repoId: node.repoId } : {}),
    }));
  }

  async getPackageLinkerFacts(repoHashes: string[]): Promise<PackageLinkerFacts> {
    if (repoHashes.length === 0) return { files: [], declarations: [] };
    return this.driver.withReadTransaction(async (tx) => {
      const declarationNodes = await this.queryNodesInTransaction(
        tx,
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($types, n.type) AND ${repoClause('n', repoHashes)} ` +
          `AND contains(n.properties, $exportedProperty) ` +
          `RETURN ${NODE_RETURN} ORDER BY n.id`,
        {
          types: [
            NodeType.Class,
            NodeType.Interface,
            NodeType.TypeAlias,
            NodeType.Enum,
            NodeType.Function,
            NodeType.Variable,
          ],
          exportedProperty: '"isExported":true',
          repoHashes,
        },
      );
      const declarations: PackageLinkerFacts['declarations'] = [];
      const declarationFileIds = new Set<string>();
      for (const node of declarationNodes) {
        if (node.properties.isExported !== true) continue;
        if (node.type === NodeType.Function && node.properties.kind !== 'function') continue;
        const fileId = node.properties.fileId;
        if (typeof fileId !== 'string' || fileId.length === 0) continue;
        declarationFileIds.add(fileId);
        declarations.push({
          id: node.id,
          name: node.name,
          fileId,
          kind: node.type as PackageLinkerDeclarationKind,
          isExported: true,
        });
      }

      const declarationFileIdList = [...declarationFileIds].sort();
      const fileSelection =
        declarationFileIdList.length > 0
          ? `(contains(n.properties, $packageImportsProperty) OR list_contains($declarationFileIds, n.id))`
          : `contains(n.properties, $packageImportsProperty)`;
      const fileNodes = await this.queryNodesInTransaction(
        tx,
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $fileType AND ${repoClause('n', repoHashes)} ` +
          `AND contains(n.properties, $packageIdProperty) AND ${fileSelection} ` +
          `RETURN ${NODE_RETURN} ORDER BY n.id`,
        {
          fileType: NodeType.File,
          packageIdProperty: '"packageId":',
          packageImportsProperty: '"packageImports":',
          repoHashes,
          ...(declarationFileIdList.length > 0 ? { declarationFileIds: declarationFileIdList } : {}),
        },
      );
      // Warn-and-skip, matching the SQLite backend and target-slicer's stated policy: a read
      // projection must degrade the one bad row, not abort resolution for the whole workspace.
      // This backend selects with a `contains(n.properties, …)` substring test rather than
      // SQLite's typed `json_type(...) = 'text'`, so it can legitimately admit rows SQLite
      // never returns — throwing on them made Ladybug fail where SQLite silently succeeded.
      const skipped: string[] = [];
      const files: PackageLinkerFacts['files'] = [];
      for (const node of fileNodes) {
        const packageId = node.properties.packageId;
        if (typeof packageId !== 'string' || packageId.length === 0) {
          skipped.push(`File ${node.id}: missing packageId`);
          continue;
        }
        const storedImports = node.properties.packageImports;
        if (storedImports !== undefined && !Array.isArray(storedImports)) {
          skipped.push(`File ${node.id}: invalid packageImports`);
          continue;
        }
        files.push({
          id: node.id,
          path: optionalString(node.properties.path) ?? node.filePath ?? node.name,
          packageId,
          ...(optionalString(node.properties.target) ? { target: optionalString(node.properties.target) } : {}),
          imports: (storedImports ?? []) as PackageLinkerImportInfo[],
        });
      }
      if (skipped.length > 0) {
        console.warn(
          `[coredoc] package linker: skipped ${skipped.length} malformed row(s) — ${skipped.slice(0, 5).join('; ')}` +
            `${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''}`,
        );
      }
      const projectedFileIds = new Set(files.map((file) => file.id));
      return {
        files,
        declarations: declarations.filter((declaration) => projectedFileIds.has(declaration.fileId)),
      };
    });
  }

  async getEmbeddedNodes(repoHashes: string[]): Promise<EmbeddedNode[]> {
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.embedding IS NOT NULL AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.id`,
      { ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return nodes
      .filter((node) => Array.isArray(node.embedding))
      .map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        filePath: node.filePath ?? '',
        startLine: node.startLine ?? 0,
        ...(node.summary ? { summary: node.summary } : {}),
        embedding: node.embedding as number[],
        ...(optionalString(node.properties.embeddingProvider)
          ? { embeddingProvider: optionalString(node.properties.embeddingProvider) }
          : {}),
        ...(optionalString(node.properties.embeddingModel)
          ? { embeddingModel: optionalString(node.properties.embeddingModel) }
          : {}),
      }));
  }

  /**
   * KNOWN GAP — `provenanceInferred` is not reported on a transitive caller here.
   *
   * The sqlite arm ORs the flag along its recursive CTE and the Neo4j arm uses
   * `any(r IN relationships(path) …)`; Ladybug's Cypher subset has no verified
   * `relationships(path)` support (nothing else in this file uses a path function
   * beyond `length()`), so the flag would have to be recovered with a second query
   * per caller. Direct callers ARE flagged — {@link callerInfo} reads it off the
   * edge — and `find_callers` renders direct callers by default, so the visible
   * surface is covered. Stated rather than silent: a transitive caller reached
   * only through an inferred hop currently renders unflagged on this backend.
   */
  async getTransitiveCallers(targetId: string, depth: number, repoHashes: string[]): Promise<CallerInfo[]> {
    const boundedDepth = clampDepth(depth);
    const query = `
      MATCH path = (caller:${LADYBUG_NODE_TABLE})-[:CALLS*1..${boundedDepth}]->(target:${LADYBUG_NODE_TABLE} {id: $targetId})
      WHERE caller.id <> target.id AND ${repoClause('caller', repoHashes)}
      WITH caller, min(length(path)) AS distance
      OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(caller)
      WHERE owner.type = $classType
      RETURN ${nodeReturn('caller')}, distance, owner.name AS className
      ORDER BY distance, coalesce(caller.filePath, ''), caller.id
      LIMIT ${CALLER_LIMIT}
    `;
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<NodeRow & { distance: number | bigint; className: string | null }>(query, {
        targetId,
        classType: NodeType.Class,
        repoHashes,
      }),
    );
    const seen = new Set<string>();
    const callers: CallerInfo[] = [];
    for (const row of rows) {
      if (seen.has(row.id) || row.id === targetId) continue;
      seen.add(row.id);
      callers.push(callerInfo(decodeNode(row), toNumber(row.distance), row.className ?? undefined));
      if (callers.length === CALLER_LIMIT) break;
    }
    return callers;
  }

  async getDirectCallers(targetId: string, repoHashes: string[]): Promise<CallerInfo[]> {
    type DirectCallerRow = NodeRow & { edgeProperties: string | null; className: string | null };
    const rows = await this.driver.withReadTransaction(async (tx) => {
      const output: Array<DirectCallerRow & { edgeType: EdgeType }> = [];
      // CALLS rows intentionally precede REFERENCES_VARIABLE so the invocation
      // site wins when both edge kinds connect the same caller and target.
      for (const edgeType of [EdgeType.Calls, EdgeType.ReferencesVariable] as const) {
        const batch = await tx.run<DirectCallerRow>(
          `MATCH (caller:${LADYBUG_NODE_TABLE})-[call:${edgeType}]->(target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
            `WHERE ${repoClause('caller', repoHashes)} ` +
            `OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(caller) WHERE owner.type = $classType ` +
            `RETURN ${nodeReturn('caller')}, call.properties AS edgeProperties, owner.name AS className ` +
            `ORDER BY coalesce(caller.filePath, ''), coalesce(caller.startLine, 0), caller.id LIMIT ${CALLER_LIMIT}`,
          {
            targetId,
            classType: NodeType.Class,
            ...(repoHashes.length > 0 ? { repoHashes } : {}),
          },
        );
        output.push(...batch.map((row) => ({ ...row, edgeType })));
      }
      return output;
    });
    const seen = new Set<string>();
    const callers: CallerInfo[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      callers.push(
        callerInfo(decodeNode(row), 1, row.className ?? undefined, {
          id: '',
          sourceId: row.id,
          targetId,
          type: row.edgeType,
          confidence: 1,
          createdBy: 'parser',
          properties: parseObject(row.edgeProperties),
        }),
      );
      if (callers.length === CALLER_LIMIT) break;
    }
    return callers;
  }

  async getReachingEntrypoints(targetId: string, depth: number, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const boundedDepth = clampDepth(depth + 3);
    type EntrypointRow = NodeRow & { handlerId: string; handlerName: string };
    const rows = await this.driver.withReadTransaction(async (tx) => {
      const direct = await tx.run<EntrypointRow>(
        `MATCH (ep:${LADYBUG_NODE_TABLE})-[:HANDLES]->(handler:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
          `WHERE ep.type = $entrypointType AND handler.type = $functionType AND ${repoClause('ep', repoHashes)} ` +
          `RETURN ${nodeReturn('ep')}, handler.id AS handlerId, handler.name AS handlerName ORDER BY id`,
        {
          targetId,
          entrypointType: NodeType.Entrypoint,
          functionType: NodeType.Function,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      );
      const transitive = await tx.run<EntrypointRow>(
        `MATCH path = (handler:${LADYBUG_NODE_TABLE})-[:CALLS*1..${boundedDepth}]->(target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
          'WHERE handler.type = $functionType ' +
          `MATCH (ep:${LADYBUG_NODE_TABLE})-[:HANDLES]->(handler) ` +
          `WHERE ep.type = $entrypointType AND ${repoClause('ep', repoHashes)} ` +
          `RETURN DISTINCT ${nodeReturn('ep')}, handler.id AS handlerId, handler.name AS handlerName ` +
          'ORDER BY id',
        {
          targetId,
          entrypointType: NodeType.Entrypoint,
          functionType: NodeType.Function,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      );
      return [...direct, ...transitive];
    });
    const byId = new Map<string, EntrypointInfo>();
    for (const row of rows) {
      if (byId.has(row.id)) continue;
      const handler: StoredNode = {
        id: row.handlerId,
        name: row.handlerName,
        type: NodeType.Function,
        properties: {},
      };
      byId.set(row.id, entrypointInfo(decodeNode(row), handler));
    }
    return [...byId.values()]
      .sort((a, b) => (a.fullPath ?? '').localeCompare(b.fullPath ?? '') || a.id.localeCompare(b.id))
      .slice(0, 20);
  }

  async findShortestPath(startId: string, endId: string, repoHashes: string[]): Promise<PathStep[]> {
    const scopedEndpoints = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN}`,
      { ids: [startId, endId], ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    const scopedEndpointIds = new Set(scopedEndpoints.map((node) => node.id));
    if (!scopedEndpointIds.has(startId) || !scopedEndpointIds.has(endId)) return [];
    if (startId === endId) return this.hydratePathSteps([startId], repoHashes);

    const parent = new Map<string, string>();
    const visited = new Set<string>([startId]);
    let frontier = [startId];
    for (let hop = 1; hop <= MAX_TRAVERSAL_DEPTH && frontier.length > 0; hop += 1) {
      const rows = await this.driver.withReadTransaction((tx) =>
        tx.run<{ sourceId: string; targetId: string }>(
          `MATCH (source:${LADYBUG_NODE_TABLE})-[:CALLS]->(target:${LADYBUG_NODE_TABLE}) ` +
            `WHERE list_contains($frontier, source.id) AND ${repoClause('target', repoHashes)} ` +
            'RETURN source.id AS sourceId, target.id AS targetId ORDER BY source.id, target.id',
          { frontier, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
        ),
      );
      const next: string[] = [];
      for (const row of rows) {
        if (visited.has(row.targetId)) continue;
        visited.add(row.targetId);
        parent.set(row.targetId, row.sourceId);
        next.push(row.targetId);
      }
      if (visited.has(endId)) break;
      frontier = next;
    }
    if (!visited.has(endId)) return [];
    const ids = [endId];
    while (ids[0] !== startId) {
      const previous = parent.get(ids[0] as string);
      if (!previous) return [];
      ids.unshift(previous);
    }
    return this.hydratePathSteps(ids, repoHashes);
  }

  private async hydratePathSteps(ids: string[], repoHashes: string[]): Promise<PathStep[]> {
    if (ids.length === 0) return [];
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) AND ${repoClause('n', repoHashes, true)} RETURN ${NODE_RETURN}`,
      { ids, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return ids.map((id) => {
      const node = byId.get(id);
      return node
        ? {
            id: node.id,
            name: node.name,
            filePath: node.filePath ?? '',
            startLine: node.startLine ?? 0,
            ...(node.summary ? { summary: node.summary } : {}),
            ...(optionalString(node.properties.classId) ? { classId: optionalString(node.properties.classId) } : {}),
          }
        : { id, name: 'unknown', filePath: '', startLine: 0 };
    });
  }

  async getCallTree(rootId: string, depth: number, repoHashes: string[]): Promise<CallTreeNode[]> {
    const boundedDepth = clampDepth(depth);
    const rows = await this.driver.withReadTransaction(async (tx) => {
      const rootRows = await tx.run<NodeRow & { className: string | null }>(
        `MATCH (f:${LADYBUG_NODE_TABLE} {id: $rootId}) WHERE f.type = $functionType AND ${repoClause('f', repoHashes)} ` +
          `OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(f) WHERE owner.type = $classType ` +
          `RETURN ${nodeReturn('f')}, owner.name AS className`,
        {
          rootId,
          functionType: NodeType.Function,
          classType: NodeType.Class,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      );
      const root = rootRows[0];
      if (!root) return [];

      const output: Array<NodeRow & { depth: number; className: string | null }> = [{ ...root, depth: 0 }];
      const visited = new Set<string>([root.id]);
      let frontier = [root.id];
      for (let currentDepth = 1; currentDepth <= boundedDepth && frontier.length > 0; currentDepth += 1) {
        const remaining = 200 - output.length;
        if (remaining === 0) break;
        const nextRows = await tx.run<NodeRow & { className: string | null }>(
          `MATCH (source:${LADYBUG_NODE_TABLE})-[:CALLS]->(target:${LADYBUG_NODE_TABLE}) ` +
            `WHERE list_contains($frontier, source.id) AND source.id <> target.id ` +
            `AND target.type = $functionType AND ${repoClause('source', repoHashes)} ` +
            `AND ${repoClause('target', repoHashes)} ` +
            'WITH DISTINCT target ' +
            `OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(target) WHERE owner.type = $classType ` +
            `RETURN ${nodeReturn('target')}, owner.name AS className ` +
            `ORDER BY target.name, target.id LIMIT ${remaining}`,
          {
            frontier,
            functionType: NodeType.Function,
            classType: NodeType.Class,
            ...(repoHashes.length > 0 ? { repoHashes } : {}),
          },
        );
        const next: string[] = [];
        for (const row of nextRows) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          next.push(row.id);
          output.push({ ...row, depth: currentDepth });
          if (output.length === 200) break;
        }
        frontier = next;
      }
      return output;
    });
    const seen = new Set<string>();
    const result: CallTreeNode[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const node = decodeNode(row);
      result.push({
        id: node.id,
        name: node.name,
        kind: stringProp(node, 'kind') === 'method' ? 'method' : 'function',
        filePath: node.filePath ?? '',
        startLine: node.startLine ?? 0,
        ...(row.className ? { className: row.className } : {}),
        ...(node.summary ? { summary: node.summary } : {}),
        depth: toNumber(row.depth),
      });
    }
    return result;
  }

  async getDirectCallees(sourceId: string, repoHashes: string[]): Promise<FunctionInfo[]> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<NodeRow & { edgeProperties: string | null }>(
        `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId})-[edge:CALLS]->(callee:${LADYBUG_NODE_TABLE}) ` +
          `WHERE callee.type = $functionType AND ${repoClause('callee', repoHashes)} ` +
          `RETURN ${nodeReturn('callee')}, edge.properties AS edgeProperties`,
        { sourceId, functionType: NodeType.Function, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows
      .sort((a, b) => {
        const aLine = toNumber(parseObject(a.edgeProperties).line);
        const bLine = toNumber(parseObject(b.edgeProperties).line);
        return aLine - bLine || a.id.localeCompare(b.id);
      })
      .map((row) => functionInfo(decodeNode(row)));
  }

  async getClassExtensions(classId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<NodeRow>(
        `MATCH (child:${LADYBUG_NODE_TABLE})-[:EXTENDS]->(base:${LADYBUG_NODE_TABLE} {id: $classId}) ` +
          `WHERE child.type = $classType AND ${repoClause('child', repoHashes)} ` +
          `RETURN ${nodeReturn('child')} ORDER BY child.name, child.id`,
        { classId, classType: NodeType.Class, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => classInfo(decodeNode(row)));
  }

  async getInterfaceImplementations(interfaceId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<NodeRow>(
        `MATCH (child:${LADYBUG_NODE_TABLE})-[:IMPLEMENTS_INTERFACE]->(target:${LADYBUG_NODE_TABLE} {id: $interfaceId}) ` +
          `WHERE child.type = $classType AND ${repoClause('child', repoHashes)} ` +
          `RETURN ${nodeReturn('child')} ORDER BY child.name, child.id`,
        { interfaceId, classType: NodeType.Class, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => classInfo(decodeNode(row)));
  }

  async getEntityConsumers(
    entityName: string,
    repoHashes: string[],
    operation?: DbOperationType,
  ): Promise<EntityConsumer[]> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<
        NodeRow & {
          edgeProperties: string | null;
          entityProperties: string | null;
          entityName: string;
          className: string | null;
        }
      >(
        `MATCH (f:${LADYBUG_NODE_TABLE})-[edge:OPERATES_ON]->(entity:${LADYBUG_NODE_TABLE}) ` +
          `WHERE f.type = $functionType AND entity.type = $entityType ` +
          `AND ${repoClause('f', repoHashes)} ` +
          `AND (entity.name = $entityName OR contains(entity.properties, $tableNameProperty)) ` +
          `${operation ? 'AND contains(edge.properties, $operationProperty) ' : ''}` +
          `OPTIONAL MATCH (owner:${LADYBUG_NODE_TABLE})-[:HAS_METHOD]->(f) WHERE owner.type = $classType ` +
          `RETURN ${nodeReturn('f')}, edge.properties AS edgeProperties, ` +
          'entity.properties AS entityProperties, entity.name AS entityName, owner.name AS className ' +
          'ORDER BY f.filePath, f.startLine, f.id',
        {
          functionType: NodeType.Function,
          entityType: NodeType.Entity,
          classType: NodeType.Class,
          entityName,
          tableNameProperty: JSON.stringify({ tableName: entityName }).slice(1, -1),
          ...(operation ? { operationProperty: JSON.stringify({ operation }).slice(1, -1) } : {}),
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      ),
    );
    return rows
      .map((row) => ({
        row,
        op: optionalString(parseObject(row.edgeProperties).operation) ?? 'unknown',
        tableName: optionalString(parseObject(row.entityProperties).tableName),
      }))
      .filter(({ row, tableName }) => row.entityName === entityName || tableName === entityName)
      .filter(({ op }) => !operation || op === operation)
      .sort((a, b) => a.op.localeCompare(b.op) || a.row.id.localeCompare(b.row.id))
      .map(({ row, op }) => {
        const node = decodeNode(row);
        return {
          id: node.id,
          name: node.name,
          kind: stringProp(node, 'kind') === 'method' ? 'method' : 'function',
          filePath: node.filePath ?? '',
          startLine: node.startLine ?? 0,
          ...(row.className ? { className: row.className } : {}),
          operation: op as DbOperationType,
        };
      });
  }

  async getTypeUsages(typeId: string, repoHashes: string[]): Promise<TypeUsage[]> {
    const params = { typeId, ...(repoHashes.length > 0 ? { repoHashes } : {}) };
    const rows = await this.driver.withReadTransaction(async (tx) => {
      const typeRows = await tx.run<NodeRow & { edgeProperties: string | null }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[edge:USES_TYPE]->(target:${LADYBUG_NODE_TABLE} {id: $typeId}) ` +
          `WHERE ${repoClause('source', repoHashes)} ` +
          `RETURN ${nodeReturn('source')}, edge.properties AS edgeProperties`,
        params,
      );
      const importRows = await tx.run<NodeRow & { edgeProperties: string | null }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[edge:RESOLVES_TO]->(target:${LADYBUG_NODE_TABLE} {id: $typeId}) ` +
          `WHERE ${repoClause('source', repoHashes)} AND contains(edge.properties, $packageImportRelation) ` +
          `RETURN ${nodeReturn('source')}, edge.properties AS edgeProperties`,
        { ...params, packageImportRelation: '"relation":"package-import"' },
      );
      return [
        ...typeRows,
        ...importRows.filter((row) => parseObject(row.edgeProperties).relation === 'package-import'),
      ];
    });
    return rows
      .map((row) => {
        const node = decodeNode(row);
        const properties = parseObject(row.edgeProperties);
        return {
          id: node.id,
          name: node.name,
          type: node.type,
          filePath: node.filePath ?? '',
          startLine: node.startLine ?? 0,
          ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
          usage: (optionalString(properties.usage) ?? 'parameter') as TypeUsageKind,
          ...(optionalString(properties.via) ? { via: optionalString(properties.via) } : {}),
          // Value-position member reference metadata; absent on type-position edges.
          ...(optionalString(properties.useKind) ? { useKind: optionalString(properties.useKind) as TypeUseKind } : {}),
          ...(optionalString(properties.member) ? { member: optionalString(properties.member) } : {}),
          ambiguous: properties.ambiguous === true,
        };
      })
      .sort(
        (left, right) =>
          compareCodeUnits(left.filePath, right.filePath) ||
          left.startLine - right.startLine ||
          compareCodeUnits(left.id, right.id),
      );
  }

  async getEntitiesForFunctions(
    functionIds: string[],
    repoHashes: string[],
  ): Promise<
    Array<{ functionId: string; entityName: string; tableName: string; operation: string; entityId: string }>
  > {
    if (functionIds.length === 0) return [];
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{
        functionId: string;
        entityId: string;
        entityName: string;
        entityProperties: string | null;
        edgeProperties: string | null;
      }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[edge:OPERATES_ON]->(entity:${LADYBUG_NODE_TABLE}) ` +
          `WHERE list_contains($functionIds, source.id) AND ${repoClause('source', repoHashes)} ` +
          'RETURN source.id AS functionId, entity.id AS entityId, entity.name AS entityName, ' +
          'entity.properties AS entityProperties, edge.properties AS edgeProperties ' +
          'ORDER BY source.id, entity.name, entity.id',
        { functionIds, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => ({
      functionId: row.functionId,
      entityName: row.entityName,
      tableName: optionalString(parseObject(row.entityProperties).tableName) ?? '',
      operation: optionalString(parseObject(row.edgeProperties).operation) ?? 'unknown',
      entityId: row.entityId,
    }));
  }

  private async queryExternalCalls(
    repoHashes: string[],
    filters: { targetService?: string; callerId?: string; messagingOnly?: boolean } = {},
  ): Promise<ExternalCallInfo[]> {
    // Prefilter only: a call whose profile cannot name the callee (Swift/Kotlin
    // clients emit an empty serviceName) is named by the repo its RESOLVES_TO
    // target belongs to, which is not known until the target lookup below — so
    // every resolved row has to survive the Cypher filter and is decided in the
    // effective-target pass after the names are in hand.
    const targetFilter = filters.targetService
      ? `AND (contains(external.properties, $targetServiceProperty) OR ` +
        `contains(external.properties, '"resolvedTargetId":') OR ` +
        `(NOT contains(external.properties, '"targetService":') AND contains(external.properties, $serviceNameProperty))) `
      : '';
    const callerFilter = filters.callerId ? 'AND contains(external.properties, $callerIdProperty) ' : '';
    const messagingFilter = filters.messagingOnly
      ? `AND contains(external.properties, '"messagingDestination":') `
      : '';
    const nodesAndCallers = await this.driver.withReadTransaction(async (tx) => {
      const rows = await tx.run<NodeRow>(
        `MATCH (external:${LADYBUG_NODE_TABLE}) ` +
          `WHERE external.type = $externalType AND ${repoClause('external', repoHashes)} ` +
          targetFilter +
          callerFilter +
          messagingFilter +
          `RETURN ${nodeReturn('external')} ORDER BY external.id`,
        {
          externalType: NodeType.ExternalCall,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
          ...(filters.targetService
            ? {
                targetServiceProperty: JSON.stringify({ targetService: filters.targetService }).slice(1, -1),
                serviceNameProperty: JSON.stringify({ serviceName: filters.targetService }).slice(1, -1),
              }
            : {}),
          ...(filters.callerId
            ? { callerIdProperty: JSON.stringify({ callerId: filters.callerId }).slice(1, -1) }
            : {}),
        },
      );
      const nodes = rows
        .map(decodeNode)
        .filter(
          (node) =>
            (!filters.callerId || optionalString(node.properties.callerId) === filters.callerId) &&
            (!filters.messagingOnly || Boolean(optionalString(node.properties.messagingDestination))),
        );
      const callerIds = [
        ...new Set(nodes.map((node) => optionalString(node.properties.callerId)).filter((id): id is string => !!id)),
      ];
      const callerRows =
        callerIds.length === 0
          ? []
          : await tx.run<NodeRow>(
              `MATCH (caller:${LADYBUG_NODE_TABLE}) WHERE list_contains($callerIds, caller.id) RETURN ${nodeReturn('caller')}`,
              { callerIds },
            );
      // Two keyed lookups instead of a join: the target node carries the owning
      // repo id, the repository node carries its name. Cheaper than widening the
      // scan — both are bounded by the resolved calls actually returned.
      const targetIds = [
        ...new Set(
          nodes.map((node) => optionalString(node.properties.resolvedTargetId)).filter((id): id is string => !!id),
        ),
      ];
      const targetRows =
        targetIds.length === 0
          ? []
          : await tx.run<NodeRow>(
              `MATCH (target:${LADYBUG_NODE_TABLE}) WHERE list_contains($targetIds, target.id) RETURN ${nodeReturn('target')}`,
              { targetIds },
            );
      const targets = targetRows.map(decodeNode);
      const repoIds = [...new Set(targets.map((target) => target.repoId ?? target.id))];
      const repoRows =
        repoIds.length === 0
          ? []
          : await tx.run<NodeRow>(
              `MATCH (r:${LADYBUG_NODE_TABLE}) WHERE r.type = $repositoryType AND list_contains($repoIds, r.id) ` +
                `RETURN ${nodeReturn('r')}`,
              { repositoryType: NodeType.Repository, repoIds },
            );
      const repoNames = new Map(repoRows.map((row) => [row.id, row.name]));
      const targetRepoNames = new Map(
        targets
          .map((target) => [target.id, repoNames.get(target.repoId ?? target.id)] as const)
          .filter((pair): pair is readonly [string, string] => pair[1] != null),
      );
      return {
        nodes,
        callers: new Map(callerRows.map((row) => [row.id, decodeNode(row)])),
        targetRepoNames,
      };
    });
    return nodesAndCallers.nodes
      .map((node) => {
        const info = externalCallInfo(
          node,
          nodesAndCallers.callers.get(optionalString(node.properties.callerId) ?? ''),
        );
        const resolvedTargetRepoName = info.resolvedTargetId
          ? nodesAndCallers.targetRepoNames.get(info.resolvedTargetId)
          : undefined;
        return resolvedTargetRepoName ? { ...info, resolvedTargetRepoName } : info;
      })
      .filter(
        (info) =>
          !filters.targetService ||
          (info.targetService ?? info.resolvedTargetRepoName ?? info.serviceName) === filters.targetService ||
          info.resolvedTargetRepoName === filters.targetService,
      )
      .sort((a, b) => a.callerName.localeCompare(b.callerName) || a.id.localeCompare(b.id));
  }

  async getExternalCalls(repoHashes: string[], targetService?: string): Promise<ExternalCallInfo[]> {
    return this.queryExternalCalls(repoHashes, { ...(targetService ? { targetService } : {}) });
  }

  async getExternalCallsWithMessaging(repoHashes: string[]): Promise<MessagingExternalCall[]> {
    return (await this.queryExternalCalls(repoHashes, { messagingOnly: true }))
      .filter((call): call is ExternalCallInfo & { messagingDestination: string } => Boolean(call.messagingDestination))
      .map((call) => ({
        id: call.id,
        callerName: call.callerName,
        filePath: call.filePath,
        startLine: call.startLine,
        ...(call.messagingSystem ? { system: call.messagingSystem } : {}),
        destination: call.messagingDestination as string,
        ...(call.messagingDestinationRef ? { destinationRef: call.messagingDestinationRef } : {}),
      }));
  }

  async getExternalCallsFrom(functionId: string, repoHashes: string[]): Promise<ExternalCallInfo[]> {
    return this.queryExternalCalls(repoHashes, { callerId: functionId });
  }

  // -------------------------------------------------------------------------
  // Dynamic boundaries (statically unresolved calls)
  // -------------------------------------------------------------------------

  /**
   * Whether this graph carries the unresolved-call table.
   *
   * Published graph files are immutable and a writable driver creates the table
   * during `initialize()`, so the answer cannot change under one driver — the
   * probe is cached. A file built before the table existed answers `false`, and
   * every unresolved-call query then reports empty instead of failing: "no
   * boundaries recorded" is the designed degradation for an older graph.
   */
  private unresolvedCallTableProbe: Promise<boolean> | undefined;

  private async hasUnresolvedCallTable(): Promise<boolean> {
    this.unresolvedCallTableProbe ??= this.driver.withReadTransaction(async (tx) => {
      const tables = await tx.run<{ name: string }>('CALL SHOW_TABLES() RETURN name');
      return tables.some(({ name }) => name === LADYBUG_UNRESOLVED_CALL_TABLE);
    });
    return this.unresolvedCallTableProbe;
  }

  async findUnresolvedCallsByNameTail(
    nameTail: string,
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    if (nameTail.length === 0) return [];
    return this.queryUnresolvedCalls('u.calleeNameTail = $nameTail', { nameTail }, repoHashes, options);
  }

  async findUnresolvedCallsInFiles(
    filePaths: string[],
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    if (filePaths.length === 0) return [];
    return this.queryUnresolvedCalls('list_contains($filePaths, u.filePath)', { filePaths }, repoHashes, options);
  }

  private async queryUnresolvedCalls(
    filter: string,
    params: Record<string, unknown>,
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    if (!(await this.hasUnresolvedCallTable())) return [];
    const limit = clampLimit(
      options?.limit ?? UNRESOLVED_CALL_DEFAULT_LIMIT,
      UNRESOLVED_CALL_LIMIT.max,
      UNRESOLVED_CALL_LIMIT.fallback,
    );
    const repoFilter = repoHashes.length > 0 ? ' AND list_contains($repoHashes, u.repoId)' : '';
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{
        callerId: string;
        calleeExpression: string;
        calleeNameTail: string | null;
        filePath: string;
        line: number | bigint;
      }>(
        `MATCH (u:${LADYBUG_UNRESOLVED_CALL_TABLE}) WHERE ${filter}${repoFilter} ` +
          'RETURN u.callerId AS callerId, u.calleeExpression AS calleeExpression, ' +
          'u.calleeNameTail AS calleeNameTail, u.filePath AS filePath, u.line AS line ' +
          `ORDER BY filePath, line, callerId LIMIT ${limit}`,
        { ...params, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => unresolvedCallFromRow({ ...row, line: toNumber(row.line) }));
  }

  async getNodesByIds(ids: string[], repoHashes: string[]): Promise<VizNode[]> {
    if (ids.length === 0) return [];
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) AND ${repoClause('n', repoHashes, true)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.id`,
      { ids, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    return this.vizNodes(nodes);
  }

  async getNeighborCounts(nodeId: string, repoHashes: string[]): Promise<NeighborCount[]> {
    return this.driver.withReadTransaction(async (tx) => {
      type CountRow = { edgeType: string; count: number | bigint };
      const params = { nodeId, ...(repoHashes.length > 0 ? { repoHashes } : {}) };
      const outgoing = await tx.run<CountRow>(
        `MATCH (focus:${LADYBUG_NODE_TABLE} {id: $nodeId})-[r]->(neighbor:${LADYBUG_NODE_TABLE}) ` +
          `WHERE ${repoClause('neighbor', repoHashes, true)} ` +
          'RETURN label(r) AS edgeType, count(*) AS count',
        params,
      );
      const incoming = await tx.run<CountRow>(
        `MATCH (focus:${LADYBUG_NODE_TABLE} {id: $nodeId})<-[r]-(neighbor:${LADYBUG_NODE_TABLE}) ` +
          `WHERE ${repoClause('neighbor', repoHashes, true)} ` +
          'RETURN label(r) AS edgeType, count(*) AS count',
        params,
      );
      const counts: NeighborCount[] = [
        ...outgoing.map((row) => ({
          edgeType: assertEdgeType(row.edgeType),
          direction: 'out' as const,
          count: toNumber(row.count),
        })),
        ...incoming.map((row) => ({
          edgeType: assertEdgeType(row.edgeType),
          direction: 'in' as const,
          count: toNumber(row.count),
        })),
      ].filter((row) => row.count > 0);
      return counts.sort((a, b) => a.edgeType.localeCompare(b.edgeType) || a.direction.localeCompare(b.direction));
    });
  }

  async getNeighbors(nodeId: string, params: GetNeighborsParams, repoHashes: string[]): Promise<NeighborsResult> {
    const direction = params.direction ?? 'both';
    const limit = clampLimit(params.limit, NEIGHBOR_LIMIT.max, NEIGHBOR_LIMIT.fallback);
    const edgeTypes = params.edgeTypes?.length
      ? [...new Set(params.edgeTypes.map(assertEdgeType))]
      : [...LADYBUG_EDGE_TYPES];
    const edges = await this.driver.withReadTransaction(async (tx) => {
      const output: StoredEdge[] = [];
      const queryParams = {
        nodeId,
        ...(repoHashes.length > 0 ? { repoHashes } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      };
      if (direction !== 'in') {
        output.push(
          ...(await this.queryEdgesAcrossTypesInTransaction(
            tx,
            edgeTypes,
            `source.id = $nodeId AND ${repoClause('target', repoHashes, true)} ${params.cursor ? 'AND r.id > $cursor' : ''}`,
            queryParams,
            `ORDER BY r.id LIMIT ${limit + 1}`,
          )),
        );
      }
      if (direction !== 'out') {
        output.push(
          ...(await this.queryEdgesAcrossTypesInTransaction(
            tx,
            edgeTypes,
            `target.id = $nodeId AND ${repoClause('source', repoHashes, true)} ${params.cursor ? 'AND r.id > $cursor' : ''}`,
            queryParams,
            `ORDER BY r.id LIMIT ${limit + 1}`,
          )),
        );
      }
      return output;
    });
    const ordered = [
      ...new Map(edges.sort((a, b) => a.id.localeCompare(b.id)).map((edge) => [edge.id, edge])).values(),
    ];
    const { page, ...pageFacts } = pageSlice(ordered, limit, (edge) => edge.id);
    const neighborIds = [...new Set(page.map((edge) => (edge.sourceId === nodeId ? edge.targetId : edge.sourceId)))];
    const nodes = await this.getNodesByIds(neighborIds, repoHashes);
    return { nodes, edges: page.map(vizEdge), ...pageFacts };
  }

  async listNodesByType(
    type: NodeType,
    params: { limit: number; cursor?: string },
    repoHashes: string[],
  ): Promise<VizNodePage> {
    const limit = clampLimit(params.limit, NODE_PAGE_LIMIT.max, NODE_PAGE_LIMIT.fallback);
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes, true)} ` +
        `${params.cursor ? 'AND n.id > $cursor ' : ''}` +
        `RETURN ${NODE_RETURN} ORDER BY n.id LIMIT ${limit + 1}`,
      {
        type,
        ...(repoHashes.length > 0 ? { repoHashes } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
    );
    const { page, ...pageFacts } = pageSlice(nodes, limit, (node) => node.id);
    return { nodes: await this.vizNodes(page), ...pageFacts };
  }

  async getNodeWithProperties(
    id: string,
    repoHashes: string[],
  ): Promise<{ node: VizNode; properties: Record<string, unknown> } | null> {
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE} {id: $id}) WHERE ${repoClause('n', repoHashes, true)} RETURN ${NODE_RETURN} LIMIT 1`,
      { id, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    const stored = nodes[0];
    if (!stored) return null;
    const [node] = await this.vizNodes([stored]);
    return node ? { node, properties: { ...stored.properties } } : null;
  }

  async getEdgesAmong(nodeIds: string[], repoHashes: string[], limit = 2000): Promise<EdgesAmongResult> {
    return this.edgesAmong(
      nodeIds,
      LADYBUG_EDGE_TYPES,
      repoHashes,
      clampLimit(limit, EDGES_AMONG_LIMIT.max, EDGES_AMONG_LIMIT.fallback),
    );
  }

  /**
   * Set-at-a-time outbound expansion — ONE query for a whole frontier.
   *
   * The `LIMIT limit + 1` is what makes `truncated` an observation: the extra
   * id is read and discarded, so a frontier that exactly fills the budget is
   * never reported as complete. Ordering by id keeps a truncated page
   * deterministic (the same seeds always yield the same prefix), which is what
   * lets a caller's bound-tripped result be reproducible instead of arbitrary.
   */
  async expandOutboundNodeIds(
    sourceIds: readonly string[],
    params: BatchExpandParams,
    repoHashes: string[],
  ): Promise<BatchNodeIdsResult> {
    const edgeTypes = [...new Set(params.edgeTypes.map(assertEdgeType))];
    if (sourceIds.length === 0 || edgeTypes.length === 0) return { nodeIds: [], truncated: false };
    const limit = clampLimit(params.limit, SUBGRAPH_EXPANSION_LIMIT.max, SUBGRAPH_EXPANSION_LIMIT.fallback);
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ id: string }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
          'WHERE list_contains($sourceIds, source.id) AND list_contains($edgeTypes, label(r)) ' +
          `AND ${repoClause('source', repoHashes, true)} AND ${repoClause('target', repoHashes, true)} ` +
          `RETURN DISTINCT target.id AS id ORDER BY id LIMIT ${limit + 1}`,
        {
          sourceIds: [...sourceIds],
          edgeTypes,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      ),
    );
    return { nodeIds: rows.slice(0, limit).map((row) => row.id), truncated: rows.length > limit };
  }

  /**
   * The reverse-direction join: which of `candidateIds` does this source set
   * reach in one hop? Filtering the TARGET side in the query is the point —
   * expanding the source set and intersecting in JS would pull an area's whole
   * callee neighbourhood across the wire to keep a handful of ids.
   */
  async selectReachedNodeIds(
    sourceIds: readonly string[],
    candidateIds: readonly string[],
    params: BatchExpandParams,
    repoHashes: string[],
  ): Promise<BatchNodeIdsResult> {
    const edgeTypes = [...new Set(params.edgeTypes.map(assertEdgeType))];
    if (sourceIds.length === 0 || candidateIds.length === 0 || edgeTypes.length === 0) {
      return { nodeIds: [], truncated: false };
    }
    const limit = clampLimit(params.limit, SUBGRAPH_EXPANSION_LIMIT.max, SUBGRAPH_EXPANSION_LIMIT.fallback);
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ id: string }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
          'WHERE list_contains($sourceIds, source.id) AND list_contains($candidateIds, target.id) ' +
          `AND list_contains($edgeTypes, label(r)) ` +
          `AND ${repoClause('source', repoHashes, true)} AND ${repoClause('target', repoHashes, true)} ` +
          `RETURN DISTINCT target.id AS id ORDER BY id LIMIT ${limit + 1}`,
        {
          sourceIds: [...sourceIds],
          candidateIds: [...candidateIds],
          edgeTypes,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
        },
      ),
    );
    return { nodeIds: rows.slice(0, limit).map((row) => row.id), truncated: rows.length > limit };
  }

  private async edgesAmong(
    nodeIds: string[],
    edgeTypes: readonly EdgeType[],
    repoHashes: string[],
    limit = 2000,
  ): Promise<EdgesAmongResult> {
    if (nodeIds.length === 0) return { edges: [], truncated: false };
    const stored = await this.driver.withReadTransaction((tx) =>
      this.queryEdgesAcrossTypesInTransaction(
        tx,
        edgeTypes,
        `list_contains($ids, source.id) AND list_contains($ids, target.id) AND ${repoClause('source', repoHashes, true)}`,
        { ids: nodeIds, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
        `ORDER BY r.id LIMIT ${limit + 1}`,
      ),
    );
    const ordered = stored.sort((a, b) => a.id.localeCompare(b.id));
    return { edges: ordered.slice(0, limit).map(vizEdge), truncated: ordered.length > limit };
  }

  private async allEdgesAmong(
    nodeIds: string[],
    edgeTypes: readonly EdgeType[],
    repoHashes: string[],
  ): Promise<VizEdge[]> {
    if (nodeIds.length === 0) return [];
    const stored = await this.driver.withReadTransaction((tx) =>
      this.queryEdgesAcrossTypesInTransaction(
        tx,
        edgeTypes,
        `list_contains($ids, source.id) AND list_contains($ids, target.id) AND ${repoClause('source', repoHashes, true)}`,
        { ids: nodeIds, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return stored.map(vizEdge);
  }

  async getSubgraph(rootId: string, params: SubgraphParams, repoHashes: string[]): Promise<NeighborsResult> {
    const depth = Math.min(5, clampDepth(params.depth));
    const nodeCap = clampLimit(params.nodeCap, SUBGRAPH_NODE_CAP.max, SUBGRAPH_NODE_CAP.fallback);
    const edgeTypes = params.edgeTypes?.length
      ? [...new Set(params.edgeTypes.map(assertEdgeType))]
      : [...SUBGRAPH_FLOW_EDGE_TYPES];
    const direction = params.direction ?? 'both';
    const roots = await this.getNodesByIds([rootId], repoHashes);
    if (roots.length === 0) return { nodes: [], edges: [], truncated: false };

    const visited = new Set([rootId]);
    const reached: string[] = [];
    let frontier = [rootId];
    for (let level = 0; level < depth && frontier.length > 0 && reached.length <= nodeCap; level += 1) {
      const candidates = await this.driver.withReadTransaction(async (tx) => {
        const queryDirection = async (outgoing: boolean): Promise<string[]> => {
          const source = outgoing ? 'source' : 'target';
          const target = outgoing ? 'target' : 'source';
          const rows = await tx.run<{ id: string }>(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
              `WHERE list_contains($frontier, ${source}.id) AND list_contains($edgeTypes, label(r)) ` +
              `AND NOT list_contains($visited, ${target}.id) ` +
              `AND ${repoClause(source, repoHashes, true)} AND ${repoClause(target, repoHashes, true)} ` +
              `RETURN DISTINCT ${target}.id AS id ORDER BY id LIMIT ${nodeCap + 1}`,
            {
              frontier,
              visited: [...visited],
              edgeTypes,
              ...(repoHashes.length > 0 ? { repoHashes } : {}),
            },
          );
          return rows.map((row) => row.id);
        };
        if (direction === 'out') return queryDirection(true);
        if (direction === 'in') return queryDirection(false);
        return [...(await queryDirection(true)), ...(await queryDirection(false))];
      });
      const next: string[] = [];
      for (const id of [...new Set(candidates)].sort()) {
        if (visited.has(id)) continue;
        visited.add(id);
        reached.push(id);
        next.push(id);
        if (reached.length > nodeCap) break;
      }
      frontier = next;
    }
    const truncated = reached.length > nodeCap;
    const nodeIds = [rootId, ...reached.slice(0, nodeCap)];
    const nodes = await this.getNodesByIds(nodeIds, repoHashes);
    const edges = await this.allEdgesAmong(nodeIds, edgeTypes, repoHashes);
    return { nodes, edges, truncated };
  }

  async findDeadNodes(params: DeadCodeParams, repoHashes: string[]): Promise<DeadCodePage> {
    const types = params.types?.length ? params.types : [...DEAD_CODE_DEFAULT_TYPES];
    const limit = clampLimit(params.limit, DEAD_NODE_LIMIT.max, DEAD_NODE_LIMIT.fallback);
    const batchSize = Math.max(200, Math.min(1000, (limit + 1) * 4));
    const dead: StoredNode[] = [];
    let scanCursor = params.cursor;
    while (dead.length <= limit) {
      const candidates = await this.queryNodes(
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($types, n.type) AND ${repoClause('n', repoHashes)} ` +
          `${scanCursor ? 'AND n.id > $cursor ' : ''}` +
          `RETURN ${NODE_RETURN} ORDER BY n.id LIMIT ${batchSize}`,
        {
          types,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
          ...(scanCursor ? { cursor: scanCursor } : {}),
        },
      );
      if (candidates.length === 0) break;
      scanCursor = candidates[candidates.length - 1]?.id;
      const liveCandidates = candidates.filter((node) => node.properties.isExported !== true);
      const ids = liveCandidates.map((node) => node.id);
      const used = new Set<string>();
      if (ids.length > 0) {
        // Each node TYPE gets its own usage-edge set, mirroring the sqlite
        // arm's `n.type = X AND e.type IN (per-type set)`. A single union list
        // over the whole batch marked nodes as live through edge types that do
        // not count as usage for their own type (a class referenced only as a
        // DI token stayed "live" whenever a Variable candidate shared the
        // batch) — and made results vary with pagination, since the union
        // depended on which types landed in the same batch.
        const byType = new Map<NodeType, string[]>();
        for (const node of liveCandidates) {
          const bucket = byType.get(node.type) ?? [];
          bucket.push(node.id);
          byType.set(node.type, bucket);
        }
        for (const [nodeType, typeIds] of byType) {
          const relationTypes = [...deadCodeUsageEdges(nodeType)].map(assertEdgeType);
          if (relationTypes.length === 0) continue;
          const rows = await this.driver.withReadTransaction((tx) =>
            tx.run<{ targetId: string }>(
              `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
                'WHERE list_contains($ids, target.id) AND list_contains($edgeTypes, label(r)) ' +
                'RETURN DISTINCT target.id AS targetId',
              { ids: typeIds, edgeTypes: relationTypes },
            ),
          );
          for (const row of rows) used.add(row.targetId);
        }
      }
      for (const candidate of liveCandidates) {
        if (!used.has(candidate.id)) dead.push(candidate);
        if (dead.length > limit) break;
      }
      if (candidates.length < batchSize) break;
    }
    const { page, ...pageFacts } = pageSlice(dead, limit, (node) => node.id);
    const coverage = await this.getCoverageCounts(repoHashes);
    return {
      nodes: await this.vizNodes(page),
      lowCoverageRepos: lowCoverageRepoNames(coverage),
      ...pageFacts,
    };
  }

  async getCrossRepoBridges(params: CrossRepoBridgeParams, repoHashes: string[]): Promise<NeighborsResult> {
    const limit = clampLimit(params.limit, BRIDGE_LIMIT.max, BRIDGE_LIMIT.fallback);
    const resolved = await this.driver.withReadTransaction((tx) =>
      this.queryEdgesInTransaction(
        tx,
        EdgeType.ResolvesTo,
        'source.type = $sourceType AND target.type = $targetType AND source.repoId <> target.repoId AND ' +
          `${repoHashes.length > 0 ? `(${repoClause('source', repoHashes)} OR ${repoClause('target', repoHashes)})` : 'true'} ` +
          `${params.focusRepoHashes?.length ? 'AND (list_contains($focusRepoHashes, source.repoId) OR list_contains($focusRepoHashes, target.repoId))' : ''}`,
        {
          sourceType: NodeType.ExternalCall,
          targetType: NodeType.Entrypoint,
          ...(repoHashes.length > 0 ? { repoHashes } : {}),
          ...(params.focusRepoHashes?.length ? { focusRepoHashes: params.focusRepoHashes } : {}),
        },
        `ORDER BY r.id LIMIT ${limit + 1}`,
      ),
    );
    const truncated = resolved.length > limit;
    const retained = resolved.slice(0, limit);
    const externalIds = retained.map((edge) => edge.sourceId);
    const entrypointIds = retained.map((edge) => edge.targetId);
    const [makes, handles] = await this.driver.withReadTransaction(async (tx) => {
      const makesRows = externalIds.length
        ? await this.queryEdgesInTransaction(tx, EdgeType.MakesExternalCall, 'list_contains($ids, target.id)', {
            ids: externalIds,
          })
        : [];
      const handleRows = entrypointIds.length
        ? await this.queryEdgesInTransaction(tx, EdgeType.Handles, 'list_contains($ids, source.id)', {
            ids: entrypointIds,
          })
        : [];
      return [makesRows, handleRows] as const;
    });
    const allEdges = [...makes, ...retained, ...handles];
    const nodeIds = [...new Set(allEdges.flatMap((edge) => [edge.sourceId, edge.targetId]))];
    return {
      nodes: await this.getNodesByIds(nodeIds, repoHashes),
      edges: allEdges.map(vizEdge),
      truncated,
    };
  }

  async getPackageDependencyRollup(repoHashes: string[]): Promise<PackageDependencyRollup[]> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{
        sourcePackageId: string;
        sourcePackageName: string;
        targetPackageId: string;
        targetPackageName: string;
        callCount: number | bigint;
        minConfidence: number;
        inferred: number | bigint;
      }>(
        `MATCH (sourcePackage:${LADYBUG_NODE_TABLE})-[:CONTAINS_FILE]->(sourceFile:${LADYBUG_NODE_TABLE}) ` +
          `MATCH (sourceFile)-[:CONTAINS_FUNCTION]->(sourceFunction:${LADYBUG_NODE_TABLE})-[call:CALLS]->(targetFunction:${LADYBUG_NODE_TABLE}) ` +
          `MATCH (targetFile:${LADYBUG_NODE_TABLE})-[:CONTAINS_FUNCTION]->(targetFunction) ` +
          `MATCH (targetPackage:${LADYBUG_NODE_TABLE})-[:CONTAINS_FILE]->(targetFile) ` +
          `WHERE sourcePackage.type = $packageType AND targetPackage.type = $packageType ` +
          `AND sourcePackage.id <> targetPackage.id AND ${repoClause('sourceFunction', repoHashes)} ` +
          'RETURN sourcePackage.id AS sourcePackageId, sourcePackage.name AS sourcePackageName, ' +
          'targetPackage.id AS targetPackageId, targetPackage.name AS targetPackageName, ' +
          "count(*) AS callCount, min(call.confidence) AS minConfidence, max(CASE WHEN call.createdBy <> 'parser' THEN 1 ELSE 0 END) AS inferred " +
          'ORDER BY callCount DESC, sourcePackageId, targetPackageId',
        { packageType: NodeType.Package, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => ({
      sourcePackageId: row.sourcePackageId,
      sourcePackageName: row.sourcePackageName,
      targetPackageId: row.targetPackageId,
      targetPackageName: row.targetPackageName,
      callCount: toNumber(row.callCount),
      minConfidence: toNumber(row.minConfidence),
      inferred: toNumber(row.inferred) === 1,
    }));
  }

  async getComponentGraph(repoHashes: string[]): Promise<ComponentGraphData> {
    const componentTypes = [NodeType.Entrypoint, NodeType.Component, NodeType.Class, NodeType.StateStore];
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($types, n.type) AND ${repoClause('n', repoHashes)} ` +
        `RETURN ${NODE_RETURN} ORDER BY n.id`,
      { types: componentTypes, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
    );
    const ids = nodes.map((node) => node.id);
    const edges = await this.allEdgesAmong(ids, LADYBUG_EDGE_TYPES, repoHashes);
    return {
      nodes: nodes.map(
        (node): ComponentGraphNode => ({
          id: node.id,
          type: node.type,
          name: node.name,
          filePath: node.filePath ?? null,
          startLine: node.startLine ?? null,
          ...(node.summary ? { summary: node.summary } : {}),
        }),
      ),
      edges: edges.map(
        (edge): ComponentGraphEdge => ({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          type: edge.type,
          confidence: edge.confidence,
          createdBy: edge.createdBy,
        }),
      ),
    };
  }

  async getResolvesEdge(sourceCallId: string): Promise<ResolvesEdgeInfo | null> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<EdgeRow>(
        `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceCallId})-[r:RESOLVES_TO]->(target:${LADYBUG_NODE_TABLE}) ` +
          'RETURN r.id AS id, source.id AS sourceId, target.id AS targetId, r.confidence AS confidence, ' +
          'r.createdBy AS createdBy, r.properties AS properties ORDER BY r.confidence DESC LIMIT 1',
        { sourceCallId },
      ),
    );
    const row = rows[0];
    if (!row) return null;
    const edge = decodeEdge(EdgeType.ResolvesTo, row);
    const chain = Array.isArray(edge.properties.chain) ? (edge.properties.chain as ResolvedHop[]) : undefined;
    return {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      confidence: edge.confidence,
      ...(optionalString(edge.properties.via) ? { via: optionalString(edge.properties.via) as HopVia } : {}),
      ...(chain ? { chain } : {}),
      ...(optionalString(edge.properties.sourceRepoName)
        ? { sourceRepoName: optionalString(edge.properties.sourceRepoName) }
        : {}),
      ...(optionalString(edge.properties.targetRepoName)
        ? { targetRepoName: optionalString(edge.properties.targetRepoName) }
        : {}),
      ...(optionalString(edge.properties.confidenceLevel)
        ? { confidenceLevel: optionalString(edge.properties.confidenceLevel) }
        : {}),
    };
  }

  async getMonikeredFunctions(repoHashes: string[]): Promise<FunctionInfo[]> {
    if (repoHashes.length === 0) return [];
    const nodes = await this.queryNodes(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.type = $type AND ${repoClause('n', repoHashes)} ` +
        `AND contains(n.properties, '"monikerPackage":') ` +
        `RETURN ${NODE_RETURN} ORDER BY n.filePath, n.startLine, n.id`,
      { type: NodeType.Function, repoHashes },
    );
    return nodes.filter((node) => optionalString(node.properties.monikerPackage)).map((node) => functionInfo(node));
  }

  /**
   * Intra-repo CALLS edges whose target is one of `calleeIds` — the evidence the
   * cross-repo call-edge hop joins on. The callee set is bounded by the caller
   * (the monikered SDK method nodes), so this stays a keyed lookup.
   */
  async getInternalCallEdges(
    repoHashes: string[],
    calleeIds: string[],
  ): Promise<{ callerId: string; calleeId: string }[]> {
    if (calleeIds.length === 0) return [];
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ callerId: string; calleeId: string }>(
        `MATCH (caller:${LADYBUG_NODE_TABLE})-[:${EdgeType.Calls}]->(callee:${LADYBUG_NODE_TABLE}) ` +
          `WHERE list_contains($calleeIds, callee.id) AND ${repoClause('caller', repoHashes)} ` +
          'RETURN DISTINCT caller.id AS callerId, callee.id AS calleeId ORDER BY callerId, calleeId',
        { calleeIds, ...(repoHashes.length > 0 ? { repoHashes } : {}) },
      ),
    );
    return rows.map((row) => ({ callerId: row.callerId, calleeId: row.calleeId }));
  }

  async getAppliedGraphSnapshot(repoId: string): Promise<AppliedGraphSnapshot | null> {
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ snapshot: string | null }>(
        'MATCH (meta:CoredocMeta {repoId: $repoId}) RETURN meta.snapshot AS snapshot LIMIT 1',
        { repoId },
      ),
    );
    const snapshot = rows[0]?.snapshot;
    return snapshot ? parseAppliedGraphSnapshot(snapshot, repoId) : null;
  }

  async pushNodes(nodes: GraphNode[]): Promise<number> {
    if (nodes.length === 0) return 0;
    return this.driver.executeBatch(nodes, async (batch, tx) => {
      for (const node of batch) await this.upsertNode(tx, node);
    });
  }

  private async upsertNode(tx: ITransaction, node: GraphNode): Promise<void> {
    await tx.run(
      `MERGE (n:${LADYBUG_NODE_TABLE} {id: $id})\n` +
        'SET n.type = $type, n.name = $name, n.properties = $properties, n.summary = $summary, ' +
        'n.embedding = $embedding, n.repoId = $repoId, n.filePath = $filePath, ' +
        'n.startLine = $startLine, n.endLine = $endLine',
      {
        id: node.id,
        type: node.type,
        name: node.name,
        properties: JSON.stringify(node.properties ?? {}),
        summary: node.summary ?? null,
        embedding: node.embedding ?? null,
        repoId: node.repoId ?? null,
        filePath: node.filePath ?? null,
        startLine: node.startLine ?? null,
        endLine: node.endLine ?? null,
      },
    );
  }

  async pushEdges(edges: GraphEdge[], options?: { collisionTypes: readonly EdgeType[] }): Promise<number> {
    if (edges.length === 0) return 0;
    const collisionTypes = options?.collisionTypes?.map((type) => assertEdgeType(type));
    if (collisionTypes) {
      const collisionTypeSet = new Set(collisionTypes);
      for (const edge of edges) {
        if (!collisionTypeSet.has(assertEdgeType(edge.type))) {
          throw new Error('Ladybug edge collision scope must include every incoming relationship type');
        }
      }
    }
    let edgeIndex: EdgeIndex | undefined;
    return this.driver.executeBatch(edges, async (batch, tx) => {
      edgeIndex ??= await this.loadEdgeIndex(tx, collisionTypes);
      for (const edge of batch) await this.upsertEdge(tx, edge, edgeIndex);
    });
  }

  private async loadEdgeIndex(tx: ITransaction, types: readonly EdgeType[] = LADYBUG_EDGE_TYPES): Promise<EdgeIndex> {
    const index: EdgeIndex = { byId: new Map(), byIdentity: new Map() };
    for (const type of types) {
      const rows = await tx.run<{ id: string | null; sourceId: string; targetId: string }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
          'RETURN r.id AS id, source.id AS sourceId, target.id AS targetId',
      );
      for (const row of rows) {
        const stored: IndexedEdge = {
          ...(row.id ? { id: row.id } : {}),
          sourceId: row.sourceId,
          targetId: row.targetId,
          type,
        };
        index.byIdentity.set(edgeIdentity(row.sourceId, row.targetId, type), stored);
        if (row.id) index.byId.set(row.id, stored);
      }
    }
    return index;
  }

  /**
   * Drop-and-report variant for changeset ingestion. A dangling edge is
   * dropped (with any prior same-id edge removed, matching a clean rebuild);
   * a malformed edge TYPE still fails fast — an unsupported relation is
   * corruption, not a legitimately unresolved reference.
   */
  private async upsertEdgeIfEndpointsExist(
    tx: ITransaction,
    edge: GraphEdge,
    index: EdgeIndex,
  ): Promise<{ inserted: boolean; deletedStale: boolean }> {
    assertEdgeType(edge.type);
    const endpoints = await tx.run<{ sourceId: string }>(
      `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId}), (target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
        'RETURN source.id AS sourceId LIMIT 1',
      { sourceId: edge.sourceId, targetId: edge.targetId },
    );
    if (endpoints.length === 0) {
      // Clean-build equivalence: a fresh file would contain neither the
      // dropped edge NOR any prior edge under the same id. Leaving the stale
      // one behind would diverge from what a rebuild of the same input yields.
      const stale = index.byId.get(edge.id);
      if (stale) {
        await tx.run(
          `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId})-[stored:${stale.type}]->(target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
            'DELETE stored',
          { sourceId: stale.sourceId, targetId: stale.targetId },
        );
        index.byIdentity.delete(edgeIdentity(stale.sourceId, stale.targetId, stale.type));
        index.byId.delete(edge.id);
        return { inserted: false, deletedStale: true };
      }
      return { inserted: false, deletedStale: false };
    }
    await this.upsertEdge(tx, edge, index);
    return { inserted: true, deletedStale: false };
  }

  private async upsertEdge(tx: ITransaction, edge: GraphEdge, index: EdgeIndex): Promise<void> {
    const type = assertEdgeType(edge.type);
    const endpoints = await tx.run<{ sourceId: string; targetId: string }>(
      `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId}), (target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
        'RETURN source.id AS sourceId, target.id AS targetId LIMIT 1',
      { sourceId: edge.sourceId, targetId: edge.targetId },
    );
    if (endpoints.length === 0) {
      throw new Error(`Cannot upsert graph edge ${edge.id}: missing endpoint ${edge.sourceId} or ${edge.targetId}`);
    }

    const identity = edgeIdentity(edge.sourceId, edge.targetId, type);
    const existingById = index.byId.get(edge.id);
    const existingByIdentity = index.byIdentity.get(identity);
    const storedId = existingById ? edge.id : (existingByIdentity?.id ?? edge.id);
    const removals = new Map<string, IndexedEdge>();
    if (existingById) {
      removals.set(edgeIdentity(existingById.sourceId, existingById.targetId, existingById.type), existingById);
    }
    if (existingByIdentity) removals.set(identity, existingByIdentity);
    for (const [existingIdentity, existing] of removals) {
      await tx.run(
        `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId})-[stored:${existing.type}]->(target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
          'DELETE stored',
        { sourceId: existing.sourceId, targetId: existing.targetId },
      );
      index.byIdentity.delete(existingIdentity);
      if (existing.id && index.byId.get(existing.id) === existing) index.byId.delete(existing.id);
    }
    await tx.run(
      `MATCH (source:${LADYBUG_NODE_TABLE} {id: $sourceId}), (target:${LADYBUG_NODE_TABLE} {id: $targetId}) ` +
        `CREATE (source)-[r:${type}]->(target) ` +
        'SET r.id = $id, r.confidence = $confidence, r.createdBy = $createdBy, r.properties = $properties',
      {
        id: storedId,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        confidence: edge.confidence,
        createdBy: edge.createdBy,
        properties: JSON.stringify(edge.properties ?? {}),
      },
    );
    const stored: IndexedEdge = { id: storedId, sourceId: edge.sourceId, targetId: edge.targetId, type };
    index.byIdentity.set(identity, stored);
    index.byId.set(storedId, stored);
  }

  async deleteRepository(repoId: string): Promise<void> {
    await this.driver.withWriteTransaction(async (tx) => {
      await this.deleteRepositoryGraph(tx, repoId);
      await tx.run('MATCH (meta:CoredocMeta {repoId: $repoId}) DELETE meta', { repoId });
    });
  }

  /**
   * Replace one repo's unresolved-call rows (see the changeset field's contract).
   *
   * One CREATE per row, like the node/edge upserts beside it. Local Ladybug
   * pushes bulk-load through the file builder's COPY path instead, so this loop
   * only ever sees changeset-sized writes; batch it if that stops being true.
   */
  private async replaceUnresolvedCalls(
    tx: ITransaction,
    repoId: string,
    records: readonly UnresolvedCallRecord[],
  ): Promise<void> {
    await this.deleteUnresolvedCalls(tx, repoId);
    for (const [index, record] of records.entries()) {
      await tx.run(
        `CREATE (u:${LADYBUG_UNRESOLVED_CALL_TABLE} {id: $id, repoId: $repoId, callerId: $callerId, ` +
          'calleeExpression: $calleeExpression, calleeNameTail: $calleeNameTail, filePath: $filePath, line: $line})',
        {
          id: ladybugUnresolvedCallId(repoId, index),
          repoId,
          callerId: record.callerId,
          calleeExpression: record.calleeExpression,
          calleeNameTail: record.calleeNameTail,
          filePath: record.filePath,
          line: record.line,
        },
      );
    }
  }

  private async deleteUnresolvedCalls(tx: ITransaction, repoId: string): Promise<void> {
    await tx.run(`MATCH (u:${LADYBUG_UNRESOLVED_CALL_TABLE}) WHERE u.repoId = $repoId DELETE u`, { repoId });
  }

  async deleteEdgesByType(edgeType: EdgeType, repoIds: string[]): Promise<void> {
    if (repoIds.length === 0) return;
    const type = assertEdgeType(edgeType);
    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
          'WHERE list_contains($repoIds, source.repoId) OR list_contains($repoIds, source.id) DELETE r',
        { repoIds },
      );
    });
  }

  async updateResolvedTargetIds(updates: Map<string, string>): Promise<void> {
    if (updates.size === 0) return;
    await this.driver.withWriteTransaction(async (tx) => {
      const nodes = await this.queryNodesInTransaction(
        tx,
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) RETURN ${NODE_RETURN}`,
        { ids: [...updates.keys()] },
      );
      for (const node of nodes) {
        const targetId = updates.get(node.id);
        if (!targetId) continue;
        await this.upsertNode(tx, { ...node, properties: { ...node.properties, resolvedTargetId: targetId } });
      }
    });
  }

  async clearResolvedTargetIds(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.driver.withWriteTransaction(async (tx) => {
      const nodes = await this.queryNodesInTransaction(
        tx,
        `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) RETURN ${NODE_RETURN}`,
        { ids: nodeIds },
      );
      for (const node of nodes) {
        if (!Object.hasOwn(node.properties, 'resolvedTargetId')) continue;
        const { resolvedTargetId: _removed, ...properties } = node.properties;
        await this.upsertNode(tx, { ...node, properties });
      }
    });
  }

  private async deleteNodesAndIncidentEdges(tx: ITransaction, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let deletedEdges = 0;
    for (const type of LADYBUG_EDGE_TYPES) {
      const countRows = await tx.run<{ count: number | bigint }>(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
          'WHERE list_contains($ids, source.id) OR list_contains($ids, target.id) RETURN count(*) AS count',
        { ids },
      );
      deletedEdges += toNumber(countRows[0]?.count);
      await tx.run(
        `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
          'WHERE list_contains($ids, source.id) OR list_contains($ids, target.id) DELETE r',
        { ids },
      );
    }
    await tx.run(`MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) DELETE n`, { ids });
    return deletedEdges;
  }

  private async deleteRepositoryGraph(
    tx: ITransaction,
    repoId: string,
  ): Promise<{ nodesDeleted: number; edgesDeleted: number }> {
    const nodeRows = await tx.run<{ count: number | bigint }>(
      `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.id = $repoId OR n.repoId = $repoId RETURN count(*) AS count`,
      { repoId },
    );
    const edgeRows = await tx.run<{ count: number | bigint }>(
      `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
        'WHERE source.id = $repoId OR source.repoId = $repoId OR target.id = $repoId OR target.repoId = $repoId ' +
        'RETURN count(*) AS count',
      { repoId },
    );
    await tx.run(
      `MATCH (source:${LADYBUG_NODE_TABLE})-[r]->(target:${LADYBUG_NODE_TABLE}) ` +
        'WHERE source.id = $repoId OR source.repoId = $repoId OR target.id = $repoId OR target.repoId = $repoId ' +
        'DELETE r',
      { repoId },
    );
    await tx.run(`MATCH (n:${LADYBUG_NODE_TABLE}) WHERE n.id = $repoId OR n.repoId = $repoId DELETE n`, { repoId });
    await this.deleteUnresolvedCalls(tx, repoId);
    return {
      nodesDeleted: toNumber(nodeRows[0]?.count),
      edgesDeleted: toNumber(edgeRows[0]?.count),
    };
  }

  async applyChangeset(
    changeset: {
      repoId: string;
      repoIdsToDelete?: string[];
      nodesToAdd: GraphNode[];
      nodesToUpdate: GraphNode[];
      nodeIdsToDelete: string[];
      edgeNodeIdsToWipe: string[];
      edgeTypesToPreserve?: string[];
      edgesToInsert: GraphEdge[];
      nodeMetadataUpdates?: NodeMetadataUpdate[];
      unresolvedCalls?: readonly UnresolvedCallRecord[];
    },
    options?: ApplyChangesetOptions,
  ): Promise<GraphApplyReceipt> {
    const preservedTypes = new Set((changeset.edgeTypesToPreserve ?? []).map(assertEdgeType));
    const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try {
        return await work();
      } finally {
        options?.onPhase?.(name, Date.now() - started);
      }
    };

    return this.driver.withWriteTransaction(async (tx) => {
      options?.signal?.throwIfAborted();
      const receipt: GraphApplyReceipt = {
        nodesAdded: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesDeleted: 0,
        edgesInserted: 0,
      };

      const repositoryIds = [...new Set(changeset.repoIdsToDelete ?? [])];
      await phase('repositories.delete', async () => {
        for (const repoId of repositoryIds) {
          options?.signal?.throwIfAborted();
          const deleted = await this.deleteRepositoryGraph(tx, repoId);
          receipt.nodesDeleted += deleted.nodesDeleted;
          receipt.edgesDeleted += deleted.edgesDeleted;
          await tx.run('MATCH (meta:CoredocMeta {repoId: $repoId}) DELETE meta', { repoId });
        }
      });

      await phase('nodes.delete', async () => {
        const ids = [
          ...new Set(
            changeset.nodeIdsToDelete.filter(
              (id) => !repositoryIds.some((repoId) => id === repoId || id.startsWith(`${repoId}:`)),
            ),
          ),
        ];
        receipt.edgesDeleted += await this.deleteNodesAndIncidentEdges(tx, ids);
        receipt.nodesDeleted += ids.length;
      });

      const upserts = [...changeset.nodesToAdd, ...changeset.nodesToUpdate];
      await phase('nodes.upsert', async () => {
        for (let index = 0; index < upserts.length; index += 1) {
          options?.signal?.throwIfAborted();
          await this.upsertNode(tx, upserts[index] as GraphNode);
          options?.onBatch?.({ kind: 'nodes', completed: index + 1, total: upserts.length });
        }
      });
      receipt.nodesAdded = changeset.nodesToAdd.length;
      receipt.nodesUpdated = changeset.nodesToUpdate.length;

      await phase('edges.wipe', async () => {
        if (changeset.edgeNodeIdsToWipe.length === 0) return;
        for (const type of LADYBUG_EDGE_TYPES) {
          if (preservedTypes.has(type)) continue;
          const rows = await tx.run<{ count: number | bigint }>(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
              'WHERE list_contains($ids, source.id) OR list_contains($ids, target.id) RETURN count(*) AS count',
            { ids: changeset.edgeNodeIdsToWipe },
          );
          receipt.edgesDeleted += toNumber(rows[0]?.count);
          await tx.run(
            `MATCH (source:${LADYBUG_NODE_TABLE})-[r:${type}]->(target:${LADYBUG_NODE_TABLE}) ` +
              'WHERE list_contains($ids, source.id) OR list_contains($ids, target.id) DELETE r',
            { ids: changeset.edgeNodeIdsToWipe },
          );
        }
      });

      await phase('edges.insert', async () => {
        if (changeset.edgesToInsert.length === 0) return;
        // A full repository replacement removed every incident edge before
        // inserting this repo-owned snapshot. Start empty just as Neo4j does;
        // incremental and arbitrary changesets retain the full semantic fallback.
        const edgeIndex = repositoryIds.includes(changeset.repoId)
          ? { byId: new Map<string, IndexedEdge>(), byIdentity: new Map<string, IndexedEdge>() }
          : await this.loadEdgeIndex(tx);
        let droppedDangling = 0;
        for (let index = 0; index < changeset.edgesToInsert.length; index += 1) {
          options?.signal?.throwIfAborted();
          const edge = changeset.edgesToInsert[index] as GraphEdge;
          // Transformer output legitimately contains dangling references
          // (CALLS with an unresolved calleeId, HANDLES to an out-of-repo
          // file, …). The cloud file-builder's documented policy is
          // drop-and-count; throwing here instead rolled back entire local
          // pushes of repos that push fine on sqlite. Same policy, same graph.
          const outcome = await this.upsertEdgeIfEndpointsExist(tx, edge, edgeIndex);
          if (outcome.inserted) {
            receipt.edgesInserted += 1;
          } else {
            droppedDangling += 1;
            if (outcome.deletedStale) receipt.edgesDeleted += 1;
          }
          options?.onBatch?.({ kind: 'edges', completed: index + 1, total: changeset.edgesToInsert.length });
        }
        if (droppedDangling > 0) {
          console.warn(
            `[coredoc/db] Dropped ${droppedDangling} dangling edges while applying changeset for ${changeset.repoId}`,
          );
        }
      });

      const metadataUpdates = changeset.nodeMetadataUpdates ?? [];
      await phase('metadata.update', async () => {
        if (metadataUpdates.length === 0) return;
        const existing = await this.queryNodesInTransaction(
          tx,
          `MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) RETURN ${NODE_RETURN}`,
          { ids: metadataUpdates.map((update) => update.id) },
        );
        const byId = new Map(existing.map((node) => [node.id, node]));
        for (let index = 0; index < metadataUpdates.length; index += 1) {
          options?.signal?.throwIfAborted();
          const update = metadataUpdates[index] as NodeMetadataUpdate;
          const node = byId.get(update.id);
          if (node) {
            await this.upsertNode(tx, {
              ...node,
              properties: { ...node.properties, ...update.properties },
              ...(update.summary !== undefined ? { summary: update.summary } : {}),
              ...(update.embedding !== undefined ? { embedding: update.embedding } : {}),
            });
          }
          options?.onBatch?.({ kind: 'metadata', completed: index + 1, total: metadataUpdates.length });
        }
      });
      receipt.nodesUpdated += metadataUpdates.length;

      // Not counted in the receipt: these are neither nodes nor edges, and a
      // caller reconciling the receipt against the transform's counts must keep
      // seeing the same numbers.
      await phase('unresolvedCalls.replace', async () => {
        if (!changeset.unresolvedCalls) return;
        await this.replaceUnresolvedCalls(tx, changeset.repoId, changeset.unresolvedCalls);
      });

      if (options?.snapshot) {
        receipt.totalNodeCount = options.snapshot.totalNodeCount;
        receipt.totalEdgeCount = options.snapshot.totalEdgeCount;
        const repository = await this.queryNodesInTransaction(
          tx,
          `MATCH (n:${LADYBUG_NODE_TABLE} {id: $repoId}) WHERE n.type = $type RETURN ${NODE_RETURN} LIMIT 1`,
          { repoId: changeset.repoId, type: NodeType.Repository },
        );
        if (!repository[0]) {
          throw new Error(`Cannot record graph snapshot: repository node ${changeset.repoId} is missing`);
        }
        const snapshot: AppliedGraphSnapshot = {
          ...options.snapshot,
          nodeCount: options.snapshot.totalNodeCount,
          edgeCount: options.snapshot.totalEdgeCount,
          receipt,
          appliedAt: new Date().toISOString(),
        };
        await tx.run('MERGE (meta:CoredocMeta {repoId: $repoId}) SET meta.snapshot = $snapshot', {
          repoId: changeset.repoId,
          snapshot: JSON.stringify(snapshot),
        });
      }

      return receipt;
    });
  }

  // -------------------------------------------------------------------------
  // Read-only Cypher (run_cypher_query substrate)
  // -------------------------------------------------------------------------

  /**
   * The read-only boundary, asserted before anything else runs.
   *
   * `assertReadOnlyCypherAllowlisted` is the security gate for the query text;
   * this makes the handle half true by construction — a caller-supplied query
   * can never reach a writable Ladybug connection, whatever the guard misses.
   */
  private assertReadOnlyCypherHandle(): void {
    if (!this.driver.readOnly) {
      throw new Error('Read-only Cypher requires a read-only Ladybug handle (this repository is writable)');
    }
  }

  /**
   * Rows shape: a scalar table. Streams at most `limit + 1` rows so an
   * unbounded match is never materialized — the extra row is what proves
   * truncation. Composite cells are rejected with projection guidance.
   */
  async runReadOnlyCypherRows(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherRowsResult> {
    this.assertReadOnlyCypherHandle();
    assertReadOnlyCypherAllowlisted(query, 'ladybug');
    // Source protection is a QUERY-side check, not an output scan: a projection
    // can mine source in-engine (`regexp_extract(n.properties, …)`) and never
    // emit a field an output scan recognises, so the query text is rejected
    // before execution when the deployment does not serve source.
    if (!allowSourcesInGraph()) assertQueryDoesNotProjectSource(query);
    const limit = Math.max(0, Math.floor(opts.limit));

    return this.driver.runTimedReadQuery<CypherRowsResult>(
      query,
      opts.params ?? {},
      CYPHER_TIMEOUT_MS,
      async (columns, stream) => {
        const rows: CypherScalar[][] = [];
        let truncated = false;
        for await (const row of stream) {
          if (rows.length >= limit) {
            truncated = true;
            break;
          }
          rows.push(columns.map((column) => normalizeLadybugCypherScalar(row[column])));
        }
        return { columns, rows, truncated };
      },
    );
  }

  /**
   * Graph shape: returned node/relationship values projected into the viz
   * contract. Node conversion goes through `buildVizNode` (via `vizNodes`) so
   * INT64 line numbers are coerced exactly like every other read — nothing
   * non-numeric can reach a `VizNode` numeric slot. Relationships whose
   * endpoints are not among the returned nodes are dropped.
   */
  async runReadOnlyCypher(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherGraphResult> {
    this.assertReadOnlyCypherHandle();
    assertReadOnlyCypherAllowlisted(query, 'ladybug');
    // Source protection is a QUERY-side check, not an output scan (see the rows
    // shape for the rationale): reject a source-bearing projection before it runs.
    if (!allowSourcesInGraph()) assertQueryDoesNotProjectSource(query);
    const limit = Math.max(0, Math.floor(opts.limit));

    const accumulator = await this.driver.runTimedReadQuery<LadybugCypherGraphAccumulator>(
      query,
      opts.params ?? {},
      CYPHER_TIMEOUT_MS,
      async (columns, stream) => {
        const collected: LadybugCypherGraphAccumulator = { nodes: new Map(), rels: [], truncated: false };
        for await (const row of stream) {
          // Both capped sets are full: further rows can only add truncated
          // content, so stop pulling. `collectLadybugGraphElements` also caps
          // each set at `limit`, so a rel-only projection cannot balloon the
          // accumulator even if this break never fires (no nodes to fill).
          if (collected.nodes.size >= limit && collected.rels.length >= limit) {
            collected.truncated = true;
            break;
          }
          for (const column of columns) {
            collectLadybugGraphElements(row[column], limit, collected);
          }
        }
        return collected;
      },
    );

    // Conversion runs AFTER the driver operation: `vizNodes` issues its own
    // read for repository names, which would deadlock inside the serialized
    // operation the timed read holds.
    const byInternalId = [...accumulator.nodes.entries()];
    const nodes = await this.vizNodes(byInternalId.map(([, value]) => decodeNode(value)));
    const idByInternalId = new Map(byInternalId.map(([key, value]) => [key, value.id]));

    const edges = new Map<string, VizEdge>();
    let truncated = accumulator.truncated;
    for (const rel of accumulator.rels) {
      const sourceId = idByInternalId.get(internalIdKey(rel._src));
      const targetId = idByInternalId.get(internalIdKey(rel._dst));
      if (!sourceId || !targetId) continue; // endpoint not among the returned nodes
      const type = assertEdgeType(rel._label);
      const edge = decodeEdge(type, { ...rel, sourceId, targetId });
      if (edges.has(edge.id)) continue;
      if (edges.size >= limit) {
        truncated = true;
        continue;
      }
      edges.set(edge.id, vizEdge(edge));
    }

    return { nodes, edges: [...edges.values()], truncated };
  }
}
