import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { JobsController } from './jobs.controller.js';
import type { PushQueueService } from '../job-queue/push-queue.service.js';

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job_1',
    workspaceId: 'ws_1',
    repoName: 'gateway',
    type: 'push',
    payload: { legacy: { parsedRepo: { id: 'r1', huge: 'x'.repeat(1000) } } },
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    queuedAt: new Date('2026-05-23T00:00:00Z'),
    nextRunAt: new Date('2026-05-23T00:00:00Z'),
    startedAt: new Date('2026-05-23T00:00:01Z'),
    finishedAt: new Date('2026-05-23T00:00:05Z'),
    result: { repoName: 'gateway', mode: 'incremental' },
    queuedByUserId: 'user_42',
    leaseToken: 'do-not-leak',
    heartbeatAt: new Date('2026-05-23T00:00:03Z'),
    phase: 'writing_nodes',
    progress: { phase: 'writing_nodes', completed: 50, total: 100, unit: 'nodes', updatedAt: 'now' },
    ...overrides,
  };
}

describe('JobsController', () => {
  it('GET /jobs/:jobId returns the documented shape (strips payload + queuedByUserId)', async () => {
    const queue = {
      getJob: vi.fn(async () =>
        makeJobRow({
          attemptHistory: [
            {
              id: 'attempt_1',
              jobId: 'job_1',
              attemptNumber: 1,
              leaseToken: 'nested-secret-token',
              status: 'succeeded',
              phase: 'completed',
              progress: null,
              startedAt: new Date('2026-05-23T00:00:01Z'),
              heartbeatAt: new Date('2026-05-23T00:00:04Z'),
              finishedAt: new Date('2026-05-23T00:00:05Z'),
              lastError: null,
              phaseTimings: { writing_nodes: 1000 },
            },
          ],
        }),
      ),
      listJobs: vi.fn(),
    } as unknown as PushQueueService;
    const controller = new JobsController(queue);
    const result = (await controller.getJob('ws_1', 'job_1')) as Record<string, unknown>;
    expect(result.id).toBe('job_1');
    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({ repoName: 'gateway' });
    // Security: payload (full ParsedRepo for legacy path) MUST NOT leak.
    expect(result).not.toHaveProperty('payload');
    expect(result).not.toHaveProperty('queuedByUserId');
    expect(result).not.toHaveProperty('nextRunAt');
    expect(result).not.toHaveProperty('leaseToken');
    expect(result).toMatchObject({ phase: 'writing_nodes', heartbeatAt: expect.any(Date) });
    expect(JSON.stringify(result)).not.toContain('nested-secret-token');
  });

  it('GET /jobs/:jobId throws NotFoundException when missing', async () => {
    const queue = {
      getJob: vi.fn(async () => null),
      listJobs: vi.fn(),
    } as unknown as PushQueueService;
    const controller = new JobsController(queue);
    await expect(controller.getJob('ws_1', 'job_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /jobs supports status filter and limit; each row is projected', async () => {
    const queue = {
      getJob: vi.fn(),
      listJobs: vi.fn(async () => [makeJobRow({ id: 'job_a' }), makeJobRow({ id: 'job_b' })]),
    } as unknown as PushQueueService;
    const controller = new JobsController(queue);
    const rows = (await controller.listJobs('ws_1', { status: 'pending', limit: 5 })) as Array<Record<string, unknown>>;
    expect(queue.listJobs).toHaveBeenCalledWith('ws_1', 'pending', 5);
    for (const row of rows) {
      expect(row).not.toHaveProperty('payload');
      expect(row).not.toHaveProperty('queuedByUserId');
    }
  });
});
