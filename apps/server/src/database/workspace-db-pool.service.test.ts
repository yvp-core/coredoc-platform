import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceDbPoolService } from './workspace-db-pool.service.js';
import type { TursoProvisioningService } from './turso-provisioning.service.js';
import type { IDatabaseDriver, IGraphRepository } from '@coredoc/db';

// Shared singleton the on-prem Neo4j path should hand back from the backend-factory.
const { sharedRepo, getRepositoryMock } = vi.hoisted(() => {
  const sharedRepo = { __shared: 'neo4j' } as unknown as IGraphRepository;
  return { sharedRepo, getRepositoryMock: vi.fn(async (_backend?: string) => sharedRepo) };
});

// Override only `getRepository`; keep every other real export so the transitively
// loaded turso-provisioning module (and any @coredoc/db consumer) is unaffected.
vi.mock('@coredoc/db', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/db')>();
  return { ...actual, getRepository: getRepositoryMock };
});

/**
 * Regression coverage for the 2026-05-24 eviction race: the pool was closing
 * a workspace's libsql driver from under an actively-running push because
 * `lastAccessed` was only refreshed on `getRepository`, not per-statement.
 * The `inFlight` refcount fixes this by making `evictIdle` skip any
 * connection that's currently leased.
 *
 * Manually seeds the internal connections Map to avoid mocking the dynamic
 * imports inside `createConnection` (SqliteDriver / SqliteRepository).
 */
describe('WorkspaceDbPoolService — eviction race protection', () => {
  let service: WorkspaceDbPoolService;
  let tursoProvisioning: TursoProvisioningService;
  let closeMock: ReturnType<typeof vi.fn>;
  let driver: IDatabaseDriver;
  let repository: IGraphRepository;

  beforeEach(() => {
    tursoProvisioning = {
      ensureDatabase: vi.fn(),
    } as unknown as TursoProvisioningService;
    service = new WorkspaceDbPoolService(tursoProvisioning);

    closeMock = vi.fn(async () => {});
    driver = { close: closeMock } as unknown as IDatabaseDriver;
    repository = {} as IGraphRepository;
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  function seedConnection(workspaceId: string, opts: { inFlight: number; lastAccessedMsAgo: number }) {
    // Access the private `connections` map. Manual seeding avoids the
    // dynamic-import + libsql initialization that real `createConnection` does.
    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    connections.set(workspaceId, {
      driver,
      repository,
      lastAccessed: Date.now() - opts.lastAccessedMsAgo,
      inFlight: opts.inFlight,
    });
  }

  function invokeEvictIdle() {
    (service as unknown as { evictIdle: () => void }).evictIdle();
  }

  it('does NOT evict a connection while inFlight > 0, even past the idle threshold', () => {
    seedConnection('ws_active', {
      inFlight: 1,
      // 2 hours in the past — well past the 60min maxIdleMs default.
      lastAccessedMsAgo: 2 * 60 * 60 * 1000,
    });

    invokeEvictIdle();

    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws_active')).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('evicts a connection once inFlight drops to 0 and idle threshold elapsed', () => {
    seedConnection('ws_idle', {
      inFlight: 0,
      lastAccessedMsAgo: 2 * 60 * 60 * 1000,
    });

    invokeEvictIdle();

    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws_idle')).toBe(false);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT evict a connection that is recently accessed (inFlight=0, fresh)', () => {
    seedConnection('ws_fresh', {
      inFlight: 0,
      lastAccessedMsAgo: 1000, // 1 second
    });

    invokeEvictIdle();

    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws_fresh')).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('release() refreshes lastAccessed so just-released connections are not immediately evicted', () => {
    seedConnection('ws_just_released', {
      inFlight: 1,
      lastAccessedMsAgo: 2 * 60 * 60 * 1000,
    });

    // Simulate the end of a long-running push: release the lease.
    service.release('ws_just_released');

    // Eviction now sees inFlight=0 but lastAccessed=now → keep it.
    invokeEvictIdle();

    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws_just_released')).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('release() is idempotent — calling on missing or zero-inFlight connection is a no-op', () => {
    // No connection seeded — release should not throw.
    expect(() => service.release('ws_missing')).not.toThrow();

    seedConnection('ws_zero', { inFlight: 0, lastAccessedMsAgo: 0 });
    expect(() => service.release('ws_zero')).not.toThrow();

    const conn = (service as unknown as { connections: Map<string, { inFlight: number }> }).connections.get('ws_zero');
    expect(conn?.inFlight).toBe(0);
  });

  it('retires a broken connection and closes it only after every exact repository lease drains', async () => {
    seedConnection('ws_reconnect', { inFlight: 0, lastAccessedMsAgo: 0 });
    const firstLease = await service.acquire('ws_reconnect', 'slug');
    const secondLease = await service.acquire('ws_reconnect', 'slug');
    expect(firstLease).toBe(repository);
    expect(secondLease).toBe(repository);

    await service.closeConnection('ws_reconnect');

    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws_reconnect')).toBe(false);
    expect(closeMock).not.toHaveBeenCalled();

    service.release('ws_reconnect', firstLease!);
    expect(closeMock).not.toHaveBeenCalled();

    service.release('ws_reconnect', secondLease!);
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));

    // A duplicated release is harmless and cannot close the retired driver a
    // second time through the repository→connection index.
    service.release('ws_reconnect', secondLease!);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * On-prem single-tenant Neo4j: the pool must skip per-workspace Turso provisioning
 * and hand back the backend-factory's shared graph singleton, WITHOUT caching it in
 * the evictable connections map (closing the shared driver on idle eviction would
 * tear it down for every other workspace).
 */
describe('WorkspaceDbPoolService — single-tenant Neo4j routing', () => {
  let service: WorkspaceDbPoolService;
  let tursoProvisioning: TursoProvisioningService;
  const prevBackend = process.env.COREDOC_DB_BACKEND;

  beforeEach(() => {
    getRepositoryMock.mockClear();
    tursoProvisioning = { ensureDatabase: vi.fn() } as unknown as TursoProvisioningService;
    // The backend is read once, at construction, from the validated config.
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    service = new WorkspaceDbPoolService(tursoProvisioning);
  });

  afterEach(async () => {
    if (prevBackend === undefined) delete process.env.COREDOC_DB_BACKEND;
    else process.env.COREDOC_DB_BACKEND = prevBackend;
    await service.onModuleDestroy();
  });

  it('returns the shared backend-factory repository — no Turso provisioning, no caching', async () => {
    const repo = await service.getRepository('ws1', 'slug1');

    expect(repo).toBe(sharedRepo);
    expect(getRepositoryMock).toHaveBeenCalledWith('neo4j');
    // No per-workspace provisioning on the on-prem path.
    expect(tursoProvisioning.ensureDatabase).not.toHaveBeenCalled();
    // The shared driver must NOT land in the evictable connections map.
    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws1')).toBe(false);
  });

  it('acquire/release degrade to safe no-ops on the shared repo (no lease, never evicted)', async () => {
    const repo = await service.acquire('ws1', 'slug1');
    expect(repo).toBe(sharedRepo);
    // No cache entry → nothing to lease; release must not throw.
    expect(() => service.release('ws1')).not.toThrow();
    const connections = (service as unknown as { connections: Map<string, unknown> }).connections;
    expect(connections.has('ws1')).toBe(false);
  });

  it('falls back to Turso provisioning when the backend is not neo4j', async () => {
    process.env.COREDOC_DB_BACKEND = 'sqlite';
    service = new WorkspaceDbPoolService(tursoProvisioning);
    (tursoProvisioning.ensureDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const repo = await service.getRepository('ws2', 'slug2');

    // sqlite path consults Turso provisioning; null → no database available.
    expect(tursoProvisioning.ensureDatabase).toHaveBeenCalledWith('ws2', 'slug2');
    expect(getRepositoryMock).not.toHaveBeenCalled();
    expect(repo).toBeNull();
  });
});
