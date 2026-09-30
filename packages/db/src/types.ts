/**
 * Database Abstraction Layer Types
 *
 * Core interfaces for database-agnostic graph operations.
 * Supports Neo4j and SQLite backends.
 */

import type {
  AnalysisRecord,
  CallResolutionStats,
  DbOpResolutionStats,
  EntrypointType,
  HttpMethod,
  DbOperationType,
  Visibility,
  EntityField,
  EntityRelation,
  EntityIndex,
  EnumMember,
  FunctionNode,
} from '@coredoc/core/types';
// Graph storage vocabulary — single source of truth in @coredoc/core; imported for local
// use and re-exported below so existing `@coredoc/db` importers are unaffected.
// NodeType/EdgeType are enums (runtime values), so they are value imports/exports.
import { EdgeType, NodeType } from '@coredoc/core';
import type { GraphEdge, GraphNode, ResolvesEdgeInfo } from '@coredoc/core';
// Visualization DTOs (Tier B explorer) — the wire contract the `modules/graph`
// REST layer and `apps/web` share. Imported here so the id-centric neighbor
// queries return the viz shapes directly.
import type {
  VizNode,
  VizEdge,
  NeighborCount,
  EdgeDirection,
  VizNodePage,
  DeadCodePage,
  CypherGraphResult,
} from '@coredoc/core';

// =============================================================================
// Backend Configuration
// =============================================================================

export type DatabaseBackend = 'neo4j' | 'sqlite' | 'ladybug';
export type ProjectFileBackend = Exclude<DatabaseBackend, 'neo4j'>;

export interface DatabaseConfig {
  backend: DatabaseBackend;
  // Neo4j specific
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  // SQLite specific
  sqliteUrl?: string;
  sqliteAuthToken?: string;
}

// =============================================================================
// Transaction Interface
// =============================================================================

/**
 * Abstract transaction interface used by both backends.
 * For Neo4j, this wraps ManagedTransaction.
 * For SQLite, this wraps the synchronous transaction mechanism.
 */
export interface ITransaction {
  /**
   * Execute a query and return results.
   * @param query - Query string (Cypher for Neo4j, SQL for SQLite)
   * @param params - Query parameters
   */
  run<T = unknown>(query: string, params?: Record<string, unknown>): Promise<T[]>;

  /**
   * Execute write statements in order using one transport batch when the
   * backend supports it. The surrounding transaction still owns commit and
   * rollback. Callers must fall back to ordered run() calls when absent.
   */
  runBatch?(statements: readonly TransactionStatement[]): Promise<void>;
}

export interface TransactionStatement {
  query: string;
  params?: Record<string, unknown>;
}

export type BatchProgressKind = 'nodes' | 'edges' | 'metadata' | 'unresolvedCalls';

export interface BatchProgress {
  kind: BatchProgressKind;
  completed: number;
  total: number;
}

export enum GraphApplyMode {
  Full = 'full',
  Incremental = 'incremental',
  Metadata = 'metadata',
}

export interface GraphApplyReceipt {
  nodesAdded: number;
  nodesUpdated: number;
  nodesDeleted: number;
  edgesDeleted: number;
  edgesInserted: number;
  totalNodeCount?: number;
  totalEdgeCount?: number;
}

export interface GraphSnapshotInput {
  parsedVersion: string;
  summaryVersion: string | null;
  embeddingsVersion: string | null;
  commitSha: string | null;
  totalNodeCount: number;
  totalEdgeCount: number;
  mode: GraphApplyMode;
  executionToken: string;
}

export interface AppliedGraphSnapshot extends GraphSnapshotInput {
  nodeCount: number;
  edgeCount: number;
  receipt: GraphApplyReceipt;
  appliedAt: string;
}

export interface NodeMetadataUpdate {
  id: string;
  summary?: string;
  embedding?: number[];
  properties: Record<string, unknown>;
}

export interface ApplyChangesetOptions {
  snapshot?: GraphSnapshotInput;
  signal?: AbortSignal;
  onBatch?: (progress: BatchProgress) => void;
  /**
   * Called as each apply phase completes with its wall-clock duration.
   * Diagnostic seam: unlike onBatch (upsert flushes only), this fires for
   * every phase — including the delete phases, which emit no batch progress —
   * so a connection death mid-apply leaves a trail of completed phases.
   */
  onPhase?: (phase: string, elapsedMs: number) => void;
}

// =============================================================================
// Driver Interface
// =============================================================================

/**
 * Database driver interface for connection and transaction management.
 */
export interface IDatabaseDriver {
  /** Which backend this driver uses */
  readonly backend: DatabaseBackend;

  /**
   * Initialize the driver (connect, run migrations, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close the driver and release resources.
   */
  close(): Promise<void>;

  /**
   * Execute a function within a read transaction.
   * @param fn - Function to execute with transaction
   */
  withReadTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T>;

  /**
   * Execute a function within a write transaction.
   * @param fn - Function to execute with transaction
   */
  withWriteTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T>;

  /**
   * Execute batch operations with automatic chunking.
   * @param items - Items to process
   * @param handler - Handler function for each batch
   * @param batchSize - Optional batch size (default: 500)
   */
  executeBatch<T>(
    items: T[],
    handler: (batch: T[], tx: ITransaction) => Promise<void>,
    batchSize?: number,
  ): Promise<number>;
}

// =============================================================================
// Unified Graph Node/Edge Types
// =============================================================================

// Re-export the graph storage vocabulary (defined in @coredoc/core, imported above) so
// existing `@coredoc/db` importers (mcp, cli) keep resolving these from '@coredoc/db'.
// NodeType/EdgeType are enums (runtime values), re-exported as values.
export { NodeType, EdgeType };
export type { GraphNode, GraphEdge, ResolvesEdgeInfo };

// =============================================================================
// Query Result Types
// =============================================================================

/**
 * Code element returned from find_code queries.
 */
export interface CodeElement {
  id: string;
  name: string;
  type: NodeType;
  filePath: string;
  startLine: number;
  endLine?: number;
  summary?: string;
  /** AI-generated one-line purpose, if present (concise — good for list output). */
  purpose?: string;
  /** Raw source body — populated only when findCode is called with includeSource. */
  sourceCode?: string;
}

/**
 * Function node with all properties.
 */
export interface FunctionInfo {
  id: string;
  versionedId?: string;
  name: string;
  kind: 'function' | 'method';
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isAsync: boolean;
  isGenerator?: boolean;
  isExported?: boolean;
  classId?: string;
  className?: string;
  visibility?: Visibility;
  isStatic?: boolean;
  isAbstract?: boolean;
  complexity?: number;
  documentation?: string;
  summary?: string;
  purpose?: string;
  businessLogic?: string;
  sideEffects?: string;
  /** Raw source body — present only when ALLOW_SOURCES_IN_GRAPH stored it. */
  sourceCode?: string;
  /** SCIP package moniker for SDK-method symbol-hop join. */
  moniker?: { packageName: string; descriptor: string };
  /**
   * Present when the substrate synthesized this node from a declaration convention (e.g. a
   * Rails association reader) rather than a `def`; names the convention. Absent on declared code.
   */
  synthesized?: FunctionNode['synthesized'];
}

/**
 * Class node with all properties.
 */
/**
 * A class property (field), as persisted in the class node's `properties_`
 * array by the transformer. Backs DTO/class field introspection.
 */
export interface ClassPropertyInfo {
  name: string;
  visibility?: Visibility;
  isStatic?: boolean;
  isReadonly?: boolean;
  isOptional?: boolean;
  /** Declared type, as text. */
  typeText?: string;
  defaultValue?: string;
  startLine?: number;
}

/**
 * An interface member (property or method signature), as persisted in the
 * interface node's `members` array by the transformer.
 */
export interface InterfaceMemberInfo {
  name: string;
  kind: 'property' | 'method' | 'index';
  isOptional?: boolean;
  isReadonly?: boolean;
  /** Declared type, as text (for properties). */
  typeText?: string;
  /** Return type, as text (for methods). */
  returnTypeText?: string;
  startLine?: number;
}

export interface ClassInfo {
  id: string;
  versionedId?: string;
  name: string;
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAbstract: boolean;
  extendsName?: string;
  extendsId?: string;
  documentation?: string;
  /**
   * Declared properties (fields), each with its type text and flags. Optional
   * and backwards-compatible: present for graphs that persisted them.
   */
  properties?: ClassPropertyInfo[];
}

/**
 * Interface node with all properties.
 */
export interface InterfaceInfo {
  id: string;
  versionedId?: string;
  name: string;
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  documentation?: string;
  /**
   * Declared members (properties + method signatures). Optional and
   * backwards-compatible: present for graphs that persisted them.
   */
  members?: InterfaceMemberInfo[];
}

export interface EnumInfo {
  id: string;
  versionedId?: string;
  name: string;
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isConst?: boolean;
  documentation?: string;
  /**
   * Enum members with their values. Optional and backwards-compatible: present
   * for graphs parsed after enum-member persistence landed (re-parse to populate
   * older graphs).
   */
  members?: EnumMember[];
}

export interface TypeAliasInfo {
  id: string;
  versionedId?: string;
  name: string;
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  documentation?: string;
  /** The aliased type, as text (e.g. `{ a: string; b: number }` or `'a' | 'b'`). */
  aliasedTypeText?: string;
}

/**
 * Entrypoint node with all properties.
 */
export interface EntrypointInfo {
  id: string;
  versionedId?: string;
  type: EntrypointType;
  handlerId: string;
  handlerName?: string;
  method?: HttpMethod;
  path?: string;
  fullPath?: string;
  fieldName?: string;
  operationType?: 'query' | 'mutation' | 'subscription';
  schedule?: string;
  topic?: string;
  /** Runtime queue topic when `topic` is a source-level token. */
  topicValue?: string;
  eventName?: string;
  /** Messaging system (queue system or event emitter). Missing is legacy/unknown. */
  system?: string;
  /** Canonical queue/event destination token. */
  destination?: string;
  /** Runtime destination when statically resolved. */
  destinationValue?: string;
  command?: string;
  /** Mobile entrypoint address: the component class simple name. */
  className?: string;
  /**
   * Mobile entrypoint taxonomy (launcher, deep-link, push, broadcast, …). A
   * label, deliberately NOT an address token: `pathPattern: 'push'` must not
   * match every push handler in the repo.
   */
  trigger?: string;
  filePath: string;
  startLine: number;
  endLine?: number;
  documentation?: string;
  summary?: string;
  purpose?: string;
}

/**
 * Entity node with all properties.
 */
export interface EntityInfo {
  id: string;
  versionedId?: string;
  name: string;
  fileId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  ormType: string;
  tableName: string;
  schema?: string;
  documentation?: string;
  /**
   * Full DB structure — columns, relations, and indexes — persisted in the
   * entity node's `properties` blob. Optional and backwards-compatible: present
   * for graphs parsed after entity-schema persistence landed; `undefined` for
   * older graphs (re-parse + re-push to populate). `indexes` is populated only
   * by ORM paths that expose them (e.g. ActiveRecord via schema.rb).
   */
  fields?: EntityField[];
  relations?: EntityRelation[];
  indexes?: EntityIndex[];
}

/**
 * Caller information with distance.
 */
export interface CallerInfo {
  id: string;
  name: string;
  kind: 'function' | 'method';
  filePath: string;
  startLine: number;
  endLine?: number;
  className?: string;
  summary?: string;
  purpose?: string;
  visibility?: Visibility;
  isAsync?: boolean;
  /** Distance from target (1 = direct caller, 2+ = transitive) */
  distance: number;
  /** Line where call occurs (for direct callers) */
  callSiteLine?: number;
  /** Whether the call is async */
  isAsyncCall?: boolean;
  /**
   * The edge reaching this caller was INFERRED, not proven.
   *
   * Set from the CALLS edge's `provenanceInferred` property, which the
   * transformer stamps for heuristic provenances (`iface-impl` — bound to the
   * sole declared implementation of an interface). `CallProvenance` requires
   * consumers to render such an edge as inferred; without this projection the
   * flag was written and never read, so a heuristic guess reached agents looking
   * exactly like a compiler-proven SCIP edge.
   *
   * On a TRANSITIVE caller it means "at least one hop in the shortest chain was
   * inferred" — a chain is only as proven as its weakest edge.
   */
  provenanceInferred?: true;
  /**
   * Read from the CALLER function node's `synthesized` property: the caller is a
   * function the substrate synthesized from a declaration convention (e.g. a Rails
   * association reader), not one written in the file. Absent on declared code.
   */
  synthesized?: FunctionNode['synthesized'];
}

/**
 * Call tree node for hierarchical display.
 */
export interface CallTreeNode {
  id: string;
  name: string;
  kind: 'function' | 'method';
  filePath: string;
  startLine: number;
  className?: string;
  summary?: string;
  depth: number;
}

/**
 * Entity consumer information.
 */
export interface EntityConsumer {
  id: string;
  name: string;
  kind: 'function' | 'method';
  filePath: string;
  startLine: number;
  className?: string;
  operation: DbOperationType;
}

/**
 * A consumer of a type (class/interface/type_alias/enum) — populated from
 * USES_TYPE edges emitted by the transformer.
 */
export type TypeUsageKind =
  | 'parameter'
  | 'return'
  | 'property'
  | 'interface-member'
  | 'aliased'
  | 'extends'
  | 'implements'
  | 'import'
  /** Value-position access to an enum member (`Status.Locked`) — see {@link TypeUseKind}. */
  | 'member-access'
  /** Value-position construction of a class (`new UserService(...)`). */
  | 'construction';

/**
 * Which half of a type-bearing declaration a consumer touches. A consumer that
 * annotates with the type breaks on a shape change; a consumer that compares
 * against one enum member is the one an added member silently bypasses — the
 * two answer different impact questions, so they must be distinguishable.
 */
export enum TypeUseKind {
  /** Type position: annotation, extends/implements, alias right-hand side. */
  Type = 'type',
  /** Value position: a reference to a specific enum member. */
  Value = 'value',
}

export interface TypeUsage {
  /** Source element ID (the thing that uses the type) */
  id: string;
  /** Source element name */
  name: string;
  /** Source element node type */
  type: NodeType;
  filePath: string;
  startLine: number;
  endLine?: number;
  /** How the source uses the type */
  usage: TypeUsageKind;
  /** Parameter / property / member name (when applicable) */
  via?: string;
  /**
   * Type- vs value-position use. Absent on edges stored before the distinction
   * existed, and on substrates that do not detect value-position references —
   * absent means "type-level or undetermined", never "certainly type-level".
   */
  useKind?: TypeUseKind;
  /** Enum member referenced in value position (set only with `useKind: 'value'`). */
  member?: string;
  /** Whether the name resolution was ambiguous at parse time */
  ambiguous: boolean;
}

/**
 * Repository overview statistics.
 */
export interface RepoOverview {
  name: string;
  type: string;
  parsedAt: string;
  fileCount: number;
  functionCount: number;
  classCount: number;
  entityCount: number;
  entrypointTypes: string[];
  summary?: string;
  dataModel?: string;
  externalIntegrations?: string[];
  /** The `origin` remote URL (the "git link"), if captured at parse time. */
  gitRemoteUrl?: string;
  /**
   * Parser version that produced this snapshot (`1.1.0`, `1.1.0-python`, …).
   * Absent for graphs pushed before it was projected. Consumers use it to tell a
   * graph that predates a schema change from one that is merely empty.
   */
  parserVersion?: string;
  /**
   * The commit this snapshot was parsed at, if captured at parse time. Absent
   * for a repo parsed outside git, and for any graph pushed before this field
   * was carried — a consumer asking "does the graph see my base?" gets no
   * answer rather than a wrong one.
   */
  gitCommitHash?: string;
}

/**
 * Minimal repository identity for discovery. Lighter than {@link RepoOverview}
 * — meant for "what scopes can I query?" listings, not per-repo deep dives.
 */
export interface RepoSummary {
  /** Repo name (matches the `scope` argument accepted by other tools). */
  name: string;
  /** Repo hash (12-char prefix used in node IDs). */
  hash: string;
  /** Declared repo type (backend / frontend / mobile / monorepo / etc.), or 'unknown'. */
  type: string;
  /** ISO timestamp of last parse, or '' if missing. */
  parsedAt: string;
  /** AI-generated one-line summary, if present. */
  summary?: string;
}

/**
 * A node carrying a stored embedding vector, with the provenance props needed
 * to embed a query with the SAME provider/model. Only function and entrypoint
 * nodes get embeddings (see transformer.mergeEmbeddings). Backs the MCP
 * `semantic_search` tool's brute-force cosine ranking — no vector index; at
 * repo scale a full scan is cheap and keeps both backends trivial.
 */
export interface EmbeddedNode {
  /** Stable node ID */
  id: string;
  /** Symbol name */
  name: string;
  /** Node kind (function or entrypoint) */
  type: NodeType;
  /** File path relative to repo */
  filePath: string;
  /** Declaration line */
  startLine: number;
  /** AI-generated summary, when stored */
  summary?: string;
  /** The stored embedding vector */
  embedding: number[];
  /** Provider that generated the vector ('ollama' | 'openrouter'), per-node provenance */
  embeddingProvider?: string;
  /** Model that generated the vector, per-node provenance */
  embeddingModel?: string;
}

/** Result of {@link IGraphRepository.getEdgesAmong}. */
export interface EdgesAmongResult {
  edges: VizEdge[];
  /** The induced edge set was larger than the requested limit. */
  truncated: boolean;
}

/**
 * Per-repo raw counts backing extraction-coverage reporting (the MCP
 * `get_extraction_coverage` tool and the caveats on empty impact results). Pure
 * counting: every field is a count of nodes or edges the graph holds.
 */
export interface RepoCoverageCounts {
  /** Repo name (matches the `scope` argument accepted by other tools). */
  repoName: string;
  /**
   * Raw node counts keyed by NodeType string value ('function', 'entity',
   * 'external_call', …). The repository node itself is excluded.
   */
  nodeCountsByType: Record<string, number>;
  /** Entities in the repo. */
  entityCount: number;
  /** Entities that are the target of at least one OPERATES_ON edge. */
  entitiesWithDbOps: number;
  /** Functions in the repo. */
  functionCount: number;
  /** Functions with at least one outgoing CALLS edge. */
  functionsWithCalls: number;
  /** external_call nodes in the repo. */
  externalCallCount: number;
  /**
   * external_call nodes with at least one outgoing RESOLVES_TO edge. Counted
   * from the edge — the durable resolution signal — not the denormalized
   * `resolvedTargetId` node property, which a re-push can clobber.
   */
  resolvedExternalCallCount: number;
  /**
   * In-repo call resolution as the parser measured it. Present only when the
   * Repository node carries all three numbers (written by a parser that
   * measured); absent means not measured — never zero.
   */
  callResolution?: CallResolutionStats;
  analysis?: AnalysisRecord[];
  /**
   * DB-operation resolution as the parser measured it. Present only when the Repository node
   * carries all three numbers; absent means not measured — never zero.
   */
  dbOpResolution?: DbOpResolutionStats;
}

/**
 * Execution path step.
 */
export interface PathStep {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  summary?: string;
  classId?: string;
}

/**
 * External call information (cross-repo calls).
 * Represents an ExternalCall node stored in the database.
 */
export interface ExternalCallInfo {
  /** External call node ID */
  id: string;
  /** Caller function ID */
  callerId: string;
  /** Caller function name */
  callerName: string;
  /** Caller file path */
  callerFilePath: string;
  /** Target service name (e.g., 'order-service') */
  serviceName: string;
  /**
   * Parser-emitted canonical target service hint (e.g., 'walle' for a call
   * whose `serviceName` is the client class 'sampleApiClient'). Mapper engine
   * uses this as source of truth when present; `fromTurso` falls back to
   * `serviceName` when undefined (legacy rows or parsers that didn't set it).
   */
  targetService?: string;
  /** SDK name if applicable */
  sdkName?: string;
  /** Method being called */
  method: string;
  /** Persisted protocol. Queue/event producers use messaging. */
  protocol: 'http' | 'messaging' | 'grpc' | 'graphql' | 'ipc' | 'internal';
  /** HTTP method (for HTTP protocol) */
  httpMethod?: string;
  /** Path template (for HTTP protocol) */
  pathTemplate?: string;
  /** Canonical messaging system. */
  messagingSystem?: string;
  /** Runtime messaging/IPC destination. */
  messagingDestination?: string;
  /** Source token/reference for the destination. */
  messagingDestinationRef?: string;
  /** IPC direction when protocol is ipc. */
  ipcDirection?: string;
  /** gRPC service name (for gRPC protocol) */
  grpcService?: string;
  /** gRPC method name (for gRPC protocol) */
  grpcMethod?: string;
  /** GraphQL operation type */
  graphqlOperationType?: string;
  /** GraphQL operation name */
  graphqlOperationName?: string;
  /** SCIP package moniker (consumer side) — the cross-repo symbol-hop join key */
  moniker?: { packageName: string; descriptor: string };
  /**
   * Dynamic-dispatch SDK method name (e.g. `performApiRequest('listResources')`).
   * When set, `method` holds the wrapper verb; the cross-repo sdkMapping fallback keys
   * its `(sdkName, method)` lookup off this. Unset for ordinary calls.
   */
  dispatchMethod?: string;
  /** Resolved target entrypoint ID (if cross-repo linked) */
  resolvedTargetId?: string;
  /**
   * Name of the repository that owns the `RESOLVES_TO` target, derived at read
   * time from the persisted `resolvedTargetId`. Absent when the call is
   * unresolved — a language whose profile cannot name the callee service
   * (Swift/Kotlin clients) then still gets a real target name from the link.
   */
  resolvedTargetRepoName?: string;
  /** Source file path where call occurs */
  filePath: string;
  /** Line number where call occurs */
  startLine: number;
}

/**
 * Narrow projection of an external_call node that publishes to a messaging
 * destination. Backed by a destination-filtered query so tracing does not
 * materialize the full external-call row set.
 */
export interface MessagingExternalCall {
  /** External call node ID */
  id: string;
  /** Caller function name */
  callerName: string;
  /** Source file path where call occurs */
  filePath: string;
  /** Line number where call occurs */
  startLine: number;
  /** Messaging system. Missing means the graph predates messaging descriptors. */
  system?: string;
  /** Runtime destination used for producer/consumer joins. */
  destination: string;
  /** Source token/reference when different from the runtime destination. */
  destinationRef?: string;
}

/**
 * A call site the parser extracted but could NOT resolve to a callee — the
 * place where the static graph stops (`this.client.emit(topicFor(x))`,
 * `handlers[kind]()`). Stored alongside the graph, never as an edge: there is
 * no callee to point at, and presenting one would fabricate a relationship.
 */
export interface UnresolvedCallRecord {
  /** Symbol id of the calling function/method (ParsedRepo callerId). */
  callerId: string;
  /** Normalized callee expression, single-line, length-capped. */
  calleeExpression: string;
  /**
   * Trailing member/identifier name of the callee, precomputed at write time so
   * a name lookup is an indexed equality match instead of a LIKE scan. `null`
   * when the expression has no static tail (e.g. `logger[logLevel]`).
   */
  calleeNameTail: string | null;
  filePath: string;
  line: number;
}

export interface UnresolvedCallQueryOptions {
  /** Maximum rows to return, applied after the deterministic (filePath, line) ordering. */
  limit?: number;
}

/**
 * Minimal repository identity row: the node-id hash prefix and the repo name.
 * Backs batched hash→name resolution (getRepositoryNames) — lighter than
 * {@link RepoOverview}, which computes per-repo counts.
 */
export interface RepoNameRow {
  /** Repo hash (12-char prefix used in node IDs). */
  hash: string;
  /** Repo name. */
  name: string;
  /**
   * Parser version that produced this snapshot (`1.1.0`, `1.1.0-python`, …), read
   * straight off the repository node. Same value {@link RepoOverview} carries, but
   * without its per-repo count subqueries — a consumer that needs only the schema
   * generation (messaging staleness) must not pay for the counts.
   */
  parserVersion?: string;
}

// =============================================================================
// Query Parameters
// =============================================================================

export interface FindCodeParams {
  pattern: string;
  types?: NodeType[];
  limit?: number;
  /**
   * When true, `variable` rows are filtered to `isExported = true`. Used by
   * the MCP `search_symbols` "all" pathway: variables are 5–20% the node count
   * and dominated by internal helpers, so we surface only the exported subset
   * (Kea logics, models, library exports) when mixed with other kinds.
   * No effect when `types` does not include 'variable'.
   */
  exportedVariablesOnly?: boolean;
  /**
   * Project each row's raw source body (`sourceCode`). Off by default so the
   * search hot path is unchanged; the column is only selected when set. Source is
   * only present in the graph when it was stored at push time (ALLOW_SOURCES_IN_GRAPH).
   */
  includeSource?: boolean;
}

export interface ListEntrypointsParams {
  type?: EntrypointType;
  pathPattern?: string;
  /** Normalized messaging system; reserved `unknown` selects systemless legacy rows. */
  system?: string;
  limit?: number;
  /**
   * Filter by exact entrypoint ID. Used to look up the downstream entrypoint
   * referenced by an external_call's `resolvedTargetId`. Combine with empty
   * repoHashes (`[]`) to search across all parsed repos.
   */
  id?: string;
}

export interface PackageInfo {
  /**
   * The package node id (`{repoHash}:package:{path}:{name}`). Optional so older
   * neo4j returns continue to type-check; both backends now populate it. Used by
   * the C4 builder to key package containers and match dependency-rollup edges.
   */
  id?: string;
  name: string;
  path: string;
  type?: string;
  language?: string;
  description?: string;
  /**
   * Hash of the repo this package belongs to (12-char prefix used in node
   * IDs). Optional so older neo4j returns continue to type-check; the
   * SQLite handler returns it unconditionally. Used by `describe_repository`
   * to derive repo types from packages and to render per-repo package
   * lists in the monorepo section.
   */
  repoId?: string;
}

export interface PackageLinkerImportedName {
  name: string;
  alias?: string;
}

export interface PackageLinkerImportInfo {
  id: string;
  moduleSpecifier: string;
  isTypeOnly: boolean;
  importKind: 'named' | 'default' | 'namespace' | 'side-effect';
  importedNames: PackageLinkerImportedName[];
}

export interface PackageLinkerFileInfo {
  id: string;
  path: string;
  packageId: string;
  target?: string;
  imports: PackageLinkerImportInfo[];
}

export type PackageLinkerDeclarationKind = 'class' | 'interface' | 'type_alias' | 'enum' | 'function' | 'variable';

export interface PackageLinkerDeclarationInfo {
  id: string;
  name: string;
  fileId: string;
  kind: PackageLinkerDeclarationKind;
  isExported: true;
}

/** Minimal persisted facts needed to rebuild cross-repo package-import linker inputs. */
export interface PackageLinkerFacts {
  files: PackageLinkerFileInfo[];
  declarations: PackageLinkerDeclarationInfo[];
}

// =============================================================================
// Graph Visualization Queries (Tier B — explorer)
// =============================================================================

/**
 * Parameters for a single depth-1 neighbor expansion in the graph explorer.
 * Deep traversal is repeated expansion, never one request — there is no depth
 * parameter by design (see docs/web-ui-plan-2026-07.md §3.2, Tier B).
 */
export interface GetNeighborsParams {
  /**
   * Which side of the focus node to expand. `out` = edges where the focus is
   * the source, `in` = edges where it is the target, `both` = union. Defaults
   * to `both` when omitted.
   */
  direction?: EdgeDirection | 'both';
  /** Restrict to these edge kinds. Omit/empty = all edge kinds. */
  edgeTypes?: EdgeType[];
  /** Hard cap on neighbors returned in this page (clamped ≤ 200 by the caller). */
  limit: number;
  /** Opaque keyset cursor from a prior page's `nextCursor` — resume after it. */
  cursor?: string;
}

/**
 * One page of a neighbor expansion. `nodes` are the freshly reached neighbors
 * (deduped within the page); `edges` are the connecting edges, preserving their
 * true source→target orientation (not focus-relative).
 */
export interface NeighborsResult {
  nodes: VizNode[];
  edges: VizEdge[];
  /** Keyset cursor for the next page of this same expansion, when more remain. */
  nextCursor?: string;
  /** True when the page hit `limit` and more neighbors exist. */
  truncated: boolean;
}

/**
 * Parameters for a bounded depth-N subgraph walk from a focus node (the
 * click-to-traverse feature). Unlike {@link GetNeighborsParams} this is one
 * server-side recursive walk, not repeated depth-1 expansion.
 */
export interface SubgraphParams {
  /** How many hops out from the root to walk. Clamped ≤ 5 by the caller. */
  depth: number;
  /**
   * Which side(s) of each hop to follow. `out` = downstream (source→target),
   * `in` = upstream, `both` = either. Defaults to `both` when omitted.
   */
  direction?: EdgeDirection | 'both';
  /**
   * Restrict the walk to these edge kinds. Omit → the impl applies a *flow*
   * default set (CALLS/HANDLES/MAKES_EXTERNAL_CALL/RESOLVES_TO/REFERENCES_VARIABLE)
   * so a bare traverse never explodes on structural `CONTAINS_*` / `USES_TYPE`.
   */
  edgeTypes?: EdgeType[];
  /** Hard cap on total nodes returned (clamped ≤ 200 by the caller). */
  nodeCap: number;
}

/**
 * Parameters for the dead-code (unreferenced node) scan. Keyset-paginated by
 * node id like {@link IGraphRepository.listNodesByType}.
 */
export interface DeadCodeParams {
  /** Node kinds to scan. Defaults to `[function, class]` when omitted/empty. */
  types?: NodeType[];
  /** Hard cap on candidates returned in this page (clamped ≤ 200 by the caller). */
  limit: number;
  /** Opaque keyset cursor from a prior page's `nextCursor` — resume after it. */
  cursor?: string;
}

/**
 * Parameters for the cross-repo bridge query — the materialized
 * `MAKES_EXTERNAL_CALL → RESOLVES_TO → HANDLES` links between repos.
 */
export interface CrossRepoBridgeParams {
  /**
   * When set, keep only bridges whose external-call side OR entrypoint side is
   * one of these repo hashes (the "bridges touching repo X" filter). Omit =
   * every cross-repo bridge in scope.
   */
  focusRepoHashes?: string[];
  /** Hard cap on the number of bridges returned (clamped by the caller). */
  limit: number;
}

// =============================================================================
// Graph Visualization Queries (Tier C — C4 architecture view)
// =============================================================================

/**
 * One aggregated inter-package dependency — every function→function CALLS edge
 * whose endpoints resolve to two different packages, rolled up by package pair.
 * Package membership is resolved in SQL/Cypher via function→file (`fileId`) →
 * file's `packageId`, so the result set is tiny (package pairs, not edges) even
 * on a 100k-node repo. Backs the C4 L2 container-relationship edges.
 */
export interface PackageDependencyRollup {
  sourcePackageId: string;
  sourcePackageName: string;
  targetPackageId: string;
  targetPackageName: string;
  /** Number of underlying CALLS edges collapsed into this package pair. */
  callCount: number;
  /** Weakest confidence across the aggregated edges. */
  minConfidence: number;
  /** True when any aggregated edge was AI-inferred (createdBy !== 'parser'). */
  inferred: boolean;
}

/** A component-level node (entrypoint / component / class / state store). */
export interface ComponentGraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath: string | null;
  startLine: number | null;
  summary?: string;
}

/** An edge between two component-level nodes, projected for the C4 view. */
export interface ComponentGraphEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  confidence: number;
  createdBy: 'parser' | 'ai' | 'human';
}

/**
 * The component-level slice of the graph for a repo — the architectural nodes
 * (entrypoints, components, classes, state stores) plus the edges among them.
 * Bounded by the component count (far smaller than the function count), so the
 * C4 builder attributes each node to a package by `filePath` and caps per view.
 */
export interface ComponentGraphData {
  nodes: ComponentGraphNode[];
  edges: ComponentGraphEdge[];
}

// =============================================================================
// Repository Interface
// =============================================================================

/**
 * Optional opaque identity for short-lived read facades that represent the
 * same underlying graph capability. Consumers may key read-only memoization on
 * this token without gaining access to the concrete repository or driver.
 */
export const GRAPH_READ_CAPABILITY_IDENTITY = Symbol.for('@coredoc/db/graph-read-capability-identity');

/**
 * Backend-neutral graph read capability.
 *
 * Serving paths should depend on this interface so a read-only graph handle
 * cannot be passed to code that mutates the artifact.
 */
export interface IGraphReadRepository {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Find code elements by name pattern.
   */
  findCode(params: FindCodeParams, repoHashes: string[]): Promise<CodeElement[]>;

  /**
   * List every named symbol declared in a single file, ordered by start line.
   * Matches `filePath` exactly or by trailing path segment, so callers can pass
   * a full repo-relative path or just the distinctive tail. Filtered to
   * `repoHashes`. Returns all node kinds present in the file.
   */
  listSymbolsInFile(filePath: string, repoHashes: string[]): Promise<CodeElement[]>;

  /**
   * Find a function by name. When `className` is provided, only methods of a
   * class with that name (matched on the class node, not the function's
   * properties) are considered — required to disambiguate "Foo.bar" vs
   * "Baz.bar" inputs from MCP callers. `fileHint` further narrows by path.
   */
  findFunction(name: string, repoHashes: string[], fileHint?: string, className?: string): Promise<FunctionInfo | null>;

  /**
   * Find a class by name.
   */
  findClass(name: string, repoHashes: string[]): Promise<ClassInfo | null>;

  /**
   * Find an interface by name.
   */
  findInterface(name: string, repoHashes: string[]): Promise<InterfaceInfo | null>;

  /**
   * Find an enum by name, with its members (values).
   */
  findEnum(name: string, repoHashes: string[]): Promise<EnumInfo | null>;

  /**
   * Find a type alias by name, with its aliased type text.
   */
  findTypeAlias(name: string, repoHashes: string[]): Promise<TypeAliasInfo | null>;

  /**
   * Find an entity by name or table name.
   */
  findEntity(name: string, repoHashes: string[]): Promise<EntityInfo | null>;

  /**
   * List all entities (data models) in scope, each with full DB structure
   * (columns, relations, indexes). Backs the describe_db_schema MCP tool's
   * whole-schema dump.
   */
  listEntities(repoHashes: string[]): Promise<EntityInfo[]>;

  /**
   * List entrypoints with optional filtering.
   */
  listEntrypoints(params: ListEntrypointsParams, repoHashes: string[]): Promise<EntrypointInfo[]>;

  /**
   * Get repository overview statistics.
   */
  getRepoOverview(repoHashes: string[]): Promise<RepoOverview[]>;

  /**
   * Get per-repo extraction-coverage counts (node counts by kind, entities
   * with ≥1 OPERATES_ON edge, functions with ≥1 outgoing CALLS edge, external
   * calls total/resolved). Empty `repoHashes` = all repos (cross-repo
   * convention). Backs the MCP `get_extraction_coverage` tool and the
   * low-coverage caveats on empty impact results.
   */
  getCoverageCounts(repoHashes: string[]): Promise<RepoCoverageCounts[]>;

  /**
   * List parsed repositories in the graph. Pass `nameFilter` to bound the
   * result to a known project's repos (cloud MCP workspace isolation, local
   * MCP with a `COREDOC_SCOPE=project:X` binding). Omit it only for the
   * bootstrap case where no project context exists.
   */
  listAllRepositories(nameFilter?: string[]): Promise<RepoSummary[]>;

  /**
   * List repository nodes as `{hash, name, parserVersion?}` rows in ONE query,
   * optionally filtered to the given hashes. Empty `repoHashes` = all repos
   * (cross-repo convention). Backs batched hash→name attribution AND schema-
   * generation checks for the messaging producer/consumer join
   * (`collectMessagingGraph`) without the per-repo counting getRepoOverview does.
   */
  getRepositoryNames(repoHashes: string[]): Promise<RepoNameRow[]>;

  /**
   * Get packages for the given repos.
   */
  getPackages(repoHashes: string[]): Promise<PackageInfo[]>;

  /**
   * Project only File/import facts and exported top-level declarations needed
   * by cross-repo package-import resolution.
   */
  getPackageLinkerFacts(repoHashes: string[]): Promise<PackageLinkerFacts>;

  /**
   * Get every node carrying a stored embedding vector, with its provenance
   * props (embeddingProvider/embeddingModel). Empty `repoHashes` = all repos
   * (same convention as the cross-repo queries). Backs semantic_search.
   */
  getEmbeddedNodes(repoHashes: string[]): Promise<EmbeddedNode[]>;

  // -------------------------------------------------------------------------
  // Traversals
  // -------------------------------------------------------------------------

  /**
   * Get direct callers of a function.
   */
  getDirectCallers(targetId: string, repoHashes: string[]): Promise<CallerInfo[]>;

  /**
   * Get transitive callers up to a certain depth.
   */
  getTransitiveCallers(targetId: string, depth: number, repoHashes: string[]): Promise<CallerInfo[]>;

  /**
   * Get entrypoints that can reach a target function.
   */
  getReachingEntrypoints(targetId: string, depth: number, repoHashes: string[]): Promise<EntrypointInfo[]>;

  /**
   * Find the shortest call path between two functions.
   */
  findShortestPath(startId: string, endId: string, repoHashes: string[]): Promise<PathStep[]>;

  /**
   * Get call tree from a root function.
   */
  getCallTree(rootId: string, depth: number, repoHashes: string[]): Promise<CallTreeNode[]>;

  /**
   * Get direct callees of a function.
   */
  getDirectCallees(sourceId: string, repoHashes: string[]): Promise<FunctionInfo[]>;

  // -------------------------------------------------------------------------
  // Impact Analysis
  // -------------------------------------------------------------------------

  /**
   * Get classes that extend a base class.
   */
  getClassExtensions(classId: string, repoHashes: string[]): Promise<ClassInfo[]>;

  /**
   * Get classes that implement an interface.
   */
  getInterfaceImplementations(interfaceId: string, repoHashes: string[]): Promise<ClassInfo[]>;

  /**
   * Get functions that operate on an entity.
   */
  getEntityConsumers(entityName: string, repoHashes: string[], operation?: DbOperationType): Promise<EntityConsumer[]>;

  /**
   * Get elements that reference a given type (class, interface, type alias,
   * or enum) via USES_TYPE edges, plus source Files linked by a cross-repo
   * package-import RESOLVES_TO edge. Includes the usage kind ('parameter',
   * 'return', 'property', 'interface-member', 'aliased', 'extends',
   * 'implements', 'import') and an optional `via` field
   * (parameter/property/import alias name).
   */
  getTypeUsages(typeId: string, repoHashes: string[]): Promise<TypeUsage[]>;

  /**
   * Get entities operated on by a batch of functions.
   * Returns OPERATES_ON edge data for the given function IDs.
   */
  getEntitiesForFunctions(
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
  >;

  // -------------------------------------------------------------------------
  // Cross-Repo
  // -------------------------------------------------------------------------

  /**
   * Get external calls (cross-repo calls) from functions in scope.
   * These are CALLS edges with isExternal=true.
   */
  getExternalCalls(repoHashes: string[], targetService?: string): Promise<ExternalCallInfo[]>;

  /**
   * Get only external calls that publish to a messaging destination.
   * Empty `repoHashes` = all repos. The filter runs in the query so
   * callers never pull the full external-call list to filter in JS.
   */
  getExternalCallsWithMessaging(repoHashes: string[]): Promise<MessagingExternalCall[]>;

  /**
   * Get external calls made by a specific function.
   */
  getExternalCallsFrom(functionId: string, repoHashes: string[]): Promise<ExternalCallInfo[]>;

  // -------------------------------------------------------------------------
  // Dynamic boundaries (statically unresolved calls)
  // -------------------------------------------------------------------------

  /**
   * Unresolved call sites whose callee expression ends in `nameTail`
   * (`app.useLogger` matches `useLogger`). Exact match on the precomputed tail
   * — no LIKE scan. Empty `repoHashes` = all repos (cross-repo convention).
   *
   * Never returns an edge: these sites have no callee, so a consumer must
   * present them as candidates, never as callers.
   */
  findUnresolvedCallsByNameTail(
    nameTail: string,
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]>;

  /**
   * Unresolved call sites located in any of `filePaths` (exact path match, as
   * stored by the parser). Backs "which dynamic sites sit inside the symbols I
   * am about to change?".
   */
  findUnresolvedCallsInFiles(
    filePaths: string[],
    repoHashes: string[],
    options?: UnresolvedCallQueryOptions,
  ): Promise<UnresolvedCallRecord[]>;

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier B — explorer)
  // -------------------------------------------------------------------------

  /**
   * Fetch nodes by exact ID, projected to the {@link VizNode} shape (never the
   * `properties` blob, embedding, or source — a response-size/Turso-egress
   * guard). Filtered to `repoHashes` (empty = all repos, cross-repo
   * convention). Missing IDs are simply absent from the result. Backs the
   * explorer's search-seed hydration and URL-state restore.
   */
  getNodesByIds(ids: string[], repoHashes: string[]): Promise<VizNode[]>;

  /**
   * Per-relation neighbor tallies for a focus node — the counts the explorer
   * fetches BEFORE any expansion to render count-labeled expand chevrons.
   * Grouped by (edgeType, direction). Filtered to `repoHashes`.
   */
  getNeighborCounts(nodeId: string, repoHashes: string[]): Promise<NeighborCount[]>;

  /**
   * One depth-1 neighbor expansion for a focus node. Returns the neighbor
   * nodes + connecting edges as viz DTOs, keyset-paginated by edge ID. Filtered
   * to `repoHashes`. Depth is fixed at 1 by design — deep traversal is repeated
   * expansion (see {@link GetNeighborsParams}).
   */
  getNeighbors(nodeId: string, params: GetNeighborsParams, repoHashes: string[]): Promise<NeighborsResult>;

  /**
   * A page of all nodes of one {@link NodeType}, projected to {@link VizNode},
   * keyset-paginated by node id. Filtered to `repoHashes` (empty = all repos).
   * Powers the explorer's "browse all entrypoints/entities of a repo" flow.
   */
  listNodesByType(
    type: NodeType,
    params: { limit: number; cursor?: string },
    repoHashes: string[],
  ): Promise<VizNodePage>;

  /**
   * A single node's {@link VizNode} projection PLUS its raw type-specific
   * `properties` (the blob {@link getNodesByIds} deliberately strips) — the
   * source for the explorer drawer's type-specific detail. `embedding` is never
   * included. Returns null when the id names no node in scope.
   */
  getNodeWithProperties(
    id: string,
    repoHashes: string[],
  ): Promise<{ node: VizNode; properties: Record<string, unknown> } | null>;

  /**
   * Bounded depth-N subgraph from a focus node — one recursive walk instead of
   * repeated {@link getNeighbors} calls. Follows `edgeTypes` in `direction` up to
   * `depth` hops, returning the reached nodes (nearest-first, capped at
   * `nodeCap`) plus every edge of an allowed type among them. `truncated` is set
   * when the reachable set exceeded `nodeCap`. Scoped by `repoHashes` (empty =
   * all repos), so a walk that includes the RESOLVES_TO bridge crosses repos.
   */
  getSubgraph(rootId: string, params: SubgraphParams, repoHashes: string[]): Promise<NeighborsResult>;

  /**
   * Every edge whose BOTH endpoints are in `nodeIds` — the induced subgraph
   * over a node set the caller already has.
   *
   * This is what turns a browse-by-type result into a graph: seeding 200
   * functions yields 200 isolated dots until their mutual edges are filled in.
   * Deliberately not a traversal — it never introduces a node the caller did
   * not already ask for. `truncated` is set when the edge count exceeded
   * `limit`, so the UI can say the picture is partial instead of implying the
   * nodes are unrelated.
   */
  getEdgesAmong(nodeIds: string[], repoHashes: string[], limit?: number): Promise<EdgesAmongResult>;

  /**
   * Candidate dead code — nodes of the requested kinds with NO inbound *usage*
   * edge (functions: CALLS/REFERENCES_VARIABLE/USES_TYPE/HANDLES; classes:
   * USES_TYPE/EXTENDS/IMPLEMENTS_INTERFACE), excluding exported symbols (which
   * are reachable from outside the repo). Keyset-paginated by node id. Also
   * returns `lowCoverageRepos` (from the coverage stats) so callers can flag
   * results from thinly-extracted repos as "suspect" not confirmed dead.
   */
  findDeadNodes(params: DeadCodeParams, repoHashes: string[]): Promise<DeadCodePage>;

  /**
   * The cross-repo bridges in scope — each materialized
   * `caller —MAKES_EXTERNAL_CALL→ external_call —RESOLVES_TO→ entrypoint
   * (—HANDLES→ handler)` chain where the external-call and entrypoint sides live
   * in different repos — projected to viz nodes+edges. Built on the required edge
   * rows (not the optional {@link getResolvesEdge}), so both backends implement
   * it. `truncated` is set when more bridges exist than `limit`.
   */
  getCrossRepoBridges(params: CrossRepoBridgeParams, repoHashes: string[]): Promise<NeighborsResult>;

  // -------------------------------------------------------------------------
  // Graph Visualization (Tier C — C4 architecture view)
  // -------------------------------------------------------------------------

  /**
   * Aggregate function→function CALLS into inter-package dependency edges,
   * resolving package membership via function→file→`packageId` entirely in the
   * query so the result is one row per package pair. Filtered to `repoHashes`
   * (a single repo hash for a per-repo L2 view). Backs C4 L2 edges.
   */
  getPackageDependencyRollup(repoHashes: string[]): Promise<PackageDependencyRollup[]>;

  /**
   * Fetch the component-level nodes (entrypoint / component / class /
   * state_store) and the edges among them for the given repos. Bounded by
   * component count; the C4 builder attributes nodes to packages by `filePath`
   * and applies per-view caps. Backs C4 L2 childCounts and L3 component graphs.
   */
  getComponentGraph(repoHashes: string[]): Promise<ComponentGraphData>;

  /**
   * Fetch the resolved cross-repo end-edge for a source external_call node,
   * including the stored multi-hop chain provenance. Returns null when the call
   * never resolved. Optional: backends without RESOLVES_TO edge storage omit it,
   * and MCP tracing falls back to the node's `resolvedTargetId`.
   */
  getResolvesEdge?(sourceCallId: string): Promise<ResolvesEdgeInfo | null>;

  /**
   * Return only the function nodes that carry a SCIP moniker for the given
   * repos (SDK-source exported methods). These are the nodes the cross-repo
   * symbol hop needs; loading every function would be wasteful on large repos.
   *
   * SELECT … FROM nodes WHERE type='function' AND repo_id IN (…)
   *   AND json_extract(properties,'$.monikerPackage') IS NOT NULL
   *
   * Each returned FunctionInfo has `.moniker` populated (packageName +
   * descriptor).
   */
  getMonikeredFunctions(repoHashes: string[]): Promise<FunctionInfo[]>;

  /**
   * Return the intra-repo CALLS edges of the given repos whose target is one of
   * `calleeIds` — the evidence the cross-repo chain-walker's call-edge hop needs
   * (a caller with a direct edge to an in-workspace SDK method node disambiguates
   * its egress). `calleeIds` is always a bounded join set (in practice the
   * monikered function ids) so this never degrades into a full CALLS scan.
   *
   * SELECT source_id, target_id FROM edges WHERE type='CALLS'
   *   AND repo_id IN (…) AND target_id IN (…)
   *
   * Deterministically ordered by (callerId, calleeId). Optional so backends may
   * omit the projection; callers guard with `?.` and fall back to [] — a resolver
   * without it behaves exactly as it did before the hop existed.
   */
  getInternalCallEdges?(repoHashes: string[], calleeIds: string[]): Promise<{ callerId: string; calleeId: string }[]>;

  /** Read the last graph snapshot committed atomically with a repository write. */
  getAppliedGraphSnapshot(repoId: string): Promise<AppliedGraphSnapshot | null>;
}

/**
 * Narrow logical-text inspection capability for immutable graph validation.
 *
 * It is separate from the common read contract because only file engines that
 * can stream every persisted node field efficiently need to expose it.
 */
export interface IGraphNodeTextReadRepository extends IGraphReadRepository {
  /** Return true when any scoped node text contains any exact needle. */
  containsNodeText(needles: readonly string[], repoHashes: string[]): Promise<boolean>;
}

/** Bound on one batched traversal step. */
export interface BatchExpandParams {
  /** Edge types the step may follow. An empty list yields an empty result. */
  edgeTypes: readonly EdgeType[];
  /**
   * Maximum distinct node ids returned. The implementation reads `limit + 1`
   * ids so `truncated` is observed, never inferred.
   */
  limit: number;
}

/** Result of one batched traversal step. */
export interface BatchNodeIdsResult {
  /** Distinct node ids, ascending, capped at `limit`. */
  nodeIds: string[];
  /** True when more ids matched than `limit` allowed. */
  truncated: boolean;
}

/**
 * Set-at-a-time traversal capability.
 *
 * Every read on {@link IGraphReadRepository} walks from ONE node
 * (`getDirectCallees`, `getSubgraph`, `getNeighbors`). Computing a feature's
 * code area — many seeds, a containment closure, one hop of callees over the
 * whole closure — through those means one round trip per node, which does not
 * fit inside a per-query timeout on any realistic feature.
 *
 * The two methods here are the set-shaped primitives that composition needs and
 * nothing more: "expand this SET of nodes one hop" and "which of THESE nodes are
 * reached in one hop from that set". Both are bounded and report `truncated`.
 *
 * Kept off the common read contract (ISP, and the same reason
 * {@link IGraphCypherReadRepository} is separate): only a graph-native engine
 * implements them efficiently, and every consumer must feature-detect and
 * degrade rather than assume the capability exists.
 */
export interface IGraphBatchTraversalRepository extends IGraphReadRepository {
  /**
   * Distinct targets reached in ONE outbound hop from any node in `sourceIds`
   * over `edgeTypes`, scoped to `repoHashes` on BOTH endpoints (empty = all
   * repos, cross-repo convention). Source nodes are not echoed back.
   */
  expandOutboundNodeIds?(
    sourceIds: readonly string[],
    params: BatchExpandParams,
    repoHashes: string[],
  ): Promise<BatchNodeIdsResult>;

  /**
   * The subset of `candidateIds` reached in ONE outbound hop from any node in
   * `sourceIds` over `edgeTypes` — the reverse-direction join (which of these
   * anchors does that area call?) without materializing the area's full
   * neighbourhood. Same repo scoping as {@link expandOutboundNodeIds}.
   */
  selectReachedNodeIds?(
    sourceIds: readonly string[],
    candidateIds: readonly string[],
    params: BatchExpandParams,
    repoHashes: string[],
  ): Promise<BatchNodeIdsResult>;
}

/** Raw persisted node projection exposed only for immutable-file validation. */
export interface StoredGraphValidationNode {
  id: string;
  type: NodeType;
  name: string;
  properties: Record<string, unknown>;
  repoId: string | null;
  filePath: string | null;
}

/** Raw persisted edge projection exposed only for immutable-file validation. */
export interface StoredGraphValidationEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  confidence: number;
  createdBy: GraphEdge['createdBy'];
  properties: Record<string, unknown>;
}

/**
 * Ladybug-only validation capability for exhaustively streaming an immutable
 * graph without widening the ordinary serving repository contract.
 */
export interface IGraphFileValidationRepository extends IGraphNodeTextReadRepository {
  scanStoredNodes(): AsyncIterable<StoredGraphValidationNode>;
  scanStoredEdges(): AsyncIterable<StoredGraphValidationEdge>;
}

/**
 * Scalar wire contract for the rows shape of a native Cypher read. Composite
 * values (maps/lists/nodes/relationships/temporal/spatial) are rejected at the
 * repository boundary with projection guidance — never coerced into this type.
 */
export type CypherScalar = string | number | boolean | null;

/**
 * Rows result for `runReadOnlyCypherRows`. `columns` are the projected return
 * names; each row is a scalar array aligned to `columns`; `truncated` is true
 * when more rows matched than `limit` allowed.
 */
export interface CypherRowsResult {
  columns: string[];
  rows: CypherScalar[][];
  truncated: boolean;
}

/**
 * Requested result shape for a native Cypher read. `Rows` yields a scalar
 * table (`CypherRowsResult`); `Graph` yields a node/edge subgraph
 * (`CypherGraphResult`).
 */
export enum CypherResultShape {
  Rows = 'rows',
  Graph = 'graph',
}

/**
 * Optional engine-specific read capability for backends that accept native
 * Cypher. It is separate from the common read contract because SQLite cannot
 * implement a Cypher surface, while serving code can still feature-detect it
 * without acquiring write capabilities.
 */
export interface IGraphCypherReadRepository extends IGraphReadRepository {
  runReadOnlyCypher?(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherGraphResult>;
  runReadOnlyCypherRows?(
    query: string,
    opts: { limit: number; params?: Record<string, CypherScalar> },
  ): Promise<CypherRowsResult>;
}

/**
 * Full graph repository capability. Existing writable implementations continue
 * to satisfy this interface while serving code can hold the narrower read type.
 */
export interface IGraphRepository extends IGraphCypherReadRepository {
  // -------------------------------------------------------------------------
  // Push Operations
  // -------------------------------------------------------------------------

  /**
   * Push nodes to the database.
   */
  pushNodes(nodes: GraphNode[]): Promise<number>;

  /**
   * Push edges to the database.
   */
  pushEdges(edges: GraphEdge[]): Promise<number>;

  /**
   * Delete all nodes and edges for a repository.
   */
  deleteRepository(repoId: string): Promise<void>;

  /**
   * Delete edges of a specific type for given repo IDs.
   * Used to clear stale RESOLVES_TO edges before re-resolution.
   * Required: both SQLite and Neo4j implement it; the resolution bridge calls it
   * unconditionally to keep the stale-edge wipe idempotent.
   */
  deleteEdgesByType(edgeType: EdgeType, repoIds: string[]): Promise<void>;

  /**
   * Batch update resolvedTargetId on external_call nodes.
   * Maps nodeId → targetEntrypointId. Required on both backends.
   */
  updateResolvedTargetIds(updates: Map<string, string>): Promise<void>;

  /**
   * Clear resolvedTargetId on external_call nodes that are no longer resolved.
   * Required on both backends.
   */
  clearResolvedTargetIds(nodeIds: string[]): Promise<void>;

  /**
   * Apply an incremental changeset (deletes, upserts, edge re-wiring) in one
   * atomic write. Lets PushService.applyIncremental skip a full re-push.
   * Optional so a backend may leave it unimplemented; the caller guards with a
   * `typeof repository.applyChangeset === 'function'` check and falls back to a
   * full push. Declared here so both backends' implementations are checked
   * against a single signature (drift guard).
   */
  applyChangeset?(
    changeset: {
      repoId: string;
      /** Entire repository snapshots to delete before applying the remaining delta. */
      repoIdsToDelete?: string[];
      nodesToAdd: GraphNode[];
      nodesToUpdate: GraphNode[];
      nodeIdsToDelete: string[];
      edgeNodeIdsToWipe: string[];
      /** Edge kinds owned outside the parser snapshot and excluded from the incident-edge wipe. */
      edgeTypesToPreserve?: string[];
      edgesToInsert: GraphEdge[];
      nodeMetadataUpdates?: NodeMetadataUpdate[];
      /**
       * Unresolved call sites of `repoId` (transformer output). When present it
       * REPLACES that repo's stored set — the write is a rebuild, so a retry or
       * a re-push converges without bookkeeping. Omitted leaves the stored set
       * untouched; an empty array clears it.
       */
      unresolvedCalls?: readonly UnresolvedCallRecord[];
    },
    options?: ApplyChangesetOptions,
  ): Promise<GraphApplyReceipt>;
}

// =============================================================================
// Batch Types for Push Operations
// =============================================================================

export interface NodeBatch {
  type: NodeType;
  nodes: GraphNode[];
}

export interface EdgeBatch {
  type: EdgeType;
  edges: GraphEdge[];
}

// =============================================================================
// Operations Tracking
// =============================================================================

export type OperationType = 'parse' | 'summarize' | 'push' | 'docs' | 'generate' | 'embed' | 'resolve';
export type OperationStatus = 'started' | 'completed' | 'failed';

export interface OperationRecord {
  id: string;
  projectId: string;
  repoName: string;
  operation: OperationType;
  status: OperationStatus;
  startedAt: number; // unix epoch ms
  completedAt?: number;
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export interface OperationSummary {
  projectId: string;
  repoName: string;
  lastParsed?: OperationRecord;
  lastSummarized?: OperationRecord;
  lastPushed?: OperationRecord;
  lastGenerated?: OperationRecord;
  lastDocs?: OperationRecord;
}

export interface IOperationsRepository {
  startOperation(
    projectId: string,
    repoName: string,
    operation: OperationType,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  completeOperation(id: string, metadata?: Record<string, unknown>): Promise<void>;
  failOperation(id: string, error: string, metadata?: Record<string, unknown>): Promise<void>;
  getOperationSummary(projectId: string, repoName: string): Promise<OperationSummary>;
  getOperationHistory(
    projectId: string,
    repoName: string,
    operation?: OperationType,
    limit?: number,
  ): Promise<OperationRecord[]>;
  getLatestOperation(projectId: string, repoName: string, operation: OperationType): Promise<OperationRecord | null>;
  getAllOperationSummaries(): Promise<OperationSummary[]>;
}
