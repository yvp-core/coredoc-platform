import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { CaptureRetentionCron } from './capture-retention.cron.js';
import { CaptureService } from './capture.service.js';

const TEST_DATABASE_URL = process.env.CAPTURE_TEST_DATABASE_URL ?? '';
const RUN = `capture_retention_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const NOW = new Date('2026-08-17T04:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 90 * 86_400_000);
const REPOSITORY_KEY = 'coredoc/coredoc-parser';

function enableRetention(): void {
  process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
  delete process.env.CAPTURE_FINE_RETENTION_DAYS;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
}

function runStarted(eventId: string, runId: string, sessionId: string, taskId: string) {
  return {
    schemaVersion: 2,
    eventId,
    occurredAt: '2026-08-17T10:00:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: REPOSITORY_KEY,
    taskId,
    type: 'workflow.run.started',
    data: {
      workflowId: 'change:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'normal',
      stages: [{ stageId: 'implement', after: [] }],
    },
  };
}

function stageEvent(
  type: 'workflow.stage.started' | 'workflow.stage.finished',
  eventId: string,
  runId: string,
  sessionId: string,
  occurrenceId: string,
  attempt: number,
  occurredAt: string,
) {
  return {
    schemaVersion: 2,
    eventId,
    occurredAt,
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: REPOSITORY_KEY,
    type,
    data: {
      occurrenceId,
      stageId: 'implement',
      attempt,
      ...(type === 'workflow.stage.finished' ? { outcome: 'success' } : {}),
    },
  };
}

function runFinished(eventId: string, runId: string, sessionId: string) {
  return {
    schemaVersion: 2,
    eventId,
    occurredAt: '2026-08-17T10:05:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: REPOSITORY_KEY,
    type: 'workflow.run.finished',
    data: {
      outcome: 'success',
      counters: { verificationRuns: 2, verificationFailures: 1, editVerifyRounds: 1 },
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('CaptureRetentionCron (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let workspaceSequence = 0;
  const workspaceIds: string[] = [];

  async function createWorkspace(): Promise<string> {
    workspaceSequence += 1;
    const slug = `${RUN}_${workspaceSequence}`;
    const workspace = await prisma.workspace.create({ data: { name: slug, slug } });
    workspaceIds.push(workspace.id);
    await prisma.workspaceRepo.create({
      data: {
        workspaceId: workspace.id,
        repoKey: `graph-${slug}`,
        repoName: slug,
        captureRepositoryKey: REPOSITORY_KEY,
      },
    });
    return workspace.id;
  }

  async function createCaptureEvent(
    workspaceId: string,
    input: {
      actorId: string;
      host: 'claude-code' | 'codex';
      type: string;
      receivedAt: Date;
      occurredAt: Date;
      repositoryKey?: string | null;
    },
  ) {
    return prisma.captureEvent.create({
      data: {
        workspaceId,
        eventId: randomUUID(),
        schemaVersion: 2,
        type: input.type,
        occurredAt: input.occurredAt,
        receivedAt: input.receivedAt,
        host: input.host,
        sessionId: `${RUN}-session`,
        repositoryKey: input.repositoryKey ?? null,
        data: {},
        actorId: input.actorId,
      },
    });
  }

  async function seedCodexEvents(
    workspaceId: string,
    actorId: string,
    firstReceivedAt: Date,
    count: number,
  ): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO capture_events (
        workspace_id,
        event_id,
        schema_version,
        type,
        occurred_at,
        received_at,
        host,
        session_id,
        repository_key,
        data,
        actor_id
      )
      SELECT
        ${workspaceId}::uuid,
        gen_random_uuid(),
        1,
        'capability.used',
        ${NOW},
        ${firstReceivedAt}::timestamptz + series.number * INTERVAL '1 millisecond',
        'codex',
        ${`${RUN}-bulk-session`},
        ${REPOSITORY_KEY},
        '{}'::jsonb,
        ${actorId}
      FROM generate_series(1, ${count}) AS series(number)
    `;
  }

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
  });

  beforeEach(async () => {
    await prisma.captureRetentionCheckpoint.deleteMany({ where: { id: 'capture_fine_events' } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.CAPTURE_FINE_RETENTION_ENABLED;
    delete process.env.CAPTURE_FINE_RETENTION_DAYS;
    await prisma.captureRetentionCheckpoint.deleteMany({ where: { id: 'capture_fine_events' } });
    if (workspaceIds.length > 0) {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds.splice(0) } } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('purges only strict received-time predecessors and atomically backfills exact host-scoped watermarks', async () => {
    const workspaceId = await createWorkspace();
    const claudeActor = `${RUN}-claude`;
    const codexActor = `${RUN}-codex`;
    const preexistingFirst = new Date(CUTOFF.getTime() - 4_000);
    await createCaptureEvent(workspaceId, {
      actorId: claudeActor,
      host: 'claude-code',
      type: 'workflow.run.started',
      receivedAt: new Date(CUTOFF.getTime() - 3_000),
      occurredAt: new Date('2099-01-01T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    const oldStage = await createCaptureEvent(workspaceId, {
      actorId: claudeActor,
      host: 'claude-code',
      type: 'workflow.stage.finished',
      receivedAt: new Date(CUTOFF.getTime() - 2_000),
      occurredAt: new Date('2099-01-02T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    const oldCapability = await createCaptureEvent(workspaceId, {
      actorId: claudeActor,
      host: 'claude-code',
      type: 'capability.used',
      receivedAt: new Date(CUTOFF.getTime() - 1_000),
      occurredAt: new Date('2099-01-03T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    const oldCodex = await createCaptureEvent(workspaceId, {
      actorId: codexActor,
      host: 'codex',
      type: 'workflow.stage.started',
      receivedAt: new Date(CUTOFF.getTime() - 500),
      occurredAt: new Date('2099-01-04T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    const exactCutoff = await createCaptureEvent(workspaceId, {
      actorId: claudeActor,
      host: 'claude-code',
      type: 'capability.used',
      receivedAt: CUTOFF,
      occurredAt: new Date('2000-01-01T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    const freshReceived = await createCaptureEvent(workspaceId, {
      actorId: claudeActor,
      host: 'claude-code',
      type: 'capability.used',
      receivedAt: new Date(CUTOFF.getTime() + 1),
      occurredAt: new Date('2000-01-02T00:00:00.000Z'),
      repositoryKey: REPOSITORY_KEY,
    });
    await prisma.captureAcceptedWatermark.create({
      data: {
        workspaceId,
        actorId: claudeActor,
        host: 'claude-code',
        scopeKey: `repo:${REPOSITORY_KEY}`,
        repositoryKey: REPOSITORY_KEY,
        firstAcceptedAt: preexistingFirst,
        lastAcceptedAt: preexistingFirst,
      },
    });

    enableRetention();
    await new CaptureRetentionCron(prisma as unknown as PrismaService).purgeExpiredCaptureEvents();

    const remaining = await prisma.captureEvent.findMany({
      where: { workspaceId },
      orderBy: { receivedAt: 'asc' },
      select: { eventId: true },
    });
    expect(remaining.map(({ eventId }) => eventId)).toEqual([exactCutoff.eventId, freshReceived.eventId]);

    const watermarks = await prisma.captureAcceptedWatermark.findMany({
      where: { workspaceId },
      orderBy: { host: 'asc' },
    });
    expect(watermarks).toEqual([
      expect.objectContaining({
        actorId: claudeActor,
        host: 'claude-code',
        scopeKey: `repo:${REPOSITORY_KEY}`,
        repositoryKey: REPOSITORY_KEY,
        firstAcceptedAt: preexistingFirst,
        lastAcceptedAt: oldCapability.receivedAt,
        workflowLastAcceptedAt: oldStage.receivedAt,
      }),
      expect.objectContaining({
        actorId: codexActor,
        host: 'codex',
        scopeKey: `repo:${REPOSITORY_KEY}`,
        repositoryKey: REPOSITORY_KEY,
        firstAcceptedAt: oldCodex.receivedAt,
        lastAcceptedAt: oldCodex.receivedAt,
        workflowLastAcceptedAt: oldCodex.receivedAt,
      }),
    ]);
    await expect(
      prisma.captureRetentionCheckpoint.findUniqueOrThrow({ where: { id: 'capture_fine_events' } }),
    ).resolves.toMatchObject({ purgedThroughReceivedAt: CUTOFF });
  });

  it('deletes at most 10,000 rows per invocation and advances the checkpoint conservatively', async () => {
    const workspaceId = await createWorkspace();
    const actorId = `${RUN}-bulk-actor`;
    const firstReceivedAt = new Date('2026-01-01T00:00:00.000Z');
    await seedCodexEvents(workspaceId, actorId, firstReceivedAt, 10_001);
    enableRetention();
    const cron = new CaptureRetentionCron(prisma as unknown as PrismaService);

    await cron.purgeExpiredCaptureEvents();

    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(1);
    await expect(
      prisma.captureRetentionCheckpoint.findUniqueOrThrow({ where: { id: 'capture_fine_events' } }),
    ).resolves.toMatchObject({
      purgedThroughReceivedAt: new Date(firstReceivedAt.getTime() + 10_000),
    });
    await expect(
      prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId,
            host: 'codex',
            scopeKey: `repo:${REPOSITORY_KEY}`,
          },
        },
      }),
    ).resolves.toMatchObject({
      firstAcceptedAt: new Date(firstReceivedAt.getTime() + 1),
      lastAcceptedAt: new Date(firstReceivedAt.getTime() + 10_000),
      workflowLastAcceptedAt: null,
    });

    await cron.purgeExpiredCaptureEvents();

    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(0);
    await expect(
      prisma.captureRetentionCheckpoint.findUniqueOrThrow({ where: { id: 'capture_fine_events' } }),
    ).resolves.toMatchObject({ purgedThroughReceivedAt: CUTOFF });
    await expect(
      prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId,
            host: 'codex',
            scopeKey: `repo:${REPOSITORY_KEY}`,
          },
        },
      }),
    ).resolves.toMatchObject({
      firstAcceptedAt: new Date(firstReceivedAt.getTime() + 1),
      lastAcceptedAt: new Date(firstReceivedAt.getTime() + 10_001),
      workflowLastAcceptedAt: null,
    });
  });

  it('rolls back delete, watermark, and checkpoint together, then retries without losing durable projections', async () => {
    const workspaceId = await createWorkspace();
    const actor = { id: `${RUN}-projection-actor`, email: `${RUN}@example.com` };
    const service = new CaptureService(prisma as unknown as PrismaService);
    const runId = 'cdr-20260817-c6a001';
    const sessionId = `${RUN}-projection-session`;
    const taskId = `cdt_${randomUUID()}`;
    const firstOccurrenceId = randomUUID();
    const secondOccurrenceId = randomUUID();
    const events = [
      runStarted(randomUUID(), runId, sessionId, taskId),
      stageEvent(
        'workflow.stage.started',
        randomUUID(),
        runId,
        sessionId,
        firstOccurrenceId,
        1,
        '2026-08-17T10:01:00.000Z',
      ),
      stageEvent(
        'workflow.stage.finished',
        randomUUID(),
        runId,
        sessionId,
        firstOccurrenceId,
        1,
        '2026-08-17T10:02:00.000Z',
      ),
      stageEvent(
        'workflow.stage.started',
        randomUUID(),
        runId,
        sessionId,
        secondOccurrenceId,
        2,
        '2026-08-17T10:03:00.000Z',
      ),
      runFinished(randomUUID(), runId, sessionId),
    ];
    await expect(service.ingest(workspaceId, actor, { events })).resolves.toEqual({
      acceptedEventIds: events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    });
    const oldReceivedAt = new Date('2026-01-05T00:00:00.000Z');
    await prisma.captureEvent.updateMany({ where: { workspaceId }, data: { receivedAt: oldReceivedAt } });
    await prisma.captureAcceptedWatermark.deleteMany({ where: { workspaceId } });
    enableRetention();

    const rollbackPrisma = {
      $transaction: (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          await operation(tx);
          throw new Error('injected retention rollback');
        }),
    } as unknown as PrismaService;
    await expect(new CaptureRetentionCron(rollbackPrisma).purgeExpiredCaptureEvents()).rejects.toThrow(
      'injected retention rollback',
    );

    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(events.length);
    expect(await prisma.captureAcceptedWatermark.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.captureRetentionCheckpoint.findUnique({ where: { id: 'capture_fine_events' } })).toBeNull();

    await new CaptureRetentionCron(prisma as unknown as PrismaService).purgeExpiredCaptureEvents();

    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(0);
    await expect(
      prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId: actor.id,
            host: 'claude-code',
            scopeKey: `repo:${REPOSITORY_KEY}`,
          },
        },
      }),
    ).resolves.toMatchObject({
      firstAcceptedAt: oldReceivedAt,
      lastAcceptedAt: oldReceivedAt,
      workflowLastAcceptedAt: oldReceivedAt,
    });
    await expect(
      prisma.workflowRun.findUniqueOrThrow({ where: { workspaceId_runId: { workspaceId, runId } } }),
    ).resolves.toMatchObject({ deliveryTaskId: taskId, outcome: 'success' });
    expect(await prisma.workflowStageOccurrence.count({ where: { workflowRun: { workspaceId, runId } } })).toBe(2);
    // A stage re-entry is an iteration fact, not rework: capture no longer writes a signal for it.
    expect(await prisma.deliveryReworkSignal.count({ where: { workspaceId, deliveryTaskId: taskId } })).toBe(0);
    await expect(
      prisma.deliveryTask.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: taskId } } }),
    ).resolves.toMatchObject({ lifecycle: 'active', authority: 'coredoc' });
  });

  it('converges concurrent and duplicate sweeps without overstating or regressing the checkpoint', async () => {
    const workspaceId = await createWorkspace();
    const actorId = `${RUN}-concurrent-actor`;
    const firstReceivedAt = new Date('2026-02-01T00:00:00.000Z');
    await seedCodexEvents(workspaceId, actorId, firstReceivedAt, 1_001);
    enableRetention();
    const first = new CaptureRetentionCron(prisma as unknown as PrismaService);
    const second = new CaptureRetentionCron(prisma as unknown as PrismaService);

    await Promise.all([first.purgeExpiredCaptureEvents(), second.purgeExpiredCaptureEvents()]);

    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(0);
    const checkpoint = await prisma.captureRetentionCheckpoint.findUniqueOrThrow({
      where: { id: 'capture_fine_events' },
    });
    expect(checkpoint.purgedThroughReceivedAt).toEqual(CUTOFF);

    vi.setSystemTime(new Date(NOW.getTime() - 86_400_000));
    await first.purgeExpiredCaptureEvents();

    await expect(
      prisma.captureRetentionCheckpoint.findUniqueOrThrow({ where: { id: 'capture_fine_events' } }),
    ).resolves.toMatchObject({ purgedThroughReceivedAt: CUTOFF });
    await expect(
      prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId,
            host: 'codex',
            scopeKey: `repo:${REPOSITORY_KEY}`,
          },
        },
      }),
    ).resolves.toMatchObject({
      firstAcceptedAt: new Date(firstReceivedAt.getTime() + 1),
      lastAcceptedAt: new Date(firstReceivedAt.getTime() + 1_001),
    });
  });
});
