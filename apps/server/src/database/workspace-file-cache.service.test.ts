import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { GRAPH_FILE_FORMAT_COMPATIBILITY, type GraphFileHandle, type IGraphReadRepository } from '@coredoc/db';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R2StorageService } from './r2-storage.service.js';
import {
  WORKSPACE_FILE_CACHE_OPTIONS,
  WorkspaceFileCacheError,
  WorkspaceFileCacheService,
  type WorkspaceGraphFileDescriptor,
} from './workspace-file-cache.service.js';

const { openGraphFileMock } = vi.hoisted(() => ({ openGraphFileMock: vi.fn() }));

vi.mock('@coredoc/db', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/db')>();
  return { ...actual, openGraphFile: openGraphFileMock };
});

const roots: string[] = [];
const services: WorkspaceFileCacheService[] = [];

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function descriptor(
  versionId: string,
  bytes: Uint8Array,
  overrides: Partial<WorkspaceGraphFileDescriptor> = {},
): WorkspaceGraphFileDescriptor {
  return {
    workspaceId: 'workspace-a',
    versionId,
    engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
    r2Key: `workspace-a/graphs/${versionId}.graph`,
    sha256: sha256(bytes),
    sizeBytes: BigInt(bytes.byteLength),
    storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
    ...overrides,
  };
}

function compatibilityMetadata(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
    engineversion: GRAPH_FILE_FORMAT_COMPATIBILITY.engineVersion,
    schemaversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.graphSchemaVersion),
    builderversion: GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
    storageformatversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion),
    ...overrides,
  };
}

function streamingStorage(objects: Map<string, Uint8Array>, metadataOverrides: Readonly<Record<string, string>> = {}) {
  return {
    download: vi.fn(),
    headObject: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        contentLength: bytes.byteLength,
        contentType: 'application/vnd.coredoc.ladybug',
        etag: null,
        lastModified: null,
        metadata: compatibilityMetadata(metadataOverrides),
      };
    }),
    downloadStream: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return (async function* () {
        const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
        yield bytes.subarray(0, midpoint);
        if (midpoint < bytes.byteLength) yield bytes.subarray(midpoint);
      })();
    }),
  };
}

function ensureCompatibilityHead<
  T extends { download: ReturnType<typeof vi.fn>; downloadStream: ReturnType<typeof vi.fn> },
>(storage: T): T & { headObject: ReturnType<typeof vi.fn> } {
  if (!('headObject' in storage)) {
    Object.assign(storage, {
      // R2's local fallback intentionally has no custom object metadata. The
      // reader accepts that legacy/local shape while requiring an exact match
      // whenever compatibility metadata is present.
      headObject: vi.fn(async () => ({
        contentLength: null,
        contentType: null,
        etag: null,
        lastModified: null,
        metadata: {},
      })),
    });
  }
  return storage as T & { headObject: ReturnType<typeof vi.fn> };
}

function createService(
  storage:
    | ReturnType<typeof streamingStorage>
    | { download: ReturnType<typeof vi.fn>; downloadStream: ReturnType<typeof vi.fn> },
  overrides: Partial<ConstructorParameters<typeof WorkspaceFileCacheService>[1]> = {},
): WorkspaceFileCacheService {
  const cacheDir = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-'));
  roots.push(cacheDir);
  const service = new WorkspaceFileCacheService(ensureCompatibilityHead(storage) as unknown as R2StorageService, {
    cacheDir,
    maxOpenHandles: 4,
    maxCacheBytes: 16 * 1024 ** 2,
    downloadTimeoutMs: 1_000,
    budgets: {
      maxDbSizeBytes: 1024 ** 3,
      bufferPoolBytes: 256 * 1024 ** 2,
      queryTimeoutMs: 5_000,
    },
    ...overrides,
  });
  services.push(service);
  return service;
}

function cacheDirOf(service: WorkspaceFileCacheService): string {
  return (service as unknown as { options: { cacheDir: string } }).options.cacheDir;
}

function partialFiles(service: WorkspaceFileCacheService, versionId: string): string[] {
  const workspaceDir = join(cacheDirOf(service), 'workspace-a');
  if (!existsSync(workspaceDir)) return [];
  return readdirSync(workspaceDir).filter(
    (name) => name === `${versionId}.partial` || (name.startsWith(`${versionId}.`) && name.endsWith('.partial')),
  );
}

function createSiblingService(
  source: WorkspaceFileCacheService,
  storage:
    | ReturnType<typeof streamingStorage>
    | { download: ReturnType<typeof vi.fn>; downloadStream: ReturnType<typeof vi.fn> },
): WorkspaceFileCacheService {
  const service = new WorkspaceFileCacheService(ensureCompatibilityHead(storage) as unknown as R2StorageService, {
    ...(source as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] }).options,
    cacheDir: cacheDirOf(source),
  });
  services.push(service);
  return service;
}

beforeEach(() => {
  openGraphFileMock.mockReset();
  openGraphFileMock.mockImplementation(async (options: { path: string }) => {
    const repository = { artifact: basename(options.path) } as unknown as IGraphReadRepository;
    return { repository, close: vi.fn(async () => undefined) } satisfies GraphFileHandle<IGraphReadRepository>;
  });
});

afterEach(async () => {
  while (services.length > 0) await services.pop()?.onModuleDestroy();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('WorkspaceFileCacheService', () => {
  it('default reader capacity accepts the publisher 5-GiB boundary and rejects one byte over', async () => {
    const storage = streamingStorage(new Map());
    const cacheDir = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-boundary-'));
    roots.push(cacheDir);
    const service = new WorkspaceFileCacheService(storage as unknown as R2StorageService, { cacheDir });
    services.push(service);
    const internals = service as unknown as {
      options: { maxCacheBytes: number };
      reserveCapacity(sizeBytes: bigint, protectedPath: string): Promise<void>;
    };
    const publisherMaximum = 5n * 1024n * 1024n * 1024n;

    expect(internals.options.maxCacheBytes).toBe(Number(publisherMaximum));
    await expect(internals.reserveCapacity(publisherMaximum, join(cacheDir, 'max.ladybug'))).resolves.toBeUndefined();
    await expect(
      internals.reserveCapacity(publisherMaximum + 1n, join(cacheDir, 'too-large.ladybug')),
    ).rejects.toMatchObject({ code: 'CACHE_CAPACITY' });
  });

  it('normalizes an unexpected initialization errno at the public acquire boundary', async () => {
    const bytes = Buffer.from('initialization fault');
    const item = descriptor('init-fault', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage);
    vi.spyOn(service as unknown as { ensureInitialized(): Promise<void> }, 'ensureInitialized').mockRejectedValueOnce(
      Object.assign(new Error('filesystem unavailable'), { code: 'EIO' }),
    );

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });

  it('singleflights concurrent cold opens, streams once, and issues one exact lease per waiter', async () => {
    const bytes = Buffer.from('one immutable graph artifact');
    const item = descriptor('version-1', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage);

    const leases = await Promise.all(Array.from({ length: 8 }, () => service.acquire(item)));

    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    expect(storage.download).not.toHaveBeenCalled();
    expect(openGraphFileMock).toHaveBeenCalledTimes(1);
    expect(new Set(leases).size).toBe(8);
    expect(new Set(leases.map((lease) => lease.repository)).size).toBe(1);
    expect(leases.every((lease) => lease.versionId === 'version-1')).toBe(true);
    const finalPath = join(cacheDirOf(service), 'workspace-a', 'version-1.graph');
    expect(readFileSync(finalPath)).toEqual(bytes);
    expect(partialFiles(service, 'version-1')).toEqual([]);

    await Promise.all(leases.map((lease) => service.release(lease)));
  });

  it('rejects corrupt and truncated streams before opening or committing a final artifact', async () => {
    const bytes = Buffer.from('actual bytes');
    const cases: WorkspaceGraphFileDescriptor[] = [
      descriptor('bad-hash', bytes, { sha256: '0'.repeat(64) }),
      descriptor('bad-size', bytes, { sizeBytes: BigInt(bytes.byteLength + 1) }),
    ];

    for (const item of cases) {
      const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
      const service = createService(storage);
      await expect(service.acquire(item)).rejects.toMatchObject({ code: 'INTEGRITY' });
      expect(openGraphFileMock).not.toHaveBeenCalled();
      expect(existsSync(join(cacheDirOf(service), 'workspace-a', `${item.versionId}.graph`))).toBe(false);
      expect(partialFiles(service, item.versionId)).toEqual([]);
    }
  });

  it('cleans an iterator failure before any artifact can be opened', async () => {
    const bytes = Buffer.from('iterator disconnect');
    const item = descriptor('iterator-failure', bytes);
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const storage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () => ({
        [Symbol.asyncIterator]() {
          let first = true;
          return {
            next: async () => {
              if (first) {
                first = false;
                return { done: false as const, value: bytes.subarray(0, 4) };
              }
              throw new Error('socket disconnected');
            },
            return: iteratorReturn,
          };
        },
      })),
    };
    const service = createService(storage);

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });

    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(partialFiles(service, 'iterator-failure')).toEqual([]);
    expect(existsSync(join(workspaceDir, 'iterator-failure.graph'))).toBe(false);
    expect(openGraphFileMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled body iterator with a typed timeout and no hidden retry', async () => {
    const bytes = Buffer.from('never delivered');
    const item = descriptor('stalled', bytes);
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const storage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
            return: iteratorReturn,
          };
        },
      })),
    };
    const service = createService(storage, { downloadTimeoutMs: 25 });
    const startedAt = Date.now();

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(openGraphFileMock).not.toHaveBeenCalled();
    expect(partialFiles(service, 'stalled')).toEqual([]);
  });

  it('allows a download to keep making progress beyond the idle timeout', async () => {
    const bytes = Buffer.from('slow but continuously progressing graph');
    const item = descriptor('slow-progress', bytes);
    const storage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () =>
        (async function* () {
          const chunkSize = Math.ceil(bytes.length / 3);
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            // The invariant is the RATIO: every inter-chunk gap stays under the
            // idle timeout while the whole download exceeds it (3×150 > 400), so
            // per-chunk progress must reset the timer. 150/400 leaves ~250ms of
            // scheduling headroom — the old 40/100 margin flaked under a full
            // parallel `pnpm test`, where a 40ms setTimeout routinely fires late.
            await new Promise((resolve) => setTimeout(resolve, 150));
            yield bytes.subarray(offset, offset + chunkSize);
          }
        })(),
      ),
    };
    const service = createService(storage, { downloadTimeoutMs: 400 });

    const lease = await service.acquire(item);

    expect(readFileSync(join(cacheDirOf(service), 'workspace-a', 'slow-progress.graph'))).toEqual(bytes);
    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    expect(partialFiles(service, 'slow-progress')).toEqual([]);
    await service.release(lease);
  });

  it('normalizes an abort-aware body rejection to the typed download timeout', async () => {
    const bytes = Buffer.from('abort-aware body');
    const item = descriptor('abort-aware', bytes);
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const storage = {
      download: vi.fn(),
      downloadStream: vi.fn(async (_key: string, options: { signal?: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
                options.signal?.addEventListener(
                  'abort',
                  () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })),
                  { once: true },
                );
              }),
            return: iteratorReturn,
          };
        },
      })),
    };
    const service = createService(storage, { downloadTimeoutMs: 25 });

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });

    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(openGraphFileMock).not.toHaveBeenCalled();
    expect(partialFiles(service, 'abort-aware')).toEqual([]);
  });

  it('does not arm a rejecting download deadline during pre-GET filesystem setup', async () => {
    const bytes = Buffer.from('body stalls after setup');
    const item = descriptor('slow-setup', bytes);
    const storage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
            return: vi.fn(async () => ({ done: true, value: undefined })),
          };
        },
      })),
    };
    const service = createService(storage, { downloadTimeoutMs: 20 });
    await service.onModuleInit();
    const internal = service as unknown as {
      ensurePrivateDirectory(path: string): Promise<void>;
    };
    const realEnsurePrivateDirectory = internal.ensurePrivateDirectory.bind(service);
    vi.spyOn(internal, 'ensurePrivateDirectory').mockImplementationOnce(async (path) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await realEnsurePrivateDirectory(path);
    });
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      await expect(service.acquire(item)).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it('sweeps only stale partials on startup and re-verifies a preserved final hit', async () => {
    const bytes = Buffer.from('already cached');
    const item = descriptor('existing', bytes);
    const storage = streamingStorage(new Map());
    const first = createService(storage);
    await first.onModuleInit();
    const workspaceDir = join(cacheDirOf(first), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'stale.partial'), 'incomplete');
    writeFileSync(join(workspaceDir, 'existing.graph'), bytes);
    writeFileSync(join(workspaceDir, 'preserve.txt'), 'unrelated');

    const service = createSiblingService(first, storage);
    await service.onModuleInit();
    const lease = await service.acquire(item);

    expect(existsSync(join(workspaceDir, 'stale.partial'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'preserve.txt'))).toBe(true);
    expect(storage.downloadStream).not.toHaveBeenCalled();
    expect(openGraphFileMock).toHaveBeenCalledTimes(1);
    await service.release(lease);
  });

  it('sweeps a partial-only crash residue and downloads a fresh verified artifact', async () => {
    const bytes = Buffer.from('redownload after interrupted fill');
    const item = descriptor('partial-only', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const first = createService(storage);
    await first.onModuleInit();
    const workspaceDir = join(cacheDirOf(first), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, 'partial-only.partial'), 'interrupted');

    const service = createSiblingService(first, storage);
    await service.onModuleInit();
    const lease = await service.acquire(item);

    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    expect(existsSync(join(workspaceDir, 'partial-only.partial'))).toBe(false);
    expect(readFileSync(join(workspaceDir, 'partial-only.graph'))).toEqual(bytes);
    await service.release(lease);
  });

  it('closes handles on clean shutdown but preserves verified finals for the next process', async () => {
    const bytes = Buffer.from('survives a clean restart');
    const item = descriptor('restart', bytes);
    const firstStorage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const first = createService(firstStorage);
    const firstLease = await first.acquire(item);
    await first.release(firstLease);
    const cacheDir = cacheDirOf(first);

    await first.onModuleDestroy();
    expect(existsSync(join(cacheDir, 'workspace-a', 'restart.graph'))).toBe(true);

    const secondStorage = streamingStorage(new Map());
    const second = new WorkspaceFileCacheService(secondStorage as unknown as R2StorageService, {
      ...(first as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] }).options,
      cacheDir,
    });
    services.push(second);
    const secondLease = await second.acquire(item);
    expect(secondStorage.downloadStream).not.toHaveBeenCalled();
    await second.release(secondLease);
  });

  it('removes a just-committed final when graph open fails and retries from a miss', async () => {
    const bytes = Buffer.from('valid but initially unopenable');
    const item = descriptor('open-failure', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage);
    openGraphFileMock.mockRejectedValueOnce(new Error('driver rejected artifact'));

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    const finalPath = join(cacheDirOf(service), 'workspace-a', 'open-failure.graph');
    expect(existsSync(finalPath)).toBe(false);
    expect(storage.downloadStream).toHaveBeenCalledTimes(1);

    const lease = await service.acquire(item);
    expect(storage.downloadStream).toHaveBeenCalledTimes(2);
    expect(existsSync(finalPath)).toBe(true);
    await service.release(lease);
  });

  it('preserves a verified warm final across a transient open failure while storage is unavailable', async () => {
    const bytes = Buffer.from('verified warm artifact');
    const item = descriptor('warm-open-failure', bytes);
    const storage = streamingStorage(new Map());
    const service = createService(storage);
    await service.onModuleInit();
    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    const finalPath = join(workspaceDir, 'warm-open-failure.graph');
    writeFileSync(finalPath, bytes);
    openGraphFileMock.mockRejectedValueOnce(Object.assign(new Error('descriptor pressure'), { code: 'EMFILE' }));

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(readFileSync(finalPath)).toEqual(bytes);
    expect(storage.downloadStream).not.toHaveBeenCalled();

    const lease = await service.acquire(item);
    expect(storage.downloadStream).not.toHaveBeenCalled();
    await service.release(lease);
  });

  it('preserves a warm final when verification hits a transient filesystem error', async () => {
    const bytes = Buffer.from('warm artifact with transient verifier pressure');
    const item = descriptor('warm-verify-failure', bytes);
    const storage = streamingStorage(new Map());
    const service = createService(storage);
    await service.onModuleInit();
    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    const finalPath = join(workspaceDir, 'warm-verify-failure.graph');
    writeFileSync(finalPath, bytes);
    const verify = vi
      .spyOn(
        service as unknown as {
          verifyFile(path: string, value: WorkspaceGraphFileDescriptor): Promise<void>;
        },
        'verifyFile',
      )
      .mockRejectedValueOnce(Object.assign(new Error('file descriptor pressure'), { code: 'EMFILE' }));

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(readFileSync(finalPath)).toEqual(bytes);
    expect(storage.downloadStream).not.toHaveBeenCalled();

    verify.mockRestore();
    const lease = await service.acquire(item);
    expect(storage.downloadStream).not.toHaveBeenCalled();
    await service.release(lease);
  });

  it('removes a renamed final when directory fsync fails and retries from a miss', async () => {
    const bytes = Buffer.from('valid bytes before directory fsync failure');
    const item = descriptor('directory-fsync', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage, { maxCacheBytes: bytes.byteLength });
    await service.onModuleInit();
    const syncDirectory = vi
      .spyOn(service as unknown as { syncDirectory(path: string): Promise<void> }, 'syncDirectory')
      .mockRejectedValueOnce(new Error('directory fsync failed'));

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    expect(existsSync(join(workspaceDir, 'directory-fsync.graph'))).toBe(false);
    expect(partialFiles(service, 'directory-fsync')).toEqual([]);
    expect(openGraphFileMock).not.toHaveBeenCalled();
    const accounting = service as unknown as { cachedBytes: bigint; reservedBytes: bigint };
    expect(accounting.cachedBytes).toBe(0n);
    expect(accounting.reservedBytes).toBe(0n);

    syncDirectory.mockRestore();
    const lease = await service.acquire(item);
    expect(storage.downloadStream).toHaveBeenCalledTimes(2);
    await service.release(lease);
  });

  it('replaces a corrupt warm final at the exact cache cap', async () => {
    const bytes = Buffer.from('valid replacement exactly at cap');
    const item = descriptor('corrupt-at-cap', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage, { maxCacheBytes: bytes.byteLength });
    await service.onModuleInit();
    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    const finalPath = join(workspaceDir, 'corrupt-at-cap.graph');
    writeFileSync(finalPath, Buffer.alloc(bytes.byteLength, 0x78));

    const lease = await service.acquire(item);

    expect(storage.downloadStream).toHaveBeenCalledOnce();
    expect(readFileSync(finalPath)).toEqual(bytes);
    const accounting = service as unknown as { cachedBytes: bigint; reservedBytes: bigint };
    expect(accounting.cachedBytes).toBe(BigInt(bytes.byteLength));
    expect(accounting.reservedBytes).toBe(0n);
    await service.release(lease);
  });

  it.each([
    ['file fsync', 'syncPartial'],
    ['atomic rename', 'renamePartial'],
  ] as const)('cleans a failed %s and leaves the next attempt as a cache miss', async (_label, method) => {
    const bytes = Buffer.from(`failure at ${method}`);
    const item = descriptor(`fail-${method}`, bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage);
    const operation = vi
      .spyOn(service as unknown as Record<typeof method, (...args: never[]) => Promise<void>>, method)
      .mockRejectedValueOnce(new Error(`${method} failed`));

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    expect(partialFiles(service, item.versionId)).toEqual([]);
    expect(existsSync(join(workspaceDir, `${item.versionId}.graph`))).toBe(false);
    expect(openGraphFileMock).not.toHaveBeenCalled();

    operation.mockRestore();
    const lease = await service.acquire(item);
    expect(storage.downloadStream).toHaveBeenCalledTimes(2);
    await service.release(lease);
  });

  it('backpressures at the hard handle cap without closing an active reader', async () => {
    const firstBytes = Buffer.from('version one');
    const secondBytes = Buffer.from('version two');
    const first = descriptor('v1', firstBytes);
    const second = descriptor('v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    const handles = new Map<string, { close: ReturnType<typeof vi.fn> }>();
    openGraphFileMock.mockImplementation(async (options: { path: string }) => {
      const handle = {
        repository: { artifact: basename(options.path) } as unknown as IGraphReadRepository,
        close: vi.fn(async () => undefined),
      };
      handles.set(basename(options.path), handle);
      return handle;
    });
    const service = createService(storage, { maxOpenHandles: 1 });

    const firstLease = await service.acquire(first);
    const secondAcquire = service.acquire(second);
    await vi.waitFor(() => expect(storage.downloadStream).toHaveBeenCalledTimes(2));

    expect(handles.get('v1.graph')?.close).not.toHaveBeenCalled();
    expect(handles.has('v2.graph')).toBe(false);
    const cacheState = service as unknown as { active: Map<string, unknown>; retired: Set<unknown> };
    await vi.waitFor(() => expect(cacheState.retired.size).toBe(1));
    expect(cacheState.active.size).toBe(0);
    expect(cacheState.retired.size).toBe(1);
    await service.release(firstLease);
    const secondLease = await secondAcquire;
    expect(handles.get('v1.graph')?.close).toHaveBeenCalledTimes(1);
    await service.release(firstLease);
    expect(handles.get('v1.graph')?.close).toHaveBeenCalledTimes(1);
    expect(handles.get('v2.graph')?.close).not.toHaveBeenCalled();
    await service.release(secondLease);
    expect(existsSync(join(cacheDirOf(service), 'workspace-a', 'v1.graph'))).toBe(true);
  });

  it('retries a transient retired-handle close failure without stranding a hard-cap waiter', async () => {
    const firstBytes = Buffer.from('retry-close-one');
    const secondBytes = Buffer.from('retry-close-two');
    const first = descriptor('retry-close-v1', firstBytes);
    const second = descriptor('retry-close-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient native close failure'))
      .mockResolvedValue(undefined);
    openGraphFileMock
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose })
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: vi.fn(async () => undefined) });
    const service = createService(storage, { maxOpenHandles: 1 });

    const firstLease = await service.acquire(first);
    const secondAcquire = service.acquire(second);
    await vi.waitFor(() => expect(storage.downloadStream).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((service as unknown as { retired: Set<unknown> }).retired.size).toBe(1));
    await service.release(firstLease);

    const secondLease = await Promise.race([
      secondAcquire,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hard-cap waiter stalled')), 500)),
    ]);
    expect(firstClose).toHaveBeenCalledTimes(2);
    await service.release(secondLease);
  });

  it('force-releases the slot of a handle whose close fails persistently instead of bricking every acquire', async () => {
    const firstBytes = Buffer.from('persistent-close-one');
    const secondBytes = Buffer.from('persistent-close-two');
    const first = descriptor('persistent-close-v1', firstBytes);
    const second = descriptor('persistent-close-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    // Close NEVER succeeds — an EIO on the mmapped file. Before the bound,
    // this entry kept its maxOpenHandles slot forever and every later acquire
    // failed until restart.
    const firstClose = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('persistent native close failure'));
    openGraphFileMock
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose })
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: vi.fn(async () => undefined) });
    const service = createService(storage, { maxOpenHandles: 1 });

    const firstLease = await service.acquire(first);
    await service.release(firstLease);

    // Contract: each failed close surfaces as one typed OPEN_FAILED that the
    // caller can retry. The bound is what changed: after the third failure the
    // slot is force-released, so the FOURTH acquire succeeds even though
    // close() never stopped rejecting — previously this loop never ended.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.acquire(second)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    }
    expect(firstClose).toHaveBeenCalledTimes(3);
    const secondLease = await service.acquire(second);
    expect(firstClose).toHaveBeenCalledTimes(3);
    await service.release(secondLease);
  });

  it('returns a typed hard-cap close failure and lets a later acquire retry cleanup', async () => {
    const firstBytes = Buffer.from('idle-close-first');
    const secondBytes = Buffer.from('idle-close-second');
    const first = descriptor('idle-close-v1', firstBytes);
    const second = descriptor('idle-close-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient idle close failure'))
      .mockResolvedValue(undefined);
    openGraphFileMock
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose })
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: vi.fn(async () => undefined) });
    const service = createService(storage, { maxOpenHandles: 1 });

    const firstLease = await service.acquire(first);
    await service.release(firstLease);

    await expect(service.acquire(second)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDirOf(service), 'workspace-a', 'idle-close-v2.graph'))).toBe(false);

    const secondLease = await service.acquire(second);
    expect(firstClose).toHaveBeenCalledTimes(2);
    expect(storage.downloadStream).toHaveBeenCalledTimes(3);
    await service.release(secondLease);
  });

  it('does not delete a warm final claimed by a reopen after an eviction close failure', async () => {
    const firstBytes = Buffer.from('claimed-warm-file');
    const secondBytes = Buffer.from('eviction-trigger!');
    expect(firstBytes.byteLength).toBe(secondBytes.byteLength);
    const first = descriptor('claimed-v1', firstBytes);
    const second = descriptor('claimed-v2', secondBytes);
    const objects = new Map([
      [first.r2Key, firstBytes],
      [second.r2Key, secondBytes],
    ]);
    const storage = streamingStorage(objects);
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient native close failure'))
      .mockResolvedValue(undefined);
    openGraphFileMock
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose })
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: vi.fn(async () => undefined) });
    const service = createService(storage, {
      maxCacheBytes: firstBytes.byteLength,
      maxOpenHandles: 1,
    });

    const firstLease = await service.acquire(first);
    await service.release(firstLease);
    objects.delete(first.r2Key);
    await expect(service.acquire(second)).rejects.toMatchObject({ code: 'OPEN_FAILED' });

    const firstPath = join(cacheDirOf(service), 'workspace-a', 'claimed-v1.graph');
    expect(readFileSync(firstPath)).toEqual(firstBytes);
    const reopened = await service.acquire(first);
    expect(firstClose).toHaveBeenCalledTimes(2);
    expect(readFileSync(firstPath)).toEqual(firstBytes);
    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    await service.release(reopened);
  });

  it('normalizes a native close fault for every waiter on one shared eviction', async () => {
    const firstBytes = Buffer.from('shared-eviction-a');
    const secondBytes = Buffer.from('shared-eviction-b');
    const first = descriptor('shared-eviction-v1', firstBytes);
    const second = descriptor('shared-eviction-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    let rejectClose!: (error: Error) => void;
    const closeGate = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    const firstClose = vi
      .fn()
      .mockImplementationOnce(() => closeGate)
      .mockResolvedValue(undefined);
    openGraphFileMock.mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose });
    const service = createService(storage, { maxCacheBytes: firstBytes.byteLength });

    const firstLease = await service.acquire(first);
    await service.release(firstLease);
    const evictionOwner = service.acquire(second);
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
    const concurrentReopen = service.acquire(first);
    rejectClose(new Error('native close failed'));

    await expect(evictionOwner).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    await expect(concurrentReopen).rejects.toMatchObject({ code: 'OPEN_FAILED' });
  });

  it('evicts a released warm file when the disk cap needs space', async () => {
    const firstBytes = Buffer.from('first-cache-file');
    const secondBytes = Buffer.from('second-cachefile');
    expect(firstBytes.byteLength).toBe(secondBytes.byteLength);
    const first = descriptor('disk-v1', firstBytes);
    const second = descriptor('disk-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    const service = createService(storage, { maxCacheBytes: firstBytes.byteLength });

    const firstLease = await service.acquire(first);
    await service.release(firstLease);
    const secondLease = await service.acquire(second);

    const workspaceDir = join(cacheDirOf(service), 'workspace-a');
    expect(existsSync(join(workspaceDir, 'disk-v1.graph'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'disk-v2.graph'))).toBe(true);
    await service.release(secondLease);
  });

  it('forgets stale scan accounting when a warm final was deleted externally', async () => {
    const bytes = Buffer.from('externally deleted warm final');
    const item = descriptor('external-delete', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const first = createService(storage, { maxCacheBytes: bytes.byteLength });
    await first.onModuleInit();
    const workspaceDir = join(cacheDirOf(first), 'workspace-a');
    mkdirSync(workspaceDir, { recursive: true });
    const finalPath = join(workspaceDir, 'external-delete.graph');
    writeFileSync(finalPath, bytes);
    const second = createSiblingService(first, storage);
    await second.onModuleInit();
    rmSync(finalPath);

    const lease = await second.acquire(item);

    expect(storage.downloadStream).toHaveBeenCalledOnce();
    expect(readFileSync(finalPath)).toEqual(bytes);
    await second.release(lease);
  });

  it('drains a fill that finishes during shutdown and never returns a late lease', async () => {
    const bytes = Buffer.from('shutdown-race');
    const item = descriptor('shutdown-race', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    let enteredOpen!: () => void;
    let finishOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      enteredOpen = resolve;
    });
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const close = vi.fn(async () => undefined);
    openGraphFileMock.mockImplementationOnce(async () => {
      enteredOpen();
      await openGate;
      return { repository: {} as IGraphReadRepository, close };
    });
    const service = createService(storage);

    const acquire = service.acquire(item);
    await openStarted;
    const destroy = service.onModuleDestroy();
    finishOpen();

    await expect(acquire).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    await destroy;
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheDirOf(service), 'workspace-a', 'shutdown-race.graph'))).toBe(true);
  });

  it('waits for every zero-ref close before surfacing a shutdown close failure', async () => {
    const firstBytes = Buffer.from('shutdown-close-one');
    const secondBytes = Buffer.from('shutdown-close-two');
    const first = descriptor('shutdown-close-v1', firstBytes);
    const second = descriptor('shutdown-close-v2', secondBytes);
    const storage = streamingStorage(
      new Map([
        [first.r2Key, firstBytes],
        [second.r2Key, secondBytes],
      ]),
    );
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first shutdown close failed'))
      .mockResolvedValue(undefined);
    let finishSecondClose!: () => void;
    const secondCloseGate = new Promise<void>((resolve) => {
      finishSecondClose = resolve;
    });
    const secondClose = vi
      .fn()
      .mockImplementationOnce(() => secondCloseGate)
      .mockResolvedValue(undefined);
    openGraphFileMock
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: firstClose })
      .mockResolvedValueOnce({ repository: {} as IGraphReadRepository, close: secondClose });
    const service = createService(storage, { maxOpenHandles: 2 });
    const firstLease = await service.acquire(first);
    const secondLease = await service.acquire(second);
    await service.release(firstLease);
    await service.release(secondLease);

    const destroy = service.onModuleDestroy();
    let settled = false;
    void destroy.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(secondClose).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishSecondClose();

    await expect(destroy).rejects.toThrow('first shutdown close failed');
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('cannot rename or unlink another instance partial after a restart sweep', async () => {
    const bytes = Buffer.from('one process owns each unique partial inode');
    const item = descriptor('partial-owner', bytes);
    const midpoint = Math.floor(bytes.byteLength / 2);
    let firstStarted!: () => void;
    let finishFirst!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstStorage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () =>
        (async function* () {
          yield bytes.subarray(0, midpoint);
          firstStarted();
          await firstGate;
          yield bytes.subarray(midpoint);
        })(),
      ),
    };
    const first = createService(firstStorage);
    const cacheDir = cacheDirOf(first);
    const firstAcquire = first.acquire(item);
    await firstStart;
    expect(partialFiles(first, item.versionId)).toHaveLength(1);

    let secondStarted!: () => void;
    let finishSecond!: () => void;
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const secondStorage = {
      download: vi.fn(),
      downloadStream: vi.fn(async () =>
        (async function* () {
          yield bytes.subarray(0, midpoint);
          secondStarted();
          await secondGate;
          yield bytes.subarray(midpoint);
        })(),
      ),
    };
    const second = createSiblingService(first, secondStorage);
    await second.onModuleInit();
    expect(partialFiles(first, item.versionId)).toEqual([]);

    const secondAcquire = second.acquire(item);
    await secondStart;
    expect(partialFiles(second, item.versionId)).toHaveLength(1);
    finishFirst();
    await expect(firstAcquire).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(existsSync(join(cacheDir, 'workspace-a', 'partial-owner.graph'))).toBe(false);
    expect(partialFiles(second, item.versionId)).toHaveLength(1);

    finishSecond();
    const secondLease = await secondAcquire;
    expect(readFileSync(join(cacheDir, 'workspace-a', 'partial-owner.graph'))).toEqual(bytes);
    expect(partialFiles(second, item.versionId)).toEqual([]);
    await second.release(secondLease);
  });

  it('uses owner-only permissions and rejects a symlinked workspace directory', async () => {
    const bytes = Buffer.from('private graph bytes');
    const item = descriptor('private-mode', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage);
    const cacheDir = cacheDirOf(service);

    const lease = await service.acquire(item);
    const workspaceDir = join(cacheDir, 'workspace-a');
    const finalPath = join(workspaceDir, 'private-mode.graph');
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(workspaceDir).mode & 0o777).toBe(0o700);
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
    await service.release(lease);

    const symlinkRoot = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-symlink-'));
    const externalDir = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-external-'));
    roots.push(symlinkRoot, externalDir);
    const symlinkService = new WorkspaceFileCacheService(storage as unknown as R2StorageService, {
      ...(service as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] }).options,
      cacheDir: symlinkRoot,
    });
    services.push(symlinkService);
    await symlinkService.onModuleInit();
    symlinkSync(externalDir, join(symlinkRoot, 'workspace-a'), 'dir');

    await expect(symlinkService.acquire(descriptor('symlink', bytes))).rejects.toMatchObject({
      code: 'INVALID_STORAGE_KEY',
    });
  });

  it('keeps Nest bootable when an unmarked non-empty cache root is unsafe to adopt', async () => {
    const bytes = Buffer.from('unavailable cache must not reach storage');
    const item = descriptor('unavailable-cache', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const source = createService(storage);
    const unsafeRoot = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-unmarked-'));
    roots.push(unsafeRoot);
    const nested = join(unsafeRoot, 'unrelated', 'nested');
    mkdirSync(nested, { recursive: true, mode: 0o755 });
    const partial = join(nested, 'keep.partial');
    const graph = join(nested, 'keep.graph');
    writeFileSync(partial, 'not cache data');
    writeFileSync(graph, 'not cache data');
    const rootMode = statSync(unsafeRoot).mode & 0o777;
    const nestedMode = statSync(nested).mode & 0o777;
    const options = (source as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] })
      .options;
    const module = await Test.createTestingModule({
      providers: [
        WorkspaceFileCacheService,
        { provide: R2StorageService, useValue: storage },
        { provide: WORKSPACE_FILE_CACHE_OPTIONS, useValue: { ...options, cacheDir: unsafeRoot } },
      ],
    }).compile();
    const service = module.get(WorkspaceFileCacheService);
    const logger = (service as unknown as { logger: { error: (...args: unknown[]) => void } }).logger;
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      await expect(module.init()).resolves.toBe(module);
      await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
      await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(storage.downloadStream).not.toHaveBeenCalled();
      expect(readFileSync(partial, 'utf8')).toBe('not cache data');
      expect(readFileSync(graph, 'utf8')).toBe('not cache data');
      expect(statSync(unsafeRoot).mode & 0o777).toBe(rootMode);
      expect(statSync(nested).mode & 0o777).toBe(nestedMode);
    } finally {
      await module.close();
      errorLog.mockRestore();
    }
  });

  it('recovers the exact owned marker staging file left by a crashed initializer', async () => {
    const storage = streamingStorage(new Map());
    const source = createService(storage);
    const cacheDir = mkdtempSync(join(tmpdir(), 'coredoc-workspace-file-cache-marker-crash-'));
    roots.push(cacheDir);
    const stagingName = '.coredoc-graph-cache-v1.creating';
    writeFileSync(join(cacheDir, stagingName), 'partially written marker');
    const service = new WorkspaceFileCacheService(storage as unknown as R2StorageService, {
      ...(source as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] }).options,
      cacheDir,
    });
    services.push(service);

    await service.onModuleInit();

    expect(readFileSync(join(cacheDir, '.coredoc-graph-cache-v1'), 'utf8')).toBe('coredoc workspace graph cache v1\n');
    expect(existsSync(join(cacheDir, stagingName))).toBe(false);
  });

  it('keeps a durability failure terminal for one service and recovers on restart', async () => {
    const bytes = Buffer.from('restart after marker durability failure');
    const item = descriptor('marker-durability-restart', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const first = createService(storage);
    const syncDirectory = vi
      .spyOn(first as unknown as { syncDirectory(path: string): Promise<void> }, 'syncDirectory')
      .mockRejectedValueOnce(new Error('directory fsync failed'))
      .mockResolvedValue(undefined);

    await expect(first.onModuleInit()).resolves.toBeUndefined();
    expect(existsSync(join(cacheDirOf(first), '.coredoc-graph-cache-v1'))).toBe(true);
    await expect(first.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    expect(storage.downloadStream).not.toHaveBeenCalled();

    const second = createSiblingService(first, storage);
    await expect(second.onModuleInit()).resolves.toBeUndefined();
    const lease = await second.acquire(item);
    expect(storage.downloadStream).toHaveBeenCalledOnce();
    await second.release(lease);
    expect(syncDirectory).toHaveBeenCalledOnce();
  });

  it('sweeps only exact workspace/version paths inside an owned cache root', async () => {
    const storage = streamingStorage(new Map());
    const first = createService(storage);
    await first.onModuleInit();
    const cacheDir = cacheDirOf(first);
    const nested = join(cacheDir, 'unrelated', 'nested');
    mkdirSync(nested, { recursive: true });
    const preserved = [
      join(cacheDir, 'root.partial'),
      join(cacheDir, 'root.graph'),
      join(nested, 'nested.partial'),
      join(nested, 'nested.graph'),
    ];
    for (const path of preserved) writeFileSync(path, 'unrelated');

    const second = createSiblingService(first, storage);
    await second.onModuleInit();

    expect(preserved.every((path) => existsSync(path))).toBe(true);
  });

  it('keeps Nest bootable while soft-disabling broad cache roots before scanning them', async () => {
    const storage = streamingStorage(new Map());
    const source = createService(storage);
    const options = (source as unknown as { options: ConstructorParameters<typeof WorkspaceFileCacheService>[1] })
      .options;
    const dangerousRoots = ['', parse(process.cwd()).root, process.cwd(), homedir(), tmpdir()];
    const item = descriptor('broad-root', Buffer.from('must not download'));

    for (const cacheDir of dangerousRoots) {
      const service = new WorkspaceFileCacheService(storage as unknown as R2StorageService, {
        ...options,
        cacheDir,
      });
      services.push(service);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await expect(service.acquire(item)).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    }
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });

  it('rejects foreign/traversal storage keys and unsupported formats before storage access', async () => {
    const bytes = Buffer.from('graph');
    const storage = streamingStorage(new Map());
    const service = createService(storage);
    const invalidItems = [
      descriptor('foreign', bytes, { r2Key: 'workspace-b/graphs/foreign.graph' }),
      descriptor('traversal', bytes, { r2Key: 'workspace-a/../workspace-b/graph' }),
      descriptor('format', bytes, { storageFormatVersion: 2 }),
    ];

    for (const item of invalidItems) {
      await expect(service.acquire(item)).rejects.toBeInstanceOf(WorkspaceFileCacheError);
    }
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });

  it('rejects every graph compatibility mismatch before object GET', async () => {
    const bytes = Buffer.from('compatibility-checked graph');
    const cases: ReadonlyArray<{
      label: string;
      descriptorOverrides?: Partial<WorkspaceGraphFileDescriptor>;
      metadataOverrides?: Readonly<Record<string, string>>;
    }> = [
      { label: 'descriptor engine', descriptorOverrides: { engine: 'sqlite' } },
      { label: 'object engine', metadataOverrides: { engine: 'sqlite' } },
      { label: 'engine version', metadataOverrides: { engineversion: '0.0.0' } },
      { label: 'graph schema', metadataOverrides: { schemaversion: '2' } },
      { label: 'object storage format', metadataOverrides: { storageformatversion: '2' } },
      { label: 'descriptor storage format', descriptorOverrides: { storageFormatVersion: 2 } },
    ];

    for (const mismatch of cases) {
      const item = descriptor(`compat-${mismatch.label.replaceAll(' ', '-')}`, bytes, mismatch.descriptorOverrides);
      const storage = streamingStorage(new Map([[item.r2Key, bytes]]), mismatch.metadataOverrides);
      const service = createService(storage);

      await expect(service.acquire(item), mismatch.label).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
      expect(storage.downloadStream, mismatch.label).not.toHaveBeenCalled();
    }
  });

  it('leases a pre-bump builder object and reports its vintage instead of refusing it', async () => {
    const bytes = Buffer.from('phase3 graph');
    const item = descriptor('pre-bump-builder', bytes, { builderVersion: 'phase3-v1' });
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]), { builderversion: 'phase3-v1' });
    const service = createService(storage);

    const lease = await service.acquire(item);
    expect(lease.builderVersion).toBe('phase3-v1');
    expect(storage.downloadStream).toHaveBeenCalledTimes(1);
    await service.release(lease);
  });

  it('rejects an artifact larger than the declared disk cap before storage access', async () => {
    const bytes = Buffer.from('too large for this cache');
    const item = descriptor('large', bytes);
    const storage = streamingStorage(new Map([[item.r2Key, bytes]]));
    const service = createService(storage, { maxCacheBytes: bytes.byteLength - 1 });

    await expect(service.acquire(item)).rejects.toMatchObject({ code: 'CACHE_CAPACITY' });
    expect(storage.downloadStream).not.toHaveBeenCalled();
  });
});
