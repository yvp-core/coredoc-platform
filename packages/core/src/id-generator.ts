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
  private repoRoot: string;
  private repoKey: string;
  private repoHash: string;

  /**
   * @param repoRoot - Filesystem path to the repository root (used for file resolution)
   * @param repoKey - Canonical key for hash generation (defaults to repoRoot if not provided).
   *                  Use a stable, path-independent key (e.g., repo name) so that
   *                  different machines produce identical hashes for the same repo.
   */
  constructor(repoRoot: string, repoKey?: string) {
    this.repoRoot = repoRoot;
    this.repoKey = repoKey ?? repoRoot;
    this.repoHash = generateRepoHash(this.repoKey);
  }

  /**
   * Get the repository root path
   */
  getRepoRoot(): string {
    return this.repoRoot;
  }

  /**
   * Get the canonical repository key used for hash generation
   */
  getRepoKey(): string {
    return this.repoKey;
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
   * Generate WebSocket entrypoint ID
   */
  websocketEntrypointId(event: string, filePath: string, namespace?: string): string {
    const identifier = namespace ? `${namespace}:${event}` : event;
    return this.entrypointId('websocket', identifier, filePath);
  }

  /**
   * Generate Cron entrypoint ID
   */
  cronEntrypointId(jobName: string, filePath: string): string {
    return this.entrypointId('cron', jobName, filePath);
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

  /**
   * Generate component usage edge ID
   */
  componentUseEdgeId(parentComponentId: string, childComponentName: string, location: string): string {
    const hash = this.shortHash(`${parentComponentId}:${childComponentName}:${location}`);
    return `${this.repoHash}:component-use:${hash}`;
  }

  /**
   * Generate state access edge ID
   */
  stateAccessEdgeId(componentId: string, storeName: string, selector: string): string {
    const hash = this.shortHash(`${componentId}:${storeName}:${selector}`);
    return `${this.repoHash}:state-access:${hash}`;
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
   * Generate versioned class ID
   */
  versionedClassId(filePath: string, className: string, sourceCode: string): string {
    const stableId = this.classId(filePath, className);
    return this.versionedId(stableId, sourceCode);
  }

  /**
   * Generate versioned method ID
   */
  versionedMethodId(filePath: string, className: string, methodName: string, sourceCode: string): string {
    const stableId = this.methodId(filePath, className, methodName);
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

  /**
   * Generate ID for any edge type
   */
  generateEdgeId(type: EdgeIdKind, ...parts: string[]): string {
    const hash = this.shortHash(parts.join(':'));
    return `${this.repoHash}:${type}:${hash}`;
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
   * Check if two IDs refer to the same element (ignoring version/checksum)
   */
  isSameElement(id1: string, id2: string): boolean {
    return this.getStableId(id1) === this.getStableId(id2);
  }

  /**
   * Check if content has changed between two versioned IDs
   */
  hasChanged(oldVersionedId: string, newVersionedId: string): boolean {
    if (!this.isSameElement(oldVersionedId, newVersionedId)) {
      return true; // Different elements
    }

    const oldChecksum = this.getChecksum(oldVersionedId);
    const newChecksum = this.getChecksum(newVersionedId);

    if (!oldChecksum || !newChecksum) {
      return true; // Can't compare non-versioned IDs
    }

    return oldChecksum !== newChecksum;
  }

  /**
   * Check if ID belongs to this repository
   */
  belongsToRepo(id: string): boolean {
    return id.startsWith(this.repoHash + ':');
  }

  /**
   * Get node type from ID
   */
  getType(id: string): NodeIdKind | EdgeIdKind | null {
    const parsed = this.parseId(id);
    return parsed?.type ?? null;
  }

  /**
   * Check if ID is an edge type
   */
  isEdge(id: string): boolean {
    const type = this.getType(id);
    return type !== null && ['call', 'import', 'db-op', 'ext-call', 'component-use', 'state-access'].includes(type);
  }

  /**
   * Check if ID is a node type
   */
  isNode(id: string): boolean {
    return !this.isEdge(id);
  }

  // ===========================================================================
  // CROSS-REPO UTILITIES
  // ===========================================================================

  /**
   * Create a cross-repo reference ID
   * Used when referencing elements from shared packages
   */
  crossRepoRef(targetRepoHash: string, targetId: string): string {
    return `xref:${this.repoHash}:${targetRepoHash}:${this.getStableId(targetId)}`;
  }

  /**
   * Parse cross-repo reference
   */
  parseCrossRepoRef(refId: string): { sourceRepoHash: string; targetRepoHash: string; targetId: string } | null {
    const match = refId.match(/^xref:([a-f0-9]+):([a-f0-9]+):(.+)$/);
    if (!match) return null;

    return {
      sourceRepoHash: match[1] as string,
      targetRepoHash: match[2] as string,
      targetId: match[3] as string,
    };
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

  /**
   * Generate short content hash (first 8 chars)
   */
  shortContentHash(content: string): string {
    return this.contentHash(content).slice(0, 8);
  }
}

// =============================================================================
// Factory function for convenience
// =============================================================================

export function createIdGenerator(repoRoot: string, repoKey?: string): StableIdGenerator {
  return new StableIdGenerator(repoRoot, repoKey);
}

// =============================================================================
// Multi-repo ID Generator Manager
// =============================================================================

export class IdGeneratorManager {
  private generators: Map<string, StableIdGenerator> = new Map();

  /**
   * Get or create ID generator for a repo
   * @param repoRoot - Filesystem path to the repository root
   * @param repoKey - Canonical key for hash generation (defaults to normalized repoRoot)
   */
  getGenerator(repoRoot: string, repoKey?: string): StableIdGenerator {
    const normalized = repoRoot.replace(/\\/g, '/');
    const key = repoKey ?? normalized;

    if (!this.generators.has(key)) {
      this.generators.set(key, new StableIdGenerator(normalized, repoKey));
    }

    return this.generators.get(key)!;
  }

  /**
   * Get all registered generators
   */
  getAllGenerators(): StableIdGenerator[] {
    return Array.from(this.generators.values());
  }

  /**
   * Find which repo an ID belongs to
   */
  findRepoForId(id: string): StableIdGenerator | null {
    for (const generator of this.generators.values()) {
      if (generator.belongsToRepo(id)) {
        return generator;
      }
    }
    return null;
  }

  /**
   * Clear all generators
   */
  clear(): void {
    this.generators.clear();
  }
}

// Global manager instance
export const idGeneratorManager = new IdGeneratorManager();
