import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MapperService, EMPTY_MAPPER } from './mapper.service.js';
import type { MapperStorageService } from './mapper-storage.service.js';
import type { PrismaService } from '../../database/prisma.service.js';

const VALID_MAPPER_CONTENT = JSON.stringify({
  $schemaVersion: 1,
  project: 'demo',
  services: [{ name: 'users-svc', repo: 'users-svc', aliases: ['usersApi'] }],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
});

function mapperArtifact(content: string, overrides: Record<string, unknown> = {}) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    sha256,
    r2Key: `ws1/mapper/${sha256}.json`,
    sizeBytes: BigInt(Buffer.byteLength(content)),
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    mapperArtifact: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ retainGraphArtifacts: false }),
    },
  } as unknown as PrismaService & {
    mapperArtifact: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    workspace: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
}

function createStorageMock() {
  return {
    uploadJson: vi.fn(),
    downloadJson: vi.fn(),
    deleteObject: vi.fn(),
    objectExists: vi.fn().mockResolvedValue(true),
    buildKey: vi.fn(),
  } as unknown as MapperStorageService & {
    uploadJson: ReturnType<typeof vi.fn>;
    downloadJson: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
    objectExists: ReturnType<typeof vi.fn>;
    buildKey: ReturnType<typeof vi.fn>;
  };
}

describe('MapperService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let storage: ReturnType<typeof createStorageMock>;
  let svc: MapperService;

  beforeEach(() => {
    prisma = createPrismaMock();
    storage = createStorageMock();
    svc = new MapperService(prisma as unknown as PrismaService, storage as unknown as MapperStorageService);
  });

  describe('uploadMapper', () => {
    it('uploads to R2 and upserts MapperArtifact for new content', async () => {
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.findUnique.mockResolvedValue(null);
      prisma.mapperArtifact.upsert.mockResolvedValue({
        id: 'id1',
        sha256: 'sha-new',
        r2Key: 'ws1/mapper.json',
        sizeBytes: 50,
      });

      const result = await svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1');
      expect(result.duplicate).toBe(false);
      expect(result.sha256).toBe('sha-new');
      expect(storage.uploadJson).toHaveBeenCalledWith('ws1', VALID_MAPPER_CONTENT);
      expect(prisma.mapperArtifact.upsert).toHaveBeenCalled();
    });

    it('returns duplicate=true and skips re-upload when sha matches AND R2 blob exists', async () => {
      const expectedSha = createHash('sha256').update(VALID_MAPPER_CONTENT).digest('hex');
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id1',
        sha256: expectedSha,
        r2Key: `ws1/mapper/${expectedSha}.json`,
        sizeBytes: 50,
      });
      storage.objectExists.mockResolvedValue(true);

      const result = await svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1');
      expect(result.duplicate).toBe(true);
      expect(storage.uploadJson).not.toHaveBeenCalled();
      expect(prisma.mapperArtifact.upsert).not.toHaveBeenCalled();
    });

    it('re-uploads when sha matches but R2 blob is missing (repair path)', async () => {
      const expectedSha = createHash('sha256').update(VALID_MAPPER_CONTENT).digest('hex');
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id1',
        sha256: expectedSha,
        r2Key: `ws1/mapper/${expectedSha}.json`,
        sizeBytes: 50,
      });
      storage.objectExists.mockResolvedValue(false);
      storage.uploadJson.mockResolvedValue({
        r2Key: `ws1/mapper/${expectedSha}.json`,
        sha256: expectedSha,
        sizeBytes: Buffer.byteLength(VALID_MAPPER_CONTENT),
      });
      prisma.mapperArtifact.upsert.mockResolvedValue({
        id: 'id1',
        sha256: expectedSha,
        r2Key: `ws1/mapper/${expectedSha}.json`,
        sizeBytes: 50,
      });

      const result = await svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1');
      expect(result.duplicate).toBe(false);
      expect(storage.uploadJson).toHaveBeenCalled();
      expect(prisma.mapperArtifact.upsert).toHaveBeenCalled();
    });

    it('rolls back R2 upload when Postgres upsert fails', async () => {
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-x.json', sha256: 'sha-x', sizeBytes: 50 });
      prisma.mapperArtifact.findUnique.mockResolvedValue(null);
      prisma.mapperArtifact.upsert.mockRejectedValue(new Error('db down'));

      await expect(svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1')).rejects.toThrow();
      expect(storage.deleteObject).toHaveBeenCalledWith('ws1/mapper/sha-x.json');
    });

    it('garbage-collects the previous blob after a successful replace', async () => {
      // Existing mapper at the old content-addressed key.
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-old',
        r2Key: 'ws1/mapper/sha-old.json',
        sizeBytes: 40,
      });
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-new.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.upsert.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-new',
        r2Key: 'ws1/mapper/sha-new.json',
        sizeBytes: 50,
      });

      const result = await svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1');
      expect(result.duplicate).toBe(false);
      // GC of the previous blob — not the new one.
      expect(storage.deleteObject).toHaveBeenCalledWith('ws1/mapper/sha-old.json');
      expect(storage.deleteObject).not.toHaveBeenCalledWith('ws1/mapper/sha-new.json');
    });

    it('does NOT delete the existing blob when the Postgres upsert fails on a replace', async () => {
      // This is the failure mode codex P1.1 flagged: previously, rollback would
      // delete the same key the existing row pointed at, destroying the only copy.
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-old',
        r2Key: 'ws1/mapper/sha-old.json',
        sizeBytes: 40,
      });
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-new.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.upsert.mockRejectedValue(new Error('db down'));

      await expect(svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1')).rejects.toThrow();
      // The NEW blob is rolled back...
      expect(storage.deleteObject).toHaveBeenCalledWith('ws1/mapper/sha-new.json');
      // ...but the existing blob is untouched.
      expect(storage.deleteObject).not.toHaveBeenCalledWith('ws1/mapper/sha-old.json');
    });

    it('leaves a newly uploaded mapper orphaned when retained artifact metadata upsert fails', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ retainGraphArtifacts: true });
      prisma.mapperArtifact.findUnique.mockResolvedValue(null);
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-new.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.upsert.mockRejectedValue(new Error('db down'));

      await expect(svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1')).rejects.toThrow(
        /persist mapper artifact metadata/i,
      );
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('keeps the previous mapper blob after a retained artifact replacement succeeds', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ retainGraphArtifacts: true });
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-old',
        r2Key: 'ws1/mapper/sha-old.json',
        sizeBytes: 40,
      });
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-new.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.upsert.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-new',
        r2Key: 'ws1/mapper/sha-new.json',
        sizeBytes: 50,
      });

      await expect(svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1')).resolves.toMatchObject({
        duplicate: false,
        r2Key: 'ws1/mapper/sha-new.json',
      });
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
        where: { id: 'ws1' },
        select: { retainGraphArtifacts: true },
      });
    });

    it('fails closed to retaining mapper blobs when the policy read is unavailable', async () => {
      prisma.workspace.findUnique.mockRejectedValue(new Error('control plane unavailable'));
      prisma.mapperArtifact.findUnique.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-old',
        r2Key: 'ws1/mapper/sha-old.json',
        sizeBytes: 40,
      });
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-new.json', sha256: 'sha-new', sizeBytes: 50 });
      prisma.mapperArtifact.upsert.mockResolvedValue({
        id: 'id-old',
        sha256: 'sha-new',
        r2Key: 'ws1/mapper/sha-new.json',
        sizeBytes: 50,
      });

      await svc.uploadMapper('ws1', VALID_MAPPER_CONTENT, 'user-1');

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('does not throw when content is not valid JSON; persists with metadata=null', async () => {
      // Defense-in-depth: the controller validates upstream, but uploadMapper
      // must not crash if called with non-JSON content. metadata extraction is
      // best-effort and silently falls back to null.
      prisma.mapperArtifact.findUnique.mockResolvedValue(null);
      storage.uploadJson.mockResolvedValue({ r2Key: 'ws1/mapper/sha-x.json', sha256: 'sha-x', sizeBytes: 9 });
      prisma.mapperArtifact.upsert.mockImplementation(async (args: { create: { metadata: unknown } }) => {
        expect(args.create.metadata).toBeNull();
        return { id: 'id-x', sha256: 'sha-x', r2Key: 'ws1/mapper/sha-x.json', sizeBytes: 9 };
      });

      await expect(svc.uploadMapper('ws1', '{not-json', 'user-1')).resolves.toMatchObject({ sha256: 'sha-x' });
    });
  });

  describe('loadOrDefault', () => {
    it('uses the supplied transaction client instead of the outer Prisma client', async () => {
      const transaction = {
        mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
      };

      const result = await svc.loadOrDefault('ws1', transaction as never);

      expect(result).toEqual({ mapper: EMPTY_MAPPER, sha256: null, descriptor: null });
      expect(transaction.mapperArtifact.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws1' } });
      expect(prisma.mapperArtifact.findUnique).not.toHaveBeenCalled();
    });

    it('returns the parsed mapper when artifact + R2 content present', async () => {
      const artifact = mapperArtifact(VALID_MAPPER_CONTENT);
      prisma.mapperArtifact.findUnique.mockResolvedValue(artifact);
      storage.buildKey.mockReturnValue(artifact.r2Key);
      storage.downloadJson.mockResolvedValue(VALID_MAPPER_CONTENT);
      const { mapper, sha256, descriptor } = await svc.loadOrDefault('ws1');
      expect(mapper.services).toHaveLength(1);
      expect(sha256).toBe(artifact.sha256);
      expect(descriptor).toEqual({
        r2Key: artifact.r2Key,
        sha256: artifact.sha256,
        sizeBytes: String(artifact.sizeBytes),
      });
    });

    it('returns EMPTY_MAPPER when no artifact exists', async () => {
      prisma.mapperArtifact.findUnique.mockResolvedValue(null);
      const { mapper, sha256, descriptor } = await svc.loadOrDefault('ws1');
      expect(mapper).toBe(EMPTY_MAPPER);
      expect(sha256).toBeNull();
      expect(descriptor).toBeNull();
    });

    it('throws when R2 content is missing for an existing artifact (invariant failure)', async () => {
      const artifact = mapperArtifact(VALID_MAPPER_CONTENT);
      prisma.mapperArtifact.findUnique.mockResolvedValue(artifact);
      storage.buildKey.mockReturnValue(artifact.r2Key);
      storage.downloadJson.mockResolvedValue(null);
      await expect(svc.loadOrDefault('ws1')).rejects.toThrow(/missing/);
    });

    it('throws when R2 content is not valid JSON', async () => {
      const content = '{not json';
      const artifact = mapperArtifact(content);
      prisma.mapperArtifact.findUnique.mockResolvedValue(artifact);
      storage.buildKey.mockReturnValue(artifact.r2Key);
      storage.downloadJson.mockResolvedValue(content);
      await expect(svc.loadOrDefault('ws1')).rejects.toThrow(/not valid JSON/);
    });

    it('throws when R2 content fails schema validation', async () => {
      const content = '{"$schemaVersion":1,"project":"x"}';
      const artifact = mapperArtifact(content);
      prisma.mapperArtifact.findUnique.mockResolvedValue(artifact);
      storage.buildKey.mockReturnValue(artifact.r2Key);
      storage.downloadJson.mockResolvedValue(content);
      await expect(svc.loadOrDefault('ws1')).rejects.toThrow(/schema validation/);
    });

    it('rejects replaced mapper bytes before they can be used or stamped', async () => {
      const artifact = mapperArtifact(VALID_MAPPER_CONTENT);
      prisma.mapperArtifact.findUnique.mockResolvedValue(artifact);
      storage.buildKey.mockReturnValue(artifact.r2Key);
      storage.downloadJson.mockResolvedValue(VALID_MAPPER_CONTENT.replace('users-svc', 'attacker'));

      const error = await svc.loadOrDefault('ws1').catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'artifact_integrity_error' });
      expect((error as Error).message).not.toContain(artifact.r2Key);
    });
  });
});
