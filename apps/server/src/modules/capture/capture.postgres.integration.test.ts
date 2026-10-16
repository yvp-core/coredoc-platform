import '../../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { CaptureService } from './capture.service.js';

const TEST_DATABASE_URL = process.env.CAPTURE_TEST_DATABASE_URL ?? '';
const RUN = `capture_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const ACTOR = { id: `${RUN}-actor`, email: `${RUN}@example.com` };

function twoPartyBarrier() {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      if (arrivals >= 2) return;
      arrivals += 1;
      if (arrivals === 2) release();
      await ready;
    },
    arrivals: () => arrivals,
  };
}

function started(eventId: string, runId: string, sessionId: string) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: '2026-08-16T10:00:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: 'coredoc/coredoc-parser',
    taskId: 'DELIVERY-42',
    type: 'workflow.run.started',
    data: { workflowId: 'change:normal', intent: 'change', risk: 'normal', scale: 'normal' },
  };
}

function finished(eventId: string, runId: string, sessionId: string) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: '2026-08-16T10:05:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: 'coredoc/coredoc-parser',
    taskId: 'DELIVERY-42',
    type: 'workflow.run.finished',
    data: {
      outcome: 'success',
      counters: { editCalls: 2, verificationRuns: 1, verificationPasses: 1 },
    },
  };
}

function startedV2(eventId: string, runId: string, sessionId: string, taskId: string) {
  return {
    schemaVersion: 2,
    eventId,
    occurredAt: '2026-08-17T10:00:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: 'coredoc/coredoc-parser',
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

function startedV3(
  eventId: string,
  runId: string,
  sessionId: string,
  workItems: Array<{ provider: string; externalId: string; externalKey?: string }>,
) {
  return {
    schemaVersion: 3,
    eventId,
    occurredAt: '2026-08-17T10:00:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: 'coredoc/coredoc-parser',
    type: 'workflow.run.started',
    data: {
      workflowId: 'change:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'normal',
      stages: [{ stageId: 'implement', after: [] }],
      workItems,
    },
  };
}

function stageStartedV2(
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
    repositoryKey: 'coredoc/coredoc-parser',
    type: 'workflow.stage.started',
    data: { occurrenceId, stageId: 'implement', attempt },
  };
}

function stageFinishedV2(
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
    repositoryKey: 'coredoc/coredoc-parser',
    type: 'workflow.stage.finished',
    data: { occurrenceId, stageId: 'implement', attempt, outcome: 'success' },
  };
}

function finishedV2(eventId: string, runId: string, sessionId: string) {
  return {
    schemaVersion: 2,
    eventId,
    occurredAt: '2026-08-17T10:05:00.000Z',
    host: 'claude-code',
    sessionId,
    runId,
    repositoryKey: 'coredoc/coredoc-parser',
    type: 'workflow.run.finished',
    data: {
      outcome: 'success',
      counters: { verificationRuns: 2, verificationFailures: 1, editVerifyRounds: 1 },
    },
  };
}

function capabilityUsed(eventId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: '2026-08-17T09:59:00.000Z',
    host: 'claude-code',
    sessionId,
    type: 'capability.used',
    data: { kind: 'skill', capabilityId: 'coredoc-tdd', outcome: 'success' },
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function holdWorkspaceAdvisoryLock(prisma: PrismaClient, workspaceId: string) {
  const acquired = deferred();
  const release = deferred();
  const finished = prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))
    `;
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  return { release: release.resolve, finished };
}

async function waitForAdvisoryWaiters(prisma: PrismaClient, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted = false
    `;
    if (Number(row?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiter(s)`);
}

describe.skipIf(!TEST_DATABASE_URL)('CaptureService (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let service: CaptureService;
  let controlPlane: ControlPlaneService;
  let workspaceId: string;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    service = new CaptureService(prisma as unknown as PrismaService);
    controlPlane = new ControlPlaneService(prisma as unknown as PrismaService);
    const workspace = await prisma.workspace.create({
      data: { name: RUN, slug: RUN },
    });
    workspaceId = workspace.id;
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: `graph-${RUN}`,
        repoName: RUN,
        captureRepositoryKey: 'coredoc/coredoc-parser',
      },
    });
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('resolves and idempotently binds one server-trusted Git identity', async () => {
    const repoKey = `resolver-${RUN}`;
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey,
        repoName: `resolver-${RUN}`,
        gitUrl: 'git@github.com:owner/resolver-repo.git',
      },
    });

    await expect(service.resolveRepository(workspaceId, { repositoryKey: 'owner/resolver-repo' })).resolves.toEqual({
      status: 'resolved',
      repositoryKey: 'owner/resolver-repo',
    });
    await expect(service.resolveRepository(workspaceId, { repositoryKey: 'owner/resolver-repo' })).resolves.toEqual({
      status: 'resolved',
      repositoryKey: 'owner/resolver-repo',
    });

    await expect(
      prisma.workspaceRepo.findUnique({
        where: { workspaceId_repoKey: { workspaceId, repoKey } },
        select: { captureRepositoryKey: true },
      }),
    ).resolves.toEqual({ captureRepositoryKey: 'owner/resolver-repo' });
  });

  it('serializes a trusted gitUrl mutation ahead of resolution and re-reads the committed identity', async () => {
    const repoKey = `resolver-mutation-${RUN}`;
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey,
        repoName: repoKey,
        gitUrl: 'https://github.com/owner/concurrent-original.git',
      },
    });

    const blocker = await holdWorkspaceAdvisoryLock(prisma, workspaceId);
    let mutation: Promise<unknown> | undefined;
    let resolution: ReturnType<CaptureService['resolveRepository']> | undefined;
    try {
      mutation = controlPlane.updateRepo(workspaceId, repoKey, {
        gitUrl: 'https://github.com/owner/concurrent-renamed.git',
      });
      await waitForAdvisoryWaiters(prisma, 1);

      resolution = service.resolveRepository(workspaceId, { repositoryKey: 'owner/concurrent-original' });
      await waitForAdvisoryWaiters(prisma, 2);
    } finally {
      blocker.release();
      await blocker.finished;
    }

    await mutation;
    await expect(resolution).resolves.toEqual({ status: 'unregistered' });
    await expect(
      prisma.workspaceRepo.findUnique({
        where: { workspaceId_repoKey: { workspaceId, repoKey } },
        select: { gitUrl: true, captureRepositoryKey: true },
      }),
    ).resolves.toEqual({
      gitUrl: 'https://github.com/owner/concurrent-renamed.git',
      captureRepositoryKey: null,
    });
  });

  it('serializes second-match creation ahead of resolution and fails closed as ambiguous', async () => {
    const firstRepoKey = `resolver-ambiguous-a-${RUN}`;
    const secondRepoKey = `resolver-ambiguous-b-${RUN}`;
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: firstRepoKey,
        repoName: firstRepoKey,
        gitUrl: 'https://github.com/owner/concurrent-ambiguous.git',
      },
    });

    const blocker = await holdWorkspaceAdvisoryLock(prisma, workspaceId);
    let creation: Promise<unknown> | undefined;
    let resolution: ReturnType<CaptureService['resolveRepository']> | undefined;
    try {
      creation = controlPlane.addRepo(
        workspaceId,
        secondRepoKey,
        secondRepoKey,
        'https://gitlab.example/owner/concurrent-ambiguous.git',
      );
      await waitForAdvisoryWaiters(prisma, 1);

      resolution = service.resolveRepository(workspaceId, { repositoryKey: 'owner/concurrent-ambiguous' });
      await waitForAdvisoryWaiters(prisma, 2);
    } finally {
      blocker.release();
      await blocker.finished;
    }

    await creation;
    await expect(resolution).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.workspaceRepo.findMany({
        where: { workspaceId, repoKey: { in: [firstRepoKey, secondRepoKey] } },
        orderBy: { repoKey: 'asc' },
        select: { captureRepositoryKey: true },
      }),
    ).resolves.toEqual([{ captureRepositoryKey: null }, { captureRepositoryKey: null }]);
  });

  it('persists all provisioning timestamp transitions through PostgreSQL', async () => {
    const report = {
      schemaVersion: 1 as const,
      host: 'codex' as const,
      target: {
        kind: 'repository' as const,
        repoKey: `graph-${RUN}`,
        repositoryKey: 'coredoc/coredoc-parser',
        profileName: null,
      },
      state: 'configured' as const,
      pendingCount: 0,
      errorCode: null,
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
    };

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime('2026-08-17T08:00:00.000Z');
      const configured = await service.reportProvisioning(workspaceId, ACTOR.id, report);
      expect(configured).toMatchObject({
        state: 'configured',
        configuredAt: '2026-08-17T08:00:00.000Z',
        disabledAt: null,
        reportedAt: '2026-08-17T08:00:00.000Z',
      });

      vi.setSystemTime('2026-08-17T08:01:00.000Z');
      const configuredRefresh = await service.reportProvisioning(workspaceId, ACTOR.id, {
        ...report,
        pendingCount: 2,
        errorCode: 'OUTBOX_PENDING',
      });
      expect(configuredRefresh).toMatchObject({
        state: 'configured',
        pendingCount: 2,
        errorCode: 'OUTBOX_PENDING',
        configuredAt: configured.configuredAt,
        disabledAt: null,
        reportedAt: '2026-08-17T08:01:00.000Z',
      });

      vi.setSystemTime('2026-08-17T08:02:00.000Z');
      const disabled = await service.reportProvisioning(workspaceId, ACTOR.id, {
        ...report,
        state: 'disabled',
      });
      expect(disabled).toMatchObject({
        state: 'disabled',
        configuredAt: configured.configuredAt,
        disabledAt: '2026-08-17T08:02:00.000Z',
        reportedAt: '2026-08-17T08:02:00.000Z',
      });

      vi.setSystemTime('2026-08-17T08:03:00.000Z');
      const disabledRefresh = await service.reportProvisioning(workspaceId, ACTOR.id, {
        ...report,
        state: 'disabled',
      });
      expect(disabledRefresh).toMatchObject({
        state: 'disabled',
        configuredAt: configured.configuredAt,
        disabledAt: disabled.disabledAt,
        reportedAt: '2026-08-17T08:03:00.000Z',
      });

      vi.setSystemTime('2026-08-17T08:04:00.000Z');
      const reconfigured = await service.reportProvisioning(workspaceId, ACTOR.id, report);
      expect(reconfigured).toMatchObject({
        state: 'configured',
        configuredAt: '2026-08-17T08:04:00.000Z',
        disabledAt: null,
        reportedAt: '2026-08-17T08:04:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves receipt order, idempotency, order-independent projection, and rollback', async () => {
    const firstRunId = 'cdr-20260816-a1b2c3';
    const secondRunId = 'cdr-20260816-d4e5f6';
    const firstStart = started('11111111-1111-4111-8111-111111111111', firstRunId, `${RUN}-one`);
    const firstFinish = finished('22222222-2222-4222-8222-222222222222', firstRunId, `${RUN}-one`);
    const secondStart = started('33333333-3333-4333-8333-333333333333', secondRunId, `${RUN}-two`);
    const secondFinish = finished('44444444-4444-4444-8444-444444444444', secondRunId, `${RUN}-two`);

    await expect(service.ingest(workspaceId, ACTOR, { events: [firstStart, firstFinish] })).resolves.toEqual({
      acceptedEventIds: [firstStart.eventId, firstFinish.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    await expect(service.ingest(workspaceId, ACTOR, { events: [secondFinish, secondStart] })).resolves.toEqual({
      acceptedEventIds: [secondFinish.eventId, secondStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    await expect(service.ingest(workspaceId, ACTOR, { events: [firstStart] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [firstStart.eventId],
      rejected: [],
    });

    const projected = await prisma.workflowRun.findMany({
      where: { workspaceId },
      orderBy: { runId: 'asc' },
      select: {
        workflowId: true,
        intent: true,
        risk: true,
        scale: true,
        repositoryKey: true,
        taskId: true,
        startedAt: true,
        finishedAt: true,
        outcome: true,
        counters: true,
      },
    });
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual(projected[1]);
    expect(await prisma.captureEvent.count({ where: { workspaceId } })).toBe(4);

    const contradiction = {
      ...firstStart,
      eventId: '55555555-5555-4555-8555-555555555555',
      data: { ...firstStart.data, workflowId: 'review:normal' },
    };
    await expect(service.ingest(workspaceId, ACTOR, { events: [contradiction] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: contradiction.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(
      await prisma.captureEvent.count({
        where: { workspaceId, eventId: contradiction.eventId },
      }),
    ).toBe(0);
    expect(
      await prisma.workflowRun.findUnique({
        where: { workspaceId_runId: { workspaceId, runId: firstRunId } },
        select: { workflowId: true },
      }),
    ).toEqual({ workflowId: firstStart.data.workflowId });
  });

  it('links a routed run to an existing connector task without inventing task repository ownership', async () => {
    const runId = 'cdr-20260817-a1b2d4';
    const sessionId = `${RUN}-connector-task-link`;
    const taskId = `cdt_${randomUUID()}`;
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'jira',
        displayName: `${RUN}-task-link`,
      },
    });
    await prisma.deliveryTask.create({
      data: {
        workspaceId,
        id: taskId,
        repositoryKey: null,
        lifecycle: 'active',
        authority: 'connector:jira',
        createdBy: 'capture-postgres-test',
      },
    });
    const ref = await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId: taskId,
        provider: 'jira',
        externalId: `${RUN}-task-link-issue`,
        externalKey: 'CAP-42',
        connectorId: connector.id,
      },
    });
    await prisma.deliveryTask.update({
      where: { workspaceId_id: { workspaceId, id: taskId } },
      data: { authorityRefId: ref.id },
    });
    const runStart = startedV2(randomUUID(), runId, sessionId, taskId);

    await expect(service.ingest(workspaceId, ACTOR, { events: [runStart] })).resolves.toEqual({
      acceptedEventIds: [runStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });

    await expect(
      prisma.workflowRun.findUniqueOrThrow({
        where: { workspaceId_runId: { workspaceId, runId } },
      }),
    ).resolves.toMatchObject({
      taskId,
      deliveryTaskId: taskId,
      repositoryKey: 'coredoc/coredoc-parser',
    });
    await expect(
      prisma.deliveryTask.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: taskId } },
      }),
    ).resolves.toMatchObject({
      repositoryKey: null,
      authority: 'connector:jira',
      authorityRefId: ref.id,
    });
  });

  it('persists an immutable V3 identity set with receipt precedence and no canonical side effects', async () => {
    const runId = 'cdr-20260817-a1b2d5';
    const sessionId = `${RUN}-v3-projection`;
    const start = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
      { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
    ]);
    const canonicalCountsBefore = await Promise.all([
      prisma.deliveryTask.count({ where: { workspaceId } }),
      prisma.taskExternalRef.count({ where: { workspaceId } }),
      prisma.taskExternalRefStateFact.count({ where: { workspaceId } }),
      prisma.deliveryReworkSignal.count({ where: { workspaceId } }),
      prisma.deliveryShipEvidence.count({ where: { workspaceId } }),
    ]);

    await expect(service.ingest(workspaceId, ACTOR, { events: [start] })).resolves.toEqual({
      acceptedEventIds: [start.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    await expect(
      service.ingest(workspaceId, ACTOR, { events: [{ ...start, prompt: 'private replay bytes' }] }),
    ).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [start.eventId],
      rejected: [],
    });

    const equal = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' },
      { provider: 'linear', externalId: 'LIN-42' },
    ]);
    const different = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'jira', externalId: '99999', externalKey: 'OTHER-1' },
    ]);
    await expect(service.ingest(workspaceId, ACTOR, { events: [equal, different] })).resolves.toEqual({
      acceptedEventIds: [equal.eventId],
      duplicateEventIds: [],
      rejected: [{ eventId: different.eventId, code: 'CONTRADICTING_FACT' }],
    });
    const firstOccurrenceId = randomUUID();
    const secondOccurrenceId = randomUUID();
    const firstStageStart = stageStartedV2(
      randomUUID(),
      runId,
      sessionId,
      firstOccurrenceId,
      1,
      '2026-08-17T10:01:00.000Z',
    );
    const firstStageFinish = stageFinishedV2(
      randomUUID(),
      runId,
      sessionId,
      firstOccurrenceId,
      1,
      '2026-08-17T10:02:00.000Z',
    );
    const secondStageStart = stageStartedV2(
      randomUUID(),
      runId,
      sessionId,
      secondOccurrenceId,
      2,
      '2026-08-17T10:03:00.000Z',
    );
    await service.ingest(workspaceId, ACTOR, {
      events: [firstStageStart, firstStageFinish, secondStageStart],
    });

    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { workspaceId_runId: { workspaceId, runId } },
      include: { workItems: { orderBy: [{ provider: 'asc' }, { externalId: 'asc' }] } },
    });
    expect(run).toMatchObject({ deliveryTaskId: null, taskId: null, declaredStages: start.data.stages });
    expect(
      run.workItems.map(({ provider, externalId, externalKey }) => ({ provider, externalId, externalKey })),
    ).toEqual([
      { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
      { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
    ]);
    expect(await prisma.captureEvent.count({ where: { workspaceId, eventId: different.eventId } })).toBe(0);
    expect(
      await Promise.all([
        prisma.deliveryTask.count({ where: { workspaceId } }),
        prisma.taskExternalRef.count({ where: { workspaceId } }),
        prisma.taskExternalRefStateFact.count({ where: { workspaceId } }),
        prisma.deliveryReworkSignal.count({ where: { workspaceId } }),
        prisma.deliveryShipEvidence.count({ where: { workspaceId } }),
      ]),
    ).toEqual(canonicalCountsBefore);
  });

  it('rejects sequential V2 task attribution and V3 work items in both arrival orders', async () => {
    const v2FirstRunId = 'cdr-20260817-a1b2d6';
    const v3FirstRunId = 'cdr-20260817-a1b2d7';
    const v2FirstTaskId = `cdt_${randomUUID()}`;
    const v3FirstTaskId = `cdt_${randomUUID()}`;
    const v2First = startedV2(randomUUID(), v2FirstRunId, `${RUN}-v2-first`, v2FirstTaskId);
    const v3After = startedV3(randomUUID(), v2FirstRunId, `${RUN}-v2-first`, [
      { provider: 'jira', externalId: 'seq-v3-after' },
    ]);
    const v3First = startedV3(randomUUID(), v3FirstRunId, `${RUN}-v3-first`, [
      { provider: 'jira', externalId: 'seq-v3-first' },
    ]);
    const v2After = startedV2(randomUUID(), v3FirstRunId, `${RUN}-v3-first`, v3FirstTaskId);

    await service.ingest(workspaceId, ACTOR, { events: [v2First] });
    await expect(service.ingest(workspaceId, ACTOR, { events: [v3After] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: v3After.eventId, code: 'CONTRADICTING_FACT' }],
    });
    await service.ingest(workspaceId, ACTOR, { events: [v3First] });
    await expect(service.ingest(workspaceId, ACTOR, { events: [v2After] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: v2After.eventId, code: 'CONTRADICTING_FACT' }],
    });

    await expect(
      prisma.workflowRun.findUniqueOrThrow({ where: { workspaceId_runId: { workspaceId, runId: v2FirstRunId } } }),
    ).resolves.toMatchObject({ deliveryTaskId: v2FirstTaskId });
    expect(
      await prisma.workflowRunWorkItem.count({
        where: { workflowRun: { workspaceId, runId: v2FirstRunId } },
      }),
    ).toBe(0);
    await expect(
      prisma.workflowRun.findUniqueOrThrow({ where: { workspaceId_runId: { workspaceId, runId: v3FirstRunId } } }),
    ).resolves.toMatchObject({ deliveryTaskId: null });
    expect(
      await prisma.workflowRunWorkItem.count({
        where: { workflowRun: { workspaceId, runId: v3FirstRunId } },
      }),
    ).toBe(1);
    expect(await prisma.deliveryTask.count({ where: { workspaceId, id: v3FirstTaskId } })).toBe(0);
  });

  it('persists scoped monotonic watermarks from server receipt time only for accepted events', async () => {
    const watermarkActor = { id: `${RUN}-watermark-actor`, email: `${RUN}-watermark@example.com` };
    const repositoryKey = 'coredoc/coredoc-parser';
    const runId = 'cdr-20260817-aa0001';
    const sessionId = `${RUN}-watermark-claude`;
    const capability = capabilityUsed(randomUUID(), sessionId, {
      occurredAt: '2001-01-01T00:00:00.000Z',
      repositoryKey,
    });
    const runStart = started(randomUUID(), runId, sessionId);
    const laterCapability = capabilityUsed(randomUUID(), sessionId, {
      occurredAt: '1999-01-01T00:00:00.000Z',
      repositoryKey,
    });

    await expect(
      service.ingest(workspaceId, watermarkActor, { events: [capability, runStart, laterCapability] }),
    ).resolves.toEqual({
      acceptedEventIds: [capability.eventId, runStart.eventId, laterCapability.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    const acceptedEvents = await prisma.captureEvent.findMany({
      where: { workspaceId, eventId: { in: [capability.eventId, runStart.eventId, laterCapability.eventId] } },
      select: { eventId: true, receivedAt: true },
    });
    const receivedById = new Map(acceptedEvents.map((event) => [event.eventId, event.receivedAt]));
    const receivedTimes = acceptedEvents.map((event) => event.receivedAt.getTime());
    const watermarkWhere = {
      workspaceId_actorId_host_scopeKey: {
        workspaceId,
        actorId: watermarkActor.id,
        host: 'claude-code',
        scopeKey: `repo:${repositoryKey}`,
      },
    };
    const claudeWatermark = await prisma.captureAcceptedWatermark.findUniqueOrThrow({ where: watermarkWhere });
    expect(claudeWatermark).toEqual({
      workspaceId,
      actorId: watermarkActor.id,
      host: 'claude-code',
      scopeKey: `repo:${repositoryKey}`,
      repositoryKey,
      firstAcceptedAt: new Date(Math.min(...receivedTimes)),
      lastAcceptedAt: new Date(Math.max(...receivedTimes)),
      workflowLastAcceptedAt: receivedById.get(runStart.eventId),
    });

    await expect(service.ingest(workspaceId, watermarkActor, { events: [laterCapability] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [laterCapability.eventId],
      rejected: [],
    });
    const contradiction = {
      ...runStart,
      eventId: randomUUID(),
      data: { ...runStart.data, workflowId: 'review:normal' },
    };
    await expect(service.ingest(workspaceId, watermarkActor, { events: [contradiction] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: contradiction.eventId, code: 'CONTRADICTING_FACT' }],
    });
    const unattributed = capabilityUsed(randomUUID(), `${RUN}-watermark-unattributed`);
    await expect(service.ingest(workspaceId, watermarkActor, { events: [unattributed] })).resolves.toEqual({
      acceptedEventIds: [unattributed.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(await prisma.captureAcceptedWatermark.findUniqueOrThrow({ where: watermarkWhere })).toEqual(claudeWatermark);
    expect(
      await prisma.captureAcceptedWatermark.count({
        where: { workspaceId, actorId: watermarkActor.id, host: 'claude-code' },
      }),
    ).toBe(1);
    expect(await prisma.captureEvent.count({ where: { workspaceId, eventId: contradiction.eventId } })).toBe(0);

    const codexSessionId = `${RUN}-watermark-codex`;
    const codexCapability = capabilityUsed(randomUUID(), codexSessionId, {
      host: 'codex',
      repositoryKey,
    });
    const codexStage = {
      ...stageStartedV2(
        randomUUID(),
        'cdr-20260817-aa0002',
        codexSessionId,
        randomUUID(),
        1,
        '2026-08-17T11:00:00.000Z',
      ),
      host: 'codex',
    };
    await expect(
      service.ingest(workspaceId, watermarkActor, { events: [codexCapability, codexStage] }),
    ).resolves.toEqual({
      acceptedEventIds: [codexCapability.eventId, codexStage.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    const codexEvents = await prisma.captureEvent.findMany({
      where: { workspaceId, eventId: { in: [codexCapability.eventId, codexStage.eventId] } },
      select: { eventId: true, receivedAt: true },
    });
    const codexReceivedById = new Map(codexEvents.map((event) => [event.eventId, event.receivedAt]));
    const codexReceivedTimes = codexEvents.map((event) => event.receivedAt.getTime());
    expect(
      await prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId: watermarkActor.id,
            host: 'codex',
            scopeKey: `repo:${repositoryKey}`,
          },
        },
      }),
    ).toEqual({
      workspaceId,
      actorId: watermarkActor.id,
      host: 'codex',
      scopeKey: `repo:${repositoryKey}`,
      repositoryKey,
      firstAcceptedAt: new Date(Math.min(...codexReceivedTimes)),
      lastAcceptedAt: new Date(Math.max(...codexReceivedTimes)),
      workflowLastAcceptedAt: codexReceivedById.get(codexStage.eventId),
    });
  });

  it('converges concurrent watermark first writes without a unique-violation receipt failure', async () => {
    const watermarkActor = { id: `${RUN}-watermark-race-actor`, email: `${RUN}-race@example.com` };
    const firstSessionId = `${RUN}-watermark-race-first`;
    const secondSessionId = `${RUN}-watermark-race-second`;
    const firstSeed = capabilityUsed(randomUUID(), firstSessionId);
    const secondSeed = capabilityUsed(randomUUID(), secondSessionId);
    await service.ingest(workspaceId, watermarkActor, { events: [firstSeed, secondSeed] });

    const firstEvent = capabilityUsed(randomUUID(), firstSessionId, {
      repositoryKey: 'coredoc/coredoc-parser',
    });
    const secondEvent = capabilityUsed(randomUUID(), secondSessionId, {
      repositoryKey: 'coredoc/coredoc-parser',
    });
    const racingSessionIds = new Set([firstSessionId, secondSessionId]);
    const barrier = twoPartyBarrier();
    const racingPrisma = prisma.$extends({
      query: {
        agentSession: {
          async upsert({ args, query }) {
            if (racingSessionIds.has(args.where.workspaceId_provider_sessionId.sessionId)) {
              await barrier.wait();
            }
            return query(args);
          },
        },
      },
    });
    const racingService = new CaptureService(racingPrisma as unknown as PrismaService);

    const [firstReceipt, secondReceipt] = await Promise.all([
      racingService.ingest(workspaceId, watermarkActor, { events: [firstEvent] }),
      racingService.ingest(workspaceId, watermarkActor, { events: [secondEvent] }),
    ]);
    expect(firstReceipt).toEqual({
      acceptedEventIds: [firstEvent.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(secondReceipt).toEqual({
      acceptedEventIds: [secondEvent.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(barrier.arrivals()).toBe(2);
    const events = await prisma.captureEvent.findMany({
      where: { workspaceId, eventId: { in: [firstEvent.eventId, secondEvent.eventId] } },
      select: { receivedAt: true },
    });
    const receivedTimes = events.map((event) => event.receivedAt.getTime());
    expect(
      await prisma.captureAcceptedWatermark.findUniqueOrThrow({
        where: {
          workspaceId_actorId_host_scopeKey: {
            workspaceId,
            actorId: watermarkActor.id,
            host: 'claude-code',
            scopeKey: 'repo:coredoc/coredoc-parser',
          },
        },
      }),
    ).toEqual({
      workspaceId,
      actorId: watermarkActor.id,
      host: 'claude-code',
      scopeKey: 'repo:coredoc/coredoc-parser',
      repositoryKey: 'coredoc/coredoc-parser',
      firstAcceptedAt: new Date(Math.min(...receivedTimes)),
      lastAcceptedAt: new Date(Math.max(...receivedTimes)),
      workflowLastAcceptedAt: null,
    });
  });

  it('converges concurrent stage start and finish first writes without a false contradiction', async () => {
    const runId = 'cdr-20260817-e8a001';
    const sessionId = `${RUN}-ext8-stage`;
    const taskId = `cdt_${randomUUID()}`;
    const occurrenceId = randomUUID();
    const runStart = startedV2(randomUUID(), runId, sessionId, taskId);
    const stageStart = stageStartedV2(randomUUID(), runId, sessionId, occurrenceId, 1, '2026-08-17T10:01:00.000Z');
    const stageFinish = stageFinishedV2(randomUUID(), runId, sessionId, occurrenceId, 1, '2026-08-17T10:02:00.000Z');
    await service.ingest(workspaceId, ACTOR, { events: [runStart] });

    const barrier = twoPartyBarrier();
    const racingPrisma = prisma.$extends({
      query: {
        workflowStageOccurrence: {
          async upsert({ args, query }) {
            await barrier.wait();
            return query(args);
          },
          async create({ args, query }) {
            await barrier.wait();
            return query(args);
          },
        },
      },
    });
    const racingService = new CaptureService(racingPrisma as unknown as PrismaService);

    const [startedReceipt, finishedReceipt] = await Promise.all([
      racingService.ingest(workspaceId, ACTOR, { events: [stageStart] }),
      racingService.ingest(workspaceId, ACTOR, { events: [stageFinish] }),
    ]);

    expect(startedReceipt).toEqual({
      acceptedEventIds: [stageStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(finishedReceipt).toEqual({
      acceptedEventIds: [stageFinish.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(barrier.arrivals()).toBe(2);
    const occurrences = await prisma.workflowStageOccurrence.findMany({
      where: { workflowRun: { workspaceId, runId } },
    });
    expect(occurrences).toEqual([
      expect.objectContaining({
        id: occurrenceId,
        stageId: 'implement',
        attempt: 1,
        startedAt: new Date(stageStart.occurredAt),
        finishedAt: new Date(stageFinish.occurredAt),
        outcome: 'success',
      }),
    ]);
    expect(
      await prisma.captureEvent.count({
        where: { workspaceId, eventId: { in: [stageStart.eventId, stageFinish.eventId] } },
      }),
    ).toBe(2);

    const conflictingOccurrence = stageStartedV2(
      randomUUID(),
      runId,
      sessionId,
      randomUUID(),
      1,
      stageStart.occurredAt,
    );
    await expect(service.ingest(workspaceId, ACTOR, { events: [conflictingOccurrence] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: conflictingOccurrence.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(
      await prisma.workflowStageOccurrence.findMany({
        where: { workflowRun: { workspaceId, runId } },
      }),
    ).toEqual(occurrences);
  });

  it('serializes concurrent disjoint V3 starts on a skeleton run without unioning their sets', async () => {
    const runId = 'cdr-20260817-e8a002';
    const sessionId = `${RUN}-v3-set-race`;
    const skeleton = stageStartedV2(randomUUID(), runId, sessionId, randomUUID(), 1, '2026-08-17T10:01:00.000Z');
    await service.ingest(workspaceId, ACTOR, { events: [skeleton] });

    const first = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'jira', externalId: 'race-set-a', externalKey: 'A-1' },
    ]);
    const second = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'linear', externalId: 'race-set-b', externalKey: 'B-1' },
    ]);
    const barrier = twoPartyBarrier();
    const racingPrisma = prisma.$extends({
      query: {
        workflowRun: {
          async upsert({ args, query }) {
            if (args.where.workspaceId_runId?.runId === runId) await barrier.wait();
            return query(args);
          },
        },
      },
    });
    const racingService = new CaptureService(racingPrisma as unknown as PrismaService);

    const receipts = await Promise.all([
      racingService.ingest(workspaceId, ACTOR, { events: [first] }),
      racingService.ingest(workspaceId, ACTOR, { events: [second] }),
    ]);
    expect(barrier.arrivals()).toBe(2);
    expect(receipts.flatMap((receipt) => receipt.acceptedEventIds)).toHaveLength(1);
    expect(receipts.flatMap((receipt) => receipt.rejected)).toEqual([
      expect.objectContaining({ code: 'CONTRADICTING_FACT' }),
    ]);
    const stored = await prisma.workflowRunWorkItem.findMany({
      where: { workflowRun: { workspaceId, runId } },
      select: { provider: true, externalId: true, externalKey: true },
    });
    expect(stored).toHaveLength(1);
    expect([
      [{ provider: 'jira', externalId: 'race-set-a', externalKey: 'A-1' }],
      [{ provider: 'linear', externalId: 'race-set-b', externalKey: 'B-1' }],
    ]).toContainEqual(stored);
  });

  it('serializes a concurrent V2-task versus V3-set race into exactly one attribution mode', async () => {
    const runId = 'cdr-20260817-e8a003';
    const sessionId = `${RUN}-v2-v3-race`;
    const taskId = `cdt_${randomUUID()}`;
    const skeleton = stageStartedV2(randomUUID(), runId, sessionId, randomUUID(), 1, '2026-08-17T10:01:00.000Z');
    await service.ingest(workspaceId, ACTOR, { events: [skeleton] });

    const v2 = startedV2(randomUUID(), runId, sessionId, taskId);
    const v3 = startedV3(randomUUID(), runId, sessionId, [
      { provider: 'jira', externalId: 'race-mode-v3', externalKey: 'MODE-3' },
    ]);
    const barrier = twoPartyBarrier();
    const racingPrisma = prisma.$extends({
      query: {
        workflowRun: {
          async upsert({ args, query }) {
            if (args.where.workspaceId_runId?.runId === runId) await barrier.wait();
            return query(args);
          },
        },
      },
    });
    const racingService = new CaptureService(racingPrisma as unknown as PrismaService);

    const receipts = await Promise.all([
      racingService.ingest(workspaceId, ACTOR, { events: [v2] }),
      racingService.ingest(workspaceId, ACTOR, { events: [v3] }),
    ]);
    expect(barrier.arrivals()).toBe(2);
    expect(receipts.flatMap((receipt) => receipt.acceptedEventIds)).toHaveLength(1);
    expect(receipts.flatMap((receipt) => receipt.rejected)).toEqual([
      expect.objectContaining({ code: 'CONTRADICTING_FACT' }),
    ]);

    const [run, workItems, taskCount] = await Promise.all([
      prisma.workflowRun.findUniqueOrThrow({ where: { workspaceId_runId: { workspaceId, runId } } }),
      prisma.workflowRunWorkItem.findMany({ where: { workflowRun: { workspaceId, runId } } }),
      prisma.deliveryTask.count({ where: { workspaceId, id: taskId } }),
    ]);
    const v2Won = run.deliveryTaskId === taskId;
    expect(v2Won ? workItems.length : taskCount).toBe(0);
    expect(v2Won ? taskCount : workItems.length).toBe(1);
  });

  it('returns complete receipts for concurrent batches first-touching one session, run, and task', async () => {
    const runId = 'cdr-20260817-e8b002';
    const sharedSessionId = `${RUN}-ext8-shared`;
    const firstSessionId = `${RUN}-ext8-first`;
    const secondSessionId = `${RUN}-ext8-second`;
    const taskId = `cdt_${randomUUID()}`;
    const firstCapability = capabilityUsed(randomUUID(), firstSessionId);
    const secondCapability = capabilityUsed(randomUUID(), secondSessionId);
    const firstRunStart = startedV2(randomUUID(), runId, sharedSessionId, taskId);
    const secondRunStart = startedV2(randomUUID(), runId, sharedSessionId, taskId);
    const barrier = twoPartyBarrier();
    const racingPrisma = prisma.$extends({
      query: {
        agentSession: {
          async upsert({ args, query }) {
            if (args.where.workspaceId_provider_sessionId.sessionId === sharedSessionId) {
              await barrier.wait();
            }
            return query(args);
          },
        },
      },
    });
    const racingService = new CaptureService(racingPrisma as unknown as PrismaService);

    const [firstReceipt, secondReceipt] = await Promise.all([
      racingService.ingest(workspaceId, ACTOR, { events: [firstCapability, firstRunStart] }),
      racingService.ingest(workspaceId, ACTOR, { events: [secondCapability, secondRunStart] }),
    ]);

    expect(firstReceipt).toEqual({
      acceptedEventIds: [firstCapability.eventId, firstRunStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(secondReceipt).toEqual({
      acceptedEventIds: [secondCapability.eventId, secondRunStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(barrier.arrivals()).toBe(2);
    expect(
      await prisma.captureEvent.count({
        where: {
          workspaceId,
          eventId: {
            in: [firstCapability.eventId, firstRunStart.eventId, secondCapability.eventId, secondRunStart.eventId],
          },
        },
      }),
    ).toBe(4);
    const sharedSessions = await prisma.agentSession.findMany({
      where: { workspaceId, provider: 'claude-code', sessionId: sharedSessionId },
    });
    expect(sharedSessions).toHaveLength(1);
    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { workspaceId_runId: { workspaceId, runId } },
    });
    expect(run).toMatchObject({ agentSessionId: sharedSessions[0]?.id, deliveryTaskId: taskId });
    await expect(
      prisma.deliveryTask.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: taskId } } }),
    ).resolves.toMatchObject({ lifecycle: 'active', authority: 'coredoc' });
  });

  it('records the attempt-two occurrence with no rework signal and never treats workflow success as ship evidence', async () => {
    const runId = 'cdr-20260817-c5a001';
    const sessionId = `${RUN}-c5-stage`;
    const taskId = `cdt_${randomUUID()}`;
    const firstOccurrenceId = randomUUID();
    const secondOccurrenceId = randomUUID();
    const runStart = startedV2(randomUUID(), runId, sessionId, taskId);
    const firstStart = stageStartedV2(randomUUID(), runId, sessionId, firstOccurrenceId, 1, '2026-08-17T10:01:00.000Z');
    const firstFinish = stageFinishedV2(
      randomUUID(),
      runId,
      sessionId,
      firstOccurrenceId,
      1,
      '2026-08-17T10:02:00.000Z',
    );
    const secondStart = stageStartedV2(
      randomUUID(),
      runId,
      sessionId,
      secondOccurrenceId,
      2,
      '2026-08-17T10:03:00.000Z',
    );
    const secondFinish = stageFinishedV2(
      randomUUID(),
      runId,
      sessionId,
      secondOccurrenceId,
      2,
      '2026-08-17T10:04:00.000Z',
    );
    const runFinish = finishedV2(randomUUID(), runId, sessionId);

    await expect(
      service.ingest(workspaceId, ACTOR, {
        events: [runStart, firstStart, firstFinish],
      }),
    ).resolves.toEqual({
      acceptedEventIds: [runStart.eventId, firstStart.eventId, firstFinish.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(
      await prisma.deliveryReworkSignal.count({
        where: { workspaceId, deliveryTaskId: taskId },
      }),
    ).toBe(0);

    await expect(
      service.ingest(workspaceId, ACTOR, {
        events: [secondStart, secondFinish, runFinish],
      }),
    ).resolves.toEqual({
      acceptedEventIds: [secondStart.eventId, secondFinish.eventId, runFinish.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    await expect(service.ingest(workspaceId, ACTOR, { events: [secondStart] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [secondStart.eventId],
      rejected: [],
    });
    const occurrenceReplay = { ...secondStart, eventId: randomUUID() };
    await expect(service.ingest(workspaceId, ACTOR, { events: [occurrenceReplay] })).resolves.toEqual({
      acceptedEventIds: [occurrenceReplay.eventId],
      duplicateEventIds: [],
      rejected: [],
    });

    const [run, task, occurrences, signals, shipEvidence] = await Promise.all([
      prisma.workflowRun.findUniqueOrThrow({ where: { workspaceId_runId: { workspaceId, runId } } }),
      prisma.deliveryTask.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: taskId } } }),
      prisma.workflowStageOccurrence.findMany({
        where: { workflowRun: { workspaceId, runId } },
        orderBy: { attempt: 'asc' },
      }),
      prisma.deliveryReworkSignal.findMany({ where: { workspaceId, deliveryTaskId: taskId } }),
      prisma.deliveryShipEvidence.findMany({ where: { workspaceId, deliveryTaskId: taskId } }),
    ]);
    expect(run).toMatchObject({ deliveryTaskId: taskId, outcome: 'success' });
    expect(task).toMatchObject({ lifecycle: 'active' });
    expect(occurrences.map(({ id, attempt }) => ({ id, attempt }))).toEqual([
      { id: firstOccurrenceId, attempt: 1 },
      { id: secondOccurrenceId, attempt: 2 },
    ]);
    // A stage re-entry is an iteration fact, not rework: capture records the occurrences and
    // writes no signal at all.
    expect(signals).toHaveLength(0);
    expect(shipEvidence).toHaveLength(0);
  });

  it('writes no rework signal when the exact task binding arrives after the re-entry occurrences', async () => {
    const runId = 'cdr-20260817-c5b002';
    const sessionId = `${RUN}-c5-late-run-start`;
    const taskId = `cdt_${randomUUID()}`;
    const firstOccurrenceId = randomUUID();
    const secondOccurrenceId = randomUUID();
    const firstStart = stageStartedV2(randomUUID(), runId, sessionId, firstOccurrenceId, 1, '2026-08-17T11:01:00.000Z');
    const firstFinish = stageFinishedV2(
      randomUUID(),
      runId,
      sessionId,
      firstOccurrenceId,
      1,
      '2026-08-17T11:02:00.000Z',
    );
    const secondStart = stageStartedV2(
      randomUUID(),
      runId,
      sessionId,
      secondOccurrenceId,
      2,
      '2026-08-17T11:03:00.000Z',
    );

    await expect(
      service.ingest(workspaceId, ACTOR, { events: [firstStart, firstFinish, secondStart] }),
    ).resolves.toEqual({
      acceptedEventIds: [firstStart.eventId, firstFinish.eventId, secondStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(await prisma.deliveryReworkSignal.count({ where: { workspaceId, sourceRef: secondOccurrenceId } })).toBe(0);

    const runStart = {
      ...startedV2(randomUUID(), runId, sessionId, taskId),
      occurredAt: '2026-08-17T11:00:00.000Z',
    };
    await expect(service.ingest(workspaceId, ACTOR, { events: [runStart] })).resolves.toEqual({
      acceptedEventIds: [runStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    const runStartReplay = { ...runStart, eventId: randomUUID() };
    await expect(service.ingest(workspaceId, ACTOR, { events: [runStartReplay] })).resolves.toEqual({
      acceptedEventIds: [runStartReplay.eventId],
      duplicateEventIds: [],
      rejected: [],
    });

    const signals = await prisma.deliveryReworkSignal.findMany({
      where: { workspaceId, deliveryTaskId: taskId },
    });
    expect(signals).toHaveLength(0);
  });
});
