/**
 * Resolves a workspace graph for one bounded operation. File-backed readers
 * are leased only for the callback lifetime, so a pointer flip or LRU eviction
 * cannot invalidate an in-flight query.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  GRAPH_READ_CAPABILITY_IDENTITY,
  type IGraphBatchTraversalRepository,
  type IGraphCypherReadRepository,
  type IGraphReadRepository,
  withHeritageIdentityDowngrade,
} from '@coredoc/db';
import type { ScopeContext } from '@coredoc/mcp';
import type { Request } from 'express';
import type { WorkspaceRepo } from '../database/control-plane.service.js';
import { ControlPlaneService } from '../database/control-plane.service.js';
import { WorkspaceFileCacheService, type WorkspaceGraphFileLease } from '../database/workspace-file-cache.service.js';
import { WorkspaceDbPoolService } from '../database/workspace-db-pool.service.js';
import { GraphBackend, resolveGraphBackend } from '../database/graph-backend.js';
import { resolveWorkspaceScope } from './workspace-scope-resolver.js';

export interface WorkspaceContext {
  repository: IGraphReadRepository;
  scope: ScopeContext;
  repos: WorkspaceRepo[];
  /** Captured immutable graph version, or null for the legacy Turso path. */
  versionId: string | null;
  /**
   * The workspace's resolved graph backend (`turso` | `file_snapshot`). Carried
   * so a tool can NAME the plane that refused it — a capability error that says
   * "turso cannot serve Cypher" is actionable; "this graph cannot" is not.
   */
  graphBackend: GraphBackend;
}

export type WorkspaceGraphContextErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'DATABASE_UNAVAILABLE'
  | 'ACTIVE_VERSION_MISSING'
  | 'VERSION_NOT_FOUND'
  | 'UNSUPPORTED_BACKEND'
  | 'UNSUPPORTED_ENGINE';

export class WorkspaceGraphContextError extends Error {
  constructor(
    readonly code: WorkspaceGraphContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceGraphContextError';
  }
}

export class WorkspaceContextExpiredError extends Error {
  readonly code = 'WORKSPACE_CONTEXT_EXPIRED' as const;

  constructor() {
    super('Workspace graph repository cannot be used outside its context callback');
    this.name = 'WorkspaceContextExpiredError';
  }
}

export type WorkspaceContextCallback<T> = (context: WorkspaceContext) => Promise<T> | T;

const GRAPH_READ_METHODS = [
  'findCode',
  'listSymbolsInFile',
  'findFunction',
  'findClass',
  'findInterface',
  'findEnum',
  'findTypeAlias',
  'findEntity',
  'listEntities',
  'listEntrypoints',
  'getRepoOverview',
  'getCoverageCounts',
  'listAllRepositories',
  'getRepositoryNames',
  'getPackages',
  'getPackageLinkerFacts',
  'getEmbeddedNodes',
  'getDirectCallers',
  'getTransitiveCallers',
  'getReachingEntrypoints',
  'findShortestPath',
  'getCallTree',
  'getDirectCallees',
  'getClassExtensions',
  'getInterfaceImplementations',
  'getEntityConsumers',
  'getTypeUsages',
  'getEntitiesForFunctions',
  'getExternalCalls',
  'getExternalCallsWithMessaging',
  'getExternalCallsFrom',
  'getNodesByIds',
  'getNeighborCounts',
  'getNeighbors',
  'listNodesByType',
  'getNodeWithProperties',
  'getSubgraph',
  'getEdgesAmong',
  'findDeadNodes',
  'getCrossRepoBridges',
  'getPackageDependencyRollup',
  'getComponentGraph',
  'getResolvesEdge',
  'getMonikeredFunctions',
  'getInternalCallEdges',
  'getAppliedGraphSnapshot',
  'getPendingGraphApply',
  'findUnresolvedCallsByNameTail',
  'findUnresolvedCallsInFiles',
] as const satisfies readonly (keyof IGraphReadRepository)[];

// Exhaustiveness check: a read method added to IGraphReadRepository but not listed
// above fails compilation with "Type '<methodName>' does not satisfy the constraint 'never'".
type MissingGraphReadMethod = Exclude<keyof IGraphReadRepository, (typeof GRAPH_READ_METHODS)[number]>;
type AssertNoMissingGraphReadMethods<Missing extends never> = Missing;
export type AllGraphReadMethodsListed = AssertNoMissingGraphReadMethods<MissingGraphReadMethod>;

/**
 * Cypher is an OPTIONAL capability, so these stay out of GRAPH_READ_METHODS (and
 * out of its exhaustiveness check): only a graph-native backend implements them,
 * and the facade must not fabricate a callable the underlying graph lacks —
 * feature detection on the leased repository is what the hosted tool trusts.
 */
const OPTIONAL_CYPHER_METHODS = [
  'runReadOnlyCypher',
  'runReadOnlyCypherRows',
] as const satisfies readonly (keyof IGraphCypherReadRepository)[];

/**
 * Set-at-a-time traversal, optional for the same reason Cypher is: only a
 * graph-native backend implements it, and the legacy Turso path never will.
 * Intent derivation (spec §6.1) feature-detects these on the leased repository
 * and degrades to attachment-only applicability when they are absent — so the
 * facade must forward them when present and fabricate nothing when not.
 */
const OPTIONAL_BATCH_TRAVERSAL_METHODS = [
  'expandOutboundNodeIds',
  'selectReachedNodeIds',
] as const satisfies readonly (keyof IGraphBatchTraversalRepository)[];
const GRAPH_READ_IDENTITIES = new WeakMap<IGraphReadRepository, object>();

function graphReadIdentity(repository: IGraphReadRepository): object {
  const existing = GRAPH_READ_IDENTITIES.get(repository);
  if (existing) return existing;
  const identity = Object.freeze({});
  GRAPH_READ_IDENTITIES.set(repository, identity);
  return identity;
}

function scopedRepository(repository: IGraphReadRepository): {
  repository: IGraphReadRepository;
  revoke(): void;
  drain(): Promise<void>;
} {
  let active = true;
  const inFlight = new Set<Promise<unknown>>();
  const assertActive = (): void => {
    if (!active) throw new WorkspaceContextExpiredError();
  };

  const track = (value: unknown): void => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (typeof (value as PromiseLike<unknown>).then !== 'function') return;
    const operation = Promise.resolve(value);
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
  };

  const facade = Object.create(null) as Record<string, unknown>;
  const source = repository as IGraphReadRepository &
    Partial<IGraphCypherReadRepository> &
    Partial<IGraphBatchTraversalRepository>;
  Object.defineProperty(facade, GRAPH_READ_CAPABILITY_IDENTITY, {
    value: graphReadIdentity(repository),
  });
  for (const method of [...GRAPH_READ_METHODS, ...OPTIONAL_CYPHER_METHODS, ...OPTIONAL_BATCH_TRAVERSAL_METHODS]) {
    const implementation = source[method];
    if (typeof implementation !== 'function') continue;
    Object.defineProperty(facade, method, {
      enumerable: true,
      value: (...args: unknown[]) => {
        assertActive();
        const result = Reflect.apply(implementation, repository, args);
        track(result);
        return result;
      },
    });
  }

  return {
    repository: Object.freeze(facade) as unknown as IGraphReadRepository,
    revoke(): void {
      active = false;
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...inFlight]);
    },
  };
}

@Injectable()
export class WorkspaceMcpContextService {
  private readonly logger = new Logger(WorkspaceMcpContextService.name);

  constructor(
    private readonly workspaceDbPool: WorkspaceDbPoolService,
    private readonly controlPlane: ControlPlaneService,
    private readonly fileCache: WorkspaceFileCacheService,
  ) {}

  async withContext<T>(request: Request, callback: WorkspaceContextCallback<T>): Promise<T> {
    const workspaceId = (request as Request & { workspaceId?: string }).workspaceId;
    if (!workspaceId) {
      throw new Error('Missing workspaceId on request');
    }
    return this.withContextByWorkspaceId(workspaceId, callback);
  }

  async withContextByWorkspaceId<T>(workspaceId: string, callback: WorkspaceContextCallback<T>): Promise<T> {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new WorkspaceGraphContextError('WORKSPACE_NOT_FOUND', `Workspace not found: ${workspaceId}`);
    }

    // Capture both routing fields before another await. One request must never
    // combine metadata from two active-pointer generations.
    let graphBackend: GraphBackend;
    try {
      graphBackend = resolveGraphBackend(workspace);
    } catch (error) {
      // Keep the MCP-shaped code: intent degradation maps UNSUPPORTED_BACKEND to a
      // graceful "this graph plane cannot serve you", not a hard failure.
      throw new WorkspaceGraphContextError(
        'UNSUPPORTED_BACKEND',
        error instanceof Error ? error.message : `Unsupported graph backend: ${workspace.graphBackend}`,
      );
    }
    const capturedVersionId = workspace.activeGraphVersionId ?? null;
    let repository: IGraphReadRepository;
    let versionId: string | null = null;
    let lease: WorkspaceGraphFileLease | null = null;

    if (graphBackend === GraphBackend.Turso) {
      const tursoRepository = await this.workspaceDbPool.getRepository(workspaceId, workspace.slug);
      if (!tursoRepository) {
        throw new WorkspaceGraphContextError(
          'DATABASE_UNAVAILABLE',
          `No database available for workspace: ${workspace.slug}`,
        );
      }
      repository = tursoRepository;
    } else {
      if (!capturedVersionId) {
        throw new WorkspaceGraphContextError(
          'ACTIVE_VERSION_MISSING',
          `Workspace ${workspaceId} has no active graph version`,
        );
      }
      const version = await this.controlPlane.getWorkspaceGraphVersion(workspaceId, capturedVersionId);
      if (!version) {
        throw new WorkspaceGraphContextError(
          'VERSION_NOT_FOUND',
          `Graph version not found: ${workspaceId}/${capturedVersionId}`,
        );
      }
      if (version.engine !== GRAPH_FILE_FORMAT_COMPATIBILITY.engine) {
        throw new WorkspaceGraphContextError('UNSUPPORTED_ENGINE', `Unsupported graph file engine: ${version.engine}`);
      }
      // `builderVersion` is not a column on the version row — it is carried in the
      // manifest JSONB. Threaded onto the lease so a reader can tell a pre-phase4
      // snapshot from a current one; absent (an artifact published before the
      // manifest carried it) fails closed, which renders a verified heritage edge
      // as unverified rather than the reverse.
      const manifest = version.manifest as { builderVersion?: unknown } | null;
      const builderVersion = typeof manifest?.builderVersion === 'string' ? manifest.builderVersion : undefined;
      lease = await this.fileCache.acquire({ ...version, engine: version.engine, builderVersion });
      // Downgrade heritage identity HERE, at the one place a snapshot's vintage and
      // its repository are both in hand. Threading the vintage onward instead would
      // make every present and future consumer of `getTypeUsages` responsible for
      // remembering it; wrapping the reader means the rows they can observe are
      // already honest. A current snapshot is returned untouched.
      repository = withHeritageIdentityDowngrade(lease.repository, builderVersion);
      versionId = capturedVersionId;
    }

    let scoped: ReturnType<typeof scopedRepository> | null = null;
    let callbackFailed = false;
    let callbackError: unknown;
    let releaseError: unknown;
    let result!: T;
    try {
      scoped = scopedRepository(repository);
      const repos = await this.controlPlane.listRepos(workspaceId);
      const scope = resolveWorkspaceScope(repos);
      result = await callback({ repository: scoped.repository, scope, repos, versionId, graphBackend });
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    } finally {
      scoped?.revoke();
      if (scoped) await scoped.drain();
      if (lease) {
        try {
          await this.fileCache.release(lease);
        } catch (error) {
          releaseError = error;
        }
      }
    }
    if (callbackFailed) {
      if (releaseError !== undefined) {
        this.logger.error(`Failed to release graph lease ${workspaceId}/${versionId}`, releaseError);
      }
      throw callbackError;
    }
    if (releaseError !== undefined) throw releaseError;
    return result;
  }
}
