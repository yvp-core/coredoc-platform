import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { CaptureService } from './capture.service.js';

const START_ID = '11111111-1111-4111-8111-111111111111';
const FINISH_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'cdr-20260815-a1b2c3';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function started(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: START_ID,
    occurredAt: '2026-08-15T10:00:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: RUN_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    taskId: 'cdt_pilot_42',
    type: 'workflow.run.started',
    data: {
      workflowId: 'change:large:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'large',
    },
    ...overrides,
  };
}

function finished(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: FINISH_ID,
    occurredAt: '2026-08-15T10:05:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: RUN_ID,
    type: 'workflow.run.finished',
    data: {
      outcome: 'success',
      counters: { editCalls: 3, verificationRuns: 2, verificationPasses: 2 },
    },
    ...overrides,
  };
}

function startedV2(overrides: Record<string, unknown> = {}) {
  return started({
    schemaVersion: 2,
    taskId: TASK_ID,
    data: {
      workflowId: 'change:large:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'large',
      stages: [
        { stageId: 'spec', after: [] },
        { stageId: 'implement', after: ['spec'] },
      ],
    },
    ...overrides,
  });
}

function startedV3(overrides: Record<string, unknown> = {}) {
  return started({
    schemaVersion: 3,
    taskId: undefined,
    data: {
      workflowId: 'change:large:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'large',
      stages: [
        { stageId: 'spec', after: [] },
        { stageId: 'implement', after: ['spec'] },
      ],
      workItems: [
        { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
        { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
      ],
    },
    ...overrides,
  });
}

function stageStarted(stageId: string, occurrenceId: string, attempt: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    eventId: '33333333-3333-4333-8333-333333333333',
    occurredAt: '2026-08-15T10:01:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: RUN_ID,
    type: 'workflow.stage.started',
    data: { occurrenceId, stageId, attempt },
    ...overrides,
  };
}

function stageFinished(
  stageId: string,
  occurrenceId: string,
  attempt: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    eventId: '44444444-4444-4444-8444-444444444444',
    occurredAt: '2026-08-15T10:02:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: RUN_ID,
    type: 'workflow.stage.finished',
    data: { occurrenceId, stageId, attempt, outcome: 'success' },
    ...overrides,
  };
}

function questionAnswered(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    eventId: '66666666-6666-4666-8666-666666666666',
    occurredAt: '2026-08-15T10:01:30.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    type: 'workflow.question.answered',
    data: {
      askId: '77777777-7777-4777-8777-777777777777',
      questionIndex: 1,
      questionCount: 1,
      question: 'Backfill existing rows?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      multiSelect: false,
      answer: 'No',
      answerKind: 'option',
    },
    ...overrides,
  };
}

function capabilityUsed(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: '55555555-5555-4555-8555-555555555555',
    occurredAt: '2026-08-15T10:01:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    type: 'capability.used',
    data: { kind: 'skill', capabilityId: 'coredoc-tdd', outcome: 'success' },
    ...overrides,
  };
}

type Row = Record<string, unknown>;
type RawSql = { strings: readonly string[]; values: readonly unknown[] };
type CaptureFindArgs = {
  where: { workspaceId_eventId: { workspaceId: string; eventId: string } };
};
type CaptureCreateArgs = { data: Row & { workspaceId: string; eventId: string } };
type SessionUpsertArgs = {
  where: { workspaceId_provider_sessionId: { workspaceId: string; provider: string; sessionId: string } };
  create: Row & { workspaceId: string; provider: string; sessionId: string };
};
type RunUpsertArgs = {
  where: { workspaceId_runId: { workspaceId: string; runId: string } };
  create: Row & { workspaceId: string; runId: string };
};
type RunFindArgs = {
  where: { workspaceId_runId: { workspaceId: string; runId: string } };
};
type TaskUpsertArgs = {
  where: { workspaceId_id: { workspaceId: string; id: string } };
  create: Row & { workspaceId: string; id: string };
  update: Row;
};
type UpdateArgs = { where: { id: string }; data: Row };
type WorkspaceRepoFindArgs = {
  where: { workspaceId: string; captureRepositoryKey: string };
};
type WorkItemFindArgs = {
  where: { workspaceId: string; workflowRunId: string };
};

function cloneRows(rows: Map<string, Row>): Map<string, Row> {
  return new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
}

function memoryPrisma(boundRepositoryKeys = ['coredoc/coredoc-parser']) {
  const state = {
    captureEvents: new Map<string, Row>(),
    sessions: new Map<string, Row>(),
    runs: new Map<string, Row>(),
    workItems: new Map<string, Row>(),
    tasks: new Map<string, Row>(),
    stages: new Map<string, Row>(),
    reworkSignals: new Map<string, Row>(),
    watermarks: new Map<string, Row>(),
    taskUpserts: [] as TaskUpsertArgs[],
    stageUpserts: [] as Array<{ where: { id: string }; create: Row; update: Row }>,
    stageCreates: [] as Row[],
    reworkCreates: [] as Row[],
    watermarkQueries: [] as Array<{ sql: string; values: unknown[] }>,
    runLockQueries: [] as Array<{ sql: string; values: unknown[] }>,
    workspaceRepos: new Set(boundRepositoryKeys.map((key) => `workspace-1:${key}`)),
    failProjection: false,
  };

  const transaction = async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
    const draft = {
      captureEvents: cloneRows(state.captureEvents),
      sessions: cloneRows(state.sessions),
      runs: cloneRows(state.runs),
      workItems: cloneRows(state.workItems),
      tasks: cloneRows(state.tasks),
      stages: cloneRows(state.stages),
      reworkSignals: cloneRows(state.reworkSignals),
      watermarks: cloneRows(state.watermarks),
    };
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        state.runLockQueries.push({
          sql: strings.join('?'),
          values: structuredClone(values),
        });
        return [];
      },
      $executeRaw: async (query: RawSql) => {
        state.watermarkQueries.push({
          sql: query.strings.join('?'),
          values: structuredClone([...query.values]),
        });
        const [
          workspaceId,
          actorId,
          host,
          scopeKey,
          repositoryKey,
          firstAcceptedAt,
          lastAcceptedAt,
          workflowLastAcceptedAt,
        ] = query.values as [string, string, string, string, string | null, Date, Date, Date | null];
        const storageKey = `${workspaceId}:${actorId}:${host}:${scopeKey}`;
        const established = draft.watermarks.get(storageKey);
        const establishedFirst = established?.firstAcceptedAt as Date | undefined;
        const establishedLast = established?.lastAcceptedAt as Date | undefined;
        const establishedWorkflowLast = established?.workflowLastAcceptedAt as Date | null | undefined;
        const workflowTimes = [establishedWorkflowLast, workflowLastAcceptedAt].filter(
          (value): value is Date => value instanceof Date,
        );
        const row = {
          workspaceId,
          actorId,
          host,
          scopeKey,
          repositoryKey,
          firstAcceptedAt:
            establishedFirst === undefined || firstAcceptedAt < establishedFirst ? firstAcceptedAt : establishedFirst,
          lastAcceptedAt:
            establishedLast === undefined || lastAcceptedAt > establishedLast ? lastAcceptedAt : establishedLast,
          workflowLastAcceptedAt:
            workflowTimes.length === 0
              ? null
              : workflowTimes.reduce((latest, value) => (value > latest ? value : latest)),
        };
        draft.watermarks.set(storageKey, row);
        return 1;
      },
      workspaceRepo: {
        findFirst: async ({ where }: WorkspaceRepoFindArgs) =>
          state.workspaceRepos.has(`${where.workspaceId}:${where.captureRepositoryKey}`) ? { id: 'repo-1' } : null,
      },
      captureEvent: {
        findUnique: async ({ where }: CaptureFindArgs) =>
          draft.captureEvents.get(`${where.workspaceId_eventId.workspaceId}:${where.workspaceId_eventId.eventId}`) ??
          null,
        create: async ({ data }: CaptureCreateArgs) => {
          const row = {
            ...structuredClone(data),
            receivedAt: new Date(Date.UTC(2026, 7, 15, 12, 0, draft.captureEvents.size)),
          };
          draft.captureEvents.set(`${data.workspaceId}:${data.eventId}`, row);
          return row;
        },
      },
      agentSession: {
        // The provider-conflict guard reads the LEGACY (workspaceId, sessionId) unique: any
        // provider's row for the same session id answers, mirroring the real index.
        findUnique: async ({
          where,
        }: {
          where: { workspaceId_sessionId: { workspaceId: string; sessionId: string } };
        }) => {
          const key = where.workspaceId_sessionId;
          return (
            [...draft.sessions.values()].find(
              (row) => row.workspaceId === key.workspaceId && row.sessionId === key.sessionId,
            ) ?? null
          );
        },
        upsert: async ({ where, create }: SessionUpsertArgs) => {
          const key = where.workspaceId_provider_sessionId;
          const storageKey = `${key.workspaceId}:${key.provider}:${key.sessionId}`;
          const existing = draft.sessions.get(storageKey);
          if (existing) return existing;
          const row = { id: `session:${create.provider}:${create.sessionId}`, ...structuredClone(create) };
          draft.sessions.set(storageKey, row);
          return row;
        },
        update: async ({ where, data }: UpdateArgs) => {
          const current = [...draft.sessions.values()].find((row) => row.id === where.id);
          if (!current) throw new Error('missing session');
          Object.assign(current, structuredClone(data));
          return current;
        },
      },
      workflowRun: {
        upsert: async ({ where, create }: RunUpsertArgs) => {
          const key = where.workspaceId_runId;
          const storageKey = `${key.workspaceId}:${key.runId}`;
          const existing = draft.runs.get(storageKey);
          if (existing) return existing;
          if (state.failProjection) throw new Error('forced projection failure');
          const row = { id: `run:${create.runId}`, ...structuredClone(create) };
          draft.runs.set(storageKey, row);
          return row;
        },
        update: async ({ where, data }: UpdateArgs) => {
          if (state.failProjection) throw new Error('forced projection failure');
          const current = [...draft.runs.values()].find((row) => row.id === where.id);
          if (!current) throw new Error('missing run');
          Object.assign(current, structuredClone(data));
          return current;
        },
        findUnique: async ({ where }: RunFindArgs) => {
          const key = where.workspaceId_runId;
          return draft.runs.get(`${key.workspaceId}:${key.runId}`) ?? null;
        },
      },
      workflowRunWorkItem: {
        findMany: async ({ where }: WorkItemFindArgs) =>
          [...draft.workItems.values()]
            .filter((row) => row.workspaceId === where.workspaceId && row.workflowRunId === where.workflowRunId)
            .sort((left, right) => {
              const providerOrder = String(left.provider).localeCompare(String(right.provider));
              return providerOrder === 0
                ? String(left.externalId).localeCompare(String(right.externalId))
                : providerOrder;
            }),
        createMany: async ({ data }: { data: Row[] }) => {
          for (const item of data) {
            const storageKey = `${String(item.workspaceId)}:${String(item.workflowRunId)}:${String(item.provider)}:${String(item.externalId)}`;
            if (draft.workItems.has(storageKey)) {
              throw Object.assign(new Error('work-item relation collision'), { code: 'P2002' });
            }
            draft.workItems.set(storageKey, {
              id: BigInt(draft.workItems.size + 1),
              ...structuredClone(item),
            });
          }
          return { count: data.length };
        },
      },
      deliveryTask: {
        upsert: async (args: TaskUpsertArgs) => {
          state.taskUpserts.push(structuredClone(args));
          const { where, create } = args;
          const key = where.workspaceId_id;
          const storageKey = `${key.workspaceId}:${key.id}`;
          const existing = draft.tasks.get(storageKey);
          if (existing) return existing;
          const row = {
            ...structuredClone(create),
            createdAt: new Date('2026-08-15T10:00:00.000Z'),
            updatedAt: new Date('2026-08-15T10:00:00.000Z'),
          };
          draft.tasks.set(storageKey, row);
          return row;
        },
        update: async ({ where, data }: UpdateArgs) => {
          const current = [...draft.tasks.values()].find((row) => row.id === where.id);
          if (!current) throw new Error('missing task');
          Object.assign(current, structuredClone(data));
          return current;
        },
      },
      workflowStageOccurrence: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          if (typeof where.id === 'string') return draft.stages.get(where.id) ?? null;
          const unique = where.workflowRunId_stageId_attempt as
            | { workflowRunId: string; stageId: string; attempt: number }
            | undefined;
          if (!unique) return null;
          return (
            [...draft.stages.values()].find(
              (row) =>
                row.workflowRunId === unique.workflowRunId &&
                row.stageId === unique.stageId &&
                row.attempt === unique.attempt,
            ) ?? null
          );
        },
        findMany: async ({ where }: { where: { workflowRunId: string; stageId?: string } }) =>
          [...draft.stages.values()]
            .filter(
              (row) =>
                row.workflowRunId === where.workflowRunId &&
                (where.stageId === undefined || row.stageId === where.stageId),
            )
            .sort((left, right) => Number(left.attempt) - Number(right.attempt)),
        upsert: async (args: { where: { id: string }; create: Row & { id: string }; update: Row }) => {
          state.stageUpserts.push(structuredClone(args));
          const { where, create } = args;
          const existing = draft.stages.get(where.id);
          if (existing) return existing;
          const tupleCollision = [...draft.stages.values()].some(
            (row) =>
              row.workflowRunId === create.workflowRunId &&
              row.stageId === create.stageId &&
              row.attempt === create.attempt,
          );
          if (tupleCollision) throw Object.assign(new Error('stage tuple collision'), { code: 'P2002' });
          const row = { startedAt: null, finishedAt: null, outcome: null, ...structuredClone(create) };
          draft.stages.set(create.id, row);
          return row;
        },
        create: async ({ data }: { data: Row & { id: string } }) => {
          state.stageCreates.push(structuredClone(data));
          const idCollision = draft.stages.has(data.id);
          const tupleCollision = [...draft.stages.values()].some(
            (row) =>
              row.workflowRunId === data.workflowRunId && row.stageId === data.stageId && row.attempt === data.attempt,
          );
          if (idCollision || tupleCollision) {
            throw Object.assign(new Error('stage occurrence collision'), { code: 'P2002' });
          }
          const row = { startedAt: null, finishedAt: null, outcome: null, ...structuredClone(data) };
          draft.stages.set(data.id, row);
          return row;
        },
        update: async ({ where, data }: UpdateArgs) => {
          const current = draft.stages.get(where.id);
          if (!current) throw new Error('missing stage occurrence');
          Object.assign(current, structuredClone(data));
          return current;
        },
      },
      deliveryReworkSignal: {
        findUnique: async ({
          where,
        }: {
          where: {
            workspaceId_kind_sourceKey: { workspaceId: string; kind: string; sourceKey: string };
          };
        }) => {
          const key = where.workspaceId_kind_sourceKey;
          return draft.reworkSignals.get(`${key.workspaceId}:${key.kind}:${key.sourceKey}`) ?? null;
        },
        create: async ({ data }: { data: Row }) => {
          state.reworkCreates.push(structuredClone(data));
          const storageKey = `${String(data.workspaceId)}:${String(data.kind)}:${String(data.sourceKey)}`;
          if (draft.reworkSignals.has(storageKey)) {
            throw Object.assign(new Error('rework signal collision'), { code: 'P2002' });
          }
          const row = { id: BigInt(draft.reworkSignals.size + 1), ...structuredClone(data) };
          draft.reworkSignals.set(storageKey, row);
          return row;
        },
      },
    };

    const result = await work(tx);
    state.captureEvents = draft.captureEvents;
    state.sessions = draft.sessions;
    state.runs = draft.runs;
    state.workItems = draft.workItems;
    state.tasks = draft.tasks;
    state.stages = draft.stages;
    state.reworkSignals = draft.reworkSignals;
    state.watermarks = draft.watermarks;
    return result;
  };

  return {
    state,
    prisma: {
      $transaction: transaction,
      captureEvent: {
        findUnique: async ({ where }: CaptureFindArgs) =>
          state.captureEvents.get(`${where.workspaceId_eventId.workspaceId}:${where.workspaceId_eventId.eventId}`) ??
          null,
      },
    } as unknown as PrismaService,
  };
}

const actor = { id: 'user-42', email: 'pilot@example.com' };

function repositoryResolverPrisma(workspaceRepo: Record<string, unknown>) {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
    operation({ $executeRaw: executeRaw, workspaceRepo }),
  );
  return {
    executeRaw,
    transaction,
    prisma: { $transaction: transaction } as unknown as PrismaService,
  };
}

describe('CaptureService', () => {
  it.each(['claude-code', 'codex'])('rejects an unbound %s repository before creating any rows', async (host) => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const event = started({ host, repositoryKey: 'outside/workspace' });

    await expect(service.ingest('workspace-1', actor, { events: [event] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'OUT_OF_WORKSPACE_REPOSITORY' }],
    });
    expect(store.state.captureEvents).toHaveLength(0);
    expect(store.state.sessions).toHaveLength(0);
    expect(store.state.runs).toHaveLength(0);
  });

  it('accepts a V1 event without repositoryKey and leaves it unattributed', async () => {
    const store = memoryPrisma([]);
    const service = new CaptureService(store.prisma);

    await expect(
      service.ingest('workspace-1', actor, { events: [started({ repositoryKey: undefined })] }),
    ).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });
    expect([...store.state.captureEvents.values()][0]).toMatchObject({ repositoryKey: null });
  });

  it('classifies an unsupported schema separately from a malformed event', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [started({ schemaVersion: 99 })] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'UNSUPPORTED_SCHEMA_VERSION' }],
    });
    expect(store.state.captureEvents).toHaveLength(0);
  });

  it('keeps a malformed schemaVersion in the generic invalid-event category', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await expect(
      service.ingest('workspace-1', actor, { events: [started({ schemaVersion: 'future' })] }),
    ).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'INVALID_EVENT' }],
    });
  });

  it('binds a normalized capture repository key to the graph repo identity', async () => {
    const updateManyAndReturn = vi.fn(async () => [{ repoKey: 'graph-hash', captureRepositoryKey: 'owner/repo' }]);
    const service = new CaptureService({ workspaceRepo: { updateManyAndReturn } } as unknown as PrismaService);

    await expect(service.bindRepository('workspace-1', 'graph-hash', { repositoryKey: 'owner/repo' })).resolves.toEqual(
      { repoKey: 'graph-hash', captureRepositoryKey: 'owner/repo' },
    );
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        repoKey: 'graph-hash',
        OR: [{ captureRepositoryKey: null }, { captureRepositoryKey: 'owner/repo' }],
      },
      data: { captureRepositoryKey: 'owner/repo' },
      select: { repoKey: true, captureRepositoryKey: true },
    });
  });

  it('atomically permits only one divergent first binding for the same graph repo', async () => {
    let captureRepositoryKey: string | null = null;
    let mutations = 0;
    const updateManyAndReturn = vi.fn(async ({ data }: { data: { captureRepositoryKey: string } }) => {
      await Promise.resolve();
      if (captureRepositoryKey !== null && captureRepositoryKey !== data.captureRepositoryKey) return [];
      if (captureRepositoryKey === null) mutations += 1;
      captureRepositoryKey = data.captureRepositoryKey;
      return [{ repoKey: 'graph-hash', captureRepositoryKey }];
    });
    const findUnique = vi.fn(async () =>
      captureRepositoryKey === null ? null : { repoKey: 'graph-hash', captureRepositoryKey },
    );
    const service = new CaptureService({
      workspaceRepo: { updateManyAndReturn, findUnique },
    } as unknown as PrismaService);

    const results = await Promise.allSettled([
      service.bindRepository('workspace-1', 'graph-hash', { repositoryKey: 'owner/first' }),
      service.bindRepository('workspace-1', 'graph-hash', { repositoryKey: 'owner/second' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 409 }) }),
    ]);
    expect(mutations).toBe(1);
    expect(captureRepositoryKey).toMatch(/^owner\/(first|second)$/);
  });

  it.each([
    'https://github.com/owner/repo',
    'owner/../repo',
    'owner/repo?ref=main',
    '/owner/repo',
  ])('refuses a non-normalized capture repository key: %s', async (repositoryKey) => {
    const updateManyAndReturn = vi.fn();
    const service = new CaptureService({ workspaceRepo: { updateManyAndReturn } } as unknown as PrismaService);

    await expect(service.bindRepository('workspace-1', 'graph-hash', { repositoryKey })).rejects.toMatchObject({
      status: 400,
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects unknown repository-binding fields before persistence', async () => {
    const updateManyAndReturn = vi.fn();
    const service = new CaptureService({ workspaceRepo: { updateManyAndReturn } } as unknown as PrismaService);

    await expect(
      service.bindRepository('workspace-1', 'graph-hash', {
        repositoryKey: 'owner/repo',
        captureRepositoryKey: 'attacker/override',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('returns 404 when the graph repo is not connected to the authenticated workspace', async () => {
    const updateManyAndReturn = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(null);
    const service = new CaptureService({
      workspaceRepo: { updateManyAndReturn, findUnique },
    } as unknown as PrismaService);

    await expect(
      service.bindRepository('workspace-1', 'foreign-graph-hash', { repositoryKey: 'owner/repo' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns 409 when the normalized origin is already bound to another graph repo', async () => {
    const updateManyAndReturn = vi.fn(async () => {
      throw Object.assign(new Error('duplicate origin'), { code: 'P2002' });
    });
    const service = new CaptureService({ workspaceRepo: { updateManyAndReturn } } as unknown as PrismaService);

    await expect(
      service.bindRepository('workspace-1', 'graph-hash-2', { repositoryKey: 'owner/repo' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reads and binds the trusted repository identity under the workspace advisory lock', async () => {
    const outerFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'repo-row', gitUrl: 'git@github.com:owner/repo.git', captureRepositoryKey: null }]);
    const outerUpdateManyAndReturn = vi.fn().mockResolvedValue([{ captureRepositoryKey: 'owner/repo' }]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const transactionFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'repo-row', gitUrl: 'git@github.com:owner/repo.git', captureRepositoryKey: null }]);
    const transactionUpdateManyAndReturn = vi.fn().mockResolvedValue([{ captureRepositoryKey: 'owner/repo' }]);
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        $executeRaw: executeRaw,
        workspaceRepo: {
          findMany: transactionFindMany,
          updateManyAndReturn: transactionUpdateManyAndReturn,
        },
      }),
    );
    const service = new CaptureService({
      $transaction: transaction,
      workspaceRepo: { findMany: outerFindMany, updateManyAndReturn: outerUpdateManyAndReturn },
    } as unknown as PrismaService);

    await expect(service.resolveRepository('workspace-1', { repositoryKey: 'owner/repo' })).resolves.toEqual({
      status: 'resolved',
      repositoryKey: 'owner/repo',
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(String(executeRaw.mock.calls[0]?.[0]?.join('?'))).toContain('pg_advisory_xact_lock');
    expect(transactionFindMany).toHaveBeenCalledOnce();
    expect(transactionUpdateManyAndReturn).toHaveBeenCalledOnce();
    expect(outerFindMany).not.toHaveBeenCalled();
    expect(outerUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('resolves and atomically binds one server-trusted Git identity', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'repo-row',
        gitUrl: 'git@github.com:owner/repo.git',
        captureRepositoryKey: null,
      },
    ]);
    const updateManyAndReturn = vi.fn().mockResolvedValue([{ captureRepositoryKey: 'owner/repo' }]);
    const store = repositoryResolverPrisma({ findMany, updateManyAndReturn });
    const service = new CaptureService(store.prisma);

    await expect(service.resolveRepository('workspace-1', { repositoryKey: 'owner/repo' })).resolves.toEqual({
      status: 'resolved',
      repositoryKey: 'owner/repo',
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1', gitUrl: { not: null } },
      select: { id: true, gitUrl: true, captureRepositoryKey: true },
    });
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: 'repo-row',
        workspaceId: 'workspace-1',
        gitUrl: 'git@github.com:owner/repo.git',
        OR: [{ captureRepositoryKey: null }, { captureRepositoryKey: 'owner/repo' }],
      },
      data: { captureRepositoryKey: 'owner/repo' },
      select: { captureRepositoryKey: true },
    });
  });

  it('returns unregistered without mutating when the workspace has no trusted Git identity match', async () => {
    const updateManyAndReturn = vi.fn();
    const store = repositoryResolverPrisma({
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'other', gitUrl: 'https://github.com/another/repo.git', captureRepositoryKey: null },
        ]),
      updateManyAndReturn,
    });
    const service = new CaptureService(store.prisma);

    await expect(service.resolveRepository('workspace-1', { repositoryKey: 'owner/repo' })).resolves.toEqual({
      status: 'unregistered',
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it('fails closed when host-free normalization matches more than one workspace repository', async () => {
    const store = repositoryResolverPrisma({
      findMany: vi.fn().mockResolvedValue([
        { id: 'github', gitUrl: 'https://github.com/owner/repo.git', captureRepositoryKey: null },
        { id: 'gitlab', gitUrl: 'https://gitlab.example/owner/repo.git', captureRepositoryKey: null },
      ]),
    });
    const service = new CaptureService(store.prisma);

    await expect(service.resolveRepository('workspace-1', { repositoryKey: 'owner/repo' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('fails closed when the trusted repository is already bound to another identity', async () => {
    const store = repositoryResolverPrisma({
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'repo-row',
          gitUrl: 'https://github.com/owner/repo.git',
          captureRepositoryKey: 'different/repository',
        },
      ]),
    });
    const service = new CaptureService(store.prisma);

    await expect(service.resolveRepository('workspace-1', { repositoryKey: 'owner/repo' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rejects raw URLs and unknown resolver fields before reading repository records', async () => {
    const findMany = vi.fn();
    const service = new CaptureService({ workspaceRepo: { findMany } } as unknown as PrismaService);

    await expect(
      service.resolveRepository('workspace-1', {
        repositoryKey: 'https://github.com/owner/repo',
        repoKey: 'internal-graph-key',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reports a Claude provisioning fact only after validating the exact workspace repo binding', async () => {
    const reportedAt = new Date('2026-08-16T11:00:00.000Z');
    const findFirst = vi.fn().mockResolvedValue({ id: 'repo-1' });
    const queryRaw = vi.fn().mockResolvedValue([
      {
        actorId: actor.id,
        host: 'claude-code',
        targetKey: 'repo:graph-hash',
        repositoryKey: 'owner/repo',
        state: 'configured',
        pendingCount: 2,
        errorCode: 'OUTBOX_PENDING',
        configuredAt: reportedAt,
        disabledAt: null,
        reportedAt,
      },
    ]);
    const service = new CaptureService({
      workspaceRepo: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    const body = {
      schemaVersion: 1,
      host: 'claude-code',
      target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo' },
      state: 'configured',
      pendingCount: 2,
      errorCode: 'OUTBOX_PENDING',
    };

    await expect(service.reportProvisioning('workspace-1', actor.id, body)).resolves.toEqual({
      actorId: actor.id,
      host: 'claude-code',
      targetKey: 'repo:graph-hash',
      repositoryKey: 'owner/repo',
      state: 'configured',
      pendingCount: 2,
      errorCode: 'OUTBOX_PENDING',
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
      configuredAt: reportedAt.toISOString(),
      disabledAt: null,
      reportedAt: reportedAt.toISOString(),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        repoKey: 'graph-hash',
        captureRepositoryKey: 'owner/repo',
      },
      select: { id: true },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual([
      'workspace-1',
      actor.id,
      'claude-code',
      'repo:graph-hash',
      'owner/repo',
      'configured',
      'configured',
      expect.any(Date),
      'configured',
      expect.any(Date),
      expect.any(Date),
      2,
      'OUTBOX_PENDING',
      0,
      0,
      null,
    ]);
  });

  it('uses one atomic conflict transition for same-target provisioning timestamps', async () => {
    const configuredAt = new Date('2026-08-16T09:00:00.000Z');
    const reportedAt = new Date('2026-08-16T11:00:00.000Z');
    const queryRaw = vi.fn().mockResolvedValue([
      {
        actorId: actor.id,
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'owner/repo',
        state: 'configured',
        pendingCount: 1,
        errorCode: 'OUTBOX_PENDING',
        configuredAt,
        disabledAt: null,
        reportedAt,
      },
    ]);
    const service = new CaptureService({
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-id' }) },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);

    await expect(
      service.reportProvisioning('workspace-1', actor.id, {
        schemaVersion: 1,
        host: 'codex',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
        state: 'configured',
        pendingCount: 1,
        errorCode: 'OUTBOX_PENDING',
      }),
    ).resolves.toMatchObject({
      state: 'configured',
      configuredAt: configuredAt.toISOString(),
      reportedAt: reportedAt.toISOString(),
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = (queryRaw.mock.calls[0][0] as readonly string[]).join('?').replace(/\s+/g, ' ');
    expect(sql).toContain('ON CONFLICT (workspace_id, actor_id, host, target_key) DO UPDATE');
    expect(sql).toContain(
      "WHEN EXCLUDED.state = 'configured' AND capture_provisioning.state <> 'configured' THEN EXCLUDED.reported_at",
    );
    expect(sql).toMatch(
      /configured_at = CASE .*COALESCE\(capture_provisioning\.configured_at, EXCLUDED\.reported_at\)/,
    );
    expect(sql).toContain('ELSE capture_provisioning.configured_at');
    expect(sql).toMatch(/disabled_at = CASE .*COALESCE\(capture_provisioning\.disabled_at, EXCLUDED\.reported_at\)/);
  });

  it('refuses a Claude provisioning report whose graph repo and normalized origin are not bound together', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const queryRaw = vi.fn();
    const service = new CaptureService({
      workspaceRepo: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);

    await expect(
      service.reportProvisioning('workspace-1', actor.id, {
        schemaVersion: 1,
        host: 'claude-code',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'other/repo' },
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('preserves configuredAt across same-state diagnostic refreshes while advancing reportedAt', async () => {
    const configuredAt = new Date('2026-08-16T09:00:00.000Z');
    const reportedAt = new Date('2026-08-16T11:00:00.000Z');
    const queryRaw = vi.fn().mockResolvedValue([
      {
        actorId: actor.id,
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'owner/repo',
        state: 'configured',
        pendingCount: 1,
        errorCode: 'OUTBOX_PENDING',
        configuredAt,
        disabledAt: null,
        reportedAt,
      },
    ]);
    const service = new CaptureService({
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-id' }) },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);

    await expect(
      service.reportProvisioning('workspace-1', actor.id, {
        schemaVersion: 1,
        host: 'codex',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
        state: 'configured',
        pendingCount: 1,
        errorCode: 'OUTBOX_PENDING',
      }),
    ).resolves.toMatchObject({ configuredAt: configuredAt.toISOString(), reportedAt: reportedAt.toISOString() });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('derives the repository-scoped Codex base-profile target and rejects contradictory disabled reports', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        actorId: actor.id,
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'owner/repo',
        state: 'disabled',
        pendingCount: 0,
        errorCode: null,
        configuredAt: null,
        disabledAt: new Date('2026-08-16T11:00:00.000Z'),
        reportedAt: new Date('2026-08-16T11:00:00.000Z'),
      },
    ]);
    const service = new CaptureService({
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-id' }) },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);

    await expect(
      service.reportProvisioning('workspace-1', actor.id, {
        schemaVersion: 1,
        host: 'codex',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
        state: 'disabled',
        pendingCount: 1,
        errorCode: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(queryRaw).not.toHaveBeenCalled();

    await expect(
      service.reportProvisioning('workspace-1', actor.id, {
        schemaVersion: 1,
        host: 'codex',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
        state: 'disabled',
        pendingCount: 0,
        errorCode: null,
      }),
    ).resolves.toMatchObject({
      targetKey: 'repo:graph-hash:profile:base',
      repositoryKey: 'owner/repo',
      state: 'disabled',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns an exact mixed accepted/rejected receipt', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const invalid = { ...finished({ eventId: '33333333-3333-4333-8333-333333333333' }), prompt: 'private' };

    await expect(service.ingest('workspace-1', actor, { events: [started(), invalid] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [{ eventId: '33333333-3333-4333-8333-333333333333', code: 'INVALID_EVENT' }],
    });
  });

  it('stores an answered question as session evidence without projecting a run', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const question = questionAnswered();

    await expect(service.ingest('workspace-1', actor, { events: [question] })).resolves.toEqual({
      acceptedEventIds: [question.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(store.state.runs.size).toBe(0);
    expect(store.state.captureEvents).toHaveLength(1);
    expect([...store.state.captureEvents.values()][0]).toMatchObject({
      schemaVersion: 4,
      type: 'workflow.question.answered',
      runId: null,
      data: question.data,
    });

    // The same question during a run keeps the run id but still projects nothing new.
    await service.ingest('workspace-1', actor, { events: [started()] });
    const runs = store.state.runs.size;
    const inRun = questionAnswered({
      eventId: '68888888-8888-4888-8888-888888888888',
      runId: RUN_ID,
      data: { ...question.data, stageId: 'spec' },
    });
    await expect(service.ingest('workspace-1', actor, { events: [inRun] })).resolves.toMatchObject({
      acceptedEventIds: [inRun.eventId],
    });
    expect(store.state.runs.size).toBe(runs);
    expect([...store.state.captureEvents.values()].at(-1)).toMatchObject({ runId: RUN_ID, data: inRun.data });
  });

  it('classifies a retry as duplicate without applying the projection twice', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });
    const before = structuredClone([...store.state.runs.values()][0]);
    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [START_ID],
      rejected: [],
    });
    expect([...store.state.runs.values()][0]).toEqual(before);
    expect(store.state.captureEvents).toHaveLength(1);
  });

  it('returns an accepted event id as duplicate before rejecting altered replay bytes', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await service.ingest('workspace-1', actor, { events: [startedV3()] });
    const accepted = structuredClone(store.state.captureEvents.get(`workspace-1:${START_ID}`));

    await expect(
      service.ingest('workspace-1', actor, {
        events: [{ ...startedV3(), prompt: 'private replay bytes' }],
      }),
    ).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [START_ID],
      rejected: [],
    });
    expect(store.state.captureEvents.get(`workspace-1:${START_ID}`)).toEqual(accepted);
  });

  it('keeps an accepted event idempotent after its repository binding changes', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await service.ingest('workspace-1', actor, { events: [started()] });
    store.state.workspaceRepos.clear();

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [START_ID],
      rejected: [],
    });
    expect(store.state.captureEvents).toHaveLength(1);
    expect(store.state.sessions).toHaveLength(1);
    expect(store.state.runs).toHaveLength(1);
  });

  it('projects start then finish identically to finish then start', async () => {
    const forward = memoryPrisma();
    const reverse = memoryPrisma();
    const forwardService = new CaptureService(forward.prisma);
    const reverseService = new CaptureService(reverse.prisma);

    await forwardService.ingest('workspace-1', actor, { events: [started(), finished()] });
    await reverseService.ingest('workspace-1', actor, { events: [finished(), started()] });

    expect([...reverse.state.runs.values()][0]).toEqual([...forward.state.runs.values()][0]);
  });

  it('creates and links a canonical task only for a V2 run start', async () => {
    const v1 = memoryPrisma();
    const v2 = memoryPrisma();

    await new CaptureService(v1.prisma).ingest('workspace-1', actor, { events: [started()] });
    await new CaptureService(v2.prisma).ingest('workspace-1', actor, { events: [startedV2()] });

    expect(v1.state.tasks).toHaveLength(0);
    expect([...v1.state.runs.values()][0]).toMatchObject({ taskId: 'cdt_pilot_42' });
    expect([...v1.state.runs.values()][0]).not.toHaveProperty('deliveryTaskId');
    expect([...v2.state.tasks.values()][0]).toMatchObject({
      id: TASK_ID,
      workspaceId: 'workspace-1',
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
      createdBy: actor.id,
    });
    expect([...v2.state.runs.values()][0]).toMatchObject({
      taskId: TASK_ID,
      deliveryTaskId: TASK_ID,
      declaredStages: [
        { stageId: 'spec', after: [] },
        { stageId: 'implement', after: ['spec'] },
      ],
    });
    expect(v2.state.taskUpserts[0]).toMatchObject({
      where: { workspaceId_id: { workspaceId: 'workspace-1', id: TASK_ID } },
      update: {},
    });
  });

  it('projects a canonical V3 work-item set under a locked run without creating canonical delivery rows', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [startedV3()] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });

    expect(store.state.tasks).toHaveLength(0);
    expect(store.state.taskUpserts).toHaveLength(0);
    expect([...store.state.workItems.values()]).toEqual([
      {
        id: 1n,
        workspaceId: 'workspace-1',
        workflowRunId: `run:${RUN_ID}`,
        provider: 'jira',
        externalId: '10042',
        externalKey: 'CORE-123',
      },
      {
        id: 2n,
        workspaceId: 'workspace-1',
        workflowRunId: `run:${RUN_ID}`,
        provider: 'linear',
        externalId: 'LIN-42',
        externalKey: 'ENG-42',
      },
    ]);
    expect([...store.state.runs.values()][0]).toMatchObject({
      declaredStages: [
        { stageId: 'spec', after: [] },
        { stageId: 'implement', after: ['spec'] },
      ],
    });
    expect(store.state.runLockQueries).toHaveLength(1);
    expect(store.state.runLockQueries[0]).toMatchObject({ values: ['workspace-1', RUN_ID] });
    expect(store.state.runLockQueries[0]?.sql).toContain('FOR UPDATE');
  });

  it('accepts a distinct equal V3 identity set, retains first keys, and rolls back a different set', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const first = startedV3();
    const equal = {
      ...first,
      eventId: '77777777-7777-4777-8777-777777777777',
      data: {
        ...first.data,
        workItems: [
          { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' },
          { provider: 'linear', externalId: 'LIN-42' },
        ],
      },
    };
    const different = {
      ...first,
      eventId: '88888888-8888-4888-8888-888888888888',
      data: {
        ...first.data,
        workItems: [{ provider: 'jira', externalId: '99999', externalKey: 'OTHER-1' }],
      },
    };

    await service.ingest('workspace-1', actor, { events: [first] });
    await expect(service.ingest('workspace-1', actor, { events: [equal, different] })).resolves.toEqual({
      acceptedEventIds: [equal.eventId],
      duplicateEventIds: [],
      rejected: [{ eventId: different.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(
      [...store.state.workItems.values()].map(({ provider, externalId, externalKey }) => ({
        provider,
        externalId,
        externalKey,
      })),
    ).toEqual([
      { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
      { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
    ]);
    expect(store.state.captureEvents.has(`workspace-1:${different.eventId}`)).toBe(false);
  });

  it('compares repeated V3 relations as a set independently of database collation order', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const first = startedV3({
      data: {
        ...startedV3().data,
        workItems: [
          { provider: 'jira', externalId: 'Z-1' },
          { provider: 'jira', externalId: 'a-1' },
        ],
      },
    });
    const replay = { ...first, eventId: '77777777-7777-4777-8777-777777777777' };

    await service.ingest('workspace-1', actor, { events: [first] });
    await expect(service.ingest('workspace-1', actor, { events: [replay] })).resolves.toEqual({
      acceptedEventIds: [replay.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
  });

  it('rejects explicit V2 task attribution and V3 work items in both arrival orders', async () => {
    const v2First = memoryPrisma();
    const v3First = memoryPrisma();
    const v3 = startedV3({ eventId: '77777777-7777-4777-8777-777777777777' });
    const v2 = startedV2({ eventId: '88888888-8888-4888-8888-888888888888' });

    await new CaptureService(v2First.prisma).ingest('workspace-1', actor, { events: [v2] });
    await expect(new CaptureService(v2First.prisma).ingest('workspace-1', actor, { events: [v3] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: v3.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(v2First.state.tasks).toHaveLength(1);
    expect(v2First.state.workItems).toHaveLength(0);

    await new CaptureService(v3First.prisma).ingest('workspace-1', actor, { events: [v3] });
    await expect(new CaptureService(v3First.prisma).ingest('workspace-1', actor, { events: [v2] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: v2.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(v3First.state.tasks).toHaveLength(0);
    expect(v3First.state.workItems).toHaveLength(2);
  });

  it('keeps attempt-two stage facts on a V3 run without synthesizing task-scoped rework', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const firstOccurrence = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondOccurrence = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await service.ingest('workspace-1', actor, {
      events: [
        startedV3(),
        stageStarted('spec', firstOccurrence, 1),
        stageFinished('spec', firstOccurrence, 1),
        stageStarted('spec', secondOccurrence, 2, {
          eventId: '99999999-9999-4999-8999-999999999999',
          occurredAt: '2026-08-15T10:03:00.000Z',
        }),
      ],
    });

    expect(store.state.stages).toHaveLength(2);
    expect(store.state.reworkSignals).toHaveLength(0);
    expect(store.state.reworkCreates).toHaveLength(0);
  });

  it('projects a stage start and finish into the same row in either delivery order', async () => {
    const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const forward = memoryPrisma();
    const reverse = memoryPrisma();
    const start = stageStarted('spec', occurrenceId, 1);
    const finish = stageFinished('spec', occurrenceId, 1);

    await new CaptureService(forward.prisma).ingest('workspace-1', actor, {
      events: [startedV2(), start, finish],
    });
    await new CaptureService(reverse.prisma).ingest('workspace-1', actor, {
      events: [startedV2(), finish, start],
    });

    expect([...reverse.state.stages.values()][0]).toEqual([...forward.state.stages.values()][0]);
    expect([...forward.state.stages.values()][0]).toMatchObject({
      id: occurrenceId,
      stageId: 'spec',
      attempt: 1,
      startedAt: new Date('2026-08-15T10:01:00.000Z'),
      finishedAt: new Date('2026-08-15T10:02:00.000Z'),
      outcome: 'success',
    });
    expect(forward.state.stageCreates).toHaveLength(1);
    expect(reverse.state.stageCreates).toHaveLength(1);
  });

  it('does not reproject an exact duplicate stage event id', async () => {
    const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const stage = stageStarted('spec', occurrenceId, 1);
    await service.ingest('workspace-1', actor, { events: [startedV2(), stage] });
    const stageWritesBeforeRetry = store.state.stageUpserts.length + store.state.stageCreates.length;

    await expect(service.ingest('workspace-1', actor, { events: [stage] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [stage.eventId],
      rejected: [],
    });
    expect(store.state.stageUpserts.length + store.state.stageCreates.length).toBe(stageWritesBeforeRetry);
    expect(store.state.stages).toHaveLength(1);
  });

  it('writes no rework signal for a stage re-entry, on any of the paths that used to emit one', async () => {
    // A stage re-entry is an iteration fact, not rework (ADR-20260908-per-member-delivery-filter
    // era rework rule): capture no longer projects `stage_reentry`, on the direct attempt-two
    // start, on a finish-first re-entry, or on the late run start that used to backfill it.
    const firstOccurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const secondOccurrenceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondStart = stageStarted('spec', secondOccurrenceId, 2, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:03:00.000Z',
    });
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);

    await service.ingest('workspace-1', actor, {
      events: [startedV2(), stageStarted('spec', firstOccurrenceId, 1), stageFinished('spec', firstOccurrenceId, 1)],
    });
    await expect(service.ingest('workspace-1', actor, { events: [secondStart] })).resolves.toEqual({
      acceptedEventIds: [secondStart.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(store.state.stages).toHaveLength(2);
    expect(store.state.reworkSignals).toHaveLength(0);
    expect(store.state.reworkCreates).toHaveLength(0);

    // Finish-first re-entry, then its start, on a run whose task is only established afterwards.
    const lateStore = memoryPrisma();
    const lateService = new CaptureService(lateStore.prisma);
    await lateService.ingest('workspace-1', actor, {
      events: [
        stageFinished('spec', firstOccurrenceId, 1, {
          eventId: '66666666-6666-4666-8666-666666666666',
          occurredAt: '2026-08-15T10:02:00.000Z',
        }),
        stageFinished('spec', secondOccurrenceId, 2, {
          eventId: '77777777-7777-4777-8777-777777777777',
          occurredAt: '2026-08-15T10:03:00.000Z',
        }),
        stageStarted('spec', secondOccurrenceId, 2, {
          eventId: '88888888-8888-4888-8888-888888888888',
          occurredAt: '2026-08-15T10:02:30.000Z',
        }),
        startedV2(),
      ],
    });
    expect(lateStore.state.reworkSignals).toHaveLength(0);
    expect(lateStore.state.reworkCreates).toHaveLength(0);
  });

  it('rejects an occurrence identity contradiction and rolls back the capture event', async () => {
    const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, { events: [startedV2(), stageStarted('spec', occurrenceId, 1)] });

    const contradiction = stageFinished('spec', occurrenceId, 2, {
      eventId: '55555555-5555-4555-8555-555555555555',
    });
    await expect(service.ingest('workspace-1', actor, { events: [contradiction] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: contradiction.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(2);
    expect(store.state.stages).toHaveLength(1);
  });

  it('rejects a second occurrence UUID claiming an established stage attempt', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, {
      events: [startedV2(), stageStarted('spec', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1)],
    });
    const collision = stageFinished('spec', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, {
      eventId: '55555555-5555-4555-8555-555555555555',
    });

    await expect(service.ingest('workspace-1', actor, { events: [collision] })).resolves.toMatchObject({
      rejected: [{ eventId: collision.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.stages).toHaveLength(1);
  });

  it('rejects a later stage finish with a different time or outcome', async () => {
    const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, {
      events: [startedV2(), stageFinished('spec', occurrenceId, 1)],
    });
    const contradiction = stageFinished('spec', occurrenceId, 1, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:03:00.000Z',
      data: { occurrenceId, stageId: 'spec', attempt: 1, outcome: 'failed' },
    });

    await expect(service.ingest('workspace-1', actor, { events: [contradiction] })).resolves.toMatchObject({
      rejected: [{ eventId: contradiction.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(2);
  });

  it('enforces declared membership and completed dependencies before a stage starts', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, { events: [startedV2()] });

    const unknown = stageStarted('review', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1);
    const dependencyNotFinished = stageStarted('implement', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, {
      eventId: '55555555-5555-4555-8555-555555555555',
    });
    await expect(service.ingest('workspace-1', actor, { events: [unknown, dependencyNotFinished] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [
        { eventId: unknown.eventId, code: 'CONTRADICTING_FACT' },
        { eventId: dependencyNotFinished.eventId, code: 'CONTRADICTING_FACT' },
      ],
    });
    expect(store.state.stages).toHaveLength(0);
  });

  it('validates authenticated stage dependencies without rescanning every occurrence', () => {
    const stageCount = 12;
    const attemptsPerStage = 20;
    const declaration = Array.from({ length: stageCount }, (_, stageIndex) => ({
      stageId: `stage-${stageIndex}`,
      after: stageIndex === 0 ? [] : [`stage-${stageIndex - 1}`],
    }));
    let stageIdReads = 0;
    const occurrences = declaration.flatMap((stage, stageIndex) =>
      Array.from({ length: attemptsPerStage }, (_, attemptIndex) => {
        const boundary = new Date(stageIndex * attemptsPerStage + attemptIndex + 1);
        return {
          id: `${stageIndex}:${attemptIndex}`,
          workflowRunId: 'run-1',
          get stageId() {
            stageIdReads += 1;
            return stage.stageId;
          },
          attempt: attemptIndex + 1,
          startedAt: boundary,
          finishedAt: boundary,
          outcome: 'success',
        };
      }),
    );
    const service = new CaptureService({} as PrismaService);
    const validate = (
      service as unknown as {
        assertValidStageFacts: (declared: typeof declaration, rows: typeof occurrences) => void;
      }
    ).assertValidStageFacts.bind(service);

    expect(() => validate(declaration, occurrences)).not.toThrow();
    expect(stageIdReads).toBeLessThanOrEqual(occurrences.length * 8);
  });

  it('rejects a keyed stage fact that contradicts its established run repository', async () => {
    const store = memoryPrisma(['coredoc/coredoc-parser', 'other/repository']);
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, { events: [startedV2()] });
    const stage = stageStarted('spec', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1, {
      repositoryKey: 'other/repository',
    });

    await expect(service.ingest('workspace-1', actor, { events: [stage] })).resolves.toMatchObject({
      rejected: [{ eventId: stage.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.stages).toHaveLength(0);
  });

  it('requires contiguous re-entry attempts after the prior attempt finishes', async () => {
    const firstId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const secondId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, {
      events: [startedV2(), stageStarted('spec', firstId, 1)],
    });

    const earlySecond = stageStarted('spec', secondId, 2, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:02:30.000Z',
    });
    await expect(service.ingest('workspace-1', actor, { events: [earlySecond] })).resolves.toMatchObject({
      rejected: [{ eventId: earlySecond.eventId, code: 'CONTRADICTING_FACT' }],
    });

    await service.ingest('workspace-1', actor, {
      events: [
        stageFinished('spec', firstId, 1),
        stageStarted('spec', secondId, 2, {
          eventId: '66666666-6666-4666-8666-666666666666',
          occurredAt: '2026-08-15T10:03:00.000Z',
        }),
      ],
    });
    expect([...store.state.stages.values()].map((row) => row.attempt)).toEqual([1, 2]);
  });

  it('reconciles valid finish-first occurrences when the declaration arrives', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const spec = stageFinished('spec', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:01:00.000Z',
    });
    const implement = stageFinished('implement', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, {
      eventId: '66666666-6666-4666-8666-666666666666',
      occurredAt: '2026-08-15T10:02:00.000Z',
    });

    await service.ingest('workspace-1', actor, { events: [spec, implement] });
    await expect(service.ingest('workspace-1', actor, { events: [startedV2()] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(store.state.stages).toHaveLength(2);
  });

  it('compares repeated declarations structurally while preserving stage order', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, { events: [startedV2()] });
    const run = [...store.state.runs.values()][0];
    run.declaredStages = [
      { after: [], stageId: 'spec' },
      { after: ['spec'], stageId: 'implement' },
    ];

    const exactRetry = startedV2({ eventId: '55555555-5555-4555-8555-555555555555' });
    await expect(service.ingest('workspace-1', actor, { events: [exactRetry] })).resolves.toMatchObject({
      acceptedEventIds: [exactRetry.eventId],
      rejected: [],
    });

    const reordered = startedV2({
      eventId: '66666666-6666-4666-8666-666666666666',
      data: {
        workflowId: 'change:large:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'large',
        stages: [
          { stageId: 'implement', after: [] },
          { stageId: 'spec', after: [] },
        ],
      },
    });
    await expect(service.ingest('workspace-1', actor, { events: [reordered] })).resolves.toMatchObject({
      rejected: [{ eventId: reordered.eventId, code: 'CONTRADICTING_FACT' }],
    });
  });

  it('rolls back a declaration that contradicts a finish-first dependency', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const implement = stageFinished('implement', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, {
      eventId: '66666666-6666-4666-8666-666666666666',
      occurredAt: '2026-08-15T10:02:00.000Z',
    });
    await service.ingest('workspace-1', actor, { events: [implement] });

    await expect(service.ingest('workspace-1', actor, { events: [startedV2()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(1);
    expect([...store.state.runs.values()][0]).not.toHaveProperty('declaredStages');
  });

  it('refuses a start time after the established finish time', async () => {
    const occurrenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, {
      events: [startedV2(), stageFinished('spec', occurrenceId, 1)],
    });
    const lateStart = stageStarted('spec', occurrenceId, 1, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:03:00.000Z',
    });

    await expect(service.ingest('workspace-1', actor, { events: [lateStart] })).resolves.toMatchObject({
      rejected: [{ eventId: lateStart.eventId, code: 'CONTRADICTING_FACT' }],
    });
    expect([...store.state.stages.values()][0]).toMatchObject({ startedAt: null });
  });

  it('does not legitimize a finish-first attempt gap when the declaration arrives', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const second = stageFinished('spec', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2, {
      eventId: '66666666-6666-4666-8666-666666666666',
    });
    await expect(service.ingest('workspace-1', actor, { events: [second] })).resolves.toMatchObject({
      rejected: [{ eventId: second.eventId, code: 'CONTRADICTING_FACT' }],
    });

    await service.ingest('workspace-1', actor, { events: [finished({ schemaVersion: 2 })] });
    store.state.stages.set('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      workflowRunId: `run:${RUN_ID}`,
      stageId: 'spec',
      attempt: 2,
      startedAt: null,
      finishedAt: new Date('2026-08-15T10:02:00.000Z'),
      outcome: 'success',
    });

    await expect(service.ingest('workspace-1', actor, { events: [startedV2()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'CONTRADICTING_FACT' }],
    });
    expect([...store.state.runs.values()][0]).not.toHaveProperty('declaredStages');
  });

  it('rejects a canonical task repository contradiction atomically', async () => {
    const store = memoryPrisma();
    store.state.tasks.set(`workspace-1:${TASK_ID}`, {
      id: TASK_ID,
      workspaceId: 'workspace-1',
      repositoryKey: 'other/repository',
      lifecycle: 'active',
      authority: 'coredoc',
      createdBy: actor.id,
    });
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [startedV2()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(0);
    expect(store.state.sessions).toHaveLength(0);
    expect(store.state.runs).toHaveLength(0);
  });

  it('links an established unattributed task without late-binding its repository', async () => {
    const store = memoryPrisma();
    store.state.tasks.set(`workspace-1:${TASK_ID}`, {
      id: TASK_ID,
      workspaceId: 'workspace-1',
      repositoryKey: null,
      lifecycle: 'active',
      authority: 'coredoc',
      createdBy: actor.id,
    });
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [startedV2()] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(store.state.tasks.get(`workspace-1:${TASK_ID}`)?.repositoryKey).toBeNull();
    expect([...store.state.runs.values()][0]).toMatchObject({
      taskId: TASK_ID,
      deliveryTaskId: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
    });
    expect(store.state.taskUpserts[0]).toMatchObject({ update: {} });
    expect(store.state.captureEvents).toHaveLength(1);
  });

  it('rejects a contradictory established fact and rolls back its event insert', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    await service.ingest('workspace-1', actor, { events: [started()] });
    const contradictory = started({
      eventId: '44444444-4444-4444-8444-444444444444',
      data: { workflowId: 'review:normal', intent: 'review', risk: 'normal', scale: 'normal' },
    });

    await expect(service.ingest('workspace-1', actor, { events: [contradictory] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: '44444444-4444-4444-8444-444444444444', code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(1);
    expect([...store.state.runs.values()][0]).toMatchObject({ workflowId: 'change:large:normal', intent: 'change' });
  });

  it('stores a direct capability without fabricating a WorkflowRun', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const capability = {
      schemaVersion: 1,
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-08-15T10:01:00.000Z',
      host: 'claude-code',
      sessionId: 'session-42',
      type: 'capability.used',
      data: { kind: 'skill', capabilityId: 'coredoc-spec', outcome: 'success' },
    };

    await service.ingest('workspace-1', actor, { events: [capability] });
    expect(store.state.captureEvents).toHaveLength(1);
    expect(store.state.sessions).toHaveLength(1);
    expect(store.state.runs).toHaveLength(0);
  });

  it('writes a parameterized Claude repository watermark only after an event projection is accepted', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const capability = capabilityUsed({ repositoryKey: 'coredoc/coredoc-parser' });
    const workflow = started();

    await expect(service.ingest('workspace-1', actor, { events: [capability, workflow] })).resolves.toEqual({
      acceptedEventIds: [capability.eventId, workflow.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    const watermarkKey = `workspace-1:${actor.id}:claude-code:repo:coredoc/coredoc-parser`;
    const acceptedWatermark = {
      workspaceId: 'workspace-1',
      actorId: actor.id,
      host: 'claude-code',
      scopeKey: 'repo:coredoc/coredoc-parser',
      repositoryKey: 'coredoc/coredoc-parser',
      firstAcceptedAt: new Date('2026-08-15T12:00:00.000Z'),
      lastAcceptedAt: new Date('2026-08-15T12:00:01.000Z'),
      workflowLastAcceptedAt: new Date('2026-08-15T12:00:01.000Z'),
    };
    expect(store.state.watermarks.get(watermarkKey)).toEqual(acceptedWatermark);

    await expect(service.ingest('workspace-1', actor, { events: [workflow] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [workflow.eventId],
      rejected: [],
    });
    const contradiction = started({
      eventId: '66666666-6666-4666-8666-666666666666',
      data: { workflowId: 'review:normal', intent: 'review', risk: 'normal', scale: 'normal' },
    });
    await expect(service.ingest('workspace-1', actor, { events: [contradiction] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: contradiction.eventId, code: 'CONTRADICTING_FACT' }],
    });
    const unattributed = capabilityUsed({
      eventId: '77777777-7777-4777-8777-777777777777',
      sessionId: 'unattributed-session',
    });
    await expect(service.ingest('workspace-1', actor, { events: [unattributed] })).resolves.toEqual({
      acceptedEventIds: [unattributed.eventId],
      duplicateEventIds: [],
      rejected: [],
    });

    expect(store.state.watermarks).toHaveLength(1);
    expect(store.state.watermarks.get(watermarkKey)).toEqual(acceptedWatermark);
    expect(store.state.watermarkQueries).toHaveLength(2);
    const [capabilityQuery, workflowQuery] = store.state.watermarkQueries;
    expect(capabilityQuery?.sql).toContain('INSERT INTO capture_accepted_watermarks');
    expect(capabilityQuery?.sql).toContain('ON CONFLICT (workspace_id, actor_id, host, scope_key) DO UPDATE');
    expect(capabilityQuery?.sql).toContain('LEAST(');
    expect(capabilityQuery?.sql).toContain('GREATEST(');
    expect(capabilityQuery?.sql).not.toContain(actor.id);
    expect(capabilityQuery?.sql).not.toContain('coredoc/coredoc-parser');
    expect(capabilityQuery?.values.slice(0, 5)).toEqual([
      'workspace-1',
      actor.id,
      'claude-code',
      'repo:coredoc/coredoc-parser',
      'coredoc/coredoc-parser',
    ]);
    expect(capabilityQuery?.values[7]).toBeNull();
    expect(workflowQuery?.values[7]).toEqual(new Date('2026-08-15T12:00:01.000Z'));
  });

  it('writes Codex repository events to their repository watermark and treats stages as workflow facts', async () => {
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    const capability = capabilityUsed({
      eventId: '88888888-8888-4888-8888-888888888888',
      host: 'codex',
      sessionId: 'codex-session',
      repositoryKey: 'coredoc/coredoc-parser',
    });
    const stage = stageStarted('spec', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1, {
      eventId: '99999999-9999-4999-8999-999999999999',
      host: 'codex',
      sessionId: 'codex-session',
      repositoryKey: 'coredoc/coredoc-parser',
    });

    await expect(service.ingest('workspace-1', actor, { events: [capability, stage] })).resolves.toEqual({
      acceptedEventIds: [capability.eventId, stage.eventId],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(store.state.watermarks).toEqual(
      new Map([
        [
          `workspace-1:${actor.id}:codex:repo:coredoc/coredoc-parser`,
          {
            workspaceId: 'workspace-1',
            actorId: actor.id,
            host: 'codex',
            scopeKey: 'repo:coredoc/coredoc-parser',
            repositoryKey: 'coredoc/coredoc-parser',
            firstAcceptedAt: new Date('2026-08-15T12:00:00.000Z'),
            lastAcceptedAt: new Date('2026-08-15T12:00:01.000Z'),
            workflowLastAcceptedAt: new Date('2026-08-15T12:00:01.000Z'),
          },
        ],
      ]),
    );
    expect(store.state.watermarkQueries.map((query) => query.values.slice(2, 5))).toEqual([
      ['codex', 'repo:coredoc/coredoc-parser', 'coredoc/coredoc-parser'],
      ['codex', 'repo:coredoc/coredoc-parser', 'coredoc/coredoc-parser'],
    ]);
  });

  it('rejects an event whose session id is already claimed by another provider', async () => {
    // Observed live: plugin hooks running under Codex mislabeled events as claude-code while
    // telemetry had created the session as codex. The provider-scoped upsert would CREATE and
    // hit the legacy (workspace_id, session_id) unique — a deterministic P2002 that turned the
    // whole batch into an unhandled 500 on every relay retry. It must be a permanent rejection.
    const store = memoryPrisma();
    const service = new CaptureService(store.prisma);
    store.state.sessions.set('workspace-1:codex:session-42', {
      id: 'session:codex:session-42',
      workspaceId: 'workspace-1',
      provider: 'codex',
      sessionId: 'session-42',
      userId: actor.id,
    });

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: START_ID, code: 'CONTRADICTING_FACT' }],
    });
    expect(store.state.captureEvents).toHaveLength(0);
  });

  it('rolls back both the event and session when projection persistence fails', async () => {
    const store = memoryPrisma();
    store.state.failProjection = true;
    const service = new CaptureService(store.prisma);

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).rejects.toThrow(
      'forced projection failure',
    );
    expect(store.state.captureEvents).toHaveLength(0);
    expect(store.state.sessions).toHaveLength(0);
    expect(store.state.runs).toHaveLength(0);
  });

  it('never classifies an unrelated unique violation as a duplicate event', async () => {
    const error = Object.assign(new Error('workflow run race'), {
      code: 'P2002',
      meta: {
        modelName: 'WorkflowRun',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['workspace_id', 'run_id'] },
          },
        },
      },
    });
    let duplicateLookups = 0;
    let transactionAttempts = 0;
    const prisma = {
      $transaction: async () => {
        transactionAttempts += 1;
        throw error;
      },
      captureEvent: {
        findUnique: async () => {
          duplicateLookups += 1;
          return null;
        },
      },
    } as unknown as PrismaService;
    const service = new CaptureService(prisma);

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).rejects.toBe(error);
    expect(transactionAttempts).toBe(2);
    expect(duplicateLookups).toBe(1);
  });

  it.each([
    'AgentSession',
    'WorkflowRun',
    'DeliveryTask',
  ])('retries one concurrent first write for %s before classifying the event', async (modelName) => {
    const error = Object.assign(new Error(`${modelName} first-write race`), {
      code: 'P2002',
      meta: { modelName },
    });
    const transaction = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('accepted');
    const duplicateLookup = vi.fn(async () => null);
    const service = new CaptureService({
      $transaction: transaction,
      captureEvent: { findUnique: duplicateLookup },
    } as unknown as PrismaService);

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [START_ID],
      duplicateEventIds: [],
      rejected: [],
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(duplicateLookup).not.toHaveBeenCalled();
  });

  it('classifies a racing event insert as duplicate only after that event exists', async () => {
    const error = Object.assign(new Error('capture event race'), {
      code: 'P2002',
      meta: {
        modelName: 'CaptureEvent',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['workspace_id', 'event_id'] },
          },
        },
      },
    });
    let duplicateLookups = 0;
    let transactionAttempts = 0;
    const prisma = {
      $transaction: async () => {
        transactionAttempts += 1;
        throw error;
      },
      captureEvent: {
        findUnique: async () => {
          duplicateLookups += 1;
          return { id: 1n };
        },
      },
    } as unknown as PrismaService;
    const service = new CaptureService(prisma);

    await expect(service.ingest('workspace-1', actor, { events: [started()] })).resolves.toEqual({
      acceptedEventIds: [],
      duplicateEventIds: [START_ID],
      rejected: [],
    });
    expect(transactionAttempts).toBe(2);
    expect(duplicateLookups).toBe(1);
  });
});
