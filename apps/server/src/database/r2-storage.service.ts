/**
 * R2 Storage Service
 *
 * S3-compatible client for object storage. Works against Cloudflare R2 (default)
 * or any S3-compatible backend, including Google Cloud Storage's interoperability
 * (XML) API — used by self-hosted client deployments. Stores parser artifacts,
 * mappers, and versioned results.
 *
 * Required environment variables:
 *   R2_ENDPOINT        — S3-compatible endpoint
 *                          R2:  https://<account>.r2.cloudflarestorage.com
 *                          GCS: https://storage.googleapis.com
 *   R2_ACCESS_KEY_ID   — access key (GCS: HMAC key access ID)
 *   R2_SECRET_ACCESS_KEY — secret key (GCS: HMAC key secret)
 *   R2_BUCKET          — Bucket name (default: coredoc-parsers)
 *   R2_REGION          — signing region (default: auto; GCS may need a real region)
 *   R2_FORCE_PATH_STYLE — set "true" for path-style addressing (some S3-compatible backends)
 *
 * Falls back to local filesystem storage when R2 is not configured (dev mode).
 */

import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, configFromEnv } from '../config/app-config.js';
import type { S3Client as AwsS3Client } from '@aws-sdk/client-s3';
import { join, resolve, sep, dirname } from 'node:path';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { finished, pipeline } from 'node:stream/promises';

export interface StorageDownloadStreamOptions {
  signal?: AbortSignal;
}

export interface StorageObjectHead {
  readonly contentLength: number | null;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: Date | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StoragePutFileIfAbsentOptions {
  readonly contentLength: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface StoragePutBufferIfAbsentOptions {
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type StorageConditionalWriteOutcome = 'ambiguous' | 'retryable';

/**
 * A conditional write failure whose outcome needs explicit caller recovery.
 * `ambiguous` means the request may have committed, so callers must verify the
 * canonical object before deciding whether a retry is safe. `retryable` means
 * reconciliation proved that no canonical object exists.
 */
export class StorageConditionalWriteError extends Error {
  constructor(
    public readonly outcome: StorageConditionalWriteOutcome,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'StorageConditionalWriteError';
  }
}

interface StorageSdkError {
  readonly name?: string;
  readonly code?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function storageHttpStatus(error: unknown): number | undefined {
  return (error as StorageSdkError | null)?.$metadata?.httpStatusCode;
}

function isMissingObject(error: unknown): boolean {
  const storageError = error as StorageSdkError | null;
  return storageError?.name === 'NotFound' || storageError?.name === 'NoSuchKey' || storageHttpStatus(error) === 404;
}

function isPreconditionFailure(error: unknown): boolean {
  const storageError = error as StorageSdkError | null;
  return storageError?.name === 'PreconditionFailed' || storageHttpStatus(error) === 412;
}

function isTimeoutReason(reason: unknown): boolean {
  const error = reason as { readonly name?: string; readonly code?: string } | null;
  return error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
}

function isAmbiguousConditionalWriteFailure(error: unknown): boolean {
  if (isTimeoutReason(error)) return true;
  const status = storageHttpStatus(error);
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

// GCS's XML API rejects any request mixing x-goog-* and x-amz-* headers
// (ExcessHeaderValues), and SigV4 signing always sends x-amz-date /
// x-amz-content-sha256, so x-goog-if-generation-match is unusable through this
// SDK. GCS also accepts S3's If-None-Match: * on PUT but silently ignores it.
// Verified against storage.googleapis.com on 2026-09-09. GCS therefore gets a
// HEAD-then-PUT with no write precondition; the remaining race window is
// benign because every caller's key is content-derived (results: sha256 of
// the bytes; graph snapshots: sha256 of the manifest identity), so a lost race
// rewrites the same key from the same identity.
function isGoogleCloudStorageEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return new URL(endpoint).hostname === 'storage.googleapis.com';
  } catch {
    // intentional: an unparseable endpoint is not GCS. It stays on the S3 path,
    // where the very next request fails loudly with the bad endpoint in hand —
    // logging it here would only duplicate that error at startup.
    return false;
  }
}

const LOCAL_BUNDLE_FORMAT_VERSION = 1;
const LOCAL_BUNDLE_BODY_FILE = '.coredoc-r2-object.body';
const LOCAL_BUNDLE_MANIFEST_FILE = '.coredoc-r2-object.json';
const LOCAL_STAGING_PREFIX = '.coredoc-r2-staging-';

interface LocalBundleManifest {
  readonly formatVersion: typeof LOCAL_BUNDLE_FORMAT_VERSION;
  readonly contentLength: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}

interface LocalObject {
  readonly objectPath: string;
  readonly bodyPath: string;
  readonly bundled: boolean;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly lastModified: Date;
  readonly metadata: Readonly<Record<string, string>>;
}

function parseLocalBundleManifest(raw: string, key: string): LocalBundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt local conditional object metadata for ${key}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Corrupt local conditional object metadata for ${key}`);
  }
  const manifest = value as Partial<LocalBundleManifest>;
  const contentLength = manifest.contentLength;
  const metadata = manifest.metadata;
  if (
    manifest.formatVersion !== LOCAL_BUNDLE_FORMAT_VERSION ||
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    typeof manifest.contentType !== 'string' ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.values(metadata).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`Corrupt local conditional object metadata for ${key}`);
  }
  return {
    formatVersion: LOCAL_BUNDLE_FORMAT_VERSION,
    contentLength,
    contentType: manifest.contentType,
    metadata: { ...metadata },
  };
}

@Injectable()
export class R2StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(R2StorageService.name);
  private s3Client: AwsS3Client | null = null;
  private s3ClientPromise: Promise<AwsS3Client> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly bucket: string;
  private readonly localFallbackDir: string;
  private readonly useLocal: boolean;
  private readonly gcsHeadBeforePut: boolean;

  constructor(@Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = configFromEnv().storage) {
    this.bucket = storage.r2.bucket;
    this.localFallbackDir = join(process.cwd(), '.r2-local', this.bucket);
    this.useLocal = !storage.r2.endpoint;
    this.gcsHeadBeforePut = isGoogleCloudStorageEndpoint(storage.r2.endpoint);

    if (this.useLocal) {
      this.logger.warn('R2 not configured — using local filesystem fallback (.r2-local/)');
    }
  }

  onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.destroyPromise ??= this.destroyS3Client();
    return this.destroyPromise;
  }

  /**
   * Resolve a storage key to an absolute local-fallback path, rejecting any key
   * that escapes the fallback root via `..` traversal. Local fallback joins the
   * key straight into the filesystem, so an unvalidated key such as
   * `../../etc/cron.d/x` would let a caller read/write/delete outside the store.
   * This is the single chokepoint for every local-fallback path, so it contains
   * all callers regardless of upstream validation. Fail fast on traversal.
   */
  private resolveLocalPath(key: string): string {
    const base = resolve(this.localFallbackDir);
    const target = resolve(base, key);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Invalid storage key (path traversal): ${key}`);
    }
    return target;
  }

  /**
   * Conditional objects use a directory so one same-parent rename publishes
   * body and identity together. Regular files remain readable for artifacts
   * created by ordinary upload or older local-fallback versions.
   */
  private async readLocalObject(key: string): Promise<LocalObject | null> {
    const objectPath = this.resolveLocalPath(key);
    let objectStat: Stats;
    try {
      objectStat = await stat(objectPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
      throw error;
    }

    if (objectStat.isFile()) {
      return {
        objectPath,
        bodyPath: objectPath,
        bundled: false,
        contentLength: objectStat.size,
        contentType: null,
        lastModified: objectStat.mtime,
        metadata: {},
      };
    }
    if (!objectStat.isDirectory()) return null;

    const manifestPath = join(objectPath, LOCAL_BUNDLE_MANIFEST_FILE);
    let manifestRaw: string;
    try {
      manifestRaw = await readFile(manifestPath, 'utf8');
    } catch (error: unknown) {
      // A normal directory can be a key prefix for nested legacy objects.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
      throw error;
    }
    const manifest = parseLocalBundleManifest(manifestRaw, key);
    const bodyPath = join(objectPath, LOCAL_BUNDLE_BODY_FILE);
    let bodyStat: Stats;
    try {
      bodyStat = await stat(bodyPath);
    } catch (error: unknown) {
      throw new Error(`Corrupt local conditional object body for ${key}`, { cause: error });
    }
    if (!bodyStat.isFile() || bodyStat.size !== manifest.contentLength) {
      throw new Error(`Corrupt local conditional object body for ${key}`);
    }
    return {
      objectPath,
      bodyPath,
      bundled: true,
      contentLength: bodyStat.size,
      contentType: manifest.contentType,
      lastModified: objectStat.mtime,
      metadata: manifest.metadata,
    };
  }

  /**
   * Lazily initialize the S3 client (avoids importing @aws-sdk at startup if not configured).
   */
  private async getS3Client(): Promise<AwsS3Client> {
    if (this.shuttingDown) {
      throw new Error('R2 storage service is shutting down');
    }
    if (this.s3Client) return this.s3Client;
    if (this.s3ClientPromise) return this.s3ClientPromise;

    const initialization = this.initializeS3Client();
    this.s3ClientPromise = initialization;
    try {
      return await initialization;
    } finally {
      if (this.s3ClientPromise === initialization) this.s3ClientPromise = null;
    }
  }

  private async initializeS3Client(): Promise<AwsS3Client> {
    const { S3Client } = await import('@aws-sdk/client-s3');
    if (this.shuttingDown) {
      throw new Error('R2 storage service is shutting down');
    }

    const client = new S3Client({
      region: this.storage.r2.region,
      endpoint: this.storage.r2.endpoint!,
      forcePathStyle: this.storage.r2.forcePathStyle,
      credentials: {
        accessKeyId: this.storage.r2.accessKeyId!,
        secretAccessKey: this.storage.r2.secretAccessKey!,
      },
      // AWS SDK v3 (>= 3.729) sends checksum integrity headers by default, which
      // non-AWS S3-compatible backends (GCS, R2, MinIO) reject with checksum/
      // signature-mismatch errors. WHEN_REQUIRED restores the pre-2025 behavior.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.s3Client = client;
    return client;
  }

  private async destroyS3Client(): Promise<void> {
    let client = this.s3Client;
    if (!client && this.s3ClientPromise) {
      try {
        client = await this.s3ClientPromise;
      } catch {
        // Initialization observes shuttingDown and exits without retaining a client.
      }
    }
    client ??= this.s3Client;
    if (!client) return;

    if (this.s3Client === client) this.s3Client = null;
    client.destroy();
  }

  /**
   * Upload an object to R2 (or local fallback).
   */
  async upload(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (this.useLocal) {
      const filePath = this.resolveLocalPath(key);
      const existing = await this.readLocalObject(key);
      if (existing?.bundled) await rm(filePath, { recursive: true, force: true });
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, body);
      this.logger.debug(`Local write: ${key} (${body.length} bytes)`);
      return;
    }

    const client = await this.getS3Client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    this.logger.debug(`R2 upload: ${key} (${body.length} bytes)`);
  }

  /**
   * Read object identity metadata without downloading the body.
   */
  async headObject(key: string, options: StorageDownloadStreamOptions = {}): Promise<StorageObjectHead | null> {
    throwIfAborted(options.signal);

    if (this.useLocal) {
      try {
        const object = await this.readLocalObject(key);
        throwIfAborted(options.signal);
        if (!object) return null;
        return {
          contentLength: object.contentLength,
          contentType: object.contentType,
          etag: null,
          lastModified: object.lastModified,
          metadata: object.metadata,
        };
      } catch (error: unknown) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw error;
      }
    }

    try {
      const client = await this.getS3Client();
      throwIfAborted(options.signal);
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const command = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
      const response = options.signal
        ? await client.send(command, { abortSignal: options.signal })
        : await client.send(command);
      return {
        contentLength: response.ContentLength ?? null,
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
        lastModified: response.LastModified ?? null,
        metadata: { ...(response.Metadata ?? {}) },
      };
    } catch (error: unknown) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  /**
   * Publish a file without ever replacing an existing object.
   */
  async putFileIfAbsent(
    key: string,
    sourcePath: string,
    options: StoragePutFileIfAbsentOptions,
  ): Promise<'created' | 'already_exists'> {
    if (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0) {
      throw new Error(`Invalid storage content length for ${key}: ${options.contentLength}`);
    }
    throwIfAborted(options.signal);

    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error(`Storage upload source is not a file: ${sourcePath}`);
    if (source.size !== options.contentLength) {
      throw new Error(
        `Storage content length mismatch for ${key}: expected ${options.contentLength}, found ${source.size}`,
      );
    }
    throwIfAborted(options.signal);

    if (this.useLocal) {
      return this.putLocalFileIfAbsent(key, sourcePath, options);
    }

    if (this.gcsHeadBeforePut && (await this.headObject(key, { signal: options.signal }))) return 'already_exists';
    const client = await this.getS3Client();
    throwIfAborted(options.signal);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const body = createReadStream(sourcePath, { signal: options.signal });
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: options.contentLength,
      ContentType: options.contentType,
      Metadata: { ...options.metadata },
      ...(this.gcsHeadBeforePut ? {} : { IfNoneMatch: '*' }),
    });

    try {
      if (options.signal) {
        await client.send(command, { abortSignal: options.signal });
      } else {
        await client.send(command);
      }
      this.logger.debug(`R2 conditional upload: ${key} (${options.contentLength} bytes)`);
      return 'created';
    } catch (error: unknown) {
      if (isPreconditionFailure(error)) return 'already_exists';

      if (options.signal?.aborted && !isTimeoutReason(options.signal.reason)) {
        throw options.signal.reason;
      }
      if (isAmbiguousConditionalWriteFailure(error) || isTimeoutReason(options.signal?.reason)) {
        throw new StorageConditionalWriteError(
          'ambiguous',
          `Conditional storage write outcome is ambiguous for ${key}`,
          error,
        );
      }
      throw error;
    } finally {
      body.destroy();
      await finished(body).catch(() => undefined);
    }
  }

  /**
   * Publish buffered bytes without ever replacing an existing object.
   * Component artifacts already exist in memory at this boundary, so this
   * closes the HEAD-then-PUT race without an extra temporary file.
   */
  async putBufferIfAbsent(
    key: string,
    body: Buffer,
    options: StoragePutBufferIfAbsentOptions,
  ): Promise<'created' | 'already_exists'> {
    throwIfAborted(options.signal);
    const metadata = { ...(options.metadata ?? {}) };

    if (this.useLocal) {
      return this.putLocalBufferIfAbsent(key, body, {
        contentLength: body.length,
        contentType: options.contentType,
        metadata,
        signal: options.signal,
      });
    }

    if (this.gcsHeadBeforePut && (await this.headObject(key, { signal: options.signal }))) return 'already_exists';
    const client = await this.getS3Client();
    throwIfAborted(options.signal);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: options.contentType,
      Metadata: metadata,
      ...(this.gcsHeadBeforePut ? {} : { IfNoneMatch: '*' }),
    });

    try {
      if (options.signal) {
        await client.send(command, { abortSignal: options.signal });
      } else {
        await client.send(command);
      }
      this.logger.debug(`R2 conditional buffer upload: ${key} (${body.length} bytes)`);
      return 'created';
    } catch (error: unknown) {
      if (isPreconditionFailure(error)) return 'already_exists';
      if (options.signal?.aborted && !isTimeoutReason(options.signal.reason)) {
        throw options.signal.reason;
      }
      if (isAmbiguousConditionalWriteFailure(error) || isTimeoutReason(options.signal?.reason)) {
        throw new StorageConditionalWriteError(
          'ambiguous',
          `Conditional storage write outcome is ambiguous for ${key}`,
          error,
        );
      }
      throw error;
    }
  }

  private async putLocalFileIfAbsent(
    key: string,
    sourcePath: string,
    options: StoragePutFileIfAbsentOptions,
  ): Promise<'created' | 'already_exists'> {
    const filePath = this.resolveLocalPath(key);
    const parentPath = dirname(filePath);
    await mkdir(parentPath, { recursive: true });
    throwIfAborted(options.signal);
    if (existsSync(filePath)) return 'already_exists';

    const stagingPath = await mkdtemp(join(parentPath, LOCAL_STAGING_PREFIX));
    const bodyPath = join(stagingPath, LOCAL_BUNDLE_BODY_FILE);
    let input: ReturnType<typeof createReadStream> | null = null;
    let output: ReturnType<typeof createWriteStream> | null = null;
    let published = false;

    try {
      input = createReadStream(sourcePath, { signal: options.signal });
      output = createWriteStream(bodyPath, { flags: 'wx' });
      await pipeline(input, output, { signal: options.signal });
      const stagedBody = await stat(bodyPath);
      if (stagedBody.size !== options.contentLength) {
        throw new Error(
          `Storage content length mismatch after staging ${key}: expected ${options.contentLength}, found ${stagedBody.size}`,
        );
      }
      const manifest: LocalBundleManifest = {
        formatVersion: LOCAL_BUNDLE_FORMAT_VERSION,
        contentLength: options.contentLength,
        contentType: options.contentType,
        metadata: { ...options.metadata },
      };
      throwIfAborted(options.signal);
      await writeFile(join(stagingPath, LOCAL_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), { flag: 'wx' });
      throwIfAborted(options.signal);
      try {
        await rename(stagingPath, filePath);
      } catch (error: unknown) {
        if (existsSync(filePath)) return 'already_exists';
        throw error;
      }
      published = true;
      this.logger.debug(`Local conditional write: ${key} (${options.contentLength} bytes)`);
      return 'created';
    } catch (error: unknown) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
    } finally {
      input?.destroy();
      output?.destroy();
      if (!published) await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private async putLocalBufferIfAbsent(
    key: string,
    body: Buffer,
    options: StoragePutFileIfAbsentOptions,
  ): Promise<'created' | 'already_exists'> {
    const filePath = this.resolveLocalPath(key);
    const parentPath = dirname(filePath);
    await mkdir(parentPath, { recursive: true });
    throwIfAborted(options.signal);
    if (existsSync(filePath)) return 'already_exists';

    const stagingPath = await mkdtemp(join(parentPath, LOCAL_STAGING_PREFIX));
    let published = false;
    try {
      await writeFile(join(stagingPath, LOCAL_BUNDLE_BODY_FILE), body, { flag: 'wx' });
      throwIfAborted(options.signal);
      const manifest: LocalBundleManifest = {
        formatVersion: LOCAL_BUNDLE_FORMAT_VERSION,
        contentLength: options.contentLength,
        contentType: options.contentType,
        metadata: { ...options.metadata },
      };
      await writeFile(join(stagingPath, LOCAL_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest), { flag: 'wx' });
      throwIfAborted(options.signal);
      try {
        await rename(stagingPath, filePath);
      } catch (error: unknown) {
        if (existsSync(filePath)) return 'already_exists';
        throw error;
      }
      published = true;
      this.logger.debug(`Local conditional buffer write: ${key} (${body.length} bytes)`);
      return 'created';
    } catch (error: unknown) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw error;
    } finally {
      if (!published) await rm(stagingPath, { recursive: true, force: true });
    }
  }

  /**
   * Check if an object exists in R2 (or local fallback) without downloading it.
   * Uses HEAD request for R2 — much cheaper than downloading the full object.
   */
  async exists(key: string): Promise<boolean> {
    if (this.useLocal) {
      return (await this.readLocalObject(key)) !== null;
    }

    try {
      const client = await this.getS3Client();
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (error: unknown) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  /**
   * Stream an object from R2 (or local fallback) without buffering it.
   * Returns null if the object does not exist.
   */
  async downloadStream(
    key: string,
    options: StorageDownloadStreamOptions = {},
  ): Promise<AsyncIterable<Uint8Array> | null> {
    if (this.useLocal) {
      throwIfAborted(options.signal);
      const object = await this.readLocalObject(key);
      throwIfAborted(options.signal);
      if (!object) return null;
      return createReadStream(object.bodyPath, { signal: options.signal });
    }

    try {
      const client = await this.getS3Client();
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      const response = options.signal
        ? await client.send(command, { abortSignal: options.signal })
        : await client.send(command);
      const body = response.Body as AsyncIterable<Uint8Array> | undefined;
      if (!body) return null;
      if (typeof body[Symbol.asyncIterator] !== 'function') {
        throw new Error(`Storage response body for ${key} is not an async iterable`);
      }
      return body;
    } catch (error: unknown) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  /**
   * Compatibility helper for existing small artifacts. Large graph files use
   * downloadStream() directly so their memory use stays independent of size.
   */
  async download(key: string): Promise<Buffer | null> {
    const stream = await this.downloadStream(key);
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /**
   * Delete an object from R2 (or local fallback).
   */
  async delete(key: string): Promise<void> {
    if (this.useLocal) {
      const object = await this.readLocalObject(key);
      if (object) await rm(object.objectPath, { recursive: object.bundled, force: true });
      return;
    }

    const client = await this.getS3Client();
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  /**
   * Generate a presigned download URL for an object.
   * Returns null if running in local fallback mode (no R2 configured).
   */
  async getPresignedDownloadUrl(key: string, expiresInSeconds = 300): Promise<string | null> {
    if (this.useLocal) return null;

    const client = await this.getS3Client();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    // The presigner resolves a duplicate Smithy client type in this workspace;
    // both packages use the same S3Client contract at runtime.
    const presignerClient = client as unknown as Parameters<typeof getSignedUrl>[0];
    return getSignedUrl(presignerClient, command, { expiresIn: expiresInSeconds });
  }

  /**
   * List objects with a given prefix.
   * Returns array of keys.
   */
  async list(prefix: string): Promise<string[]> {
    if (this.useLocal) {
      const exactObject = await this.readLocalObject(prefix);
      if (exactObject) return prefix.endsWith('/') ? [] : [prefix];
      const dir = this.resolveLocalPath(prefix);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((entry) => !entry.startsWith(LOCAL_STAGING_PREFIX))
        .map((entry) => `${prefix}${entry}`);
    }

    const client = await this.getS3Client();
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      }),
    );
    return (response.Contents ?? []).map((obj: { Key?: string }) => obj.Key).filter(Boolean) as string[];
  }
}
