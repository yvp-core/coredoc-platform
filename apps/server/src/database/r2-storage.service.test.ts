import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { R2StorageService, StorageConditionalWriteError } from './r2-storage.service.js';

const s3ClientCtor = vi.fn();
const s3Send = vi.fn().mockResolvedValue({});
const s3Destroy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3Send;
    destroy = s3Destroy;
    constructor(config: unknown) {
      s3ClientCtor(config);
    }
  },
  PutObjectCommand: class {
    middlewareStack = { add: vi.fn() };
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

async function collect(stream: AsyncIterable<Uint8Array> | null): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Tests for R2StorageService in local-fallback mode (no R2_ENDPOINT set).
 * This tests the filesystem-based storage used during development.
 */
describe('R2StorageService (local fallback)', () => {
  let service: R2StorageService;
  let tempDir: string;

  beforeEach(() => {
    // Ensure R2 is not configured so local fallback is used
    delete process.env.R2_ENDPOINT;

    // Create temp dir and mock process.cwd() so .r2-local/ goes there
    tempDir = mkdtempSync(join(tmpdir(), 'r2-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    service = new R2StorageService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uploads and downloads a file', async () => {
    const data = Buffer.from('hello world');
    await service.upload('test/file.txt', data);

    const downloaded = await service.download('test/file.txt');
    expect(downloaded).not.toBeNull();
    expect(downloaded!.toString()).toBe('hello world');
  });

  it('streams a local file without routing through the buffering download API', async () => {
    await service.upload('test/stream.bin', Buffer.from('streamed bytes'));
    const downloadSpy = vi.spyOn(service, 'download');

    const body = await collect(await service.downloadStream('test/stream.bin'));

    expect(body?.toString()).toBe('streamed bytes');
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('returns null when a streamed local object does not exist', async () => {
    await expect(service.downloadStream('missing.bin')).resolves.toBeNull();
  });

  it('returns null when downloading non-existent file', async () => {
    const result = await service.download('does/not/exist.txt');
    expect(result).toBeNull();
  });

  it('overwrites existing file on re-upload', async () => {
    await service.upload('key.txt', Buffer.from('version 1'));
    await service.upload('key.txt', Buffer.from('version 2'));

    const result = await service.download('key.txt');
    expect(result!.toString()).toBe('version 2');
  });

  it('deletes a file', async () => {
    await service.upload('to-delete.txt', Buffer.from('bye'));
    await service.delete('to-delete.txt');

    const result = await service.download('to-delete.txt');
    expect(result).toBeNull();
  });

  it('delete is a no-op for non-existent file', async () => {
    // Should not throw
    await service.delete('nonexistent.txt');
  });

  it('lists files with prefix', async () => {
    await service.upload('ws_1/repo-a/parser.tar.gz', Buffer.from('a'));
    await service.upload('ws_1/repo-b/parser.tar.gz', Buffer.from('b'));

    const files = await service.list('ws_1/');
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array when listing non-existent prefix', async () => {
    const files = await service.list('nonexistent/');
    expect(files).toEqual([]);
  });

  it('creates nested directories automatically', async () => {
    await service.upload('deep/nested/path/file.bin', Buffer.from('data'));
    const result = await service.download('deep/nested/path/file.bin');
    expect(result!.toString()).toBe('data');
  });

  it('exists returns true for uploaded file', async () => {
    await service.upload('check-exists.txt', Buffer.from('data'));
    const result = await service.exists('check-exists.txt');
    expect(result).toBe(true);
  });

  it('exists returns false for non-existent file', async () => {
    const result = await service.exists('does/not/exist.txt');
    expect(result).toBe(false);
  });

  it('exists returns false after file is deleted', async () => {
    await service.upload('ephemeral.txt', Buffer.from('data'));
    await service.delete('ephemeral.txt');
    const result = await service.exists('ephemeral.txt');
    expect(result).toBe(false);
  });

  it('heads a local object with its exact byte length and returns null when absent', async () => {
    await service.upload('graphs/version.ladybug', Buffer.from('immutable'));

    await expect(service.headObject('graphs/version.ladybug')).resolves.toEqual({
      contentLength: 9,
      contentType: null,
      etag: null,
      lastModified: expect.any(Date),
      metadata: {},
    });
    await expect(service.headObject('graphs/missing.ladybug')).resolves.toBeNull();
  });

  it('persists conditional object identity metadata across service instances', async () => {
    const sourcePath = join(tempDir, 'graph.ladybug');
    writeFileSync(sourcePath, 'immutable-graph');
    const metadata = {
      sha256: 'a'.repeat(64),
      versionid: 'version-1',
      workspaceid: 'workspace-1',
    };

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 15,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata,
      }),
    ).resolves.toBe('created');

    const restarted = new R2StorageService();
    await expect(restarted.headObject('ws/graphs/version.ladybug')).resolves.toEqual({
      contentLength: 15,
      contentType: 'application/vnd.coredoc.ladybug',
      etag: null,
      lastModified: expect.any(Date),
      metadata,
    });
    await expect(restarted.download('ws/graphs/version.ladybug')).resolves.toEqual(Buffer.from('immutable-graph'));
  });

  it('publishes a local file exactly once without truncating the winner', async () => {
    const firstPath = join(tempDir, 'first.ladybug');
    const replayPath = join(tempDir, 'replay.ladybug');
    writeFileSync(firstPath, 'first-writer');
    writeFileSync(replayPath, 'different-replay');

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', firstPath, {
        contentLength: 12,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: { sha256: 'first-sha' },
      }),
    ).resolves.toBe('created');
    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', replayPath, {
        contentLength: 16,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: { sha256: 'second-sha' },
      }),
    ).resolves.toBe('already_exists');

    await expect(service.download('ws/graphs/version.ladybug')).resolves.toEqual(Buffer.from('first-writer'));
    await expect(service.headObject('ws/graphs/version.ladybug')).resolves.toMatchObject({
      contentLength: 12,
      contentType: 'application/vnd.coredoc.ladybug',
      metadata: { sha256: 'first-sha' },
    });
  });

  it('keeps one immutable body and matching metadata under concurrent conditional writers', async () => {
    const firstPath = join(tempDir, 'concurrent-first.ladybug');
    const secondPath = join(tempDir, 'concurrent-second.ladybug');
    writeFileSync(firstPath, 'winner-one');
    writeFileSync(secondPath, 'winner-two');
    const key = 'ws/graphs/concurrent.ladybug';

    const outcomes = await Promise.all([
      service.putFileIfAbsent(key, firstPath, {
        contentLength: 10,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: { sha256: 'sha-one' },
      }),
      service.putFileIfAbsent(key, secondPath, {
        contentLength: 10,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: { sha256: 'sha-two' },
      }),
    ]);

    expect(outcomes.sort()).toEqual(['already_exists', 'created']);
    const body = await service.download(key);
    const expectedMetadata = body?.toString() === 'winner-one' ? { sha256: 'sha-one' } : { sha256: 'sha-two' };
    expect(['winner-one', 'winner-two']).toContain(body?.toString());
    await expect(service.headObject(key)).resolves.toMatchObject({ metadata: expectedMetadata });
  });

  it('conditionally publishes buffered component bytes without replacing the winner', async () => {
    const key = 'ws/repo/results/parsed/collision.json';
    const outcomes = await Promise.all([
      service.putBufferIfAbsent(key, Buffer.from('winner-one'), {
        contentType: 'application/json',
        metadata: { sha256: 'sha-one' },
      }),
      service.putBufferIfAbsent(key, Buffer.from('winner-two'), {
        contentType: 'application/json',
        metadata: { sha256: 'sha-two' },
      }),
    ]);

    expect(outcomes.sort()).toEqual(['already_exists', 'created']);
    const body = await service.download(key);
    const expectedMetadata = body?.toString() === 'winner-one' ? { sha256: 'sha-one' } : { sha256: 'sha-two' };
    expect(['winner-one', 'winner-two']).toContain(body?.toString());
    await expect(service.headObject(key)).resolves.toMatchObject({
      contentLength: 10,
      contentType: 'application/json',
      metadata: expectedMetadata,
    });
  });

  it('lists a conditional bundle as one logical key, hides staging, and deletes the whole object', async () => {
    const sourcePath = join(tempDir, 'listed.ladybug');
    writeFileSync(sourcePath, 'listed-body');
    const key = 'ws/graphs/listed.ladybug';

    await service.putFileIfAbsent(key, sourcePath, {
      contentLength: 11,
      contentType: 'application/vnd.coredoc.ladybug',
      metadata: { sha256: 'listed-sha' },
    });
    const parent = join(tempDir, '.r2-local', 'coredoc-parsers', 'ws', 'graphs');
    mkdirSync(join(parent, '.coredoc-r2-staging-orphan'), { recursive: true });

    await expect(service.list('ws/graphs/')).resolves.toEqual([key]);
    await expect(service.list(key)).resolves.toEqual([key]);
    await expect(service.list(`${key}/`)).resolves.toEqual([]);

    await service.delete(key);

    await expect(service.headObject(key)).resolves.toBeNull();
    await expect(service.download(key)).resolves.toBeNull();
    await expect(service.exists(key)).resolves.toBe(false);
    await expect(service.list('ws/graphs/')).resolves.toEqual([]);
    expect(existsSync(join(parent, 'listed.ladybug'))).toBe(false);
  });

  it('cleans a fully staged body when the conditional write is aborted before publish', async () => {
    const sourcePath = join(tempDir, 'abort-after-copy.ladybug');
    writeFileSync(sourcePath, 'staged-body');
    const key = 'ws/graphs/aborted-after-copy.ladybug';
    const reason = new Error('worker shutdown');
    const controller = new AbortController();
    const metadata: Record<string, string> = {};
    Object.defineProperty(metadata, 'sha256', {
      enumerable: true,
      get: () => {
        controller.abort(reason);
        return 'staged-sha';
      },
    });

    await expect(
      service.putFileIfAbsent(key, sourcePath, {
        contentLength: 11,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    await expect(service.headObject(key)).resolves.toBeNull();
    await expect(service.download(key)).resolves.toBeNull();
    await expect(service.exists(key)).resolves.toBe(false);
    const parent = join(tempDir, '.r2-local', 'coredoc-parsers', 'ws', 'graphs');
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
  });

  it('keeps ordinary upload overwrite behavior when replacing a conditional local object', async () => {
    const sourcePath = join(tempDir, 'conditional.ladybug');
    writeFileSync(sourcePath, 'conditional');
    const key = 'ws/graphs/replaceable.ladybug';
    await service.putFileIfAbsent(key, sourcePath, {
      contentLength: 11,
      contentType: 'application/vnd.coredoc.ladybug',
      metadata: { sha256: 'conditional-sha' },
    });

    await service.upload(key, Buffer.from('ordinary'));

    await expect(service.download(key)).resolves.toEqual(Buffer.from('ordinary'));
    await expect(service.headObject(key)).resolves.toMatchObject({
      contentLength: 8,
      contentType: null,
      metadata: {},
    });
  });

  it('rejects a mismatched local content length before creating the destination', async () => {
    const sourcePath = join(tempDir, 'short.ladybug');
    writeFileSync(sourcePath, 'short');

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 6,
        contentType: 'application/octet-stream',
        metadata: {},
      }),
    ).rejects.toThrow(/content length/i);
    await expect(service.headObject('ws/graphs/version.ladybug')).resolves.toBeNull();
  });

  it('honors an already-aborted signal without creating a local destination', async () => {
    const sourcePath = join(tempDir, 'aborted.ladybug');
    writeFileSync(sourcePath, 'bytes');
    const reason = new Error('worker shutdown');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 5,
        contentType: 'application/octet-stream',
        metadata: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(service.headObject('ws/graphs/version.ladybug')).resolves.toBeNull();
  });

  it('preserves an explicit abort reason when heading a local object', async () => {
    const reason = Object.assign(new Error('worker shutdown'), { code: 'ENOENT' });
    const controller = new AbortController();
    controller.abort(reason);

    await expect(service.headObject('missing', { signal: controller.signal })).rejects.toBe(reason);
  });

  describe('path-traversal containment', () => {
    const traversalKey = '../../escaped.txt';
    // The fallback root is tempDir/.r2-local/coredoc-parsers, so `../../escaped.txt`
    // would resolve to tempDir/escaped.txt — outside the store.
    const escapedPath = () => join(tempDir, 'escaped.txt');

    it('rejects upload with a traversal key and writes nothing outside the store', async () => {
      await expect(service.upload(traversalKey, Buffer.from('pwned'))).rejects.toThrow(/path traversal/i);
      expect(existsSync(escapedPath())).toBe(false);
    });

    it('rejects download with a traversal key', async () => {
      await expect(service.download(traversalKey)).rejects.toThrow(/path traversal/i);
    });

    it('rejects exists with a traversal key', async () => {
      await expect(service.exists(traversalKey)).rejects.toThrow(/path traversal/i);
    });

    it('rejects immutable HEAD and PUT operations with traversal keys', async () => {
      const sourcePath = join(tempDir, 'source.ladybug');
      writeFileSync(sourcePath, 'bytes');

      await expect(service.headObject(traversalKey)).rejects.toThrow(/path traversal/i);
      await expect(
        service.putFileIfAbsent(traversalKey, sourcePath, {
          contentLength: 5,
          contentType: 'application/octet-stream',
          metadata: {},
        }),
      ).rejects.toThrow(/path traversal/i);
      expect(existsSync(escapedPath())).toBe(false);
    });

    it('rejects delete with a traversal key', async () => {
      await expect(service.delete(traversalKey)).rejects.toThrow(/path traversal/i);
    });

    it('rejects list with a traversal prefix', async () => {
      await expect(service.list('../../')).rejects.toThrow(/path traversal/i);
    });

    it('still allows legitimate nested keys', async () => {
      await service.upload('ws_1/repo-a/nested/file.bin', Buffer.from('ok'));
      const result = await service.download('ws_1/repo-a/nested/file.bin');
      expect(result!.toString()).toBe('ok');
    });
  });
});

/**
 * Tests for the S3 client construction when an S3-compatible endpoint IS configured.
 * Guards the GCS/R2 interoperability config (checksum flags, region, path-style).
 */
describe('R2StorageService (S3-compatible client config)', () => {
  let tempDir: string;
  let sourcePath: string;

  beforeEach(() => {
    s3ClientCtor.mockClear();
    s3Send.mockReset().mockResolvedValue({});
    s3Destroy.mockClear();
    process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    tempDir = mkdtempSync(join(tmpdir(), 'r2-remote-test-'));
    sourcePath = join(tempDir, 'graph.ladybug');
    writeFileSync(sourcePath, 'graph-bytes');
  });

  afterEach(() => {
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_REGION;
    delete process.env.R2_FORCE_PATH_STYLE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets checksum compatibility flags so non-AWS backends (GCS) accept requests', async () => {
    process.env.R2_ENDPOINT = 'https://storage.googleapis.com';
    await new R2StorageService().upload('k', Buffer.from('x'));

    expect(s3ClientCtor).toHaveBeenCalledTimes(1);
    const config = s3ClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(config.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(config.endpoint).toBe('https://storage.googleapis.com');
  });

  it('defaults region to "auto" and path-style off', async () => {
    await new R2StorageService().upload('k', Buffer.from('x'));

    const config = s3ClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.region).toBe('auto');
    expect(config.forcePathStyle).toBe(false);
  });

  it('honors R2_REGION and R2_FORCE_PATH_STYLE overrides', async () => {
    process.env.R2_REGION = 'us-east1';
    process.env.R2_FORCE_PATH_STYLE = 'true';

    await new R2StorageService().upload('k', Buffer.from('x'));

    const config = s3ClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.region).toBe('us-east1');
    expect(config.forcePathStyle).toBe(true);
  });

  it('constructs one S3 client for parallel first requests', async () => {
    const service = new R2StorageService();

    await Promise.all([
      service.upload('first', Buffer.from('1')),
      service.upload('second', Buffer.from('2')),
      service.upload('third', Buffer.from('3')),
    ]);

    expect(s3ClientCtor).toHaveBeenCalledTimes(1);
    expect(s3Send).toHaveBeenCalledTimes(3);
  });

  it('destroys the retained client exactly once and rejects later initialization', async () => {
    const service = new R2StorageService();
    await service.upload('before-shutdown', Buffer.from('x'));

    await Promise.all([service.onModuleDestroy(), service.onModuleDestroy()]);

    expect(s3Destroy).toHaveBeenCalledTimes(1);
    await expect(service.upload('after-shutdown', Buffer.from('x'))).rejects.toThrow(/shutting down/i);
    expect(s3ClientCtor).toHaveBeenCalledTimes(1);
  });

  it('returns the S3 response body as a stream and forwards the abort signal', async () => {
    const body = (async function* () {
      yield Buffer.from('remote');
    })();
    s3Send.mockResolvedValueOnce({ Body: body });
    const controller = new AbortController();
    const service = new R2StorageService();

    await expect(
      collect(await service.downloadStream('ws/version.graph', { signal: controller.signal })),
    ).resolves.toEqual(Buffer.from('remote'));
    expect(s3Send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: 'coredoc-parsers', Key: 'ws/version.graph' } }),
      { abortSignal: controller.signal },
    );
  });

  it('heads a remote object and exposes immutable verification metadata', async () => {
    const lastModified = new Date('2026-08-11T10:00:00.000Z');
    s3Send.mockResolvedValueOnce({
      ContentLength: 11,
      ContentType: 'application/vnd.coredoc.ladybug',
      ETag: '"etag"',
      LastModified: lastModified,
      Metadata: { sha256: 'digest', versionid: 'version' },
    });
    const controller = new AbortController();
    const service = new R2StorageService();

    await expect(service.headObject('ws/graphs/version.ladybug', { signal: controller.signal })).resolves.toEqual({
      contentLength: 11,
      contentType: 'application/vnd.coredoc.ladybug',
      etag: '"etag"',
      lastModified,
      metadata: { sha256: 'digest', versionid: 'version' },
    });
    expect(s3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: 'coredoc-parsers', Key: 'ws/graphs/version.ladybug' },
      }),
      { abortSignal: controller.signal },
    );
  });

  it('returns null only for a remote HEAD 404', async () => {
    s3Send.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    const service = new R2StorageService();

    await expect(service.headObject('missing')).resolves.toBeNull();

    const denied = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
    s3Send.mockRejectedValueOnce(denied);
    await expect(service.headObject('denied')).rejects.toBe(denied);
  });

  it('preserves an explicit abort reason during a remote HEAD', async () => {
    const reason = new Error('worker shutdown');
    const controller = new AbortController();
    s3Send.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const service = new R2StorageService();

    await expect(service.headObject('ws/graphs/version.ladybug', { signal: controller.signal })).rejects.toBe(reason);
  });

  it('on GCS, checks existence with HEAD and writes without any precondition header', async () => {
    // GCS rejects x-goog-* alongside SigV4's x-amz-* headers and ignores If-None-Match.
    process.env.R2_ENDPOINT = 'https://storage.googleapis.com';
    const controller = new AbortController();
    const service = new R2StorageService();
    s3Send.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: { sha256: 'digest', versionid: 'version' },
        signal: controller.signal,
      }),
    ).resolves.toBe('created');

    expect(s3Send).toHaveBeenCalledTimes(2);
    const head = s3Send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(head.input).toEqual({ Bucket: 'coredoc-parsers', Key: 'ws/graphs/version.ladybug' });
    const command = s3Send.mock.calls[1]?.[0] as {
      input: Record<string, unknown>;
      middlewareStack: { add: ReturnType<typeof vi.fn> };
    };
    expect(command.input).toEqual(
      expect.objectContaining({
        Key: 'ws/graphs/version.ladybug',
        Metadata: { sha256: 'digest', versionid: 'version' },
        Body: expect.objectContaining({ path: sourcePath }),
      }),
    );
    expect(command.input.IfNoneMatch).toBeUndefined();
    expect(command.middlewareStack.add).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledWith(command, { abortSignal: controller.signal });
  });

  it('on GCS, reports an existing object from HEAD without issuing a PUT', async () => {
    process.env.R2_ENDPOINT = 'https://storage.googleapis.com';
    const service = new R2StorageService();
    s3Send.mockResolvedValueOnce({ ContentLength: 2, Metadata: { sha256: 'digest' } });

    await expect(
      service.putBufferIfAbsent('ws/results/version.json', Buffer.from('{}'), {
        contentType: 'application/json',
      }),
    ).resolves.toBe('already_exists');

    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('keeps the S3 If-None-Match precondition for non-GCS endpoints', async () => {
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: {},
      }),
    ).resolves.toBe('created');

    const command = s3Send.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
      middlewareStack: { add: ReturnType<typeof vi.fn> };
    };
    expect(command.input.IfNoneMatch).toBe('*');
    expect(command.middlewareStack.add).not.toHaveBeenCalled();
  });

  it('classifies a conditional-write precondition failure as already existing', async () => {
    s3Send.mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/octet-stream',
        metadata: {},
      }),
    ).resolves.toBe('already_exists');
  });

  it.each([
    ['conflict', { name: 'Conflict', $metadata: { httpStatusCode: 409 } }],
    ['transport failure', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['server failure', { name: 'InternalError', $metadata: { httpStatusCode: 503 } }],
  ])('classifies an ambiguous %s for caller-side HEAD and byte verification', async (_label, failure) => {
    s3Send.mockRejectedValueOnce(failure);
    const service = new R2StorageService();

    const result = service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
      contentLength: 11,
      contentType: 'application/octet-stream',
      metadata: {},
    });

    await expect(result).rejects.toMatchObject({
      name: 'StorageConditionalWriteError',
      outcome: 'ambiguous',
      cause: failure,
    });
  });

  it('preserves an explicit caller abort reason during a conditional write', async () => {
    const reason = new Error('worker shutdown');
    const controller = new AbortController();
    s3Send.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/octet-stream',
        metadata: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it('classifies a timed-out conditional write as ambiguous', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const controller = new AbortController();
    s3Send.mockImplementationOnce(async () => {
      controller.abort(timeout);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/octet-stream',
        metadata: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(StorageConditionalWriteError);
  });

  it('classifies a direct SDK timeout as ambiguous even when it carries a client status', async () => {
    const timeout = Object.assign(new Error('request timed out'), {
      name: 'TimeoutError',
      $metadata: { httpStatusCode: 400 },
    });
    s3Send.mockRejectedValueOnce(timeout);
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/octet-stream',
        metadata: {},
      }),
    ).rejects.toMatchObject({ outcome: 'ambiguous', cause: timeout });
  });

  it('rethrows a deterministic remote rejection without marking its outcome ambiguous', async () => {
    const denied = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
    s3Send.mockRejectedValueOnce(denied);
    const service = new R2StorageService();

    await expect(
      service.putFileIfAbsent('ws/graphs/version.ladybug', sourcePath, {
        contentLength: 11,
        contentType: 'application/octet-stream',
        metadata: {},
      }),
    ).rejects.toBe(denied);
  });
});
