/**
 * Data Index Types
 *
 * Lightweight index types for memory-efficient loading of large parsed JSON files.
 * These types store only what's needed for lookup and navigation - NOT full parsed objects.
 *
 * Live in @coredoc/core to enable shared access across packages without circular dependencies.
 */

import { z } from 'zod';
import { ALL_HTTP_METHODS } from './output.js';
import type { EntrypointType, HttpMethod, ParseStats, RepoType } from './output.js';

// =============================================================================
// Content Source Types (for confidence tracking)
// =============================================================================

/**
 * Content source type indicating where a description came from.
 * - 'parsed': From JSDoc/docstrings in source code
 * - 'summary': From pre-computed summaries file ({repo}-summaries.json)
 * - 'ai-generated': Generated on-the-fly during doc generation
 */
export type ContentSource = 'parsed' | 'summary' | 'ai-generated';

/**
 * Statistics about content sources in generated documentation.
 */
export interface SourceStats {
  parsed: number;
  summary: number;
  aiGenerated: number;
  total: number;
}

/**
 * Configuration for confidence indicator display.
 */
export interface ConfidenceConfig {
  /** Whether to show confidence indicators (--show-confidence flag) */
  showConfidence: boolean;
  /** Whether to show only AI-generated content (--ai-only flag) */
  aiOnly?: boolean;
}

// =============================================================================
// Repository Metadata
// =============================================================================

/**
 * RepositoryMetadata - lightweight repo metadata extracted from ParsedRepo.
 * Contains only top-level identification and statistics fields.
 */
export interface RepositoryMetadata {
  id: string;
  name: string;
  path: string;
  type?: RepoType;
  parsedAt: string;
  parserVersion: string;
  parserId: string;
  stats: ParseStats;
}

export const RepositoryMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  type: z.enum(['backend', 'frontend', 'mobile', 'library']).optional(),
  parsedAt: z.string(),
  parserVersion: z.string(),
  parserId: z.string(),
  stats: z.object({
    totalFiles: z.number(),
    parsedFiles: z.number(),
    skippedFiles: z.number(),
    totalFunctions: z.number(),
    totalClasses: z.number(),
    totalEntrypoints: z.number(),
    totalEntities: z.number(),
    totalCalls: z.number(),
    totalImports: z.number(),
    totalExternalCalls: z.number(),
    totalSdkDefinitions: z.number().optional(),
    parseTimeMs: z.number(),
  }),
});

// =============================================================================
// Index Types - Lightweight references
// =============================================================================

/**
 * EntrypointIndexRow - lightweight entrypoint reference for indexing and navigation.
 * Stores only ID, location, and type-specific routing information.
 */
export interface EntrypointIndexRow {
  id: string;
  versionedId: string;
  type: EntrypointType; // 'http' | 'graphql' | 'grpc' | 'websocket' | 'cron' | 'queue' | 'event' | 'cli' | 'mobile'
  handlerId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  // HTTP-specific (optional)
  method?: HttpMethod;
  path?: string;
  fullPath?: string;
  // Queue-specific (optional)
  topic?: string;
}

export const EntrypointIndexRowSchema = z.object({
  id: z.string(),
  versionedId: z.string(),
  type: z.enum(['http', 'graphql', 'grpc', 'websocket', 'cron', 'queue', 'event', 'cli', 'mobile']),
  handlerId: z.string(),
  filePath: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  // Includes the `ALL` wildcard: a pages-router API file / `router.all` handler serves every
  // verb, and rejecting it here would fail validation on a legitimately emitted entrypoint.
  method: z.enum(ALL_HTTP_METHODS as unknown as readonly [HttpMethod, ...HttpMethod[]]).optional(),
  path: z.string().optional(),
  fullPath: z.string().optional(),
  topic: z.string().optional(),
});

/**
 * FunctionIndex - lightweight function reference for indexing and navigation.
 * Stores only ID, name, location, and optional summary for quick lookup.
 */
export interface FunctionIndex {
  id: string;
  name: string;
  kind: 'function' | 'method';
  fileId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  classId?: string;
  summary?: string; // Pre-computed summary if available (truncated)
  summarySource?: ContentSource; // Tracks where summary came from
}

export const FunctionIndexSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['function', 'method']),
  fileId: z.string(),
  filePath: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  classId: z.string().optional(),
  summary: z.string().optional(),
  summarySource: z.enum(['parsed', 'summary', 'ai-generated']).optional(),
});

/**
 * EntityRef - lightweight entity reference for indexing and navigation.
 * Stores only ID, name, table name, location, and counts for quick lookup.
 * (Named EntityRef to avoid conflict with EntityIndex in output.ts which represents DB indexes)
 */
export interface EntityRef {
  id: string;
  name: string;
  tableName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fieldCount: number;
  relationCount: number;
}

export const EntityRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  tableName: z.string(),
  filePath: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  fieldCount: z.number(),
  relationCount: z.number(),
});

// =============================================================================
// Combined Data Indices
// =============================================================================

/**
 * DataIndices - the main output structure containing all lightweight indices.
 * Provides multiple access patterns for efficient lookups.
 */
export interface DataIndices {
  /** All entrypoints by ID */
  entrypoints: Map<string, EntrypointIndexRow>;
  /** Entrypoints grouped by type (http, graphql, queue, etc.) */
  entrypointsByType: Map<EntrypointType, EntrypointIndexRow[]>;
  /** Functions grouped by file ID */
  functionsByFile: Map<string, FunctionIndex[]>;
  /** Functions by ID for direct lookup */
  functionsById: Map<string, FunctionIndex>;
  /** Entities by name for quick lookup */
  entitiesByName: Map<string, EntityRef>;
  /** Repository metadata */
  metadata: RepositoryMetadata;
}

// =============================================================================
// Call Graph Types
// =============================================================================

/**
 * CallIndex - lightweight call edge for call graph navigation.
 * Represents one function calling another.
 */
export interface CallIndex {
  id: string;
  callerId: string; // Function making the call
  calleeId?: string; // Function being called (undefined if unresolved)
  calleeExpression: string; // The call expression text
  isMethodCall: boolean;
  filePath: string;
  line: number;
}

export const CallIndexSchema = z.object({
  id: z.string(),
  callerId: z.string(),
  calleeId: z.string().optional(),
  calleeExpression: z.string(),
  isMethodCall: z.boolean(),
  filePath: z.string(),
  line: z.number(),
});

/**
 * CallGraphIndices - adjacency lists for call graph traversal.
 */
export interface CallGraphIndices {
  /** Map from callee ID to list of caller IDs */
  callersOf: Map<string, string[]>;
  /** Map from caller ID to list of callee IDs */
  calleesOf: Map<string, string[]>;
  /** All call edges by ID */
  calls: Map<string, CallIndex>;
}

/**
 * ExtendedDataIndices - DataIndices with call graph and external call support.
 */
export interface ExtendedDataIndices extends DataIndices {
  callGraph: CallGraphIndices;
  /** Map from caller ID to external calls made by that function */
  externalCallsByCallerId: Map<string, ExternalCallIndex[]>;
}

// =============================================================================
// Import Graph Types
// =============================================================================

/**
 * ImportIndex - lightweight import edge for import graph navigation.
 * Represents one file importing from another module.
 */
export interface ImportIndex {
  id: string;
  sourceFileId: string;
  moduleSpecifier: string;
  targetFileId?: string; // undefined for external packages
  isTypeOnly: boolean;
  importKind: 'named' | 'default' | 'namespace' | 'side-effect';
}

export const ImportIndexSchema = z.object({
  id: z.string(),
  sourceFileId: z.string(),
  moduleSpecifier: z.string(),
  targetFileId: z.string().optional(),
  isTypeOnly: z.boolean(),
  importKind: z.enum(['named', 'default', 'namespace', 'side-effect']),
});

/**
 * ImportGraphIndices - adjacency lists for import graph traversal.
 */
export interface ImportGraphIndices {
  /** Map from file ID to list of files it imports */
  importsFrom: Map<string, string[]>;
  /** Map from file ID to list of files that import it */
  importedBy: Map<string, string[]>;
  /** All import edges by ID */
  imports: Map<string, ImportIndex>;
  /** Set of external package specifiers (moduleSpecifiers without targetFileId) */
  externalPackages: Set<string>;
}

/**
 * CycleInfo - information about a circular dependency detected in the import graph.
 */
export interface CycleInfo {
  /** Files involved in the cycle, in order */
  cycle: string[];
  /** The normalized cycle string (for deduplication) */
  normalized: string;
}

// =============================================================================
// External Call Index Types
// =============================================================================

/**
 * ExternalCallIndex - lightweight external call reference for indexing and navigation.
 * Stores only fields needed for external call traversal and aggregation.
 */
export interface ExternalCallIndex {
  id: string;
  callerId: string;
  serviceName: string;
  sdkName?: string;
  method: string;
  protocol: 'http' | 'messaging' | 'grpc' | 'ipc' | 'unknown';
  httpMethod?: HttpMethod;
  path?: string;
  system?: string;
  destination?: string;
  filePath: string;
  line: number;
}

export const ExternalCallIndexSchema = z.object({
  id: z.string(),
  callerId: z.string(),
  serviceName: z.string(),
  sdkName: z.string().optional(),
  method: z.string(),
  protocol: z.enum(['http', 'messaging', 'grpc', 'ipc', 'unknown']),
  httpMethod: z.enum(ALL_HTTP_METHODS as unknown as readonly [HttpMethod, ...HttpMethod[]]).optional(),
  path: z.string().optional(),
  system: z.string().optional(),
  destination: z.string().optional(),
  filePath: z.string(),
  line: z.number(),
});
