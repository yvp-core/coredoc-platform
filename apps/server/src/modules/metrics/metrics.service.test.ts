import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import type { SelfScope } from '../../auth/self-scope.js';

function createMockPrisma() {
  return {
    pushMetric: {
      create: vi.fn().mockResolvedValue({ id: 'metric-1' }),
      upsert: vi.fn().mockResolvedValue({ id: 'metric-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    mcpQueryMetric: {
      create: vi.fn().mockResolvedValue({ id: 'mcp-1' }),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaService;
}

/** Reassemble a tagged-template $queryRaw call's SQL text for assertions. */
function rawSqlOfCall(prisma: PrismaService, callIndex = 0): string {
  const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[callIndex];
  return (call[0] as readonly string[]).join('?');
}

/**
 * Like `rawSqlOfCall` but inlines interpolated `Prisma.sql` fragments (the
 * conditional self-scope filters) so their text is visible; scalar params
 * render as `?`. `Prisma.empty` (the unscoped branch) contributes nothing.
 */
/** Every bound parameter of a `$queryRaw` call, including ones nested in injected `Prisma.sql` fragments. */
function sqlParamsOfCall(prisma: PrismaService, callIndex = 0): unknown[] {
  const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[callIndex];
  const [, ...values] = call as [readonly string[], ...unknown[]];
  return values.flatMap((v) => (v instanceof Prisma.Sql ? v.values : [v]));
}

function composedSqlOfCall(prisma: PrismaService, callIndex = 0): string {
  const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[callIndex];
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v instanceof Prisma.Sql ? v.strings.join('?') : '?') + strings[i + 1];
  }
  return out;
}

const SELF: SelfScope = { userId: 'user-42' };

describe('MetricsService', () => {
  let service: MetricsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new MetricsService(prisma as any);
  });

  describe('recordPushMetrics', () => {
    it('should record metrics for an incremental push', async () => {
      await service.recordPushMetrics({
        workspaceId: 'ws-1',
        repoKey: 'repo_abc',
        repoName: 'my-service',
        commitHash: 'abc123',
        pushedByUserId: 'user-1',
        pushMode: 'incremental',
        totalNodes: 100,
        totalEdges: 200,
        nodesByType: { function: 50, class: 10, entrypoint: 5, entity: 3, external_call: 2, component: 0 },
        edgesByType: { CALLS: 100, IMPORTS: 50 },
        nodesAdded: 5,
        nodesUpdated: 3,
        nodesDeleted: 1,
        nodesWithSummaries: 40,
        nodesWithEmbeddings: 30,
      });

      expect(prisma.pushMetric.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws-1',
          repoKey: 'repo_abc',
          repoName: 'my-service',
          commitHash: 'abc123',
          pushedByUserId: 'user-1',
          pushMode: 'incremental',
          totalNodes: 100,
          totalEdges: 200,
          nodesByType: { function: 50, class: 10, entrypoint: 5, entity: 3, external_call: 2, component: 0 },
          edgesByType: { CALLS: 100, IMPORTS: 50 },
          entrypointCount: 5,
          entityCount: 3,
          externalCallCount: 2,
          componentCount: 0,
          nodesAdded: 5,
          nodesUpdated: 3,
          nodesDeleted: 1,
          nodesWithSummaries: 40,
          nodesWithEmbeddings: 30,
        }),
      });
    });

    it('should record metrics for a full push with null deltas', async () => {
      await service.recordPushMetrics({
        workspaceId: 'ws-1',
        repoKey: 'repo_abc',
        repoName: 'my-service',
        pushMode: 'full',
        totalNodes: 100,
        totalEdges: 200,
        nodesByType: { function: 50 },
        edgesByType: { CALLS: 100 },
        nodesWithSummaries: 0,
        nodesWithEmbeddings: 0,
      });

      expect(prisma.pushMetric.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushMode: 'full',
          nodesAdded: null,
          nodesUpdated: null,
          nodesDeleted: null,
          commitHash: null,
          pushedByUserId: null,
        }),
      });
    });

    it('deduplicates retries by graph execution token', async () => {
      const executionToken = '11111111-1111-4111-8111-111111111111';
      await service.recordPushMetrics({
        executionToken,
        workspaceId: 'ws-1',
        repoKey: 'repo_abc',
        repoName: 'my-service',
        pushMode: 'full',
        totalNodes: 10,
        totalEdges: 20,
        nodesByType: {},
        edgesByType: {},
        nodesWithSummaries: 0,
        nodesWithEmbeddings: 0,
      });

      expect(prisma.pushMetric.upsert).toHaveBeenCalledWith({
        where: { executionToken },
        create: expect.objectContaining({ executionToken, repoKey: 'repo_abc' }),
        update: {},
      });
      expect(prisma.pushMetric.create).not.toHaveBeenCalled();
    });

    it('should not throw if recording fails', async () => {
      (prisma.pushMetric.create as any).mockRejectedValue(new Error('DB down'));

      await expect(
        service.recordPushMetrics({
          workspaceId: 'ws-1',
          repoKey: 'repo_abc',
          repoName: 'my-service',
          pushMode: 'full',
          totalNodes: 100,
          totalEdges: 200,
          nodesByType: {},
          edgesByType: {},
          nodesWithSummaries: 0,
          nodesWithEmbeddings: 0,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('recordMcpQuery', () => {
    it('should record an MCP tool invocation', async () => {
      await service.recordMcpQuery({
        workspaceId: 'ws-1',
        toolName: 'search_symbols',
        userId: 'user-1',
        durationMs: 150,
        success: true,
      });

      expect(prisma.mcpQueryMetric.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          toolName: 'search_symbols',
          userId: 'user-1',
          durationMs: 150,
          success: true,
          resultCount: null,
          scope: null,
        },
      });
    });

    it('records resultCount and scope when the caller supplies them (C3)', async () => {
      await service.recordMcpQuery({
        workspaceId: 'ws-1',
        toolName: 'search_symbols',
        userId: 'user-1',
        durationMs: 150,
        success: true,
        resultCount: 0,
        scope: 'api-server',
      });

      expect(prisma.mcpQueryMetric.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ resultCount: 0, scope: 'api-server' }),
      });
    });

    it('defaults resultCount/scope to null when omitted (non-list tools, unscoped calls)', async () => {
      await service.recordMcpQuery({
        workspaceId: 'ws-1',
        toolName: 'explain',
        durationMs: 100,
        success: true,
      });

      expect(prisma.mcpQueryMetric.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ resultCount: null, scope: null }),
      });
    });

    it('should not throw if recording fails', async () => {
      (prisma.mcpQueryMetric.create as any).mockRejectedValue(new Error('DB down'));

      await expect(
        service.recordMcpQuery({
          workspaceId: 'ws-1',
          toolName: 'search_symbols',
          durationMs: 100,
          success: true,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('getMcpEmptyResultBreakdown (C3)', () => {
    it('excludes NULL resultCount rows from both the numerator and denominator', async () => {
      // Passes-while-broken guard (spec.md acceptance 04): a naive
      // COUNT(*)/COUNT(*) implementation would fold null-count rows into the
      // denominator and silently dilute the rate. This asserts the SQL itself
      // filters them out of both sides.
      await service.getMcpEmptyResultBreakdown('ws-1', 30);

      const sql = rawSqlOfCall(prisma);
      expect(sql).toContain('FROM mcp_query_metrics');
      expect(sql).toContain('result_count IS NOT NULL');
      expect(sql).toContain("tool_name NOT LIKE 'rest:%'");
    });

    it('returns per-tool total/empty/emptyRate as plain numbers', async () => {
      const rows = [
        { toolName: 'search_symbols', total: 10, empty: 4, emptyRate: 0.4 },
        { toolName: 'find_callers', total: 5, empty: 0, emptyRate: 0 },
      ];
      (prisma.$queryRaw as any).mockResolvedValue(rows);

      const result = await service.getMcpEmptyResultBreakdown('ws-1', 30);

      expect(result).toEqual(rows);
      for (const r of result) {
        expect(typeof r.total).toBe('number');
        expect(typeof r.empty).toBe('number');
        expect(typeof r.emptyRate).toBe('number');
      }
    });
  });

  describe('getMcpQueryCount', () => {
    it('returns the current-month count, excluding historical rest:% explorer rows', async () => {
      (prisma.mcpQueryMetric.count as any).mockResolvedValue(42);

      const count = await service.getMcpQueryCount('ws-1');

      expect(count).toBe(42);
      expect(prisma.mcpQueryMetric.count).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws-1',
          queriedAt: { gte: expect.any(Date) },
          toolName: { not: { startsWith: 'rest:' } },
        },
      });
    });

    it('adds a userId filter when self-scoped (member sees only their own calls)', async () => {
      await service.getMcpQueryCount('ws-1', SELF);

      const where = (prisma.mcpQueryMetric.count as any).mock.calls[0][0].where;
      expect(where.userId).toBe('user-42');
    });

    it('omits the userId filter when unscoped (workspace-wide for admin/owner)', async () => {
      await service.getMcpQueryCount('ws-1');

      const where = (prisma.mcpQueryMetric.count as any).mock.calls[0][0].where;
      expect(where).not.toHaveProperty('userId');
    });
  });

  describe('getMcpQueryBreakdown', () => {
    it('returns per-tool count/errorRate/avgMs rows as plain numbers', async () => {
      const rows = [
        { toolName: 'search_symbols', count: 20, errorRate: 0.05, avgMs: 123.4 },
        { toolName: 'find_callers', count: 10, errorRate: 0, avgMs: 80 },
      ];
      (prisma.$queryRaw as any).mockResolvedValue(rows);

      const result = await service.getMcpQueryBreakdown('ws-1', 30);

      expect(result).toEqual(rows);
      for (const r of result) {
        expect(typeof r.count).toBe('number'); // ::int cast — never BigInt
        expect(typeof r.errorRate).toBe('number');
        expect(typeof r.avgMs).toBe('number');
      }
    });

    it('SQL groups per tool, orders by count desc, computes errorRate/avgMs with BigInt-safe casts, excludes rest:%', async () => {
      await service.getMcpQueryBreakdown('ws-1', 30);

      const sql = rawSqlOfCall(prisma);
      expect(sql).toContain('FROM mcp_query_metrics');
      expect(sql).toContain('GROUP BY tool_name');
      expect(sql).toContain('ORDER BY COUNT(*) DESC');
      // errorRate = failed/count (0..1) and avgMs = mean duration, both as
      // JSON-serializable floats; count as ::int (BigInt breaks JSON).
      expect(sql).toContain('COUNT(*)::int');
      expect(sql).toContain('(COUNT(*) FILTER (WHERE success = false))::float / COUNT(*)::float');
      expect(sql).toContain('AVG(duration_ms)::float');
      // Historical explorer REST rows must not pollute the agent-tool signal.
      expect(sql).toContain("tool_name NOT LIKE 'rest:%'");
    });

    it('appends an AND user_id filter when self-scoped', async () => {
      await service.getMcpQueryBreakdown('ws-1', 30, SELF);

      const sql = composedSqlOfCall(prisma);
      expect(sql).toContain('AND user_id =');
      expect(sqlParamsOfCall(prisma)).toContain('user-42');
    });

    it('injects no user filter when unscoped', async () => {
      await service.getMcpQueryBreakdown('ws-1', 30);

      expect(composedSqlOfCall(prisma)).not.toContain('user_id');
    });

    it('uses an explicit `since` verbatim, and the rolling now-days default when absent', async () => {
      // The analytics/usage composer pins every sub-read to one UTC-day-aligned
      // window (BR-16); the standalone route keeps the rolling default.
      const pinned = new Date('2026-08-01T00:00:00.000Z');
      await service.getMcpQueryBreakdown('ws-1', 30, undefined, pinned);
      await service.getMcpEmptyResultBreakdown('ws-1', 30, undefined, pinned);
      expect((prisma.$queryRaw as any).mock.calls[0]).toContain(pinned);
      expect((prisma.$queryRaw as any).mock.calls[1]).toContain(pinned);

      await service.getMcpQueryBreakdown('ws-1', 30);
      const rolling = (prisma.$queryRaw as any).mock.calls[2].find((v: unknown) => v instanceof Date) as Date;
      const expected = Date.now() - 30 * 86_400_000;
      expect(Math.abs(rolling.getTime() - expected)).toBeLessThan(5_000);
    });

    it('bounds the read strictly below an explicit `until` (the window end is exclusive)', async () => {
      const since = new Date('2026-08-01T00:00:00.000Z');
      const until = new Date('2026-08-08T00:00:00.000Z');
      await service.getMcpQueryBreakdown('ws-1', 30, undefined, since, until);
      await service.getMcpEmptyResultBreakdown('ws-1', 30, undefined, since, until);

      const queryBreakdownSql = composedSqlOfCall(prisma, 0);
      const emptyBreakdownSql = composedSqlOfCall(prisma, 1);
      expect(queryBreakdownSql).toContain('AND queried_at <');
      expect(queryBreakdownSql).not.toContain('queried_at <=');
      expect(emptyBreakdownSql).toContain('AND queried_at <');
      expect(emptyBreakdownSql).not.toContain('queried_at <=');
      // `until` is a bound parameter of the injected `windowEnd` fragment, not a
      // top-level call argument.
      expect(sqlParamsOfCall(prisma, 0)).toContainEqual(until);
      expect(sqlParamsOfCall(prisma, 1)).toContainEqual(until);
    });

    it('omits the upper bound when `until` is absent (rolling default)', async () => {
      await service.getMcpQueryBreakdown('ws-1', 30);

      expect(composedSqlOfCall(prisma)).not.toContain('queried_at <');
    });
  });

  describe('getWorkspaceSummary', () => {
    it('should return latest metrics per repo in workspace', async () => {
      const mockLatest = [
        {
          repoKey: 'repo_abc',
          repoName: 'my-service',
          totalNodes: 100,
          totalEdges: 200,
          entrypointCount: 5,
          entityCount: 3,
          externalCallCount: 2,
          componentCount: 0,
          nodesWithSummaries: 40,
          nodesWithEmbeddings: 30,
          pushedAt: new Date('2026-04-01'),
        },
      ];
      (prisma.pushMetric.findMany as any).mockResolvedValue(mockLatest);

      const result = await service.getWorkspaceSummary('ws-1');

      expect(result.totalNodes).toBe(100);
      expect(result.totalEdges).toBe(200);
      expect(result.repos).toHaveLength(1);
    });
  });

  describe('getTimeseries', () => {
    // Frozen clock so UTC day buckets are deterministic: "today" is 2026-03-15,
    // a 7-day window spans 2026-03-09 .. 2026-03-15.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T10:30:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const WEEK = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'];

    it('empty workspace → exactly `days` all-zero points, oldest-first, never a throw', async () => {
      const result = await service.getTimeseries('ws-1', 'mcp_calls', 7);

      expect(result.metric).toBe('mcp_calls');
      expect(result.days).toBe(7);
      expect(result.points).toHaveLength(7);
      expect(result.points.map((p) => p.date)).toEqual(WEEK);
      for (const p of result.points) {
        expect(p.value).toBe(0);
        expect(typeof p.value).toBe('number');
      }
    });

    it('sparse rows land on their dates with zero-fill elsewhere', async () => {
      (prisma.$queryRaw as any).mockResolvedValue([
        { day: '2026-03-11', value: 4 },
        { day: '2026-03-14', value: 2 },
      ]);

      const result = await service.getTimeseries('ws-1', 'mcp_calls', 7);

      expect(result.points).toEqual([
        { date: '2026-03-09', value: 0 },
        { date: '2026-03-10', value: 0 },
        { date: '2026-03-11', value: 4 },
        { date: '2026-03-12', value: 0 },
        { date: '2026-03-13', value: 0 },
        { date: '2026-03-14', value: 2 },
        { date: '2026-03-15', value: 0 },
      ]);
      // Window starts at UTC midnight of the oldest bucket.
      const sinceArg = (prisma.$queryRaw as any).mock.calls[0][2];
      expect(sinceArg).toEqual(new Date('2026-03-09T00:00:00.000Z'));
    });

    it('mcp_calls SQL excludes historical rest:% explorer rows (matches the headline count)', async () => {
      await service.getTimeseries('ws-1', 'mcp_calls', 7);

      const sql = rawSqlOfCall(prisma);
      expect(sql).toContain('FROM mcp_query_metrics');
      expect(sql).toContain("tool_name NOT LIKE 'rest:%'");
    });

    it('sessions SQL applies the ghost-session filter (matches the headline KPI)', async () => {
      await service.getTimeseries('ws-1', 'sessions', 7);

      const sql = rawSqlOfCall(prisma);
      expect(sql).toContain('FROM agent_sessions');
      expect(sql).toContain('last_event_nanos > 0');
      expect(sql).toContain('active_time_sec > 0');
      expect(sql).toContain('tokens_input > 0');
      expect(sql).toContain('tokens_output > 0');
      expect(sql).toContain('commit_count > 0');
      // BigInt-safe cast is load-bearing for JSON serialization.
      expect(sql).toContain('COUNT(*)::int');
    });

    it('cost SQL sums cost_usd as float with the same ghost filter', async () => {
      (prisma.$queryRaw as any).mockResolvedValue([{ day: '2026-03-14', value: 1.25 }]);

      const result = await service.getTimeseries('ws-1', 'cost', 7);

      const sql = rawSqlOfCall(prisma);
      expect(sql).toContain('SUM(cost_usd)::float');
      expect(sql).toContain('last_event_nanos > 0');
      expect(result.points[5]).toEqual({ date: '2026-03-14', value: 1.25 });
      for (const p of result.points) expect(typeof p.value).toBe('number');
    });

    it('all three flow metrics self-scope on user_id (mcp_calls, sessions, cost)', async () => {
      await service.getTimeseries('ws-1', 'mcp_calls', 7, SELF);
      expect(composedSqlOfCall(prisma)).toContain('AND user_id =');

      prisma = createMockPrisma();
      service = new MetricsService(prisma as any);
      await service.getTimeseries('ws-1', 'sessions', 7, SELF);
      expect(composedSqlOfCall(prisma)).toContain('AND user_id =');

      prisma = createMockPrisma();
      service = new MetricsService(prisma as any);
      await service.getTimeseries('ws-1', 'cost', 7, SELF);
      expect(composedSqlOfCall(prisma)).toContain('AND user_id =');
    });

    it('flow metrics carry no user filter when unscoped', async () => {
      await service.getTimeseries('ws-1', 'mcp_calls', 7);
      expect(composedSqlOfCall(prisma)).not.toContain('user_id');

      prisma = createMockPrisma();
      service = new MetricsService(prisma as any);
      await service.getTimeseries('ws-1', 'sessions', 7);
      expect(composedSqlOfCall(prisma)).not.toContain('user_id');
    });

    it('nodes stays workspace-wide even when self-scoped (no raw SQL, no user filter)', async () => {
      (prisma.pushMetric.findMany as any).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await service.getTimeseries('ws-1', 'nodes', 7, SELF);

      expect(result.points).toHaveLength(7);
      // Node series is a level query over push_metrics (no user column) — the
      // scope must never reach it.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      const baselineWhere = (prisma.pushMetric.findMany as any).mock.calls[0][0].where;
      expect(baselineWhere).not.toHaveProperty('userId');
      expect(baselineWhere).not.toHaveProperty('userEmail');
    });

    it('nodes: zeros before first push, carry-forward across gap days, multi-repo summation', async () => {
      // No pushes before the window; three pushes inside it.
      (prisma.pushMetric.findMany as any)
        .mockResolvedValueOnce([]) // (a) baseline
        .mockResolvedValueOnce([
          { repoKey: 'repo-a', totalNodes: 100, pushedAt: new Date('2026-03-10T08:00:00Z') },
          { repoKey: 'repo-b', totalNodes: 50, pushedAt: new Date('2026-03-12T09:00:00Z') },
          { repoKey: 'repo-a', totalNodes: 120, pushedAt: new Date('2026-03-14T10:00:00Z') },
        ]); // (b) window rows

      const result = await service.getTimeseries('ws-1', 'nodes', 7);

      expect(result.points).toEqual([
        { date: '2026-03-09', value: 0 }, // before the first-ever push
        { date: '2026-03-10', value: 100 },
        { date: '2026-03-11', value: 100 }, // gap day carries forward
        { date: '2026-03-12', value: 150 }, // repo-a + repo-b
        { date: '2026-03-13', value: 150 },
        { date: '2026-03-14', value: 170 }, // repo-a re-push replaces its level
        { date: '2026-03-15', value: 170 },
      ]);
      for (const p of result.points) expect(typeof p.value).toBe('number');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      // Baseline query: latest-per-repo strictly before the window.
      expect(prisma.pushMetric.findMany).toHaveBeenNthCalledWith(1, {
        where: { workspaceId: 'ws-1', pushedAt: { lt: new Date('2026-03-09T00:00:00.000Z') } },
        orderBy: { pushedAt: 'desc' },
        distinct: ['repoKey'],
        select: { repoKey: true, totalNodes: true },
      });
      // Window query: ascending so later pushes win the day.
      expect(prisma.pushMetric.findMany).toHaveBeenNthCalledWith(2, {
        where: { workspaceId: 'ws-1', pushedAt: { gte: new Date('2026-03-09T00:00:00.000Z') } },
        orderBy: { pushedAt: 'asc' },
        select: { repoKey: true, totalNodes: true, pushedAt: true },
      });
    });

    it('nodes: a pre-window baseline seeds every day when the window has no pushes', async () => {
      (prisma.pushMetric.findMany as any)
        .mockResolvedValueOnce([
          { repoKey: 'repo-a', totalNodes: 80 },
          { repoKey: 'repo-b', totalNodes: 20 },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getTimeseries('ws-1', 'nodes', 7);

      expect(result.points).toHaveLength(7);
      for (const p of result.points) expect(p.value).toBe(100);
    });
  });
});

describe('MetricsController timeseries metric allowlist', () => {
  const admin: AuthUser = { id: 'u-admin', email: 'admin@acme.com' };

  it('rejects an unknown metric with a 400 naming the valid values', async () => {
    const service = { getTimeseries: vi.fn() } as unknown as MetricsService;
    const controller = new MetricsController(service);

    await expect(controller.getTimeseries('ws-1', admin, WorkspaceMemberRole.Admin, 'bogus', '30')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.getTimeseries('ws-1', admin, WorkspaceMemberRole.Admin, undefined, undefined),
    ).rejects.toThrow(/mcp_calls, sessions, cost, nodes/);
    expect(service.getTimeseries).not.toHaveBeenCalled();
  });

  it('passes a valid metric through with parsed days (admin → no self-scope)', async () => {
    const service = {
      getTimeseries: vi.fn().mockResolvedValue({ metric: 'sessions', days: 60, points: [] }),
    } as unknown as MetricsService;
    const controller = new MetricsController(service);

    await controller.getTimeseries('ws-1', admin, WorkspaceMemberRole.Admin, 'sessions', '60');

    expect(service.getTimeseries).toHaveBeenCalledWith('ws-1', 'sessions', 60, undefined);
  });
});
