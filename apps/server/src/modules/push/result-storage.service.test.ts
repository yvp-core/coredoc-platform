import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResultStorageService } from './result-storage.service.js';
import { R2StorageService } from '../../database/r2-storage.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';

function makeMockR2() {
  const store = new Map<string, Buffer>();
  const storage = {
    upload: vi.fn(async (key: string, body: Buffer) => {
      store.set(key, body);
    }),
    putBufferIfAbsent: vi.fn(async (key: string, body: Buffer) => {
      if (store.has(key)) return 'already_exists' as const;
      store.set(key, Buffer.from(body));
      return 'created' as const;
    }),
    download: vi.fn(async (key: string) => store.get(key) ?? null),
    // Mirrors production: putImmutableContent stamps sha256/sizebytes metadata,
    // and the dedup check verifies via HEAD before falling back to a download.
    headObject: vi.fn(async (key: string) => {
      const body = store.get(key);
      if (!body) return null;
      return {
        contentLength: body.length,
        contentType: null,
        etag: null,
        lastModified: null,
        metadata: { sha256: createHash('sha256').update(body).digest('hex'), sizebytes: String(body.length) },
      };
    }),
    exists: vi.fn(async (key: string) => store.has(key)),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => []),
    _store: store,
  };
  return storage as unknown as typeof storage & R2StorageService;
}

function makeMockPrisma(retainGraphArtifacts = false) {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ retainGraphArtifacts }),
    },
    workspaceRepoArtifact: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService & {
    workspace: { findUnique: ReturnType<typeof vi.fn> };
    workspaceRepoArtifact: { findUnique: ReturnType<typeof vi.fn> };
  };
}

function makeSummary(repoName = 'test'): SummaryOutput {
  return {
    repoId: 'repo-id',
    repoName,
    generatedAt: new Date().toISOString(),
    summarizerVersion: '1.0',
    summaries: [],
    stats: { totalFunctions: 0, summarized: 0, skipped: 0, failed: 0, cached: 0, totalTimeMs: 0 },
  } as SummaryOutput;
}

function makeRepo(name = 'test'): ParsedRepo {
  return {
    id: 'repo-id',
    name,
    path: '/test',
    parsedAt: new Date().toISOString(),
    parserVersion: '1.0',
    parserId: 'p1',
    packages: [],
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: { totalFiles: 0, totalFunctions: 0, totalClasses: 0, totalEntrypoints: 0, parseTimeMs: 0 },
  } as ParsedRepo;
}

function makeEmbeddings(repoName = 'test'): EmbeddingsOutput {
  return {
    repoId: 'repo-id',
    repoName,
    generatedAt: new Date().toISOString(),
    provider: 'test',
    model: 'test',
    dimensions: 2,
    inputStrategy: 'summary',
    functions: [],
    endpoints: [],
    stats: {},
  } as EmbeddingsOutput;
}

describe('ResultStorageService', () => {
  let r2: ReturnType<typeof makeMockR2>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: ResultStorageService;

  beforeEach(() => {
    r2 = makeMockR2();
    prisma = makeMockPrisma();
    service = new ResultStorageService(r2, prisma);
  });

  it('uploads result and returns version', async () => {
    const repo = makeRepo();
    const result = await service.uploadResult('ws1', 'myrepo', repo);

    expect(result.version).toHaveLength(16);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.r2Key).toBe(`ws1/myrepo/results/parsed/${result.version}.json`);
    expect(result.duplicate).toBe(false);
    expect(r2.putBufferIfAbsent).toHaveBeenCalledTimes(1);
    expect(r2.upload).not.toHaveBeenCalled();
  });

  it('detects duplicate upload', async () => {
    const repo = makeRepo();
    const r1 = await service.uploadResult('ws1', 'myrepo', repo);
    const r2Result = await service.uploadResult('ws1', 'myrepo', repo);

    expect(r2Result.version).toBe(r1.version);
    expect(r2Result.duplicate).toBe(true);
    expect(r2Result.sha256).toBe(r1.sha256);
  });

  it('rejects a truncated-version collision instead of blessing or overwriting different existing bytes', async () => {
    const repo = makeRepo();
    const first = await service.uploadResult('ws1', 'myrepo', repo);
    r2._store.set(first.r2Key, Buffer.from('different bytes under the same truncated route version'));

    await expect(service.uploadResult('ws1', 'myrepo', repo)).rejects.toBeInstanceOf(GraphSnapshotError);
    expect(r2.putBufferIfAbsent).toHaveBeenCalledTimes(2);
    expect(r2.upload).not.toHaveBeenCalled();
  });

  it('never overwrites a concurrent truncated-version winner with different bytes', async () => {
    const winner = Buffer.from('different bytes published by the concurrent winner');
    r2.putBufferIfAbsent.mockImplementationOnce(async (key: string) => {
      r2._store.set(key, winner);
      return 'already_exists';
    });

    await expect(service.uploadResult('ws1', 'myrepo', makeRepo())).rejects.toMatchObject({
      code: 'artifact_identity_conflict',
    });

    expect([...r2._store.values()]).toEqual([winner]);
    expect(r2.upload).not.toHaveBeenCalled();
  });

  it('downloads uploaded result', async () => {
    const repo = makeRepo('dl-test');
    const uploaded = await service.uploadResult('ws1', 'repo', repo);
    const downloaded = await service.downloadResult('ws1', 'repo', uploaded.version);

    expect(downloaded).not.toBeNull();
    expect(downloaded!.name).toBe('dl-test');
  });

  it('verifies registered graph-input bytes by full SHA, size, key, and repo identity before parsing', async () => {
    const repo = makeRepo('verified');
    const uploaded = await service.uploadResult('ws1', 'verified', repo);
    prisma.workspaceRepoArtifact.findUnique.mockResolvedValue({
      workspaceId: 'ws1',
      repoKey: 'repo-id',
      repoName: 'verified',
      kind: 'parsed',
      version: uploaded.version,
      r2Key: uploaded.r2Key,
      sha256: uploaded.sha256,
      sizeBytes: BigInt(uploaded.sizeBytes),
    });

    await expect(service.downloadResultForGraph('ws1', 'repo-id', 'verified', uploaded.version)).resolves.toMatchObject(
      { value: { id: 'repo-id', name: 'verified' }, registered: true },
    );
  });

  it('rejects replaced registered graph-input bytes before Turso can apply them', async () => {
    const repo = makeRepo('verified');
    const uploaded = await service.uploadResult('ws1', 'verified', repo);
    prisma.workspaceRepoArtifact.findUnique.mockResolvedValue({
      workspaceId: 'ws1',
      repoKey: 'repo-id',
      repoName: 'verified',
      kind: 'parsed',
      version: uploaded.version,
      r2Key: uploaded.r2Key,
      sha256: '0'.repeat(64),
      sizeBytes: BigInt(uploaded.sizeBytes),
    });

    await expect(service.downloadResultForGraph('ws1', 'repo-id', 'verified', uploaded.version)).rejects.toMatchObject({
      code: 'artifact_integrity_error',
    });
  });

  it('rejects replaced registered summary bytes before Turso metadata mutation', async () => {
    const uploaded = await service.uploadSummary('ws1', 'verified', makeSummary('verified'));
    prisma.workspaceRepoArtifact.findUnique.mockResolvedValue({
      workspaceId: 'ws1',
      repoKey: 'repo-id',
      repoName: 'verified',
      kind: 'summary',
      version: uploaded.version,
      r2Key: uploaded.r2Key,
      sha256: '0'.repeat(64),
      sizeBytes: BigInt(uploaded.sizeBytes),
    });

    await expect(service.downloadSummaryForGraph('ws1', 'repo-id', 'verified', uploaded.version)).rejects.toMatchObject(
      { code: 'artifact_integrity_error' },
    );
  });

  it('rejects replaced registered embedding bytes before Turso metadata mutation', async () => {
    const uploaded = await service.uploadEmbeddings('ws1', 'verified', makeEmbeddings('verified'));
    prisma.workspaceRepoArtifact.findUnique.mockResolvedValue({
      workspaceId: 'ws1',
      repoKey: 'repo-id',
      repoName: 'verified',
      kind: 'embeddings',
      version: uploaded.version,
      r2Key: uploaded.r2Key,
      sha256: '0'.repeat(64),
      sizeBytes: BigInt(uploaded.sizeBytes),
    });

    await expect(
      service.downloadEmbeddingsForGraph('ws1', 'repo-id', 'verified', uploaded.version),
    ).rejects.toMatchObject({ code: 'artifact_integrity_error' });
  });

  it('keeps legacy unregistered graph inputs readable but marks them unstampable', async () => {
    const repo = makeRepo('legacy');
    const uploaded = await service.uploadResult('ws1', 'legacy', repo);

    await expect(service.downloadResultForGraph('ws1', 'repo-id', 'legacy', uploaded.version)).resolves.toMatchObject({
      value: { name: 'legacy' },
      registered: false,
    });
  });

  it('returns null for non-existent version', async () => {
    const result = await service.downloadResult('ws1', 'repo', 'deadbeef12345678');
    expect(result).toBeNull();
  });

  it('returns empty manifest when none exists', async () => {
    const manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentParsed).toBeNull();
    expect(manifest.history).toHaveLength(0);
  });

  it('updates manifest and rotates history', async () => {
    await service.updateManifest('ws1', 'repo', 'v1', 'sha1');
    let manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentParsed).toBe('v1');
    expect(manifest.history).toHaveLength(0);

    await service.updateManifest('ws1', 'repo', 'v2', 'sha2');
    manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentParsed).toBe('v2');
    expect(manifest.history).toHaveLength(1);
    expect(manifest.history[0].parsed).toBe('v1');
  });

  it('prunes old versions beyond retainCount', async () => {
    // Push 7 versions with retainCount=3
    for (let i = 1; i <= 7; i++) {
      await service.updateManifest('ws1', 'repo', `v${i}`, `sha${i}`, 3);
    }

    const manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentParsed).toBe('v7');
    expect(manifest.history).toHaveLength(3);
    expect(manifest.history[0].parsed).toBe('v6');
    expect(manifest.history[2].parsed).toBe('v4');
  });

  it('prunes manifest history but never deletes parsed blobs once artifact retention is enabled', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ retainGraphArtifacts: true });

    for (let i = 1; i <= 4; i++) {
      await service.updateManifest('ws1', 'repo', `v${i}`, `sha${i}`, 1);
    }

    const manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentParsed).toBe('v4');
    expect(manifest.history.map((entry) => entry.parsed)).toEqual(['v3']);
    expect(r2.delete).not.toHaveBeenCalled();
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws1' },
      select: { retainGraphArtifacts: true },
    });
  });

  it('keeps deleting pruned parsed blobs for a never-piloted Turso workspace', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ retainGraphArtifacts: false });

    for (let i = 1; i <= 4; i++) {
      await service.updateManifest('ws1', 'repo', `v${i}`, `sha${i}`, 1);
    }

    expect(r2.delete).toHaveBeenCalledTimes(2);
    expect(r2.delete).toHaveBeenNthCalledWith(1, 'ws1/repo/results/parsed/v1.json');
    expect(r2.delete).toHaveBeenNthCalledWith(2, 'ws1/repo/results/parsed/v2.json');
  });

  it('retains pruned parsed blobs when the retention policy cannot be read safely', async () => {
    prisma.workspace.findUnique.mockRejectedValue(new Error('control plane unavailable'));

    for (let i = 1; i <= 3; i++) {
      await service.updateManifest('ws1', 'repo', `v${i}`, `sha${i}`, 1);
    }

    expect(r2.delete).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Summary storage tests
  // =========================================================================

  it('uploads summary and returns version with sum_ prefix', async () => {
    const summary = makeSummary();
    const result = await service.uploadSummary('ws1', 'myrepo', summary);

    expect(result.version).toMatch(/^sum_/);
    expect(result.version).toHaveLength(20); // "sum_" (4) + 16 hex chars
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.r2Key).toBe(`ws1/myrepo/results/summaries/${result.version}.json`);
    expect(result.duplicate).toBe(false);
  });

  it('detects duplicate summary upload', async () => {
    const summary = makeSummary();
    const r1 = await service.uploadSummary('ws1', 'myrepo', summary);
    const r2Result = await service.uploadSummary('ws1', 'myrepo', summary);

    expect(r2Result.version).toBe(r1.version);
    expect(r2Result.duplicate).toBe(true);
  });

  it('updates manifest currentSummary on upload', async () => {
    const summary = makeSummary();
    const uploaded = await service.uploadSummary('ws1', 'myrepo', summary);

    const manifest = await service.getManifest('ws1', 'myrepo');
    expect(manifest.currentSummary).toBe(uploaded.version);
  });

  it('downloads latest summary', async () => {
    const summary = makeSummary('test-repo');
    await service.uploadSummary('ws1', 'myrepo', summary);

    const result = await service.downloadLatestSummary('ws1', 'myrepo');
    expect(result).not.toBeNull();
    expect(result!.summaryOutput.repoName).toBe('test-repo');
    expect(result!.version).toMatch(/^sum_/);
  });

  it('returns null when no summary exists', async () => {
    const result = await service.downloadLatestSummary('ws1', 'myrepo');
    expect(result).toBeNull();
  });

  it('downloads specific summary version', async () => {
    const summary = makeSummary('specific');
    const uploaded = await service.uploadSummary('ws1', 'myrepo', summary);

    const result = await service.downloadSummary('ws1', 'myrepo', uploaded.version);
    expect(result).not.toBeNull();
    expect(result!.repoName).toBe('specific');
  });

  it('returns null for non-existent summary version', async () => {
    const result = await service.downloadSummary('ws1', 'myrepo', 'sum_deadbeef12345678');
    expect(result).toBeNull();
  });

  it('manifest includes currentSummary field even for legacy manifests', async () => {
    // Simulate a legacy manifest without currentSummary
    await service.updateManifest('ws1', 'repo', 'v1', 'sha1');
    const manifest = await service.getManifest('ws1', 'repo');
    expect(manifest.currentSummary).toBeDefined();
  });

  // =========================================================================
  // workspaceId validation tests
  // =========================================================================

  it('rejects workspaceId with path traversal characters', async () => {
    const repo = makeRepo();
    await expect(service.uploadResult('../evil', 'myrepo', repo)).rejects.toThrow(BadRequestException);
    await expect(service.downloadResult('../evil', 'myrepo', 'deadbeef12345678')).rejects.toThrow(BadRequestException);
    await expect(service.getManifest('../evil', 'myrepo')).rejects.toThrow(BadRequestException);
    await expect(service.updateManifest('../evil', 'myrepo', 'v1', null)).rejects.toThrow(BadRequestException);
    await expect(service.uploadSummary('../evil', 'myrepo', makeSummary())).rejects.toThrow(BadRequestException);
    await expect(service.downloadLatestSummary('../evil', 'myrepo')).rejects.toThrow(BadRequestException);
    await expect(service.getLatestSummaryUrl('../evil', 'myrepo')).rejects.toThrow(BadRequestException);
    await expect(service.downloadSummary('../evil', 'myrepo', 'sum_deadbeef12345678')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects workspaceId with slashes', async () => {
    await expect(service.uploadResult('ws/nested', 'myrepo', makeRepo())).rejects.toThrow(BadRequestException);
  });

  it('rejects workspaceId with spaces', async () => {
    await expect(service.uploadResult('ws id', 'myrepo', makeRepo())).rejects.toThrow(BadRequestException);
  });

  it('accepts valid workspaceId formats', async () => {
    // CUID-style
    const result1 = await service.uploadResult('clh1abc2d0000xyz', 'myrepo', makeRepo());
    expect(result1.duplicate).toBe(false);

    // UUID-style (without dashes uses alphanumeric)
    const result2 = await service.uploadResult('ws_abc-123', 'myrepo', makeRepo());
    expect(result2.duplicate).toBe(false);
  });

  // =========================================================================
  // Dedup verifies bytes because a 16-hex route version is not a full identity.
  // =========================================================================

  it('verifies a conditional-write dedup hit via HEAD metadata, without re-downloading the artifact', async () => {
    const repo = makeRepo();
    await service.uploadResult('ws1', 'myrepo', repo);

    // Reset call counts after first upload
    r2.putBufferIfAbsent.mockClear();
    r2.download.mockClear();
    r2.headObject.mockClear();

    await service.uploadResult('ws1', 'myrepo', repo);

    expect(r2.putBufferIfAbsent).toHaveBeenCalledTimes(1);
    // The sha256/sizebytes metadata stamped at write time carries the
    // verification; a CI re-push of an unchanged artifact must not pay a GET.
    expect(r2.headObject).toHaveBeenCalledTimes(1);
    expect(r2.download).not.toHaveBeenCalled();
  });

  it('falls back to a byte-compare for a legacy object without metadata', async () => {
    const repo = makeRepo();
    const first = await service.uploadResult('ws1', 'myrepo', repo);

    // Legacy object: exists, but HEAD reports no sha256 metadata.
    r2.headObject.mockImplementationOnce(async () => ({
      contentLength: 1,
      contentType: null,
      etag: null,
      lastModified: null,
      metadata: {},
    }));
    r2.download.mockClear();

    const second = await service.uploadResult('ws1', 'myrepo', repo);
    expect(second.duplicate).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(r2.download).toHaveBeenCalled();
  });
});
