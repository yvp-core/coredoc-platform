import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSessionsService } from './agent-sessions.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { LogRecordEvent, SessionDelta, SessionLogRecords } from './otlp-parser.js';

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
    },
    _upsert: upsert,
    _create: create,
    _updateMany: updateMany,
  } as unknown as PrismaService & {
    _upsert: ReturnType<typeof vi.fn>;
    _create: ReturnType<typeof vi.fn>;
    _updateMany: ReturnType<typeof vi.fn>;
  };
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
