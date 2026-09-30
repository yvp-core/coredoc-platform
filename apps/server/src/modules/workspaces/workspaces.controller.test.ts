import { describe, it, expect, vi } from 'vitest';
import { WorkspacesController } from './workspaces.controller.js';
import type { WorkspacesService } from './workspaces.service.js';
import type { ResolverService } from '../mapper/resolver.service.js';
import type { PushQueueService } from '../job-queue/push-queue.service.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';

function makeRes() {
  const status = vi.fn();
  const res = { status } as unknown as import('express').Response;
  status.mockReturnValue(res);
  return { res, status };
}

describe('WorkspacesController.resolveWorkspace', () => {
  it('default (no ?sync) enqueues, returns { jobId, status: "queued" }, sets 202', async () => {
    const resolverService = { resolveWorkspace: vi.fn() } as unknown as ResolverService;
    const pushQueue = { enqueueResolve: vi.fn(async () => ({ id: 'job_r' })) } as unknown as PushQueueService;
    // Async branch now reads the backend up front (the Turso-targets guard).
    const workspacesService = {
      getWorkspace: vi.fn(async () => ({ id: 'ws_42', graphBackend: 'file_snapshot' })),
    } as unknown as WorkspacesService;
    const controller = new WorkspacesController(workspacesService, resolverService, pushQueue);
    const { res, status } = makeRes();
    const result = await controller.resolveWorkspace('ws_42', { id: 'user_1' } as AuthUser, res, undefined);
    expect(result).toEqual({ jobId: 'job_r', status: 'queued' });
    expect(status).toHaveBeenCalledWith(202);
    expect(pushQueue.enqueueResolve).toHaveBeenCalledWith({ workspaceId: 'ws_42', userId: 'user_1', targets: [] });
    expect(resolverService.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('?sync=true runs inline via ResolverService and does NOT set 202', async () => {
    const metrics = { resolved: 12, total: 20, rate: 0.6, legacyEdges: 3, mapperSha: 'sha_abc' };
    const resolverService = {
      resolveWorkspace: vi.fn().mockResolvedValue(metrics),
    } as unknown as ResolverService;
    const pushQueue = { enqueueResolve: vi.fn() } as unknown as PushQueueService;
    const workspacesService = {
      getWorkspace: vi.fn().mockResolvedValue({ id: 'ws_42', graphBackend: 'turso' }),
    } as unknown as WorkspacesService;
    const controller = new WorkspacesController(workspacesService, resolverService, pushQueue);
    const { res, status } = makeRes();
    const result = await controller.resolveWorkspace('ws_42', { id: 'user_1' } as AuthUser, res, 'true');
    expect(result).toBe(metrics);
    expect(status).not.toHaveBeenCalled();
    expect(resolverService.resolveWorkspace).toHaveBeenCalledWith('ws_42');
    expect(pushQueue.enqueueResolve).not.toHaveBeenCalled();
  });

  it('file_snapshot ?sync=true enqueues, waits for the durable terminal row, and never calls live resolution', async () => {
    const workspacesService = {
      getWorkspace: vi.fn().mockResolvedValue({ id: 'ws_42', graphBackend: 'file_snapshot' }),
    } as unknown as WorkspacesService;
    const resolverService = { resolveWorkspace: vi.fn() } as unknown as ResolverService;
    const pushQueue = {
      enqueueResolve: vi.fn(async () => ({ id: 'job_r' })),
      waitForTerminal: vi.fn(async () => ({
        id: 'job_r',
        status: 'succeeded',
        result: {
          versionId: 'a'.repeat(64),
          resolved: 12,
          artifact: { r2Key: 'ws_42/graphs/private.ladybug', sha256: 'b'.repeat(64) },
        },
      })),
    } as unknown as PushQueueService;
    const controller = new WorkspacesController(workspacesService, resolverService, pushQueue);
    const { res, status } = makeRes();

    const result = await controller.resolveWorkspace('ws_42', { id: 'user_1' } as AuthUser, res, 'true');

    expect(result).toEqual({
      versionId: 'a'.repeat(64),
      resolved: 12,
      artifact: { sha256: 'b'.repeat(64) },
    });
    expect(pushQueue.enqueueResolve).toHaveBeenCalledWith({ workspaceId: 'ws_42', userId: 'user_1', targets: [] });
    expect(pushQueue.waitForTerminal).toHaveBeenCalledWith('ws_42', 'job_r');
    expect(resolverService.resolveWorkspace).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
