/**
 * Workspace DB Pool Service
 *
 * Manages a pool of SQLite/Turso connections, one per workspace.
 * Each workspace has its own isolated database for code graph data.
 * Connections are created on-demand, refcounted while in use, and evicted
 * after a period of true idleness (no lease held + no recent acquire).
 */

import { Inject, Injectable, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, storageConfigFromEnv } from '../config/app-config.js';
import type { IDatabaseDriver, IGraphRepository } from '@coredoc/db';
import { TursoProvisioningService } from './turso-provisioning.service.js';

// =============================================================================
// Types
// =============================================================================

interface WorkspaceConnection {
  driver: IDatabaseDriver;
  repository: IGraphRepository;
  lastAccessed: number;
  /**
   * Active leases held via `acquire()`. The idle-eviction sweep MUST NOT
   * close a driver while any lease is outstanding — that's exactly the bug
   * that caused 2026-05-24's TRANSACTION_CLOSED / fetch failed / SERVER_ERROR
   * 404 cascade: a long-running push held the cached repository for >10 min,
   * `evictIdle` saw `lastAccessed` stale (only refreshed on `getRepository`
   * call, not per-statement), closed the driver under the running job, and
   * every subsequent libsql call on the dead client failed.
   */
  inFlight: number;
  /**
   * Set by closeConnection() when the driver must be replaced while other
   * leases are still outstanding. A retired connection is out of the map (new
   * acquires get a fresh driver) and its driver closes when the last lease
   * releases — never under a concurrent holder.
   */
  retiredAt?: number;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class WorkspaceDbPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceDbPoolService.name);
  private readonly connections = new Map<string, WorkspaceConnection>();
  private readonly pending = new Map<string, Promise<IGraphRepository | null>>();
  /** Connections retired by closeConnection() while still leased; drain via release(). */
  private readonly retired = new Map<string, WorkspaceConnection[]>();
  /**
   * Repository → connection index so release() can target the exact connection
   * a caller acquired even after closeConnection() replaced the map entry.
   * WeakMap: entries die with the repository objects.
   */
  private readonly leaseIndex = new WeakMap<IGraphRepository, WorkspaceConnection>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Max idle time before a connection is evicted (60 minutes).
   *
   * Defense-in-depth alongside the `inFlight` refcount: even if a future code
   * path forgets to pair `acquire`/`release`, the eviction window is well
   * past any plausible push duration, so the race window shrinks to zero
   * for refcount-correct callers and stays very small for stragglers.
   */
  private readonly maxIdleMs = 60 * 60 * 1000;

  constructor(
    private readonly tursoProvisioning: TursoProvisioningService,
    @Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = storageConfigFromEnv(),
  ) {
    // Periodically evict idle connections
    this.cleanupInterval = setInterval(() => this.evictIdle(), 5 * 60 * 1000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.closeAll();

    // The shared Neo4j driver is owned by the backend-factory and deliberately not
    // cached here, so closeAll() above can't reach it. Close it explicitly on
    // shutdown so the bolt connection pool drains gracefully instead of leaking
    // until process exit. closeDriver() is idempotent and clears the factory
    // singleton, so a later getRepository('neo4j') re-initialises cleanly.
    if (this.isNeo4jBackend()) {
      const { closeDriver } = await import('@coredoc/db');
      await closeDriver();
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get or create a graph repository for a workspace.
   *
   * **Short-lived reads only.** Does NOT take a lease; the underlying driver
   * may be evicted at any time. For any operation that holds the repository
   * for more than a few seconds (push, resolve, anything in a worker job),
   * use `acquire` + `release` (or `withRepository`) instead.
   *
   * SQLite/Turso path: returns null when the workspace has no provisioned
   * database. Neo4j path (on-prem): returns the shared graph and never null;
   * if Neo4j is misconfigured (no NEO4J_PASSWORD) or unreachable it THROWS
   * rather than returning null — fail-fast, so a misconfigured deployment is
   * loud instead of silently serving an empty graph.
   */
  async getRepository(workspaceId: string, workspaceSlug: string): Promise<IGraphRepository | null> {
    // On-prem single-tenant Neo4j: one shared, process-lifetime graph for the whole
    // deployment — no per-workspace provisioning. The backend-factory owns the
    // singleton driver, so it is intentionally NOT cached in this pool: the
    // lease/eviction machinery below exists only to keep a per-workspace Turso driver
    // from being closed mid-statement, and closing the *shared* Neo4j driver on idle
    // eviction would tear it down for every other workspace. Hand back the singleton
    // directly; `acquire`/`release` then degrade to no-ops (no cache entry to lease),
    // which is correct because the shared driver is never evicted.
    if (this.isNeo4jBackend()) {
      const { getRepository: getSharedRepository } = await import('@coredoc/db');
      return getSharedRepository('neo4j');
    }

    const existing = this.connections.get(workspaceId);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing.repository;
    }

    const inflight = this.pending.get(workspaceId);
    if (inflight) return inflight;

    const promise = this.createRepositoryOnce(workspaceId, workspaceSlug);
    this.pending.set(workspaceId, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(workspaceId);
    }
  }

  private async createRepositoryOnce(workspaceId: string, workspaceSlug: string): Promise<IGraphRepository | null> {
    const recheck = this.connections.get(workspaceId);
    if (recheck) {
      recheck.lastAccessed = Date.now();
      return recheck.repository;
    }

    const dbInfo = await this.tursoProvisioning.ensureDatabase(workspaceId, workspaceSlug);
    if (!dbInfo) {
      this.logger.warn(`No database available for workspace ${workspaceSlug}`);
      return null;
    }

    return this.createConnection(workspaceId, dbInfo.url, dbInfo.token);
  }

  /**
   * Acquire a leased graph repository. Increments `inFlight`, blocking idle
   * eviction until `release(workspaceId)` is called. Always pair with a
   * matching `release` in a `try/finally` (or use `withRepository`).
   *
   * Returns null if the workspace has no provisioned database (no lease taken
   * in that case — `release` is not required).
   */
  async acquire(workspaceId: string, workspaceSlug: string): Promise<IGraphRepository | null> {
    const repository = await this.getRepository(workspaceId, workspaceSlug);
    if (!repository) return null;
    const conn = this.connections.get(workspaceId);
    if (conn) {
      conn.inFlight += 1;
      this.leaseIndex.set(repository, conn);
    }
    return repository;
  }

  /**
   * Release a lease taken by `acquire`. Idempotent: calling `release` without
   * a matching `acquire` is a no-op (inFlight is clamped at 0). Also refreshes
   * `lastAccessed` so a freshly-released connection isn't immediately eligible
   * for eviction by an already-elapsed idle window.
   *
   * Pass the acquired `repository` when the caller may outlive a
   * `closeConnection()` on the same workspace (reconnect paths): it routes the
   * decrement to the exact — possibly retired — connection that was acquired,
   * and closes a retired driver once its last lease drains.
   */
  release(workspaceId: string, repository?: IGraphRepository): void {
    const conn = (repository && this.leaseIndex.get(repository)) || this.connections.get(workspaceId);
    if (!conn) return;
    conn.inFlight = Math.max(0, conn.inFlight - 1);
    conn.lastAccessed = Date.now();
    if (conn.retiredAt !== undefined && conn.inFlight === 0) {
      this.closeRetired(workspaceId, conn);
    }
  }

  private closeRetired(workspaceId: string, conn: WorkspaceConnection): void {
    if (conn.retiredAt === undefined) return;
    // Clear the marker before starting the async close so a duplicated release
    // cannot close the same driver twice through the repository WeakMap.
    conn.retiredAt = undefined;
    const list = this.retired.get(workspaceId);
    if (list) {
      const remaining = list.filter((entry) => entry !== conn);
      if (remaining.length > 0) this.retired.set(workspaceId, remaining);
      else this.retired.delete(workspaceId);
    }
    conn.driver.close().catch((err) => {
      this.logger.error(`Error closing retired connection for workspace ${workspaceId}`, err);
    });
    this.logger.log(`Closed retired connection for workspace ${workspaceId} after last lease drained`);
  }

  /**
   * Run `fn` against a leased repository. Recommended pattern for any operation
   * that holds the repository for more than a few seconds — guarantees the
   * lease is released on throw without callers needing to write try/finally.
   *
   * Throws when no database is available for the workspace.
   */
  async withRepository<T>(
    workspaceId: string,
    workspaceSlug: string,
    fn: (repository: IGraphRepository) => Promise<T>,
  ): Promise<T> {
    const repository = await this.acquire(workspaceId, workspaceSlug);
    if (!repository) {
      throw new Error(`No database available for workspace ${workspaceSlug}`);
    }
    try {
      return await fn(repository);
    } finally {
      this.release(workspaceId, repository);
    }
  }

  /**
   * Remove a workspace's connection so the next acquire builds a fresh driver.
   * Closes the driver immediately only when no lease is outstanding; otherwise
   * the connection is retired and its driver closes when the last holder
   * releases — closing under a concurrent holder is the 2026-05-24
   * TRANSACTION_CLOSED cascade this pool exists to prevent.
   */
  async closeConnection(workspaceId: string): Promise<void> {
    const conn = this.connections.get(workspaceId);
    if (!conn) return;
    this.connections.delete(workspaceId);
    if (conn.inFlight === 0) {
      await conn.driver.close();
      return;
    }
    conn.retiredAt = Date.now();
    const list = this.retired.get(workspaceId) ?? [];
    list.push(conn);
    this.retired.set(workspaceId, list);
    this.logger.warn(
      `Retired connection for workspace ${workspaceId} with ${conn.inFlight} lease(s) outstanding; will close on drain`,
    );
  }

  /**
   * Close all connections in the pool.
   */
  async closeAll(): Promise<void> {
    const entries: Array<[string, WorkspaceConnection]> = [
      ...this.connections.entries(),
      ...[...this.retired.entries()].flatMap(([workspaceId, conns]) =>
        conns.map((conn): [string, WorkspaceConnection] => [workspaceId, conn]),
      ),
    ];
    const closeTasks = entries.map(async ([workspaceId, conn]) => {
      try {
        await conn.driver.close();
      } catch (error) {
        this.logger.error(`Error closing connection for workspace ${workspaceId}`, error);
      }
    });
    await Promise.all(closeTasks);
    this.connections.clear();
    this.retired.clear();
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  /**
   * Whether the data plane is a single shared Neo4j graph (on-prem deployment)
   * rather than per-workspace Turso/SQLite. The backend is fixed for the process
   * lifetime, so it is read once from the boot-validated config.
   *
   * MUST stay in sync with @coredoc/db's `getConfiguredBackend()`: only the
   * literal lowercased "neo4j" routes to Neo4j. Compared inline (rather than
   * importing getConfiguredBackend) so the proven SQLite hot path never eagerly
   * loads the @coredoc/db module index just to branch.
   */
  private isNeo4jBackend(): boolean {
    return this.storage.dbBackend.toLowerCase() === 'neo4j';
  }

  private async createConnection(workspaceId: string, url: string, token: string): Promise<IGraphRepository> {
    // Dynamically import to avoid circular dependencies and allow tree-shaking
    const { SqliteDriver } = await import('@coredoc/db/sqlite');
    const { SqliteRepository } = await import('@coredoc/db');

    const driver = new SqliteDriver(url, token);
    await driver.initialize();

    const repository = new SqliteRepository(driver);

    this.connections.set(workspaceId, {
      driver,
      repository,
      lastAccessed: Date.now(),
      inFlight: 0,
    });

    this.logger.log(`Created database connection for workspace ${workspaceId}`);
    return repository;
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [workspaceId, conn] of this.connections) {
      // Never evict a connection that's actively leased — closing the driver
      // mid-statement was the eviction-race bug of 2026-05-24.
      if (conn.inFlight > 0) continue;
      if (now - conn.lastAccessed > this.maxIdleMs) {
        conn.driver.close().catch((err) => {
          this.logger.error(`Error evicting connection for workspace ${workspaceId}`, err);
        });
        this.connections.delete(workspaceId);
        this.logger.log(`Evicted idle connection for workspace ${workspaceId}`);
      }
    }
  }
}
