import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PushQueueService } from './push-queue.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { JobFailedException, JobStillRunningException } from './job-errors.js';

const ORIGINAL_FILE_SNAPSHOT_SYNC_TIMEOUT_MS = process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS;

function makePrismaMock() {
  const pushJob = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'job_1',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      result: null,
      queuedAt: new Date(),
      nextRunAt: new Date(),
      startedAt: null,
      finishedAt: null,
      queuedByUserId: null,
      ...args.data,
    })),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
  };
  return { pushJob } as unknown as PrismaService;
}

describe('PushQueueService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: PushQueueService;

  beforeEach(() => {
    delete process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS;
    prisma = makePrismaMock();
    service = new PushQueueService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_FILE_SNAPSHOT_SYNC_TIMEOUT_MS === undefined) {
      delete process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS;
    } else {
      process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS = ORIGINAL_FILE_SNAPSHOT_SYNC_TIMEOUT_MS;
    }
  });

  it('enqueuePush creates a row with type=push and pending status', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const job = await service.enqueuePush({
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v1' },
      userId: 'user_1',
    });
    expect(job.id).toBe('job_1');
    expect((prisma.pushJob.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({
      workspaceId: 'ws_1',
      repoName: 'gateway',
      type: 'push',
      payload: expect.objectContaining({ parsedVersion: 'v1', executionToken: expect.any(String) }),
      queuedByUserId: 'user_1',
    });
  });

  it('enqueuePush returns an existing pending job for the same semantic payload', async () => {
    const existingJob = {
      id: 'job_existing',
      status: 'pending',
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v2', rebuild: false },
    };
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJob);
    const job = await service.enqueuePush({
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v2' },
      userId: 'user_1',
    });
    expect(job).toBe(existingJob);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('enqueuePush rejects a different version while another push is in flight', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_existing',
      status: 'running',
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v1' },
    });

    await expect(
      service.enqueuePush({
        workspaceId: 'ws_1',
        repoName: 'gateway',
        payload: { parsedVersion: 'v2' },
        userId: 'user_1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('returns the matching winner when concurrent enqueues race on the active-job constraint', async () => {
    const winner = {
      id: 'job_winner',
      status: 'pending',
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v2', executionToken: 'winner-token' },
    };
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    (prisma.pushJob.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('active push already exists', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.enqueuePush({
        workspaceId: 'ws_1',
        repoName: 'gateway',
        payload: { parsedVersion: 'v2' },
        userId: 'user_1',
      }),
    ).resolves.toBe(winner);
  });

  it('enqueuePush does not deduplicate an explicit rebuild into an ordinary push', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_existing',
      status: 'pending',
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v1' },
    });

    await expect(
      service.enqueuePush({
        workspaceId: 'ws_1',
        repoName: 'gateway',
        payload: { parsedVersion: 'v1', rebuild: true },
        userId: 'user_1',
      }),
    ).rejects.toThrow(/different push is already pending or running/);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('does not deduplicate an explicit metadata exclusion into a preserving push', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_existing',
      status: 'pending',
      workspaceId: 'ws_1',
      repoName: 'gateway',
      payload: { parsedVersion: 'v1' },
    });

    await expect(
      service.enqueuePush({
        workspaceId: 'ws_1',
        repoName: 'gateway',
        payload: { parsedVersion: 'v1', excludeSummaries: true },
        userId: 'user_1',
      }),
    ).rejects.toThrow(/different push is already pending or running/);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('enqueueResolve creates a row with type=resolve and null repoName', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await service.enqueueResolve({ workspaceId: 'ws_1', userId: 'user_1' });
    const created = (prisma.pushJob.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(created).toMatchObject({
      workspaceId: 'ws_1',
      type: 'resolve',
      repoName: null,
      queuedByUserId: 'user_1',
    });
    expect(created.payload).toEqual({ executionToken: expect.any(String) });
  });

  it('enqueueResolve carries a batch of targets into the job payload', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const targets = [
      { repoName: 'api', parsedVersion: 'a'.repeat(16) },
      { repoName: 'billing', parsedVersion: 'b'.repeat(16), commitSha: 'commit-b' },
    ];
    await service.enqueueResolve({ workspaceId: 'ws_1', userId: 'user_1', targets });
    const created = (prisma.pushJob.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(created.payload).toEqual({ executionToken: expect.any(String), targets });
  });

  it('enqueueResolve refuses to hand back a pending resolve that publishes a different batch', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_resolve_1',
      status: 'pending',
      workspaceId: 'ws_1',
      type: 'resolve',
      payload: { executionToken: 'stable-token', targets: [{ repoName: 'api', parsedVersion: 'a'.repeat(16) }] },
    });

    // Reusing it would silently drop 'billing' from what the caller asked to
    // publish, and the caller would be told its batch succeeded.
    await expect(
      service.enqueueResolve({
        workspaceId: 'ws_1',
        userId: 'user_1',
        targets: [{ repoName: 'billing', parsedVersion: 'b'.repeat(16) }],
      }),
    ).rejects.toThrow(/different resolve is already pending/);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('enqueueResolve distinguishes preserve (undefined) from exclude (null) metadata targets', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_resolve_1',
      status: 'pending',
      workspaceId: 'ws_1',
      type: 'resolve',
      // Pending batch says: PRESERVE the pinned summary (undefined).
      payload: { executionToken: 'stable-token', targets: [{ repoName: 'api', parsedVersion: 'a'.repeat(16) }] },
    });

    // New request says: EXCLUDE the summary (explicit null). Reusing the
    // preserve job would publish the wrong graph while reporting success.
    await expect(
      service.enqueueResolve({
        workspaceId: 'ws_1',
        userId: 'user_1',
        targets: [{ repoName: 'api', parsedVersion: 'a'.repeat(16), summaryVersion: null }],
      }),
    ).rejects.toThrow(/different resolve is already pending/);
  });

  it('enqueueResolve hands any pending resolve to a targetless request', async () => {
    const existingJob = {
      id: 'job_resolve_1',
      status: 'pending',
      workspaceId: 'ws_1',
      type: 'resolve',
      payload: { executionToken: 'stable-token', targets: [{ repoName: 'api', parsedVersion: 'a'.repeat(16) }] },
    };
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJob);

    // The mapper PUT path fires a targetless resolve after the mapper is
    // already persisted; a 409 here would fail a PUT whose data has landed.
    await expect(service.enqueueResolve({ workspaceId: 'ws_1', userId: 'user_1' })).resolves.toBe(existingJob);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('enqueueResolve reuses a pending resolve that publishes the same batch', async () => {
    const existingJob = {
      id: 'job_resolve_1',
      status: 'pending',
      workspaceId: 'ws_1',
      type: 'resolve',
      payload: {
        executionToken: 'stable-token',
        targets: [
          { repoName: 'billing', parsedVersion: 'b'.repeat(16) },
          { repoName: 'api', parsedVersion: 'a'.repeat(16) },
        ],
      },
    };
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJob);

    // Same batch, different order — a retry of the same request, not a new one.
    const job = await service.enqueueResolve({
      workspaceId: 'ws_1',
      userId: 'user_1',
      targets: [
        { repoName: 'api', parsedVersion: 'a'.repeat(16) },
        { repoName: 'billing', parsedVersion: 'b'.repeat(16) },
      ],
    });
    expect(job).toBe(existingJob);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });

  it('enqueueResolve returns existing pending resolve instead of creating duplicate', async () => {
    const existingJob = {
      id: 'job_resolve_1',
      status: 'pending',
      workspaceId: 'ws_1',
      type: 'resolve',
      payload: { executionToken: 'stable-token' },
    };
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingJob);
    const job = await service.enqueueResolve({ workspaceId: 'ws_1', userId: 'user_1' });
    expect(job).toBe(existingJob);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
    expect((prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where.status).toBe('pending');
  });

  it('getJob returns the row only when workspaceId matches', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'job_99', workspaceId: 'ws_1' });
    const job = await service.getJob('ws_1', 'job_99');
    expect(job?.id).toBe('job_99');
    expect((prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      where: { id: 'job_99', workspaceId: 'ws_1' },
      include: { attemptHistory: { orderBy: { attemptNumber: 'asc' } } },
    });

    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const missing = await service.getJob('ws_1', 'job_other');
    expect(missing).toBeNull();
  });

  it('listJobs filters by status when provided', async () => {
    await service.listJobs('ws_1', 'pending', 10);
    expect((prisma.pushJob.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      where: { workspaceId: 'ws_1', status: 'pending' },
      take: 10,
      orderBy: { queuedAt: 'desc' },
    });
  });

  it('listJobs caps limit at 200', async () => {
    await service.listJobs('ws_1', undefined, 500);
    expect((prisma.pushJob.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].take).toBe(200);
  });

  it('waitForTerminal returns only a terminal success from the scoped job row', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'job_1', workspaceId: 'ws_1', status: 'running', result: null })
      .mockResolvedValueOnce({ id: 'job_1', workspaceId: 'ws_1', status: 'succeeded', result: { versionId: 'v1' } });

    const terminal = await service.waitForTerminal('ws_1', 'job_1', { timeoutMs: 100, pollIntervalMs: 0 });

    expect(terminal.result).toEqual({ versionId: 'v1' });
    for (const call of (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].where).toEqual({ id: 'job_1', workspaceId: 'ws_1' });
    }
  });

  it('waitForTerminal surfaces the persisted safe typed failure', async () => {
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'job_1',
      workspaceId: 'ws_1',
      status: 'failed',
      result: {
        error: {
          code: 'graph_parent_conflict',
          jobId: 'job_1',
          message: 'The graph parent changed; enqueue a new push.',
          statusCode: 409,
        },
      },
    });

    await expect(service.waitForTerminal('ws_1', 'job_1', { timeoutMs: 100, pollIntervalMs: 0 })).rejects.toMatchObject(
      {
        constructor: JobFailedException,
        code: 'graph_parent_conflict',
        jobId: 'job_1',
        status: 409,
      },
    );
  });

  it('waitForTerminal times out below the caller abort without cancelling the job', async () => {
    vi.useFakeTimers();
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'job_1',
      workspaceId: 'ws_1',
      status: 'running',
      result: null,
    });

    const pending = service.waitForTerminal('ws_1', 'job_1', { timeoutMs: 25, pollIntervalMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({
      constructor: JobStillRunningException,
      code: 'job_still_running',
      jobId: 'job_1',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });

  it('bounds a never-settling database poll by the same terminal deadline', async () => {
    vi.useFakeTimers();
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    const pending = service.waitForTerminal('ws_1', 'job_1', { timeoutMs: 25, pollIntervalMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({
      constructor: JobStillRunningException,
      code: 'job_still_running',
      jobId: 'job_1',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(prisma.pushJob.findFirst).toHaveBeenCalledTimes(1);
  });

  it('removes every abort listener after a polling delay resolves', async () => {
    vi.useFakeTimers();
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'job_1', workspaceId: 'ws_1', status: 'running', result: null })
      .mockResolvedValueOnce({ id: 'job_1', workspaceId: 'ws_1', status: 'succeeded', result: { versionId: 'v1' } });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = service.waitForTerminal('ws_1', 'job_1', {
      timeoutMs: 100,
      pollIntervalMs: 10,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    const addedAbortListeners = addListener.mock.calls.filter(([type]) => type === 'abort').length;
    const removedAbortListeners = removeListener.mock.calls.filter(([type]) => type === 'abort').length;
    expect(addedAbortListeners).toBeGreaterThan(0);
    expect(removedAbortListeners).toBe(addedAbortListeners);
  });

  it('removes every abort listener when a polling delay is aborted', async () => {
    vi.useFakeTimers();
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'job_1',
      workspaceId: 'ws_1',
      status: 'running',
      result: null,
    });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = service.waitForTerminal('ws_1', 'job_1', {
      timeoutMs: 100,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow('stop waiting');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('stop waiting'));
    await rejection;

    const addedAbortListeners = addListener.mock.calls.filter(([type]) => type === 'abort').length;
    const removedAbortListeners = removeListener.mock.calls.filter(([type]) => type === 'abort').length;
    expect(addedAbortListeners).toBeGreaterThan(0);
    expect(removedAbortListeners).toBe(addedAbortListeners);
  });

  it('uses a valid downward FILE_SNAPSHOT_SYNC_TIMEOUT_MS override', async () => {
    vi.useFakeTimers();
    process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS = '25';
    service = new PushQueueService(prisma as unknown as PrismaService);
    (prisma.pushJob.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    const pending = service.waitForTerminal('ws_1', 'job_1');
    const rejection = expect(pending).rejects.toBeInstanceOf(JobStillRunningException);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(prisma.pushJob.findFirst).toHaveBeenCalledTimes(1);
  });

  it.each([
    'invalid',
    '0',
    '270001',
  ])('rejects invalid or upward FILE_SNAPSHOT_SYNC_TIMEOUT_MS=%s', (configuredTimeout) => {
    process.env.FILE_SNAPSHOT_SYNC_TIMEOUT_MS = configuredTimeout;

    expect(() => new PushQueueService(prisma as unknown as PrismaService)).toThrow(
      /FILE_SNAPSHOT_SYNC_TIMEOUT_MS must be a positive integer no greater than 270000ms/,
    );
  });
});
