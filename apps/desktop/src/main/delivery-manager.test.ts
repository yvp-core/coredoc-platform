import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';

// Mock the transport so no real network runs. A local ApiError class stands in
// for server-api's — the manager imports ApiError from the same (mocked) module,
// so `err instanceof ApiError` matches the rejections we construct here.
const {
  getCanonicalTasksMock,
  getCanonicalTaskSummariesMock,
  getCanonicalTaskDetailMock,
  getCanonicalTaskExternalRefsMock,
  getCanonicalExternalRefStateHistoryMock,
  getCanonicalTaskRunsMock,
  getCanonicalRunStageOccurrencesMock,
  getCanonicalTaskCodeChangesMock,
  getCanonicalTaskShipEvidenceMock,
  getCanonicalTaskReworkSignalsMock,
  getCanonicalTaskArtifactsMock,
  getCanonicalArtifactRevisionsMock,
  openExternalMock,
  ApiErrorClass,
} = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    getCanonicalTasksMock: vi.fn(),
    getCanonicalTaskSummariesMock: vi.fn(),
    getCanonicalTaskDetailMock: vi.fn(),
    getCanonicalTaskExternalRefsMock: vi.fn(),
    getCanonicalExternalRefStateHistoryMock: vi.fn(),
    getCanonicalTaskRunsMock: vi.fn(),
    getCanonicalRunStageOccurrencesMock: vi.fn(),
    getCanonicalTaskCodeChangesMock: vi.fn(),
    getCanonicalTaskShipEvidenceMock: vi.fn(),
    getCanonicalTaskReworkSignalsMock: vi.fn(),
    getCanonicalTaskArtifactsMock: vi.fn(),
    getCanonicalArtifactRevisionsMock: vi.fn(),
    openExternalMock: vi.fn(async () => undefined),
    ApiErrorClass: ApiError,
  };
});

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }));

vi.mock('./server-api.js', () => ({
  ApiError: ApiErrorClass,
  getCanonicalDeliveryTasks: getCanonicalTasksMock,
  getCanonicalTaskSummaries: getCanonicalTaskSummariesMock,
  getCanonicalTaskDetail: getCanonicalTaskDetailMock,
  getCanonicalTaskExternalRefs: getCanonicalTaskExternalRefsMock,
  getCanonicalExternalRefStateHistory: getCanonicalExternalRefStateHistoryMock,
  getCanonicalTaskRuns: getCanonicalTaskRunsMock,
  getCanonicalRunStageOccurrences: getCanonicalRunStageOccurrencesMock,
  getCanonicalTaskCodeChanges: getCanonicalTaskCodeChangesMock,
  getCanonicalTaskShipEvidence: getCanonicalTaskShipEvidenceMock,
  getCanonicalTaskReworkSignals: getCanonicalTaskReworkSignalsMock,
  getCanonicalTaskArtifacts: getCanonicalTaskArtifactsMock,
  getCanonicalArtifactRevisions: getCanonicalArtifactRevisionsMock,
}));

/** Minimal ipcMain double that records handlers registered against it. */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, IpcHandler> } {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

async function registered() {
  const { registerDeliveryHandlers } = await import('./delivery-manager.js');
  const { ipcMain, handlers } = fakeIpcMain();
  registerDeliveryHandlers(ipcMain);
  return handlers;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('canonical delivery IPC boundary', () => {
  const taskResponse = {
    tasks: [
      {
        id: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryKey: 'acme/widgets',
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: 'actor-1',
        createdAt: '2026-08-16T10:00:00.000Z',
        updatedAt: '2026-08-16T10:05:00.000Z',
        cloudAuthorization: 'Bearer secret-renderer-sentinel',
        externalRefs: [
          {
            provider: 'jira-cloud',
            externalId: '10001',
            externalKey: 'CORE-42',
            externalUrl: 'https://jira.example/browse/CORE-42',
            externalState: 'in_progress',
            bindingNonce: 'secret-renderer-sentinel',
          },
        ],
        workflowRuns: [
          {
            runId: 'cdr-20260816-a1b2c3',
            actorId: 'actor-1',
            workflowId: 'change:normal',
            intent: 'change',
            risk: 'normal',
            scale: 'normal',
            repositoryKey: 'acme/widgets',
            declaredStages: [
              { stageId: 'spec', after: [] },
              { stageId: 'tdd', after: ['spec'] },
            ],
            startedAt: '2026-08-16T10:00:00.000Z',
            finishedAt: '2026-08-16T10:05:00.000Z',
            outcome: 'success',
            stageOccurrences: [
              {
                occurrenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                stageId: 'tdd',
                attempt: 1,
                startedAt: '2026-08-16T10:02:00.000Z',
                finishedAt: '2026-08-16T10:05:00.000Z',
                outcome: 'success',
                rawError: 'secret-renderer-sentinel',
              },
            ],
          },
        ],
        artifacts: [
          {
            id: 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            repositoryKey: 'acme/widgets',
            kind: 'spec',
            createdAt: '2026-08-16T10:01:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            localPath: '/private/secret/spec.md',
            revisions: [
              {
                id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                sha256: 'a'.repeat(64),
                byteCount: 120,
                checkpoint: 'run-finish',
                runId: 'cdr-20260816-a1b2c3',
                createdAt: '2026-08-16T10:05:00.000Z',
              },
            ],
          },
        ],
      },
    ],
  };

  it('projects canonical task responses to the bounded renderer contract', async () => {
    getCanonicalTasksMock.mockResolvedValue(taskResponse);
    const handlers = await registered();

    const response = await handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1');

    expect(response).toMatchObject({
      success: true,
      data: {
        tasks: [
          {
            id: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workflowRuns: [
              {
                declaredStages: [
                  { stageId: 'spec', after: [] },
                  { stageId: 'tdd', after: ['spec'] },
                ],
                stageOccurrences: [{ stageId: 'tdd', attempt: 1 }],
              },
            ],
            artifacts: [{ revisions: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', byteCount: 120 }] }],
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /secret-renderer-sentinel|cloudAuthorization|bindingNonce|localPath|rawError/,
    );
    expect(getCanonicalTasksMock).toHaveBeenCalledWith('ws-1');
  });

  it('returns only the explicitly requested artifact revisions and strips unexpected fields', async () => {
    getCanonicalArtifactRevisionsMock.mockResolvedValue({
      artifact: {
        id: 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryKey: 'acme/widgets',
        kind: 'spec',
        bindingNonce: 'secret-renderer-sentinel',
      },
      revisions: [
        {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          sha256: '34382ff3f4fb46d9832bbad9f841f139e115f2c3a1721e7c43d4ffe8a9dc6fe8',
          byteCount: 11,
          checkpoint: 'run-finish',
          runId: null,
          createdAt: '2026-08-16T10:05:00.000Z',
          markdown: '# Safe body',
          cloudAuthorization: 'Bearer secret-renderer-sentinel',
        },
      ],
    });
    const handlers = await registered();

    const response = await handlers.get('delivery:getCanonicalArtifactRevisions')!(
      null,
      'ws-1',
      'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(response).toEqual({
      success: true,
      data: {
        artifact: {
          id: 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          repositoryKey: 'acme/widgets',
          kind: 'spec',
        },
        revisions: [
          {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            sha256: '34382ff3f4fb46d9832bbad9f841f139e115f2c3a1721e7c43d4ffe8a9dc6fe8',
            byteCount: 11,
            checkpoint: 'run-finish',
            runId: null,
            createdAt: '2026-08-16T10:05:00.000Z',
            markdown: '# Safe body',
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain('secret-renderer-sentinel');
    expect(getCanonicalArtifactRevisionsMock).toHaveBeenCalledWith('ws-1', 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('maps server failures to bounded authorization/unavailable states without raw errors', async () => {
    getCanonicalTasksMock.mockRejectedValue(
      new ApiErrorClass(403, 'permission denied: Bearer secret-renderer-sentinel at /private/path'),
    );
    getCanonicalArtifactRevisionsMock.mockRejectedValue(
      new ApiErrorClass(500, 'upstream failed: Bearer secret-renderer-sentinel'),
    );
    const handlers = await registered();

    await expect(handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1')).resolves.toEqual({
      success: false,
      error: 'CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED',
    });
    await expect(
      handlers.get('delivery:getCanonicalArtifactRevisions')!(null, 'ws-1', 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).resolves.toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });

  it('accepts the V1-compatible unknown run outcome without widening stage outcomes', async () => {
    const response = structuredClone(taskResponse);
    response.tasks[0].workflowRuns[0].outcome = 'unknown';
    getCanonicalTasksMock.mockResolvedValue(response);
    const handlers = await registered();

    await expect(handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1')).resolves.toMatchObject({
      success: true,
      data: { tasks: [{ workflowRuns: [{ outcome: 'unknown' }] }] },
    });
  });

  it('accepts more than sixteen historical artifacts after config rotation', async () => {
    const response = structuredClone(taskResponse);
    response.tasks[0].artifacts = Array.from({ length: 17 }, (_, index) => ({
      ...response.tasks[0].artifacts[0],
      id: `cda_${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      revisions: [],
    }));
    getCanonicalTasksMock.mockResolvedValue(response);
    const handlers = await registered();

    const result = await handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1');

    expect(result).toMatchObject({ success: true });
    expect((result as { data: { tasks: Array<{ artifacts: unknown[] }> } }).data.tasks[0].artifacts).toHaveLength(17);
  });

  it('rejects contract-excessive arrays instead of creating unbounded renderer state', async () => {
    getCanonicalTasksMock.mockResolvedValue({
      tasks: Array.from({ length: 1_001 }, () => taskResponse.tasks[0]),
    });
    const handlers = await registered();

    await expect(handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1')).resolves.toEqual({
      success: false,
      error: 'CANONICAL_DELIVERY_UNAVAILABLE',
    });
  });

  it('rejects malformed canonical ids, timestamps, and digests at the IPC boundary', async () => {
    const malformedId = structuredClone(taskResponse);
    malformedId.tasks[0].id = 'task-not-canonical';
    const malformedTimestamp = structuredClone(taskResponse);
    malformedTimestamp.tasks[0].createdAt = 'sometime later';
    const malformedDigest = structuredClone(taskResponse);
    malformedDigest.tasks[0].artifacts[0].revisions[0].sha256 = 'not-a-sha256';
    getCanonicalTasksMock
      .mockResolvedValueOnce(malformedId)
      .mockResolvedValueOnce(malformedTimestamp)
      .mockResolvedValueOnce(malformedDigest);
    const handlers = await registered();

    for (let index = 0; index < 3; index += 1) {
      await expect(handlers.get('delivery:getCanonicalTasks')!(null, 'ws-1')).resolves.toEqual({
        success: false,
        error: 'CANONICAL_DELIVERY_UNAVAILABLE',
      });
    }
  });

  it('rejects artifact Markdown above one MiB before returning it to the renderer', async () => {
    getCanonicalArtifactRevisionsMock.mockResolvedValue({
      artifact: {
        id: 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryKey: 'acme/widgets',
        kind: 'spec',
      },
      revisions: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          sha256: 'a'.repeat(64),
          byteCount: 1_048_578,
          checkpoint: 'run-finish',
          runId: null,
          createdAt: '2026-08-16T10:05:00.000Z',
          markdown: 'é'.repeat(524_289),
        },
      ],
    });
    const handlers = await registered();

    await expect(
      handlers.get('delivery:getCanonicalArtifactRevisions')!(null, 'ws-1', 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).resolves.toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });

  it('rejects artifact Markdown whose byte count or server digest contradicts the content', async () => {
    const response = {
      artifact: {
        id: 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryKey: 'acme/widgets',
        kind: 'spec',
      },
      revisions: [
        {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          sha256: '34382ff3f4fb46d9832bbad9f841f139e115f2c3a1721e7c43d4ffe8a9dc6fe8',
          byteCount: 12,
          checkpoint: 'run-finish',
          runId: null,
          createdAt: '2026-08-16T10:05:00.000Z',
          markdown: '# Safe body',
        },
      ],
    };
    getCanonicalArtifactRevisionsMock.mockResolvedValueOnce(response).mockResolvedValueOnce({
      ...response,
      revisions: [{ ...response.revisions[0], byteCount: 11, sha256: 'a'.repeat(64) }],
    });
    const handlers = await registered();

    for (let index = 0; index < 2; index += 1) {
      await expect(
        handlers.get('delivery:getCanonicalArtifactRevisions')!(
          null,
          'ws-1',
          'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ),
      ).resolves.toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
    }
  });

  it('rejects a drilldown response for a different artifact identity', async () => {
    getCanonicalArtifactRevisionsMock.mockResolvedValue({
      artifact: {
        id: 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryKey: 'acme/widgets',
        kind: 'spec',
      },
      revisions: [],
    });
    const handlers = await registered();

    await expect(
      handlers.get('delivery:getCanonicalArtifactRevisions')!(null, 'ws-1', 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).resolves.toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });
});

describe('canonical delivery C7 bounded IPC', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const taskId = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runId = 'cdr-20260816-a1b2c3';
  const summary = {
    id: taskId,
    title: 'Fix flaky checkout webhook',
    repositoryKey: 'acme/widgets',
    lifecycle: 'active',
    authority: {
      kind: 'external_ref',
      externalRefId: '42',
      provider: 'jira',
      externalId: '10001',
      externalKey: 'CORE-1',
      connected: true,
      sourceCreatedAt: '2026-08-15T09:00:00.000Z',
      bindingNonce: 'secret-renderer-sentinel',
    },
    createdBy: 'actor-1',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:05:00.000Z',
    everShipped: true,
    lastShippedAt: '2026-08-16T10:04:00.000Z',
    shipState: 'partial',
    counts: {
      externalRefs: 1,
      workflowRuns: 1,
      codeChanges: 2,
      mergedCodeChanges: 1,
      openCodeChanges: 1,
      shipEvidence: 1,
      reworkSignals: 1,
      artifacts: 1,
    },
    cloudAuthorization: 'Bearer secret-renderer-sentinel',
  };

  it('projects bounded summaries and scalar detail while stripping non-contract fields', async () => {
    getCanonicalTaskSummariesMock.mockResolvedValue({ tasks: [summary], nextCursor: 'next-page', raw: 'secret' });
    getCanonicalTaskDetailMock.mockResolvedValue({
      ...summary,
      fineEventRetention: {
        policyDays: 90,
        purgedThroughReceivedAt: '2026-05-01T00:00:00.000Z',
        missingCount: 99,
      },
      estimatedCost: { totalUsd: 12.34, sessions: 3, unpricedSessions: 1 },
    });
    const handlers = await registered();

    const summaries = await handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 50);
    const detail = await handlers.get('delivery:getCanonicalTaskDetail')!(null, workspaceId, taskId);

    expect(summaries).toEqual({
      success: true,
      data: {
        tasks: [
          {
            id: taskId,
            title: 'Fix flaky checkout webhook',
            repositoryKey: 'acme/widgets',
            lifecycle: 'active',
            authority: {
              kind: 'external_ref',
              externalRefId: '42',
              provider: 'jira',
              externalId: '10001',
              externalKey: 'CORE-1',
              connected: true,
              sourceCreatedAt: '2026-08-15T09:00:00.000Z',
            },
            createdBy: 'actor-1',
            createdAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
            everShipped: true,
            lastShippedAt: '2026-08-16T10:04:00.000Z',
            shipState: 'partial',
            counts: summary.counts,
          },
        ],
        nextCursor: 'next-page',
      },
    });
    expect(detail).toMatchObject({
      success: true,
      data: {
        id: taskId,
        title: 'Fix flaky checkout webhook',
        fineEventRetention: {
          policyDays: 90,
          purgedThroughReceivedAt: '2026-05-01T00:00:00.000Z',
        },
        estimatedCost: { totalUsd: 12.34, sessions: 3, unpricedSessions: 1 },
      },
    });
    expect(JSON.stringify({ summaries, detail })).not.toMatch(
      /secret-renderer-sentinel|cloudAuthorization|bindingNonce/,
    );
    expect(getCanonicalTaskSummariesMock).toHaveBeenCalledWith(workspaceId, 50, undefined);
    expect(getCanonicalTaskDetailMock).toHaveBeenCalledWith(workspaceId, taskId);
  });

  it('passes through sessionsWithoutUsage when the server supplies it (C5)', async () => {
    getCanonicalTaskDetailMock.mockResolvedValue({
      ...summary,
      fineEventRetention: { policyDays: 90, purgedThroughReceivedAt: null },
      estimatedCost: { totalUsd: null, sessions: 2, unpricedSessions: 0, sessionsWithoutUsage: 2 },
    });
    const handlers = await registered();

    const detail = await handlers.get('delivery:getCanonicalTaskDetail')!(null, workspaceId, taskId);

    expect(detail).toMatchObject({
      success: true,
      data: { estimatedCost: { totalUsd: null, sessions: 2, unpricedSessions: 0, sessionsWithoutUsage: 2 } },
    });
  });

  it('tolerates an older server that omits sessionsWithoutUsage by defaulting to 0 (C5)', async () => {
    getCanonicalTaskDetailMock.mockResolvedValue({
      ...summary,
      fineEventRetention: { policyDays: 90, purgedThroughReceivedAt: null },
      estimatedCost: { totalUsd: 12.34, sessions: 3, unpricedSessions: 1 },
    });
    const handlers = await registered();

    const detail = await handlers.get('delivery:getCanonicalTaskDetail')!(null, workspaceId, taskId);

    expect(detail).toMatchObject({
      success: true,
      data: { estimatedCost: { totalUsd: 12.34, sessions: 3, unpricedSessions: 1, sessionsWithoutUsage: 0 } },
    });
  });

  it.each([
    ['an impossible calendar date', '2026-02-31T10:00:00.000Z'],
    ['hour 24', '2026-08-16T24:00:00.000Z'],
  ])('rejects %s even when the timestamp is ISO-shaped', async (_case, createdAt) => {
    getCanonicalTaskSummariesMock.mockResolvedValue({
      tasks: [{ ...summary, createdAt }],
      nextCursor: null,
    });
    const handlers = await registered();

    await expect(handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 50)).resolves.toEqual({
      success: false,
      error: 'CANONICAL_DELIVERY_UNAVAILABLE',
    });
  });

  it('preserves exact nullable verification facts and only the two accepted non-causal signal kinds', async () => {
    getCanonicalTaskRunsMock.mockResolvedValue({
      items: [
        {
          runId,
          workflowId: 'change:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'normal',
          repositoryKey: 'acme/widgets',
          startedAt: '2026-08-16T10:00:00.000Z',
          finishedAt: '2026-08-16T10:05:00.000Z',
          outcome: 'success',
          verification: { runs: 3, failures: 1, editVerifyRounds: null },
          workItems: [
            {
              provider: 'jira',
              externalId: '10042',
              externalKey: 'CORE-123',
              linked: true,
              rawProviderPayload: 'secret-renderer-sentinel',
            },
            {
              provider: 'linear.issue',
              externalId: 'lin_42',
              externalKey: null,
              linked: false,
            },
          ],
          rawError: 'secret-renderer-sentinel',
        },
        {
          runId: 'cdr-20260816-d4e5f6',
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
    });
    getCanonicalTaskReworkSignalsMock.mockResolvedValue({
      items: [
        {
          id: '7',
          kind: 'stage_reentry',
          sourceKey: 'stage:2',
          sourceRef: 'occurrence-2',
          occurredAt: '2026-08-16T10:03:00.000Z',
          observedAt: '2026-08-16T10:03:01.000Z',
        },
        {
          id: '8',
          kind: 'tracker_reopened',
          sourceKey: 'jira-transition:abc',
          sourceRef: 'jira-transition:abc',
          occurredAt: '2026-08-16T10:04:00.000Z',
          observedAt: '2026-08-16T10:04:01.000Z',
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    const runs = await handlers.get('delivery:getCanonicalTaskRuns')!(null, workspaceId, taskId, 50);
    const signals = await handlers.get('delivery:getCanonicalTaskReworkSignals')!(null, workspaceId, taskId, 50);

    expect(runs).toMatchObject({
      success: true,
      data: {
        items: [
          {
            runId,
            verification: { runs: 3, failures: 1, editVerifyRounds: null },
            workItems: [
              { provider: 'jira', externalId: '10042', externalKey: 'CORE-123', linked: true },
              { provider: 'linear.issue', externalId: 'lin_42', externalKey: null, linked: false },
            ],
          },
          { verification: null, workItems: [] },
        ],
      },
    });
    expect(signals).toMatchObject({
      success: true,
      data: { items: [{ kind: 'stage_reentry' }, { kind: 'tracker_reopened' }] },
    });
    expect(JSON.stringify(runs)).not.toContain('secret-renderer-sentinel');
  });

  it('projects a v1-shaped task summary from a server that predates the partial-ship widening', async () => {
    const v1 = structuredClone(summary) as Record<string, unknown>;
    delete v1.shipState;
    const counts = v1.counts as Record<string, unknown>;
    delete counts.mergedCodeChanges;
    delete counts.openCodeChanges;
    getCanonicalTaskSummariesMock.mockResolvedValue({ tasks: [v1], nextCursor: null });
    const handlers = await registered();

    const summaries = await handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 50);

    // `everShipped` is the only ship fact such a server has, and it can never mean `partial`.
    expect(summaries).toMatchObject({
      success: true,
      data: { tasks: [{ shipState: 'shipped', counts: { mergedCodeChanges: 0, openCodeChanges: 0 } }] },
    });
  });

  it('projects the review rework kinds the server now emits', async () => {
    getCanonicalTaskReworkSignalsMock.mockResolvedValue({
      items: [
        {
          id: '9',
          kind: 'review_changes_requested',
          sourceKey: 'github-review:acme/widgets:482:7001',
          sourceRef: 'https://github.com/acme/widgets/pull/482#pullrequestreview-7001',
          occurredAt: '2026-08-16T11:00:00.000Z',
          observedAt: '2026-08-16T11:00:01.000Z',
        },
        {
          id: '10',
          kind: 'review_commented',
          sourceKey: 'github-review:acme/widgets:482:7002',
          sourceRef: 'https://github.com/acme/widgets/pull/482#pullrequestreview-7002',
          occurredAt: '2026-08-16T12:00:00.000Z',
          observedAt: '2026-08-16T12:00:01.000Z',
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    const signals = await handlers.get('delivery:getCanonicalTaskReworkSignals')!(null, workspaceId, taskId, 50);

    expect(signals).toMatchObject({
      success: true,
      data: { items: [{ kind: 'review_changes_requested' }, { kind: 'review_commented' }] },
    });
  });

  it('fails the page on an unknown rework kind', async () => {
    getCanonicalTaskReworkSignalsMock.mockResolvedValue({
      items: [
        {
          id: '11',
          kind: 'review_dismissed',
          sourceKey: 'github-review:acme/widgets:482:7003',
          sourceRef: 'github-review:acme/widgets:482:7003',
          occurredAt: '2026-08-16T13:00:00.000Z',
          observedAt: '2026-08-16T13:00:01.000Z',
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    await expect(
      handlers.get('delivery:getCanonicalTaskReworkSignals')!(null, workspaceId, taskId, 50),
    ).resolves.toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });

  it.each([
    [
      'more than eight work items',
      Array.from({ length: 9 }, (_, index) => ({
        provider: `provider.${index}`,
        externalId: `item-${index}`,
        externalKey: null,
        linked: false,
      })),
    ],
    [
      'a shell-metacharacter identity',
      [{ provider: 'jira', externalId: '$(touch-pwned)', externalKey: null, linked: false }],
    ],
  ])('fails closed on %s in a canonical run response', async (_label, workItems) => {
    getCanonicalTaskRunsMock.mockResolvedValue({
      items: [
        {
          runId,
          workflowId: 'change:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'normal',
          repositoryKey: 'acme/widgets',
          startedAt: '2026-08-16T10:00:00.000Z',
          finishedAt: null,
          outcome: null,
          verification: null,
          workItems,
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    await expect(handlers.get('delivery:getCanonicalTaskRuns')!(null, workspaceId, taskId, 50)).resolves.toEqual({
      success: false,
      error: 'CANONICAL_DELIVERY_UNAVAILABLE',
    });
  });

  it('projects every nested page to its closed item shape', async () => {
    getCanonicalTaskExternalRefsMock.mockResolvedValue({
      items: [
        {
          id: '42',
          provider: 'jira',
          externalId: '10001',
          externalKey: 'CORE-42',
          externalUrl: 'https://jira.example/browse/CORE-42',
          externalState: 'in_progress',
          connectorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceUpdatedAt: '2026-08-16T10:00:00.000Z',
          lastObservedAt: '2026-08-16T10:01:00.000Z',
          isAuthority: true,
          stateFactCount: 1,
          payload: 'secret-renderer-sentinel',
        },
      ],
      nextCursor: null,
    });
    getCanonicalExternalRefStateHistoryMock.mockResolvedValue({
      items: [
        {
          id: '51',
          fromState: 'done',
          toState: 'in_progress',
          sourceRef: 'transition-1',
          occurredAt: '2026-08-16T10:00:00.000Z',
          sourceUpdatedAt: '2026-08-16T10:00:01.000Z',
          receivedAt: '2026-08-16T10:00:02.000Z',
          actorId: null,
        },
      ],
      nextCursor: null,
    });
    getCanonicalRunStageOccurrencesMock.mockResolvedValue({
      items: [
        {
          occurrenceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          runId,
          stageId: 'verify',
          attempt: 2,
          startedAt: null,
          finishedAt: '2026-08-16T10:05:00.000Z',
          outcome: 'success',
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskCodeChangesMock.mockResolvedValue({
      items: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          provider: 'github',
          repoExternalId: 'acme/widgets',
          externalId: '991',
          number: 42,
          title: 'Ship it',
          state: 'merged',
          isDraft: false,
          sourceBranch: 'feature/c7',
          targetBranch: 'main',
          mergedAt: '2026-08-16T10:04:00.000Z',
          updatedAt: '2026-08-16T10:04:01.000Z',
          associationSource: 'run_id',
          associationSourceValue: runId,
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskShipEvidenceMock.mockResolvedValue({
      items: [
        {
          id: '61',
          source: 'github_pr_merged',
          sourceKey: 'github-pr:abc',
          occurredAt: '2026-08-16T10:04:00.000Z',
          receivedAt: '2026-08-16T10:04:01.000Z',
          actorId: null,
          provider: 'github',
          repoExternalId: 'acme/widgets',
          externalId: '991',
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskArtifactsMock.mockResolvedValue({
      items: [
        {
          id: 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          repositoryKey: 'acme/widgets',
          kind: 'spec',
          createdBy: 'actor-1',
          createdAt: '2026-08-16T10:01:00.000Z',
          updatedAt: '2026-08-16T10:05:00.000Z',
          revisionCount: 2,
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    const responses = await Promise.all([
      handlers.get('delivery:getCanonicalTaskExternalRefs')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalExternalRefStateHistory')!(null, workspaceId, taskId, '42', 50),
      handlers.get('delivery:getCanonicalRunStageOccurrences')!(null, workspaceId, taskId, runId, 50),
      handlers.get('delivery:getCanonicalTaskCodeChanges')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalTaskShipEvidence')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalTaskArtifacts')!(null, workspaceId, taskId, 50),
    ]);

    expect(responses.every((response) => (response as { success: boolean }).success)).toBe(true);
    expect(JSON.stringify(responses)).not.toContain('secret-renderer-sentinel');
    expect(getCanonicalExternalRefStateHistoryMock).toHaveBeenCalledWith(workspaceId, taskId, '42', 50, undefined);
    expect(getCanonicalRunStageOccurrencesMock).toHaveBeenCalledWith(workspaceId, taskId, runId, 50, undefined);
  });

  it('degrades a single malformed code-change externalUrl to null instead of rejecting the whole page (C1)', async () => {
    getCanonicalTaskCodeChangesMock.mockResolvedValue({
      items: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          provider: 'github',
          repoExternalId: 'acme/widgets',
          externalId: '991',
          number: 42,
          title: 'Bad URL row',
          state: 'merged',
          isDraft: false,
          sourceBranch: 'feature/c1',
          targetBranch: 'main',
          mergedAt: '2026-08-16T10:04:00.000Z',
          updatedAt: '2026-08-16T10:04:01.000Z',
          // Provenance stays stricter than the open policy: a canonical row the
          // server composed carries no query string. (`http:` is covered by the
          // external-ref case below.)
          externalUrl: 'https://github.com/acme/widgets/pull/991?token=abc',
          associationSource: 'run_id',
          associationSourceValue: runId,
        },
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          provider: 'github',
          repoExternalId: 'acme/widgets',
          externalId: '992',
          number: 43,
          title: 'Good URL row',
          state: 'merged',
          isDraft: false,
          sourceBranch: 'feature/c1b',
          targetBranch: 'main',
          mergedAt: '2026-08-16T10:05:00.000Z',
          updatedAt: '2026-08-16T10:05:01.000Z',
          externalUrl: 'https://github.com/acme/widgets/pull/992',
          associationSource: 'run_id',
          associationSourceValue: runId,
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    const response = await handlers.get('delivery:getCanonicalTaskCodeChanges')!(null, workspaceId, taskId, 50);

    expect(response).toMatchObject({
      success: true,
      data: {
        items: [
          { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', externalUrl: null },
          { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', externalUrl: 'https://github.com/acme/widgets/pull/992' },
        ],
      },
    });
  });

  it('fails closed on bounds, invalid retention/URLs, and values outside closed evidence enums', async () => {
    getCanonicalTaskSummariesMock
      .mockResolvedValueOnce({ tasks: [summary, summary], nextCursor: null })
      .mockResolvedValueOnce({ tasks: [summary], nextCursor: 'x'.repeat(2_049) });
    getCanonicalTaskDetailMock.mockResolvedValue({
      ...summary,
      fineEventRetention: { policyDays: 91, purgedThroughReceivedAt: null },
    });
    getCanonicalTaskExternalRefsMock.mockResolvedValue({
      items: [
        {
          id: '42',
          provider: 'jira',
          externalId: '10001',
          externalKey: null,
          externalUrl: 'http://jira.example/browse/CORE-42',
          externalState: null,
          connectorId: null,
          sourceUpdatedAt: null,
          lastObservedAt: null,
          isAuthority: false,
          stateFactCount: 0,
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskReworkSignalsMock.mockResolvedValue({
      items: [
        {
          id: '7',
          kind: 'verification_failed',
          sourceKey: 'counter:1',
          sourceRef: 'counter:1',
          occurredAt: '2026-08-16T10:03:00.000Z',
          observedAt: '2026-08-16T10:03:01.000Z',
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskCodeChangesMock.mockResolvedValue({
      items: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          provider: 'github',
          repoExternalId: 'repo-node-17',
          externalId: '991',
          number: 42,
          title: null,
          state: 'merged',
          isDraft: false,
          sourceBranch: null,
          targetBranch: null,
          mergedAt: null,
          updatedAt: '2026-08-16T10:04:01.000Z',
          associationSource: 'inferred_guess',
          associationSourceValue: runId,
        },
      ],
      nextCursor: null,
    });
    getCanonicalTaskShipEvidenceMock.mockResolvedValue({
      items: [
        {
          id: '61',
          source: 'github',
          sourceKey: 'github-pr:abc',
          occurredAt: '2026-08-16T10:04:00.000Z',
          receivedAt: '2026-08-16T10:04:01.000Z',
          actorId: null,
          provider: 'github',
          repoExternalId: 'repo-node-17',
          externalId: '991',
        },
      ],
      nextCursor: null,
    });
    const handlers = await registered();

    const calls = [
      handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 1),
      handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 50),
      handlers.get('delivery:getCanonicalTaskSummaries')!(null, workspaceId, 50, 'x'.repeat(2_049)),
      handlers.get('delivery:getCanonicalTaskDetail')!(null, workspaceId, taskId),
      handlers.get('delivery:getCanonicalTaskExternalRefs')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalTaskReworkSignals')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalTaskCodeChanges')!(null, workspaceId, taskId, 50),
      handlers.get('delivery:getCanonicalTaskShipEvidence')!(null, workspaceId, taskId, 50),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
    }
  });

  it('fails closed when verification members are missing or are not nullable non-negative integers', async () => {
    const baseRun = {
      runId,
      workflowId: null,
      intent: null,
      risk: null,
      scale: null,
      repositoryKey: null,
      startedAt: null,
      finishedAt: null,
      outcome: null,
    };
    getCanonicalTaskRunsMock
      .mockResolvedValueOnce({ items: [{ ...baseRun, verification: { runs: 1, failures: 1 } }], nextCursor: null })
      .mockResolvedValueOnce({
        items: [{ ...baseRun, verification: { runs: 1, failures: -1, editVerifyRounds: null } }],
        nextCursor: null,
      });
    const handlers = await registered();

    for (let index = 0; index < 2; index += 1) {
      await expect(handlers.get('delivery:getCanonicalTaskRuns')!(null, workspaceId, taskId, 50)).resolves.toEqual({
        success: false,
        error: 'CANONICAL_DELIVERY_UNAVAILABLE',
      });
    }
  });

  it('rejects a non-UUID workspace id before any additive canonical transport call', async () => {
    const handlers = await registered();
    const invalidWorkspaceId = '../other-workspace';
    const calls: Array<[string, unknown[]]> = [
      ['delivery:getCanonicalTaskSummaries', [invalidWorkspaceId, 50]],
      ['delivery:getCanonicalTaskDetail', [invalidWorkspaceId, taskId]],
      ['delivery:getCanonicalTaskExternalRefs', [invalidWorkspaceId, taskId, 50]],
      ['delivery:getCanonicalExternalRefStateHistory', [invalidWorkspaceId, taskId, '42', 50]],
      ['delivery:getCanonicalTaskRuns', [invalidWorkspaceId, taskId, 50]],
      ['delivery:getCanonicalRunStageOccurrences', [invalidWorkspaceId, taskId, runId, 50]],
      ['delivery:getCanonicalTaskCodeChanges', [invalidWorkspaceId, taskId, 50]],
      ['delivery:getCanonicalTaskShipEvidence', [invalidWorkspaceId, taskId, 50]],
      ['delivery:getCanonicalTaskReworkSignals', [invalidWorkspaceId, taskId, 50]],
      ['delivery:getCanonicalTaskArtifacts', [invalidWorkspaceId, taskId, 50]],
    ];

    for (const [channel, args] of calls) {
      await expect(handlers.get(channel)!(null, ...args)).resolves.toEqual({
        success: false,
        error: 'CANONICAL_DELIVERY_UNAVAILABLE',
      });
    }
    for (const transport of [
      getCanonicalTaskSummariesMock,
      getCanonicalTaskDetailMock,
      getCanonicalTaskExternalRefsMock,
      getCanonicalExternalRefStateHistoryMock,
      getCanonicalTaskRunsMock,
      getCanonicalRunStageOccurrencesMock,
      getCanonicalTaskCodeChangesMock,
      getCanonicalTaskShipEvidenceMock,
      getCanonicalTaskReworkSignalsMock,
      getCanonicalTaskArtifactsMock,
    ]) {
      expect(transport).not.toHaveBeenCalled();
    }
  });
});

describe('delivery:openExternal (trusted compose)', () => {
  it('opens a validated clean HTTPS externalUrl', async () => {
    const handlers = await registered();

    const res = await handlers.get('delivery:openExternal')!(null, {
      externalUrl: 'https://jira.example/browse/SCRUM-13',
    });

    expect(res).toEqual({ success: true });
    expect(openExternalMock).toHaveBeenCalledWith('https://jira.example/browse/SCRUM-13');
  });

  it('rejects a non-http externalUrl (no shell.openExternal call)', async () => {
    const handlers = await registered();

    const res = (await handlers.get('delivery:openExternal')!(null, { externalUrl: 'file:///etc/passwd' })) as {
      success: boolean;
      error?: string;
    };

    expect(res.success).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});

describe('composeDeliveryUrl', () => {
  it('accepts only clean HTTPS for an externalUrl', async () => {
    const { composeDeliveryUrl } = await import('./delivery-manager.js');
    expect(composeDeliveryUrl({ externalUrl: 'https://a.co/x' })).toBe('https://a.co/x');
    expect(composeDeliveryUrl({ externalUrl: 'http://a.co/x' })).toBeNull();
    expect(composeDeliveryUrl({ externalUrl: 'https://user:secret@a.co/x' })).toBeNull();
    // Query and fragment open: the renderer gates its links on the same predicate.
    expect(composeDeliveryUrl({ externalUrl: 'https://a.co/x?q=1#f' })).toBe('https://a.co/x?q=1#f');
    expect(composeDeliveryUrl({ externalUrl: 'file:///etc/passwd' })).toBeNull();
    expect(composeDeliveryUrl({ externalUrl: 'javascript:alert(1)' })).toBeNull();
    expect(composeDeliveryUrl({ externalUrl: 'not a url' })).toBeNull();
  });
});
