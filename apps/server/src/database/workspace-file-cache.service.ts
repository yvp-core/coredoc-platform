import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  openGraphFile,
  type GraphFileBudgets,
  type GraphFileHandle,
  type IGraphReadRepository,
} from '@coredoc/db';
import { R2StorageService, type StorageObjectHead } from './r2-storage.service.js';
import { type GraphFileConfig, storageConfigFromEnv } from '../config/app-config.js';

export const WORKSPACE_FILE_CACHE_OPTIONS = Symbol('WORKSPACE_FILE_CACHE_OPTIONS');

export type WorkspaceFileCacheErrorCode =
  | 'NOT_FOUND'
  | 'DOWNLOAD_TIMEOUT'
  | 'INTEGRITY'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_STORAGE_KEY'
  | 'CACHE_CAPACITY'
  | 'OPEN_FAILED';

export interface WorkspaceFileCacheErrorDetails {
  cause?: unknown;
  expectedSha256?: string;
  actualSha256?: string;
  expectedSizeBytes?: bigint;
  actualSizeBytes?: bigint;
}

export class WorkspaceFileCacheError extends Error {
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly expectedSizeBytes?: bigint;
  readonly actualSizeBytes?: bigint;

  constructor(
    readonly code: WorkspaceFileCacheErrorCode,
    message: string,
    details: WorkspaceFileCacheErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'WorkspaceFileCacheError';
    this.expectedSha256 = details.expectedSha256;
    this.actualSha256 = details.actualSha256;
    this.expectedSizeBytes = details.expectedSizeBytes;
    this.actualSizeBytes = details.actualSizeBytes;
  }
}

export interface WorkspaceGraphFileDescriptor {
  workspaceId: string;
  versionId: string;
  engine: string;
  r2Key: string;
  sha256: string;
  sizeBytes: bigint;
  storageFormatVersion: number;
  /**
   * Identity of the builder that produced the payload, carried through from the snapshot
   * manifest so a reader can branch on payload MEANING, not just on storage shape — the
   * `ambiguous` flag on a heritage USES_TYPE row changed meaning in `phase4-v1`
   * (see `heritageIdentityIsVerifiable` in `@coredoc/db`).
   *
   * Optional because the control-plane row exposes it only inside `manifest`, and callers that
   * have not been taught to read it out still construct a descriptor without it. Absent reads
   * as "vintage unknown", which every gate must treat as unverified rather than current.
   */
  builderVersion?: string;
}

export interface WorkspaceGraphFileLease {
  readonly repository: IGraphReadRepository;
  readonly versionId: string;
  /** Builder vintage of the leased file; see {@link WorkspaceGraphFileDescriptor.builderVersion}. */
  readonly builderVersion?: string;
}

export interface WorkspaceFileCacheOptions {
  /** Dedicated to one live service instance; persisted contents may be reused after restart. */
  cacheDir: string;
  maxOpenHandles: number;
  maxTotalBufferPoolBytes: number;
  maxCacheBytes: number;
  downloadTimeoutMs: number;
  storageFormatVersion: number;
  budgets: GraphFileBudgets;
}

interface CacheEntry {
  readonly key: string;
  readonly descriptor: WorkspaceGraphFileDescriptor;
  readonly path: string;
  readonly handle: GraphFileHandle<IGraphReadRepository>;
  refs: number;
  lastUseSeq: number;
  retired: boolean;
  deleteOnClose: boolean;
  closePromise: Promise<void> | null;
  /** Consecutive failed close() attempts; bounds the retry loop. */
  closeFailures?: number;
}

interface DiskFile {
  sizeBytes: bigint;
  lastUseSeq: number;
}

interface PendingEntry {
  readonly promise: Promise<CacheEntry>;
  readonly finalPath: string;
  waiters: number;
}

const DEFAULT_MAX_OPEN_HANDLES = 4;
// After this many rejected close() calls the retired entry's slot is force-
// released — a persistently failing native close must not brick the read path.
const MAX_RETIRED_CLOSE_ATTEMPTS = 3;
const DEFAULT_MAX_TOTAL_BUFFER_POOL_BYTES = 1024 ** 3;
// The Phase 3 publisher accepts a single immutable artifact through 5 GiB.
// The default reader must be able to reserve every artifact the writer accepts.
const DEFAULT_MAX_CACHE_BYTES = 5 * 1024 ** 3;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
// Budget accepted artifacts at 1 MiB/s, but retain a finite ceiling even when
// every streamed chunk arrives before the idle deadline.
const MIN_DOWNLOAD_BYTES_PER_SECOND = 1024n * 1024n;
const MAX_DOWNLOAD_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const MIN_DOWNLOAD_IDLE_WINDOWS = 4;
const DEFAULT_GRAPH_FILE_BUDGETS: GraphFileBudgets = {
  maxDbSizeBytes: 8 * 1024 ** 3,
  bufferPoolBytes: 256 * 1024 ** 2,
  queryTimeoutMs: 5_000,
};
const CACHE_MARKER_NAME = '.coredoc-graph-cache-v1';
const CACHE_MARKER_CREATING_NAME = `${CACHE_MARKER_NAME}.creating`;
const CACHE_MARKER_CONTENT = 'coredoc workspace graph cache v1\n';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Storage-shape identity only. `builderversion` is deliberately absent: it describes payload
// MEANING, not storage shape, and a pre-bump object must still be leasable — the reader branches
// on the descriptor's `builderVersion` instead (see `assertDescriptorCompatibility`).
const GRAPH_FILE_COMPATIBILITY_METADATA = Object.freeze({
  engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
  engineversion: GRAPH_FILE_FORMAT_COMPATIBILITY.engineVersion,
  schemaversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.graphSchemaVersion),
  storageformatversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion),
});

function downloadHardTimeoutMs(idleTimeoutMs: number, expectedBytes: bigint): number {
  const transferMs = (expectedBytes * 1_000n + MIN_DOWNLOAD_BYTES_PER_SECOND - 1n) / MIN_DOWNLOAD_BYTES_PER_SECOND;
  const minimum = BigInt(idleTimeoutMs) * BigInt(MIN_DOWNLOAD_IDLE_WINDOWS);
  const sizeDerived = BigInt(idleTimeoutMs) + transferMs;
  const sizeBudget = minimum > sizeDerived ? minimum : sizeDerived;
  const hardCap = BigInt(MAX_DOWNLOAD_HARD_TIMEOUT_MS);
  return Number(sizeBudget < hardCap ? sizeBudget : hardCap);
}

function positiveIntegerSetting(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, got ${raw}`);
  }
  return value;
}

function defaultOptions(graphFile: GraphFileConfig = storageConfigFromEnv().graphFile): WorkspaceFileCacheOptions {
  const configuredCacheDir = graphFile.cacheDir;
  if (configuredCacheDir !== undefined && configuredCacheDir.trim() === '') {
    throw new Error('GRAPH_FILE_CACHE_DIR must not be empty');
  }
  return {
    cacheDir: resolve(configuredCacheDir ?? join(tmpdir(), 'coredoc-graph-cache')),
    maxOpenHandles: positiveIntegerSetting(
      'GRAPH_FILE_CACHE_MAX_OPEN_HANDLES',
      graphFile.maxOpenHandles,
      DEFAULT_MAX_OPEN_HANDLES,
    ),
    maxTotalBufferPoolBytes: positiveIntegerSetting(
      'GRAPH_FILE_MAX_TOTAL_BUFFER_POOL_BYTES',
      graphFile.maxTotalBufferPoolBytes,
      DEFAULT_MAX_TOTAL_BUFFER_POOL_BYTES,
    ),
    maxCacheBytes: positiveIntegerSetting(
      'GRAPH_FILE_CACHE_MAX_BYTES',
      graphFile.maxCacheBytes,
      DEFAULT_MAX_CACHE_BYTES,
    ),
    downloadTimeoutMs: positiveIntegerSetting(
      'GRAPH_FILE_DOWNLOAD_TIMEOUT_MS',
      graphFile.downloadTimeoutMs,
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
    ),
    storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
    budgets: {
      maxDbSizeBytes: positiveIntegerSetting(
        'GRAPH_FILE_MAX_DB_SIZE_BYTES',
        graphFile.maxDbSizeBytes,
        DEFAULT_GRAPH_FILE_BUDGETS.maxDbSizeBytes,
      ),
      bufferPoolBytes: positiveIntegerSetting(
        'GRAPH_FILE_BUFFER_POOL_BYTES',
        graphFile.bufferPoolBytes,
        DEFAULT_GRAPH_FILE_BUDGETS.bufferPoolBytes,
      ),
      queryTimeoutMs: positiveIntegerSetting(
        'GRAPH_FILE_QUERY_TIMEOUT_MS',
        graphFile.queryTimeoutMs,
        DEFAULT_GRAPH_FILE_BUDGETS.queryTimeoutMs as number,
      ),
    },
  };
}

function validatePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, got ${String(value)}`);
  }
}

function mergeOptions(overrides: Partial<WorkspaceFileCacheOptions>): WorkspaceFileCacheOptions {
  const defaults = defaultOptions();
  const options = {
    ...defaults,
    ...overrides,
    budgets: { ...defaults.budgets, ...overrides.budgets },
    cacheDir: resolve(overrides.cacheDir ?? defaults.cacheDir),
  };
  validatePositiveInteger('maxOpenHandles', options.maxOpenHandles);
  validatePositiveInteger('maxTotalBufferPoolBytes', options.maxTotalBufferPoolBytes);
  validatePositiveInteger('maxCacheBytes', options.maxCacheBytes);
  validatePositiveInteger('downloadTimeoutMs', options.downloadTimeoutMs);
  validatePositiveInteger('storageFormatVersion', options.storageFormatVersion);
  if (options.storageFormatVersion !== GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion) {
    throw new Error(
      `storageFormatVersion is fixed at ${GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion}, got ${options.storageFormatVersion}`,
    );
  }
  validatePositiveInteger('budgets.maxDbSizeBytes', options.budgets.maxDbSizeBytes);
  validatePositiveInteger('budgets.bufferPoolBytes', options.budgets.bufferPoolBytes);
  if (options.budgets.queryTimeoutMs !== undefined) {
    validatePositiveInteger('budgets.queryTimeoutMs', options.budgets.queryTimeoutMs);
  }
  if (
    BigInt(options.maxOpenHandles) * BigInt(options.budgets.bufferPoolBytes) >
    BigInt(options.maxTotalBufferPoolBytes)
  ) {
    throw new Error('maxOpenHandles * budgets.bufferPoolBytes must not exceed maxTotalBufferPoolBytes');
  }
  return options;
}

function isSafeSegment(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_SEGMENT.test(value) && !value.includes('\\');
}

function sameDescriptor(left: WorkspaceGraphFileDescriptor, right: WorkspaceGraphFileDescriptor): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.versionId === right.versionId &&
    left.engine === right.engine &&
    left.r2Key === right.r2Key &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.storageFormatVersion === right.storageFormatVersion &&
    // versionId is a hash of the manifest, which includes builderVersion, so two descriptors for
    // one version can only disagree here if one of them was built without reading the manifest.
    // That is exactly the confusion this field exists to surface, so it is compared like the rest.
    left.builderVersion === right.builderVersion
  );
}

@Injectable()
export class WorkspaceFileCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceFileCacheService.name);
  private readonly active = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly pendingPaths = new Set<string>();
  private readonly evictingPaths = new Map<string, Promise<void>>();
  private readonly retired = new Set<CacheEntry>();
  private readonly leaseEntries = new WeakMap<WorkspaceGraphFileLease, CacheEntry>();
  private readonly releasedLeases = new WeakSet<WorkspaceGraphFileLease>();
  private readonly diskFiles = new Map<string, DiskFile>();
  private cachedBytes = 0n;
  private reservedBytes = 0n;
  private sequence = 0;
  private initializationPromise: Promise<void> | null = null;
  private initializationFailure: WorkspaceFileCacheError | null = null;
  private shuttingDown = false;
  private openReservations = 0;
  private readonly openSlotWaiters = new Set<() => void>();
  private readonly options: WorkspaceFileCacheOptions;

  constructor(
    private readonly storage: R2StorageService,
    @Optional()
    @Inject(WORKSPACE_FILE_CACHE_OPTIONS)
    options: Partial<WorkspaceFileCacheOptions> = {},
  ) {
    this.options = mergeOptions(options);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureInitialized().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.notifyOpenSlotWaiters();
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.promise));
    const entries = [...this.active.values()];
    for (const entry of entries) this.retire(entry, false);
    const closes = await Promise.allSettled(
      [...this.retired].filter((entry) => entry.refs === 0).map((entry) => this.closeRetired(entry)),
    );
    const failures = closes
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to close workspace graph cache handles');
  }

  async acquire(descriptor: WorkspaceGraphFileDescriptor): Promise<WorkspaceGraphFileLease> {
    try {
      return await this.acquireInternal(descriptor);
    } catch (error) {
      if (error instanceof WorkspaceFileCacheError) throw error;
      throw new WorkspaceFileCacheError(
        'OPEN_FAILED',
        `Failed to acquire graph file ${descriptor.workspaceId}/${descriptor.versionId}`,
        { cause: error },
      );
    }
  }

  private async acquireInternal(descriptor: WorkspaceGraphFileDescriptor): Promise<WorkspaceGraphFileLease> {
    this.validateDescriptor(descriptor);
    this.assertRunning();
    await this.ensureInitialized();
    this.assertRunning();
    const key = this.cacheKey(descriptor.workspaceId, descriptor.versionId);
    const finalPath = this.finalPath(descriptor);
    const eviction = this.evictingPaths.get(finalPath);
    if (eviction) await eviction;
    this.assertRunning();
    const existing = this.active.get(key);
    if (existing) {
      this.assertDescriptorMatches(existing.descriptor, descriptor);
      return this.issueLease(existing);
    }

    let pending = this.pending.get(key);
    if (!pending) {
      this.pendingPaths.add(finalPath);
      pending = {
        promise: this.createEntry(key, descriptor, finalPath),
        finalPath,
        waiters: 0,
      };
      this.pending.set(key, pending);
    }

    pending.waiters += 1;
    try {
      const entry = await pending.promise;
      this.assertRunning();
      this.assertDescriptorMatches(entry.descriptor, descriptor);
      return this.issueLease(entry);
    } finally {
      pending.waiters = Math.max(0, pending.waiters - 1);
      if (pending.waiters === 0 && this.pending.get(key) === pending) {
        this.pending.delete(key);
        this.pendingPaths.delete(pending.finalPath);
      }
    }
  }

  async release(lease: WorkspaceGraphFileLease): Promise<void> {
    if (this.releasedLeases.has(lease)) return;
    const entry = this.leaseEntries.get(lease);
    if (!entry) return;
    this.releasedLeases.add(lease);
    this.leaseEntries.delete(lease);
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUseSeq = this.nextSequence();
    if (entry.retired && entry.refs === 0) {
      await this.closeRetired(entry).catch(() => undefined);
      return;
    }
    if (entry.refs === 0) this.notifyOpenSlotWaiters();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initializationFailure) throw this.initializationFailure;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.initializeCache().catch((error) => {
      const failure = new WorkspaceFileCacheError(
        'OPEN_FAILED',
        `Workspace graph file cache is unavailable: ${this.options.cacheDir}`,
        { cause: error },
      );
      this.initializationFailure = failure;
      this.logger.error(failure.message, error instanceof Error ? error.stack : undefined);
      throw failure;
    });
    return this.initializationPromise;
  }

  private async initializeCache(): Promise<void> {
    await this.ensureOwnedCacheRoot();
    this.diskFiles.clear();
    this.cachedBytes = 0n;
    await this.scanCacheRoot();
    await this.enforceStartupDiskLimit();
  }

  private async scanCacheRoot(): Promise<void> {
    const entries = await readdir(this.options.cacheDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
      await this.scanWorkspaceDirectory(join(this.options.cacheDir, entry.name));
    }
  }

  private async scanWorkspaceDirectory(workspaceDir: string): Promise<void> {
    await this.ensurePrivateDirectory(workspaceDir);
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const suffix = entry.name.endsWith('.partial') ? '.partial' : entry.name.endsWith('.graph') ? '.graph' : null;
      if (!suffix || !isSafeSegment(entry.name.slice(0, -suffix.length))) continue;
      const path = join(workspaceDir, entry.name);
      if (suffix === '.partial') {
        await rm(path, { force: true });
        continue;
      }
      const metadata = await lstat(path, { bigint: true });
      const expectedUid = process.getuid?.();
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (expectedUid !== undefined && metadata.uid !== BigInt(expectedUid))
      ) {
        throw new WorkspaceFileCacheError(
          'INVALID_STORAGE_KEY',
          `Cached graph path is not an owned regular file: ${path}`,
        );
      }
      await chmod(path, 0o600);
      this.diskFiles.set(path, { sizeBytes: metadata.size, lastUseSeq: this.nextSequence() });
      this.cachedBytes += metadata.size;
    }
  }

  private async createEntry(
    key: string,
    descriptor: WorkspaceGraphFileDescriptor,
    finalPath: string,
  ): Promise<CacheEntry> {
    let downloadedThisAttempt = false;
    let finalExists = await this.isRegularFile(finalPath);
    if (!finalExists) finalExists = await this.reconcileMissingFinal(finalPath);
    if (finalExists) {
      try {
        await this.verifyFile(finalPath, descriptor);
        this.touchDiskFile(finalPath, descriptor.sizeBytes);
      } catch (error) {
        if (!(error instanceof WorkspaceFileCacheError) || error.code !== 'INTEGRITY') {
          throw new WorkspaceFileCacheError(
            'OPEN_FAILED',
            `Failed to verify cached graph file ${descriptor.workspaceId}/${descriptor.versionId}`,
            { cause: error },
          );
        }
        // This service is the sole owner of its cache root. Removing the
        // corrupt final before reserving replacement space keeps the hard
        // disk cap honest even when one artifact is as large as the cap.
        await this.removeCachedFile(finalPath);
        finalExists = false;
      }
    }

    if (!finalExists) {
      await this.downloadAndCommit(descriptor, finalPath);
      downloadedThisAttempt = true;
    }

    let releaseOpenReservation: (() => void) | null = null;
    let handle: GraphFileHandle<IGraphReadRepository> | null = null;
    try {
      releaseOpenReservation = await this.reserveOpenSlot();
      this.assertRunning();
      handle = await openGraphFile({
        path: finalPath,
        budgets: this.options.budgets,
      });
      const entry: CacheEntry = {
        key,
        descriptor,
        path: finalPath,
        handle,
        refs: 0,
        lastUseSeq: this.nextSequence(),
        retired: false,
        deleteOnClose: false,
        closePromise: null,
      };
      this.active.set(key, entry);
      handle = null;
      return entry;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      let cause: unknown = error;
      if (downloadedThisAttempt) {
        try {
          await this.removeCachedFile(finalPath);
        } catch (cleanupError) {
          cause = new AggregateError([error, cleanupError], 'Graph open and cache cleanup both failed');
        }
      }
      throw new WorkspaceFileCacheError(
        'OPEN_FAILED',
        `Failed to open graph file ${descriptor.workspaceId}/${descriptor.versionId}`,
        { cause },
      );
    } finally {
      releaseOpenReservation?.();
    }
  }

  private async downloadAndCommit(descriptor: WorkspaceGraphFileDescriptor, finalPath: string): Promise<void> {
    await this.validateRemoteCompatibility(descriptor);
    await this.reserveCapacity(descriptor.sizeBytes, finalPath);
    const workspaceDir = join(this.options.cacheDir, descriptor.workspaceId);
    // The attempt id is part of the path ownership proof. If another process
    // sweeps a live pathname during a shared-volume restart, this attempt can
    // fail with ENOENT but can never rename or unlink the replacement inode.
    const partialPath = join(workspaceDir, `${descriptor.versionId}.${process.pid}.${randomUUID()}.partial`);

    let partialHandle: Awaited<ReturnType<typeof open>> | null = null;
    let iterator: AsyncIterator<Uint8Array> | null = null;
    let completedBody = false;
    let committed = false;
    let ownsPartial = false;
    let renamedFinal = false;
    let timeoutError: WorkspaceFileCacheError | null = null;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let recordProgress = () => undefined;

    try {
      await this.ensurePrivateDirectory(workspaceDir);
      partialHandle = await open(
        partialPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      ownsPartial = true;
      const streamPromise = Promise.resolve().then(() =>
        this.storage.downloadStream(descriptor.r2Key, { signal: controller.signal }),
      );
      const hardTimeoutMs = downloadHardTimeoutMs(this.options.downloadTimeoutMs, descriptor.sizeBytes);
      const deadline = new Promise<never>((_, reject) => {
        const expire = (message: string) => {
          if (timeoutError) return;
          timeoutError = new WorkspaceFileCacheError('DOWNLOAD_TIMEOUT', message);
          controller.abort(timeoutError);
          reject(timeoutError);
        };
        recordProgress = () => {
          if (controller.signal.aborted) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => expire(`Graph download made no progress for ${this.options.downloadTimeoutMs}ms`),
            this.options.downloadTimeoutMs,
          );
        };
        hardTimer = setTimeout(
          () => expire(`Graph download exceeded its ${hardTimeoutMs}ms hard deadline`),
          hardTimeoutMs,
        );
        recordProgress();
      });
      void streamPromise
        .then((lateStream) => {
          if (!controller.signal.aborted || !lateStream) return;
          const lateIterator = lateStream[Symbol.asyncIterator]();
          if (lateIterator.return) void Promise.resolve(lateIterator.return()).catch(() => undefined);
        })
        .catch(() => undefined);
      const stream = await Promise.race([streamPromise, deadline]);
      if (!stream) {
        throw new WorkspaceFileCacheError('NOT_FOUND', `Graph object not found: ${descriptor.r2Key}`);
      }

      iterator = stream[Symbol.asyncIterator]();
      const hash = createHash('sha256');
      let actualSizeBytes = 0n;
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) {
          completedBody = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (hardTimer) clearTimeout(hardTimer);
          idleTimer = undefined;
          hardTimer = undefined;
          break;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw new WorkspaceFileCacheError('INTEGRITY', 'Graph download yielded a non-byte chunk');
        }
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        actualSizeBytes += BigInt(chunk.byteLength);
        hash.update(chunk);
        if (actualSizeBytes > descriptor.sizeBytes) {
          throw this.integrityError(descriptor, hash.copy().digest('hex'), actualSizeBytes);
        }
        await this.writeAll(partialHandle, chunk);
        if (chunk.byteLength > 0) recordProgress();
      }

      const actualSha256 = hash.digest('hex');
      if (actualSizeBytes !== descriptor.sizeBytes || actualSha256 !== descriptor.sha256) {
        throw this.integrityError(descriptor, actualSha256, actualSizeBytes);
      }

      await this.syncPartial(partialHandle);
      await partialHandle.close();
      partialHandle = null;
      await this.renamePartial(partialPath, finalPath);
      renamedFinal = true;
      await this.syncDirectory(workspaceDir);
      this.commitReservation(finalPath, descriptor.sizeBytes);
      committed = true;
    } catch (error) {
      controller.abort();
      if (iterator && !completedBody && iterator.return) {
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          // The primary download error remains authoritative.
        }
      }
      if (timeoutError) throw timeoutError;
      if (error instanceof WorkspaceFileCacheError) throw error;
      throw new WorkspaceFileCacheError('OPEN_FAILED', `Failed to cache graph object ${descriptor.r2Key}`, {
        cause: error,
      });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (partialHandle) await partialHandle.close().catch(() => undefined);
      if (ownsPartial) await rm(partialPath, { force: true }).catch(() => undefined);
      if (!committed && renamedFinal) {
        try {
          await this.removeCachedFile(finalPath);
        } catch {
          // If cleanup itself fails, account the retained bytes rather than
          // silently allowing later reservations to exceed the disk cap.
          let retainedSize = descriptor.sizeBytes;
          try {
            const metadata = await lstat(finalPath, { bigint: true });
            if (metadata.isFile() && !metadata.isSymbolicLink()) retainedSize = metadata.size;
          } catch {
            // Conservatively retain the declared size when stat also fails.
          }
          this.commitReservation(finalPath, retainedSize, descriptor.sizeBytes);
          committed = true;
        }
      }
      if (!committed) this.releaseReservation(descriptor.sizeBytes);
    }
  }

  private async validateRemoteCompatibility(descriptor: WorkspaceGraphFileDescriptor): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: WorkspaceFileCacheError | null = null;
    const headPromise = Promise.resolve().then(() =>
      this.storage.headObject(descriptor.r2Key, { signal: controller.signal }),
    );
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutError = new WorkspaceFileCacheError(
          'DOWNLOAD_TIMEOUT',
          `Graph compatibility check timed out after ${this.options.downloadTimeoutMs}ms`,
        );
        controller.abort();
        reject(timeoutError);
      }, this.options.downloadTimeoutMs);
    });

    let head: StorageObjectHead | null;
    try {
      head = await Promise.race([headPromise, deadline]);
    } catch (error) {
      controller.abort();
      if (timeoutError) throw timeoutError;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!head) return;

    const metadata = new Map(Object.entries(head.metadata).map(([key, value]) => [key.toLowerCase(), value] as const));
    const compatibilityKeys = Object.keys(GRAPH_FILE_COMPATIBILITY_METADATA);
    if (!compatibilityKeys.some((key) => metadata.has(key))) return;

    for (const [key, expected] of Object.entries(GRAPH_FILE_COMPATIBILITY_METADATA)) {
      const actual = metadata.get(key);
      if (actual === expected) continue;
      throw new WorkspaceFileCacheError(
        'UNSUPPORTED_FORMAT',
        `Graph object compatibility mismatch for ${key}: expected ${expected}, got ${actual ?? 'missing'}`,
      );
    }
  }

  private async writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      if (bytesWritten <= 0) throw new Error('Graph cache write made no progress');
      offset += bytesWritten;
    }
  }

  private async syncPartial(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
    await handle.sync();
  }

  private async renamePartial(partialPath: string, finalPath: string): Promise<void> {
    await rename(partialPath, finalPath);
  }

  private async syncDirectory(path: string): Promise<void> {
    const directoryHandle = await open(path, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  private async verifyFile(path: string, descriptor: WorkspaceGraphFileDescriptor): Promise<void> {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile()) {
      throw new WorkspaceFileCacheError('INTEGRITY', `Cached graph path is not a regular file: ${path}`);
    }
    const hash = createHash('sha256');
    let sizeBytes = 0n;
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer;
      sizeBytes += BigInt(bytes.byteLength);
      hash.update(bytes);
    }
    const actualSha256 = hash.digest('hex');
    if (sizeBytes !== descriptor.sizeBytes || actualSha256 !== descriptor.sha256) {
      throw this.integrityError(descriptor, actualSha256, sizeBytes);
    }
  }

  private integrityError(
    descriptor: WorkspaceGraphFileDescriptor,
    actualSha256: string,
    actualSizeBytes: bigint,
  ): WorkspaceFileCacheError {
    return new WorkspaceFileCacheError(
      'INTEGRITY',
      `Graph artifact integrity mismatch for ${descriptor.workspaceId}/${descriptor.versionId}`,
      {
        expectedSha256: descriptor.sha256,
        actualSha256,
        expectedSizeBytes: descriptor.sizeBytes,
        actualSizeBytes,
      },
    );
  }

  private issueLease(entry: CacheEntry): WorkspaceGraphFileLease {
    entry.refs += 1;
    entry.lastUseSeq = this.nextSequence();
    const disk = this.diskFiles.get(entry.path);
    if (disk) disk.lastUseSeq = entry.lastUseSeq;
    const lease = Object.freeze({
      repository: entry.handle.repository,
      versionId: entry.descriptor.versionId,
      // Exposed on the lease so a tool reading this file can decide how to render claims whose
      // meaning is builder-dependent, without reaching back into the control plane.
      builderVersion: entry.descriptor.builderVersion,
    });
    this.leaseEntries.set(lease, entry);
    return lease;
  }

  private retire(entry: CacheEntry, deleteOnClose: boolean): void {
    entry.deleteOnClose ||= deleteOnClose;
    if (entry.retired) return;
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key);
    entry.retired = true;
    this.retired.add(entry);
  }

  private closeRetired(entry: CacheEntry): Promise<void> {
    if (!entry.retired || entry.refs > 0) return Promise.resolve();
    if (entry.closePromise) return entry.closePromise;
    const releaseAccounting = async (): Promise<void> => {
      this.retired.delete(entry);
      if (entry.deleteOnClose && !this.pendingPaths.has(entry.path) && !this.pathHasAnotherEntry(entry.path, entry)) {
        await this.removeCachedFile(entry.path);
      }
    };
    entry.closePromise = entry.handle
      .close()
      .then(releaseAccounting, async (error: unknown) => {
        // Transient close failures stay retryable: the entry remains in
        // `retired` and the next slot request re-attempts the close. But a
        // PERSISTENTLY failing close must not brick the read path — before
        // this bound, one always-rejecting handle kept its maxOpenHandles slot
        // forever and every subsequent acquire failed until restart. After the
        // bound, the slot is force-released and the rejection still propagates
        // (shutdown reports it); the possibly-leaked native handle is strictly
        // cheaper than a dead read path. unlink-while-open is safe on POSIX,
        // so file cleanup proceeds even after a failed close.
        entry.closeFailures = (entry.closeFailures ?? 0) + 1;
        if (entry.closeFailures >= MAX_RETIRED_CLOSE_ATTEMPTS) {
          this.logger.error(
            `Closing retired graph handle ${entry.key} failed ${entry.closeFailures} times; releasing its slot anyway`,
            error,
          );
          await releaseAccounting();
        } else {
          this.logger.error(`Failed to close retired graph handle ${entry.key}`, error);
        }
        throw error;
      })
      .finally(() => {
        entry.closePromise = null;
        this.notifyOpenSlotWaiters();
      });
    return entry.closePromise;
  }

  private async reserveOpenSlot(): Promise<() => void> {
    for (;;) {
      this.assertRunning();
      if (this.openHandleCount() + this.openReservations < this.options.maxOpenHandles) {
        this.openReservations += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.openReservations = Math.max(0, this.openReservations - 1);
          this.notifyOpenSlotWaiters();
        };
      }

      const retired = [...this.retired]
        .filter((entry) => entry.refs === 0)
        .sort((left, right) => left.lastUseSeq - right.lastUseSeq || left.key.localeCompare(right.key))[0];
      if (retired) {
        await this.closeRetired(retired);
        continue;
      }

      const active = [...this.active.values()]
        .filter((entry) => entry.refs === 0 && !this.pending.has(entry.key))
        .sort((left, right) => left.lastUseSeq - right.lastUseSeq || left.key.localeCompare(right.key))[0];
      if (active) {
        this.retire(active, false);
        await this.closeRetired(active);
        continue;
      }

      const heldActive = [...this.active.values()]
        .filter((entry) => entry.refs > 0 && !this.pending.has(entry.key))
        .sort((left, right) => left.lastUseSeq - right.lastUseSeq || left.key.localeCompare(right.key))[0];
      if (heldActive) {
        // Retire under pressure so no new request can extend this handle's
        // lifetime. Its current readers keep it open; the last exact release
        // closes it and wakes the backpressured opener below.
        this.retire(heldActive, false);
        await new Promise<void>((resolveWaiter) => this.openSlotWaiters.add(resolveWaiter));
        continue;
      }

      await new Promise<void>((resolveWaiter) => this.openSlotWaiters.add(resolveWaiter));
    }
  }

  private openHandleCount(): number {
    return this.active.size + this.retired.size;
  }

  private notifyOpenSlotWaiters(): void {
    const waiters = [...this.openSlotWaiters];
    this.openSlotWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter();
  }

  private pathHasAnotherEntry(path: string, excluded?: CacheEntry): boolean {
    for (const entry of this.active.values()) if (entry !== excluded && entry.path === path) return true;
    for (const entry of this.retired) if (entry !== excluded && entry.path === path) return true;
    return false;
  }

  private async reserveCapacity(sizeBytes: bigint, protectedPath: string): Promise<void> {
    const limit = BigInt(this.options.maxCacheBytes);
    if (sizeBytes > limit || sizeBytes > BigInt(this.options.budgets.maxDbSizeBytes)) {
      throw new WorkspaceFileCacheError(
        'CACHE_CAPACITY',
        `Graph artifact is ${sizeBytes} bytes, above the declared cache/file limit`,
      );
    }

    this.reservedBytes += sizeBytes;
    try {
      while (this.cachedBytes + this.reservedBytes > limit) {
        const candidate = [...this.diskFiles.entries()]
          .filter(
            ([path]) =>
              path !== protectedPath &&
              !this.pendingPaths.has(path) &&
              !this.evictingPaths.has(path) &&
              this.pathIsIdle(path),
          )
          .sort(
            ([leftPath, left], [rightPath, right]) =>
              left.lastUseSeq - right.lastUseSeq || leftPath.localeCompare(rightPath),
          )[0];
        if (!candidate) {
          throw new WorkspaceFileCacheError(
            'CACHE_CAPACITY',
            'Graph file cache has no evictable space for the requested artifact',
          );
        }
        await this.evictDiskPath(candidate[0]);
      }
    } catch (error) {
      this.reservedBytes -= sizeBytes;
      if (error instanceof WorkspaceFileCacheError) throw error;
      throw new WorkspaceFileCacheError('OPEN_FAILED', 'Failed to evict a cached graph artifact', { cause: error });
    }
  }

  private releaseReservation(sizeBytes: bigint): void {
    this.reservedBytes = this.reservedBytes >= sizeBytes ? this.reservedBytes - sizeBytes : 0n;
  }

  private commitReservation(path: string, sizeBytes: bigint, reservedSizeBytes = sizeBytes): void {
    this.releaseReservation(reservedSizeBytes);
    const previous = this.diskFiles.get(path);
    if (previous) this.cachedBytes -= previous.sizeBytes;
    this.diskFiles.set(path, { sizeBytes, lastUseSeq: this.nextSequence() });
    this.cachedBytes += sizeBytes;
  }

  private touchDiskFile(path: string, sizeBytes: bigint): void {
    const existing = this.diskFiles.get(path);
    if (!existing) {
      this.diskFiles.set(path, { sizeBytes, lastUseSeq: this.nextSequence() });
      this.cachedBytes += sizeBytes;
    } else {
      existing.lastUseSeq = this.nextSequence();
    }
  }

  private async removeCachedFile(path: string): Promise<void> {
    await rm(path, { force: true });
    this.forgetCachedFile(path);
  }

  private forgetCachedFile(path: string): void {
    const existing = this.diskFiles.get(path);
    if (existing) {
      this.diskFiles.delete(path);
      this.cachedBytes = this.cachedBytes >= existing.sizeBytes ? this.cachedBytes - existing.sizeBytes : 0n;
    }
  }

  private async reconcileMissingFinal(path: string): Promise<boolean> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new WorkspaceFileCacheError('INTEGRITY', `Cached graph path is not a regular file: ${path}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The scan-time accounting represented the now-missing inode. Forget it
      // only after this second lstat confirms absence; a replacement observed
      // here is verified normally instead.
      this.forgetCachedFile(path);
      return false;
    }
  }

  private pathIsIdle(path: string): boolean {
    for (const entry of this.active.values()) if (entry.path === path && entry.refs > 0) return false;
    for (const entry of this.retired) if (entry.path === path && entry.refs > 0) return false;
    return true;
  }

  private async evictDiskPath(path: string): Promise<void> {
    const existing = this.evictingPaths.get(path);
    if (existing) return existing;
    const operation = this.performDiskEviction(path)
      .catch((error) => {
        if (error instanceof WorkspaceFileCacheError) throw error;
        throw new WorkspaceFileCacheError('OPEN_FAILED', `Failed to evict cached graph file: ${path}`, {
          cause: error,
        });
      })
      .finally(() => {
        if (this.evictingPaths.get(path) === operation) this.evictingPaths.delete(path);
      });
    this.evictingPaths.set(path, operation);
    return operation;
  }

  private async performDiskEviction(path: string): Promise<void> {
    const entries = [
      ...[...this.active.values()].filter((entry) => entry.path === path),
      ...[...this.retired].filter((entry) => entry.path === path),
    ];
    if (entries.some((entry) => entry.refs > 0) || this.pendingPaths.has(path)) {
      throw new WorkspaceFileCacheError('CACHE_CAPACITY', `Cached graph file is still in use: ${path}`);
    }
    for (const entry of entries) {
      entry.deleteOnClose = true;
      this.retire(entry, true);
    }
    for (const entry of entries) await this.closeRetired(entry);
    if (!this.pathHasAnotherEntry(path)) await this.removeCachedFile(path);
  }

  private async isRegularFile(path: string): Promise<boolean> {
    try {
      return (await lstat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private validateDescriptor(descriptor: WorkspaceGraphFileDescriptor): void {
    if (!isSafeSegment(descriptor.workspaceId) || !isSafeSegment(descriptor.versionId)) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `Invalid workspace/version cache identity: ${descriptor.workspaceId}/${descriptor.versionId}`,
      );
    }
    const keySegments = descriptor.r2Key.split('/');
    if (
      !descriptor.r2Key.startsWith(`${descriptor.workspaceId}/`) ||
      keySegments.some((segment) => !isSafeSegment(segment))
    ) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `Graph storage key is outside workspace ${descriptor.workspaceId}: ${descriptor.r2Key}`,
      );
    }
    if (descriptor.engine !== GRAPH_FILE_FORMAT_COMPATIBILITY.engine) {
      throw new WorkspaceFileCacheError(
        'UNSUPPORTED_FORMAT',
        `Unsupported graph engine ${String(descriptor.engine)}; expected ${GRAPH_FILE_FORMAT_COMPATIBILITY.engine}`,
      );
    }
    if (descriptor.storageFormatVersion !== GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion) {
      throw new WorkspaceFileCacheError(
        'UNSUPPORTED_FORMAT',
        `Unsupported graph storage format ${descriptor.storageFormatVersion}; expected ${GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion}`,
      );
    }
    // `builderVersion` is deliberately NOT a hard gate — neither here nor on the R2 object
    // metadata in `validateRemoteCompatibility`. Pre-bump artifacts have a payload whose MEANING
    // differs (see `heritageIdentityIsVerifiable` in `@coredoc/db`), so the descriptor's value is
    // recorded and handed to the reader on the lease instead of being used to refuse the file:
    // refusing would take a workspace's graph away, while branching lets the reader downgrade the
    // one claim that is vintage-dependent.
    if (!/^[0-9a-f]{64}$/.test(descriptor.sha256) || descriptor.sizeBytes <= 0n) {
      throw new WorkspaceFileCacheError('INTEGRITY', 'Graph descriptor has an invalid SHA-256 or byte size');
    }
  }

  private assertDescriptorMatches(
    existing: WorkspaceGraphFileDescriptor,
    requested: WorkspaceGraphFileDescriptor,
  ): void {
    if (!sameDescriptor(existing, requested)) {
      throw new WorkspaceFileCacheError(
        'INTEGRITY',
        `Immutable graph metadata changed for ${requested.workspaceId}/${requested.versionId}`,
      );
    }
  }

  private cacheKey(workspaceId: string, versionId: string): string {
    return JSON.stringify([workspaceId, versionId]);
  }

  private finalPath(descriptor: WorkspaceGraphFileDescriptor): string {
    return join(this.options.cacheDir, descriptor.workspaceId, `${descriptor.versionId}.graph`);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new WorkspaceFileCacheError('OPEN_FAILED', 'Workspace graph file cache is shutting down');
    }
  }

  private async ensureOwnedCacheRoot(): Promise<void> {
    const forbiddenCacheRoots = new Set([
      parse(this.options.cacheDir).root,
      resolve(process.cwd()),
      resolve(homedir()),
      resolve(tmpdir()),
    ]);
    if (forbiddenCacheRoots.has(this.options.cacheDir)) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `cacheDir must be a dedicated graph-cache directory, got ${this.options.cacheDir}`,
      );
    }

    try {
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', 'Unable to create graph cache directory', {
        cause: error,
      });
    }

    const metadata = await lstat(this.options.cacheDir);
    const expectedUid = process.getuid?.();
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `Graph cache root is not a real directory: ${this.options.cacheDir}`,
      );
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `Graph cache root has an unexpected owner: ${this.options.cacheDir}`,
      );
    }

    const markerPath = join(this.options.cacheDir, CACHE_MARKER_NAME);
    const creatingPath = join(this.options.cacheDir, CACHE_MARKER_CREATING_NAME);
    let markerExists = true;
    try {
      await lstat(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      markerExists = false;
    }

    if (!markerExists) {
      const entries = await readdir(this.options.cacheDir);
      if (entries.length === 1 && entries[0] === CACHE_MARKER_CREATING_NAME) {
        await this.removeOwnedMarkerStagingFile(creatingPath);
      } else if (entries.length > 0) {
        throw new WorkspaceFileCacheError(
          'INVALID_STORAGE_KEY',
          `Refusing to adopt unmarked non-empty graph cache directory: ${this.options.cacheDir}`,
        );
      }
      await chmod(this.options.cacheDir, 0o700);
      await this.createCacheMarker(markerPath, creatingPath);
    }

    await this.verifyCacheMarker(markerPath);
    await chmod(this.options.cacheDir, 0o700);
    // A crash after rename but before this barrier leaves either no marker or a
    // complete marker. The next sole owner safely recreates or re-syncs it.
    await this.syncDirectory(this.options.cacheDir);
  }

  private async createCacheMarker(markerPath: string, creatingPath: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let ownsCreatingPath = false;
    try {
      handle = await open(
        creatingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      ownsCreatingPath = true;
      await handle.writeFile(CACHE_MARKER_CONTENT, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(creatingPath, markerPath);
      ownsCreatingPath = false;
    } catch (error) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', 'Failed to create graph cache ownership marker', {
        cause: error,
      });
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (ownsCreatingPath) await rm(creatingPath, { force: true }).catch(() => undefined);
    }
  }

  private async removeOwnedMarkerStagingFile(path: string): Promise<void> {
    const expectedUid = process.getuid?.();
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', `Invalid graph cache marker staging file: ${path}`);
    }
    await rm(path, { force: true });
  }

  private async verifyCacheMarker(markerPath: string): Promise<void> {
    const metadata = await lstat(markerPath);
    const expectedUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== Buffer.byteLength(CACHE_MARKER_CONTENT) ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', `Invalid graph cache ownership marker: ${markerPath}`);
    }
    if ((await readFile(markerPath, 'utf8')) !== CACHE_MARKER_CONTENT) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', `Invalid graph cache ownership marker: ${markerPath}`);
    }
    await chmod(markerPath, 0o600);
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    const expectedUid = process.getuid?.();
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new WorkspaceFileCacheError('INVALID_STORAGE_KEY', `Graph cache path is not a real directory: ${path}`);
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new WorkspaceFileCacheError(
        'INVALID_STORAGE_KEY',
        `Graph cache directory has an unexpected owner: ${path}`,
      );
    }
    await chmod(path, 0o700);
  }

  private async enforceStartupDiskLimit(): Promise<void> {
    const limit = BigInt(this.options.maxCacheBytes);
    while (this.cachedBytes > limit) {
      const candidate = [...this.diskFiles.entries()].sort(
        ([leftPath, left], [rightPath, right]) =>
          left.lastUseSeq - right.lastUseSeq || leftPath.localeCompare(rightPath),
      )[0];
      if (!candidate) return;
      await this.removeCachedFile(candidate[0]);
    }
  }
}
