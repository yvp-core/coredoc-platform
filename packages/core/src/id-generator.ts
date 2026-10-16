/**
 * Coredoc Stable ID Generator
 *
 * Generates stable, deterministic IDs for code elements. Supports:
 * - Stable IDs for graph relationships (don't change when code changes)
 * - Versioned IDs for caching (include content checksum)
 * - Incremental updates via change detection
 * - Multi-repo support (repo hash prefix prevents collisions)
 *
 * STABLE ID Format: `{repoHash}:{type}:{path}:{name}`
 * - Used for graph nodes and edges
 * - Does NOT change when code content changes
 * - Relationships remain valid across code updates
 *
 * VERSIONED ID Format: `{stableId}@{checksum}`
 * - Used for caching and change detection
 * - Changes when code content changes
 * - Enables cache invalidation
 *
 * Repo Hash: First 12 chars of sha256(repoKey)
 * - 48 bits = ~0.03% collision probability at 1M repos
 */

import * as crypto from 'crypto';

/**
 * Generate repository hash from a canonical repo key (`repo.key ?? repo.name`).
 * Using 12 hex chars (48 bits) for collision resistance.
 *
 * The single definition of the two-ID system's repo identity — the local MCP
 * scope resolver joins on exactly this value, so the two must never drift.
 *
 * NOTE: the key is the repo name (or its `key` override) and deliberately
 * excludes the project, so ids are unique only WITHIN one graph database.
 * Two projects that both contain a repo named `api` mint identical ids. That
 * is safe today only because each project owns its own database file
 * (`projectDbPath`). Any feature that merges two graph files into one — a
 * workspace-wide export/import, a cross-project search, a shared backend —
 * reintroduces the collision and must fold the project into this key first.
 */
export function generateRepoHash(repoKey: string): string {
  return crypto.createHash('sha256').update(repoKey).digest('hex').slice(0, 12);
}

// =============================================================================
// Types
// =============================================================================

export type NodeIdKind =
  | 'file'
  | 'package'
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'variable'
  | 'entity' // DB entity
  | 'entrypoint'
  | 'component' // Frontend component
  | 'route' // Frontend route
  | 'state-store'; // State management

export type EdgeIdKind =
  | 'call'
  | 'import'
  | 'db-op'
  | 'ext-call'
  | 'component-use' // Component usage
  | 'state-access'; // State store access

export interface ParsedId {
  repoHash: string;
  type: NodeIdKind | EdgeIdKind;
  segments: string[];
  checksum?: string; // Only present in versioned IDs
  isVersioned: boolean;
}

// =============================================================================
// Main Class
// =============================================================================

export class StableIdGenerator {
  private repoHash: string;

  /**
   * @param repoRoot - Filesystem path to the repository root (the hash key when repoKey is omitted)
   * @param repoKey - Canonical key for hash generation (defaults to repoRoot if not provided).
   *                  Use a stable, path-independent key (e.g., repo name) so that
   *                  different machines produce identical hashes for the same repo.
   */
  constructor(repoRoot: string, repoKey?: string) {
    this.repoHash = generateRepoHash(repoKey ?? repoRoot);
  }

  /**
   * Get the repository hash
   */
  getRepoHash(): string {
    return this.repoHash;
  }

  // ===========================================================================
  // STABLE IDs (for graph nodes/edges - don't include checksum)
  // ===========================================================================

  /**
   * Generate file ID
   */
  fileId(relativePath: string): string {
    return `${this.repoHash}:file:${relativePath}`;
  }

  /**
   * Generate package ID
   */
  packageId(packagePath: string): string {
    return `${this.repoHash}:package:${packagePath}`;
  }

  /**
   * Generate function ID (standalone function)
   */
  functionId(filePath: string, functionName: string): string {
    return `${this.repoHash}:function:${filePath}:${functionName}`;
  }

  /**
   * Generate class ID
   */
  classId(filePath: string, className: string): string {
    return `${this.repoHash}:class:${filePath}:${className}`;
  }

  /**
   * Generate method ID (class method)
   */
  methodId(filePath: string, className: string, methodName: string): string {
    return `${this.repoHash}:method:${filePath}:${className}.${methodName}`;
  }

  /**
   * Generate interface ID
   */
  interfaceId(filePath: string, interfaceName: string): string {
    return `${this.repoHash}:interface:${filePath}:${interfaceName}`;
  }

  /**
   * Generate type alias ID
   */
  typeAliasId(filePath: string, typeName: string): string {
    return `${this.repoHash}:type-alias:${filePath}:${typeName}`;
  }

  /**
   * Generate enum ID
   */
  enumId(filePath: string, enumName: string): string {
    return `${this.repoHash}:enum:${filePath}:${enumName}`;
  }

  /**
   * Generate variable ID
   */
  variableId(filePath: string, variableName: string): string {
    return `${this.repoHash}:variable:${filePath}:${variableName}`;
  }

  /**
   * Generate DB entity ID
   */
  entityId(filePath: string, entityName: string): string {
    return `${this.repoHash}:entity:${filePath}:${entityName}`;
  }

  /**
   * Generate entrypoint ID.
   *
   * The owning `filePath` is folded into the hash so that two handlers exposing
   * the same identifier from DIFFERENT files (e.g. a ts frontend and a ruby
   * backend target of one monorepo both serving `GET /health`, or two packages
   * each registering CLI command `sync`) produce DISTINCT node IDs. Without this,
   * their content-scoped IDs collide and the `INSERT OR REPLACE INTO nodes` sink
   * silently drops one handler. `filePath` is required so no mint site can be
   * left unscoped. Trade-off: an entrypoint's ID moves with its handler's file.
   *
   * @param type - Entrypoint type (http, graphql, grpc, websocket, cron, queue, event)
   * @param identifier - Type identifier (e.g., "GET:/api/users", "cron:cleanup-job")
   * @param filePath - Owning file (scopes the ID so cross-file duplicates stay distinct)
   */
  entrypointId(type: string, identifier: string, filePath: string): string {
    // Hash the file-scoped identifier to keep ID length manageable.
    const hash = this.shortHash(`${type}:${filePath}:${identifier}`);
    return `${this.repoHash}:entrypoint:${type}:${hash}`;
  }

  /**
   * Generate HTTP entrypoint ID (convenience method)
   */
  httpEntrypointId(method: string, path: string, filePath: string): string {
    return this.entrypointId('http', `${method}:${path}`, filePath);
  }

  /**
   * Generate GraphQL entrypoint ID
   */
  graphqlEntrypointId(operationType: string, fieldName: string, filePath: string): string {
    return this.entrypointId('graphql', `${operationType}:${fieldName}`, filePath);
  }

  /**
   * Generate gRPC entrypoint ID
   */
  grpcEntrypointId(serviceName: string, methodName: string, filePath: string): string {
    return this.entrypointId('grpc', `${serviceName}:${methodName}`, filePath);
  }

  /**
   * Generate Queue/Message entrypoint ID
   */
  queueEntrypointId(system: string, topic: string, filePath: string): string {
    return this.entrypointId('queue', `${system}:${topic}`, filePath);
  }

  // ===========================================================================
  // FRONTEND-SPECIFIC IDs
  // ===========================================================================

  /**
   * Generate component ID
   */
  componentId(filePath: string, componentName: string): string {
    return `${this.repoHash}:component:${filePath}:${componentName}`;
  }

  /**
   * Generate route ID
   */
  routeId(routePath: string): string {
    const hash = this.shortHash(routePath);
    return `${this.repoHash}:route:${hash}`;
  }

  /**
   * Generate state store ID
   */
  stateStoreId(filePath: string, storeName: string): string {
    return `${this.repoHash}:state-store:${filePath}:${storeName}`;
  }

  // ===========================================================================
  // EDGE IDs (for relationships)
  // ===========================================================================

  /**
   * Generate call edge ID
   */
  callEdgeId(callerId: string, calleeExpression: string, location: string): string {
    const hash = this.shortHash(`${callerId}:${calleeExpression}:${location}`);
    return `${this.repoHash}:call:${hash}`;
  }

  /**
   * Generate enum-member reference edge ID. Keyed on source + enum + member +
   * module (not location), so repeated comparisons against the same member
   * inside one function collapse into a single edge while two same-named enums
   * imported from DIFFERENT modules stay two edges. `importedFrom` absent means
   * the enum is declared in the referencing file; that case keeps the original
   * three-part key so same-file ids do not churn.
   */
  enumMemberRefEdgeId(sourceId: string, enumName: string, member: string, importedFrom?: string): string {
    const key =
      importedFrom === undefined
        ? `${sourceId}:${enumName}:${member}`
        : `${sourceId}:${enumName}:${member}:${importedFrom}`;
    return `${this.repoHash}:enum-member-ref:${this.shortHash(key)}`;
  }

  /**
   * Generate class-reference edge ID (construction / import site). Keyed on
   * source + class + refKind + module (not location), so repeated `new X()` calls
   * inside one function collapse into a single edge while two same-named classes
   * imported from DIFFERENT modules stay two edges, and a construction site never
   * collides with the import of the same class. `importedFrom` absent means the
   * class is declared in the referencing file.
   */
  classRefEdgeId(
    sourceId: string,
    className: string,
    refKind: 'construction' | 'import',
    importedFrom?: string,
  ): string {
    const key =
      importedFrom === undefined
        ? `${sourceId}:${className}:${refKind}`
        : `${sourceId}:${className}:${refKind}:${importedFrom}`;
    return `${this.repoHash}:class-ref:${this.shortHash(key)}`;
  }

  /**
   * Generate import edge ID
   */
  importEdgeId(sourceFileId: string, moduleSpecifier: string): string {
    const hash = this.shortHash(`${sourceFileId}:${moduleSpecifier}`);
    return `${this.repoHash}:import:${hash}`;
  }

  /**
   * Generate DB operation ID
   */
  dbOperationId(functionId: string, entityName: string, operation: string, location: string): string {
    const hash = this.shortHash(`${functionId}:${entityName}:${operation}:${location}`);
    return `${this.repoHash}:db-op:${hash}`;
  }

  /**
   * Generate external call ID
   */
  externalCallId(functionId: string, sdkName: string, method: string, location: string): string {
    const hash = this.shortHash(`${functionId}:${sdkName}:${method}:${location}`);
    return `${this.repoHash}:ext-call:${hash}`;
  }

  // ===========================================================================
  // VERSIONED IDs (for caching - include checksum)
  // ===========================================================================

  /**
   * Create versioned ID by appending checksum to stable ID
   *
   * @param stableId - The stable node ID
   * @param sourceCode - Source code to hash
   */
  versionedId(stableId: string, sourceCode: string): string {
    const checksum = this.shortHash(sourceCode);
    return `${stableId}@${checksum}`;
  }

  /**
   * Generate versioned function ID
   */
  versionedFunctionId(filePath: string, functionName: string, sourceCode: string): string {
    const stableId = this.functionId(filePath, functionName);
    return this.versionedId(stableId, sourceCode);
  }

  /**
   * Generate versioned file ID
   */
  versionedFileId(relativePath: string, contentHash: string): string {
    const stableId = this.fileId(relativePath);
    return `${stableId}@${contentHash.slice(0, 8)}`;
  }

  /**
   * Generate versioned component ID
   */
  versionedComponentId(filePath: string, componentName: string, sourceCode: string): string {
    const stableId = this.componentId(filePath, componentName);
    return this.versionedId(stableId, sourceCode);
  }

  // ===========================================================================
  // GENERIC ID GENERATION
  // ===========================================================================

  /**
   * Generate ID for any node type
   */
  generateNodeId(type: NodeIdKind, ...parts: string[]): string {
    return `${this.repoHash}:${type}:${parts.join(':')}`;
  }

  // ===========================================================================
  // PARSING & COMPARISON
  // ===========================================================================

  /**
   * Parse an ID to extract its components
   */
  parseId(id: string): ParsedId | null {
    // Check for versioned ID (contains @)
    const versionedMatch = id.match(/^(.+)@([a-f0-9]+)$/);
    let baseId = id;
    let checksum: string | undefined;
    let isVersioned = false;

    if (versionedMatch?.[1] && versionedMatch[2]) {
      baseId = versionedMatch[1];
      checksum = versionedMatch[2];
      isVersioned = true;
    }

    const parts = baseId.split(':');
    if (parts.length < 2) return null;

    const [repoHash, type, ...segments] = parts;

    return {
      repoHash: repoHash as string,
      type: type as NodeIdKind | EdgeIdKind,
      segments,
      checksum,
      isVersioned,
    };
  }

  /**
   * Extract stable ID from versioned ID
   */
  getStableId(versionedId: string): string {
    const atIndex = versionedId.lastIndexOf('@');
    if (atIndex === -1) return versionedId;
    return versionedId.slice(0, atIndex);
  }

  /**
   * Extract checksum from versioned ID
   */
  getChecksum(versionedId: string): string | null {
    const atIndex = versionedId.lastIndexOf('@');
    if (atIndex === -1) return null;
    return versionedId.slice(atIndex + 1);
  }

  /**
   * Check if ID belongs to this repository
   */
  belongsToRepo(id: string): boolean {
    return id.startsWith(this.repoHash + ':');
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /**
   * Generate short hash (first 8 chars of SHA1)
   */
  private shortHash(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
  }

  /**
   * Generate content hash for a file (SHA256, full)
   */
  contentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
