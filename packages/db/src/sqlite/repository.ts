/**
 * SQLite Graph Repository Implementation
 *
 * Implements IGraphRepository for SQLite backend.
 * All graph queries are converted from Cypher to SQL.
 */

import type {
  IDatabaseDriver,
  ITransaction,
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
  TransactionStatement,
  BatchProgressKind,
  ApplyChangesetOptions,
  AppliedGraphSnapshot,
  GraphApplyReceipt,
  NodeMetadataUpdate,
  UnresolvedCallRecord,
  UnresolvedCallQueryOptions,
} from '../types.js';
// NodeType/EdgeType are enums (runtime values) — used as values in findCode's
// variable filter and the Tier B badge/edge-label mapping.
import { NodeType, EdgeType } from '../types.js';
import { analysisFrom, callResolutionFrom, dbOpResolutionFrom } from '../coverage-record.js';
import { entrypointAddressMatches, staticRouteAnchor } from '../route-path.js';
import { buildVizEdge, buildVizNode, pageSlice, type VizNodeFields } from '../viz-map.js';
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
  UNRESOLVED_CALL_DEFAULT_LIMIT,
  UNRESOLVED_CALL_LIMIT,
} from '../graph-query-defaults.js';
import { type ExternalCallRow, externalCallInfoFromRow } from '../external-call-row.js';
import {
  ENTRYPOINT_ADDRESS_PROPERTY_KEYS,
  callerInfoFromRow,
  codeElementFromRow,
  entityInfoFromRow,
  entrypointInfoFromRow,
  functionInfoFromRow,
  namedDeclarationFromRow,
  unresolvedCallFromRow,
} from '../node-row.js';
import type { VizNodePage, DeadCodePage } from '@coredoc/core';
import type { DbOperationType } from '@coredoc/core/types';
import type { ResolvedHop, HopVia, VizNode, VizEdge, NeighborCount, EdgeDirection } from '@coredoc/core';
import { runStatements } from '../transaction.js';
import { parseAppliedGraphSnapshot } from '../graph-snapshot.js';

// =============================================================================
// Helper Functions
// =============================================================================

const ROWS_PER_WRITE_STATEMENT = 50;
// Turso kills a hrana stream fed a ~2MiB/25-statement pipeline (~20s stall →
// SERVER_ERROR 404, reproduced deterministically 2026-08-10). Small requests
// survive indefinitely — the pre-batching code pushed large graphs statement
// by statement for months. Keep transport batches well under the observed
// choke point.
const STATEMENTS_PER_TRANSPORT_BATCH = 10;
const TRANSPORT_BATCH_BYTES = 512 * 1024;
const PARAM_PROTOCOL_OVERHEAD_BYTES = 64;

function estimateStatementBytes(statement: TransactionStatement): number {
  let bytes = Buffer.byteLength(statement.query, 'utf8') + 64;
  for (const [key, value] of Object.entries(statement.params ?? {})) {
    bytes += Buffer.byteLength(key, 'utf8') + PARAM_PROTOCOL_OVERHEAD_BYTES;
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    else if (value !== null && value !== undefined && typeof value === 'object') {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    } else bytes += 16;
  }
  return bytes;
}

class StatementBatcher {
  private statements: TransactionStatement[] = [];
  private rowCounts: number[] = [];
  private bytes = 0;
  private completed: number;

  constructor(
    private readonly tx: ITransaction,
    private readonly kind: BatchProgressKind,
    private readonly total: number,
    private readonly options?: ApplyChangesetOptions,
    /** Rows already applied by earlier chunk transactions of the same phase. */
    initialCompleted = 0,
  ) {
    this.completed = initialCompleted;
  }

  async add(statement: TransactionStatement, rowCount: number): Promise<void> {
    const statementBytes = estimateStatementBytes(statement);
    if (statementBytes > TRANSPORT_BATCH_BYTES) {
      throw new Error(`A single graph write statement exceeds the ${TRANSPORT_BATCH_BYTES}-byte transport limit`);
    }
    if (
      this.statements.length > 0 &&
      (this.statements.length >= STATEMENTS_PER_TRANSPORT_BATCH || this.bytes + statementBytes > TRANSPORT_BATCH_BYTES)
    ) {
      await this.flush();
    }
    this.statements.push(statement);
    this.rowCounts.push(rowCount);
    this.bytes += statementBytes;
    if (this.statements.length >= STATEMENTS_PER_TRANSPORT_BATCH) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.statements.length === 0) return;
    this.options?.signal?.throwIfAborted();
    const statements = this.statements;
    const rowCounts = this.rowCounts;
    const bytes = this.bytes;
    this.statements = [];
    this.rowCounts = [];
    this.bytes = 0;
    // Diagnostic: mark the flush BEFORE the request goes out, carrying the
    // payload size. Separates client-side build gaps (late start) from
    // server-side request stalls (start on time, completion never comes).
    this.options?.onPhase?.(`${this.kind}.flush.start[${statements.length}stmt/${bytes}B]`, 0);
    const started = Date.now();
    await runStatements(this.tx, statements);
    this.options?.onPhase?.(`${this.kind}.flush.done`, Date.now() - started);
    this.completed += rowCounts.reduce((sum, value) => sum + value, 0);
    this.options?.onBatch?.({ kind: this.kind, completed: this.completed, total: this.total });
  }
}

async function addBoundedRowStatements<T>(
  batcher: StatementBatcher,
  rows: T[],
  buildStatement: (chunk: T[]) => TransactionStatement,
): Promise<void> {
  let offset = 0;
  while (offset < rows.length) {
    let chunkSize = Math.min(ROWS_PER_WRITE_STATEMENT, rows.length - offset);
    let chunk = rows.slice(offset, offset + chunkSize);
    let statement = buildStatement(chunk);

    while (chunkSize > 1 && estimateStatementBytes(statement) > TRANSPORT_BATCH_BYTES) {
      chunkSize = Math.ceil(chunkSize / 2);
      chunk = rows.slice(offset, offset + chunkSize);
      statement = buildStatement(chunk);
    }

    await batcher.add(statement, chunk.length);
    offset += chunk.length;
  }
}

function buildNodeUpsertStatement(chunk: GraphNode[]): TransactionStatement {
  const valueClauses: string[] = [];
  const params: Record<string, unknown> = {};

  for (let j = 0; j < chunk.length; j++) {
    const node = chunk[j];
    valueClauses.push(
      `(@id_${j}, @type_${j}, @name_${j}, @props_${j}, @sum_${j}, @emb_${j}, @repo_${j}, @fp_${j}, @sl_${j}, @el_${j}, unixepoch())`,
    );
    params[`id_${j}`] = node.id;
    params[`type_${j}`] = node.type;
    params[`name_${j}`] = node.name;
    params[`props_${j}`] = JSON.stringify(node.properties);
    params[`sum_${j}`] = node.summary ?? null;
    params[`emb_${j}`] = node.embedding ? JSON.stringify(node.embedding) : null;
    params[`repo_${j}`] = node.repoId || null;
    params[`fp_${j}`] = node.filePath || null;
    params[`sl_${j}`] = node.startLine || null;
    params[`el_${j}`] = node.endLine || null;
  }

  return {
    query: `INSERT INTO nodes (id, type, name, properties, summary, embedding, repo_id, file_path, start_line, end_line, updated_at)
      VALUES ${valueClauses.join(',\n          ')}
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        properties = excluded.properties,
        summary = excluded.summary,
        embedding = excluded.embedding,
        repo_id = excluded.repo_id,
        file_path = excluded.file_path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        updated_at = unixepoch()`,
    params,
  };
}

function buildEdgeUpsertStatement(chunk: GraphEdge[]): TransactionStatement {
  const valueClauses: string[] = [];
  const params: Record<string, unknown> = {};

  for (let j = 0; j < chunk.length; j++) {
    const edge = chunk[j];
    valueClauses.push(`(@id_${j}, @src_${j}, @tgt_${j}, @type_${j}, @conf_${j}, @by_${j}, @props_${j})`);
    params[`id_${j}`] = edge.id;
    params[`src_${j}`] = edge.sourceId;
    params[`tgt_${j}`] = edge.targetId;
    params[`type_${j}`] = edge.type;
    params[`conf_${j}`] = edge.confidence;
    params[`by_${j}`] = edge.createdBy;
    params[`props_${j}`] = JSON.stringify(edge.properties);
  }

  return {
    query: `INSERT INTO edges (id, source_id, target_id, type, confidence, created_by, properties)
      VALUES ${valueClauses.join(',\n          ')}
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        type = excluded.type,
        confidence = excluded.confidence,
        created_by = excluded.created_by,
        properties = excluded.properties
      ON CONFLICT(source_id, target_id, type) DO UPDATE SET
        confidence = excluded.confidence,
        created_by = excluded.created_by,
        properties = excluded.properties`,
    params,
  };
}

function buildUnresolvedCallInsertStatement(
  repoId: string,
): (chunk: readonly UnresolvedCallRecord[]) => TransactionStatement {
  return (chunk) => {
    const params: Record<string, unknown> = { repoId };
    const valueClauses = chunk.map((record, j) => {
      params[`callerId${j}`] = record.callerId;
      params[`calleeExpression${j}`] = record.calleeExpression;
      params[`calleeNameTail${j}`] = record.calleeNameTail;
      params[`filePath${j}`] = record.filePath;
      params[`line${j}`] = record.line;
      return `(@repoId, @callerId${j}, @calleeExpression${j}, @calleeNameTail${j}, @filePath${j}, @line${j})`;
    });
    return {
      query: `INSERT INTO unresolved_calls (repo_id, caller_id, callee_expression, callee_name_tail, file_path, line)
      VALUES ${valueClauses.join(',\n          ')}`,
      params,
    };
  };
}

/** Progress framing when a phase spans several chunk transactions. */
interface ChunkProgress {
  offset: number;
  total: number;
}

async function upsertNodesInTransaction(
  tx: ITransaction,
  nodes: GraphNode[],
  options?: ApplyChangesetOptions,
  progress?: ChunkProgress,
): Promise<void> {
  const batcher = new StatementBatcher(tx, 'nodes', progress?.total ?? nodes.length, options, progress?.offset ?? 0);
  await addBoundedRowStatements(batcher, nodes, buildNodeUpsertStatement);
  await batcher.flush();
}

async function upsertEdgesInTransaction(
  tx: ITransaction,
  edges: GraphEdge[],
  options?: ApplyChangesetOptions,
  progress?: ChunkProgress,
): Promise<void> {
  const batcher = new StatementBatcher(tx, 'edges', progress?.total ?? edges.length, options, progress?.offset ?? 0);
  await addBoundedRowStatements(batcher, edges, buildEdgeUpsertStatement);
  await batcher.flush();
}

// This is the only write path in the file outside the protective
// StatementBatcher/addBoundedRowStatements machinery until this function was
// added — unresolved-call rows used to go through a bespoke single-statement
// loop (TXN_UNRESOLVED_ROWS=2000 rows in one VALUES clause, no byte-size
// bound). The remote-libsql (legacy Turso) data plane is exactly where an
// oversized multi-VALUES statement degrades (see StatementBatcher's Turso
// comment above), so this rewrite path gets the same bounded-row + byte-size
// treatment as node/edge upserts instead of trusting row count alone.
async function insertUnresolvedCallsInTransaction(
  tx: ITransaction,
  repoId: string,
  records: readonly UnresolvedCallRecord[],
  options?: ApplyChangesetOptions,
  progress?: ChunkProgress,
): Promise<void> {
  const batcher = new StatementBatcher(
    tx,
    'unresolvedCalls',
    progress?.total ?? records.length,
    options,
    progress?.offset ?? 0,
  );
  await addBoundedRowStatements(batcher, records.slice(), buildUnresolvedCallInsertStatement(repoId));
  await batcher.flush();
}

async function updateMetadataInTransaction(
  tx: ITransaction,
  updates: NodeMetadataUpdate[],
  options?: ApplyChangesetOptions,
  progress?: ChunkProgress,
): Promise<void> {
  const batcher = new StatementBatcher(
    tx,
    'metadata',
    progress?.total ?? updates.length,
    options,
    progress?.offset ?? 0,
  );
  for (const update of updates) {
    const assignments = [`properties = json_patch(COALESCE(properties, '{}'), @patch)`, `updated_at = unixepoch()`];
    const params: Record<string, unknown> = {
      id: update.id,
      patch: JSON.stringify(update.properties),
    };
    if (update.summary !== undefined) {
      assignments.unshift('summary = @summary');
      params.summary = update.summary;
    }
    if (update.embedding !== undefined) {
      assignments.unshift('embedding = @embedding');
      params.embedding = JSON.stringify(update.embedding);
    }
    await batcher.add(
      {
        query: `UPDATE nodes SET ${assignments.join(', ')} WHERE id = @id`,
        params,
      },
      1,
    );
  }
  await batcher.flush();
}

/**
 * Build repo hash filter for WHERE clause.
 *
 * For node rows: filters by the indexed `repo_id` column (uses idx_nodes_repo).
 * An OR-chained `id LIKE 'hash:%'` form prevents index use and causes full
 * nodes-table scans once a workspace has more than a couple of repos —
 * significant on the post-push workspace resolver path.
 *
 * For repository nodes (isRepoNode=true): `repo_id` is null because the node
 * IS the repo, so we still filter by `id LIKE 'hash%'`. Repository rows are
 * sparse so the LIKE OR-chain is cheap here.
 *
 * Hash values are sha-derived hex strings, no quoting needed for the IN list.
 */
export function buildRepoFilter(hashes: string[], alias: string = 'n', isRepoNode: boolean = false): string {
  if (hashes.length === 0) return '1=1';
  const list = hashes.map((h) => `'${h}'`).join(', ');
  if (isRepoNode) {
    // Repository node ids ARE the repo hash (transformRepository uses
    // ParsedRepo.id = repoHash), so exact equality is correct — and unlike the
    // former `id LIKE 'hash%'` OR-chain it uses the PK index instead of
    // scanning the whole nodes table (302ms p95 → 5ms on a 181k-node graph).
    return `${alias}.id IN (${list})`;
  }
  return `${alias}.repo_id IN (${list})`;
}

/**
 * Parse JSON properties from a node row.
 */
function parseProperties(propsStr: string | null): Record<string, unknown> {
  if (!propsStr) return {};
  try {
    return JSON.parse(propsStr);
  } catch {
    return {};
  }
}

/**
 * Convert node type to lowercase for database.
 */
function normalizeNodeType(type: string): NodeType {
  return type.toLowerCase().replace('alias', '_alias') as NodeType;
}

const MAX_TRAVERSAL_DEPTH = 10;

function clampTraversalDepth(value: number): number {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer)) return 1;
  return Math.min(MAX_TRAVERSAL_DEPTH, Math.max(1, integer));
}

/** Common column projection for entity-node rows (findEntity / listEntities). */
interface EntityRow {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  properties: string;
}

// -----------------------------------------------------------------------------
// Tier B (graph explorer) helpers
// -----------------------------------------------------------------------------

/**
 * Scope filter for a NEIGHBOR node in the explorer. Unlike {@link buildRepoFilter},
 * this must also admit repository nodes (whose `repo_id` is NULL and whose `id`
 * IS the hash) so containment neighbors (repository -CONTAINS_*-> …) survive the
 * scope check. Empty hashes = no filter (`1=1`), matching the cross-repo
 * "empty = all" convention.
 */
function buildNeighborRepoFilter(hashes: string[], alias: string): string {
  if (hashes.length === 0) return '1=1';
  const list = hashes.map((h) => `'${h}'`).join(', ');
  return `(${alias}.repo_id IN (${list}) OR ${alias}.id IN (${list}))`;
}

/**
 * The VizNode column projection — deliberately excludes `properties` (may carry
 * source), `embedding`, and any large blob. `repoName` is resolved by a LEFT
 * JOIN to the repository node via `COALESCE(repo_id, id)` (repo nodes have NULL
 * `repo_id` and `id` === hash). Only the three badge-source keys are
 * json_extract'd. `<n>` and `<r>` are the node and repository-join aliases.
 */
function vizNodeCols(n: string, r: string): string {
  return `
    ${n}.id AS id,
    ${n}.type AS type,
    ${n}.name AS name,
    COALESCE(${r}.name, '') AS repoName,
    ${n}.file_path AS filePath,
    ${n}.start_line AS startLine,
    ${n}.summary AS summary,
    json_extract(${n}.properties, '$.method') AS pMethod,
    json_extract(${n}.properties, '$.entrypointType') AS pEntrypointType,
    json_extract(${n}.properties, '$.protocol') AS pProtocol`;
}

/** SQLite row shape produced by {@link vizNodeCols}; fed to the shared buildVizNode. */
interface VizNodeRow extends VizNodeFields {
  pMethod: string | null;
  pEntrypointType: string | null;
  pProtocol: string | null;
}

/** SQLite row shape for the cross-repo bridge query (RESOLVES_TO joined to its
 *  MAKES_EXTERNAL_CALL / HANDLES neighbours). LEFT-joined columns are nullable. */
interface CrossRepoBridgeRow {
  rtId: string;
  ecId: string;
  epId: string;
  rtConf: number;
  rtBy: string;
  mecId: string | null;
  callerId: string | null;
  mecConf: number | null;
  mecBy: string | null;
  hndId: string | null;
  handlerId: string | null;
  hndConf: number | null;
  hndBy: string | null;
}

// =============================================================================
// SQLite Repository Implementation
// =============================================================================

export class SqliteRepository implements IGraphRepository {
  constructor(private driver: IDatabaseDriver) {}

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async findCode(params: FindCodeParams, repoHashes: string[]): Promise<CodeElement[]> {
    const { pattern, types, exportedVariablesOnly, includeSource } = params;
    const limit = clampLimit(params.limit ?? 50, SYMBOL_SEARCH_LIMIT.max, SYMBOL_SEARCH_LIMIT.fallback);
    const repoFilter = buildRepoFilter(repoHashes);

    let typeFilter = '1=1';
    if (types && types.length > 0) {
      const typeList = types.map((t) => `'${t}'`).join(', ');
      typeFilter = `n.type IN (${typeList})`;
    } else {
      typeFilter = `n.type IN ('function', 'class', 'interface', 'entrypoint', 'entity')`;
    }

    const variableExportFilter =
      exportedVariablesOnly && (!types || types.includes(NodeType.Variable))
        ? `AND (n.type != 'variable' OR json_extract(n.properties, '$.isExported') = 1)`
        : '';

    // The caller's pattern is a glob (`*` / `?`). Pick the cheapest SQL strategy
    // based on its shape:
    //
    //   1. No wildcards (`foo`) → equality. Uses idx_nodes_type_name. O(log n).
    //   2. Trailing wildcard only (`foo*`) → prefix LIKE. Uses idx_nodes_name. O(log n + k).
    //   3. Leading wildcard with a 3+ char core (`*foo*`, `*foo`, `*foo*bar*`) →
    //      FTS5 MATCH against the trigram-indexed name. O(k) on the FTS index
    //      instead of O(n) full table scan. ~10-100× speed-up on multi-million-
    //      node graphs (the dominant case from search_symbols / explain).
    //   4. Leading wildcard with a 1-2 char core (`*a*`) → fall back to LIKE
    //      with full scan. Trigram has no <3-char tokens. Rare in practice.
    //
    // ESCAPE '\' on LIKE neutralizes literal `%` / `_` in the caller's pattern
    // so an LLM-typed `_` doesn't widen the match to "anything".
    const escapeLiteral = (s: string): string => s.replace(/([\\%_])/g, '\\$1');
    const hasLeadingStar = pattern.startsWith('*');
    const hasTrailingStar = pattern.endsWith('*');
    const inner = pattern.slice(hasLeadingStar ? 1 : 0, pattern.length - (hasTrailingStar ? 1 : 0));
    const hasInnerWildcard = /[*?]/.test(inner);

    // Project the stored source body (from the properties JSON blob) only when the
    // caller asked for it — so the default search hot path is byte-identical.
    const sourceCol = includeSource ? `, json_extract(n.properties, '$.sourceCode') as sourceCode` : '';
    const cols = `n.id, n.name, n.type, n.file_path as filePath, n.start_line as startLine, n.end_line as endLine, n.summary, json_extract(n.properties, '$.purpose') as purpose${sourceCol}`;

    let query: string;
    let queryParams: Record<string, unknown>;

    if (!hasLeadingStar && !hasTrailingStar && !hasInnerWildcard) {
      // Strategy 1: equality.
      query = `
        SELECT ${cols}
        FROM nodes n
        WHERE ${repoFilter}
          AND ${typeFilter}
          ${variableExportFilter}
          AND n.name = @pattern COLLATE NOCASE
        ORDER BY n.name, n.id
        LIMIT @limit
      `;
      queryParams = { pattern, limit };
    } else if (!hasLeadingStar && hasTrailingStar && !hasInnerWildcard) {
      // Strategy 2: prefix LIKE.
      query = `
        SELECT ${cols}
        FROM nodes n
        WHERE ${repoFilter}
          AND ${typeFilter}
          ${variableExportFilter}
          AND n.name LIKE @pattern ESCAPE '\\'
        ORDER BY n.name, n.id
        LIMIT @limit
      `;
      queryParams = { pattern: `${escapeLiteral(inner)}%`, limit };
    } else if (hasLeadingStar && inner.length >= 3 && !hasInnerWildcard) {
      // Strategy 3: FTS5 MATCH narrows candidates fast, then a LIKE post-
      // filter enforces the glob's anchoring semantics:
      //   `*foo*` → MATCH 'foo' + LIKE '%foo%' — substring (post-filter no-op)
      //   `*foo`  → MATCH 'foo' + LIKE '%foo'  — suffix-only (rejects `fooBar`)
      // Without the LIKE filter, `*foo` would falsely match anything containing
      // "foo" anywhere, diverging from the existing glob contract and from the
      // Neo4j regex backend.
      //
      // Wrap the FTS query in double quotes to make it a phrase — protects
      // against trigram operators in user input. Phrase quotes are escaped by
      // doubling.
      const ftsQuery = `"${inner.replace(/"/g, '""')}"`;
      const likeFilter = `%${escapeLiteral(inner)}${hasTrailingStar ? '%' : ''}`;
      query = `
        SELECT ${cols}
        FROM nodes_name_fts f
        JOIN nodes n ON n.rowid = f.rowid
        WHERE f.name MATCH @ftsQuery
          AND n.name LIKE @likeFilter ESCAPE '\\'
          AND ${repoFilter}
          AND ${typeFilter}
          ${variableExportFilter}
        ORDER BY n.name, n.id
        LIMIT @limit
      `;
      queryParams = { ftsQuery, likeFilter, limit };
    } else {
      // Strategy 4: full-scan LIKE fallback. Used for very short cores (<3
      // chars, trigram can't help), `?`-glob patterns, or multi-wildcard
      // patterns. Escape SQL-meaningful chars (`%` `_` `\`) first, then map
      // glob wildcards onto SQL LIKE wildcards.
      const likePattern = escapeLiteral(pattern).replace(/\*/g, '%').replace(/\?/g, '_');
      query = `
        SELECT ${cols}
        FROM nodes n
        WHERE ${repoFilter}
          AND ${typeFilter}
          ${variableExportFilter}
          AND n.name LIKE @pattern ESCAPE '\\'
        ORDER BY n.name, n.id
        LIMIT @limit
      `;
      queryParams = { pattern: likePattern, limit };
    }

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
      }>(query, queryParams);
    });

    return results.map((row) => codeElementFromRow({ ...row, type: normalizeNodeType(row.type) }));
  }

  async listSymbolsInFile(filePath: string, repoHashes: string[]): Promise<CodeElement[]> {
    if (repoHashes.length === 0) {
      return [];
    }

    // Match the file by its exact stored path OR by trailing segment, so a
    // caller can pass either the full repo-relative path or just enough of the
    // tail to identify it (`templates.service.ts`). Escape LIKE metacharacters
    // (`%`/`_`/`\`) so paths like `user_service.ts` aren't read as wildcards.
    const repoFilter = buildRepoFilter(repoHashes, 'n');
    const escapedSuffix = `%/${filePath.replace(/([\\%_])/g, '\\$1')}`;

    const query = `
      SELECT n.id, n.name, n.type, n.file_path as filePath,
             n.start_line as startLine, n.end_line as endLine, n.summary
      FROM nodes n
      WHERE ${repoFilter}
        AND (n.file_path = @filePath OR n.file_path LIKE @suffix ESCAPE '\\')
      ORDER BY n.start_line, n.name
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
      }>(query, { filePath, suffix: escapedSuffix });
    });

    return results.map((row) => codeElementFromRow({ ...row, type: normalizeNodeType(row.type) }));
  }

  async findFunction(
    name: string,
    repoHashes: string[],
    fileHint?: string,
    className?: string,
  ): Promise<FunctionInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);

    // LEFT JOIN onto the function's owning class so we can both surface the
    // className in the response and filter on it when the caller passed a
    // qualified "Class.method" input.
    let query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.summary, n.properties, c.name as className
      FROM nodes n
      LEFT JOIN nodes c
        ON c.type = 'class'
        AND c.id = json_extract(n.properties, '$.classId')
      WHERE ${repoFilter}
        AND n.type = 'function'
        AND n.name = @name
    `;

    if (fileHint) {
      query += ` AND n.file_path LIKE @fileHint`;
    }
    if (className) {
      query += ` AND c.name = @className`;
    }

    query += ` ORDER BY n.file_path LIMIT 1`;

    const results = await this.driver.withReadTransaction(async (tx) => {
      const params: Record<string, unknown> = { name };
      if (fileHint) {
        params.fileHint = `%${fileHint}%`;
      }
      if (className) {
        params.className = className;
      }
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        properties: string;
        className: string | null;
      }>(query, params);
    });

    if (results.length === 0) return null;

    const row = results[0]!;
    return functionInfoFromRow(row, parseProperties(row.properties), row.className ?? undefined);
  }

  async findClass(name: string, repoHashes: string[]): Promise<ClassInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);

    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'class'
        AND n.name = @name
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
      }>(query, { name });
    });

    if (results.length === 0) return null;

    const row = results[0]!;
    return namedDeclarationFromRow('class', row, parseProperties(row.properties));
  }

  async findInterface(name: string, repoHashes: string[]): Promise<InterfaceInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);

    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'interface'
        AND n.name = @name
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
      }>(query, { name });
    });

    if (results.length === 0) return null;

    const row = results[0]!;
    return namedDeclarationFromRow('interface', row, parseProperties(row.properties));
  }

  async findEnum(name: string, repoHashes: string[]): Promise<EnumInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);
    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'enum'
        AND n.name = @name
      LIMIT 1
    `;
    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<EntityRow>(query, { name });
    });
    if (results.length === 0) return null;

    const row = results[0]!;
    return namedDeclarationFromRow('enum', row, parseProperties(row.properties));
  }

  async findTypeAlias(name: string, repoHashes: string[]): Promise<TypeAliasInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);
    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'type_alias'
        AND n.name = @name
      LIMIT 1
    `;
    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<EntityRow>(query, { name });
    });
    if (results.length === 0) return null;

    const row = results[0]!;
    return namedDeclarationFromRow('type_alias', row, parseProperties(row.properties));
  }

  async findEntity(name: string, repoHashes: string[]): Promise<EntityInfo | null> {
    const repoFilter = buildRepoFilter(repoHashes);

    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'entity'
        AND (n.name = @name OR json_extract(n.properties, '$.tableName') = @name)
      LIMIT 1
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
      }>(query, { name });
    });

    if (results.length === 0) return null;

    const row = results[0]!;
    return entityInfoFromRow(row, parseProperties(row.properties));
  }

  async listEntities(repoHashes: string[]): Promise<EntityInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes);

    const query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'entity'
      ORDER BY n.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<EntityRow>(query, {});
    });

    return results.map((row) => entityInfoFromRow(row, parseProperties(row.properties)));
  }

  async listEntrypoints(params: ListEntrypointsParams, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const { type, pathPattern, system, limit, id } = params;
    const normalizedSystem = system?.trim().toLowerCase();
    const repoFilter = buildRepoFilter(repoHashes);

    // Parameter-agnostic path matching: the stored path uses the parser's own
    // placeholder syntax ({id} / :id / <id> / [id]), so we DB-prefilter on the
    // longest literal segment (placeholder-independent) and refine in JS with
    // `entrypointAddressMatches`. When the path is all-parameters there's no anchor, so
    // we skip the DB path filter and let the JS pass scan the scope. Path searches
    // cannot be capped before the JS refinement: the Nth actual match may appear
    // after any number of anchor-only candidates.
    const pathAnchor = pathPattern ? staticRouteAnchor(pathPattern) : undefined;
    const dbPathPattern = pathAnchor ? `%${pathAnchor}%` : undefined;
    let query = `
      SELECT n.id, n.name, n.file_path as filePath, n.start_line as startLine,
             n.end_line as endLine, n.properties,
             h.name as handlerName, h.summary as handlerSummary,
             json_extract(h.properties, '$.purpose') as handlerPurpose
      FROM nodes n
      LEFT JOIN edges e ON e.source_id = n.id AND e.type = 'HANDLES'
      LEFT JOIN nodes h ON h.id = e.target_id
      WHERE ${repoFilter}
        AND n.type = 'entrypoint'
    `;

    if (id) {
      query += ` AND n.id = @id`;
    }
    if (type) {
      query += ` AND json_extract(n.properties, '$.entrypointType') = @type`;
    }
    if (dbPathPattern) {
      // Prefilter over EVERY address property, not just `$.fullPath`: a queue/cron/CLI
      // entrypoint has no path, and anchoring on fullPath alone dropped every such row
      // before the JS refinement could look at its destination/topic/schedule.
      //
      // Named keys rather than `n.properties LIKE @pathPattern` over the whole serialized
      // blob: the blob form matches ANY property — handler name, documentation prose — so a
      // short anchor selects nearly every entrypoint row and the JS pass ends up scanning the
      // scope the prefilter exists to narrow. Over-selection within the address keys is
      // harmless: `entrypointAddressMatches` below is the authoritative filter.
      const addressMatch = ENTRYPOINT_ADDRESS_PROPERTY_KEYS.map(
        (key) => `json_extract(n.properties, '$.${key}') LIKE @pathPattern`,
      ).join(' OR ');
      query += ` AND (${addressMatch})`;
    }
    if (normalizedSystem) {
      query += ` AND json_extract(n.properties, '$.entrypointType') IN ('queue', 'event')`;
    }
    if (normalizedSystem === 'unknown') {
      query += ` AND TRIM(COALESCE(
        json_extract(n.properties, '$.messagingSystem'),
        json_extract(n.properties, '$.emitter'),
        ''
      )) = ''`;
    } else if (normalizedSystem) {
      query += ` AND LOWER(TRIM(COALESCE(
        json_extract(n.properties, '$.messagingSystem'),
        json_extract(n.properties, '$.emitter')
      ))) = @system`;
    }

    query += ` ORDER BY json_extract(n.properties, '$.entrypointType'),
                       json_extract(n.properties, '$.fullPath'),
                       json_extract(n.properties, '$.method'),
                       n.id`;

    const queryParams: Record<string, unknown> = {};
    if (type) queryParams.type = type;
    if (dbPathPattern) queryParams.pathPattern = dbPathPattern;
    if (id) queryParams.id = id;
    if (normalizedSystem && normalizedSystem !== 'unknown') queryParams.system = normalizedSystem;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
        handlerName: string | null;
        handlerSummary: string | null;
        handlerPurpose: string | null;
      }>(query, queryParams);
    });

    const entrypointInfos: EntrypointInfo[] = results.map((row) =>
      entrypointInfoFromRow(row, parseProperties(row.properties), {
        name: row.handlerName,
        summary: row.handlerSummary,
        purpose: row.handlerPurpose,
      }),
    );

    // Surface React/Vue routes as synthetic HTTP-GET entrypoints. Routes are
    // stored as their own node type (`route`) by frontend parsers, with the
    // path on `properties.path` and the rendered component on
    // `properties.componentId`. Without this, an agent calling
    // `list_entrypoints(scope: <frontend-repo>)` sees only websocket/event
    // entries and concludes the repo has no HTTP surface.
    // Skip when caller asked for a specific non-http type or filtered by id
    // (already an exact lookup against the entrypoint table).
    if (!id && !normalizedSystem && (!type || type === 'http')) {
      let routeQuery = `
        SELECT n.id, n.name, n.file_path AS filePath, n.start_line AS startLine,
               n.end_line AS endLine, n.properties,
               c.name AS handlerName, c.summary AS handlerSummary,
               json_extract(c.properties, '$.purpose') AS handlerPurpose
        FROM nodes n
        LEFT JOIN nodes c
          ON c.id = json_extract(n.properties, '$.componentId')
          AND c.type IN ('function', 'class', 'component')
        WHERE ${buildRepoFilter(repoHashes, 'n')}
          AND n.type = 'route'
      `;
      if (dbPathPattern) {
        routeQuery += ` AND json_extract(n.properties, '$.path') LIKE @pathPattern`;
      }
      routeQuery += ` ORDER BY json_extract(n.properties, '$.path'), n.id`;
      // Turso rejects surplus named parameters. The entrypoint query's `type`
      // parameter is intentionally absent here because route nodes are always
      // surfaced as synthetic HTTP entrypoints.
      const routeParams: Record<string, unknown> = {};
      if (dbPathPattern) routeParams.pathPattern = dbPathPattern;

      const routeRows = await this.driver.withReadTransaction(async (tx) => {
        return tx.run<{
          id: string;
          name: string;
          filePath: string;
          startLine: number;
          endLine: number;
          properties: string;
          handlerName: string | null;
          handlerSummary: string | null;
          handlerPurpose: string | null;
        }>(routeQuery, routeParams);
      });

      for (const row of routeRows) {
        const props = parseProperties(row.properties);
        const routePath = (props.path as string | undefined) || row.name;
        entrypointInfos.push({
          id: row.id,
          type: 'http',
          method: 'GET',
          handlerId: (props.componentId as string) || '',
          handlerName: row.handlerName || (props.componentName as string | undefined),
          path: routePath,
          fullPath: routePath,
          filePath: row.filePath,
          startLine: row.startLine,
          endLine: row.endLine,
          summary: row.handlerSummary || undefined,
          purpose: row.handlerPurpose || undefined,
        });
      }
    }

    // Refine with parameter-agnostic matching the DB LIKE cannot do, then apply
    // one global limit after the stored-entrypoint and synthetic-route arms merge.
    const matched = pathPattern
      ? entrypointInfos.filter((ep) => entrypointAddressMatches(pathPattern, ep))
      : entrypointInfos;
    return limit !== undefined
      ? matched.slice(0, clampLimit(limit, ENTRYPOINT_LIST_LIMIT.max, ENTRYPOINT_LIST_LIMIT.fallback))
      : matched;
  }

  async getRepoOverview(repoHashes: string[]): Promise<RepoOverview[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'r', true);

    const query = `
      SELECT
        r.name,
        json_extract(r.properties, '$.type') as type,
        json_extract(r.properties, '$.parsedAt') as parsedAt,
        r.summary,
        json_extract(r.properties, '$.dataModel') as dataModel,
        json_extract(r.properties, '$.externalIntegrations') as externalIntegrations,
        json_extract(r.properties, '$.gitRemoteUrl') as gitRemoteUrl,
        json_extract(r.properties, '$.gitCommitHash') as gitCommitHash,
        json_extract(r.properties, '$.parserVersion') as parserVersion,
        (SELECT COUNT(*) FROM nodes f WHERE f.type = 'file' AND f.repo_id = r.id) as fileCount,
        (SELECT COUNT(*) FROM nodes fn WHERE fn.type = 'function' AND fn.repo_id = r.id) as functionCount,
        (SELECT COUNT(*) FROM nodes c WHERE c.type = 'class' AND c.repo_id = r.id) as classCount,
        (SELECT COUNT(*) FROM nodes e WHERE e.type = 'entity' AND e.repo_id = r.id) as entityCount,
        (SELECT GROUP_CONCAT(DISTINCT json_extract(ep.properties, '$.entrypointType'))
         FROM nodes ep WHERE ep.type = 'entrypoint' AND ep.repo_id = r.id) as entrypointTypes
      FROM nodes r
      WHERE ${repoFilter}
        AND r.type = 'repository'
      ORDER BY r.name, r.id
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
        entrypointTypes: string | null;
      }>(query);
    });

    return results.map((row) => ({
      name: row.name,
      type: row.type || 'unknown',
      parsedAt: row.parsedAt || '',
      fileCount: row.fileCount,
      functionCount: row.functionCount,
      classCount: row.classCount,
      entityCount: row.entityCount,
      entrypointTypes: row.entrypointTypes ? [...new Set(row.entrypointTypes.split(','))].sort() : [],
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
   * Per-repo extraction-coverage counts. One row per repository node with
   * correlated subqueries on the indexed `repo_id` column (same shape as
   * getRepoOverview), plus one grouped query for node counts by kind. Empty
   * `repoHashes` = all repos (buildRepoFilter convention).
   */
  /**
   * Public, unfiltered counterpart to the private `edgesAmong` helper below.
   * They are not duplicates: that one serves getSubgraph, where the id set is
   * already bounded by a traversal cap and the caller supplies the edge types
   * it walked. This one takes whatever the user has accumulated on a canvas —
   * unbounded in size and unrestricted in edge type — so it binds the ids as
   * one JSON array and carries a limit.
   */
  async getEdgesAmong(nodeIds: string[], repoHashes: string[], limit = 2000): Promise<EdgesAmongResult> {
    if (nodeIds.length === 0) return { edges: [], truncated: false };
    limit = clampLimit(limit, EDGES_AMONG_LIMIT.max, EDGES_AMONG_LIMIT.fallback);

    // json_each over a single bound JSON array rather than an IN (?,?,...) list:
    // the canvas can hold a thousand-plus ids, which would blow past SQLite's
    // bound-parameter ceiling and rebuild the statement on every call.
    const query = `
      SELECT e.id, e.source_id AS sourceId, e.target_id AS targetId, e.type,
             e.confidence, e.created_by AS createdBy,
             json_extract(e.properties, '$.operation') AS operation
      FROM edges e
      JOIN nodes src ON src.id = e.source_id
      WHERE e.source_id IN (SELECT value FROM json_each(@ids))
        AND e.target_id IN (SELECT value FROM json_each(@ids))
        AND ${buildRepoFilter(repoHashes, 'src')}
      ORDER BY e.id
      LIMIT @limitPlus1
    `;

    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        id: string;
        sourceId: string;
        targetId: string;
        type: string;
        confidence: number;
        createdBy: string;
        operation: string | null;
      }>(query, { ids: JSON.stringify(nodeIds), limitPlus1: limit + 1 }),
    );

    const { page, truncated } = pageSlice(rows, limit);

    return {
      truncated,
      edges: page.map((row) =>
        buildVizEdge({ ...row, type: row.type as EdgeType, confidence: Number(row.confidence) }),
      ),
    };
  }

  async getCoverageCounts(repoHashes: string[]): Promise<RepoCoverageCounts[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'r', true);

    const query = `
      SELECT
        r.name,
        r.id AS hash,
        json_extract(r.properties, '$.analysis') AS analysis,
        json_extract(r.properties, '$.callSites') AS callSites,
        json_extract(r.properties, '$.resolvedCalls') AS resolvedCalls,
        json_extract(r.properties, '$.outOfScopeCalls') AS outOfScopeCalls,
        json_extract(r.properties, '$.dbOpSites') AS dbOpSites,
        json_extract(r.properties, '$.boundDbOps') AS boundDbOps,
        json_extract(r.properties, '$.outOfScopeDbOps') AS outOfScopeDbOps,
        (SELECT COUNT(DISTINCT e.target_id) FROM edges e
           JOIN nodes ent ON ent.id = e.target_id AND ent.type = 'entity'
           WHERE e.type = 'OPERATES_ON' AND ent.repo_id = r.id) AS entitiesWithDbOps,
        (SELECT COUNT(DISTINCT e.source_id) FROM edges e
           JOIN nodes fn ON fn.id = e.source_id AND fn.type = 'function'
           WHERE e.type = 'CALLS' AND fn.repo_id = r.id) AS functionsWithCalls,
        (SELECT COUNT(DISTINCT e.source_id) FROM edges e
           JOIN nodes ec ON ec.id = e.source_id AND ec.type = 'external_call' AND ec.repo_id = r.id
           WHERE e.type = 'RESOLVES_TO') AS resolvedExternalCallCount
      FROM nodes r
      WHERE ${repoFilter}
        AND r.type = 'repository'
      ORDER BY r.name, r.id
    `;

    // Node counts by kind, grouped per repo. The repository node itself is
    // excluded — it is bookkeeping, not extracted structure.
    const countsQuery = `
      SELECT n.repo_id AS hash, n.type AS type, COUNT(*) AS count
      FROM nodes n
      WHERE ${buildRepoFilter(repoHashes, 'n')}
        AND n.type != 'repository'
      GROUP BY n.repo_id, n.type
    `;

    const [repoRows, countRows] = await this.driver.withReadTransaction(async (tx) => {
      return Promise.all([
        tx.run<{
          name: string;
          hash: string;
          callSites: number | null;
          analysis: string | null;
          resolvedCalls: number | null;
          outOfScopeCalls: number | null;
          dbOpSites: number | null;
          boundDbOps: number | null;
          outOfScopeDbOps: number | null;
          entitiesWithDbOps: number;
          functionsWithCalls: number;
          resolvedExternalCallCount: number;
        }>(query),
        tx.run<{ hash: string; type: string; count: number }>(countsQuery),
      ]);
    });

    const countsByRepo = new Map<string, Record<string, number>>();
    for (const row of countRows) {
      const perType = countsByRepo.get(row.hash) ?? {};
      perType[row.type] = row.count;
      countsByRepo.set(row.hash, perType);
    }

    return repoRows.map((row) => {
      const nodeCountsByType = countsByRepo.get(row.hash) ?? {};
      const callResolution = callResolutionFrom(row.callSites, row.resolvedCalls, row.outOfScopeCalls);
      const analysis = analysisFrom(row.analysis);
      const dbOpResolution = dbOpResolutionFrom(row.dbOpSites, row.boundDbOps, row.outOfScopeDbOps);
      return {
        repoName: row.name,
        nodeCountsByType,
        entityCount: nodeCountsByType.entity ?? 0,
        entitiesWithDbOps: row.entitiesWithDbOps,
        functionCount: nodeCountsByType.function ?? 0,
        functionsWithCalls: row.functionsWithCalls,
        externalCallCount: nodeCountsByType.external_call ?? 0,
        resolvedExternalCallCount: row.resolvedExternalCallCount,
        ...(callResolution ? { callResolution } : {}),
        ...(analysis ? { analysis } : {}),
        ...(dbOpResolution ? { dbOpResolution } : {}),
      };
    });
  }

  async listAllRepositories(nameFilter?: string[]): Promise<RepoSummary[]> {
    // Repository nodes have id === `${hash}` (no `:type:…` suffix) — that's
    // the contract enforced by buildRepoFilter's `isRepoNode` branch. So
    // node.id IS the hash for these rows.
    //
    // When nameFilter is provided we bind each name as a positional parameter
    // (better-sqlite3 doesn't expand JS arrays). Empty array → return nothing
    // (an explicit caller asked for "no repos", honor it).
    const useFilter = Array.isArray(nameFilter);
    if (useFilter && nameFilter!.length === 0) return [];

    const filterClause = useFilter ? `AND r.name IN (${nameFilter!.map((_, i) => `@n${i}`).join(', ')})` : '';
    const query = `
      SELECT
        r.id AS hash,
        r.name AS name,
        json_extract(r.properties, '$.type') AS type,
        json_extract(r.properties, '$.parsedAt') AS parsedAt,
        r.summary AS summary
      FROM nodes r
      WHERE r.type = 'repository'
        ${filterClause}
      ORDER BY r.name
    `;

    const params: Record<string, unknown> = {};
    if (useFilter) {
      nameFilter!.forEach((name, i) => {
        params[`n${i}`] = name;
      });
    }

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
    // Repository node ids ARE the repo hash (no `:type:…` suffix) — same
    // contract listAllRepositories documents — so r.id is the hash column.
    // One query, no per-repo counts (that's getRepoOverview's job).
    const query = `
      SELECT r.id AS hash,
             r.name AS name,
             json_extract(r.properties, '$.parserVersion') AS parserVersion
      FROM nodes r
      WHERE ${buildRepoFilter(repoHashes, 'r', true)}
        AND r.type = 'repository'
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
    const repoFilter = buildRepoFilter(repoHashes);

    const query = `
      SELECT
        n.id as id,
        n.name,
        json_extract(n.properties, '$.path') as path,
        json_extract(n.properties, '$.packageType') as type,
        json_extract(n.properties, '$.language') as language,
        json_extract(n.properties, '$.description') as description,
        n.repo_id as repoId
      FROM nodes n
      WHERE n.type = 'package'
        AND ${repoFilter}
      ORDER BY n.name
    `;

    return this.driver.withReadTransaction(async (tx) => {
      return tx.run<PackageInfo>(query);
    });
  }

  async getPackageLinkerFacts(repoHashes: string[]): Promise<PackageLinkerFacts> {
    if (repoHashes.length === 0) return { files: [], declarations: [] };
    const repoFilter = buildRepoFilter(repoHashes, 'n');
    const declarationRepoFilter = buildRepoFilter(repoHashes, 'd');
    const declarationFileRepoFilter = buildRepoFilter(repoHashes, 'f');
    const query = `
      SELECT
        n.id,
        n.type,
        n.name,
        n.file_path AS filePath,
        n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND (
          (
            n.type = 'file'
            AND json_type(n.properties, '$.packageId') = 'text'
            AND (
              json_type(n.properties, '$.packageImports') IS NOT NULL
              OR n.id IN (
                SELECT json_extract(d.properties, '$.fileId')
                FROM nodes d
                JOIN nodes f ON f.id = json_extract(d.properties, '$.fileId')
                WHERE ${declarationRepoFilter}
                  AND ${declarationFileRepoFilter}
                  AND d.type IN ('class', 'interface', 'type_alias', 'enum', 'function', 'variable')
                  AND json_extract(d.properties, '$.isExported') = 1
                  AND (d.type <> 'function' OR json_extract(d.properties, '$.kind') = 'function')
                  AND f.type = 'file'
                  AND json_type(f.properties, '$.packageId') = 'text'
              )
            )
          )
          OR (
            n.type IN ('class', 'interface', 'type_alias', 'enum', 'function', 'variable')
            AND json_extract(n.properties, '$.isExported') = 1
            AND (n.type <> 'function' OR json_extract(n.properties, '$.kind') = 'function')
            AND json_extract(n.properties, '$.fileId') IN (
              SELECT f.id
              FROM nodes f
              WHERE ${declarationFileRepoFilter}
                AND f.type = 'file'
                AND json_type(f.properties, '$.packageId') = 'text'
            )
          )
        )
      ORDER BY n.repo_id, n.type, n.id
    `;
    const rows = await this.driver.withReadTransaction((tx) =>
      tx.run<{ id: string; type: string; name: string; filePath: string | null; properties: string }>(query),
    );

    // Warn-and-skip, never throw. This is a READ PROJECTION: the same policy target-slicer
    // states for push ("not thrown: push must not be DoS-able by one bad node") applies with
    // more force here, because one malformed row would otherwise abort resolution for the whole
    // workspace rather than degrade the single file it came from.
    const skipped: string[] = [];
    const facts: PackageLinkerFacts = { files: [], declarations: [] };
    for (const row of rows) {
      const properties = parseProperties(row.properties);
      if (row.type === NodeType.File) {
        const packageId = properties.packageId;
        if (typeof packageId !== 'string' || packageId.length === 0) {
          skipped.push(`File ${row.id}: missing packageId`);
          continue;
        }
        const storedImports = properties.packageImports;
        if (storedImports !== undefined && !Array.isArray(storedImports)) {
          skipped.push(`File ${row.id}: invalid packageImports`);
          continue;
        }
        facts.files.push({
          id: row.id,
          path: typeof properties.path === 'string' ? properties.path : (row.filePath ?? row.name),
          packageId,
          ...(typeof properties.target === 'string' ? { target: properties.target } : {}),
          imports: (storedImports ?? []) as PackageLinkerImportInfo[],
        });
        continue;
      }
      const fileId = properties.fileId;
      if (typeof fileId !== 'string' || fileId.length === 0) {
        skipped.push(`declaration ${row.id}: missing fileId`);
        continue;
      }
      facts.declarations.push({
        id: row.id,
        name: row.name,
        fileId,
        kind: row.type as PackageLinkerDeclarationKind,
        isExported: true,
      });
    }
    if (skipped.length > 0) {
      console.warn(
        `[coredoc] package linker: skipped ${skipped.length} malformed row(s) — ${skipped.slice(0, 5).join('; ')}` +
          `${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''}`,
      );
    }
    return facts;
  }

  // -------------------------------------------------------------------------
  // Traversals
  // -------------------------------------------------------------------------

  async getDirectCallers(targetId: string, repoHashes: string[]): Promise<CallerInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'caller');

    // We accept both CALLS and REFERENCES_VARIABLE edges. CALLS fires when
    // the target is invoked (`fn()`); REFERENCES_VARIABLE fires when the
    // target is referenced by name in an argument position
    // (e.g. `useValues(userLogic)` in Kea-style logics). The downstream
    // edge filter is just a SQL `IN (...)` — much cleaner than running two
    // queries and merging, and the dedup on (caller.id) below collapses
    // the rare case where the same caller has both edge types to the same
    // target. CALLS wins for `callSiteLine` because it points at the
    // invocation site, which is more useful than the first identifier
    // mention.
    const query = `
      WITH ranked_callers AS (
        SELECT
          caller.id,
          caller.name,
          caller.file_path as filePath,
          caller.start_line as startLine,
          caller.end_line as endLine,
          caller.summary,
          caller.properties,
          json_extract(e.properties, '$.line') as callSiteLine,
          json_extract(e.properties, '$.isAsync') as isAsyncCall,
          json_extract(e.properties, '$.provenanceInferred') as provenanceInferred,
          e.type as edgeType,
          e.id as edgeId,
          cls.name as className,
          CASE e.type WHEN 'CALLS' THEN 0 ELSE 1 END as edgePriority,
          ROW_NUMBER() OVER (
            PARTITION BY caller.id
            ORDER BY CASE e.type WHEN 'CALLS' THEN 0 ELSE 1 END, e.id, cls.id
          ) as callerRank
        FROM edges e
        JOIN nodes caller ON caller.id = e.source_id
        LEFT JOIN edges hasMethod ON hasMethod.target_id = caller.id AND hasMethod.type = 'HAS_METHOD'
        LEFT JOIN nodes cls ON cls.id = hasMethod.source_id
        WHERE e.target_id = @targetId
          AND e.type IN ('CALLS', 'REFERENCES_VARIABLE')
          AND ${repoFilter}
      )
      SELECT id, name, filePath, startLine, endLine, summary, properties,
             callSiteLine, isAsyncCall, provenanceInferred, edgeType, className
      FROM ranked_callers
      WHERE callerRank = 1
      ORDER BY edgePriority, filePath, startLine, id, edgeId
      LIMIT 100
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        properties: string;
        callSiteLine: number | null;
        isAsyncCall: boolean | null;
        provenanceInferred: boolean | null;
        edgeType: string;
        className: string | null;
      }>(query, { targetId });
    });

    const seen = new Set<string>();
    const callers: CallerInfo[] = [];
    for (const row of results) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      callers.push(
        callerInfoFromRow(row, parseProperties(row.properties), {
          distance: 1,
          className: row.className,
          callSiteLine: row.callSiteLine,
          isAsyncCall: row.isAsyncCall,
          provenanceInferred: row.provenanceInferred,
        }),
      );
    }
    return callers;
  }

  async getTransitiveCallers(targetId: string, depth: number, repoHashes: string[]): Promise<CallerInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'caller');

    // Recursive walk of CALLS edges backward from targetId. Bounded by
    // @depth (cap of 10) so worst-case row count stays small on a sparse code
    // graph; idx_edges_target_type makes each step an indexed scan.
    const query = `
      WITH RECURSIVE ancestors(id, depth, inferred) AS (
        SELECT source_id, 1,
               CASE WHEN json_extract(properties, '$.provenanceInferred') THEN 1 ELSE 0 END
        FROM edges
        WHERE type = 'CALLS' AND target_id = @targetId
        UNION
        -- A chain is only as proven as its weakest edge, so the flag is OR'd
        -- along the walk: one inferred hop makes the whole path inferred.
        SELECT e.source_id, a.depth + 1,
               CASE WHEN a.inferred = 1 OR json_extract(e.properties, '$.provenanceInferred') THEN 1 ELSE 0 END
        FROM edges e
        JOIN ancestors a ON e.target_id = a.id
        WHERE e.type = 'CALLS' AND a.depth < @depth
      ),
      shortest AS (
        -- MIN(inferred) so a caller reachable by BOTH a proven and an inferred
        -- path is reported as proven — the proven path is real evidence, and
        -- flagging it would be the false-positive direction.
        SELECT id, MIN(depth) AS distance, MIN(inferred) AS inferred FROM ancestors GROUP BY id
      )
      SELECT
        caller.id,
        caller.name,
        caller.file_path as filePath,
        caller.start_line as startLine,
        caller.end_line as endLine,
        caller.summary,
        caller.properties,
        shortest.distance,
        shortest.inferred as provenanceInferred,
        cls.name as className
      FROM shortest
      JOIN nodes caller ON caller.id = shortest.id
      LEFT JOIN edges hasMethod ON hasMethod.target_id = caller.id AND hasMethod.type = 'HAS_METHOD'
      LEFT JOIN nodes cls ON cls.id = hasMethod.source_id
      WHERE ${repoFilter}
        AND caller.id != @targetId
      ORDER BY shortest.distance, caller.file_path, caller.id
      LIMIT 100
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        properties: string;
        distance: number;
        provenanceInferred: number | null;
        className: string | null;
      }>(query, { targetId, depth: clampTraversalDepth(depth) });
    });

    return results.map((row) =>
      callerInfoFromRow(row, parseProperties(row.properties), {
        distance: row.distance,
        className: row.className,
        provenanceInferred: row.provenanceInferred,
      }),
    );
  }

  async getReachingEntrypoints(targetId: string, depth: number, repoHashes: string[]): Promise<EntrypointInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'ep');

    // Two cases for "entrypoint reaches targetId":
    //   1. the entrypoint's handler IS targetId (depth 0)
    //   2. handler transitively calls targetId — walk CALLS edges forward
    //      from each candidate handler up to @depth and check membership.
    //
    // Using a forward recursive CTE seeded from the targetId's ancestors
    // (computed via a backward walk) is symmetric and lets us skip the
    // closure table entirely. The backward seed (`reachable_handlers`) is
    // the set of handler IDs whose call tree contains targetId.
    const query = `
      WITH RECURSIVE reachable_handlers(id, depth) AS (
        SELECT source_id, 1
        FROM edges
        WHERE type = 'CALLS' AND target_id = @targetId
        UNION
        SELECT e.source_id, rh.depth + 1
        FROM edges e
        JOIN reachable_handlers rh ON e.target_id = rh.id
        WHERE e.type = 'CALLS' AND rh.depth < @depth
      )
      SELECT DISTINCT
        ep.id,
        ep.file_path as filePath,
        ep.start_line as startLine,
        ep.end_line as endLine,
        ep.properties,
        handler.name as handlerName,
        handler.id as handlerId
      FROM nodes ep
      JOIN edges handles ON handles.source_id = ep.id AND handles.type = 'HANDLES'
      JOIN nodes handler ON handler.id = handles.target_id
      WHERE ${repoFilter}
        AND ep.type = 'entrypoint'
        AND (
          handler.id = @targetId
          OR handler.id IN (SELECT id FROM reachable_handlers)
        )
      ORDER BY json_extract(ep.properties, '$.fullPath'), ep.id
      LIMIT 20
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
        handlerName: string;
        handlerId: string;
      }>(query, { targetId, depth: clampTraversalDepth(depth + 3) });
    });

    return results.map((row) =>
      entrypointInfoFromRow(row, parseProperties(row.properties), { id: row.handlerId, name: row.handlerName }),
    );
  }

  async findShortestPath(startId: string, endId: string, repoHashes: string[]): Promise<PathStep[]> {
    // BFS implemented in JS rather than a single recursive CTE because:
    //   - BFS guarantees the SHORTEST path (the function's contract).
    //   - SQLite's recursive CTE iterates DFS-order by default; capping the
    //     CTE's row count could truncate before the relevant branch was
    //     explored — i.e., return "no path" even though one exists within
    //     depth 10. JS BFS terminates early when
    //     the target is reached, naturally bounding work to the shortest-
    //     path subgraph.
    //   - Each level is a single bounded `IN (...)` lookup against the
    //     edges table — sub-millisecond on a local SQLite, ~10ms × depth
    //     on Turso remote (depth ≤ 10, so ≤ 100ms in the worst case).
    const scopedEndpoints = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{ id: string }>(
        `SELECT n.id
         FROM nodes n
         WHERE n.id IN (@startId, @endId)
           AND ${buildRepoFilter(repoHashes, 'n')}`,
        { startId, endId },
      );
    });
    const scopedEndpointIds = new Set(scopedEndpoints.map((row) => row.id));
    if (!scopedEndpointIds.has(startId) || !scopedEndpointIds.has(endId)) return [];

    if (startId === endId) {
      const single = await this.hydratePathSteps([startId]);
      return single;
    }

    const visited = new Set<string>([startId]);
    // Predecessor map lets us reconstruct the path once we hit @endId
    // without carrying the full path string through every BFS frontier
    // entry.
    const predecessor = new Map<string, string>();
    let frontier: string[] = [startId];

    for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH && frontier.length > 0; depth++) {
      const placeholders = frontier.map((_, i) => `@id${i}`).join(',');
      const params: Record<string, unknown> = Object.fromEntries(frontier.map((id, i) => [`id${i}`, id]));
      const edgeRows = await this.driver.withReadTransaction(async (tx) => {
        return tx.run<{ sourceId: string; targetId: string }>(
          `SELECT e.source_id AS sourceId, e.target_id AS targetId
           FROM edges e
           JOIN nodes target ON target.id = e.target_id
           WHERE e.type = 'CALLS'
             AND e.source_id IN (${placeholders})
             AND ${buildRepoFilter(repoHashes, 'target')}
           ORDER BY e.source_id, e.target_id`,
          params,
        );
      });

      const nextFrontier: string[] = [];
      for (const edge of edgeRows) {
        if (visited.has(edge.targetId)) continue;
        visited.add(edge.targetId);
        predecessor.set(edge.targetId, edge.sourceId);
        if (edge.targetId === endId) {
          const path: string[] = [endId];
          let cur = endId;
          while (predecessor.has(cur)) {
            const prev = predecessor.get(cur)!;
            path.unshift(prev);
            cur = prev;
          }
          return await this.hydratePathSteps(path);
        }
        nextFrontier.push(edge.targetId);
      }
      frontier = nextFrontier;
    }

    return [];
  }

  /**
   * Look up `(name, filePath, startLine, summary, classId)` for each id in a
   * traversal and return them in the same order. Used by findShortestPath
   * after BFS has produced an ordered id list.
   */
  private async hydratePathSteps(nodeIds: string[]): Promise<PathStep[]> {
    if (nodeIds.length === 0) return [];
    const idParams = Object.fromEntries(nodeIds.map((id, i) => [`id${i}`, id]));
    const nodeResults = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        summary: string | null;
        properties: string;
      }>(
        `SELECT id, name, file_path as filePath, start_line as startLine, summary, properties
         FROM nodes
         WHERE id IN (${nodeIds.map((_, i) => `@id${i}`).join(',')})`,
        idParams,
      );
    });
    const nodeMap = new Map(nodeResults.map((n) => [n.id, n]));
    return nodeIds.map((id) => {
      const node = nodeMap.get(id);
      if (!node) {
        return { id, name: 'unknown', filePath: '', startLine: 0 };
      }
      const props = parseProperties(node.properties);
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        startLine: node.startLine,
        summary: node.summary || undefined,
        classId: props.classId as string | undefined,
      };
    });
  }

  async getCallTree(rootId: string, depth: number, repoHashes: string[]): Promise<CallTreeNode[]> {
    const boundedDepth = clampTraversalDepth(depth);

    const query = `
      WITH RECURSIVE call_tree AS (
        SELECT
          root.id,
          0 as depth
        FROM nodes root
        WHERE root.id = @rootId
          AND ${buildRepoFilter(repoHashes, 'root')}
        UNION ALL
        SELECT
          target.id,
          call_tree.depth + 1
        FROM edges e
        JOIN call_tree ON e.source_id = call_tree.id
        JOIN nodes target ON target.id = e.target_id
        WHERE e.type = 'CALLS'
          AND call_tree.depth < @depth
          AND ${buildRepoFilter(repoHashes, 'target')}
      ),
      nearest AS (
        SELECT id, MIN(depth) AS depth
        FROM call_tree
        GROUP BY id
      )
      SELECT
        n.id,
        n.name,
        n.file_path as filePath,
        n.start_line as startLine,
        n.summary,
        n.properties,
        ct.depth,
        cls.name as className
      FROM nearest ct
      JOIN nodes n ON n.id = ct.id
      LEFT JOIN edges hasMethod ON hasMethod.target_id = n.id AND hasMethod.type = 'HAS_METHOD'
      LEFT JOIN nodes cls ON cls.id = hasMethod.source_id
      ORDER BY ct.depth, n.name, n.id
      LIMIT 200
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        summary: string | null;
        properties: string;
        depth: number;
        className: string | null;
      }>(query, { rootId, depth: boundedDepth });
    });

    return results.map((row) => {
      const props = parseProperties(row.properties);
      return {
        id: row.id,
        name: row.name,
        kind: (props.kind as 'function' | 'method') || 'function',
        filePath: row.filePath,
        startLine: row.startLine,
        className: row.className || undefined,
        summary: row.summary || undefined,
        depth: row.depth,
      };
    });
  }

  async getDirectCallees(sourceId: string, repoHashes: string[]): Promise<FunctionInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'callee');

    const query = `
      SELECT
        callee.id,
        callee.name,
        callee.file_path as filePath,
        callee.start_line as startLine,
        callee.end_line as endLine,
        callee.summary,
        callee.properties
      FROM edges e
      JOIN nodes callee ON callee.id = e.target_id
      WHERE e.source_id = @sourceId
        AND e.type = 'CALLS'
        AND ${repoFilter}
      ORDER BY json_extract(e.properties, '$.line')
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        properties: string;
      }>(query, { sourceId });
    });

    return results.map((row) => functionInfoFromRow(row, parseProperties(row.properties)));
  }

  // -------------------------------------------------------------------------
  // Impact Analysis
  // -------------------------------------------------------------------------

  async getClassExtensions(classId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'child');

    const query = `
      SELECT
        child.id,
        child.name,
        child.file_path as filePath,
        child.start_line as startLine,
        child.end_line as endLine,
        child.properties
      FROM edges e
      JOIN nodes child ON child.id = e.source_id
      WHERE e.target_id = @classId
        AND e.type = 'EXTENDS'
        AND ${repoFilter}
      ORDER BY child.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
      }>(query, { classId });
    });

    return results.map((row) => namedDeclarationFromRow('class', row, parseProperties(row.properties)));
  }

  async getInterfaceImplementations(interfaceId: string, repoHashes: string[]): Promise<ClassInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'impl');

    const query = `
      SELECT
        impl.id,
        impl.name,
        impl.file_path as filePath,
        impl.start_line as startLine,
        impl.end_line as endLine,
        impl.properties
      FROM edges e
      JOIN nodes impl ON impl.id = e.source_id
      WHERE e.target_id = @interfaceId
        AND e.type = 'IMPLEMENTS_INTERFACE'
        AND ${repoFilter}
      ORDER BY impl.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: string;
      }>(query, { interfaceId });
    });

    return results.map((row) => namedDeclarationFromRow('class', row, parseProperties(row.properties)));
  }

  async getEntityConsumers(
    entityName: string,
    repoHashes: string[],
    operation?: DbOperationType,
  ): Promise<EntityConsumer[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'fn');

    let query = `
      SELECT
        fn.id,
        fn.name,
        fn.file_path as filePath,
        fn.start_line as startLine,
        fn.properties,
        json_extract(e.properties, '$.operation') as operation,
        cls.name as className
      FROM nodes entity
      JOIN edges e ON e.target_id = entity.id AND e.type = 'OPERATES_ON'
      JOIN nodes fn ON fn.id = e.source_id
      LEFT JOIN edges hasMethod ON hasMethod.target_id = fn.id AND hasMethod.type = 'HAS_METHOD'
      LEFT JOIN nodes cls ON cls.id = hasMethod.source_id
      WHERE (entity.name = @entityName OR json_extract(entity.properties, '$.tableName') = @entityName)
        AND entity.type = 'entity'
        AND ${repoFilter}
    `;

    if (operation) {
      query += ` AND json_extract(e.properties, '$.operation') = @operation`;
    }

    query += ` ORDER BY json_extract(e.properties, '$.operation'), fn.file_path`;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        properties: string;
        operation: string;
        className: string | null;
      }>(query, { entityName, operation: operation || null });
    });

    return results.map((row) => {
      const props = parseProperties(row.properties);
      return {
        id: row.id,
        name: row.name,
        kind: (props.kind as 'function' | 'method') || 'function',
        filePath: row.filePath,
        startLine: row.startLine,
        className: row.className || undefined,
        operation: row.operation as DbOperationType,
      };
    });
  }

  async getTypeUsages(typeId: string, repoHashes: string[]): Promise<TypeUsage[]> {
    // Source-side filter: include only consumers in the requested repos. The
    // type itself can live in another repo (cross-repo type sharing is fine).
    const repoFilter = buildRepoFilter(repoHashes, 'src');

    const query = `
      SELECT
        src.id,
        src.name,
        src.type,
        src.file_path AS filePath,
        src.start_line AS startLine,
        src.end_line AS endLine,
        json_extract(e.properties, '$.usage') AS usage,
        json_extract(e.properties, '$.via') AS via,
        json_extract(e.properties, '$.useKind') AS useKind,
        json_extract(e.properties, '$.member') AS member,
        json_extract(e.properties, '$.ambiguous') AS ambiguous
      FROM edges e
      JOIN nodes src ON src.id = e.source_id
      WHERE e.target_id = @typeId
        AND (
          e.type = 'USES_TYPE'
          OR (
            e.type = 'RESOLVES_TO'
            AND json_extract(e.properties, '$.relation') = 'package-import'
          )
        )
        AND ${repoFilter}
      ORDER BY src.file_path, src.start_line, src.id
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        type: NodeType;
        filePath: string;
        startLine: number | null;
        endLine: number | null;
        usage: string | null;
        via: string | null;
        useKind: string | null;
        member: string | null;
        ambiguous: number | boolean | null;
      }>(query, { typeId });
    });

    return results.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      filePath: row.filePath,
      startLine: row.startLine ?? 0,
      endLine: row.endLine ?? undefined,
      usage: (row.usage ?? 'parameter') as TypeUsageKind,
      via: row.via ?? undefined,
      // Value-position member reference metadata; absent on type-position edges.
      useKind: (row.useKind as TypeUseKind | null) ?? undefined,
      member: row.member ?? undefined,
      ambiguous: Boolean(row.ambiguous),
    }));
  }

  async getEntitiesForFunctions(
    functionIds: string[],
    repoHashes: string[],
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

    // Build IN clause - functionIds come from DB (stable IDs), safe to inline
    const idList = functionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

    const query = `
      SELECT
        e.source_id as functionId,
        entity.name as entityName,
        json_extract(entity.properties, '$.tableName') as tableName,
        json_extract(e.properties, '$.operation') as operation,
        entity.id as entityId
      FROM edges e
      JOIN nodes source ON source.id = e.source_id
      JOIN nodes entity ON entity.id = e.target_id AND entity.type = 'entity'
      WHERE e.type = 'OPERATES_ON'
        AND e.source_id IN (${idList})
        AND ${buildRepoFilter(repoHashes, 'source')}
      ORDER BY e.source_id, entity.name
    `;

    return this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        functionId: string;
        entityName: string;
        tableName: string;
        operation: string;
        entityId: string;
      }>(query, {});
    });
  }

  // -------------------------------------------------------------------------
  // Push Operations
  // -------------------------------------------------------------------------

  async pushNodes(nodes: GraphNode[]): Promise<number> {
    if (nodes.length === 0) return 0;

    return this.driver.executeBatch(nodes, async (batch, tx) => {
      await upsertNodesInTransaction(tx, batch);
    });
  }

  async pushEdges(edges: GraphEdge[]): Promise<number> {
    if (edges.length === 0) return 0;

    return this.driver.executeBatch(edges, async (batch, tx) => {
      await upsertEdgesInTransaction(tx, batch);
    });
  }

  // -------------------------------------------------------------------------
  // Cross-Repo
  // -------------------------------------------------------------------------

  async getExternalCalls(repoHashes: string[], targetService?: string): Promise<ExternalCallInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'ec');

    // Match on the call's EFFECTIVE target: `targetService` is the parser-emitted
    // canonical service, `serviceName` may be the client/SDK identity instead
    // ("sampleApiClient", or a profile-authored label like "acme-backend"), so
    // filtering on serviceName alone returns nothing for any repo whose profile
    // fills both. The read side uses three levels: targetService first, then the
    // repo the call RESOLVES_TO (`resolvedTargetRepoName` — the only name a
    // Swift/Kotlin client has, since its profile emits an empty serviceName), then
    // serviceName as the fallback for rows that predate targetService. The MCP
    // tools key on the same three, so trace and list agree on one effective target.
    // linker.ts and the from-turso mapper adapter are unchanged and still resolve
    // targetService → serviceName only; this wider precedence is read-side only.
    let serviceFilter = '';
    if (targetService) {
      serviceFilter = `AND (COALESCE(json_extract(ec.properties, '$.targetService'), targetRepo.name, json_extract(ec.properties, '$.serviceName')) = @targetService OR targetRepo.name = @targetService)`;
    }

    const query = `
      SELECT
        ec.id,
        json_extract(ec.properties, '$.callerId') as callerId,
        caller.name as callerName,
        caller.file_path as callerFilePath,
        json_extract(ec.properties, '$.serviceName') as serviceName,
        json_extract(ec.properties, '$.targetService') as targetService,
        json_extract(ec.properties, '$.sdkName') as sdkName,
        json_extract(ec.properties, '$.method') as method,
        json_extract(ec.properties, '$.protocol') as protocol,
        json_extract(ec.properties, '$.httpMethod') as httpMethod,
        json_extract(ec.properties, '$.pathTemplate') as pathTemplate,
        json_extract(ec.properties, '$.messagingSystem') as messagingSystem,
        json_extract(ec.properties, '$.messagingDestination') as messagingDestination,
        json_extract(ec.properties, '$.messagingDestinationRef') as messagingDestinationRef,
        json_extract(ec.properties, '$.ipcDirection') as ipcDirection,
        json_extract(ec.properties, '$.grpcService') as grpcService,
        json_extract(ec.properties, '$.grpcMethod') as grpcMethod,
        json_extract(ec.properties, '$.graphqlOperationType') as graphqlOperationType,
        json_extract(ec.properties, '$.graphqlOperationName') as graphqlOperationName,
        json_extract(ec.properties, '$.monikerPackage') as monikerPackage,
        json_extract(ec.properties, '$.monikerDescriptor') as monikerDescriptor,
        json_extract(ec.properties, '$.dispatchMethod') as dispatchMethod,
        json_extract(ec.properties, '$.resolvedTargetId') as resolvedTargetId,
        targetRepo.name as resolvedTargetRepoName,
        ec.file_path as filePath,
        ec.start_line as startLine
      FROM nodes ec
      LEFT JOIN nodes caller ON caller.id = json_extract(ec.properties, '$.callerId')
      LEFT JOIN nodes target ON target.id = json_extract(ec.properties, '$.resolvedTargetId')
      LEFT JOIN nodes targetRepo
        ON targetRepo.type = 'repository' AND targetRepo.id = COALESCE(target.repo_id, target.id)
      WHERE ec.type = 'external_call'
        AND ${repoFilter}
        ${serviceFilter}
      ORDER BY caller.name
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<ExternalCallRow>(query, targetService != null ? { targetService } : {});
    });

    return results.map(externalCallInfoFromRow);
  }

  async getExternalCallsWithMessaging(repoHashes: string[]): Promise<MessagingExternalCall[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'ec');

    // Destination filter in SQL and a narrow projection for producer/consumer joins.
    const query = `
      SELECT
        ec.id,
        caller.name as callerName,
        ec.file_path as filePath,
        ec.start_line as startLine,
        json_extract(ec.properties, '$.messagingSystem') as system,
        json_extract(ec.properties, '$.messagingDestination') as destination,
        json_extract(ec.properties, '$.messagingDestinationRef') as destinationRef
      FROM nodes ec
      LEFT JOIN nodes caller ON caller.id = json_extract(ec.properties, '$.callerId')
      WHERE ec.type = 'external_call'
        AND ${repoFilter}
        AND json_extract(ec.properties, '$.messagingDestination') IS NOT NULL
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
      startLine: row.startLine,
      system: row.system || undefined,
      destination: row.destination,
      destinationRef: row.destinationRef || undefined,
    }));
  }

  async getExternalCallsFrom(functionId: string, repoHashes: string[]): Promise<ExternalCallInfo[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'ec');

    const query = `
      SELECT
        ec.id,
        json_extract(ec.properties, '$.callerId') as callerId,
        caller.name as callerName,
        caller.file_path as callerFilePath,
        json_extract(ec.properties, '$.serviceName') as serviceName,
        json_extract(ec.properties, '$.targetService') as targetService,
        json_extract(ec.properties, '$.sdkName') as sdkName,
        json_extract(ec.properties, '$.method') as method,
        json_extract(ec.properties, '$.protocol') as protocol,
        json_extract(ec.properties, '$.httpMethod') as httpMethod,
        json_extract(ec.properties, '$.pathTemplate') as pathTemplate,
        json_extract(ec.properties, '$.messagingSystem') as messagingSystem,
        json_extract(ec.properties, '$.messagingDestination') as messagingDestination,
        json_extract(ec.properties, '$.messagingDestinationRef') as messagingDestinationRef,
        json_extract(ec.properties, '$.ipcDirection') as ipcDirection,
        json_extract(ec.properties, '$.grpcService') as grpcService,
        json_extract(ec.properties, '$.grpcMethod') as grpcMethod,
        json_extract(ec.properties, '$.graphqlOperationType') as graphqlOperationType,
        json_extract(ec.properties, '$.graphqlOperationName') as graphqlOperationName,
        json_extract(ec.properties, '$.monikerPackage') as monikerPackage,
        json_extract(ec.properties, '$.monikerDescriptor') as monikerDescriptor,
        json_extract(ec.properties, '$.dispatchMethod') as dispatchMethod,
        json_extract(ec.properties, '$.resolvedTargetId') as resolvedTargetId,
        targetRepo.name as resolvedTargetRepoName,
        ec.file_path as filePath,
        ec.start_line as startLine
      FROM nodes ec
      LEFT JOIN nodes caller ON caller.id = json_extract(ec.properties, '$.callerId')
      LEFT JOIN nodes target ON target.id = json_extract(ec.properties, '$.resolvedTargetId')
      LEFT JOIN nodes targetRepo
        ON targetRepo.type = 'repository' AND targetRepo.id = COALESCE(target.repo_id, target.id)
      WHERE ec.type = 'external_call'
        AND json_extract(ec.properties, '$.callerId') = @functionId
        AND ${repoFilter}
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<ExternalCallRow>(query, { functionId });
    });

    return results.map(externalCallInfoFromRow);
  }

  // -------------------------------------------------------------------------
  // Dynamic boundaries (statically unresolved calls)
  // -------------------------------------------------------------------------

  async findUnresolvedCallsByNameTail(
    nameTail: string,
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    if (nameTail.length === 0) return [];
    return this.queryUnresolvedCalls('u.callee_name_tail = @nameTail', { nameTail }, repoHashes, options);
  }

  async findUnresolvedCallsInFiles(
    filePaths: string[],
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    if (filePaths.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = filePaths.map((filePath, index) => {
      params[`filePath${index}`] = filePath;
      return `@filePath${index}`;
    });
    return this.queryUnresolvedCalls(`u.file_path IN (${placeholders.join(', ')})`, params, repoHashes, options);
  }

  private async queryUnresolvedCalls(
    filter: string,
    params: Record<string, unknown>,
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]> {
    const limit = clampLimit(
      options?.limit ?? UNRESOLVED_CALL_DEFAULT_LIMIT,
      UNRESOLVED_CALL_LIMIT.max,
      UNRESOLVED_CALL_LIMIT.fallback,
    );
    const query = `
      SELECT
        u.caller_id AS callerId,
        u.callee_expression AS calleeExpression,
        u.callee_name_tail AS calleeNameTail,
        u.file_path AS filePath,
        u.line AS line
      FROM unresolved_calls u
      WHERE ${filter}
        AND ${buildRepoFilter(repoHashes, 'u')}
      ORDER BY u.file_path, u.line, u.caller_id
      LIMIT ${limit}
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        callerId: string;
        calleeExpression: string;
        calleeNameTail: string | null;
        filePath: string;
        line: number;
      }>(query, params),
    );
    return rows.map(unresolvedCallFromRow);
  }

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier B — explorer)
  // -------------------------------------------------------------------------

  async getNodesByIds(ids: string[], repoHashes: string[]): Promise<VizNode[]> {
    if (ids.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = ids.map((id, i) => {
      params[`id${i}`] = id;
      return `@id${i}`;
    });
    const query = `
      SELECT ${vizNodeCols('n', 'r')}
      FROM nodes n
      LEFT JOIN nodes r ON r.type = 'repository' AND r.id = COALESCE(n.repo_id, n.id)
      WHERE n.id IN (${placeholders.join(', ')})
        AND ${buildNeighborRepoFilter(repoHashes, 'n')}
    `;
    const rows = await this.driver.withReadTransaction(async (tx) => tx.run<VizNodeRow>(query, params));
    return rows.map(buildVizNode);
  }

  async getNeighborCounts(nodeId: string, repoHashes: string[]): Promise<NeighborCount[]> {
    const nbFilter = buildNeighborRepoFilter(repoHashes, 'nb');
    // One pass per side, tallied by edge type. The neighbor JOIN both drops
    // dangling edges and lets the scope filter apply to the far end.
    const query = `
      SELECT e.type AS edgeType, 'out' AS direction, COUNT(*) AS count
      FROM edges e
      JOIN nodes nb ON nb.id = e.target_id
      WHERE e.source_id = @nodeId AND ${nbFilter}
      GROUP BY e.type
      UNION ALL
      SELECT e.type AS edgeType, 'in' AS direction, COUNT(*) AS count
      FROM edges e
      JOIN nodes nb ON nb.id = e.source_id
      WHERE e.target_id = @nodeId AND ${nbFilter}
      GROUP BY e.type
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ edgeType: string; direction: string; count: number }>(query, { nodeId }),
    );
    return rows.map((r) => ({
      edgeType: r.edgeType as EdgeType,
      direction: r.direction as EdgeDirection,
      count: Number(r.count),
    }));
  }

  async getNeighbors(nodeId: string, params: GetNeighborsParams, repoHashes: string[]): Promise<NeighborsResult> {
    const direction = params.direction ?? 'both';
    const limit = clampLimit(params.limit, NEIGHBOR_LIMIT.max, NEIGHBOR_LIMIT.fallback);
    const nbFilter = buildNeighborRepoFilter(repoHashes, 'nb');

    const bind: Record<string, unknown> = { nodeId, limitPlus1: limit + 1 };
    if (params.cursor) bind.cursor = params.cursor;

    // Restrict to the requested edge kinds, if any. Bound as params so a
    // malformed value can never reach the SQL text.
    let edgeTypeClause = '';
    if (params.edgeTypes && params.edgeTypes.length > 0) {
      const ph = params.edgeTypes.map((t, i) => {
        bind[`et${i}`] = t;
        return `@et${i}`;
      });
      edgeTypeClause = `AND e.type IN (${ph.join(', ')})`;
    }

    // Neighbor-and-edge projection for one side. `out` = focus is the source
    // (neighbor is the target); `in` = focus is the target. Edge orientation in
    // the projected columns stays true source→target, not focus-relative.
    const sideSelect = (focusCol: 'source_id' | 'target_id', nbCol: 'source_id' | 'target_id'): string => `
      SELECT
        e.id AS edgeId,
        e.source_id AS edgeSource,
        e.target_id AS edgeTarget,
        e.type AS edgeType,
        e.confidence AS confidence,
        e.created_by AS createdBy,
        json_extract(e.properties, '$.operation') AS edgeOperation,
        ${vizNodeCols('nb', 'r')}
      FROM edges e
      JOIN nodes nb ON nb.id = e.${nbCol}
      LEFT JOIN nodes r ON r.type = 'repository' AND r.id = COALESCE(nb.repo_id, nb.id)
      WHERE e.${focusCol} = @nodeId ${edgeTypeClause} AND ${nbFilter}`;

    const sides: string[] = [];
    if (direction === 'out' || direction === 'both') sides.push(sideSelect('source_id', 'target_id'));
    if (direction === 'in' || direction === 'both') sides.push(sideSelect('target_id', 'source_id'));

    // Keyset-paginate by the unique edge id. Fetch limit+1 to learn whether a
    // further page exists without a second COUNT query.
    const cursorClause = params.cursor ? 'WHERE edgeId > @cursor' : '';
    const query = `
      SELECT * FROM (
        ${sides.join('\n        UNION ALL\n        ')}
      ) ${cursorClause}
      ORDER BY edgeId
      LIMIT @limitPlus1
    `;

    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<
        VizNodeRow & {
          edgeId: string;
          edgeSource: string;
          edgeTarget: string;
          edgeType: string;
          confidence: number;
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
            confidence: Number(row.confidence),
            createdBy: row.createdBy,
            operation: row.edgeOperation,
          }),
        );
      }
      if (!seenNodes.has(row.id)) {
        seenNodes.add(row.id);
        nodes.push(buildVizNode(row));
      }
    }

    return { nodes, edges, ...pageFacts };
  }

  async listNodesByType(
    type: NodeType,
    params: { limit: number; cursor?: string },
    repoHashes: string[],
  ): Promise<VizNodePage> {
    const limit = clampLimit(params.limit, NODE_PAGE_LIMIT.max, NODE_PAGE_LIMIT.fallback);
    const bind: Record<string, unknown> = { type, limitPlus1: limit + 1 };
    if (params.cursor) bind.cursor = params.cursor;
    // Keyset-paginate by the unique node id, fetching limit+1 to detect a
    // further page without a second COUNT.
    const cursorClause = params.cursor ? 'AND n.id > @cursor' : '';
    const query = `
      SELECT ${vizNodeCols('n', 'r')}
      FROM nodes n
      LEFT JOIN nodes r ON r.type = 'repository' AND r.id = COALESCE(n.repo_id, n.id)
      WHERE n.type = @type
        AND ${buildNeighborRepoFilter(repoHashes, 'n')}
        ${cursorClause}
      ORDER BY n.id
      LIMIT @limitPlus1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) => tx.run<VizNodeRow>(query, bind));
    const { page, ...pageFacts } = pageSlice(rows, limit, (row) => row.id);
    return { nodes: page.map(buildVizNode), ...pageFacts };
  }

  async getNodeWithProperties(
    id: string,
    repoHashes: string[],
  ): Promise<{ node: VizNode; properties: Record<string, unknown> } | null> {
    const query = `
      SELECT ${vizNodeCols('n', 'r')}, n.properties AS rawProperties
      FROM nodes n
      LEFT JOIN nodes r ON r.type = 'repository' AND r.id = COALESCE(n.repo_id, n.id)
      WHERE n.id = @id AND ${buildNeighborRepoFilter(repoHashes, 'n')}
      LIMIT 1
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<VizNodeRow & { rawProperties: string | null }>(query, { id }),
    );
    const row = rows[0];
    if (!row) return null;
    let properties: Record<string, unknown> = {};
    if (row.rawProperties) {
      try {
        const parsed: unknown = JSON.parse(row.rawProperties);
        if (parsed && typeof parsed === 'object') properties = parsed as Record<string, unknown>;
      } catch {
        // Corrupt/legacy properties JSON — treat as no detail rather than 500.
        properties = {};
      }
    }
    return { node: buildVizNode(row), properties };
  }

  /** VizEdge projection for the edges among an explicit node-id set (shared by
   *  getSubgraph). `properties.$.operation` is surfaced for OPERATES_ON, matching
   *  getNeighbors. */
  private async edgesAmong(ids: string[], edgeTypes: EdgeType[]): Promise<VizEdge[]> {
    if (ids.length === 0 || edgeTypes.length === 0) return [];
    const bind: Record<string, unknown> = {};
    const idPh = ids.map((id, i) => {
      bind[`id${i}`] = id;
      return `@id${i}`;
    });
    const etPh = edgeTypes.map((t, i) => {
      bind[`et${i}`] = t;
      return `@et${i}`;
    });
    const query = `
      SELECT e.id AS edgeId, e.source_id AS edgeSource, e.target_id AS edgeTarget,
             e.type AS edgeType, e.confidence AS confidence, e.created_by AS createdBy,
             json_extract(e.properties, '$.operation') AS edgeOperation
      FROM edges e
      WHERE e.type IN (${etPh.join(', ')})
        AND e.source_id IN (${idPh.join(', ')})
        AND e.target_id IN (${idPh.join(', ')})
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        edgeId: string;
        edgeSource: string;
        edgeTarget: string;
        edgeType: string;
        confidence: number;
        createdBy: string;
        edgeOperation: string | null;
      }>(query, bind),
    );
    return rows.map((row) =>
      buildVizEdge({
        id: row.edgeId,
        sourceId: row.edgeSource,
        targetId: row.edgeTarget,
        type: row.edgeType as EdgeType,
        confidence: Number(row.confidence),
        createdBy: row.createdBy,
        operation: row.edgeOperation,
      }),
    );
  }

  async getSubgraph(rootId: string, params: SubgraphParams, repoHashes: string[]): Promise<NeighborsResult> {
    const direction = params.direction ?? 'both';
    const depth = Math.min(5, clampTraversalDepth(params.depth));
    const nodeCap = clampLimit(params.nodeCap, SUBGRAPH_NODE_CAP.max, SUBGRAPH_NODE_CAP.fallback);
    const edgeTypes =
      params.edgeTypes && params.edgeTypes.length > 0 ? params.edgeTypes : [...SUBGRAPH_FLOW_EDGE_TYPES];

    const rootNodes = await this.getNodesByIds([rootId], repoHashes);
    if (rootNodes.length === 0) return { nodes: [], edges: [], truncated: false };

    const bind: Record<string, unknown> = { rootId, depth, capPlus1: nodeCap + 1 };
    const etPh = edgeTypes.map((t, i) => {
      bind[`et${i}`] = t;
      return `@et${i}`;
    });
    const edgeTypeIn = `e.type IN (${etPh.join(', ')})`;

    // Recursive frontier walk from the root. `UNION` dedups (id, depth) rows; the
    // `nodeset` CTE then collapses to the nearest depth per node. Bounded by
    // @depth so the row count stays small even on a dense graph; idx_edges_source
    // / idx_edges_target make each hop an indexed scan. The root is excluded from
    // `nodeset` and prepended explicitly so it is never dropped by the cap.
    let step: string;
    if (direction === 'out') {
      step = `SELECT e.target_id, rc.depth + 1
              FROM edges e JOIN reachable rc ON e.source_id = rc.id
              JOIN nodes next ON next.id = e.target_id
              WHERE rc.depth < @depth AND ${edgeTypeIn} AND ${buildNeighborRepoFilter(repoHashes, 'next')}`;
    } else if (direction === 'in') {
      step = `SELECT e.source_id, rc.depth + 1
              FROM edges e JOIN reachable rc ON e.target_id = rc.id
              JOIN nodes next ON next.id = e.source_id
              WHERE rc.depth < @depth AND ${edgeTypeIn} AND ${buildNeighborRepoFilter(repoHashes, 'next')}`;
    } else {
      step = `SELECT CASE WHEN e.source_id = rc.id THEN e.target_id ELSE e.source_id END, rc.depth + 1
              FROM edges e JOIN reachable rc ON (e.source_id = rc.id OR e.target_id = rc.id)
              JOIN nodes next ON next.id = CASE WHEN e.source_id = rc.id THEN e.target_id ELSE e.source_id END
              WHERE rc.depth < @depth AND ${edgeTypeIn} AND ${buildNeighborRepoFilter(repoHashes, 'next')}`;
    }

    const idQuery = `
      WITH RECURSIVE reachable(id, depth) AS (
        SELECT @rootId, 0
        UNION
        ${step}
      ),
      nodeset AS (SELECT id, MIN(depth) AS distance FROM reachable WHERE id <> @rootId GROUP BY id)
      SELECT id FROM nodeset
      ORDER BY distance, id
      LIMIT @capPlus1
    `;
    const idRows = await this.driver.withReadTransaction(async (tx) => tx.run<{ id: string }>(idQuery, bind));
    const truncated = idRows.length > nodeCap;
    const neighborIds = (truncated ? idRows.slice(0, nodeCap) : idRows).map((r) => r.id);
    const ids = [rootId, ...neighborIds];

    const [nodes, edges] = await Promise.all([this.getNodesByIds(ids, repoHashes), this.edgesAmong(ids, edgeTypes)]);
    return { nodes, edges, truncated };
  }

  async findDeadNodes(params: DeadCodeParams, repoHashes: string[]): Promise<DeadCodePage> {
    const types = params.types && params.types.length > 0 ? params.types : [...DEAD_CODE_DEFAULT_TYPES];
    const limit = clampLimit(params.limit, DEAD_NODE_LIMIT.max, DEAD_NODE_LIMIT.fallback);
    const bind: Record<string, unknown> = { limitPlus1: limit + 1 };
    if (params.cursor) bind.cursor = params.cursor;

    const typePh = types.map((t, i) => {
      bind[`nt${i}`] = t;
      return `@nt${i}`;
    });
    // Per-scanned-type "has no inbound usage edge" arm. HAS_METHOD / CONTAINS_*
    // are excluded from every usage set (see graph-query-defaults), and exported
    // symbols are excluded outright below since they are reachable off-repo.
    const usageArms = types.map((t, i) => {
      const eph = deadCodeUsageEdges(t).map((et, j) => {
        bind[`ue${i}_${j}`] = et;
        return `@ue${i}_${j}`;
      });
      return `(n.type = @nt${i} AND e.type IN (${eph.join(', ')}))`;
    });

    const cursorClause = params.cursor ? 'AND n.id > @cursor' : '';
    const query = `
      SELECT ${vizNodeCols('n', 'r')}
      FROM nodes n
      LEFT JOIN nodes r ON r.type = 'repository' AND r.id = COALESCE(n.repo_id, n.id)
      WHERE n.type IN (${typePh.join(', ')})
        AND ${buildRepoFilter(repoHashes, 'n')}
        AND COALESCE(json_extract(n.properties, '$.isExported'), 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM edges e
          WHERE e.target_id = n.id
            AND (${usageArms.join(' OR ')})
        )
        ${cursorClause}
      ORDER BY n.id
      LIMIT @limitPlus1
    `;
    const [rows, coverage] = await Promise.all([
      this.driver.withReadTransaction(async (tx) => tx.run<VizNodeRow>(query, bind)),
      this.getCoverageCounts(repoHashes),
    ]);
    const { page, ...pageFacts } = pageSlice(rows, limit, (row) => row.id);
    return {
      nodes: page.map(buildVizNode),
      lowCoverageRepos: lowCoverageRepoNames(coverage),
      ...pageFacts,
    };
  }

  async getCrossRepoBridges(params: CrossRepoBridgeParams, repoHashes: string[]): Promise<NeighborsResult> {
    const limit = clampLimit(params.limit, BRIDGE_LIMIT.max, BRIDGE_LIMIT.fallback);
    const bind: Record<string, unknown> = { limitPlus1: limit + 1 };

    // Scope: keep bridges whose external-call OR entrypoint side is in scope.
    let scopeFilter = '1=1';
    if (repoHashes.length > 0) {
      const ph = repoHashes.map((h, i) => {
        bind[`rh${i}`] = h;
        return `@rh${i}`;
      });
      scopeFilter = `(ec.repo_id IN (${ph.join(', ')}) OR ep.repo_id IN (${ph.join(', ')}))`;
    }
    let focusFilter = '1=1';
    if (params.focusRepoHashes && params.focusRepoHashes.length > 0) {
      const ph = params.focusRepoHashes.map((h, i) => {
        bind[`fr${i}`] = h;
        return `@fr${i}`;
      });
      focusFilter = `(ec.repo_id IN (${ph.join(', ')}) OR ep.repo_id IN (${ph.join(', ')}))`;
    }

    // The materialized cross-repo end-edge is RESOLVES_TO (external_call ->
    // entrypoint); keep only the ones whose two ends live in different repos. Cap
    // the number of BRIDGES in the CTE so the outer LEFT JOIN fan-out (multiple
    // callers/handlers) cannot skew the limit.
    const query = `
      WITH bridge AS (
        SELECT rt.id AS rtId, rt.source_id AS ecId, rt.target_id AS epId,
               rt.confidence AS rtConf, rt.created_by AS rtBy
        FROM edges rt
        JOIN nodes ec ON ec.id = rt.source_id AND ec.type = 'external_call'
        JOIN nodes ep ON ep.id = rt.target_id AND ep.type = 'entrypoint'
        WHERE rt.type = 'RESOLVES_TO'
          AND ec.repo_id IS NOT NULL AND ep.repo_id IS NOT NULL
          AND ec.repo_id <> ep.repo_id
          AND ${scopeFilter}
          AND ${focusFilter}
        ORDER BY rt.id
        LIMIT @limitPlus1
      )
      SELECT b.rtId, b.ecId, b.epId, b.rtConf, b.rtBy,
             mec.id AS mecId, mec.source_id AS callerId, mec.confidence AS mecConf, mec.created_by AS mecBy,
             hnd.id AS hndId, hnd.target_id AS handlerId, hnd.confidence AS hndConf, hnd.created_by AS hndBy
      FROM bridge b
      LEFT JOIN edges mec ON mec.target_id = b.ecId AND mec.type = 'MAKES_EXTERNAL_CALL'
      LEFT JOIN edges hnd ON hnd.source_id = b.epId AND hnd.type = 'HANDLES'
      ORDER BY b.rtId
    `;
    const rows = await this.driver.withReadTransaction(async (tx) => tx.run<CrossRepoBridgeRow>(query, bind));
    return this.assembleBridges(rows, limit, repoHashes);
  }

  /** Fold cross-repo bridge rows (RESOLVES_TO joined to its MAKES_EXTERNAL_CALL /
   *  HANDLES neighbours) into a viz nodes+edges subgraph. Distinct RESOLVES_TO
   *  edges determine truncation; the LEFT JOINs may emit several rows per bridge. */
  private async assembleBridges(
    rows: CrossRepoBridgeRow[],
    limit: number,
    repoHashes: string[],
  ): Promise<NeighborsResult> {
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
      conf: number | null,
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
          confidence: conf == null ? 1 : Number(conf),
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

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier C — C4 architecture view)
  // -------------------------------------------------------------------------

  async getPackageDependencyRollup(repoHashes: string[]): Promise<PackageDependencyRollup[]> {
    // Resolve each call endpoint to its package IN SQL: function -> its file
    // (via the function node's `fileId` property, present for both functions and
    // methods) -> the file's `packageId` property -> the package node. Aggregate
    // by (source package, target package). The scope filter binds the source
    // function; the target may live in another package of the same workspace DB.
    const repoFilter = buildRepoFilter(repoHashes, 'sfn');
    const query = `
      SELECT
        spkg.id AS sourcePackageId,
        spkg.name AS sourcePackageName,
        tpkg.id AS targetPackageId,
        tpkg.name AS targetPackageName,
        COUNT(*) AS callCount,
        MIN(e.confidence) AS minConfidence,
        MAX(CASE WHEN e.created_by <> 'parser' THEN 1 ELSE 0 END) AS inferred
      FROM edges e
      JOIN nodes sfn ON sfn.id = e.source_id AND sfn.type = 'function'
      JOIN nodes sfile ON sfile.id = json_extract(sfn.properties, '$.fileId')
      JOIN nodes spkg ON spkg.id = json_extract(sfile.properties, '$.packageId')
      JOIN nodes tfn ON tfn.id = e.target_id AND tfn.type = 'function'
      JOIN nodes tfile ON tfile.id = json_extract(tfn.properties, '$.fileId')
      JOIN nodes tpkg ON tpkg.id = json_extract(tfile.properties, '$.packageId')
      WHERE e.type = 'CALLS'
        AND spkg.id <> tpkg.id
        AND ${repoFilter}
      GROUP BY spkg.id, tpkg.id
      ORDER BY callCount DESC
    `;
    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{
        sourcePackageId: string;
        sourcePackageName: string;
        targetPackageId: string;
        targetPackageName: string;
        callCount: number;
        minConfidence: number;
        inferred: number;
      }>(query),
    );
    return rows.map((r) => ({
      sourcePackageId: r.sourcePackageId,
      sourcePackageName: r.sourcePackageName,
      targetPackageId: r.targetPackageId,
      targetPackageName: r.targetPackageName,
      callCount: Number(r.callCount),
      minConfidence: Number(r.minConfidence),
      inferred: Number(r.inferred) === 1,
    }));
  }

  async getComponentGraph(repoHashes: string[]): Promise<ComponentGraphData> {
    const nodeFilter = buildRepoFilter(repoHashes, 'n');
    const nodesQuery = `
      SELECT n.id, n.type, n.name, n.file_path AS filePath, n.start_line AS startLine, n.summary
      FROM nodes n
      WHERE n.type IN ('entrypoint', 'component', 'class', 'state_store')
        AND ${nodeFilter}
    `;
    // Edges whose BOTH endpoints are component-level nodes — the architectural
    // relationships the C4 L3 view draws. Scope-filter the source endpoint.
    const srcFilter = buildRepoFilter(repoHashes, 's');
    const edgesQuery = `
      SELECT e.source_id AS sourceId, e.target_id AS targetId, e.type, e.confidence, e.created_by AS createdBy
      FROM edges e
      JOIN nodes s ON s.id = e.source_id AND s.type IN ('entrypoint', 'component', 'class', 'state_store')
      JOIN nodes t ON t.id = e.target_id AND t.type IN ('entrypoint', 'component', 'class', 'state_store')
      WHERE ${srcFilter}
    `;
    return this.driver.withReadTransaction(async (tx) => {
      const [nodeRows, edgeRows] = await Promise.all([
        tx.run<{
          id: string;
          type: string;
          name: string;
          filePath: string | null;
          startLine: number | null;
          summary: string | null;
        }>(nodesQuery),
        tx.run<{ sourceId: string; targetId: string; type: string; confidence: number; createdBy: string }>(edgesQuery),
      ]);
      return {
        nodes: nodeRows.map((r) => ({
          id: r.id,
          type: r.type as ComponentGraphNode['type'],
          name: r.name,
          filePath: r.filePath,
          startLine: r.startLine,
          ...(r.summary ? { summary: r.summary } : {}),
        })),
        edges: edgeRows.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          type: r.type as EdgeType,
          confidence: Number(r.confidence),
          createdBy: r.createdBy as ComponentGraphEdge['createdBy'],
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Resolution Support
  // -------------------------------------------------------------------------

  async deleteEdgesByType(edgeType: EdgeType, repoIds: string[]): Promise<void> {
    if (repoIds.length === 0) return;

    const placeholders = repoIds.map((_, i) => `@repoId${i}`).join(', ');
    const params: Record<string, unknown> = { edgeType };
    repoIds.forEach((id, i) => {
      params[`repoId${i}`] = id;
    });

    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `
        DELETE FROM edges WHERE type = @edgeType
          AND source_id IN (SELECT id FROM nodes WHERE repo_id IN (${placeholders}))
      `,
        params,
      );
    });
  }

  async updateResolvedTargetIds(updates: Map<string, string>): Promise<void> {
    if (updates.size === 0) return;

    const stmt = `
      UPDATE nodes SET properties = json_set(properties, '$.resolvedTargetId', @targetId)
      WHERE id = @nodeId
    `;

    const items = Array.from(updates.entries()).map(([nodeId, targetId]) => ({ nodeId, targetId }));

    await this.driver.executeBatch(items, async (batch, tx) => {
      for (const { nodeId, targetId } of batch) {
        await tx.run(stmt, { nodeId, targetId });
      }
    });
  }

  async clearResolvedTargetIds(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    const stmt = `
      UPDATE nodes SET properties = json_remove(properties, '$.resolvedTargetId')
      WHERE id = @nodeId AND json_extract(properties, '$.resolvedTargetId') IS NOT NULL
    `;

    await this.driver.executeBatch(nodeIds, async (batch, tx) => {
      for (const nodeId of batch) {
        await tx.run(stmt, { nodeId });
      }
    });
  }

  async getResolvesEdge(sourceCallId: string): Promise<ResolvesEdgeInfo | null> {
    const query = `
      SELECT id, source_id as sourceId, target_id as targetId, confidence, properties
      FROM edges
      WHERE type = 'RESOLVES_TO' AND source_id = @sourceCallId
      ORDER BY confidence DESC
      LIMIT 1
    `;

    const rows = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        sourceId: string;
        targetId: string;
        confidence: number;
        properties: string;
      }>(query, { sourceCallId });
    });

    const row = rows[0];
    if (!row) return null;

    const props = parseProperties(row.properties);
    return {
      id: row.id,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      via: props.via as HopVia | undefined,
      chain: Array.isArray(props.chain) ? (props.chain as ResolvedHop[]) : undefined,
      sourceRepoName: (props.sourceRepoName as string) || undefined,
      targetRepoName: (props.targetRepoName as string) || undefined,
      confidenceLevel: (props.confidenceLevel as string) || undefined,
    };
  }

  /**
   * Return only the function nodes that carry a SCIP moniker (`monikerPackage`
   * IS NOT NULL) for the given repos. These are the SDK-source exported methods
   * consumed by `buildSdkSymbolIndex` in the cross-repo symbol hop.
   *
   * Deliberately excludes functions without a moniker to keep the payload small
   * on large repos — a function count of tens of thousands is common; the
   * monikered subset is typically in the low hundreds.
   */
  async getMonikeredFunctions(repoHashes: string[]): Promise<FunctionInfo[]> {
    if (repoHashes.length === 0) return [];

    const repoFilter = buildRepoFilter(repoHashes, 'n');

    const query = `
      SELECT
        n.id,
        n.name,
        n.file_path AS filePath,
        n.start_line AS startLine,
        n.end_line AS endLine,
        n.summary,
        n.properties
      FROM nodes n
      WHERE ${repoFilter}
        AND n.type = 'function'
        AND json_extract(n.properties, '$.monikerPackage') IS NOT NULL
      ORDER BY n.repo_id, n.file_path, n.start_line
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        name: string;
        filePath: string;
        startLine: number;
        endLine: number;
        summary: string | null;
        properties: string;
      }>(query, {});
    });

    // `monikerPackage IS NOT NULL` is the WHERE predicate, so the mapper always
    // emits `moniker` for these rows.
    return results.map((row) => functionInfoFromRow(row, parseProperties(row.properties)));
  }

  /**
   * Intra-repo CALLS edges of the given repos whose target is one of `calleeIds`
   * — the evidence the cross-repo call-edge hop joins on. The callee set is
   * bounded by the caller (the monikered SDK method nodes), so this stays a
   * keyed lookup rather than a full CALLS scan.
   */
  async getInternalCallEdges(
    repoHashes: string[],
    calleeIds: string[],
  ): Promise<{ callerId: string; calleeId: string }[]> {
    if (calleeIds.length === 0) return [];

    // json_each over one bound JSON array, like getEdgesAmong: the callee set is
    // the monikered-function projection and routinely exceeds SQLite's bound
    // parameter ceiling on large workspaces.
    const query = `
      SELECT DISTINCT e.source_id AS callerId, e.target_id AS calleeId
      FROM edges e
      JOIN nodes src ON src.id = e.source_id
      WHERE e.type = 'CALLS'
        AND e.target_id IN (SELECT value FROM json_each(@calleeIds))
        AND ${buildRepoFilter(repoHashes, 'src')}
      ORDER BY e.source_id, e.target_id
    `;

    const rows = await this.driver.withReadTransaction(async (tx) =>
      tx.run<{ callerId: string; calleeId: string }>(query, { calleeIds: JSON.stringify(calleeIds) }),
    );
    return rows.map((row) => ({ callerId: row.callerId, calleeId: row.calleeId }));
  }

  /**
   * Return every node carrying a stored embedding (`embedding IS NOT NULL`)
   * with its parsed vector and per-node provenance props. Only function and
   * entrypoint nodes are ever embedded (transformer.mergeEmbeddings), so the
   * embedding predicate alone bounds the scan. Empty `repoHashes` = all repos
   * (buildRepoFilter's cross-repo convention).
   */
  async getEmbeddedNodes(repoHashes: string[]): Promise<EmbeddedNode[]> {
    const repoFilter = buildRepoFilter(repoHashes, 'n');

    const query = `
      SELECT
        n.id,
        n.type,
        n.name,
        n.file_path AS filePath,
        n.start_line AS startLine,
        n.summary,
        n.embedding,
        json_extract(n.properties, '$.embeddingProvider') AS embeddingProvider,
        json_extract(n.properties, '$.embeddingModel') AS embeddingModel
      FROM nodes n
      WHERE ${repoFilter}
        AND n.embedding IS NOT NULL
      ORDER BY n.repo_id, n.file_path, n.start_line
    `;

    const results = await this.driver.withReadTransaction(async (tx) => {
      return tx.run<{
        id: string;
        type: string;
        name: string;
        filePath: string;
        startLine: number;
        summary: string | null;
        embedding: string;
        embeddingProvider: string | null;
        embeddingModel: string | null;
      }>(query, {});
    });

    return results.map((row) => ({
      id: row.id,
      type: row.type as NodeType,
      name: row.name,
      filePath: row.filePath,
      startLine: row.startLine,
      summary: row.summary || undefined,
      // Written as JSON.stringify(number[]) by pushNodes — trusted round-trip.
      embedding: JSON.parse(row.embedding) as number[],
      embeddingProvider: row.embeddingProvider || undefined,
      embeddingModel: row.embeddingModel || undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Incremental Update Operations
  // -------------------------------------------------------------------------

  async getAppliedGraphSnapshot(repoId: string): Promise<AppliedGraphSnapshot | null> {
    return this.driver.withReadTransaction(async (tx) => {
      const rows = await tx.run<{ snapshot: string }>(`SELECT snapshot FROM graph_meta WHERE repo_id = @repoId`, {
        repoId,
      });
      if (!rows[0]) return null;
      return parseAppliedGraphSnapshot(rows[0].snapshot, repoId);
    });
  }

  /**
   * Apply an incremental changeset to the graph.
   *
   * Executes as a SEQUENCE of bounded write transactions, not one changeset-
   * wide transaction. Turso degrades quadratically as writes accumulate inside
   * a single interactive transaction and kills the stream near ~2MB applied
   * (measured 2026-08-10: identical ~220KB flushes went 3s → 88s →
   * SERVER_ERROR 404), so a changeset-wide transaction cannot survive on a
   * remote data plane at real diff sizes.
   *
   * Consistency contract: the applied-snapshot (graph_meta) is written LAST,
   * in its own transaction. A failure anywhere mid-sequence leaves a
   * partially-updated graph whose snapshot still describes the PREVIOUS push,
   * so the caller's reconciliation (snapshotMatches) refuses to treat it as
   * applied and the job-level retry reapplies the changeset from the top.
   * Every phase is idempotent under reapply: deletes re-delete nothing,
   * upserts hit ON CONFLICT, the edge wipe+insert pair reconverges. Readers
   * may observe intermediate states between chunk commits — the price of
   * surviving the transport; the snapshot gate keeps *decisions* (diff
   * baselines, reconciliation) anchored to fully-applied states only.
   */
  async applyChangeset(
    changeset: {
      /** ParsedRepo.id — kept for symmetry with cross-repo bookkeeping callers. */
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
    const counts = { nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 0 };
    const BATCH_SIZE = 500;
    // Per-transaction row budgets, sized so each committed transaction stays
    // far under the observed ~2MB Turso choke point. Nodes carry properties
    // and summaries (KBs each); edges and metadata rows are far smaller.
    const TXN_NODE_ROWS = 500;
    const TXN_EDGE_ROWS = 2000;
    const TXN_META_ROWS = 1000;

    // Phase clock for options.onPhase (see ApplyChangesetOptions). Each
    // executed phase reports its wall-clock cost as it completes; a phase
    // whose block is skipped reports nothing.
    let phaseStart = Date.now();
    const markPhase = (phase: string) => {
      options?.onPhase?.(phase, Date.now() - phaseStart);
      phaseStart = Date.now();
    };
    // One bounded transaction. The abort check runs between transactions, at
    // committed boundaries — never mid-transaction.
    const inTxn = <T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> => {
      options?.signal?.throwIfAborted();
      return this.driver.withWriteTransaction(fn);
    };

    // 0. Optional full-repository removal, committed before the replacement
    // inserts. A failure between the wipe and the inserts leaves an emptied
    // graph WITHOUT an updated snapshot — reconciliation cannot mistake it
    // for applied, and the retry reapplies the full replacement.
    const repoIdsToDelete = [...new Set(changeset.repoIdsToDelete ?? [])];
    if (repoIdsToDelete.length > 0) {
      await inTxn(async (tx) => {
        const placeholders = repoIdsToDelete.map((_, index) => `@repoId${index}`).join(',');
        const params: Record<string, unknown> = {};
        repoIdsToDelete.forEach((repoId, index) => {
          params[`repoId${index}`] = repoId;
        });
        const ownedNodes = `SELECT id FROM nodes WHERE id IN (${placeholders}) OR repo_id IN (${placeholders})`;
        const edgeRows = await tx.run<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM edges
           WHERE source_id IN (${ownedNodes}) OR target_id IN (${ownedNodes})`,
          params,
        );
        const nodeRows = await tx.run<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM nodes WHERE id IN (${placeholders}) OR repo_id IN (${placeholders})`,
          params,
        );
        counts.edgesDeleted += edgeRows[0]?.cnt ?? 0;
        counts.nodesDeleted += nodeRows[0]?.cnt ?? 0;
        await tx.run(`DELETE FROM edges WHERE source_id IN (${ownedNodes}) OR target_id IN (${ownedNodes})`, params);
        await tx.run(`DELETE FROM nodes WHERE id IN (${placeholders}) OR repo_id IN (${placeholders})`, params);
        await tx.run(`DELETE FROM graph_meta WHERE repo_id IN (${placeholders})`, params);
        await tx.run(`DELETE FROM unresolved_calls WHERE repo_id IN (${placeholders})`, params);
      });
      markPhase('repoWipe');
    }

    // 1. Delete nodes removed by an incremental diff — one transaction per
    // id-batch. All incident edges, including server-derived ones, must go
    // with an absent endpoint; deleted+counted before the selective
    // parser-edge wipe.
    const nodeIdsToDelete = changeset.nodeIdsToDelete.filter(
      (nodeId) => !repoIdsToDelete.some((repoId) => nodeId === repoId || nodeId.startsWith(`${repoId}:`)),
    );
    if (nodeIdsToDelete.length > 0) {
      for (let i = 0; i < nodeIdsToDelete.length; i += BATCH_SIZE) {
        const batch = nodeIdsToDelete.slice(i, i + BATCH_SIZE);
        await inTxn(async (tx) => {
          const placeholders = batch.map((_, j) => `@id${j}`).join(',');
          const params: Record<string, unknown> = {};
          batch.forEach((id, j) => {
            params[`id${j}`] = id;
          });
          const edgeRows = await tx.run<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM edges
             WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
            params,
          );
          counts.edgesDeleted += edgeRows[0]?.cnt ?? 0;
          await tx.run(
            `DELETE FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
            params,
          );
          await tx.run(`DELETE FROM nodes WHERE id IN (${placeholders})`, params);
          counts.nodesDeleted += batch.length;
        });
      }
      markPhase('nodeDelete');
    }

    // 2. Insert/update added and updated nodes, committed every
    // TXN_NODE_ROWS. Progress framing spans the chunks so onBatch reports
    // absolute completion.
    const allUpsertNodes = [...changeset.nodesToAdd, ...changeset.nodesToUpdate];
    if (allUpsertNodes.length > 0) {
      for (let i = 0; i < allUpsertNodes.length; i += TXN_NODE_ROWS) {
        const chunk = allUpsertNodes.slice(i, i + TXN_NODE_ROWS);
        await inTxn((tx) => upsertNodesInTransaction(tx, chunk, options, { offset: i, total: allUpsertNodes.length }));
      }
      counts.nodesAdded = changeset.nodesToAdd.length;
      counts.nodesUpdated = changeset.nodesToUpdate.length;
      markPhase('nodeUpsert');
    }

    // 3. Replace parser-owned edges involving affected nodes — one
    // transaction per id-batch. Server-derived edge kinds (RESOLVES_TO)
    // survive updates to otherwise-stable nodes, so a deferred/concurrent
    // push cannot erase a completed resolver run.
    if (changeset.edgeNodeIdsToWipe.length > 0) {
      const edgeTypesToPreserve = [...new Set(changeset.edgeTypesToPreserve ?? [])];
      for (let i = 0; i < changeset.edgeNodeIdsToWipe.length; i += BATCH_SIZE) {
        const batch = changeset.edgeNodeIdsToWipe.slice(i, i + BATCH_SIZE);
        await inTxn(async (tx) => {
          const placeholders = batch.map((_, j) => `@id${j}`).join(',');
          const params: Record<string, unknown> = {};
          batch.forEach((id, j) => {
            params[`id${j}`] = id;
          });
          const preservedPlaceholders = edgeTypesToPreserve.map((_, j) => `@preservedType${j}`).join(',');
          edgeTypesToPreserve.forEach((type, j) => {
            params[`preservedType${j}`] = type;
          });
          const preserveClause = edgeTypesToPreserve.length > 0 ? ` AND type NOT IN (${preservedPlaceholders})` : '';
          const rows = await tx.run<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM edges
             WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))${preserveClause}`,
            params,
          );
          counts.edgesDeleted += rows[0]?.cnt ?? 0;
          await tx.run(
            `DELETE FROM edges
             WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))${preserveClause}`,
            params,
          );
        });
      }
      markPhase('edgeWipe');
    }

    // 4. Insert new edges, committed every TXN_EDGE_ROWS.
    if (changeset.edgesToInsert.length > 0) {
      for (let i = 0; i < changeset.edgesToInsert.length; i += TXN_EDGE_ROWS) {
        const chunk = changeset.edgesToInsert.slice(i, i + TXN_EDGE_ROWS);
        await inTxn((tx) =>
          upsertEdgesInTransaction(tx, chunk, options, { offset: i, total: changeset.edgesToInsert.length }),
        );
      }
      counts.edgesInserted = changeset.edgesToInsert.length;
      markPhase('edgeInsert');
    }

    // 5. Metadata updates, committed every TXN_META_ROWS.
    const metadataUpdates = changeset.nodeMetadataUpdates ?? [];
    if (metadataUpdates.length > 0) {
      for (let i = 0; i < metadataUpdates.length; i += TXN_META_ROWS) {
        const chunk = metadataUpdates.slice(i, i + TXN_META_ROWS);
        await inTxn((tx) =>
          updateMetadataInTransaction(tx, chunk, options, { offset: i, total: metadataUpdates.length }),
        );
      }
      counts.nodesUpdated += metadataUpdates.length;
      markPhase('metadata');
    }

    // 5b. Unresolved calls — a full replacement of this repo's set (see the
    // changeset field's contract). Not counted in the receipt: they are not
    // graph nodes or edges, and a caller comparing receipt totals to the
    // transform's node/edge counts must keep getting the same numbers.
    if (changeset.unresolvedCalls) {
      await this.replaceUnresolvedCalls(changeset.repoId, changeset.unresolvedCalls, inTxn, options);
      markPhase('unresolvedCalls');
    }

    const receipt: GraphApplyReceipt = {
      ...counts,
      ...(options?.snapshot
        ? {
            totalNodeCount: options.snapshot.totalNodeCount,
            totalEdgeCount: options.snapshot.totalEdgeCount,
          }
        : {}),
    };

    // 6. Applied-snapshot LAST, in its own transaction — the commit that
    // makes the whole sequence count as applied.
    if (options?.snapshot) {
      const snapshotInput = options.snapshot;
      await inTxn(async (tx) => {
        const repoRows = await tx.run<{ id: string }>(
          `SELECT id FROM nodes WHERE id = @repoId AND type = 'repository'`,
          {
            repoId: changeset.repoId,
          },
        );
        if (!repoRows[0])
          throw new Error(`Cannot record graph snapshot: repository node ${changeset.repoId} is missing`);
        const snapshot: AppliedGraphSnapshot = {
          ...snapshotInput,
          nodeCount: snapshotInput.totalNodeCount,
          edgeCount: snapshotInput.totalEdgeCount,
          receipt,
          appliedAt: new Date().toISOString(),
        };
        const encoded = JSON.stringify(snapshot);
        await tx.run(
          `INSERT INTO graph_meta(repo_id, snapshot) VALUES (@repoId, @snapshot)
           ON CONFLICT(repo_id) DO UPDATE SET snapshot = excluded.snapshot`,
          { repoId: changeset.repoId, snapshot: encoded },
        );
        const verify = await tx.run<{ snapshot: string }>(`SELECT snapshot FROM graph_meta WHERE repo_id = @repoId`, {
          repoId: changeset.repoId,
        });
        if (verify[0]?.snapshot !== encoded) throw new Error(`Failed to verify graph snapshot for ${changeset.repoId}`);
      });
      markPhase('snapshot');
    }

    // No closure rebuild: `getCallers` and `getReachingEntrypoints` walk the
    // edges table directly via recursive CTE (see those methods).

    // Refresh planner statistics: without sqlite_stat1 the optimizer picks a
    // full-CALLS-scan join order for the recursive caller CTEs (measured 81s
    // vs 46ms on a 5x graph — Phase 0 bench, 2026-08-10). Local file mode
    // only: over the remote libsql path ANALYZE would be a heavyweight
    // statement on exactly the degraded transport this is not needed for.
    // Intentional fallback: the changeset is already applied and consistent
    // at this point, so a stats failure must not fail the push — warn and go.
    const drv = this.driver as IDatabaseDriver & { isLocalFile?: () => boolean };
    if (drv.isLocalFile?.()) {
      try {
        await this.driver.withWriteTransaction((tx) => tx.run('ANALYZE'));
        markPhase('analyze');
      } catch (err) {
        console.warn(`[coredoc/db] ANALYZE after applyChangeset failed (stats stale, data intact): ${String(err)}`);
      }
    }

    return receipt;
  }

  // -------------------------------------------------------------------------
  // Delete Operations
  // -------------------------------------------------------------------------

  /**
   * Rewrite one repo's unresolved-call rows. Deletes the repo's stored set
   * then re-inserts `records` in TXN_UNRESOLVED_ROWS-row outer transactions,
   * each routed through insertUnresolvedCallsInTransaction's StatementBatcher
   * for the transport-level (row-count + byte-size) bound — see that
   * function's comment for why.
   */
  private async replaceUnresolvedCalls(
    repoId: string,
    records: readonly UnresolvedCallRecord[],
    inTxn: <T>(fn: (tx: ITransaction) => Promise<T>) => Promise<T>,
    options?: ApplyChangesetOptions,
  ): Promise<void> {
    const TXN_UNRESOLVED_ROWS = 2000;
    await inTxn((tx) => tx.run('DELETE FROM unresolved_calls WHERE repo_id = @repoId', { repoId }));
    for (let i = 0; i < records.length; i += TXN_UNRESOLVED_ROWS) {
      const chunk = records.slice(i, i + TXN_UNRESOLVED_ROWS);
      await inTxn((tx) =>
        insertUnresolvedCallsInTransaction(tx, repoId, chunk, options, { offset: i, total: records.length }),
      );
    }
  }

  async deleteRepository(repoId: string): Promise<void> {
    await this.driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `
        DELETE FROM edges
        WHERE source_id IN (SELECT id FROM nodes WHERE repo_id = @repoId)
           OR target_id IN (SELECT id FROM nodes WHERE repo_id = @repoId)
      `,
        { repoId },
      );

      await tx.run('DELETE FROM nodes WHERE repo_id = @repoId', { repoId });
      await tx.run('DELETE FROM nodes WHERE id = @repoId', { repoId });
      await tx.run('DELETE FROM graph_meta WHERE repo_id = @repoId', { repoId });
      await tx.run('DELETE FROM unresolved_calls WHERE repo_id = @repoId', { repoId });
    });
  }
}
