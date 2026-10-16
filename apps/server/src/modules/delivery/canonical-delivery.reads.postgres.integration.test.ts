import '../../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { CaptureService } from '../capture/capture.service.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const TEST_DATABASE_URL = process.env.CANONICAL_DELIVERY_TEST_DATABASE_URL ?? '';
const RUN = `canonical-delivery-reads-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!TEST_DATABASE_URL)('CanonicalDeliveryService bounded reads (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let service: CanonicalDeliveryService;
  let capture: CaptureService;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    service = new CanonicalDeliveryService(prisma as unknown as PrismaService);
    capture = new CaptureService(prisma as unknown as PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.captureRetentionCheckpoint.deleteMany({ where: { id: 'capture_fine_events' } });
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  async function createTask(
    workspaceId: string,
    id: string,
    overrides: {
      repositoryKey?: string | null;
      lifecycle?: string;
      authority?: string;
      authorityRefId?: bigint | null;
      createdBy?: string;
      createdAt?: Date;
      updatedAt?: Date;
    } = {},
  ): Promise<string> {
    await prisma.deliveryTask.create({
      data: {
        workspaceId,
        id,
        repositoryKey: overrides.repositoryKey,
        lifecycle: overrides.lifecycle ?? 'active',
        authority: overrides.authority ?? 'coredoc',
        authorityRefId: overrides.authorityRefId,
        createdBy: overrides.createdBy ?? 'bounded-read-test',
        createdAt: overrides.createdAt,
        updatedAt: overrides.updatedAt,
      },
    });
    return id;
  }

  async function createConnector(workspaceId: string, provider: 'github' | 'jira', suffix: string): Promise<string> {
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider,
        providerVariant: `${RUN}-${suffix}`,
        displayName: `${RUN}-${suffix}`,
      },
      select: { id: true },
    });
    return connector.id;
  }

  async function createAgentSession(workspaceId: string, suffix: string, userId?: string): Promise<string> {
    const session = await prisma.agentSession.create({
      data: {
        workspaceId,
        provider: 'claude-code',
        sessionId: `${RUN}-${suffix}`,
        userId,
      },
      select: { id: true },
    });
    return session.id;
  }

  function requiredCursor(cursor: string | null): string {
    expect(cursor).toEqual(expect.any(String));
    if (cursor === null) throw new Error('Expected another bounded-read page');
    return cursor;
  }

  it('accepts the review rework kinds and counts only the kinds the rework filter counts', async () => {
    const workspaceId = await createWorkspace('review-rework-kinds');
    const updatedAt = new Date();
    const reviewedId = 'cdt_00000000-0000-4000-8000-000000000301';
    const reenteredId = 'cdt_00000000-0000-4000-8000-000000000302';
    await createTask(workspaceId, reviewedId, { updatedAt });
    await createTask(workspaceId, reenteredId, { updatedAt });
    await prisma.deliveryReworkSignal.createMany({
      data: [
        // The two review kinds the GitHub projector emits: the widened CHECK constraint is what
        // makes these INSERTs possible at all.
        {
          workspaceId,
          deliveryTaskId: reviewedId,
          kind: 'review_changes_requested',
          sourceKey: `${RUN}:review-kinds:1`,
          sourceRef: 'https://github.com/acme/pull/7#pullrequestreview-1',
          occurredAt: updatedAt,
          observedAt: updatedAt,
        },
        {
          workspaceId,
          deliveryTaskId: reviewedId,
          kind: 'review_commented',
          sourceKey: `${RUN}:review-kinds:2`,
          sourceRef: 'https://github.com/acme/pull/7#pullrequestreview-2',
          occurredAt: updatedAt,
          observedAt: updatedAt,
        },
        // A stage re-entry is iteration, not rework (BR-9) — neither counted nor paged.
        {
          workspaceId,
          deliveryTaskId: reenteredId,
          kind: 'stage_reentry',
          sourceKey: `${RUN}:review-kinds:3`,
          sourceRef: 'stage:1',
          occurredAt: updatedAt,
          observedAt: updatedAt,
        },
      ],
    });

    const page = await service.listTaskSummaries(workspaceId, '10', undefined, '30', 'rework');
    expect(page.tasks.map((task) => task.id)).toEqual([reviewedId]);
    expect(page.tasks[0]?.counts.reworkSignals).toBe(2);

    const all = await service.listTaskSummaries(workspaceId, '10');
    expect(all.tasks.find((task) => task.id === reenteredId)?.counts.reworkSignals).toBe(0);
  });

  it('pages task-summary updatedAt ties newest-first without truncating the boundary row', async () => {
    const workspaceId = await createWorkspace('summary-tie');
    const tiedUpdatedAt = new Date('2026-08-17T16:00:00.000Z');
    const olderUpdatedAt = new Date('2026-08-17T15:00:00.000Z');
    const ids = [
      'cdt_00000000-0000-4000-8000-000000000001',
      'cdt_00000000-0000-4000-8000-000000000002',
      'cdt_00000000-0000-4000-8000-000000000003',
    ];
    await Promise.all([
      createTask(workspaceId, ids[0]!, {
        createdBy: 'summary-test',
        createdAt: olderUpdatedAt,
        updatedAt: olderUpdatedAt,
      }),
      createTask(workspaceId, ids[1]!, {
        createdBy: 'summary-test',
        createdAt: tiedUpdatedAt,
        updatedAt: tiedUpdatedAt,
      }),
      createTask(workspaceId, ids[2]!, {
        createdBy: 'summary-test',
        createdAt: tiedUpdatedAt,
        updatedAt: tiedUpdatedAt,
      }),
    ]);

    const first = await service.listTaskSummaries(workspaceId, '2');
    expect(first.tasks).toEqual(
      [ids[2], ids[1]].map((id) => ({
        id,
        repositoryKey: null,
        lifecycle: 'active',
        authority: { kind: 'coredoc' },
        title: null,
        createdBy: 'summary-test',
        createdAt: tiedUpdatedAt.toISOString(),
        updatedAt: tiedUpdatedAt.toISOString(),
        everShipped: false,
        lastShippedAt: null,
        shipState: 'none',
        counts: {
          externalRefs: 0,
          workflowRuns: 0,
          codeChanges: 0,
          mergedCodeChanges: 0,
          openCodeChanges: 0,
          shipEvidence: 0,
          reworkSignals: 0,
          artifacts: 0,
        },
      })),
    );

    const second = await service.listTaskSummaries(workspaceId, '2', requiredCursor(first.nextCursor));
    expect(second.tasks.map((task) => task.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('pages external references and equal-time state facts by their complete ascending keys', async () => {
    const workspaceId = await createWorkspace('refs');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000010');
    const githubConnectorId = await createConnector(workspaceId, 'github', 'refs-github');
    const jiraConnectorId = await createConnector(workspaceId, 'jira', 'refs-jira');
    const sourceUpdatedAt = new Date('2026-08-17T10:00:00.000Z');
    const lastObservedAt = new Date('2026-08-17T10:01:00.000Z');
    const githubRefA = await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId,
        provider: 'github',
        externalId: 'repo-a#1',
        externalKey: 'repo-a#1',
        externalUrl: 'https://github.example.test/repo-a/pull/1',
        externalState: 'open',
        connectorId: githubConnectorId,
        sourceUpdatedAt,
        lastObservedAt,
      },
    });
    const githubRefB = await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId,
        provider: 'github',
        externalId: 'repo-a#2',
        externalKey: null,
        externalUrl: null,
        externalState: null,
        connectorId: githubConnectorId,
        sourceUpdatedAt: null,
        lastObservedAt: null,
      },
    });
    const jiraRef = await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId,
        provider: 'jira',
        externalId: '10042',
        externalKey: 'CORE-42',
        externalUrl: 'https://jira.example.test/browse/CORE-42',
        externalState: 'In Progress',
        connectorId: jiraConnectorId,
        sourceUpdatedAt,
        lastObservedAt,
      },
    });
    await prisma.deliveryTask.update({
      where: { workspaceId_id: { workspaceId, id: deliveryTaskId } },
      data: { authority: 'connector:github', authorityRefId: githubRefA.id },
    });

    const occurredAt = new Date('2026-08-17T10:02:00.000Z');
    const firstFact = await prisma.taskExternalRefStateFact.create({
      data: {
        workspaceId,
        externalRefId: githubRefA.id,
        sourceRef: 'github:state:1',
        fromState: null,
        toState: 'open',
        occurredAt,
        sourceUpdatedAt,
        receivedAt: new Date('2026-08-17T10:02:01.000Z'),
        actorId: null,
      },
    });
    const secondFact = await prisma.taskExternalRefStateFact.create({
      data: {
        workspaceId,
        externalRefId: githubRefA.id,
        sourceRef: 'github:state:2',
        fromState: 'closed',
        toState: 'open',
        occurredAt,
        sourceUpdatedAt: new Date('2026-08-17T10:03:00.000Z'),
        receivedAt: new Date('2026-08-17T10:03:01.000Z'),
        actorId: null,
      },
    });

    const firstRefPage = await service.listTaskExternalRefs(workspaceId, deliveryTaskId, '2');
    expect(firstRefPage.items).toEqual([
      {
        id: githubRefA.id.toString(),
        provider: 'github',
        externalId: 'repo-a#1',
        externalKey: 'repo-a#1',
        externalUrl: 'https://github.example.test/repo-a/pull/1',
        externalState: 'open',
        connectorId: githubConnectorId,
        sourceUpdatedAt: sourceUpdatedAt.toISOString(),
        lastObservedAt: lastObservedAt.toISOString(),
        isAuthority: true,
        stateFactCount: 2,
      },
      {
        id: githubRefB.id.toString(),
        provider: 'github',
        externalId: 'repo-a#2',
        externalKey: null,
        externalUrl: null,
        externalState: null,
        connectorId: githubConnectorId,
        sourceUpdatedAt: null,
        lastObservedAt: null,
        isAuthority: false,
        stateFactCount: 0,
      },
    ]);
    const secondRefPage = await service.listTaskExternalRefs(
      workspaceId,
      deliveryTaskId,
      '2',
      requiredCursor(firstRefPage.nextCursor),
    );
    expect(secondRefPage).toEqual({
      items: [
        {
          id: jiraRef.id.toString(),
          provider: 'jira',
          externalId: '10042',
          externalKey: 'CORE-42',
          externalUrl: 'https://jira.example.test/browse/CORE-42',
          externalState: 'In Progress',
          connectorId: jiraConnectorId,
          sourceUpdatedAt: sourceUpdatedAt.toISOString(),
          lastObservedAt: lastObservedAt.toISOString(),
          isAuthority: false,
          stateFactCount: 0,
        },
      ],
      nextCursor: null,
    });

    const firstHistoryPage = await service.listExternalRefStateHistory(
      workspaceId,
      deliveryTaskId,
      githubRefA.id.toString(),
      '1',
    );
    expect(firstHistoryPage.items).toEqual([
      {
        id: firstFact.id.toString(),
        fromState: null,
        toState: 'open',
        sourceRef: 'github:state:1',
        occurredAt: occurredAt.toISOString(),
        sourceUpdatedAt: sourceUpdatedAt.toISOString(),
        receivedAt: '2026-08-17T10:02:01.000Z',
        actorId: null,
      },
    ]);
    const secondHistoryPage = await service.listExternalRefStateHistory(
      workspaceId,
      deliveryTaskId,
      githubRefA.id.toString(),
      '1',
      requiredCursor(firstHistoryPage.nextCursor),
    );
    expect(secondHistoryPage).toEqual({
      items: [
        {
          id: secondFact.id.toString(),
          fromState: 'closed',
          toState: 'open',
          sourceRef: 'github:state:2',
          occurredAt: occurredAt.toISOString(),
          sourceUpdatedAt: '2026-08-17T10:03:00.000Z',
          receivedAt: '2026-08-17T10:03:01.000Z',
          actorId: null,
        },
      ],
      nextCursor: null,
    });
  });

  it('pages createdAt-tied runs and stage tuples while preserving null and zero verification values', async () => {
    const workspaceId = await createWorkspace('runs');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000020');
    const agentSessionId = await createAgentSession(workspaceId, 'runs');
    const createdAt = new Date('2026-08-17T11:00:00.000Z');
    const runIds = ['cdr-20260817-a00001', 'cdr-20260817-a00002', 'cdr-20260817-a00003'];
    const persistedRunIds = [
      '00000000-0000-4000-8000-000000000021',
      '00000000-0000-4000-8000-000000000022',
      '00000000-0000-4000-8000-000000000023',
    ];
    await prisma.workflowRun.create({
      data: {
        id: persistedRunIds[0]!,
        workspaceId,
        runId: runIds[0]!,
        agentSessionId,
        actorId: 'actor-runs',
        deliveryTaskId,
        workflowId: null,
        intent: null,
        risk: null,
        scale: null,
        repositoryKey: null,
        startedAt: null,
        finishedAt: null,
        outcome: null,
        createdAt,
      },
    });
    await prisma.workflowRun.create({
      data: {
        id: persistedRunIds[1]!,
        workspaceId,
        runId: runIds[1]!,
        agentSessionId,
        actorId: 'actor-runs',
        deliveryTaskId,
        workflowId: 'change:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'normal',
        repositoryKey: 'coredoc/coredoc-parser',
        startedAt: new Date('2026-08-17T11:01:00.000Z'),
        finishedAt: new Date('2026-08-17T11:02:00.000Z'),
        outcome: 'success',
        counters: { verificationRuns: 0, verificationFailures: 0, editVerifyRounds: 0 },
        createdAt,
      },
    });
    await prisma.workflowRun.create({
      data: {
        id: persistedRunIds[2]!,
        workspaceId,
        runId: runIds[2]!,
        agentSessionId,
        actorId: 'actor-runs',
        deliveryTaskId,
        workflowId: 'change:high',
        intent: 'change',
        risk: 'high',
        scale: 'large',
        repositoryKey: 'coredoc/coredoc-parser',
        startedAt: createdAt,
        finishedAt: null,
        outcome: 'failed',
        counters: { verificationRuns: 2 },
        createdAt,
      },
    });

    const stageIds = [
      '00000000-0000-4000-8000-000000000024',
      '00000000-0000-4000-8000-000000000025',
      '00000000-0000-4000-8000-000000000026',
    ];
    await prisma.workflowStageOccurrence.createMany({
      data: [
        {
          id: stageIds[0]!,
          workflowRunId: persistedRunIds[1]!,
          stageId: 'build',
          attempt: 1,
          startedAt: createdAt,
          finishedAt: createdAt,
          outcome: 'success',
        },
        {
          id: stageIds[1]!,
          workflowRunId: persistedRunIds[1]!,
          stageId: 'build',
          attempt: 2,
          startedAt: createdAt,
          finishedAt: createdAt,
          outcome: 'failed',
        },
        {
          id: stageIds[2]!,
          workflowRunId: persistedRunIds[1]!,
          stageId: 'verify',
          attempt: 1,
          startedAt: null,
          finishedAt: null,
          outcome: null,
        },
      ],
    });

    const firstRunPage = await service.listTaskRuns(workspaceId, deliveryTaskId, '2');
    expect(firstRunPage.items).toEqual([
      {
        runId: runIds[0],
        workflowId: null,
        intent: null,
        risk: null,
        scale: null,
        repositoryKey: null,
        startedAt: null,
        finishedAt: null,
        outcome: null,
        verification: null,
        workItems: [],
      },
      {
        runId: runIds[1],
        workflowId: 'change:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'normal',
        repositoryKey: 'coredoc/coredoc-parser',
        startedAt: '2026-08-17T11:01:00.000Z',
        finishedAt: '2026-08-17T11:02:00.000Z',
        outcome: 'success',
        verification: { runs: 0, failures: 0, editVerifyRounds: 0 },
        workItems: [],
      },
    ]);
    const secondRunPage = await service.listTaskRuns(
      workspaceId,
      deliveryTaskId,
      '2',
      requiredCursor(firstRunPage.nextCursor),
    );
    expect(secondRunPage).toEqual({
      items: [
        {
          runId: runIds[2],
          workflowId: 'change:high',
          intent: 'change',
          risk: 'high',
          scale: 'large',
          repositoryKey: 'coredoc/coredoc-parser',
          startedAt: createdAt.toISOString(),
          finishedAt: null,
          outcome: 'failed',
          verification: { runs: 2, failures: null, editVerifyRounds: null },
          workItems: [],
        },
      ],
      nextCursor: null,
    });

    const firstStagePage = await service.listRunStageOccurrences(workspaceId, deliveryTaskId, runIds[1]!, '2');
    expect(firstStagePage.items.map((stage) => [stage.stageId, stage.attempt, stage.occurrenceId])).toEqual([
      ['build', 1, stageIds[0]],
      ['build', 2, stageIds[1]],
    ]);
    const secondStagePage = await service.listRunStageOccurrences(
      workspaceId,
      deliveryTaskId,
      runIds[1]!,
      '2',
      requiredCursor(firstStagePage.nextCursor),
    );
    expect(secondStagePage).toEqual({
      items: [
        {
          occurrenceId: stageIds[2],
          runId: runIds[1],
          stageId: 'verify',
          attempt: 1,
          startedAt: null,
          finishedAt: null,
          outcome: null,
        },
      ],
      nextCursor: null,
    });
  });

  it('derives one shared V3 run across exact refs, bounded reads, costs, stages, and ref moves', async () => {
    const workspaceId = await createWorkspace('v3-derived-reads');
    const repositoryKey = 'coredoc/coredoc-parser';
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: `${RUN}-v3-derived-reads`,
        repoName: `${RUN}-v3-derived-reads`,
        captureRepositoryKey: repositoryKey,
      },
    });
    const taskA = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000101', {
      repositoryKey,
    });
    const taskB = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000102', {
      repositoryKey,
    });
    const taskC = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000103', {
      repositoryKey,
    });
    const attach = (taskId: string, provider: string, externalId: string) =>
      service.attachExternalRef(workspaceId, taskId, {
        provider,
        externalId,
        connectorId: null,
        makeAuthority: false,
      });
    const [refA1, refA2, refB] = await Promise.all([
      attach(taskA, 'jira', 'read-a-1'),
      attach(taskA, 'jira', 'read-a-2'),
      attach(taskB, 'linear', 'read-b-1'),
    ]);

    const actor = { id: `${RUN}-v3-actor`, email: `${RUN}-v3@example.com` };
    const runIds = ['cdr-20260818-a20001', 'cdr-20260818-a20002', 'cdr-20260818-a20003'] as const;
    const sessionIds = [`${RUN}-v3-shared`, `${RUN}-v2-a`, `${RUN}-v2-b`] as const;
    const event = (
      schemaVersion: 2 | 3,
      eventId: string,
      runId: string,
      sessionId: string,
      data: Record<string, unknown>,
      taskId?: string,
    ) => ({
      schemaVersion,
      eventId,
      occurredAt: '2026-08-18T10:00:00.000Z',
      host: 'claude-code',
      sessionId,
      runId,
      repositoryKey,
      ...(taskId === undefined ? {} : { taskId }),
      type: 'workflow.run.started',
      data,
    });
    const stages = [{ stageId: 'implement', after: [] }];
    const sharedStart = event(3, randomUUID(), runIds[0], sessionIds[0], {
      workflowId: 'change:high',
      intent: 'change',
      risk: 'high',
      scale: 'large',
      stages,
      // Task A deliberately owns two exact refs. Every task-level aggregate must
      // still count this workflow run and its agent session only once.
      workItems: [
        { provider: 'linear', externalId: 'read-b-1', externalKey: 'BACK-1' },
        { provider: 'jira', externalId: 'read-a-2', externalKey: 'FRONT-2' },
        { provider: 'jira', externalId: 'read-a-1', externalKey: 'FRONT-1' },
      ],
    });
    const v2Starts = [
      event(
        2,
        randomUUID(),
        runIds[1],
        sessionIds[1],
        {
          workflowId: 'change:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'normal',
          stages,
        },
        taskA,
      ),
      event(
        2,
        randomUUID(),
        runIds[2],
        sessionIds[2],
        {
          workflowId: 'change:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'normal',
          stages,
        },
        taskA,
      ),
    ];
    const firstOccurrenceId = randomUUID();
    const secondOccurrenceId = randomUUID();
    const stageEvent = (
      eventId: string,
      occurrenceId: string,
      attempt: number,
      type: 'workflow.stage.started' | 'workflow.stage.finished',
      occurredAt: string,
    ) => ({
      schemaVersion: 2,
      eventId,
      occurredAt,
      host: 'claude-code',
      sessionId: sessionIds[0],
      runId: runIds[0],
      repositoryKey,
      type,
      data: {
        occurrenceId,
        stageId: 'implement',
        attempt,
        ...(type === 'workflow.stage.finished' ? { outcome: 'success' } : {}),
      },
    });
    const sharedEvents = [
      sharedStart,
      stageEvent(randomUUID(), firstOccurrenceId, 1, 'workflow.stage.started', '2026-08-18T10:01:00.000Z'),
      stageEvent(randomUUID(), firstOccurrenceId, 1, 'workflow.stage.finished', '2026-08-18T10:02:00.000Z'),
      stageEvent(randomUUID(), secondOccurrenceId, 2, 'workflow.stage.started', '2026-08-18T10:03:00.000Z'),
    ];
    await expect(capture.ingest(workspaceId, actor, { events: sharedEvents })).resolves.toEqual({
      acceptedEventIds: sharedEvents.map((item) => item.eventId),
      duplicateEventIds: [],
      rejected: [],
    });
    await expect(capture.ingest(workspaceId, actor, { events: v2Starts })).resolves.toEqual({
      acceptedEventIds: v2Starts.map((item) => item.eventId),
      duplicateEventIds: [],
      rejected: [],
    });

    const tiedCreatedAt = new Date('2026-08-18T10:10:00.123456Z');
    await prisma.workflowRun.updateMany({
      where: { workspaceId, runId: { in: [...runIds] } },
      data: { createdAt: tiedCreatedAt },
    });
    await prisma.agentSession.updateMany({
      where: { workspaceId, sessionId: { in: [...sessionIds] } },
      data: {
        model: 'claude-sonnet-4-6',
        tokensInput: 1_000_000,
        tokensOutput: 1_000_000,
      },
    });

    const initialRelationRows = await prisma.workflowRunWorkItem.findMany({
      where: { workflowRun: { workspaceId, runId: runIds[0] } },
      orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
      select: { provider: true, externalId: true, externalKey: true },
    });
    expect(initialRelationRows).toEqual([
      { provider: 'jira', externalId: 'read-a-1', externalKey: 'FRONT-1' },
      { provider: 'jira', externalId: 'read-a-2', externalKey: 'FRONT-2' },
      { provider: 'linear', externalId: 'read-b-1', externalKey: 'BACK-1' },
    ]);

    const taskAFirstPage = await service.listTaskRuns(workspaceId, taskA, '1');
    const taskASecondPage = await service.listTaskRuns(
      workspaceId,
      taskA,
      '1',
      requiredCursor(taskAFirstPage.nextCursor),
    );
    const taskAThirdPage = await service.listTaskRuns(
      workspaceId,
      taskA,
      '1',
      requiredCursor(taskASecondPage.nextCursor),
    );
    expect(taskAThirdPage.nextCursor).toBeNull();
    const taskAPages = [...taskAFirstPage.items, ...taskASecondPage.items, ...taskAThirdPage.items];
    expect(taskAPages.map((run) => run.runId)).toEqual([...runIds]);
    expect(taskAPages[0]?.workItems).toEqual([
      { provider: 'jira', externalId: 'read-a-1', externalKey: 'FRONT-1', linked: true },
      { provider: 'jira', externalId: 'read-a-2', externalKey: 'FRONT-2', linked: true },
      { provider: 'linear', externalId: 'read-b-1', externalKey: 'BACK-1', linked: true },
    ]);
    expect(taskAPages.slice(1).map((run) => run.workItems)).toEqual([[], []]);
    const taskBInitialRuns = await service.listTaskRuns(workspaceId, taskB, '10');
    expect(taskBInitialRuns.items.map((run) => run.runId)).toEqual([runIds[0]]);

    const summaries = await service.listTaskSummaries(workspaceId, '10');
    const summariesById = new Map(summaries.tasks.map((task) => [task.id, task]));
    expect(summariesById.get(taskA)?.counts.workflowRuns).toBe(3);
    expect(summariesById.get(taskB)?.counts.workflowRuns).toBe(1);
    expect(summariesById.get(taskC)?.counts.workflowRuns).toBe(0);
    await expect(service.getTaskDetail(workspaceId, taskA)).resolves.toMatchObject({
      counts: { workflowRuns: 3 },
      estimatedCost: { totalUsd: 54, sessions: 3, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    });
    await expect(service.getTaskDetail(workspaceId, taskB)).resolves.toMatchObject({
      counts: { workflowRuns: 1 },
      estimatedCost: { totalUsd: 18, sessions: 1, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    });

    const [taskAStages, taskBStages] = await Promise.all([
      service.listRunStageOccurrences(workspaceId, taskA, runIds[0], '10'),
      service.listRunStageOccurrences(workspaceId, taskB, runIds[0], '10'),
    ]);
    expect(taskAStages.items.map((stage) => [stage.attempt, stage.occurrenceId])).toEqual([
      [1, firstOccurrenceId],
      [2, secondOccurrenceId],
    ]);
    expect(taskBStages).toEqual(taskAStages);
    expect(await prisma.deliveryReworkSignal.count({ where: { workspaceId, kind: 'stage_reentry' } })).toBe(0);

    const legacy = await service.listTasks(workspaceId);
    const legacyById = new Map(legacy.tasks.map((task) => [task.id, task]));
    expect(legacyById.get(taskA)?.workflowRuns.map((run) => run.runId)).toEqual([...runIds]);
    expect(legacyById.get(taskB)?.workflowRuns.map((run) => run.runId)).toEqual([runIds[0]]);
    expect(legacyById.get(taskC)?.workflowRuns).toEqual([]);
    expect(legacyById.get(taskA)?.workflowRuns[0]).not.toHaveProperty('workItems');

    await service.detachExternalRef(workspaceId, taskB, refB.externalRef.id, {});
    await expect(service.listTaskRuns(workspaceId, taskB, '10')).resolves.toEqual({ items: [], nextCursor: null });
    const taskAAfterDetach = await service.listTaskRuns(workspaceId, taskA, '10');
    expect(taskAAfterDetach.items.find((run) => run.runId === runIds[0])?.workItems).toEqual([
      { provider: 'jira', externalId: 'read-a-1', externalKey: 'FRONT-1', linked: true },
      { provider: 'jira', externalId: 'read-a-2', externalKey: 'FRONT-2', linked: true },
      { provider: 'linear', externalId: 'read-b-1', externalKey: 'BACK-1', linked: false },
    ]);
    expect(
      await prisma.workflowRunWorkItem.findMany({
        where: { workflowRun: { workspaceId, runId: runIds[0] } },
        orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
        select: { provider: true, externalId: true, externalKey: true },
      }),
    ).toEqual(initialRelationRows);

    await attach(taskC, 'linear', 'read-b-1');
    await expect(service.listTaskRuns(workspaceId, taskB, '10')).resolves.toEqual({ items: [], nextCursor: null });
    const taskCAfterMove = await service.listTaskRuns(workspaceId, taskC, '10');
    expect(taskCAfterMove.items.map((run) => run.runId)).toEqual([runIds[0]]);
    await expect(service.getTaskDetail(workspaceId, taskC)).resolves.toMatchObject({
      counts: { workflowRuns: 1 },
      estimatedCost: { totalUsd: 18, sessions: 1, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    });
    await expect(service.listRunStageOccurrences(workspaceId, taskC, runIds[0], '10')).resolves.toEqual(taskAStages);
    await expect(service.listRunStageOccurrences(workspaceId, taskB, runIds[0], '10')).rejects.toMatchObject({
      status: 404,
    });
    expect(await prisma.deliveryReworkSignal.count({ where: { workspaceId, kind: 'stage_reentry' } })).toBe(0);

    // Keep the other attach results observably used: task A's two matches are
    // distinct durable refs, not duplicate fixture rows hidden by a helper.
    expect(new Set([refA1.externalRef.id, refA2.externalRef.id]).size).toBe(2);
  });

  it('does not repeat a DB-default sub-millisecond createdAt row on the next run page', async () => {
    const workspaceId = await createWorkspace('run-db-default-time');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000080');
    const agentSessionId = await createAgentSession(workspaceId, 'run-db-default-time');
    let runIds: [string, string] | null = null;

    for (let attempt = 0; attempt < 10 && runIds === null; attempt += 1) {
      const firstSerial = 81 + attempt * 2;
      const candidates: [string, string] = [
        `cdr-20260817-${firstSerial.toString(16).padStart(6, '0')}`,
        `cdr-20260817-${(firstSerial + 1).toString(16).padStart(6, '0')}`,
      ];
      const persistedIds = [
        `00000000-0000-4000-8000-${firstSerial.toString().padStart(12, '0')}`,
        `00000000-0000-4000-8000-${(firstSerial + 1).toString().padStart(12, '0')}`,
      ];
      await prisma.$executeRaw`
        INSERT INTO workflow_runs (
          id,
          workspace_id,
          run_id,
          agent_session_id,
          actor_id,
          delivery_task_id,
          updated_at
        )
        VALUES
          (
            CAST(${persistedIds[0]} AS uuid),
            CAST(${workspaceId} AS uuid),
            ${candidates[0]},
            CAST(${agentSessionId} AS uuid),
            'actor-db-default-time',
            ${deliveryTaskId},
            CURRENT_TIMESTAMP
          ),
          (
            CAST(${persistedIds[1]} AS uuid),
            CAST(${workspaceId} AS uuid),
            ${candidates[1]},
            CAST(${agentSessionId} AS uuid),
            'actor-db-default-time',
            ${deliveryTaskId},
            CURRENT_TIMESTAMP
          )
      `;
      const [precision] = await prisma.$queryRaw<Array<{ hasSubmillisecond: boolean }>>`
        SELECT BOOL_OR(created_at <> date_trunc('milliseconds', created_at)) AS "hasSubmillisecond"
        FROM workflow_runs
        WHERE workspace_id = CAST(${workspaceId} AS uuid)
          AND run_id IN (${candidates[0]}, ${candidates[1]})
      `;
      if (precision?.hasSubmillisecond) {
        runIds = candidates;
      } else {
        await prisma.workflowRun.deleteMany({ where: { workspaceId, runId: { in: candidates } } });
      }
    }
    if (runIds === null) throw new Error('PostgreSQL did not produce a sub-millisecond default timestamp');

    const first = await service.listTaskRuns(workspaceId, deliveryTaskId, '1');
    expect(first.items.map((run) => run.runId)).toEqual([runIds[0]]);
    const cursor = requiredCursor(first.nextCursor);
    await prisma.workflowRun.delete({
      where: { workspaceId_runId: { workspaceId, runId: runIds[0] } },
    });
    const second = await service.listTaskRuns(workspaceId, deliveryTaskId, '1', cursor);
    expect(second.items.map((run) => run.runId)).toEqual([runIds[1]]);
  });

  it('does not repeat a DB-default sub-millisecond createdAt row on the next artifact page', async () => {
    const workspaceId = await createWorkspace('artifact-db-default-time');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000090');
    let artifactIds: [string, string] | null = null;

    for (let attempt = 0; attempt < 10 && artifactIds === null; attempt += 1) {
      const firstSerial = 91 + attempt * 2;
      const candidates: [string, string] = [
        `cda_00000000-0000-4000-8000-${firstSerial.toString().padStart(12, '0')}`,
        `cda_00000000-0000-4000-8000-${(firstSerial + 1).toString().padStart(12, '0')}`,
      ];
      await prisma.$executeRaw`
        INSERT INTO delivery_artifacts (
          workspace_id,
          id,
          delivery_task_id,
          repository_key,
          kind,
          created_by,
          updated_at
        )
        VALUES
          (
            CAST(${workspaceId} AS uuid),
            ${candidates[0]},
            ${deliveryTaskId},
            'coredoc/coredoc-parser',
            'spec',
            'actor-db-default-time',
            CURRENT_TIMESTAMP
          ),
          (
            CAST(${workspaceId} AS uuid),
            ${candidates[1]},
            ${deliveryTaskId},
            'coredoc/coredoc-parser',
            'spec',
            'actor-db-default-time',
            CURRENT_TIMESTAMP
          )
      `;
      const [precision] = await prisma.$queryRaw<Array<{ hasSubmillisecond: boolean }>>`
        SELECT BOOL_OR(created_at <> date_trunc('milliseconds', created_at)) AS "hasSubmillisecond"
        FROM delivery_artifacts
        WHERE workspace_id = CAST(${workspaceId} AS uuid)
          AND id IN (${candidates[0]}, ${candidates[1]})
      `;
      if (precision?.hasSubmillisecond) {
        artifactIds = candidates;
      } else {
        await prisma.deliveryArtifact.deleteMany({ where: { workspaceId, id: { in: candidates } } });
      }
    }
    if (artifactIds === null) throw new Error('PostgreSQL did not produce a sub-millisecond default timestamp');

    const first = await service.listTaskArtifacts(workspaceId, deliveryTaskId, '1');
    expect(first.items.map((artifact) => artifact.id)).toEqual([artifactIds[0]]);
    const cursor = requiredCursor(first.nextCursor);
    await prisma.deliveryArtifact.delete({
      where: { workspaceId_id: { workspaceId, id: artifactIds[0] } },
    });
    const second = await service.listTaskArtifacts(workspaceId, deliveryTaskId, '1', cursor);
    expect(second.items.map((artifact) => artifact.id)).toEqual([artifactIds[1]]);
  });

  it('pages code-change source-time ties and NULLS LAST rows without exposing the cursor-only time', async () => {
    const workspaceId = await createWorkspace('code-changes');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000030');
    const connectorId = await createConnector(workspaceId, 'github', 'code-changes');
    const codeChangeIds = [
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032',
      '00000000-0000-4000-8000-000000000033',
      '00000000-0000-4000-8000-000000000034',
      '00000000-0000-4000-8000-000000000035',
    ];
    const firstSourceTime = new Date('2026-08-17T12:00:00.000Z');
    const secondSourceTime = new Date('2026-08-17T12:01:00.000Z');
    const providerUpdatedAt = new Date('2026-08-17T12:02:00.000Z');
    for (const [index, id] of codeChangeIds.entries()) {
      await prisma.codeChange.create({
        data: {
          id,
          workspaceId,
          connectorId,
          provider: 'github',
          repoExternalId: 'repo-42',
          externalId: `pr-${index + 1}`,
          number: index + 1,
          title: `Change ${index + 1}`,
          sourceBranch: `feature/${index + 1}`,
          targetBranch: 'main',
          state: index === 2 ? 'merged' : 'open',
          isDraft: index === 1,
          createdAtSource: index < 2 ? firstSourceTime : index === 2 ? secondSourceTime : null,
          mergedAt: index === 2 ? providerUpdatedAt : null,
          updatedAt: providerUpdatedAt,
        },
      });
    }
    await prisma.deliveryTaskCodeChange.createMany({
      data: codeChangeIds.map((codeChangeId, index) => ({
        workspaceId,
        deliveryTaskId,
        codeChangeId,
        associationSource: 'issue_key',
        associationSourceValue: `CORE-${index + 1}`,
      })),
    });

    const first = await service.listTaskCodeChanges(workspaceId, deliveryTaskId, '2');
    const second = await service.listTaskCodeChanges(
      workspaceId,
      deliveryTaskId,
      '2',
      requiredCursor(first.nextCursor),
    );
    const third = await service.listTaskCodeChanges(
      workspaceId,
      deliveryTaskId,
      '2',
      requiredCursor(second.nextCursor),
    );
    expect([...first.items, ...second.items, ...third.items]).toEqual(
      codeChangeIds.map((id, index) => ({
        id,
        provider: 'github',
        repoExternalId: 'repo-42',
        externalId: `pr-${index + 1}`,
        number: index + 1,
        title: `Change ${index + 1}`,
        state: index === 2 ? 'merged' : 'open',
        isDraft: index === 1,
        sourceBranch: `feature/${index + 1}`,
        targetBranch: 'main',
        createdAtSource:
          index < 2 ? firstSourceTime.toISOString() : index === 2 ? secondSourceTime.toISOString() : null,
        readyForReviewAt: null,
        firstReviewAt: null,
        approvedAt: null,
        mergedAt: index === 2 ? providerUpdatedAt.toISOString() : null,
        updatedAt: providerUpdatedAt.toISOString(),
        associationSource: 'issue_key',
        associationSourceValue: `CORE-${index + 1}`,
        externalUrl: null,
        reviewCount: null,
        commentCount: null,
      })),
    );
    expect(first.items.map((item) => item.id)).toEqual(codeChangeIds.slice(0, 2));
    expect(second.items.map((item) => item.id)).toEqual(codeChangeIds.slice(2, 4));
    expect(third.items.map((item) => item.id)).toEqual(codeChangeIds.slice(4));
    expect(third.nextCursor).toBeNull();
    expect(first.items[0]?.createdAtSource).toBe(firstSourceTime.toISOString());
  });

  it('pages ship, rework, and artifact ties with exact counts and no hidden Markdown', async () => {
    const workspaceId = await createWorkspace('facts');
    const taskUpdatedAt = new Date('2026-08-17T13:00:00.000Z');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000040', {
      createdAt: taskUpdatedAt,
      updatedAt: taskUpdatedAt,
      repositoryKey: 'coredoc/coredoc-parser',
    });
    const occurredAt = new Date('2026-08-17T13:01:00.000Z');
    const firstShip = await prisma.deliveryShipEvidence.create({
      data: {
        workspaceId,
        deliveryTaskId,
        source: 'coredoc',
        sourceKey: `${RUN}:ship:1`,
        occurredAt,
        receivedAt: new Date('2026-08-17T13:01:01.000Z'),
        actorId: 'actor-ship',
        provider: null,
        repoExternalId: null,
        externalId: null,
      },
    });
    const secondShip = await prisma.deliveryShipEvidence.create({
      data: {
        workspaceId,
        deliveryTaskId,
        source: 'github_pr_merged',
        sourceKey: `${RUN}:ship:2`,
        occurredAt,
        receivedAt: new Date('2026-08-17T13:01:02.000Z'),
        actorId: null,
        provider: 'github',
        repoExternalId: 'repo-42',
        externalId: 'pr-42',
      },
    });
    const firstRework = await prisma.deliveryReworkSignal.create({
      data: {
        workspaceId,
        deliveryTaskId,
        kind: 'stage_reentry',
        sourceKey: `${RUN}:rework:1`,
        sourceRef: 'stage:1',
        occurredAt,
        observedAt: new Date('2026-08-17T13:02:00.000Z'),
      },
    });
    const secondRework = await prisma.deliveryReworkSignal.create({
      data: {
        workspaceId,
        deliveryTaskId,
        kind: 'tracker_reopened',
        sourceKey: `${RUN}:rework:2`,
        sourceRef: 'jira:history:2',
        occurredAt,
        observedAt: new Date('2026-08-17T13:03:00.000Z'),
      },
    });

    const artifactIds = ['cda_00000000-0000-4000-8000-000000000041', 'cda_00000000-0000-4000-8000-000000000042'];
    const artifactCreatedAt = new Date('2026-08-17T13:04:00.000Z');
    await prisma.deliveryArtifact.create({
      data: {
        workspaceId,
        id: artifactIds[0]!,
        deliveryTaskId,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
        createdBy: 'actor-artifact',
        createdAt: artifactCreatedAt,
        updatedAt: artifactCreatedAt,
      },
    });
    await prisma.deliveryArtifact.create({
      data: {
        workspaceId,
        id: artifactIds[1]!,
        deliveryTaskId,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'design',
        createdBy: 'actor-artifact',
        createdAt: artifactCreatedAt,
        updatedAt: new Date('2026-08-17T13:05:00.000Z'),
      },
    });
    await prisma.artifactRevision.createMany({
      data: [
        {
          id: '00000000-0000-4000-8000-000000000043',
          workspaceId,
          artifactId: artifactIds[0]!,
          sha256: 'a'.repeat(64),
          byteCount: 3,
          markdown: 'one',
          checkpoint: 'run-finish',
          createdAt: new Date('2026-08-17T13:06:00.000Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000044',
          workspaceId,
          artifactId: artifactIds[0]!,
          sha256: 'b'.repeat(64),
          byteCount: 4,
          markdown: 'two!',
          checkpoint: 'session-end',
          createdAt: new Date('2026-08-17T13:07:00.000Z'),
        },
      ],
    });

    const firstShipPage = await service.listTaskShipEvidence(workspaceId, deliveryTaskId, '1');
    const secondShipPage = await service.listTaskShipEvidence(
      workspaceId,
      deliveryTaskId,
      '1',
      requiredCursor(firstShipPage.nextCursor),
    );
    expect(firstShipPage.items[0]).toEqual({
      id: firstShip.id.toString(),
      source: 'coredoc',
      sourceKey: `${RUN}:ship:1`,
      occurredAt: occurredAt.toISOString(),
      receivedAt: '2026-08-17T13:01:01.000Z',
      actorId: 'actor-ship',
      provider: null,
      repoExternalId: null,
      externalId: null,
    });
    expect(secondShipPage).toEqual({
      items: [
        {
          id: secondShip.id.toString(),
          source: 'github_pr_merged',
          sourceKey: `${RUN}:ship:2`,
          occurredAt: occurredAt.toISOString(),
          receivedAt: '2026-08-17T13:01:02.000Z',
          actorId: null,
          provider: 'github',
          repoExternalId: 'repo-42',
          externalId: 'pr-42',
        },
      ],
      nextCursor: null,
    });

    const firstReworkPage = await service.listTaskReworkSignals(workspaceId, deliveryTaskId, '1');
    const secondReworkPage = await service.listTaskReworkSignals(
      workspaceId,
      deliveryTaskId,
      '1',
      requiredCursor(firstReworkPage.nextCursor),
    );
    expect(firstReworkPage.items[0]?.id).toBe(firstRework.id.toString());
    expect(secondReworkPage.items[0]?.id).toBe(secondRework.id.toString());
    expect(secondReworkPage.nextCursor).toBeNull();

    const firstArtifactPage = await service.listTaskArtifacts(workspaceId, deliveryTaskId, '1');
    const secondArtifactPage = await service.listTaskArtifacts(
      workspaceId,
      deliveryTaskId,
      '1',
      requiredCursor(firstArtifactPage.nextCursor),
    );
    expect(firstArtifactPage.items).toEqual([
      {
        id: artifactIds[0],
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
        createdBy: 'actor-artifact',
        createdAt: artifactCreatedAt.toISOString(),
        updatedAt: '2026-08-17T13:07:00.000Z',
        revisionCount: 2,
      },
    ]);
    expect(secondArtifactPage).toEqual({
      items: [
        {
          id: artifactIds[1],
          repositoryKey: 'coredoc/coredoc-parser',
          kind: 'design',
          createdBy: 'actor-artifact',
          createdAt: artifactCreatedAt.toISOString(),
          updatedAt: '2026-08-17T13:05:00.000Z',
          revisionCount: 0,
        },
      ],
      nextCursor: null,
    });
    expect(firstArtifactPage.items[0]).not.toHaveProperty('markdown');

    const summaryPage = await service.listTaskSummaries(workspaceId, '1');
    expect(summaryPage).toEqual({
      tasks: [
        {
          id: deliveryTaskId,
          repositoryKey: 'coredoc/coredoc-parser',
          lifecycle: 'active',
          authority: { kind: 'coredoc' },
          title: null,
          createdBy: 'bounded-read-test',
          createdAt: taskUpdatedAt.toISOString(),
          updatedAt: taskUpdatedAt.toISOString(),
          everShipped: true,
          lastShippedAt: occurredAt.toISOString(),
          shipState: 'shipped',
          counts: {
            externalRefs: 0,
            workflowRuns: 0,
            codeChanges: 0,
            mergedCodeChanges: 0,
            openCodeChanges: 0,
            shipEvidence: 2,
            // Only the counted kinds: the seeded `stage_reentry` row is legacy and ignored.
            reworkSignals: 1,
            artifacts: 2,
          },
        },
      ],
      nextCursor: null,
    });
  });

  it('returns the durable retention checkpoint on exact task detail', async () => {
    const workspaceId = await createWorkspace('retention-detail');
    const createdAt = new Date('2026-08-17T14:00:00.000Z');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000050', {
      createdAt,
      updatedAt: createdAt,
    });
    const purgedThroughReceivedAt = new Date('2026-05-19T04:00:00.000Z');
    await prisma.captureRetentionCheckpoint.upsert({
      where: { id: 'capture_fine_events' },
      create: { id: 'capture_fine_events', purgedThroughReceivedAt },
      update: { purgedThroughReceivedAt },
    });

    await expect(service.getTaskDetail(workspaceId, deliveryTaskId)).resolves.toEqual({
      id: deliveryTaskId,
      repositoryKey: null,
      lifecycle: 'active',
      authority: { kind: 'coredoc' },
      title: null,
      createdBy: 'bounded-read-test',
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      everShipped: false,
      lastShippedAt: null,
      shipState: 'none',
      counts: {
        externalRefs: 0,
        workflowRuns: 0,
        codeChanges: 0,
        mergedCodeChanges: 0,
        openCodeChanges: 0,
        shipEvidence: 0,
        reworkSignals: 0,
        artifacts: 0,
      },
      fineEventRetention: {
        policyDays: 90,
        purgedThroughReceivedAt: purgedThroughReceivedAt.toISOString(),
      },
      estimatedCost: { totalUsd: null, sessions: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    });
    await prisma.captureRetentionCheckpoint.delete({ where: { id: 'capture_fine_events' } });
  });

  it('enforces workspace, external-ref, and run parent privacy before returning nested facts', async () => {
    const workspaceA = await createWorkspace('privacy-a');
    const workspaceB = await createWorkspace('privacy-b');
    const sharedTaskId = 'cdt_00000000-0000-4000-8000-000000000060';
    const workspaceBOnlyTaskId = 'cdt_00000000-0000-4000-8000-000000000061';
    await createTask(workspaceA, sharedTaskId);
    await createTask(workspaceB, sharedTaskId);
    await createTask(workspaceB, workspaceBOnlyTaskId);
    const connectorA = await createConnector(workspaceA, 'jira', 'privacy-a');
    const connectorB = await createConnector(workspaceB, 'jira', 'privacy-b');
    const refA = await prisma.taskExternalRef.create({
      data: {
        workspaceId: workspaceA,
        deliveryTaskId: sharedTaskId,
        provider: 'jira',
        externalId: `${RUN}:privacy:a`,
        connectorId: connectorA,
      },
    });
    const refB = await prisma.taskExternalRef.create({
      data: {
        workspaceId: workspaceB,
        deliveryTaskId: sharedTaskId,
        provider: 'jira',
        externalId: `${RUN}:privacy:b`,
        connectorId: connectorB,
      },
    });
    await prisma.taskExternalRefStateFact.create({
      data: {
        workspaceId: workspaceB,
        externalRefId: refB.id,
        sourceRef: 'privacy:b:state',
        fromState: null,
        toState: 'open',
        occurredAt: new Date('2026-08-17T15:00:00.000Z'),
        sourceUpdatedAt: new Date('2026-08-17T15:00:00.000Z'),
      },
    });
    const sessionB = await createAgentSession(workspaceB, 'privacy-b');
    const runB = 'cdr-20260817-b00001';
    const runBRowId = '00000000-0000-4000-8000-000000000062';
    await prisma.workflowRun.create({
      data: {
        id: runBRowId,
        workspaceId: workspaceB,
        runId: runB,
        agentSessionId: sessionB,
        actorId: 'actor-b',
        deliveryTaskId: sharedTaskId,
      },
    });
    await prisma.workflowStageOccurrence.create({
      data: {
        id: '00000000-0000-4000-8000-000000000063',
        workflowRunId: runBRowId,
        stageId: 'private-stage',
        attempt: 1,
      },
    });

    await expect(service.getTaskDetail(workspaceA, workspaceBOnlyTaskId)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.listExternalRefStateHistory(workspaceA, sharedTaskId, refB.id.toString()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.listRunStageOccurrences(workspaceA, sharedTaskId, runB)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.listTaskExternalRefs(workspaceA, sharedTaskId)).resolves.toMatchObject({
      items: [{ id: refA.id.toString() }],
    });
    await expect(service.listTaskSummaries(workspaceA)).resolves.toMatchObject({
      tasks: [{ id: sharedTaskId }],
    });
  });

  it('keeps the legacy unbounded list shape while bounded reads reject unresolved authority migration', async () => {
    const workspaceId = await createWorkspace('legacy-authority');
    const createdAt = new Date('2026-08-17T16:30:00.000Z');
    const deliveryTaskId = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000070', {
      authority: 'connector:jira',
      authorityRefId: null,
      createdBy: 'legacy-writer',
      createdAt,
      updatedAt: createdAt,
    });

    await expect(service.listTasks(workspaceId)).resolves.toEqual({
      tasks: [
        {
          id: deliveryTaskId,
          repositoryKey: null,
          lifecycle: 'active',
          authority: 'connector:jira',
          createdBy: 'legacy-writer',
          createdAt: createdAt.toISOString(),
          updatedAt: createdAt.toISOString(),
          externalRefs: [],
          artifacts: [],
          workflowRuns: [],
        },
      ],
    });
    await expect(service.listTaskSummaries(workspaceId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TASK_AUTHORITY_MIGRATION_REQUIRED' }),
    });
    await expect(service.getTaskDetail(workspaceId, deliveryTaskId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TASK_AUTHORITY_MIGRATION_REQUIRED' }),
    });
  });

  it('describes one population from the filtered task pages and the delivery summary', async () => {
    const workspaceId = await createWorkspace('summary-population');
    const inWindow = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const outsideWindow = new Date(Date.now() - 200 * 24 * 60 * 60 * 1_000);
    const shippedIds = [
      'cdt_00000000-0000-4000-8000-000000000201',
      'cdt_00000000-0000-4000-8000-000000000202',
      'cdt_00000000-0000-4000-8000-000000000203',
      'cdt_00000000-0000-4000-8000-000000000204',
      'cdt_00000000-0000-4000-8000-000000000205',
    ];
    const activeId = 'cdt_00000000-0000-4000-8000-000000000206';
    const staleShippedId = 'cdt_00000000-0000-4000-8000-000000000207';
    for (const [index, id] of [...shippedIds, staleShippedId].entries()) {
      const updatedAt = id === staleShippedId ? outsideWindow : new Date(inWindow.getTime() - index * 1_000);
      await createTask(workspaceId, id, {
        lifecycle: 'completed',
        createdAt: new Date(updatedAt.getTime() - 4 * 60 * 60 * 1_000),
        updatedAt,
      });
      await prisma.deliveryShipEvidence.create({
        data: {
          workspaceId,
          deliveryTaskId: id,
          source: 'coredoc',
          sourceKey: `ship:${id}`,
          occurredAt: new Date(updatedAt.getTime() - 60 * 60 * 1_000),
        },
      });
    }
    await createTask(workspaceId, activeId, {
      lifecycle: 'active',
      createdAt: new Date(inWindow.getTime() - 60 * 60 * 1_000),
      updatedAt: inWindow,
    });

    // The dogfood shape (BR-6/BR-9): rework evidence that exists only as an `attempt > 1`
    // occurrence on a run associated through work items, with no `delivery_rework_signals` row.
    const reworkOccurrenceId = 'cdt_00000000-0000-4000-8000-000000000208';
    await createTask(workspaceId, reworkOccurrenceId, {
      lifecycle: 'active',
      createdAt: new Date(inWindow.getTime() - 60 * 60 * 1_000),
      updatedAt: inWindow,
    });
    await prisma.taskExternalRef.create({
      data: { workspaceId, deliveryTaskId: reworkOccurrenceId, provider: 'jira', externalId: 'REWORK-1' },
    });
    const reworkSessionId = await createAgentSession(workspaceId, 'summary-population-rework');
    const reworkRunId = '00000000-0000-4000-8000-0000000002c0';
    await prisma.workflowRun.create({
      data: {
        id: reworkRunId,
        workspaceId,
        runId: 'cdr-20260901-cc0001',
        agentSessionId: reworkSessionId,
        actorId: 'rework-actor',
      },
    });
    await prisma.workflowRunWorkItem.create({
      data: { workspaceId, workflowRunId: reworkRunId, provider: 'jira', externalId: 'REWORK-1' },
    });
    await prisma.workflowStageOccurrence.createMany({
      data: [
        {
          id: '00000000-0000-4000-8000-0000000002c1',
          workflowRunId: reworkRunId,
          stageId: 'review',
          attempt: 1,
          startedAt: new Date(inWindow.getTime() - 60 * 60 * 1_000),
          finishedAt: new Date(inWindow.getTime() - 30 * 60 * 1_000),
          outcome: 'failed',
        },
        {
          id: '00000000-0000-4000-8000-0000000002c2',
          workflowRunId: reworkRunId,
          stageId: 'review',
          attempt: 2,
          startedAt: new Date(inWindow.getTime() - 30 * 60 * 1_000),
          finishedAt: inWindow,
          outcome: 'success',
        },
      ],
    });

    // The other half of the union: a signal with no run behind it at all.
    const reworkSignalOnlyId = 'cdt_00000000-0000-4000-8000-000000000209';
    await createTask(workspaceId, reworkSignalOnlyId, {
      lifecycle: 'active',
      createdAt: new Date(inWindow.getTime() - 60 * 60 * 1_000),
      updatedAt: inWindow,
    });
    await prisma.deliveryReworkSignal.create({
      data: {
        workspaceId,
        deliveryTaskId: reworkSignalOnlyId,
        kind: 'tracker_reopened',
        sourceKey: `${RUN}:summary-population:rework`,
        sourceRef: 'jira:history:1',
        occurredAt: inWindow,
        observedAt: inWindow,
      },
    });

    const pagedIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.listTaskSummaries(workspaceId, '2', cursor, '30', 'shipped');
      pagedIds.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);

    const summary = await service.getDeliverySummary(workspaceId, '30', 'shipped');

    expect(pages).toBe(3);
    expect([...pagedIds].sort()).toEqual([...shippedIds].sort());
    expect(summary.tasks).toEqual({
      matching: shippedIds.length,
      shipped: shippedIds.length,
      partiallyShipped: 0,
      withRework: 0,
      active: 0,
    });
    expect(summary.leadTimeMs).toEqual({ value: 3 * 60 * 60 * 1_000, sampleSize: shippedIds.length });
    expect(summary.window.lifecycle).toBe('shipped');

    const allFilter = await service.getDeliverySummary(workspaceId, '30', 'all');
    expect(allFilter.tasks).toEqual({
      matching: shippedIds.length + 3,
      shipped: shippedIds.length,
      partiallyShipped: 0,
      // Signal evidence only: the attempt>1 occurrence task is not reworked.
      withRework: 1,
      active: 3,
    });

    // AC-7: the `rework` list and the `withRework` KPI describe the same task — the one with a
    // counted signal row. The attempt>1 occurrence is an iteration fact and matches neither.
    const reworkPagedIds: string[] = [];
    let reworkCursor: string | undefined;
    let reworkPages = 0;
    do {
      const page = await service.listTaskSummaries(workspaceId, '1', reworkCursor, '30', 'rework');
      reworkPagedIds.push(...page.tasks.map((task) => task.id));
      reworkCursor = page.nextCursor ?? undefined;
      reworkPages += 1;
    } while (reworkCursor !== undefined);
    // One row per page: the filter must survive the cursor, so a page that widened to the
    // whole window would fail here on both count and identity.
    expect(reworkPages).toBe(1);
    expect(reworkPagedIds).toEqual([reworkSignalOnlyId]);

    const reworkFilter = await service.getDeliverySummary(workspaceId, '30', 'rework');
    expect(reworkFilter.tasks.matching).toBe(1);
    expect(reworkFilter.tasks.withRework).toBe(1);
    expect(reworkFilter.tasks.withRework).toBe(allFilter.tasks.withRework);
    expect(reworkFilter.rework.bySource).toEqual([
      { kind: 'tracker_reopened', signals: 1, tasks: 1 },
      { kind: 'review_changes_requested', signals: 0, tasks: 0 },
      { kind: 'review_commented', signals: 0, tasks: 0 },
    ]);

    // `runs` uses the same association as `listTaskRuns`: the only run in this workspace has
    // no `delivery_task_id` and reaches its task through a work item, so a direct-column check
    // would return nothing here.
    const runsPage = await service.listTaskSummaries(workspaceId, '10', undefined, '30', 'runs');
    expect(runsPage.tasks.map((task) => task.id)).toEqual([reworkOccurrenceId]);
    const runsFilter = await service.getDeliverySummary(workspaceId, '30', 'runs');
    expect(runsFilter.tasks.matching).toBe(1);
  });

  it('counts a doubly associated run once per task and never reads occurrences of another workspace', async () => {
    const workspaceId = await createWorkspace('summary-association');
    const otherWorkspaceId = await createWorkspace('summary-association-other');
    const updatedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const createdAt = new Date(updatedAt.getTime() - 4 * 60 * 60 * 1_000);
    const taskA = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000210', {
      lifecycle: 'completed',
      createdAt,
      updatedAt,
    });
    const taskB = await createTask(workspaceId, 'cdt_00000000-0000-4000-8000-000000000211', {
      lifecycle: 'completed',
      createdAt,
      updatedAt,
    });
    // Task A matches the shared run through BOTH association branches.
    await prisma.taskExternalRef.create({
      data: { workspaceId, deliveryTaskId: taskA, provider: 'jira', externalId: 'ASSOC-1' },
    });
    await prisma.taskExternalRef.create({
      data: { workspaceId, deliveryTaskId: taskB, provider: 'jira', externalId: 'ASSOC-2' },
    });
    const agentSessionId = await createAgentSession(workspaceId, 'assoc');
    const sharedRunId = '00000000-0000-4000-8000-0000000002a0';
    await prisma.workflowRun.create({
      data: {
        id: sharedRunId,
        workspaceId,
        runId: 'cdr-20260901-aa0001',
        agentSessionId,
        actorId: 'assoc-actor',
        deliveryTaskId: taskA,
        counters: { editVerifyRounds: 2 },
      },
    });
    await prisma.workflowRunWorkItem.createMany({
      data: [
        { workspaceId, workflowRunId: sharedRunId, provider: 'jira', externalId: 'ASSOC-1' },
        { workspaceId, workflowRunId: sharedRunId, provider: 'jira', externalId: 'ASSOC-2' },
      ],
    });
    // `workflow_stage_occurrences_finish_pair_check`: finished_at and outcome are set together,
    // so a still-open occurrence carries neither.
    await prisma.workflowStageOccurrence.createMany({
      data: [
        {
          id: '00000000-0000-4000-8000-0000000002a1',
          workflowRunId: sharedRunId,
          stageId: 'review',
          attempt: 1,
          startedAt: createdAt,
          finishedAt: new Date(createdAt.getTime() + 60 * 60 * 1_000),
          outcome: 'failed',
        },
        {
          id: '00000000-0000-4000-8000-0000000002a2',
          workflowRunId: sharedRunId,
          stageId: 'review',
          attempt: 2,
          startedAt: new Date(createdAt.getTime() + 60 * 60 * 1_000),
          finishedAt: new Date(createdAt.getTime() + 90 * 60 * 1_000),
          outcome: 'success',
        },
        {
          id: '00000000-0000-4000-8000-0000000002a3',
          workflowRunId: sharedRunId,
          stageId: 'build',
          attempt: 1,
          startedAt: new Date(createdAt.getTime() + 120 * 60 * 1_000),
          finishedAt: null,
          outcome: null,
        },
      ],
    });

    // A second workspace with its own task, run and a much longer occurrence.
    const otherTask = await createTask(otherWorkspaceId, 'cdt_00000000-0000-4000-8000-000000000212', {
      lifecycle: 'completed',
      createdAt,
      updatedAt,
    });
    const otherSessionId = await createAgentSession(otherWorkspaceId, 'assoc-other');
    const otherRunId = '00000000-0000-4000-8000-0000000002b0';
    await prisma.workflowRun.create({
      data: {
        id: otherRunId,
        workspaceId: otherWorkspaceId,
        runId: 'cdr-20260901-bb0001',
        agentSessionId: otherSessionId,
        actorId: 'assoc-actor-other',
        deliveryTaskId: otherTask,
      },
    });
    await prisma.workflowStageOccurrence.create({
      data: {
        id: '00000000-0000-4000-8000-0000000002b1',
        workflowRunId: otherRunId,
        stageId: 'review',
        attempt: 1,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 10 * 60 * 60 * 1_000),
        outcome: 'success',
      },
    });

    const summary = await service.getDeliverySummary(workspaceId, '30', 'all');

    // 90 claimed minutes of review per task (60 + 30 over the two attempts): a run matched by
    // both branches must not be counted twice. The unfinished build stage claims nothing, so it
    // reports an empty sample rather than zero.
    expect(summary.stages).toEqual([
      { stageId: 'review', claimedMs: { value: 90 * 60 * 1_000, sampleSize: 2 }, incomplete: 0, inProgress: 0 },
      // Counted once for the same reason: the unfinished occurrence is a few hours old, so it
      // is still in progress rather than incomplete.
      { stageId: 'build', claimedMs: { value: null, sampleSize: 0 }, incomplete: 0, inProgress: 1 },
    ]);
    expect(summary.rework.bySource).toEqual([
      { kind: 'tracker_reopened', signals: 0, tasks: 0 },
      { kind: 'review_changes_requested', signals: 0, tasks: 0 },
      { kind: 'review_commented', signals: 0, tasks: 0 },
    ]);
    expect(summary.editVerifyRoundsPerRun).toEqual({ value: 2, sampleSize: 1 });
    expect(summary.tasks.matching).toBe(2);

    const otherSummary = await service.getDeliverySummary(otherWorkspaceId, '30', 'all');
    expect(otherSummary.stages).toEqual([
      { stageId: 'review', claimedMs: { value: 10 * 60 * 60 * 1_000, sampleSize: 1 }, incomplete: 0, inProgress: 0 },
    ]);
  });
  it("scopes the member filter to that member's own agent sessions across both association branches", async () => {
    const workspaceId = await createWorkspace('summary-mine');
    const updatedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const createdAt = new Date(updatedAt.getTime() - 4 * 60 * 60 * 1_000);
    const mineDirectId = 'cdt_00000000-0000-4000-8000-000000000220';
    const mineWorkItemId = 'cdt_00000000-0000-4000-8000-000000000221';
    const theirsId = 'cdt_00000000-0000-4000-8000-000000000222';
    for (const id of [mineDirectId, mineWorkItemId, theirsId]) {
      await createTask(workspaceId, id, { lifecycle: 'active', createdAt, updatedAt });
    }
    await prisma.taskExternalRef.create({
      data: { workspaceId, deliveryTaskId: mineWorkItemId, provider: 'jira', externalId: 'MINE-1' },
    });

    const mySessionId = await createAgentSession(workspaceId, 'mine-caller', 'caller-user');
    const theirSessionId = await createAgentSession(workspaceId, 'mine-other', 'other-user');
    // Direct association on the caller's session.
    await prisma.workflowRun.create({
      data: {
        id: '00000000-0000-4000-8000-0000000002d0',
        workspaceId,
        runId: 'cdr-20260901-dd0001',
        agentSessionId: mySessionId,
        actorId: 'mine-actor',
        deliveryTaskId: mineDirectId,
      },
    });
    // Work-item association on the caller's session.
    const workItemRunId = '00000000-0000-4000-8000-0000000002d1';
    await prisma.workflowRun.create({
      data: {
        id: workItemRunId,
        workspaceId,
        runId: 'cdr-20260901-dd0002',
        agentSessionId: mySessionId,
        actorId: 'mine-actor',
      },
    });
    await prisma.workflowRunWorkItem.create({
      data: { workspaceId, workflowRunId: workItemRunId, provider: 'jira', externalId: 'MINE-1' },
    });
    // Another developer's run on the third task.
    await prisma.workflowRun.create({
      data: {
        id: '00000000-0000-4000-8000-0000000002d2',
        workspaceId,
        runId: 'cdr-20260901-dd0003',
        agentSessionId: theirSessionId,
        actorId: 'other-actor',
        deliveryTaskId: theirsId,
      },
    });

    const minePage = await service.listTaskSummaries(
      workspaceId,
      '10',
      undefined,
      '30',
      'all',
      undefined,
      undefined,
      'caller-user',
    );
    expect(minePage.tasks.map((task) => task.id).sort()).toEqual([mineDirectId, mineWorkItemId].sort());

    // AC-7: the KPI describes the same population as the list.
    const mineSummary = await service.getDeliverySummary(workspaceId, '30', 'all', undefined, undefined, 'caller-user');
    expect(mineSummary.tasks.matching).toBe(2);
    expect(mineSummary.window.userId).toBe('caller-user');

    // Any member id is answerable, not just the caller's: the route owns who may ask.
    const theirSummary = await service.getDeliverySummary(workspaceId, '30', 'all', undefined, undefined, 'other-user');
    expect(theirSummary.tasks.matching).toBe(1);
    expect(theirSummary.window.userId).toBe('other-user');

    const everyone = await service.getDeliverySummary(workspaceId, '30', 'all');
    expect(everyone.tasks.matching).toBe(3);
    expect(everyone.window.userId).toBeNull();
  });

  it('reports a ship with an open linked code change as partial on both the list and the summary', async () => {
    const workspaceId = await createWorkspace('summary-ship-state');
    const connectorId = await createConnector(workspaceId, 'github', 'ship-state');
    const updatedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const createdAt = new Date(updatedAt.getTime() - 4 * 60 * 60 * 1_000);
    const fullyShippedId = 'cdt_00000000-0000-4000-8000-000000000230';
    const partialId = 'cdt_00000000-0000-4000-8000-000000000231';
    for (const id of [fullyShippedId, partialId]) {
      await createTask(workspaceId, id, { lifecycle: 'completed', createdAt, updatedAt });
      await prisma.deliveryShipEvidence.create({
        data: {
          workspaceId,
          deliveryTaskId: id,
          source: 'coredoc',
          sourceKey: `${RUN}:ship-state:${id}`,
          occurredAt: new Date(updatedAt.getTime() - 60 * 60 * 1_000),
        },
      });
    }
    const codeChanges: Array<[string, string, 'merged' | 'open' | 'closed', string]> = [
      ['00000000-0000-4000-8000-000000000240', fullyShippedId, 'merged', 'pr-ship-1'],
      // A closed-without-merge change blocks nothing.
      ['00000000-0000-4000-8000-000000000241', fullyShippedId, 'closed', 'pr-ship-2'],
      ['00000000-0000-4000-8000-000000000242', partialId, 'merged', 'pr-ship-3'],
      ['00000000-0000-4000-8000-000000000243', partialId, 'open', 'pr-ship-4'],
    ];
    for (const [id, deliveryTaskId, state, externalId] of codeChanges) {
      await prisma.codeChange.create({
        data: {
          id,
          workspaceId,
          connectorId,
          provider: 'github',
          repoExternalId: 'repo-ship',
          externalId,
          state,
          isDraft: false,
          updatedAt,
          ...(state === 'merged' ? { mergedAt: updatedAt } : {}),
        },
      });
      await prisma.deliveryTaskCodeChange.create({
        data: {
          workspaceId,
          deliveryTaskId,
          codeChangeId: id,
          associationSource: 'issue_key',
          associationSourceValue: 'SHIP-1',
        },
      });
    }

    const page = await service.listTaskSummaries(workspaceId, '10', undefined, '30', 'all');
    const byId = new Map(page.tasks.map((task) => [task.id, task]));
    expect(byId.get(fullyShippedId)).toMatchObject({
      shipState: 'shipped',
      counts: { mergedCodeChanges: 1, openCodeChanges: 0 },
    });
    expect(byId.get(partialId)).toMatchObject({
      shipState: 'partial',
      counts: { mergedCodeChanges: 1, openCodeChanges: 1 },
    });

    // The `shipped` filter pages exactly what the KPI counted.
    const shippedPage = await service.listTaskSummaries(workspaceId, '10', undefined, '30', 'shipped');
    expect(shippedPage.tasks.map((task) => task.id)).toEqual([fullyShippedId]);
    const summary = await service.getDeliverySummary(workspaceId, '30', 'all');
    expect(summary.tasks).toMatchObject({ matching: 2, shipped: 1, partiallyShipped: 1 });
    expect(summary.leadTimeMs.sampleSize).toBe(1);
  });
});
