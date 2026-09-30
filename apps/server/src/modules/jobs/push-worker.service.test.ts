import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PushWorkerService, BACKOFF_MS } from './push-worker.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { JobProcessor } from './job-processor.service.js';
import { PushJobPhase, ProgressUnit, type PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import { GraphWriteLeaseTimeoutError, RepositoryLeaseBusyError } from '../lease/push-lease.service.js';
import { LicenseState } from '../license/license-state.js';
import { licenseServiceIn } from '../license/license.test-support.js';

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job_1',
    workspaceId: 'ws_1',
    repoName: 'gateway',
    type: 'push',
    payload: { parsedVersion: 'v1', executionToken: '11111111-1111-4111-8111-111111111111' },
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    queuedAt: new Date(),
    nextRunAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    result: null,
    queuedByUserId: 'user_1',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    heartbeatAt: new Date(),
    phase: null,
    progress: null,
    ...overrides,
  };
}

function makePrismaMock(claimed: unknown) {
  const updateMock = vi.fn(async () => ({}));
  const updateManyMock = vi.fn(async () => ({ count: 1 }));
  const attemptUpdateManyMock = vi.fn(async () => ({ count: 1 }));
  return {
    $queryRaw: vi.fn(async () => (claimed ? [{ id: (claimed as { id: string }).id }] : [])),
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    pushJob: {
      update: updateMock,
      updateMany: updateManyMock,
      findUniqueOrThrow: vi.fn(async () => claimed),
    },
    pushJobAttempt: {
      updateMany: attemptUpdateManyMock,
      count: vi.fn(async () => 0),
    },
  } as unknown as PrismaService;
}

describe('PushWorkerService', () => {
  let processor: { process: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    processor = { process: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('license gate on the claim', () => {
    // The worker sees no HTTP guard: without this, an expired deployment keeps
    // draining the queue — importing external data and publishing graphs —
    // indefinitely. `renormalize` is the one exception (it re-derives rows the
    // deployment already holds, and the cron keeps enqueuing it while expired
    // because its raw sources are hard-deleted on a retention deadline).
    //
    // The end-to-end proof that only the renormalize row is claimable lives in
    // push-worker-license-claim.postgres.integration.test.ts, against real SQL.
    it('narrows the claim to renormalize while the license is expired past grace', async () => {
      const prisma = makePrismaMock(makeJobRow({ type: 'renormalize' }));
      const license = licenseServiceIn(LicenseState.Expired);
      const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor, license);
      const warnSpy = vi.spyOn((worker as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');

      expect(await worker.claimNextJob()).toMatchObject({ id: 'job_1' });
      await worker.claimNextJob();

      // The restriction is a parameter of the single claim query, not a
      // claim-then-release: releasing would already have burnt an attempt.
      const calls = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
      const sql = Array.from(calls[0]![0] as TemplateStringsArray).join('?');
      expect(sql).toContain("NOT ?::boolean OR candidate.type = 'renormalize'");
      expect(calls[0]!.slice(1)).toEqual([true]);
      // Rate-limited: the loop polls every couple of seconds, so two claims
      // must not become two log lines.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claiming renormalize jobs only'));
      license.onModuleDestroy();
    });

    it.each([
      LicenseState.Absent,
      LicenseState.Valid,
      LicenseState.Grace,
    ])('claims normally while the license is %s', async (state) => {
      const prisma = makePrismaMock(makeJobRow());
      const license = licenseServiceIn(state);
      const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor, license);

      expect(await worker.claimNextJob()).toMatchObject({ id: 'job_1' });
      expect((prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(1)).toEqual([false]);
      license.onModuleDestroy();
    });
  });

  it('claim returns null when no job is ready', async () => {
    const prisma = makePrismaMock(null);
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const job = await worker.claimNextJob();
    expect(job).toBeNull();
  });

  it('claim query holds resolve jobs while any workspace push is pending or running', async () => {
    const prisma = makePrismaMock(null);
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    await worker.claimNextJob();

    const template = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TemplateStringsArray;
    const sql = Array.from(template).join('?');
    expect(sql).toContain("candidate.type <> 'resolve'");
    expect(sql).toContain('active_push.workspace_id = candidate.workspace_id');
    expect(sql).toContain("active_push.type = 'push'");
    expect(sql).toContain("active_push.status IN ('pending', 'running')");
    expect(sql).toContain('SELECT gen_random_uuid()::text, claimed.id');
    expect(sql).not.toContain('SELECT claimed.lease_token::text');
  });

  it('processOnce: success path marks succeeded with result', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    processor.process.mockResolvedValue({ ok: true });
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const handled = await worker.processOnce();
    expect(handled).toBe(true);
    const calls = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({
      where: { id: 'job_1', status: 'running' },
      data: { status: 'succeeded', result: { ok: true } },
    });
    expect(processor.process).toHaveBeenCalledWith(
      claimed,
      expect.objectContaining({
        jobId: 'job_1',
        executionToken: '11111111-1111-4111-8111-111111111111',
        leaseOwnerToken: '22222222-2222-4222-8222-222222222222',
      }),
    );
  });

  it('processOnce: resolve jobs use their stable payload execution token instead of the claim lease', async () => {
    const claimed = makeJobRow({
      type: 'resolve',
      payload: {
        executionToken: '33333333-3333-4333-8333-333333333333',
        mapper: { version: 'mapper-v1', key: 'ws_1/mappers/mapper-v1.json', sha256: 'a'.repeat(64), size: 42 },
      },
    });
    const prisma = makePrismaMock(claimed);
    processor.process.mockResolvedValue({ ok: true });
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    await worker.processOnce();

    expect(processor.process).toHaveBeenCalledWith(
      claimed,
      expect.objectContaining({
        jobId: 'job_1',
        executionToken: '33333333-3333-4333-8333-333333333333',
      }),
    );
  });

  it('processOnce: connector jobs without graph execution tokens use the claimed lease token', async () => {
    const claimed = makeJobRow({
      type: 'connector_sync',
      payload: { connectorId: 'connector_1' },
    });
    const prisma = makePrismaMock(claimed);
    processor.process.mockResolvedValue({ imported: 3 });
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    await expect(worker.processOnce()).resolves.toBe(true);

    expect(processor.process).toHaveBeenCalledWith(
      claimed,
      expect.objectContaining({
        jobId: 'job_1',
        executionToken: '22222222-2222-4222-8222-222222222222',
        leaseOwnerToken: '22222222-2222-4222-8222-222222222222',
      }),
    );
    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({
      status: 'succeeded',
      result: { imported: 3 },
    });
  });

  it('processOnce: transient failure (1st attempt) requeues with first backoff', async () => {
    const claimed = makeJobRow({ attempts: 1 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new Error('network'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    const updateArgs = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.data.status).toBe('pending');
    expect(updateArgs.data.lastError).toBe('Job execution failed');
    expect((updateArgs.data.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now() + BACKOFF_MS[0] - 1000);
  });

  it('logs an internal error and stack before persisting only its safe classification', async () => {
    const claimed = makeJobRow({ attempts: 3, maxAttempts: 3 });
    const prisma = makePrismaMock(claimed);
    (prisma.pushJobAttempt.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    const internal = new Error('postgres password=server-side-secret');
    internal.name = 'DatabaseError';
    Object.assign(internal, { code: 'ECONNRESET' });
    internal.stack = [
      'DatabaseError: postgres password=server-side-secret',
      '    at connect (/srv/database.ts:10:2)',
      '    at processJob (/srv/worker.ts:20:4)',
    ].join('\n');
    processor.process.mockRejectedValue(internal);
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const logger = (worker as unknown as { logger: { error: (...args: unknown[]) => void } }).logger;
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await worker.processOnce();

    const finalization = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(errorLog).toHaveBeenCalledWith(
      'Job job_1 failed (DatabaseError, code=ECONNRESET)',
      '    at connect (/srv/database.ts:10:2)\n    at processJob (/srv/worker.ts:20:4)',
    );
    expect(errorLog.mock.invocationCallOrder[0]).toBeLessThan(
      (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(finalization[0].data.lastError).toBe('Job execution failed');
    expect(JSON.stringify(finalization[0].data.result)).not.toContain('server-side-secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('server-side-secret');
  });

  it('processOnce: permanent failure (BadRequestException) fails immediately, no retry', async () => {
    const claimed = makeJobRow({ attempts: 1 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new BadRequestException('bad input'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data.status).toBe('failed');
  });

  it('processOnce: permanent failure (NotFoundException) fails immediately', async () => {
    const claimed = makeJobRow({ attempts: 1 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new NotFoundException('missing'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data.status).toBe('failed');
  });

  it('processOnce: a parent conflict requeues while retry budget remains', async () => {
    const claimed = makeJobRow({ attempts: 1 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(
      Object.assign(new Error('Active parent no longer matches'), { code: 'graph_parent_conflict' }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    await worker.processOnce();

    const data = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'pending',
      lastError: 'Active parent no longer matches',
    });
    expect(data.result).toBeUndefined();
  });

  it('processOnce: parent conflict at max attempts persists the typed terminal error', async () => {
    const claimed = makeJobRow({ attempts: 3, maxAttempts: 3 });
    const prisma = makePrismaMock(claimed);
    (prisma.pushJobAttempt.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    processor.process.mockRejectedValue(
      Object.assign(new Error('Active parent kept moving'), { code: 'graph_parent_conflict' }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    await worker.processOnce();

    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      lastError: 'Active parent kept moving',
      result: {
        error: {
          code: 'graph_parent_conflict',
          jobId: 'job_1',
          message: 'Active parent kept moving',
          statusCode: 409,
        },
      },
    });
  });

  it('processOnce: transient failure at max attempts → status=failed', async () => {
    const claimed = makeJobRow({ attempts: 3, maxAttempts: 3 });
    const prisma = makePrismaMock(claimed);
    (prisma.pushJobAttempt.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    processor.process.mockRejectedValue(new Error('network'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      lastError: 'Job execution failed',
      result: {
        error: {
          code: 'job_internal_error',
          jobId: 'job_1',
          message: 'Job execution failed',
          statusCode: 503,
        },
      },
    });
  });

  it('processOnce: truncates lastError to 4096 chars', async () => {
    const claimed = makeJobRow({ attempts: 1 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new BadRequestException('x'.repeat(10000)));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    const err = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data.lastError as string;
    expect(err.length).toBeLessThanOrEqual(4096);
    const result = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data.result;
    expect(result.error.message).toHaveLength(500);
  });

  it('processOnce: stolen job (stale recovery reclaimed) logs warning and discards result', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    processor.process.mockResolvedValue({ ok: true });
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const handled = await worker.processOnce();
    expect(handled).toBe(true);
    expect((prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toMatchObject({
      id: 'job_1',
      status: 'running',
    });
  });

  it('heartbeats a healthy long-running attempt with the current lease token', async () => {
    vi.useFakeTimers();
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    let finish!: (value: unknown) => void;
    processor.process.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const work = worker.processOnce();
    await vi.waitFor(() => expect(processor.process).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(15_000);

    const heartbeat = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.heartbeatAt,
    );
    expect(heartbeat?.[0].where).toMatchObject({
      id: 'job_1',
      status: 'running',
      leaseToken: '22222222-2222-4222-8222-222222222222',
    });
    finish({ ok: true });
    await work;
  });

  it('marks the attempt lease_lost when a heartbeat no longer owns the job', async () => {
    vi.useFakeTimers();
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    processor.process.mockImplementation(
      async (_job: unknown, execution: PushExecutionContext) =>
        new Promise((_resolve, reject) => {
          execution.signal?.addEventListener('abort', () => reject(execution.signal?.reason), { once: true });
        }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const work = worker.processOnce();
    await vi.waitFor(() => expect(processor.process).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(15_000);
    await work;

    const finalizedAttempt = (prisma.pushJobAttempt.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'lease_lost',
    );
    expect(finalizedAttempt?.[0].where).toMatchObject({
      jobId: 'job_1',
      leaseToken: '22222222-2222-4222-8222-222222222222',
      status: 'running',
    });
  });

  it('requeues controlled shutdown as interrupted without consuming failure budget', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    (prisma.pushJobAttempt.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    processor.process.mockImplementation(
      async (_job: unknown, execution: PushExecutionContext) =>
        new Promise((_resolve, reject) => {
          execution.signal?.addEventListener('abort', () => reject(execution.signal?.reason), { once: true });
        }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const work = worker.processOnce();
    await vi.waitFor(() => expect(processor.process).toHaveBeenCalled());

    await worker.onModuleDestroy();
    await work;

    const jobFinalization = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'pending',
    );
    expect(jobFinalization?.[0].data.nextRunAt).toBeInstanceOf(Date);
    const attemptFinalization = (prisma.pushJobAttempt.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'interrupted',
    );
    expect(attemptFinalization).toBeDefined();
    expect(prisma.pushJobAttempt.count).toHaveBeenCalled();
  });

  it('recoverStaleRunningJobs: resets `running` jobs older than threshold to `pending`', async () => {
    const prisma = makePrismaMock(null);
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'one' },
      { id: 'two' },
      { id: 'three' },
    ]);
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);

    const recovered = await worker.recoverStaleRunningJobs();

    expect(recovered).toBe(3);
    const template = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TemplateStringsArray;
    const sql = Array.from(template).join('?');
    expect(sql).toContain("COALESCE(job.heartbeat_at, job.started_at, job.queued_at) < NOW() - INTERVAL '2 minutes'");
    expect(sql).toContain("'job_stale_recovery_exhausted'");
    expect(sql).toContain("'statusCode', 503");
  });

  it('onModuleInit: runs stale recovery before starting loops; respects PUSH_WORKER_ENABLED=false', async () => {
    const prisma = makePrismaMock(null);

    // Disabled: no recovery, no loops. The kill-switch is read once, at
    // construction, from the validated config — so each phase builds its own.
    process.env.PUSH_WORKER_ENABLED = 'false';
    const disabled = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const notRecovered = vi.spyOn(disabled, 'recoverStaleRunningJobs');
    await disabled.onModuleInit();
    expect(notRecovered).not.toHaveBeenCalled();
    delete process.env.PUSH_WORKER_ENABLED;

    // Enabled: recovery runs. Stop the worker immediately so the loop doesn't poll forever.
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const recover = vi.spyOn(worker, 'recoverStaleRunningJobs');
    await worker.onModuleInit();
    expect(recover).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });

  it('onModuleInit starts exactly one worker loop when concurrency is not configured', async () => {
    const previousEnabled = process.env.PUSH_WORKER_ENABLED;
    const previousConcurrency = process.env.PUSH_WORKER_CONCURRENCY;
    delete process.env.PUSH_WORKER_ENABLED;
    delete process.env.PUSH_WORKER_CONCURRENCY;
    const prisma = makePrismaMock(null);
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const loopRunner = worker as unknown as { runLoop(index: number): Promise<void> };
    const runLoop = vi.spyOn(loopRunner, 'runLoop').mockResolvedValue(undefined);

    try {
      await worker.onModuleInit();

      expect(runLoop.mock.calls).toEqual([[0]]);
      await worker.onModuleDestroy();
    } finally {
      if (previousEnabled === undefined) delete process.env.PUSH_WORKER_ENABLED;
      else process.env.PUSH_WORKER_ENABLED = previousEnabled;
      if (previousConcurrency === undefined) delete process.env.PUSH_WORKER_CONCURRENCY;
      else process.env.PUSH_WORKER_CONCURRENCY = previousConcurrency;
    }
  });
});

describe('PushWorkerService lease-busy, claim-cap and heartbeat tolerance', () => {
  let processor: { process: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    processor = { process: vi.fn() };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requeues a lease-busy failure as interrupted with a 60s delay, not consuming failure budget', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new RepositoryLeaseBusyError('gateway'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();

    const jobFinalization = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'pending',
    );
    expect(jobFinalization).toBeDefined();
    const nextRunAt = jobFinalization![0].data.nextRunAt as Date;
    expect(nextRunAt.getTime()).toBeGreaterThan(Date.now() + 45_000);
    expect(nextRunAt.getTime()).toBeLessThan(Date.now() + 90_000);
    const attemptFinalization = (prisma.pushJobAttempt.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'interrupted',
    );
    expect(attemptFinalization).toBeDefined();
  });

  it('graph-write wait timeout is also treated as busy, not as a failed attempt', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new GraphWriteLeaseTimeoutError('ws_1'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();
    const attemptFinalization = (prisma.pushJobAttempt.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'interrupted',
    );
    expect(attemptFinalization).toBeDefined();
  });

  it('fails a job at the total-claims cap with a distinct claim-budget error', async () => {
    const claimed = makeJobRow({ attempts: 9, maxAttempts: 3 });
    const prisma = makePrismaMock(claimed);
    processor.process.mockRejectedValue(new RepositoryLeaseBusyError('gateway'));
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();

    const jobFinalization = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jobFinalization.data.status).toBe('failed');
    expect(jobFinalization.data.lastError).toContain('Claim budget exhausted');
    expect(jobFinalization.data.result).toEqual({
      error: {
        code: 'job_claim_budget_exhausted',
        jobId: 'job_1',
        message: 'Claim budget exhausted after 9 claims',
        statusCode: 503,
      },
    });
  });

  it('tolerates a transient heartbeat query failure instead of aborting the push', async () => {
    vi.useFakeTimers();
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pg pool exhausted'));
    let finish!: (value: unknown) => void;
    processor.process.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    const work = worker.processOnce();
    await vi.waitFor(() => expect(processor.process).toHaveBeenCalled());

    // First beat fails transiently — the execution must stay alive because the
    // last CONFIRMED heartbeat is well within the staleness budget.
    await vi.advanceTimersByTimeAsync(15_000);

    finish({ ok: true });
    await work;
    const succeeded = (prisma.pushJob.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'succeeded',
    );
    expect(succeeded).toBeDefined();
  });

  it('persists per-phase timings into the attempt on finalization', async () => {
    const claimed = makeJobRow();
    const prisma = makePrismaMock(claimed);
    processor.process.mockImplementation(async (_job: unknown, execution: PushExecutionContext) => {
      execution.report(PushJobPhase.LoadingArtifacts);
      execution.report(PushJobPhase.WritingNodes, 10, 20, ProgressUnit.Nodes);
      execution.report(PushJobPhase.Completed, 1, 1, ProgressUnit.Steps);
      return { ok: true };
    });
    const worker = new PushWorkerService(prisma, processor as unknown as JobProcessor);
    await worker.processOnce();

    const attemptFinalization = (prisma.pushJobAttempt.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0].data.status === 'succeeded',
    );
    expect(attemptFinalization).toBeDefined();
    const timings = attemptFinalization![0].data.phaseTimings as Record<string, number>;
    expect(Object.keys(timings)).toEqual(
      expect.arrayContaining([PushJobPhase.LoadingArtifacts, PushJobPhase.WritingNodes, PushJobPhase.Completed]),
    );
    expect(attemptFinalization![0].data.progress).toMatchObject({ phase: PushJobPhase.Completed });
  });
});
