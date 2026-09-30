import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSessionsService } from './agent-sessions.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { LogRecordEvent, SessionDelta, SessionLogRecords } from './otlp-parser.js';
import { WORKFLOW_STALENESS_WINDOW_MS, stalenessCutoff } from '../../libs/usage/workflow-completeness.js';

function delta(over: Partial<SessionDelta>): SessionDelta {
  return {
    provider: 'claude-code',
    sessionId: 'sess-1',
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensReasoning: 0,
    costUsd: 0,
    activeTimeSec: 0,
    commitCount: 0,
    prCount: 0,
    coredocToolCalls: 0,
    coredocTools: {},
    locAdded: 0,
    locRemoved: 0,
    coredocToolStats: {},
    skillsUsed: {},
    maxEventNanos: 0n,
    countedEvents: 0,
    ...over,
  };
}

function logBatch(over: Partial<SessionLogRecords>): SessionLogRecords {
  return { provider: 'claude-code', sessionId: 'sess-1', records: [], ...over };
}

const apiRecord = (nanos: bigint, inputTokens: number): LogRecordEvent => ({
  nanos,
  name: 'api_request',
  attrs: { input_tokens: inputTokens },
});

const coredocRecord = (nanos: bigint, success: string, durationMs: number): LogRecordEvent => ({
  nanos,
  name: 'tool_result',
  attrs: { tool_name: 'mcp__coredoc__search_symbols', success, duration_ms: durationMs },
});

function mockPrisma(existing: any = null) {
  const upsert = vi.fn().mockResolvedValue({ id: 'row-1' });
  // The LOG path writes through create + a conditional updateMany (the watermark
  // compare-and-swap); the METRIC path still upserts. Both are recorded into one
  // call log in the {where, create, update} shape the assertions below read, so a
  // test pins the PAYLOAD without caring which statement carried it. `_updateMany`
  // is exposed separately for the cases that need the swap predicate itself.
  const updateMany = vi.fn(async ({ where, data }: any) => {
    upsert({ where, update: data });
    return { count: 1 };
  });
  const create = vi.fn(async ({ data }: any) => {
    upsert({
      where: {
        workspaceId_provider_sessionId: {
          workspaceId: data.workspaceId,
          provider: data.provider,
          sessionId: data.sessionId,
        },
      },
      create: data,
    });
    return { id: 'row-1' };
  });
  return {
    agentSession: {
      findUnique: vi.fn().mockResolvedValue(existing),
      upsert,
      create,
      updateMany,
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    captureEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    captureProvisioning: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    captureAcceptedWatermark: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    captureRetentionCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    workflowRun: {
      // The activity read asks this model a windowed `findMany`, a capped unfinished `findMany`
      // (`where.finishedAt === null`) and two unfinished counts. Answering the windowed and the
      // unfinished reads with the same rows would count a finished run twice, so the default
      // answers every one of them with nothing and tests that need rows opt in via
      // `mockRunQueries`, which honours `where.finishedAt`.
      findMany: vi.fn((args: any = {}) => Promise.resolve(args.where?.finishedAt === null ? [] : [])),
      count: vi.fn().mockResolvedValue(0),
    },
    taskExternalRef: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    workspaceMember: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    mcpQueryMetric: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // The run reads run as one snapshot; the mock only has to resolve the batch in order.
    $transaction: vi.fn((operations: unknown[]) => Promise.all(operations)),
    _upsert: upsert,
    _create: create,
    _updateMany: updateMany,
  } as unknown as PrismaService & {
    _upsert: ReturnType<typeof vi.fn>;
    _create: ReturnType<typeof vi.fn>;
    _updateMany: ReturnType<typeof vi.fn>;
  };
}

function asMock(method: unknown): ReturnType<typeof vi.fn> {
  return method as ReturnType<typeof vi.fn>;
}

describe('AgentSessionsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: AgentSessionsService;
  beforeEach(() => {
    prisma = mockPrisma();
    service = new AgentSessionsService(prisma as any);
  });

  it('applyMetricDeltas sets active time and commits (max semantics) on create', async () => {
    await service.applyMetricDeltas('ws-1', [delta({ activeTimeSec: 42, commitCount: 2 })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      workspaceId_provider_sessionId: { workspaceId: 'ws-1', provider: 'claude-code', sessionId: 'sess-1' },
    });
    expect(call.create.provider).toBe('claude-code');
    expect(call.create.activeTimeSec).toBe(42);
    expect(call.create.commitCount).toBe(2);
  });

  it('applyLogDeltas increments token counters and advances the watermark', async () => {
    await service.applyLogDeltas('ws-1', [
      logBatch({ records: [apiRecord(200n, 500), coredocRecord(150n, 'true', 80)] }),
    ]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create.tokensInput).toBe(500);
    expect(call.create.coredocToolCalls).toBe(1);
    expect(call.create.lastEventNanos).toBe(200n);
    // No stored row, so this is the insert. The `{ increment }` half of the write
    // is pinned by the overlapping-batch test below, which seeds a row and so takes
    // the conditional-update path.
  });

  it('persists Codex provider identity and reasoning tokens without rewriting them as Claude', async () => {
    await service.applyLogDeltas('ws-1', [
      logBatch({
        provider: 'codex',
        sessionId: 'conversation-1',
        model: 'gpt-5.6-sol',
        appVersion: '0.146.0',
        records: [
          {
            nanos: 200n,
            name: 'sse_event',
            attrs: {
              'event.kind': 'response.completed',
              model_reasoning_effort: 'low',
              input_token_count: 100,
              output_token_count: 20,
              cached_token_count: 40,
              cache_write_token_count: 5,
              reasoning_token_count: 7,
            },
          },
        ],
      }),
    ]);

    const call = prisma._upsert.mock.calls[0][0];
    expect(call.where.workspaceId_provider_sessionId).toEqual({
      workspaceId: 'ws-1',
      provider: 'codex',
      sessionId: 'conversation-1',
    });
    expect(call.create.provider).toBe('codex');
    expect(call.create.model).toBe('gpt-5.6-sol');
    expect(call.create.appVersion).toBe('0.146.0');
    expect(call.create.tokensReasoning).toBe(7);
  });

  it('applyLogDeltas skips a fully-replayed batch at-or-below the watermark', async () => {
    prisma = mockPrisma({ id: 'row-1', lastEventNanos: 200n, coredocTools: {}, coredocToolStats: {} });
    service = new AgentSessionsService(prisma as any);
    await service.applyLogDeltas('ws-1', [logBatch({ records: [apiRecord(150n, 500), apiRecord(200n, 300)] })]);
    expect(prisma._upsert).not.toHaveBeenCalled();
  });

  it('applyLogDeltas counts only records newer than the watermark in an overlapping batch', async () => {
    prisma = mockPrisma({ id: 'row-1', lastEventNanos: 200n, coredocTools: {}, coredocToolStats: {} });
    service = new AgentSessionsService(prisma as any);
    // 150n/200n are replays (already counted); only 300n is new.
    await service.applyLogDeltas('ws-1', [
      logBatch({ records: [apiRecord(150n, 500), apiRecord(200n, 300), apiRecord(300n, 70)] }),
    ]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toEqual({ increment: 70 });
    expect(call.update.lastEventNanos).toBe(300n);
  });

  it('applyLogDeltas never regresses the watermark on out-of-order batches', async () => {
    prisma = mockPrisma({ id: 'row-1', lastEventNanos: 500n, coredocTools: {}, coredocToolStats: {} });
    service = new AgentSessionsService(prisma as any);
    // A record with an unknown timestamp (0n) is still counted, but the stored
    // watermark must stay at 500n, not regress to 0n.
    await service.applyLogDeltas('ws-1', [logBatch({ records: [{ ...apiRecord(0n, 25) }] })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toEqual({ increment: 25 });
    expect(call.update.lastEventNanos).toBe(500n);
  });

  it('applyLogDeltas re-reads instead of re-adding when a concurrent batch wins the watermark swap', async () => {
    // The lost-update shape: two POSTs for one session read the same watermark and
    // both judge the same records new. The swap lets exactly one write land; the
    // loser must re-aggregate against the WINNER's watermark, which filters out the
    // records the winner already counted — not increment a second time.
    const seeded = {
      id: 'row-1',
      revision: 7,
      lastEventNanos: 0n,
      coredocTools: {},
      coredocToolStats: {},
      skillsUsed: {},
    };
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(seeded)
      // The winner advanced both while we were merging.
      .mockResolvedValue({ ...seeded, revision: 8, lastEventNanos: 100n });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const local = {
      agentSession: { findUnique, updateMany, create: vi.fn(), upsert: vi.fn() },
    } as unknown as PrismaService;
    const localService = new AgentSessionsService(local as any);

    await localService.applyLogDeltas('ws-1', [logBatch({ records: [apiRecord(100n, 500)] })]);

    // One losing attempt, then the re-read finds nothing new and stops. No second
    // write, so the 500 tokens the winner already stored are never added again.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.revision).toBe(7);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('swaps on the revision, not the watermark, so a zero-timestamp event still serializes', async () => {
    // The hole a watermark-keyed swap leaves open. A direct workflow event carries
    // no source time, so `nextWatermark` comes back EQUAL to the stored watermark —
    // a swap keyed on it would still match for a concurrent writer, and that writer
    // would overwrite the whole skillsUsed map this event just wrote. The key has to
    // be something that moves on every write.
    const seeded = {
      id: 'row-1',
      revision: 3,
      lastEventNanos: 500n,
      coredocTools: {},
      coredocToolStats: {},
      skillsUsed: {},
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const local = {
      agentSession: { findUnique: vi.fn().mockResolvedValue(seeded), updateMany, create: vi.fn(), upsert: vi.fn() },
    } as unknown as PrismaService;
    const localService = new AgentSessionsService(local as any);

    await localService.applyLogDeltas('ws-1', [logBatch({ records: [coredocRecord(0n, 'true', 10)] })]);

    const call = updateMany.mock.calls[0][0];
    // The watermark did NOT move — which is exactly why it cannot be the swap key.
    expect(call.data.lastEventNanos).toBe(500n);
    expect(call.where.lastEventNanos).toBeUndefined();
    // The revision is the key, and it advances.
    expect(call.where.revision).toBe(3);
    expect(call.data.revision).toEqual({ increment: 1 });
  });

  it('applyLogDeltas throws when a batch fails to persist (no silent success envelope)', async () => {
    // The log path inserts through `create` (the metric path still upserts).
    (prisma.agentSession.create as any).mockRejectedValue(new Error('db down'));
    await expect(service.applyLogDeltas('ws-1', [logBatch({ records: [apiRecord(100n, 10)] })])).rejects.toThrow(
      /failed to persist/,
    );
  });

  it('applyMetricDeltas persists model and LoC with max semantics', async () => {
    await service.applyMetricDeltas('ws-1', [delta({ model: 'claude-fable-5', locAdded: 120, locRemoved: 30 })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create.model).toBe('claude-fable-5');
    expect(call.create.locAdded).toBe(120);
    expect(call.update.model).toBe('claude-fable-5');
    expect(call.update.locAdded).toBe(120); // max(existing 0, 120)
  });

  it('applyMetricDeltas persists token/cost fields from the delta on create', async () => {
    await service.applyMetricDeltas('ws-1', [
      delta({ tokensInput: 100, tokensOutput: 50, tokensCacheRead: 10, tokensCacheCreation: 5, costUsd: 1.5 }),
    ]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.create.tokensInput).toBe(100);
    expect(call.create.tokensOutput).toBe(50);
    expect(call.create.tokensCacheRead).toBe(10);
    expect(call.create.tokensCacheCreation).toBe(5);
    expect(call.create.costUsd).toBe(1.5);
  });

  it('applyMetricDeltas max-merges token/cost fields on update (cumulative counters, never incremented)', async () => {
    prisma = mockPrisma({
      id: 'row-1',
      tokensInput: 200,
      tokensOutput: 20,
      tokensCacheRead: 30,
      tokensCacheCreation: 40,
      costUsd: 5,
    });
    service = new AgentSessionsService(prisma as any);
    // Existing is higher on tokensInput/tokensCacheRead, delta is higher on the rest.
    await service.applyMetricDeltas('ws-1', [
      delta({ tokensInput: 100, tokensOutput: 50, tokensCacheRead: 10, tokensCacheCreation: 90, costUsd: 3 }),
    ]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toBe(200); // existing higher, kept
    expect(call.update.tokensOutput).toBe(50); // delta higher, taken
    expect(call.update.tokensCacheRead).toBe(30); // existing higher, kept
    expect(call.update.tokensCacheCreation).toBe(90); // delta higher, taken
    expect(call.update.costUsd).toBe(5); // existing higher, kept
  });

  it('applyMetricDeltas replaying the same cumulative values does not inflate them', async () => {
    prisma = mockPrisma({
      id: 'row-1',
      tokensInput: 500,
      tokensOutput: 200,
      tokensCacheRead: 60,
      tokensCacheCreation: 30,
      costUsd: 7,
    });
    service = new AgentSessionsService(prisma as any);
    await service.applyMetricDeltas('ws-1', [
      delta({ tokensInput: 500, tokensOutput: 200, tokensCacheRead: 60, tokensCacheCreation: 30, costUsd: 7 }),
    ]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toBe(500);
    expect(call.update.tokensOutput).toBe(200);
    expect(call.update.tokensCacheRead).toBe(60);
    expect(call.update.tokensCacheCreation).toBe(30);
    expect(call.update.costUsd).toBe(7);
  });

  it('first counted log batch takes over metrics-seeded token/cost with max, not increment', async () => {
    // Dual-channel order "metrics first, logs second": the row holds the metrics
    // channel's cumulative seed for the SAME usage this batch's records cover.
    // Incrementing on top would double-count — the takeover reconciles with max.
    prisma = mockPrisma({
      id: 'row-1',
      revision: 1,
      lastEventNanos: 0n,
      tokensInput: 1000,
      tokensOutput: 400,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      costUsd: 5,
      coredocTools: {},
      coredocToolStats: {},
      skillsUsed: {},
    });
    service = new AgentSessionsService(prisma as any);
    await service.applyLogDeltas('ws-1', [logBatch({ records: [apiRecord(100n, 900)] })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toBe(1000); // max(seed 1000, logs 900) — not 1900
    expect(call.update.costUsd).toBe(5); // seed kept, not incremented
    expect(call.update.lastEventNanos).toBe(100n); // logs own the columns from here on
  });

  it('takeover reconciles bigint token columns above the int4 ceiling as numbers', async () => {
    // Token counters are Postgres bigint (a long session's cache reads pass 2^31),
    // so Prisma hands them back as bigint; the max-reconcile must still compute.
    prisma = mockPrisma({
      id: 'row-1',
      revision: 1,
      lastEventNanos: 0n,
      tokensInput: 3_000_000_000n,
      tokensOutput: 0n,
      tokensCacheRead: 5_000_000_000n,
      tokensCacheCreation: 0n,
      tokensReasoning: 0n,
      costUsd: 5,
      coredocTools: {},
      coredocToolStats: {},
      skillsUsed: {},
    });
    service = new AgentSessionsService(prisma as any);
    await service.applyLogDeltas('ws-1', [logBatch({ records: [apiRecord(100n, 900)] })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toBe(3_000_000_000);
    expect(call.update.tokensCacheRead).toBe(5_000_000_000);
  });

  it('applyMetricDeltas stops writing token/cost once the logs channel owns the session', async () => {
    prisma = mockPrisma({
      id: 'row-1',
      lastEventNanos: 500n,
      tokensInput: 2000,
      activeTimeSec: 10,
      coredocTools: {},
      coredocToolStats: {},
    });
    service = new AgentSessionsService(prisma as any);
    await service.applyMetricDeltas('ws-1', [delta({ tokensInput: 5000, costUsd: 9, activeTimeSec: 60 })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.tokensInput).toBeUndefined(); // logs-owned column left alone
    expect(call.update.costUsd).toBeUndefined();
    expect(call.update.activeTimeSec).toBe(60); // metrics still own active time
  });

  it('applyMetricDeltas throws when a delta fails to persist (no silent success envelope)', async () => {
    // Twin of the applyLogDeltas throw test: a swallowed persist failure answers
    // the OTLP exporter with a 2xx, it drops its buffer, and the deltas are lost.
    (prisma.agentSession.upsert as any).mockRejectedValue(new Error('db down'));
    await expect(service.applyMetricDeltas('ws-1', [delta({ activeTimeSec: 1 })])).rejects.toThrow(/failed to persist/);
  });

  it('applyLogDeltas merges coredoc tool stats additively', async () => {
    prisma = mockPrisma({
      id: 'row-1',
      lastEventNanos: 0n,
      coredocTools: { search_symbols: 1 },
      coredocToolStats: { search_symbols: { calls: 1, errors: 0, totalDurationMs: 50 } },
    });
    service = new AgentSessionsService(prisma as any);
    await service.applyLogDeltas('ws-1', [logBatch({ records: [coredocRecord(100n, 'false', 40)] })]);
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.update.coredocToolStats).toEqual({
      search_symbols: { calls: 2, errors: 1, totalDurationMs: 90 },
    });
  });

  it('summary splits medians by coredoc-heavy vs light and counts distinct users', async () => {
    const rows = [
      {
        tokensInput: 100,
        tokensOutput: 0,
        activeTimeSec: 10,
        coredocToolCalls: 3,
        costUsd: 1,
        userEmail: 'a@acme.com',
      },
      {
        tokensInput: 200,
        tokensOutput: 0,
        activeTimeSec: 20,
        coredocToolCalls: 1,
        costUsd: 2,
        userEmail: 'b@acme.com',
      },
      {
        tokensInput: 900,
        tokensOutput: 0,
        activeTimeSec: 90,
        coredocToolCalls: 0,
        costUsd: 9,
        userEmail: 'a@acme.com',
      },
      { tokensInput: 700, tokensOutput: 0, activeTimeSec: 70, coredocToolCalls: 0, costUsd: 7, userEmail: null },
    ];
    (prisma.agentSession.findMany as any).mockResolvedValue(rows);
    const s = await service.getWorkspaceSessionSummary('ws-1', 30);
    expect(s.sessionCount).toBe(4);
    expect(s.distinctUserCount).toBe(2);
    expect(s.coredocHeavy).toEqual({ sessionCount: 2, medianTokens: 150, medianActiveTimeSec: 15, medianCostUsd: 1.5 });
    expect(s.coredocLight).toEqual({ sessionCount: 2, medianTokens: 800, medianActiveTimeSec: 80, medianCostUsd: 8 });
  });

  it('summary reports null medians for an empty segment (no false $0 signal in a demo)', async () => {
    // All sessions are coredoc-heavy, so the light segment is empty. Its medians must
    // read as "no data" (null), not 0 — a $0 median in a buyer demo looks like real
    // zero-cost activity rather than an empty bucket.
    const rows = [
      {
        tokensInput: 100,
        tokensOutput: 0,
        activeTimeSec: 10,
        coredocToolCalls: 3,
        costUsd: 1,
        userEmail: 'a@acme.com',
      },
      {
        tokensInput: 200,
        tokensOutput: 0,
        activeTimeSec: 20,
        coredocToolCalls: 2,
        costUsd: 2,
        userEmail: 'b@acme.com',
      },
    ];
    (prisma.agentSession.findMany as any).mockResolvedValue(rows);
    const s = await service.getWorkspaceSessionSummary('ws-1', 30);
    expect(s.coredocLight).toEqual({
      sessionCount: 0,
      medianTokens: null,
      medianActiveTimeSec: null,
      medianCostUsd: null,
    });
  });

  it('summary reports null medians when there are no sessions at all', async () => {
    (prisma.agentSession.findMany as any).mockResolvedValue([]);
    const s = await service.getWorkspaceSessionSummary('ws-1', 30);
    expect(s.sessionCount).toBe(0);
    expect(s.medianTokens).toBeNull();
    expect(s.medianActiveTimeSec).toBeNull();
    expect(s.medianCoredocToolCalls).toBeNull();
    expect(s.coredocHeavy.medianCostUsd).toBeNull();
    expect(s.coredocLight.medianCostUsd).toBeNull();
    expect(s.adoption).toEqual({
      sessionsUsingCoredoc: 0,
      adoptionRate: null,
      usersUsingCoredoc: 0,
      totalCoredocCalls: 0,
      coredocErrorRate: null,
      avgCallLatencyMs: null,
    });
  });

  it('summary computes coredoc adoption (reach, users, calls, error + latency) from tool stats', async () => {
    const rows = [
      {
        tokensInput: 100,
        tokensOutput: 0,
        activeTimeSec: 10,
        coredocToolCalls: 2,
        costUsd: 1,
        userEmail: 'a@acme.com',
        coredocToolStats: { search_symbols: { calls: 2, errors: 1, totalDurationMs: 300 } },
      },
      {
        tokensInput: 200,
        tokensOutput: 0,
        activeTimeSec: 20,
        coredocToolCalls: 2,
        costUsd: 2,
        userEmail: 'b@acme.com',
        coredocToolStats: {
          explain: { calls: 1, errors: 0, totalDurationMs: 60 },
          find_callers: { calls: 1, errors: 0, totalDurationMs: 40 },
        },
      },
      // Light session (no coredoc), same user as the first — must not double-count the user.
      {
        tokensInput: 900,
        tokensOutput: 0,
        activeTimeSec: 90,
        coredocToolCalls: 0,
        costUsd: 9,
        userEmail: 'a@acme.com',
        coredocToolStats: {},
      },
    ];
    (prisma.agentSession.findMany as any).mockResolvedValue(rows);
    const s = await service.getWorkspaceSessionSummary('ws-1', 30);
    expect(s.adoption).toEqual({
      sessionsUsingCoredoc: 2,
      adoptionRate: 2 / 3,
      usersUsingCoredoc: 2,
      totalCoredocCalls: 4,
      coredocErrorRate: 1 / 4,
      avgCallLatencyMs: 100, // (300 + 60 + 40) / 4
    });
  });

  it('summary query excludes hook-created skeleton rows with no telemetry signal', async () => {
    await service.getWorkspaceSessionSummary('ws-1', 30);
    const call = (prisma.agentSession.findMany as any).mock.calls[0][0];
    expect(call.where.provider).toBe('claude-code');
    expect(call.where.OR).toEqual([
      { lastEventNanos: { gt: 0 } },
      { activeTimeSec: { gt: 0 } },
      { tokensInput: { gt: 0 } },
      { tokensOutput: { gt: 0 } },
      { commitCount: { gt: 0 } },
    ]);
  });

  it('summary self-scopes to the caller by server-derived user_id', async () => {
    await service.getWorkspaceSessionSummary('ws-1', 30, { userId: 'u1' });
    const where = (prisma.agentSession.findMany as any).mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    // Ghost filter is preserved alongside the scope.
    expect(where.OR).toBeDefined();
  });

  it('summary carries no userId filter when unscoped (workspace-wide)', async () => {
    await service.getWorkspaceSessionSummary('ws-1', 30);
    const where = (prisma.agentSession.findMany as any).mock.calls[0][0].where;
    expect(where).not.toHaveProperty('userId');
  });

  it('by-user self-scopes both the groupBy and tool-map queries by user_id', async () => {
    await service.getWorkspaceSessionsByUser('ws-1', 30, { userId: 'u1' });
    const groupByWhere = (prisma.agentSession.groupBy as any).mock.calls[0][0].where;
    const findManyWhere = (prisma.agentSession.findMany as any).mock.calls[0][0].where;
    expect(groupByWhere.userId).toBe('u1');
    expect(findManyWhere.userId).toBe('u1');
    // Ghost filter and coredoc-calls gate stay intact under scope.
    expect(groupByWhere.OR).toBeDefined();
    expect(findManyWhere.coredocToolCalls).toEqual({ gt: 0 });
  });

  it('by-user carries no userId filter when unscoped', async () => {
    await service.getWorkspaceSessionsByUser('ws-1', 30);
    const groupByWhere = (prisma.agentSession.groupBy as any).mock.calls[0][0].where;
    expect(groupByWhere).not.toHaveProperty('userId');
  });

  it('by-user: empty workspace returns { users: [] }, never a throw', async () => {
    const result = await service.getWorkspaceSessionsByUser('ws-1', 30);
    expect(result).toEqual({ users: [] });
  });

  it('by-user: groups per (userId, userEmail) with summed tokens/cost/calls, ISO lastActiveAt, sorted by costUsd desc', async () => {
    (prisma.agentSession.groupBy as any).mockResolvedValue([
      {
        userId: 'u1',
        userEmail: 'a@acme.com',
        _count: { _all: 2 },
        _sum: { tokensInput: 100, tokensOutput: 50, costUsd: 3, coredocToolCalls: 4 },
        _max: { startedAt: new Date('2026-07-01T10:00:00Z') },
      },
      {
        userId: 'u2',
        userEmail: 'b@acme.com',
        _count: { _all: 1 },
        _sum: { tokensInput: 10, tokensOutput: 5, costUsd: 9, coredocToolCalls: 0 },
        _max: { startedAt: new Date('2026-07-02T10:00:00Z') },
      },
    ]);
    // u1's coredocTools maps span two sessions: search_symbols 2 vs explain 1+3
    // — the merged winner (explain) must be the topTool, proving cross-session
    // merging rather than a per-session max.
    (prisma.agentSession.findMany as any).mockResolvedValue([
      { userId: 'u1', userEmail: 'a@acme.com', coredocTools: { search_symbols: 2, explain: 1 } },
      { userId: 'u1', userEmail: 'a@acme.com', coredocTools: { explain: 3 } },
    ]);

    const { users } = await service.getWorkspaceSessionsByUser('ws-1', 30);

    expect(users).toEqual([
      {
        userId: 'u2',
        userEmail: 'b@acme.com',
        sessions: 1,
        tokens: 15,
        costUsd: 9,
        coredocCalls: 0,
        topTool: null, // no coredoc calls → null, not ''
        lastActiveAt: '2026-07-02T10:00:00.000Z',
      },
      {
        userId: 'u1',
        userEmail: 'a@acme.com',
        sessions: 2,
        tokens: 150,
        costUsd: 3,
        coredocCalls: 4,
        topTool: 'explain',
        lastActiveAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
  });

  it('by-user: buckets null-user sessions separately (rendered as "unattributed")', async () => {
    (prisma.agentSession.groupBy as any).mockResolvedValue([
      {
        userId: null,
        userEmail: null,
        _count: { _all: 3 },
        _sum: { tokensInput: 1, tokensOutput: 1, costUsd: 0.5, coredocToolCalls: 2 },
        _max: { startedAt: new Date('2026-07-03T00:00:00Z') },
      },
    ]);
    (prisma.agentSession.findMany as any).mockResolvedValue([
      { userId: null, userEmail: null, coredocTools: { find_callers: 2 } },
    ]);

    const { users } = await service.getWorkspaceSessionsByUser('ws-1', 30);

    expect(users).toEqual([
      {
        userId: null,
        userEmail: null,
        sessions: 3,
        tokens: 2,
        costUsd: 0.5,
        coredocCalls: 2,
        topTool: 'find_callers',
        lastActiveAt: '2026-07-03T00:00:00.000Z',
      },
    ]);
  });

  it('by-user: applies the same ghost-session filter as the summary to both queries', async () => {
    await service.getWorkspaceSessionsByUser('ws-1', 30);

    const ghost = [
      { lastEventNanos: { gt: 0 } },
      { activeTimeSec: { gt: 0 } },
      { tokensInput: { gt: 0 } },
      { tokensOutput: { gt: 0 } },
      { commitCount: { gt: 0 } },
    ];
    const groupByArgs = (prisma.agentSession.groupBy as any).mock.calls[0][0];
    expect(groupByArgs.by).toEqual(['userId', 'userEmail']);
    expect(groupByArgs.where.provider).toBe('claude-code');
    expect(groupByArgs.where.OR).toEqual(ghost);
    // The tool-map fetch also carries the ghost filter and only pulls sessions
    // that actually made coredoc calls.
    const findManyArgs = (prisma.agentSession.findMany as any).mock.calls[0][0];
    expect(findManyArgs.where.provider).toBe('claude-code');
    expect(findManyArgs.where.OR).toEqual(ghost);
    expect(findManyArgs.where.coredocToolCalls).toEqual({ gt: 0 });
  });

  it('applySessionContext upserts join keys, ignoring absent fields', async () => {
    await service.applySessionContext('ws-1', 'sess-1', { branch: 'feat/ABC-123-x', issueKey: 'ABC-123' });
    const call = prisma._upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      workspaceId_provider_sessionId: { workspaceId: 'ws-1', provider: 'claude-code', sessionId: 'sess-1' },
    });
    expect(call.create.provider).toBe('claude-code');
    expect(call.create.branch).toBe('feat/ABC-123-x');
    expect(call.update.issueKey).toBe('ABC-123');
    expect(call.update.prNumber).toBeUndefined();
  });
});

describe('AgentSessionsService Phase-B activity read', () => {
  it('keeps post-purge capture health from exact-scope accepted-event watermarks', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    asMock(prisma.captureProvisioning.findMany).mockResolvedValue([
      {
        actorId: 'member-a',
        host: 'claude-code',
        targetKey: 'repo:graph-a',
        repositoryKey: 'acme/repo-a',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T12:00:00.000Z'),
      },
      {
        actorId: 'member-a',
        host: 'claude-code',
        targetKey: 'repo:graph-b',
        repositoryKey: 'acme/repo-b',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T12:01:00.000Z'),
      },
      {
        actorId: 'member-a',
        host: 'codex',
        targetKey: 'repo:graph-a:profile:base',
        repositoryKey: 'acme/repo-a',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T12:02:00.000Z'),
      },
      {
        actorId: 'member-a',
        host: 'codex',
        targetKey: 'repo:graph-b:profile:pilot',
        repositoryKey: 'acme/repo-b',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T12:03:00.000Z'),
      },
    ]);
    asMock(prisma.captureAcceptedWatermark.findMany).mockResolvedValue([
      {
        actorId: 'member-a',
        host: 'claude-code',
        scopeKey: 'repo:acme/repo-a',
        repositoryKey: 'acme/repo-a',
        lastAcceptedAt: new Date('2026-08-16T10:10:00.000Z'),
        workflowLastAcceptedAt: new Date('2026-08-16T10:09:00.000Z'),
      },
      {
        actorId: 'member-a',
        host: 'codex',
        scopeKey: 'repo:acme/repo-a',
        repositoryKey: 'acme/repo-a',
        lastAcceptedAt: new Date('2026-08-16T10:11:00.000Z'),
        workflowLastAcceptedAt: new Date('2026-08-16T10:10:00.000Z'),
      },
    ]);

    const result = await service.getWorkspaceActivity('ws-1', 30, { userId: 'member-a' });

    expect(result.fineEventCoverage).toEqual({
      requestedDays: 30,
      policyDays: 90,
      status: 'complete',
      purgedThroughReceivedAt: null,
    });
    expect(
      result.captureHealth.map(({ targetKey, lastSeenAt, workflowLastSeenAt }) => ({
        targetKey,
        lastSeenAt,
        workflowLastSeenAt,
      })),
    ).toEqual([
      {
        targetKey: 'repo:graph-a',
        lastSeenAt: '2026-08-16T10:10:00.000Z',
        workflowLastSeenAt: '2026-08-16T10:09:00.000Z',
      },
      {
        targetKey: 'repo:graph-b',
        lastSeenAt: null,
        workflowLastSeenAt: null,
      },
      {
        targetKey: 'repo:graph-a:profile:base',
        lastSeenAt: '2026-08-16T10:11:00.000Z',
        workflowLastSeenAt: '2026-08-16T10:10:00.000Z',
      },
      {
        targetKey: 'repo:graph-b:profile:pilot',
        lastSeenAt: null,
        workflowLastSeenAt: null,
      },
    ]);
    expect(result.capabilities).toEqual([]);
    expect(prisma.captureAcceptedWatermark.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', actorId: 'member-a' },
      select: {
        actorId: true,
        host: true,
        scopeKey: true,
        repositoryKey: true,
        lastAcceptedAt: true,
        workflowLastAcceptedAt: true,
      },
    });
  });

  it('keeps pre-watermark retained health and takes the newest exact-scope fact from either source', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    asMock(prisma.captureProvisioning.findMany).mockResolvedValue([
      {
        actorId: 'member-a',
        host: 'claude-code',
        targetKey: 'repo:graph-a',
        repositoryKey: 'acme/repo-a',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T12:00:00.000Z'),
      },
    ]);
    asMock(prisma.captureEvent.groupBy)
      .mockResolvedValueOnce([
        {
          actorId: 'member-a',
          host: 'claude-code',
          repositoryKey: 'acme/repo-a',
          _max: { receivedAt: new Date('2026-08-16T10:05:00.000Z') },
        },
      ])
      .mockResolvedValueOnce([
        {
          actorId: 'member-a',
          host: 'claude-code',
          repositoryKey: 'acme/repo-a',
          _max: { receivedAt: new Date('2026-08-16T10:01:00.000Z') },
        },
      ]);
    asMock(prisma.captureAcceptedWatermark.findMany).mockResolvedValue([
      {
        actorId: 'member-a',
        host: 'claude-code',
        scopeKey: 'repo:acme/repo-a',
        repositoryKey: 'acme/repo-a',
        lastAcceptedAt: new Date('2026-08-16T10:02:00.000Z'),
        workflowLastAcceptedAt: new Date('2026-08-16T10:06:00.000Z'),
      },
    ]);

    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect(result.captureHealth[0]).toMatchObject({
      lastSeenAt: '2026-08-16T10:05:00.000Z',
      workflowLastSeenAt: '2026-08-16T10:06:00.000Z',
    });
    expect(asMock(prisma.captureEvent.groupBy).mock.calls[1][0].where.type).toEqual({
      not: 'capability.used',
    });
  });

  it('bounds capabilities by receivedAt but keeps source occurredAt as lastUsedAt', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    const now = Date.now();
    const rows = [
      {
        host: 'claude-code',
        type: 'capability.used',
        occurredAt: new Date(now - 60_000),
        receivedAt: new Date(now - 120 * 86_400_000),
        data: { kind: 'skill', capabilityId: 'purged-by-server-time', outcome: 'success' },
      },
      {
        host: 'claude-code',
        type: 'capability.used',
        occurredAt: new Date(now - 120 * 86_400_000),
        receivedAt: new Date(now - 60_000),
        data: { kind: 'skill', capabilityId: 'retained-by-server-time', outcome: 'success' },
      },
    ];
    asMock(prisma.captureEvent.findMany).mockImplementation(({ where }: { where: { receivedAt: { gte: Date } } }) =>
      rows.filter((row) => row.receivedAt >= where.receivedAt.gte),
    );

    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect(result.capabilities).toEqual([
      {
        host: 'claude-code',
        kind: 'skill',
        capabilityId: 'retained-by-server-time',
        uses: 1,
        outcomes: { success: 1, failed: 0, blocked: 0, abandoned: 0, unknown: 0 },
        lastUsedAt: new Date(now - 120 * 86_400_000).toISOString(),
      },
    ]);
    expect(asMock(prisma.captureEvent.findMany).mock.calls[0][0].where).toMatchObject({
      receivedAt: { gte: expect.any(Date) },
    });
    expect(asMock(prisma.captureEvent.findMany).mock.calls[0][0].where).not.toHaveProperty('occurredAt');
  });

  it.each([
    { days: 90, checkpointDaysAgo: null, expectedStatus: 'complete' },
    { days: 91, checkpointDaysAgo: null, expectedStatus: 'partial' },
    { days: 365, checkpointDaysAgo: null, expectedStatus: 'partial' },
    { days: 30, checkpointDaysAgo: 10, expectedStatus: 'partial' },
    { days: 30, checkpointDaysAgo: 120, expectedStatus: 'complete' },
  ] as const)('reports $expectedStatus fine-event coverage for $days days with a checkpoint $checkpointDaysAgo days ago', async ({
    days,
    checkpointDaysAgo,
    expectedStatus,
  }) => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    const checkpoint = checkpointDaysAgo === null ? null : new Date(Date.now() - checkpointDaysAgo * 86_400_000);
    asMock(prisma.captureRetentionCheckpoint.findUnique).mockResolvedValue(
      checkpoint === null ? null : { purgedThroughReceivedAt: checkpoint },
    );

    const result = await service.getWorkspaceActivity('ws-1', days);

    expect(result.fineEventCoverage).toEqual({
      requestedDays: days,
      policyDays: 90,
      status: expectedStatus,
      purgedThroughReceivedAt: checkpoint?.toISOString() ?? null,
    });
    expect(prisma.captureRetentionCheckpoint.findUnique).toHaveBeenCalledWith({
      where: { id: 'capture_fine_events' },
      select: { purgedThroughReceivedAt: true },
    });
  });

  it('returns honest coverage, exact estimates and only CaptureEvent-backed capabilities', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    const startedAt = new Date('2026-08-16T10:00:00.000Z');
    const updatedAt = new Date('2026-08-16T10:05:00.000Z');

    (prisma.agentSession.findMany as any).mockResolvedValue([
      {
        provider: 'claude-code',
        sessionId: 'claude-native',
        userId: 'member-a',
        userEmail: 'a@example.test',
        model: 'claude-sonnet-4-6',
        appVersion: '2.1.232',
        tokensInput: 1_000_000,
        tokensOutput: 1_000_000,
        tokensCacheRead: 1_000_000,
        tokensCacheCreation: 1_000_000,
        tokensReasoning: 0,
        activeTimeSec: 42,
        coredocToolStats: { search_symbols: { calls: 2, errors: 1, totalDurationMs: 80 } },
        skillsUsed: { 'must-not-be-read': 99 },
        startedAt,
        updatedAt,
      },
      {
        provider: 'claude-code',
        sessionId: 'c1-only',
        userId: 'member-a',
        userEmail: 'a@example.test',
        model: null,
        appVersion: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
        activeTimeSec: 0,
        coredocToolStats: {},
        skillsUsed: { 'legacy-fake-skill': 50 },
        startedAt,
        updatedAt,
      },
      {
        provider: 'codex',
        sessionId: 'codex-native',
        userId: 'member-a',
        userEmail: 'a@example.test',
        model: 'gpt-5.6-sol',
        appVersion: '0.146.0',
        tokensInput: 23_868,
        tokensOutput: 108,
        tokensCacheRead: 19_968,
        tokensCacheCreation: 0,
        tokensReasoning: 39,
        activeTimeSec: 0,
        coredocToolStats: {},
        skillsUsed: {},
        startedAt,
        updatedAt,
      },
      {
        provider: 'codex',
        sessionId: 'codex-start-only',
        userId: 'member-a',
        userEmail: 'a@example.test',
        model: 'gpt-5.6-sol',
        appVersion: '0.146.0',
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
        activeTimeSec: 0,
        coredocToolStats: {},
        skillsUsed: {},
        startedAt,
        updatedAt,
      },
      {
        provider: 'claude-code',
        sessionId: 'unknown-priced-model',
        userId: 'member-a',
        userEmail: 'a@example.test',
        model: 'claude-future-unknown',
        appVersion: '2.1.232',
        tokensInput: 100,
        tokensOutput: 20,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
        activeTimeSec: 1,
        costUsd: 99,
        coredocToolStats: {},
        skillsUsed: {},
        startedAt,
        updatedAt,
      },
    ]);
    (prisma.captureEvent.findMany as any).mockResolvedValue([
      {
        host: 'claude-code',
        type: 'capability.used',
        occurredAt: new Date('2026-08-16T10:01:00.000Z'),
        receivedAt: new Date('2026-08-16T10:01:01.000Z'),
        data: { kind: 'skill', capabilityId: 'coredoc-tdd', outcome: 'success' },
      },
      {
        host: 'claude-code',
        type: 'workflow.run.started',
        occurredAt: new Date('2026-08-16T10:00:00.000Z'),
        receivedAt: new Date('2026-08-16T10:00:01.000Z'),
        data: { workflowId: 'change:normal' },
      },
      {
        host: 'codex',
        type: 'capability.used',
        occurredAt: new Date('2026-08-16T10:03:00.000Z'),
        receivedAt: new Date('2026-08-16T10:03:01.000Z'),
        data: { kind: 'agent', capabilityId: 'unsupported-codex-agent', outcome: 'success' },
      },
    ]);
    // Windowed only: this run finished, so it must not also come back from the unfinished reads.
    mockRunQueries(
      prisma,
      [
        {
          runId: 'cdr-20260816-a1b2c3',
          actorId: 'member-a',
          workflowId: 'change:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'normal',
          repositoryKey: 'acme/repo',
          taskId: null,
          startedAt: new Date('2026-08-16T10:00:00.000Z'),
          finishedAt: new Date('2026-08-16T10:02:00.000Z'),
          outcome: 'success',
          createdAt: new Date('2026-08-16T10:00:00.000Z'),
          workItems: [
            { provider: 'jira', externalId: '10042', externalKey: 'FRONT-123' },
            { provider: 'jira', externalId: '10043', externalKey: 'BACK-456' },
            { provider: 'notion.task', externalId: 'page_42', externalKey: null },
          ],
        },
      ],
      [],
    );
    (prisma.taskExternalRef.findMany as any).mockResolvedValue([
      { provider: 'jira', externalId: '10042' },
      { provider: 'jira', externalId: '10043' },
    ]);
    (prisma.captureProvisioning.findMany as any).mockResolvedValue([
      {
        actorId: 'member-a',
        host: 'claude-code',
        targetKey: 'repo:graph-hash',
        repositoryKey: 'acme/repo',
        state: 'configured',
        pendingCount: 2,
        errorCode: 'OUTBOX_PENDING',
        configuredAt: new Date('2026-08-16T09:55:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T10:06:00.000Z'),
      },
      {
        actorId: 'member-a',
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'acme/repo',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:56:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T10:07:00.000Z'),
      },
    ]);
    (prisma.agentSession.groupBy as any).mockResolvedValue([
      {
        userId: 'member-a',
        provider: 'claude-code',
        _max: { lastEventNanos: BigInt(Date.parse('2026-08-16T10:04:00.000Z')) * 1_000_000n },
      },
      {
        userId: 'member-a',
        provider: 'codex',
        _max: { lastEventNanos: BigInt(Date.parse('2026-08-16T10:05:00.000Z')) * 1_000_000n },
      },
    ]);
    (prisma.captureEvent.groupBy as any)
      .mockResolvedValueOnce([
        {
          actorId: 'member-a',
          host: 'claude-code',
          repositoryKey: 'acme/repo',
          _max: { receivedAt: new Date('2026-08-16T10:01:01.000Z') },
        },
        {
          actorId: 'member-a',
          host: 'codex',
          repositoryKey: 'acme/repo',
          _max: { receivedAt: new Date('2026-08-16T10:03:01.000Z') },
        },
      ])
      .mockResolvedValueOnce([
        {
          actorId: 'member-a',
          host: 'claude-code',
          repositoryKey: 'acme/repo',
          _max: { receivedAt: new Date('2026-08-16T10:00:01.000Z') },
        },
      ]);

    const result = await service.getWorkspaceActivity('ws-1', 30, { userId: 'member-a' });

    expect(prisma.taskExternalRef.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        OR: [
          { provider: 'jira', externalId: '10042' },
          { provider: 'jira', externalId: '10043' },
          { provider: 'notion.task', externalId: 'page_42' },
        ],
      },
      select: { provider: true, externalId: true },
    });
    expect(result.priceMap).toEqual({
      version: '2026-09-23',
      basis: 'standard-global-public-api-5m-cache-writes',
    });
    expect(result.sessions.find((row) => row.sessionId === 'c1-only')).toMatchObject({
      usageCoverage: 'unavailable',
      tokensInput: null,
      tokensOutput: null,
      estimatedCostUsd: null,
    });
    expect(result.sessions.find((row) => row.sessionId === 'claude-native')?.estimatedCostUsd).toBeCloseTo(22.05, 9);
    expect(result.sessions.find((row) => row.sessionId === 'claude-native')?.tokensReasoning).toBeNull();
    expect(result.sessions.find((row) => row.sessionId === 'codex-native')?.estimatedCostUsd).toBeCloseTo(0.032724, 9);
    expect(result.sessions.find((row) => row.sessionId === 'codex-native')?.tokensReasoning).toBe(39);
    expect(result.sessions.find((row) => row.sessionId === 'unknown-priced-model')).toMatchObject({
      usageCoverage: 'observed',
      tokensInput: 100,
      estimatedCostUsd: null,
    });
    expect(result.sessions.find((row) => row.sessionId === 'codex-start-only')).toMatchObject({
      usageCoverage: 'unavailable',
      tokensInput: null,
      tokensOutput: null,
      estimatedCostUsd: null,
    });
    expect(result.capabilities).toEqual([
      {
        host: 'claude-code',
        kind: 'skill',
        capabilityId: 'coredoc-tdd',
        uses: 1,
        outcomes: { success: 1, failed: 0, blocked: 0, abandoned: 0, unknown: 0 },
        lastUsedAt: '2026-08-16T10:01:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('legacy-fake-skill');
    expect(JSON.stringify(result)).not.toContain('must-not-be-read');
    expect(result.mcpTools).toEqual([{ tool: 'search_symbols', calls: 2, errors: 1, avgDurationMs: 40 }]);
    expect(result.workflowRuns[0].durationMs).toBe(120_000);
    // Counted once, under its outcome — never also as an unfinished run.
    expect(result.workflowRunCompleteness).toEqual({ byOutcome: { success: 1 }, inProgress: 0, incomplete: 0 });
    expect(result.omittedUnfinishedRuns).toBe(0);
    expect(result.workflowRuns[0].workItems).toEqual([
      { provider: 'jira', externalId: '10042', externalKey: 'FRONT-123', linked: true },
      { provider: 'jira', externalId: '10043', externalKey: 'BACK-456', linked: true },
      { provider: 'notion.task', externalId: 'page_42', externalKey: null, linked: false },
    ]);
    expect(result.captureHealth).toEqual([
      {
        actorId: 'member-a',
        actorName: null,
        host: 'claude-code',
        targetKey: 'repo:graph-hash',
        repositoryKey: 'acme/repo',
        configurationState: 'configured',
        errorState: 'OUTBOX_PENDING',
        pendingCount: 2,
        configuredAt: '2026-08-16T09:55:00.000Z',
        disabledAt: null,
        reportedAt: '2026-08-16T10:06:00.000Z',
        nativeCoverage: 'observed',
        capabilityCoverage: 'available',
        lastSeenAt: '2026-08-16T10:01:01.000Z',
        nativeLastSeenAt: '2026-08-16T10:04:00.000Z',
        workflowLastSeenAt: '2026-08-16T10:00:01.000Z',
        attributionPendingCount: 0,
        attributionRejectedCount: 0,
        attributionLastClaimAt: null,
      },
      {
        actorId: 'member-a',
        actorName: null,
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'acme/repo',
        configurationState: 'configured',
        errorState: null,
        pendingCount: 0,
        configuredAt: '2026-08-16T09:56:00.000Z',
        disabledAt: null,
        reportedAt: '2026-08-16T10:07:00.000Z',
        nativeCoverage: 'observed',
        capabilityCoverage: 'unavailable',
        lastSeenAt: '2026-08-16T10:03:01.000Z',
        nativeLastSeenAt: '2026-08-16T10:05:00.000Z',
        workflowLastSeenAt: null,
        attributionPendingCount: 0,
        attributionRejectedCount: 0,
        attributionLastClaimAt: null,
      },
    ]);

    expect((prisma.agentSession.findMany as any).mock.calls[0][0].where.userId).toBe('member-a');
    expect((prisma.captureEvent.findMany as any).mock.calls[0][0].where.actorId).toBe('member-a');
    // All four run queries, not just the windowed one: an unscoped unfinished read or count
    // would leak other members' runs into a self-scoped answer.
    const runQueries = [
      ...(prisma.workflowRun.findMany as any).mock.calls,
      ...(prisma.workflowRun.count as any).mock.calls,
    ];
    expect(runQueries).toHaveLength(4);
    for (const [args] of runQueries) expect(args.where.actorId).toBe('member-a');
    expect((prisma.captureProvisioning.findMany as any).mock.calls[0][0].where.actorId).toBe('member-a');
    expect((prisma.agentSession.groupBy as any).mock.calls[0][0].where).toMatchObject({
      userId: 'member-a',
    });
    expect((prisma.agentSession.groupBy as any).mock.calls[0][0].where.OR).toEqual([
      { tokensInput: { gt: 0 } },
      { tokensOutput: { gt: 0 } },
      { tokensCacheRead: { gt: 0 } },
      { tokensCacheCreation: { gt: 0 } },
      { tokensReasoning: { gt: 0 } },
    ]);
    expect((prisma.agentSession.groupBy as any).mock.calls[0][0].by).toEqual(['userId', 'provider']);
    expect((prisma.captureEvent.groupBy as any).mock.calls[0][0].where.actorId).toBe('member-a');
    expect((prisma.captureEvent.groupBy as any).mock.calls[0][0].where).not.toHaveProperty('occurredAt');
    expect((prisma.captureEvent.groupBy as any).mock.calls[0][0].by).toEqual(['actorId', 'host', 'repositoryKey']);
    expect((prisma.captureEvent.groupBy as any).mock.calls[1][0].where.actorId).toBe('member-a');
  });

  const DAY = 86_400_000;

  function runRow(runId: string, startedAt: Date, finishedAt: Date | null, outcome: string | null) {
    return {
      runId,
      actorId: 'member-a',
      workflowId: null,
      intent: null,
      risk: null,
      scale: null,
      repositoryKey: null,
      taskId: null,
      startedAt,
      finishedAt,
      outcome,
      createdAt: startedAt,
      workItems: [],
    };
  }

  /**
   * The read asks the windowed population and the capped unfinished rows (`take`) of
   * `findMany`, and the incomplete/total unfinished counts of `count`. The counts are DERIVED
   * from the same `unfinished` fixture, applying the staleness rule the SQL bound encodes, so a
   * test cannot assert a total its own rows contradict.
   */
  function mockRunQueries(prisma: ReturnType<typeof mockPrisma>, windowed: unknown[], unfinished: unknown[]) {
    (prisma.workflowRun.findMany as any).mockImplementation((args: any) =>
      Promise.resolve(args.where.finishedAt !== null ? windowed : unfinished.slice(0, args.take)),
    );
    (prisma.workflowRun.count as any).mockImplementation((args: any) => {
      if (args.where.OR === undefined) return Promise.resolve(unfinished.length);
      const cutoff = stalenessCutoff(new Date()).getTime();
      return Promise.resolve(
        unfinished.filter((row: any) => (row.startedAt ?? row.createdAt).getTime() < cutoff).length,
      );
    });
  }

  it('classifies an unfinished run by age and counts it apart from the outcome breakdown', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    const ago = (ms: number) => new Date(Date.now() - ms);
    const finished = runRow('cdr-20260816-finished', ago(2 * DAY), ago(2 * DAY - 60_000), 'success');
    // Started a day ago, no finish yet: the client can still deliver one.
    const running = runRow('cdr-20260816-running', ago(DAY), null, null);
    // Started 18 days ago: past the 17-day staleness window, so the finish never arrived.
    const stale = runRow('cdr-20260816-stale00', ago(18 * DAY), null, null);
    mockRunQueries(prisma, [finished, running], [running, stale]);

    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect(result.workflowRunCompleteness).toEqual({ byOutcome: { success: 1 }, inProgress: 1, incomplete: 1 });
    expect(result.omittedUnfinishedRuns).toBe(0);
    // Window-bounded, and the unfinished run that started inside it is listed here.
    expect(result.workflowRuns.map((run) => [run.runId, run.status, run.durationMs])).toEqual([
      ['cdr-20260816-finished', 'finished', 60_000],
      ['cdr-20260816-running', 'in_progress', null],
    ]);
    // The out-of-window one is listed beside it, never folded into the windowed array.
    expect(result.staleUnfinishedRuns.map((run) => [run.runId, run.status])).toEqual([
      ['cdr-20260816-stale00', 'incomplete'],
    ]);
  });

  // A run finishing mid-read used to make the list and the counters disagree — a listed row
  // counted as unfinished, or reported as trimmed by the cap. One repeatable-read snapshot is
  // what rules that out, so the isolation level is the assertion, not an implementation detail.
  it('reads the runs and their counts in one repeatable-read snapshot', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    const started = new Date(Date.now() - 18 * DAY);
    mockRunQueries(prisma, [], [runRow('cdr-20260816-stale00', started, null, null)]);

    await service.getWorkspaceActivity('ws-1', 30);

    const [operations, options] = (prisma.$transaction as any).mock.calls[0];
    expect(operations).toHaveLength(4);
    expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
    // Every run read is inside it: none may observe a different snapshot.
    expect((prisma.workflowRun.findMany as any).mock.calls).toHaveLength(2);
    expect((prisma.workflowRun.count as any).mock.calls).toHaveLength(2);
    expect((prisma.$transaction as any).mock.calls).toHaveLength(1);
  });

  it('reads unfinished runs past the requested window so a short preset can still report one incomplete', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    const stale = runRow('cdr-20260816-stale00', new Date(Date.now() - 18 * DAY), null, null);
    // The 7-day window cannot return it: without an unbounded unfinished read, `incomplete`
    // would be unreachable on every preset shorter than the staleness window.
    mockRunQueries(prisma, [], [stale]);

    const result = await service.getWorkspaceActivity('ws-1', 7);

    // Neither the capped list nor the two counts may carry the caller's window.
    const unfinishedQueries = [
      ...(prisma.workflowRun.findMany as any).mock.calls,
      ...(prisma.workflowRun.count as any).mock.calls,
    ]
      .map((call: any[]) => call[0])
      .filter((args: any) => args.where.finishedAt === null);
    expect(unfinishedQueries).toHaveLength(3);
    for (const args of unfinishedQueries) {
      expect(args.where).not.toHaveProperty('createdAt');
      expect(args.where).not.toHaveProperty('startedAt');
    }
    // The staleness cutoff is the only OR any of them carries, and it is an absolute instant,
    // not a function of `days`.
    expect(unfinishedQueries.filter((args: any) => args.where.OR !== undefined)).toHaveLength(1);
    expect(result.workflowRunCompleteness).toEqual({ byOutcome: {}, inProgress: 0, incomplete: 1 });
    expect(result.workflowRuns).toEqual([]);
    expect(result.staleUnfinishedRuns[0].status).toBe('incomplete');
  });

  it('caps the unfinished rows it lists while keeping the counts exact over every unfinished run', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    // 201 leaked runs: 200 fresh (in progress) and one stale, newest first as the query orders.
    const unfinished = [
      ...Array.from({ length: 200 }, (_, index) =>
        runRow(`cdr-20260816-f${String(index).padStart(5, '0')}`, new Date(Date.now() - DAY), null, null),
      ),
      runRow('cdr-20260816-stale00', new Date(Date.now() - 18 * DAY), null, null),
    ];
    mockRunQueries(prisma, [], unfinished);

    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect(result.workflowRuns).toEqual([]);
    expect(result.staleUnfinishedRuns).toHaveLength(200);
    // The stale run is the one the cap dropped, yet it is still counted.
    expect(result.staleUnfinishedRuns.some((run) => run.runId === 'cdr-20260816-stale00')).toBe(false);
    expect(result.workflowRunCompleteness).toEqual({ byOutcome: {}, inProgress: 200, incomplete: 1 });
    expect(result.omittedUnfinishedRuns).toBe(1);
  });

  it('keeps unscoped reads workspace-wide and never substitutes zero/config timestamps for accepted evidence', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    (prisma.captureProvisioning.findMany as any).mockResolvedValue([
      {
        actorId: 'member-b',
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:pilot',
        repositoryKey: 'acme/repo',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T11:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T11:01:00.000Z'),
      },
    ]);
    (prisma.agentSession.groupBy as any).mockResolvedValue([
      { userId: 'member-b', provider: 'codex', _max: { lastEventNanos: 0n } },
    ]);
    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect((prisma.agentSession.findMany as any).mock.calls[0][0].where).not.toHaveProperty('userId');
    expect((prisma.captureEvent.findMany as any).mock.calls[0][0].where).not.toHaveProperty('actorId');
    const runQueries = [
      ...(prisma.workflowRun.findMany as any).mock.calls,
      ...(prisma.workflowRun.count as any).mock.calls,
    ];
    expect(runQueries).toHaveLength(4);
    for (const [args] of runQueries) expect(args.where).not.toHaveProperty('actorId');
    expect((prisma.captureProvisioning.findMany as any).mock.calls[0][0].where).not.toHaveProperty('actorId');
    expect((prisma.agentSession.groupBy as any).mock.calls[0][0].where).not.toHaveProperty('userId');
    expect((prisma.captureEvent.groupBy as any).mock.calls[0][0].where).not.toHaveProperty('actorId');
    expect((prisma.captureEvent.groupBy as any).mock.calls[1][0].where).not.toHaveProperty('actorId');
    expect(result.captureHealth).toEqual([
      expect.objectContaining({
        actorId: 'member-b',
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:pilot',
        lastSeenAt: null,
        nativeLastSeenAt: null,
        workflowLastSeenAt: null,
        nativeCoverage: 'observed',
        capabilityCoverage: 'unavailable',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('waiting');
  });

  it('keeps admin health evidence isolated by actor when two members share a host and repository', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma as any);
    (prisma.captureProvisioning.findMany as any).mockResolvedValue(
      ['member-a', 'member-b'].map((actorId) => ({
        actorId,
        host: 'claude-code',
        targetKey: 'repo:graph-hash',
        repositoryKey: 'acme/repo',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        configuredAt: new Date('2026-08-16T09:00:00.000Z'),
        disabledAt: null,
        reportedAt: new Date('2026-08-16T09:01:00.000Z'),
      })),
    );
    (prisma.agentSession.groupBy as any).mockResolvedValue([
      {
        userId: 'member-a',
        provider: 'claude-code',
        _max: { lastEventNanos: BigInt(Date.parse('2026-08-16T10:00:00.000Z')) * 1_000_000n },
      },
      {
        userId: 'member-b',
        provider: 'claude-code',
        _max: { lastEventNanos: BigInt(Date.parse('2026-08-16T11:00:00.000Z')) * 1_000_000n },
      },
    ]);
    (prisma.captureEvent.groupBy as any)
      .mockResolvedValueOnce([
        {
          actorId: 'member-a',
          host: 'claude-code',
          repositoryKey: 'acme/repo',
          _max: { receivedAt: new Date('2026-08-16T10:01:00.000Z') },
        },
        {
          actorId: 'member-b',
          host: 'claude-code',
          repositoryKey: 'acme/repo',
          _max: { receivedAt: new Date('2026-08-16T11:01:00.000Z') },
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await service.getWorkspaceActivity('ws-1', 30);

    expect(
      result.captureHealth.map(({ actorId, lastSeenAt, nativeLastSeenAt }) => ({
        actorId,
        lastSeenAt,
        nativeLastSeenAt,
      })),
    ).toEqual([
      {
        actorId: 'member-a',
        lastSeenAt: '2026-08-16T10:01:00.000Z',
        nativeLastSeenAt: '2026-08-16T10:00:00.000Z',
      },
      {
        actorId: 'member-b',
        lastSeenAt: '2026-08-16T11:01:00.000Z',
        nativeLastSeenAt: '2026-08-16T11:00:00.000Z',
      },
    ]);
  });

  function activitySessionRow(overrides: Record<string, unknown>) {
    return {
      provider: 'claude-code',
      sessionId: 'session-x',
      userId: 'member-a',
      userEmail: 'a@example.test',
      model: 'gpt-5.6-sol',
      appVersion: '1.0.0',
      tokensInput: 1_000,
      tokensOutput: 1_000,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensReasoning: 0,
      activeTimeSec: 10,
      coredocToolStats: {},
      skillsUsed: {},
      startedAt: new Date('2026-08-16T10:00:00.000Z'),
      updatedAt: new Date('2026-08-16T10:05:00.000Z'),
      ...overrides,
    };
  }

  it('marks cost coverage per session: estimated, unpriced_model, and unavailable', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    asMock(prisma.agentSession.findMany).mockResolvedValue([
      activitySessionRow({ sessionId: 'priced', provider: 'codex', model: 'gpt-5.6-sol' }),
      activitySessionRow({ sessionId: 'unpriced', model: 'invented-model-x' }),
      activitySessionRow({
        sessionId: 'no-usage',
        model: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        activeTimeSec: 0,
      }),
    ]);

    const result = await service.getWorkspaceActivity('ws-1', 30, { userId: 'member-a' });
    const byId = new Map(result.sessions.map((row) => [row.sessionId, row]));
    expect(byId.get('priced')).toMatchObject({ costCoverage: 'estimated' });
    expect(byId.get('priced')?.estimatedCostUsd).toBeGreaterThan(0);
    expect(byId.get('unpriced')).toMatchObject({ costCoverage: 'unpriced_model', estimatedCostUsd: null });
    expect(byId.get('no-usage')).toMatchObject({ costCoverage: 'unavailable', estimatedCostUsd: null });
  });

  it('rolls up the full window population per user with mcp calls and unpriced counts', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    asMock(prisma.agentSession.findMany).mockResolvedValue([
      activitySessionRow({ sessionId: 'a-1', provider: 'codex', model: 'gpt-5.6-sol' }),
      activitySessionRow({ sessionId: 'a-2', model: 'invented-model-x' }),
      activitySessionRow({
        sessionId: 'b-1',
        userId: 'member-b',
        userEmail: 'b@example.test',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        tokensInput: 500,
      }),
    ]);
    asMock(prisma.mcpQueryMetric.groupBy).mockResolvedValue([{ userId: 'member-a', _count: { _all: 7 } }]);

    const result = await service.getWorkspaceActivity('ws-1', 30);
    // Covers the FULL seeded population: the sessions query carries no take/limit,
    // and the rollup derives from that same uncapped set (A5).
    expect(result.byUser).toHaveLength(2);
    const byUser = new Map(result.byUser.map((row) => [row.userId, row]));
    const memberA = byUser.get('member-a');
    expect(memberA).toMatchObject({ sessions: 2, unpricedSessions: 1, mcpCalls: 7, tokensInput: 2_000 });
    expect(memberA?.estimatedCostUsd).toBeGreaterThan(0);
    expect(byUser.get('member-b')).toMatchObject({ sessions: 1, unpricedSessions: 0, mcpCalls: 0, tokensInput: 500 });
  });

  it('gives a member with mcp calls but no sessions a rollup row instead of dropping them', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    asMock(prisma.agentSession.findMany).mockResolvedValue([
      activitySessionRow({ sessionId: 'a-1', provider: 'codex', model: 'gpt-5.6-sol' }),
    ]);
    asMock(prisma.workspaceMember.findMany).mockResolvedValue([
      { userId: 'member-a', email: 'a@example.test', displayName: 'Alice Example' },
      { userId: 'member-mcp', email: 'mcp@example.test', displayName: 'Mcp Only' },
    ]);
    asMock(prisma.mcpQueryMetric.groupBy).mockResolvedValue([
      { userId: 'member-a', _count: { _all: 2 } },
      // A member who queried MCP in the window without opening a single agent session.
      { userId: 'member-mcp', _count: { _all: 9 } },
      // Unattributable metric rows stay out of "By member" entirely.
      { userId: null, _count: { _all: 4 } },
    ]);

    const result = await service.getWorkspaceActivity('ws-1', 30);
    const byUser = new Map(result.byUser.map((row) => [row.userId, row]));
    expect([...byUser.keys()]).toEqual(expect.arrayContaining(['member-a', 'member-mcp']));
    expect(byUser.has(null)).toBe(false);
    // Session facts are genuinely zero; cost stays null because nothing was priced —
    // 0.00 would read as a measured free session.
    expect(byUser.get('member-mcp')).toEqual({
      userId: 'member-mcp',
      userEmail: 'mcp@example.test',
      sessions: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      estimatedCostUsd: null,
      unpricedSessions: 0,
      mcpCalls: 9,
    });
    // The session-backed row keeps its own count, and priced rows still sort first.
    expect(byUser.get('member-a')).toMatchObject({ sessions: 1, mcpCalls: 2 });
    expect(result.byUser[0]?.userId).toBe('member-a');
  });

  it('resolves capture-health actor names from workspace members with id fallback', async () => {
    const prisma = mockPrisma();
    const service = new AgentSessionsService(prisma);
    const provisioningRow = (actorId: string, targetKey: string) => ({
      actorId,
      host: 'claude-code',
      targetKey,
      repositoryKey: 'acme/repo',
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
      configuredAt: new Date('2026-08-16T09:00:00.000Z'),
      disabledAt: null,
      reportedAt: new Date('2026-08-16T12:00:00.000Z'),
    });
    asMock(prisma.captureProvisioning.findMany).mockResolvedValue([
      provisioningRow('member-a', 'repo:graph-a'),
      provisioningRow('member-b', 'repo:graph-b'),
      provisioningRow('member-gone', 'repo:graph-c'),
    ]);
    asMock(prisma.workspaceMember.findMany).mockResolvedValue([
      { userId: 'member-a', email: 'a@example.test', displayName: 'Alice Example' },
      { userId: 'member-b', email: 'b@example.test', displayName: null },
    ]);

    const result = await service.getWorkspaceActivity('ws-1', 30);
    const names = new Map(result.captureHealth.map((row) => [row.actorId, row.actorName]));
    expect(names.get('member-a')).toBe('Alice Example');
    expect(names.get('member-b')).toBe('b@example.test');
    expect(names.get('member-gone')).toBeNull();
  });
});
