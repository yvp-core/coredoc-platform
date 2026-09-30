import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { decodeDeliveryCursor, deliveryCursorScope, encodeDeliveryCursor } from './canonical-delivery-read.contract.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REF_ID = 9_007_199_254_740_993n;
const RUN_ID = 'cdr-20260817-a1b2c3';
const MEMBER_ID = 'user-42';
const CREATED_AT = new Date('2026-08-17T10:00:00.000Z');
const UPDATED_AT = new Date('2026-08-17T10:05:00.000Z');

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    lifecycle: 'active',
    authority: 'coredoc',
    authorityRefId: null,
    authorityRef: null,
    title: null,
    createdBy: 'actor-1',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    shipEvidence: [{ occurredAt: UPDATED_AT }],
    _count: {
      externalRefs: 1,
      workflowRuns: 2,
      codeChanges: 3,
      shipEvidence: 4,
      reworkSignals: 5,
      artifacts: 6,
    },
    ...overrides,
  };
}

function taskContext(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    authority: 'coredoc',
    authorityRefId: null,
    authorityRef: null,
    ...overrides,
  };
}

function mockPrisma(overrides: Record<string, unknown> = {}): PrismaService {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    deliveryTask: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(taskContext()),
    },
    captureRetentionCheckpoint: { findUnique: vi.fn().mockResolvedValue(null) },
    taskExternalRef: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    taskExternalRefStateFact: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    workflowStageOccurrence: { findMany: vi.fn().mockResolvedValue([]) },
    deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue([]) },
    deliveryShipEvidence: { findMany: vi.fn().mockResolvedValue([]) },
    deliveryReworkSignal: { findMany: vi.fn().mockResolvedValue([]) },
    deliveryArtifact: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as unknown as PrismaService;
}

describe('CanonicalDeliveryService bounded summaries/detail', () => {
  it('returns a newest-first bounded summary with exact authority, counts, ship facts, and a cursor', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([summaryRow(), summaryRow({ id: OTHER_TASK_ID, updatedAt: CREATED_AT, shipEvidence: [] })]);
    const service = new CanonicalDeliveryService(
      mockPrisma({
        $queryRaw: vi.fn().mockResolvedValue([{ taskId: TASK_ID, runCount: 2n }]),
        deliveryTask: { findMany },
      }),
    );

    await expect(service.listTaskSummaries(WORKSPACE_ID, '1')).resolves.toEqual({
      tasks: [
        {
          id: TASK_ID,
          repositoryKey: 'coredoc/coredoc-parser',
          lifecycle: 'active',
          authority: { kind: 'coredoc' },
          title: null,
          createdBy: 'actor-1',
          createdAt: CREATED_AT.toISOString(),
          updatedAt: UPDATED_AT.toISOString(),
          everShipped: true,
          lastShippedAt: UPDATED_AT.toISOString(),
          shipState: 'shipped',
          counts: {
            externalRefs: 1,
            workflowRuns: 2,
            codeChanges: 3,
            mergedCodeChanges: 0,
            openCodeChanges: 0,
            shipEvidence: 4,
            reworkSignals: 5,
            artifacts: 6,
          },
        },
      ],
      nextCursor: expect.any(String),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
  });

  it('projects exact external-ref authority and fails closed for unresolved legacy authority', async () => {
    const connected = summaryRow({
      authority: 'connector:jira',
      authorityRefId: REF_ID,
      authorityRef: {
        id: REF_ID,
        deliveryTaskId: TASK_ID,
        provider: 'jira',
        externalId: '10042',
        connectorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      shipEvidence: [],
      _count: { externalRefs: 1, workflowRuns: 0, codeChanges: 0, shipEvidence: 0, reworkSignals: 0, artifacts: 0 },
    });
    const listService = new CanonicalDeliveryService(
      mockPrisma({ deliveryTask: { findMany: vi.fn().mockResolvedValue([connected]) } }),
    );
    await expect(listService.listTaskSummaries(WORKSPACE_ID)).resolves.toMatchObject({
      tasks: [
        {
          authority: {
            kind: 'external_ref',
            externalRefId: REF_ID.toString(),
            provider: 'jira',
            externalId: '10042',
            connected: true,
          },
          everShipped: false,
          lastShippedAt: null,
        },
      ],
    });

    const unresolved = new CanonicalDeliveryService(
      mockPrisma({
        deliveryTask: {
          findMany: vi.fn().mockResolvedValue([summaryRow({ authority: 'connector:jira' })]),
        },
      }),
    );
    await expect(unresolved.listTaskSummaries(WORKSPACE_ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(unresolved.listTaskSummaries(WORKSPACE_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TASK_AUTHORITY_MIGRATION_REQUIRED' }),
    });
  });

  it('returns exactly the summary plus the frozen retention checkpoint metadata', async () => {
    const checkpoint = new Date('2026-05-19T00:00:00.000Z');
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(summaryRow())
      .mockResolvedValueOnce({ purgedThroughReceivedAt: checkpoint });
    const prisma = mockPrisma({
      deliveryTask: { findUnique },
      captureRetentionCheckpoint: { findUnique },
    });
    const service = new CanonicalDeliveryService(prisma);

    await expect(service.getTaskDetail(WORKSPACE_ID, TASK_ID)).resolves.toMatchObject({
      id: TASK_ID,
      authority: { kind: 'coredoc' },
      fineEventRetention: {
        policyDays: 90,
        purgedThroughReceivedAt: checkpoint.toISOString(),
      },
    });
    expect(findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: TASK_ID } } }),
    );
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: 'capture_fine_events' },
      select: { purgedThroughReceivedAt: true },
    });
  });
});

describe('CanonicalDeliveryService bounded nested reads', () => {
  it('derives V3 task membership and linked state from exact work-item identities in one bounded page read', async () => {
    const prisma = mockPrisma();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { runId: RUN_ID, cursorCreatedAt: '2026-08-17T10:00:00.000000Z' },
    ] as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      {
        runId: RUN_ID,
        workflowId: 'change:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'normal',
        repositoryKey: 'coredoc/coredoc-parser',
        startedAt: CREATED_AT,
        finishedAt: UPDATED_AT,
        outcome: 'success',
        counters: null,
        workItems: [
          { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' },
          { provider: 'linear.issue', externalId: 'lin_42', externalKey: null },
        ],
      } as never,
    ]);
    vi.mocked(prisma.taskExternalRef.findMany).mockResolvedValue([{ provider: 'jira', externalId: '10042' } as never]);
    const service = new CanonicalDeliveryService(prisma);

    await expect(service.listTaskRuns(WORKSPACE_ID, TASK_ID)).resolves.toMatchObject({
      items: [
        {
          runId: RUN_ID,
          workItems: [
            { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9', linked: true },
            { provider: 'linear.issue', externalId: 'lin_42', externalKey: null, linked: false },
          ],
        },
      ],
    });
    const pageSql = (vi.mocked(prisma.$queryRaw).mock.calls[0]?.[0] as { strings: string[] }).strings.join('?');
    expect(pageSql).toContain('workflow_run_work_items');
    expect(pageSql).toContain('task_external_refs');
  });

  it('preserves zero verification counters and maps missing or invalid members to null without inference', async () => {
    const prisma = mockPrisma();
    const baseRun = {
      workflowId: null,
      intent: null,
      risk: null,
      scale: null,
      repositoryKey: null,
      startedAt: null,
      finishedAt: null,
      outcome: null,
      createdAt: CREATED_AT,
      workItems: [],
    };
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      {
        ...baseRun,
        runId: RUN_ID,
        counters: { verificationRuns: 0, verificationFailures: 0, editVerifyRounds: 0 },
      } as never,
      {
        ...baseRun,
        runId: 'cdr-20260817-b2c3d4',
        counters: { verificationRuns: '2', verificationFailures: -1, editVerifyRounds: 1.5 },
      } as never,
      { ...baseRun, runId: 'cdr-20260817-c3d4e5', counters: null } as never,
    ]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { runId: RUN_ID, cursorCreatedAt: '2026-08-17T10:00:00.000000Z' },
      { runId: 'cdr-20260817-b2c3d4', cursorCreatedAt: '2026-08-17T10:00:01.000000Z' },
      { runId: 'cdr-20260817-c3d4e5', cursorCreatedAt: '2026-08-17T10:00:02.000000Z' },
    ] as never);
    const service = new CanonicalDeliveryService(prisma);

    await expect(service.listTaskRuns(WORKSPACE_ID, TASK_ID)).resolves.toMatchObject({
      items: [
        { verification: { runs: 0, failures: 0, editVerifyRounds: 0 } },
        { verification: { runs: null, failures: null, editVerifyRounds: null } },
        { verification: null },
      ],
    });
  });

  it('projects each closed nested item shape without payloads or Markdown', async () => {
    const prisma = mockPrisma();
    const refReceivedAt = new Date('2026-08-17T10:01:00.000Z');
    vi.mocked(prisma.taskExternalRef.findMany).mockResolvedValue([
      {
        id: REF_ID,
        provider: 'jira',
        externalId: '10042',
        externalKey: 'CORE-42',
        externalUrl: 'https://jira.example.test/browse/CORE-42',
        externalState: 'In Progress',
        connectorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceUpdatedAt: CREATED_AT,
        lastObservedAt: UPDATED_AT,
        _count: { stateFacts: 2 },
      } as never,
    ]);
    vi.mocked(prisma.taskExternalRef.findFirst).mockResolvedValue({ id: REF_ID } as never);
    vi.mocked(prisma.taskExternalRefStateFact.findMany).mockResolvedValue([
      {
        id: 42n,
        fromState: 'Done',
        toState: 'In Progress',
        sourceRef: 'jira:history:1',
        occurredAt: CREATED_AT,
        sourceUpdatedAt: UPDATED_AT,
        receivedAt: refReceivedAt,
        actorId: null,
      } as never,
    ]);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      {
        runId: RUN_ID,
        workflowId: 'change:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'normal',
        repositoryKey: 'coredoc/coredoc-parser',
        startedAt: CREATED_AT,
        finishedAt: UPDATED_AT,
        outcome: 'failed',
        counters: { verificationRuns: 2, verificationFailures: 1 },
        createdAt: CREATED_AT,
        workItems: [],
      } as never,
      {
        runId: 'cdr-20260817-b2c3d4',
        workflowId: null,
        intent: null,
        risk: null,
        scale: null,
        repositoryKey: null,
        startedAt: null,
        finishedAt: null,
        outcome: null,
        counters: null,
        createdAt: UPDATED_AT,
        workItems: [],
      } as never,
    ]);
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValue({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as never);
    vi.mocked(prisma.workflowStageOccurrence.findMany).mockResolvedValue([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        stageId: 'tdd',
        attempt: 2,
        startedAt: CREATED_AT,
        finishedAt: UPDATED_AT,
        outcome: 'success',
      } as never,
    ]);
    vi.mocked(prisma.deliveryTaskCodeChange.findMany).mockResolvedValue([
      {
        associationSource: 'issue_key',
        associationSourceValue: 'CORE-42',
        codeChange: {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          provider: 'github',
          repoExternalId: 'repo-1',
          externalId: 'pr-42',
          number: 42,
          title: 'Bounded reads',
          state: 'merged',
          isDraft: false,
          sourceBranch: 'feature/c7',
          targetBranch: 'main',
          mergedAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
          createdAtSource: CREATED_AT,
          externalUrl: null,
          reviewCount: null,
          commentCount: null,
        },
      } as never,
    ]);
    vi.mocked(prisma.deliveryShipEvidence.findMany).mockResolvedValue([
      {
        id: 43n,
        source: 'github_pr_merged',
        sourceKey: 'ship:42',
        occurredAt: UPDATED_AT,
        receivedAt: refReceivedAt,
        actorId: null,
        provider: 'github',
        repoExternalId: 'repo-1',
        externalId: 'pr-42',
      } as never,
    ]);
    vi.mocked(prisma.deliveryReworkSignal.findMany).mockResolvedValue([
      {
        id: 44n,
        kind: 'stage_reentry',
        sourceKey: 'occurrence-2',
        sourceRef: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        occurredAt: CREATED_AT,
        observedAt: UPDATED_AT,
      } as never,
    ]);
    vi.mocked(prisma.deliveryArtifact.findMany).mockResolvedValue([
      {
        id: 'cda_ffffffff-ffff-4fff-8fff-ffffffffffff',
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
        createdBy: 'actor-1',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        revisions: [{ createdAt: UPDATED_AT }],
        _count: { revisions: 2 },
      } as never,
    ]);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { runId: RUN_ID, cursorCreatedAt: '2026-08-17T10:00:00.000000Z' },
        { runId: 'cdr-20260817-b2c3d4', cursorCreatedAt: '2026-08-17T10:05:00.000000Z' },
      ] as never)
      .mockResolvedValueOnce([{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] as never)
      .mockResolvedValueOnce([
        {
          id: 'cda_ffffffff-ffff-4fff-8fff-ffffffffffff',
          cursorCreatedAt: '2026-08-17T10:00:00.000000Z',
        },
      ] as never);
    const service = new CanonicalDeliveryService(prisma);

    const results = [
      await service.listTaskExternalRefs(WORKSPACE_ID, TASK_ID),
      await service.listExternalRefStateHistory(WORKSPACE_ID, TASK_ID, REF_ID.toString()),
      await service.listTaskRuns(WORKSPACE_ID, TASK_ID),
      await service.listRunStageOccurrences(WORKSPACE_ID, TASK_ID, RUN_ID),
      await service.listTaskCodeChanges(WORKSPACE_ID, TASK_ID),
      await service.listTaskShipEvidence(WORKSPACE_ID, TASK_ID),
      await service.listTaskReworkSignals(WORKSPACE_ID, TASK_ID),
      await service.listTaskArtifacts(WORKSPACE_ID, TASK_ID),
    ];

    expect(results).toEqual([
      {
        items: [
          {
            id: REF_ID.toString(),
            provider: 'jira',
            externalId: '10042',
            externalKey: 'CORE-42',
            externalUrl: 'https://jira.example.test/browse/CORE-42',
            externalState: 'In Progress',
            connectorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            sourceUpdatedAt: CREATED_AT.toISOString(),
            lastObservedAt: UPDATED_AT.toISOString(),
            isAuthority: false,
            stateFactCount: 2,
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            id: '42',
            fromState: 'Done',
            toState: 'In Progress',
            sourceRef: 'jira:history:1',
            occurredAt: CREATED_AT.toISOString(),
            sourceUpdatedAt: UPDATED_AT.toISOString(),
            receivedAt: refReceivedAt.toISOString(),
            actorId: null,
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            runId: RUN_ID,
            workflowId: 'change:normal',
            intent: 'change',
            risk: 'normal',
            scale: 'normal',
            repositoryKey: 'coredoc/coredoc-parser',
            startedAt: CREATED_AT.toISOString(),
            finishedAt: UPDATED_AT.toISOString(),
            outcome: 'failed',
            verification: { runs: 2, failures: 1, editVerifyRounds: null },
            workItems: [],
          },
          {
            runId: 'cdr-20260817-b2c3d4',
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
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            occurrenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            runId: RUN_ID,
            stageId: 'tdd',
            attempt: 2,
            startedAt: CREATED_AT.toISOString(),
            finishedAt: UPDATED_AT.toISOString(),
            outcome: 'success',
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            provider: 'github',
            repoExternalId: 'repo-1',
            externalId: 'pr-42',
            number: 42,
            title: 'Bounded reads',
            state: 'merged',
            isDraft: false,
            sourceBranch: 'feature/c7',
            targetBranch: 'main',
            createdAtSource: CREATED_AT.toISOString(),
            readyForReviewAt: null,
            firstReviewAt: null,
            approvedAt: null,
            mergedAt: UPDATED_AT.toISOString(),
            updatedAt: UPDATED_AT.toISOString(),
            associationSource: 'issue_key',
            associationSourceValue: 'CORE-42',
            externalUrl: null,
            reviewCount: null,
            commentCount: null,
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            id: '43',
            source: 'github_pr_merged',
            sourceKey: 'ship:42',
            occurredAt: UPDATED_AT.toISOString(),
            receivedAt: refReceivedAt.toISOString(),
            actorId: null,
            provider: 'github',
            repoExternalId: 'repo-1',
            externalId: 'pr-42',
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            id: '44',
            kind: 'stage_reentry',
            sourceKey: 'occurrence-2',
            sourceRef: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            occurredAt: CREATED_AT.toISOString(),
            observedAt: UPDATED_AT.toISOString(),
          },
        ],
        nextCursor: null,
      },
      {
        items: [
          {
            id: 'cda_ffffffff-ffff-4fff-8fff-ffffffffffff',
            repositoryKey: 'coredoc/coredoc-parser',
            kind: 'spec',
            createdBy: 'actor-1',
            createdAt: CREATED_AT.toISOString(),
            updatedAt: UPDATED_AT.toISOString(),
            revisionCount: 2,
          },
        ],
        nextCursor: null,
      },
    ]);
    expect(vi.mocked(prisma.deliveryTaskCodeChange.findMany).mock.calls[0]?.[0].orderBy).toEqual([
      { codeChange: { createdAtSource: { sort: 'asc', nulls: 'last' } } },
      { codeChangeId: 'asc' },
    ]);
    expect(vi.mocked(prisma.deliveryArtifact.findMany).mock.calls[0]?.[0].select).not.toHaveProperty('markdown');
  });

  it('checks workspace ownership before decoding a nested cursor', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const service = new CanonicalDeliveryService(
      mockPrisma({ deliveryTask: { findUnique }, workflowRun: { findMany, findFirst: vi.fn() } }),
    );

    await expect(service.listTaskRuns(WORKSPACE_ID, TASK_ID, '50', 'not+base64')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor after confirming the workspace task exists', async () => {
    const service = new CanonicalDeliveryService(mockPrisma());
    const result = service.listTaskRuns(WORKSPACE_ID, TASK_ID, '50', 'not+base64');
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: {
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_DELIVERY_CURSOR',
        message: 'Invalid canonical delivery cursor',
      },
    });
  });

  it('keeps exact run and artifact keys self-contained when the prior boundary row was deleted', async () => {
    const prisma = mockPrisma();
    const exactBoundary = '2026-08-17T10:05:00.123456Z';
    const nextRunId = 'cdr-20260817-b2c3d4';
    const nextRunTimestamp = '2026-08-17T10:05:00.123457Z';
    const nextArtifactId = 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const nextArtifactTimestamp = '2026-08-17T10:05:00.123457Z';
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { runId: nextRunId, cursorCreatedAt: nextRunTimestamp },
        { runId: 'cdr-20260817-c3d4e5', cursorCreatedAt: '2026-08-17T10:05:00.123458Z' },
      ] as never)
      .mockResolvedValueOnce([
        { id: nextArtifactId, cursorCreatedAt: nextArtifactTimestamp },
        {
          id: 'cda_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          cursorCreatedAt: '2026-08-17T10:05:00.123458Z',
        },
      ] as never);
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([
      {
        runId: nextRunId,
        workflowId: null,
        intent: null,
        risk: null,
        scale: null,
        repositoryKey: null,
        startedAt: null,
        finishedAt: null,
        outcome: null,
        counters: null,
        workItems: [],
      } as never,
    ]);
    vi.mocked(prisma.deliveryArtifact.findMany).mockResolvedValue([
      {
        id: nextArtifactId,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'design',
        createdBy: 'actor-1',
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        revisions: [],
        _count: { revisions: 0 },
      } as never,
    ]);
    const service = new CanonicalDeliveryService(prisma);
    const runCursor = encodeDeliveryCursor(deliveryCursorScope.taskRuns(TASK_ID), [exactBoundary, RUN_ID]);
    const artifactId = 'cda_ffffffff-ffff-4fff-8fff-ffffffffffff';
    const artifactCursor = encodeDeliveryCursor(deliveryCursorScope.taskArtifacts(TASK_ID), [
      exactBoundary,
      artifactId,
    ]);

    const runPage = await service.listTaskRuns(WORKSPACE_ID, TASK_ID, '1', runCursor);
    const artifactPage = await service.listTaskArtifacts(WORKSPACE_ID, TASK_ID, '1', artifactCursor);

    expect(prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    expect(prisma.deliveryArtifact.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID, runId: { in: [nextRunId] } },
      }),
    );
    expect(prisma.deliveryArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID, deliveryTaskId: TASK_ID, id: { in: [nextArtifactId] } },
      }),
    );
    expect(
      decodeDeliveryCursor(runPage.nextCursor, deliveryCursorScope.taskRuns(TASK_ID), [
        'exact_timestamp',
        'run_id',
      ] as const),
    ).toEqual([nextRunTimestamp, nextRunId]);
    expect(
      decodeDeliveryCursor(artifactPage.nextCursor, deliveryCursorScope.taskArtifacts(TASK_ID), [
        'exact_timestamp',
        'artifact_id',
      ] as const),
    ).toEqual([nextArtifactTimestamp, nextArtifactId]);

    const runSql = vi.mocked(prisma.$queryRaw).mock.calls[0]?.[0] as { values: unknown[] };
    const artifactSql = vi.mocked(prisma.$queryRaw).mock.calls[1]?.[0] as { values: unknown[] };
    expect(runSql.values).toEqual(expect.arrayContaining([exactBoundary, RUN_ID]));
    expect(artifactSql.values).toEqual(expect.arrayContaining([exactBoundary, artifactId]));
  });
});

describe('CanonicalDeliveryService task ship state', () => {
  it('reports partial/shipped/none from the linked code-change states of the page', async () => {
    const findMany = vi.fn().mockResolvedValue([
      summaryRow(),
      summaryRow({
        id: OTHER_TASK_ID,
        updatedAt: CREATED_AT,
        shipEvidence: [],
        _count: { ...summaryRow()._count, shipEvidence: 0 },
      }),
    ]);
    const links = vi.fn().mockResolvedValue([
      { deliveryTaskId: TASK_ID, codeChange: { state: 'merged' } },
      { deliveryTaskId: TASK_ID, codeChange: { state: 'open' } },
      // Closed without merge: neither shipped nor blocking.
      { deliveryTaskId: TASK_ID, codeChange: { state: 'closed' } },
      { deliveryTaskId: OTHER_TASK_ID, codeChange: { state: 'open' } },
    ]);
    const service = new CanonicalDeliveryService(
      mockPrisma({ deliveryTask: { findMany }, deliveryTaskCodeChange: { findMany: links } }),
    );

    const page = await service.listTaskSummaries(WORKSPACE_ID, '10');

    expect(page.tasks[0]).toMatchObject({
      shipState: 'partial',
      counts: expect.objectContaining({ mergedCodeChanges: 1, openCodeChanges: 1 }),
    });
    // Never shipped: an open code change alone is not a partial ship.
    expect(page.tasks[1]).toMatchObject({
      shipState: 'none',
      counts: expect.objectContaining({ mergedCodeChanges: 0, openCodeChanges: 1 }),
    });
    expect(links).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE_ID, deliveryTaskId: { in: [TASK_ID, OTHER_TASK_ID] } },
      }),
    );
  });
});

describe('CanonicalDeliveryService delivery population filters (BR-6)', () => {
  const NOW = new Date('2026-08-31T18:20:00.000Z');
  // days = 30 aligned to UTC midnight: 2026-08-31 00:00Z minus 29 days.
  const SINCE_30 = new Date('2026-08-02T00:00:00.000Z');
  const SINCE_90 = new Date('2026-06-03T00:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['all', { updatedAt: { gte: SINCE_30, lt: NOW } }],
    [
      'shipped',
      {
        updatedAt: { gte: SINCE_30, lt: NOW },
        shipEvidence: { some: {} },
        // Fully shipped only: an open linked code change makes the ship partial.
        codeChanges: { none: { codeChange: { state: 'open' } } },
      },
    ],
    ['active', { updatedAt: { gte: SINCE_30, lt: NOW }, lifecycle: 'active' }],
    [
      'rework',
      {
        updatedAt: { gte: SINCE_30, lt: NOW },
        reworkSignals: {
          some: { kind: { in: ['tracker_reopened', 'review_changes_requested', 'review_commented'] } },
        },
      },
    ],
  ])('pages the %s population with the window and filter applied server-side', async (lifecycle, expected) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany } }));

    await service.listTaskSummaries(WORKSPACE_ID, '10', undefined, '30', lifecycle);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE_ID, ...expected } }),
    );
  });

  it('selects the rework population from the counted signal kinds alone, ignoring stage re-entries', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    // No helper query at all: a stage re-entry is an iteration fact, not rework.
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany }, $queryRaw }));

    await service.listTaskSummaries(WORKSPACE_ID, '10', undefined, '30', 'rework');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: WORKSPACE_ID,
          updatedAt: { gte: SINCE_30, lt: NOW },
          reworkSignals: {
            some: { kind: { in: ['tracker_reopened', 'review_changes_requested', 'review_commented'] } },
          },
        },
      }),
    );
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('restricts the population to one member, nested under AND so the cursor cannot displace it', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const $queryRaw = vi.fn().mockResolvedValue([{ taskId: TASK_ID }]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany }, $queryRaw }));
    const cursor = encodeDeliveryCursor(deliveryCursorScope.taskSummaries({ days: 30 }, 'all', MEMBER_ID), [
      UPDATED_AT.toISOString(),
      TASK_ID,
    ]);

    await service.listTaskSummaries(WORKSPACE_ID, '1', cursor, '30', 'all', undefined, undefined, MEMBER_ID);

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toEqual([{ id: { in: [TASK_ID] } }]);
    expect(where.OR).toEqual([{ updatedAt: { lt: UPDATED_AT } }, { updatedAt: UPDATED_AT, id: { lt: TASK_ID } }]);
    // The member id is a bound SQL parameter of the window-scoped association helper.
    const sql = $queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(sql.values).toEqual(expect.arrayContaining([WORKSPACE_ID, MEMBER_ID, SINCE_30]));
    expect(sql.sql).toContain('session."user_id"');
  });

  it('counts only the rework kinds the summary counts', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany } }));

    await service.listTaskSummaries(WORKSPACE_ID, '1');

    expect(findMany.mock.calls[0]?.[0]?.select?._count?.select?.reworkSignals).toEqual({
      where: { kind: { in: ['tracker_reopened', 'review_changes_requested', 'review_commented'] } },
    });
  });

  it('reuses the member association for the runs filter instead of querying it twice', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ taskId: TASK_ID }]);
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany }, $queryRaw }));

    await service.listTaskSummaries(WORKSPACE_ID, '1', undefined, '30', 'runs', undefined, undefined, MEMBER_ID);

    // The member's associated tasks are a subset of all run-associated tasks, so one query
    // answers both filters.
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.id).toEqual({ in: [TASK_ID] });
    expect(where.AND).toEqual([{ id: { in: [TASK_ID] } }]);
  });

  it('refuses a cursor minted for another member', async () => {
    const service = new CanonicalDeliveryService(mockPrisma());
    const otherMemberCursor = encodeDeliveryCursor(
      deliveryCursorScope.taskSummaries({ days: 30 }, 'all', 'user-other'),
      [UPDATED_AT.toISOString(), TASK_ID],
    );

    await expect(
      service.listTaskSummaries(WORKSPACE_ID, '1', otherMemberCursor, '30', 'all', undefined, undefined, MEMBER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('associates the runs population per run without any re-entry requirement', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const service = new CanonicalDeliveryService(mockPrisma({ $queryRaw }));

    await service.listTaskSummaries(WORKSPACE_ID, '10', undefined, '30', 'runs');

    const sql = ($queryRaw.mock.calls[0]?.[0] as { sql: string }).sql;
    // The work-item association is per run...
    expect(sql).toContain('item."workflow_run_id" = run."id"');
    // ...and nothing in the helper asks about stage attempts any more.
    expect(sql).not.toContain('occurrence."attempt"');
  });

  it('keeps the rework KPI and the rework list on one population', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const $queryRaw = vi.fn().mockResolvedValue([{ taskId: TASK_ID }]);
    const service = new CanonicalDeliveryService(mockPrisma({ deliveryTask: { findMany }, $queryRaw }));

    await service.getDeliverySummary(WORKSPACE_ID, '30', 'rework');
    const summaryWhere = findMany.mock.calls[0]?.[0]?.where;
    findMany.mockClear();
    await service.listTaskSummaries(WORKSPACE_ID, '10', undefined, '30', 'rework');
    const listWhere = findMany.mock.calls[0]?.[0]?.where;

    expect(summaryWhere).toEqual(listWhere);
  });

  it('keeps the unfiltered call byte-identical to the pre-filter behavior', async () => {
    const findMany = vi.fn().mockResolvedValue([summaryRow(), summaryRow({ id: OTHER_TASK_ID })]);
    const service = new CanonicalDeliveryService(
      mockPrisma({ deliveryTask: { findMany }, $queryRaw: vi.fn().mockResolvedValue([]) }),
    );

    const page = await service.listTaskSummaries(WORKSPACE_ID, '1');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WORKSPACE_ID } }));
    expect(
      decodeDeliveryCursor(page.nextCursor, deliveryCursorScope.taskSummaries(null, 'all'), [
        'timestamp',
        'task_id',
      ] as const),
    ).toEqual([UPDATED_AT, TASK_ID]);
  });

  it('clamps the window to the analytics ceiling and binds the clamped value to the cursor scope', async () => {
    const findMany = vi.fn().mockResolvedValue([summaryRow(), summaryRow({ id: OTHER_TASK_ID })]);
    const service = new CanonicalDeliveryService(
      mockPrisma({ deliveryTask: { findMany }, $queryRaw: vi.fn().mockResolvedValue([]) }),
    );

    const page = await service.listTaskSummaries(WORKSPACE_ID, '1', undefined, '1000', 'shipped');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: WORKSPACE_ID,
          updatedAt: { gte: SINCE_90, lt: NOW },
          shipEvidence: { some: {} },
          codeChanges: { none: { codeChange: { state: 'open' } } },
        },
      }),
    );
    expect(
      decodeDeliveryCursor(page.nextCursor, deliveryCursorScope.taskSummaries({ days: 90 }, 'shipped'), [
        'timestamp',
        'task_id',
      ] as const),
    ).toEqual([UPDATED_AT, TASK_ID]);
  });

  it('refuses a cursor minted under another population filter', async () => {
    const service = new CanonicalDeliveryService(mockPrisma());
    const shippedCursor = encodeDeliveryCursor(deliveryCursorScope.taskSummaries({ days: 30 }, 'shipped'), [
      UPDATED_AT.toISOString(),
      TASK_ID,
    ]);

    await expect(service.listTaskSummaries(WORKSPACE_ID, '1', shippedCursor, '30', 'all')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.listTaskSummaries(WORKSPACE_ID, '1', shippedCursor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.listTaskSummaries(WORKSPACE_ID, '1', shippedCursor, '30', 'shipped')).resolves.toMatchObject({
      tasks: [],
    });
  });

  it('rejects an unknown lifecycle filter on both reads', async () => {
    const service = new CanonicalDeliveryService(mockPrisma());

    await expect(service.listTaskSummaries(WORKSPACE_ID, '1', undefined, '30', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.getDeliverySummary(WORKSPACE_ID, '30', 'bogus')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CanonicalDeliveryService.getDeliverySummary read composition', () => {
  const NOW = new Date('2026-08-31T18:20:00.000Z');
  const SINCE_30 = new Date('2026-08-02T00:00:00.000Z');
  const RUN_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const SESSION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function summaryPrisma() {
    return mockPrisma({
      deliveryTask: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: TASK_ID,
            createdAt: new Date('2026-08-10T00:00:00.000Z'),
            updatedAt: new Date('2026-08-10T05:00:00.000Z'),
            lifecycle: 'completed',
            shipEvidence: [{ occurredAt: new Date('2026-08-10T04:00:00.000Z') }],
            _count: { reworkSignals: 1 },
          },
          {
            id: OTHER_TASK_ID,
            createdAt: new Date('2026-08-11T00:00:00.000Z'),
            updatedAt: new Date('2026-08-11T02:00:00.000Z'),
            lifecycle: 'active',
            shipEvidence: [],
            _count: { reworkSignals: 0 },
          },
        ]),
      },
      // One run associated with both tasks: the distinct-pair rows the association SQL yields.
      $queryRaw: vi.fn().mockResolvedValue([
        { taskId: TASK_ID, runId: RUN_UUID },
        { taskId: OTHER_TASK_ID, runId: RUN_UUID },
      ]),
      workflowStageOccurrence: {
        findMany: vi.fn().mockResolvedValue([
          {
            workflowRunId: RUN_UUID,
            stageId: 'review',
            attempt: 1,
            startedAt: new Date('2026-08-10T00:00:00.000Z'),
            finishedAt: new Date('2026-08-10T01:00:00.000Z'),
          },
          {
            workflowRunId: RUN_UUID,
            stageId: 'review',
            attempt: 2,
            startedAt: new Date('2026-08-10T01:00:00.000Z'),
            finishedAt: new Date('2026-08-10T01:30:00.000Z'),
          },
        ]),
      },
      workflowRun: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: RUN_UUID, counters: { editVerifyRounds: 4 }, agentSessionId: SESSION_ID }]),
      },
      deliveryReworkSignal: {
        findMany: vi.fn().mockResolvedValue([{ deliveryTaskId: TASK_ID, kind: 'tracker_reopened' }]),
      },
      deliveryTaskCodeChange: {
        findMany: vi.fn().mockResolvedValue([
          {
            deliveryTaskId: TASK_ID,
            codeChangeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            codeChange: {
              state: 'merged',
              readyForReviewAt: new Date('2026-08-10T00:00:00.000Z'),
              firstReviewAt: new Date('2026-08-10T02:00:00.000Z'),
            },
          },
        ]),
      },
      agentSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: SESSION_ID,
            provider: 'claude-code',
            model: 'claude-sonnet-4-6',
            tokensInput: 1_000_000,
            tokensOutput: 0,
            tokensCacheRead: 0,
            tokensCacheCreation: 0,
            tokensReasoning: 0,
          },
        ]),
      },
    });
  }

  it('composes the bounded reads into the folded summary for the named window', async () => {
    const prisma = summaryPrisma();
    const service = new CanonicalDeliveryService(prisma);

    await expect(service.getDeliverySummary(WORKSPACE_ID, '30', 'shipped')).resolves.toEqual({
      window: {
        days: 30,
        since: SINCE_30.toISOString(),
        until: NOW.toISOString(),
        lifecycle: 'shipped',
        userId: null,
      },
      // Only the task with a stored `tracker_reopened` signal is reworked: the shared run's
      // re-entered review stage is an iteration fact, not rework.
      tasks: { matching: 2, shipped: 1, partiallyShipped: 0, withRework: 1, active: 1 },
      leadTimeMs: { value: 4 * 3_600_000, sampleSize: 1 },
      reviewStageMs: { value: 1.5 * 3_600_000, sampleSize: 2 },
      costPerShippedTaskUsd: { value: 3, sampleSize: 1, unpricedTasks: 0 },
      stages: [
        { stageId: 'review', claimedMs: { value: 1.5 * 3_600_000, sampleSize: 2 }, incomplete: 0, inProgress: 0 },
      ],
      unclaimedMs: { value: 1.5 * 3_600_000, sampleSize: 2 },
      reviewWaitMs: { value: 2 * 3_600_000, sampleSize: 1 },
      editVerifyRoundsPerRun: { value: 4, sampleSize: 1 },
      rework: {
        bySource: [
          { kind: 'tracker_reopened', signals: 1, tasks: 1 },
          { kind: 'review_changes_requested', signals: 0, tasks: 0 },
          { kind: 'review_commented', signals: 0, tasks: 0 },
        ],
      },
    });
    expect(prisma.deliveryTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: WORKSPACE_ID,
          updatedAt: { gte: SINCE_30, lt: NOW },
          shipEvidence: { some: {} },
          codeChanges: { none: { codeChange: { state: 'open' } } },
        },
      }),
    );
    // The population read is bounded by the window, never by a page size.
    expect(vi.mocked(prisma.deliveryTask.findMany).mock.calls[0]?.[0]).not.toHaveProperty('take');
  });

  it('downgrades a shipped task with an open linked code change to partial, out of every shipped sample', async () => {
    const prisma = summaryPrisma();
    vi.mocked(prisma.deliveryTaskCodeChange.findMany).mockResolvedValue([
      {
        deliveryTaskId: TASK_ID,
        codeChangeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        codeChange: { state: 'open', readyForReviewAt: null, firstReviewAt: null },
      },
    ] as never);
    const service = new CanonicalDeliveryService(prisma);

    const summary = await service.getDeliverySummary(WORKSPACE_ID, '30');

    expect(summary.tasks).toMatchObject({ shipped: 0, partiallyShipped: 1 });
    expect(summary.leadTimeMs).toEqual({ value: null, sampleSize: 0 });
    // Cost per SHIPPED task: a partial ship is not one.
    expect(summary.costPerShippedTaskUsd).toEqual({ value: null, sampleSize: 0, unpricedTasks: 0 });
  });

  it('leaves a shipped task whose only session reported no usage out of the cost sample entirely', async () => {
    const prisma = summaryPrisma();
    vi.mocked(prisma.agentSession.findMany).mockResolvedValue([
      {
        id: SESSION_ID,
        provider: 'claude-code',
        model: 'claude-sonnet-4-6',
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
      },
    ] as never);
    const service = new CanonicalDeliveryService(prisma);

    const summary = await service.getDeliverySummary(WORKSPACE_ID, '30', 'shipped');

    // No usage was ever priceable, so the task is not evidence of an unpriced model.
    expect(summary.costPerShippedTaskUsd).toEqual({ value: null, sampleSize: 0, unpricedTasks: 0 });
  });

  it('scopes stage occurrences through the workflow run relation and deduplicates the association', async () => {
    const prisma = summaryPrisma();
    const service = new CanonicalDeliveryService(prisma);

    await service.getDeliverySummary(WORKSPACE_ID, '30');

    expect(prisma.workflowStageOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowRun: { workspaceId: WORKSPACE_ID, id: { in: [RUN_UUID] } } },
      }),
    );
    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE_ID, id: { in: [RUN_UUID] } } }),
    );
    const associationSql = vi.mocked(prisma.$queryRaw).mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(associationSql.sql).toContain('SELECT DISTINCT');
    expect(associationSql.values).toEqual(expect.arrayContaining([WORKSPACE_ID, TASK_ID, OTHER_TASK_ID]));
  });

  it('reads nothing beyond the population when the window and filter match no task', async () => {
    const prisma = mockPrisma({ deliveryTask: { findMany: vi.fn().mockResolvedValue([]) } });
    const service = new CanonicalDeliveryService(prisma);

    const summary = await service.getDeliverySummary(WORKSPACE_ID, undefined, 'rework');

    expect(summary.window).toEqual({
      days: 30,
      since: SINCE_30.toISOString(),
      until: NOW.toISOString(),
      lifecycle: 'rework',
      userId: null,
    });
    expect(summary.tasks).toEqual({ matching: 0, shipped: 0, partiallyShipped: 0, withRework: 0, active: 0 });
    expect(summary.leadTimeMs).toEqual({ value: null, sampleSize: 0 });
    // The rework filter is a plain relation predicate now, so no helper query runs at all and
    // the association fan-out never starts.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.workflowStageOccurrence.findMany).not.toHaveBeenCalled();
  });
});

describe('CanonicalDeliveryService.listTaskCodeChanges source timestamps', () => {
  it('exposes the PR lifecycle timestamps the trace lane needs', async () => {
    const prisma = mockPrisma({
      deliveryTaskCodeChange: {
        findMany: vi.fn().mockResolvedValue([
          {
            associationSource: 'issue_key',
            associationSourceValue: 'CORE-42',
            codeChange: {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              provider: 'github',
              repoExternalId: 'repo-1',
              externalId: 'pr-42',
              number: 42,
              title: 'Bounded reads',
              state: 'merged',
              isDraft: false,
              sourceBranch: 'feature/c7',
              targetBranch: 'main',
              mergedAt: new Date('2026-08-17T14:00:00.000Z'),
              updatedAt: UPDATED_AT,
              createdAtSource: new Date('2026-08-17T09:00:00.000Z'),
              readyForReviewAt: new Date('2026-08-17T10:00:00.000Z'),
              firstReviewAt: new Date('2026-08-17T11:00:00.000Z'),
              approvedAt: null,
              externalUrl: null,
              reviewCount: null,
              commentCount: null,
            },
          },
        ]),
      },
    });
    const service = new CanonicalDeliveryService(prisma);

    const page = await service.listTaskCodeChanges(WORKSPACE_ID, TASK_ID);

    expect(page.items[0]).toMatchObject({
      createdAtSource: '2026-08-17T09:00:00.000Z',
      readyForReviewAt: '2026-08-17T10:00:00.000Z',
      firstReviewAt: '2026-08-17T11:00:00.000Z',
      approvedAt: null,
    });
    expect(vi.mocked(prisma.deliveryTaskCodeChange.findMany).mock.calls[0]?.[0]).toMatchObject({
      select: {
        codeChange: {
          select: expect.objectContaining({ readyForReviewAt: true, firstReviewAt: true, approvedAt: true }),
        },
      },
    });
  });
});
