import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  GRAPH_READ_CAPABILITY_IDENTITY,
  type IGraphReadRepository,
} from '@coredoc/db';
import type { Request } from 'express';
import type { ControlPlaneService } from '../database/control-plane.service.js';
import type { WorkspaceDbPoolService } from '../database/workspace-db-pool.service.js';
import type { WorkspaceFileCacheService } from '../database/workspace-file-cache.service.js';
import { WorkspaceMcpContextService } from './workspace-mcp-context.service.js';

function makeDeps() {
  const workspaceDbPool = { getRepository: vi.fn() } as unknown as WorkspaceDbPoolService;
  const controlPlane = {
    getWorkspaceById: vi.fn(),
    getWorkspaceGraphVersion: vi.fn(),
    listRepos: vi.fn().mockResolvedValue([{ repoName: 'api-server', repoKey: 'hashcore' }]),
  } as unknown as ControlPlaneService;
  const fileCache = {
    acquire: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceFileCacheService;
  return { workspaceDbPool, controlPlane, fileCache };
}

const VERSION = {
  workspaceId: 'ws-1',
  versionId: 'v1',
  engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
  r2Key: 'ws-1/v1.graph',
  sha256: 'a'.repeat(64),
  sizeBytes: 42n,
  storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
};

describe('WorkspaceMcpContextService', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: WorkspaceMcpContextService;

  beforeEach(() => {
    deps = makeDeps();
    service = new WorkspaceMcpContextService(deps.workspaceDbPool, deps.controlPlane, deps.fileCache);
  });

  it('keeps the Turso path byte-compatible and never touches the file cache', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
      activeGraphVersionId: null,
    });
    const repository = { findCode: vi.fn().mockResolvedValue(['turso-result']) };
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue(repository);
    const callback = vi.fn().mockImplementation(async (context) => {
      const rows = await context.repository.findCode({ pattern: 'turso' }, []);
      return { rows, versionId: context.versionId, hashes: context.scope.repoHashes };
    });

    const result = await service.withContextByWorkspaceId('ws-1', callback);

    expect(deps.workspaceDbPool.getRepository).toHaveBeenCalledWith('ws-1', 'acme');
    expect(deps.fileCache.acquire).not.toHaveBeenCalled();
    expect(deps.fileCache.release).not.toHaveBeenCalled();
    expect(result).toEqual({ rows: ['turso-result'], versionId: null, hashes: ['hashcore'] });
  });

  it('refuses an unrecognised graphBackend without touching either plane', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'postgres',
      activeGraphVersionId: null,
    });
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue({ findCode: vi.fn() });

    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toMatchObject({
      name: 'WorkspaceGraphContextError',
      code: 'UNSUPPORTED_BACKEND',
    });

    expect(deps.workspaceDbPool.getRepository).not.toHaveBeenCalled();
    expect(deps.fileCache.acquire).not.toHaveBeenCalled();
  });

  it('uses the file snapshot when graphBackend is absent', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValue(VERSION);
    (deps.fileCache.acquire as any).mockResolvedValue({ repository: { findCode: vi.fn() }, versionId: 'v1' });

    await expect(service.withContextByWorkspaceId('ws-1', async ({ graphBackend }) => graphBackend)).resolves.toBe(
      'file_snapshot',
    );

    expect(deps.workspaceDbPool.getRepository).not.toHaveBeenCalled();
    expect(deps.fileCache.acquire).toHaveBeenCalledOnce();
    expect(deps.fileCache.release).toHaveBeenCalledOnce();
  });

  it('keeps one opaque memo identity across scoped facades for the same graph capability', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
    });
    const source = { findCode: vi.fn() } as unknown as IGraphReadRepository;
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue(source);
    const identities: object[] = [];
    const capture = ({ repository }: { repository: IGraphReadRepository }) => {
      const identity = (
        repository as IGraphReadRepository & {
          readonly [GRAPH_READ_CAPABILITY_IDENTITY]?: object;
        }
      )[GRAPH_READ_CAPABILITY_IDENTITY];
      if (identity) identities.push(identity);
    };

    await service.withContextByWorkspaceId('ws-1', capture);
    await service.withContextByWorkspaceId('ws-1', capture);

    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
    expect(identities[0]).not.toBe(source);
  });

  it('carries both optional Cypher methods onto the facade only when the graph implements them', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
    });
    const capable = {
      findCode: vi.fn(),
      runReadOnlyCypher: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
      runReadOnlyCypherRows: vi.fn().mockResolvedValue({ columns: [], rows: [], truncated: false }),
    };
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue(capable);

    await service.withContextByWorkspaceId('ws-1', async ({ repository }) => {
      const facade = repository as unknown as Record<string, unknown>;
      expect(typeof facade.runReadOnlyCypher).toBe('function');
      expect(typeof facade.runReadOnlyCypherRows).toBe('function');
      await (facade.runReadOnlyCypherRows as (q: string, o: unknown) => Promise<unknown>)('MATCH (n) RETURN 1 AS one', {
        limit: 5,
      });
    });
    expect(capable.runReadOnlyCypherRows).toHaveBeenCalledWith('MATCH (n) RETURN 1 AS one', { limit: 5 });

    // A Cypher-less graph (Turso) must not gain a callable it cannot honor.
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue({ findCode: vi.fn() });
    await service.withContextByWorkspaceId('ws-1', async ({ repository }) => {
      const facade = repository as unknown as Record<string, unknown>;
      expect(facade.runReadOnlyCypher).toBeUndefined();
      expect(facade.runReadOnlyCypherRows).toBeUndefined();
    });
  });

  it('proxies the optional package-linker projection only for the context lifetime', async () => {
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
    });
    const getPackageLinkerFacts = vi.fn().mockResolvedValue({ files: [], declarations: [] });
    (deps.workspaceDbPool.getRepository as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      findCode: vi.fn(),
      getPackageLinkerFacts,
    });
    let escapedRepository: IGraphReadRepository | undefined;

    await service.withContextByWorkspaceId('ws-1', async ({ repository }) => {
      escapedRepository = repository;
      expect(typeof repository.getPackageLinkerFacts).toBe('function');
      await expect(repository.getPackageLinkerFacts?.(['hashcore'])).resolves.toEqual({
        files: [],
        declarations: [],
      });
    });

    expect(getPackageLinkerFacts).toHaveBeenCalledWith(['hashcore']);
    expect(() => escapedRepository?.getPackageLinkerFacts?.(['hashcore'])).toThrow(/outside its context callback/);
  });

  it('reports the resolved graph backend so a tool can name it in a capability error', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({ id: 'ws-1', slug: 'acme', graphBackend: 'turso' });
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue({ findCode: vi.fn() });
    await expect(service.withContextByWorkspaceId('ws-1', async ({ graphBackend }) => graphBackend)).resolves.toBe(
      'turso',
    );

    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValue(VERSION);
    (deps.fileCache.acquire as any).mockResolvedValue({ repository: { findCode: vi.fn() }, versionId: 'v1' });
    await expect(service.withContextByWorkspaceId('ws-1', async ({ graphBackend }) => graphBackend)).resolves.toBe(
      'file_snapshot',
    );
  });

  it('captures the file version once and releases the exact lease after success', async () => {
    const workspace = {
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    };
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue(workspace);
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockImplementation(async () => {
      workspace.activeGraphVersionId = 'v2';
      return VERSION;
    });
    const repository = { driver: { native: true }, findCode: vi.fn().mockResolvedValue(['file-result']) };
    const lease = { repository, versionId: 'v1' };
    (deps.fileCache.acquire as any).mockResolvedValue(lease);
    const order: string[] = [];
    (deps.fileCache.release as any).mockImplementation(async (released) => {
      expect(released).toBe(lease);
      order.push('release');
    });

    let escapedRepository: IGraphReadRepository | undefined;
    const result = await service.withContextByWorkspaceId('ws-1', async (context) => {
      order.push('callback');
      escapedRepository = context.repository;
      expect(context.repository).not.toBe(repository);
      expect((context.repository as unknown as { driver?: unknown }).driver).toBeUndefined();
      expect(Object.getPrototypeOf(context.repository)).toBeNull();
      await expect(context.repository.findCode({ pattern: 'file' }, [])).resolves.toEqual(['file-result']);
      expect(context.versionId).toBe('v1');
      return 'done';
    });

    expect(result).toBe('done');
    expect(deps.controlPlane.getWorkspaceById).toHaveBeenCalledTimes(1);
    expect(deps.controlPlane.getWorkspaceGraphVersion).toHaveBeenCalledWith('ws-1', 'v1');
    expect(deps.fileCache.acquire).toHaveBeenCalledWith(VERSION);
    expect(deps.workspaceDbPool.getRepository).not.toHaveBeenCalled();
    expect(deps.fileCache.release).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['callback', 'release']);
    expect(() => escapedRepository?.findCode({ pattern: 'file' }, [])).toThrow(/outside its context callback/);
  });

  it('drains an unawaited repository promise nested in callback data before releasing the lease', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValue(VERSION);
    let finishQuery!: (rows: never[]) => void;
    const query = new Promise<never[]>((resolve) => {
      finishQuery = resolve;
    });
    const repository = { driver: { native: true }, findCode: vi.fn(() => query) };
    const lease = { repository, versionId: 'v1' };
    (deps.fileCache.acquire as any).mockResolvedValue(lease);
    let callbackReturned!: () => void;
    const returned = new Promise<void>((resolve) => {
      callbackReturned = resolve;
    });
    let contextSettled = false;

    const operation = service.withContextByWorkspaceId('ws-1', async (context) => {
      const pending = context.repository.findCode({ pattern: 'nested' }, []);
      callbackReturned();
      return { pending };
    });
    void operation.then(() => {
      contextSettled = true;
    });
    await returned;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(contextSettled).toBe(false);
    expect(deps.fileCache.release).not.toHaveBeenCalled();
    finishQuery([]);

    const result = await operation;
    await expect(result.pending).resolves.toEqual([]);
    expect(deps.fileCache.release).toHaveBeenCalledWith(lease);
  });

  it('releases the file lease when repo listing or the callback throws', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValue(VERSION);
    const lease = { repository: { findCode: vi.fn() }, versionId: 'v1' };
    (deps.fileCache.acquire as any).mockResolvedValue(lease);
    (deps.controlPlane.listRepos as any).mockRejectedValueOnce(new Error('repo read failed'));

    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow('repo read failed');
    expect(deps.fileCache.release).toHaveBeenLastCalledWith(lease);

    (deps.controlPlane.listRepos as any).mockResolvedValue([]);
    (deps.fileCache.release as any).mockRejectedValueOnce(new Error('release failed'));
    await expect(
      service.withContextByWorkspaceId('ws-1', async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(deps.fileCache.release).toHaveBeenCalledTimes(2);
  });

  it('releases an acquired lease if construction of the read facade fails', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValue(VERSION);
    const repository = {};
    Object.defineProperty(repository, 'findCode', {
      get() {
        throw new Error('malicious repository getter');
      },
    });
    const lease = { repository, versionId: 'v1' };
    (deps.fileCache.acquire as any).mockResolvedValue(lease);

    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow('malicious repository getter');
    expect((deps.fileCache.release as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(lease);
  });

  it('observes pointer flips and rollback only on request boundaries', async () => {
    const pointers = ['v1', 'v2', 'v1'];
    (deps.controlPlane.getWorkspaceById as any).mockImplementation(async () => ({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: pointers.shift(),
    }));
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockImplementation(async (workspaceId, versionId) => ({
      ...VERSION,
      workspaceId,
      versionId,
      r2Key: `${workspaceId}/${versionId}.graph`,
    }));
    (deps.fileCache.acquire as any).mockImplementation(async (descriptor) => ({
      repository: { version: descriptor.versionId },
      versionId: descriptor.versionId,
    }));

    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      seen.push(await service.withContextByWorkspaceId('ws-1', async ({ versionId }) => versionId));
    }

    expect(seen).toEqual(['v1', 'v2', 'v1']);
    expect(deps.controlPlane.getWorkspaceGraphVersion).toHaveBeenNthCalledWith(1, 'ws-1', 'v1');
    expect(deps.controlPlane.getWorkspaceGraphVersion).toHaveBeenNthCalledWith(2, 'ws-1', 'v2');
    expect(deps.controlPlane.getWorkspaceGraphVersion).toHaveBeenNthCalledWith(3, 'ws-1', 'v1');
  });

  it('extracts workspaceId from the request and rejects missing identity', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValue({ id: 'ws-1', slug: 'acme', graphBackend: 'turso' });
    (deps.workspaceDbPool.getRepository as any).mockResolvedValue({ findCode: vi.fn() });

    await expect(service.withContext({ workspaceId: 'ws-1' } as unknown as Request, async () => 'ok')).resolves.toBe(
      'ok',
    );
    await expect(service.withContext({} as Request, vi.fn())).rejects.toThrow('Missing workspaceId on request');
  });

  it('fails closed for missing workspace, database, pointer, version, or unsupported mode', async () => {
    (deps.controlPlane.getWorkspaceById as any).mockResolvedValueOnce(null);
    await expect(service.withContextByWorkspaceId('missing', vi.fn())).rejects.toThrow('Workspace not found: missing');

    (deps.controlPlane.getWorkspaceById as any).mockResolvedValueOnce({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'turso',
    });
    (deps.workspaceDbPool.getRepository as any).mockResolvedValueOnce(null);
    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow(
      'No database available for workspace: acme',
    );

    (deps.controlPlane.getWorkspaceById as any).mockResolvedValueOnce({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: null,
    });
    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow('has no active graph version');

    (deps.controlPlane.getWorkspaceById as any).mockResolvedValueOnce({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as any).mockResolvedValueOnce(null);
    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow('Graph version not found: ws-1/v1');

    (deps.controlPlane.getWorkspaceById as any).mockResolvedValueOnce({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'future_backend',
      activeGraphVersionId: null,
    });
    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toThrow(
      'Unsupported graph backend: future_backend',
    );
  });

  it('rejects a non-compatible graph engine before acquiring the object-backed cache', async () => {
    (deps.controlPlane.getWorkspaceById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ws-1',
      slug: 'acme',
      graphBackend: 'file_snapshot',
      activeGraphVersionId: 'v1',
    });
    (deps.controlPlane.getWorkspaceGraphVersion as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...VERSION,
      engine: 'sqlite',
    });

    await expect(service.withContextByWorkspaceId('ws-1', vi.fn())).rejects.toMatchObject({
      code: 'UNSUPPORTED_ENGINE',
    });
    expect(deps.fileCache.acquire).not.toHaveBeenCalled();
  });
});
