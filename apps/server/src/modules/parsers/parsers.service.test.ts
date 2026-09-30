import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ParsersService } from './parsers.service.js';

// Mock R2 storage
function createMockR2() {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

// Mock Prisma
function createMockPrisma() {
  return {
    parserArtifact: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('ParsersService', () => {
  let service: ParsersService;
  let r2: ReturnType<typeof createMockR2>;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    r2 = createMockR2();
    prisma = createMockPrisma();
    service = new ParsersService(prisma as any, r2 as any);
  });

  describe('uploadParser', () => {
    it('uploads to R2 and upserts metadata in Prisma', async () => {
      const data = Buffer.from('test parser content');
      prisma.parserArtifact.upsert.mockResolvedValue({});

      const result = await service.uploadParser('ws_1', 'backend', data, 'user_1');

      expect(r2.upload).toHaveBeenCalledWith('ws_1/backend/parser.tar.gz', data, 'application/gzip');
      expect(prisma.parserArtifact.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_repoName: { workspaceId: 'ws_1', repoName: 'backend' } },
          create: expect.objectContaining({
            workspaceId: 'ws_1',
            repoName: 'backend',
            uploadedBy: 'user_1',
          }),
        }),
      );
      expect(result.uploaded).toBe(true);
      expect(result.version).toBeTruthy();
    });

    it('computes SHA-256 hash for version', async () => {
      const data = Buffer.from('content A');
      prisma.parserArtifact.upsert.mockResolvedValue({});
      const resultA = await service.uploadParser('ws_1', 'repo', data, 'user_1');

      const data2 = Buffer.from('content B');
      const resultB = await service.uploadParser('ws_1', 'repo', data2, 'user_1');

      // Different content should produce different versions
      expect(resultA.version).not.toBe(resultB.version);
    });
  });

  describe('downloadParser', () => {
    it('returns buffer from R2 when artifact exists', async () => {
      const buffer = Buffer.from('parser tar gz');
      prisma.parserArtifact.findUnique.mockResolvedValue({
        r2Key: 'ws_1/backend/parser.tar.gz',
      });
      r2.download.mockResolvedValue(buffer);

      const result = await service.downloadParser('ws_1', 'backend');
      expect(result).toBe(buffer);
      expect(r2.download).toHaveBeenCalledWith('ws_1/backend/parser.tar.gz');
    });

    it('throws NotFoundException when no artifact in database', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue(null);

      await expect(service.downloadParser('ws_1', 'backend')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when R2 file is missing', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue({
        r2Key: 'ws_1/backend/parser.tar.gz',
      });
      r2.download.mockResolvedValue(null);

      await expect(service.downloadParser('ws_1', 'backend')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getParserMeta', () => {
    it('returns metadata when artifact exists', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue({
        repoName: 'backend',
        sha256: 'abcdef1234567890abcdef1234567890',
        sizeBytes: 5000,
        uploadedBy: 'user_1',
        uploadedAt: new Date('2026-03-25T10:00:00Z'),
      });

      const meta = await service.getParserMeta('ws_1', 'backend');
      expect(meta).toEqual({
        repoName: 'backend',
        version: 'abcdef1234567890',
        sizeBytes: 5000,
        uploadedBy: 'user_1',
        uploadedAt: '2026-03-25T10:00:00.000Z',
      });
    });

    it('returns null when no artifact exists', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue(null);
      const meta = await service.getParserMeta('ws_1', 'backend');
      expect(meta).toBeNull();
    });
  });

  describe('listParsers', () => {
    it('returns list of parsers for workspace', async () => {
      prisma.parserArtifact.findMany.mockResolvedValue([
        {
          repoName: 'backend',
          sha256: 'abc123',
          sizeBytes: 3000,
          uploadedBy: 'user_1',
          uploadedAt: new Date('2026-03-25T10:00:00Z'),
          metadata: null,
        },
        {
          repoName: 'frontend',
          sha256: 'def456',
          sizeBytes: 5000,
          uploadedBy: 'user_2',
          uploadedAt: new Date('2026-03-25T11:00:00Z'),
          metadata: null,
        },
      ]);

      const list = await service.listParsers('ws_1');
      expect(list).toHaveLength(2);
      expect(list[0].repoName).toBe('backend');
      expect(list[1].repoName).toBe('frontend');
    });

    it('returns empty array when no parsers exist', async () => {
      prisma.parserArtifact.findMany.mockResolvedValue([]);
      const list = await service.listParsers('ws_1');
      expect(list).toEqual([]);
    });
  });

  describe('deleteParser', () => {
    it('deletes from R2 and Prisma when artifact exists', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue({
        id: 'art_1',
        r2Key: 'ws_1/backend/parser.tar.gz',
      });
      prisma.parserArtifact.delete.mockResolvedValue({});

      await service.deleteParser('ws_1', 'backend');

      expect(r2.delete).toHaveBeenCalledWith('ws_1/backend/parser.tar.gz');
      expect(prisma.parserArtifact.delete).toHaveBeenCalledWith({ where: { id: 'art_1' } });
    });

    it('does nothing when artifact does not exist', async () => {
      prisma.parserArtifact.findUnique.mockResolvedValue(null);

      await service.deleteParser('ws_1', 'backend');

      expect(r2.delete).not.toHaveBeenCalled();
      expect(prisma.parserArtifact.delete).not.toHaveBeenCalled();
    });
  });
});
