/**
 * Database Abstraction Layer
 *
 * Provides a unified interface for graph database operations.
 * Supports Neo4j and SQLite backends.
 *
 * @module @coredoc/db
 *
 * @example
 * ```typescript
 * import { getRepository, getDriver } from '@coredoc/db';
 *
 * // Get repository (uses COREDOC_DB_BACKEND env var)
 * const repo = await getRepository();
 *
 * // Query functions
 * const fn = await repo.findFunction('handleRequest', ['abc123']);
 *
 * // Get callers
 * const callers = await repo.getTransitiveCallers(fn.id, 3, ['abc123']);
 * ```
 */

// =============================================================================
// Type Exports
// =============================================================================

export type {
  // Backend types
  DatabaseBackend,
  // Driver/Repository interfaces
  IDatabaseDriver,
  IGraphBatchTraversalRepository,
  IGraphCypherReadRepository,
  IGraphFileValidationRepository,
  IGraphNodeTextReadRepository,
  IGraphReadRepository,
  IGraphRepository,
  ITransaction,
  TransactionStatement,
  BatchProgress,
  BatchProgressKind,
  GraphApplyReceipt,
  GraphSnapshotInput,
  AppliedGraphSnapshot,
  NodeMetadataUpdate,
  ApplyChangesetOptions,
  // Graph node/edge types (NodeType/EdgeType are enums — exported as values below)
  GraphNode,
  GraphEdge,
  StoredGraphValidationEdge,
  StoredGraphValidationNode,
  // Native Cypher read shapes (CypherResultShape is an enum — exported as a value below)
  CypherScalar,
  CypherRowsResult,
  // Batched traversal shapes (IGraphBatchTraversalRepository)
  BatchExpandParams,
  BatchNodeIdsResult,
  // Query result types
  CodeElement,
  FunctionInfo,
  ClassInfo,
  ClassPropertyInfo,
  InterfaceInfo,
  InterfaceMemberInfo,
  EnumInfo,
  TypeAliasInfo,
  EntrypointInfo,
  EntityInfo,
  CallerInfo,
  CallTreeNode,
  EntityConsumer,
  RepoOverview,
  RepoSummary,
  RepoNameRow,
  EdgesAmongResult,
  RepoCoverageCounts,
  PackageInfo,
  PackageLinkerImportedName,
  PackageLinkerImportInfo,
  PackageLinkerFileInfo,
  PackageLinkerDeclarationKind,
  PackageLinkerDeclarationInfo,
  PackageLinkerFacts,
  PathStep,
  ExternalCallInfo,
  MessagingExternalCall,
  EmbeddedNode,
  // Query parameter types
  FindCodeParams,
  ListEntrypointsParams,
  // Graph visualization (Tier B explorer)
  GetNeighborsParams,
  NeighborsResult,
  SubgraphParams,
  DeadCodeParams,
  CrossRepoBridgeParams,
  // Graph visualization (Tier C — C4 view)
  PackageDependencyRollup,
  ComponentGraphData,
  ComponentGraphNode,
  ComponentGraphEdge,
  // Operations tracking
  OperationType,
  OperationRecord,
  OperationSummary,
} from './types.js';

// Graph storage vocabulary enums: export as runtime values; consumers import
// members (e.g. `NodeType.Function`, `EdgeType.Calls`).
export { NodeType, EdgeType } from './types.js';
export { CypherResultShape } from './types.js';
export { GRAPH_READ_CAPABILITY_IDENTITY, GraphApplyMode } from './types.js';
export { ByteMultiPatternMatcher } from './multi-pattern.js';
export {
  assertQueryDoesNotProjectSource,
  assertReadOnlyCypherAllowlisted,
  type CypherDialect,
} from './cypher-guard.js';

export {
  openGraphFile,
  type GraphFileBudgets,
  type GraphFileHandle,
  type GraphFileOptions,
  type GraphFileOpenErrorCode,
} from './graph-file.js';

// =============================================================================
// Factory Exports
// =============================================================================

export {
  getDriver,
  getRepository,
  getOperationsRepository,
  closeDriver,
  closeOperationsDriver,
  closeAllDrivers,
  getConfiguredBackend,
  registerExitHandlers,
  isDatabaseAvailable,
  openProjectDatabase,
  closeProjectDatabases,
  replaceProjectLadybugGraphFile,
  type ProjectDatabase,
  type ProjectDatabaseOpenMode,
} from './backend-factory.js';

// =============================================================================
// Transformer Exports
// =============================================================================

export {
  transformParsedRepo,
  normalizeMetadataForParsedRepo,
  getTransformStats,
  type TransformResult,
  type NormalizedMetadata,
  type DroppedMetadataCounts,
} from './transformer.js';

// =============================================================================
// Push-Time Source Stripping Exports
// =============================================================================

export {
  stripSourceCode,
  containsSourceCode,
  stripEmbeddingInputText,
  embeddingsContainInputText,
  type StripResult,
  type StripEmbeddingsResult,
} from './strip-source.js';

// =============================================================================
// Resolution Exports
// =============================================================================

export {
  persistLinkResult,
  type LinkResultMutationRepository,
  type PersistLinkResult,
  type PersistRepoRef,
} from './resolution.js';

// =============================================================================
// Intent Code-Anchor Evidence
// =============================================================================

export {
  AnchorMismatchReason,
  AnchorStatus,
  SnapshotFreshness,
  resolveIntentEvidence,
  type AnchorEvidence,
  type AnchoredIntentSubject,
  type IntentEvidenceInput,
  type IntentEvidenceResult,
  type IntentItemEvidence,
  type ObservedCheckout,
  type RepoSnapshotEvidence,
} from './intent-evidence.js';

// =============================================================================
// Immutable Graph File Compatibility Identity
// =============================================================================

export {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  heritageIdentityIsVerifiable,
  withHeritageIdentityDowngrade,
} from './graph-format.js';

// =============================================================================
// SQLite Repository Exports
// =============================================================================

export { SqliteRepository } from './sqlite/repository.js';
export { McpMetricsRepository } from './sqlite/mcp-metrics-repository.js';
export type { McpQueryRecord, RecordMcpQueryInput, McpSessionRollup } from './sqlite/mcp-metrics-repository.js';

// =============================================================================
// SQLite Driver Exports (for direct access when needed)
// =============================================================================

export { SqliteDriver, type SqliteDriverOptions } from './sqlite/driver.js';

// =============================================================================
// Neo4j-Specific Exports (for direct access when needed)
// =============================================================================

export { getDriver as getNeo4jDriver, createVectorIndexes, ensureGraphIndexes } from './neo4j/driver.js';
