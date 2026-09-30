import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { MapperController } from './mapper.controller.js';
import type { MapperService } from './mapper.service.js';
import type { ResolverService } from './resolver.service.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import type { ControlPlaneService } from '../../database/control-plane.service.js';
import type { PushQueueService } from '../job-queue/push-queue.service.js';

const VALID_MAPPER = {
  $schemaVersion: 1,
  project: 'demo',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
};

const USER: AuthUser = { id: 'user-1', email: 'user@example.com' };

describe('MapperController', () => {
  let mapperService: {
    uploadMapper: ReturnType<typeof vi.fn>;
    getMetadata: ReturnType<typeof vi.fn>;
    getRawContent: ReturnType<typeof vi.fn>;
  };
  let resolverService: { resolveWorkspace: ReturnType<typeof vi.fn> };
  let controlPlane: { getWorkspaceById: ReturnType<typeof vi.fn> };
  let pushQueue: { enqueueResolve: ReturnType<typeof vi.fn>; waitForTerminal: ReturnType<typeof vi.fn> };
  let controller: MapperController;

  beforeEach(() => {
    mapperService = {
      uploadMapper: vi.fn().mockResolvedValue({
        sha256: 'sha1',
        r2Key: 'ws1/mapper.json',
        sizeBytes: 50,
        duplicate: false,
        artifactId: 'id1',
      }),
      getMetadata: vi.fn().mockResolvedValue({
        id: 'id1',
        workspaceId: 'ws1',
        sha256: 'sha1',
        r2Key: 'ws1/mapper.json',
        sizeBytes: 50,
        uploadedBy: 'user-1',
        uploadedAt: new Date('2026-05-22T00:00:00Z'),
        metadata: { servicesCount: 0, sdkMappingsCount: 0 },
      }),
      getRawContent: vi.fn().mockResolvedValue({
        content: JSON.stringify(VALID_MAPPER),
        sha256: 'sha1',
      }),
    };
    resolverService = {
      resolveWorkspace: vi.fn().mockResolvedValue({
        resolved: 5,
        total: 10,
        rate: 0.5,
        legacyEdges: 2,
        mapperSha: 'sha1',
      }),
    };
    controlPlane = {
      getWorkspaceById: vi.fn().mockResolvedValue({ id: 'ws1', graphBackend: 'turso' }),
    };
    pushQueue = {
      enqueueResolve: vi.fn().mockResolvedValue({ id: 'job-1' }),
      waitForTerminal: vi.fn().mockResolvedValue({
        id: 'job-1',
        status: 'succeeded',
        result: {
          versionId: 'a'.repeat(64),
          resolution: { resolved: 7, total: 11, rate: 7 / 11, legacyEdges: 3, mapperSha: 'sha1' },
        },
      }),
    };
    controller = new MapperController(
      mapperService as unknown as MapperService,
      resolverService as unknown as ResolverService,
      controlPlane as unknown as ControlPlaneService,
      pushQueue as unknown as PushQueueService,
    );
  });

  describe('PUT mapper', () => {
    it('rejects body > 3 MB', async () => {
      const huge = { junk: 'x'.repeat(3 * 1024 * 1024 + 10) };
      await expect(controller.putMapper('ws1', huge, USER)).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(mapperService.uploadMapper).not.toHaveBeenCalled();
    });

    it('rejects body that fails MapperSchema validation', async () => {
      await expect(controller.putMapper('ws1', { not: 'a mapper' }, USER)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(mapperService.uploadMapper).not.toHaveBeenCalled();
    });

    it('uploads valid mapper, runs resolver, returns combined response', async () => {
      const response = await controller.putMapper('ws1', VALID_MAPPER, USER);
      expect(mapperService.uploadMapper).toHaveBeenCalledWith('ws1', JSON.stringify(VALID_MAPPER), 'user-1');
      expect(resolverService.resolveWorkspace).toHaveBeenCalledWith('ws1');
      expect(response.sha256).toBe('sha1');
      expect(response.duplicate).toBe(false);
      expect(response.resolution.resolved).toBe(5);
    });

    it('still runs resolver on duplicate upload (graph may have drifted)', async () => {
      mapperService.uploadMapper.mockResolvedValue({
        sha256: 'sha1',
        r2Key: 'ws1/mapper.json',
        sizeBytes: 50,
        duplicate: true,
        artifactId: 'id1',
      });
      const response = await controller.putMapper('ws1', VALID_MAPPER, USER);
      expect(response.duplicate).toBe(true);
      expect(resolverService.resolveWorkspace).toHaveBeenCalled();
    });

    it.each(['file_snapshot', undefined])('enqueues a file-snapshot resolve for backend %s', async (graphBackend) => {
      controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws1', graphBackend });

      const response = await controller.putMapper('ws1', VALID_MAPPER, USER);

      expect(pushQueue.enqueueResolve).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        userId: 'user-1',
      });
      expect(pushQueue.waitForTerminal).toHaveBeenCalledWith('ws1', 'job-1');
      expect(resolverService.resolveWorkspace).not.toHaveBeenCalled();
      expect(response).toEqual({
        jobId: 'job-1',
        sha256: 'sha1',
        r2Key: 'ws1/mapper.json',
        sizeBytes: 50,
        duplicate: false,
        resolution: { resolved: 7, total: 11, rate: 7 / 11, legacyEdges: 3, mapperSha: 'sha1' },
      });
    });

    it('accepts an idempotent no-op resolve (resolution: null) as success, not a 500', async () => {
      controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws1', graphBackend: 'file_snapshot' });
      // Duplicate mapper on an unchanged composition: the fast path publishes
      // idempotently with no fresh metrics. This must be a 200, not a 500.
      pushQueue.waitForTerminal.mockResolvedValueOnce({
        result: { versionId: 'v1', idempotent: true, resolution: null },
      });

      const response = await controller.putMapper('ws1', VALID_MAPPER, USER);
      expect(response.resolution).toBeNull();
      expect(response.jobId).toBe('job-1');
    });

    it('still 500s when a non-idempotent resolve returns no metrics', async () => {
      controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws1', graphBackend: 'file_snapshot' });
      pushQueue.waitForTerminal.mockResolvedValueOnce({
        result: { versionId: 'v1', idempotent: false, resolution: null },
      });

      await expect(controller.putMapper('ws1', VALID_MAPPER, USER)).rejects.toThrow(/no resolution metrics/);
    });

    it('does not fall back to the live resolver when a file-snapshot resolve job fails', async () => {
      controlPlane.getWorkspaceById.mockResolvedValueOnce({ id: 'ws1', graphBackend: 'file_snapshot' });
      pushQueue.waitForTerminal.mockRejectedValueOnce(new Error('stored terminal failure'));

      await expect(controller.putMapper('ws1', VALID_MAPPER, USER)).rejects.toThrow('stored terminal failure');
      expect(resolverService.resolveWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('GET mapper content', () => {
    it('streams the R2 content with ETag header', async () => {
      const setHeader = vi.fn();
      const send = vi.fn();
      const res = { setHeader, send } as never;
      await controller.getMapper('ws1', res);
      expect(setHeader).toHaveBeenCalledWith('ETag', 'sha1');
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(send).toHaveBeenCalledWith(JSON.stringify(VALID_MAPPER));
    });

    it('404 when no artifact', async () => {
      mapperService.getRawContent.mockResolvedValue(null);
      await expect(controller.getMapper('ws1', { setHeader: vi.fn(), send: vi.fn() } as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('GET metadata', () => {
    it('returns artifact pointer fields', async () => {
      const meta = await controller.getMetadata('ws1');
      expect(meta.sha256).toBe('sha1');
      expect(meta.workspaceId).toBe('ws1');
    });

    it('404 when no artifact', async () => {
      mapperService.getMetadata.mockResolvedValue(null);
      await expect(controller.getMetadata('ws1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
