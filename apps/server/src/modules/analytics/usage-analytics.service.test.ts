import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { SelfScope } from '../../auth/self-scope.js';
import { MAX_ANALYTICS_DAYS, UsageAnalyticsService } from './usage-analytics.service.js';

function points(dates: string[], value: number) {
  return dates.map((date) => ({ date, value }));
}

function createMocks() {
  const prisma = {
    agentSession: { findMany: vi.fn().mockResolvedValue([]) },
    mcpQueryMetric: { groupBy: vi.fn().mockResolvedValue([]) },
    workspaceMember: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const metrics = {
    // 6 UTC days ending today: the first 3 are the previous window.
    getTimeseries: vi.fn(async (_ws: string, metric: string, days: number) => ({
      metric,
      days,
      points: [...points(['d1', 'd2', 'd3'], 1), ...points(['d4', 'd5', 'd6'], 4)],
    })),
    getMcpQueryBreakdown: vi.fn().mockResolvedValue([]),
    getMcpEmptyResultBreakdown: vi.fn().mockResolvedValue([]),
  };
  const feedback = {
    getRoadmap: vi.fn().mockResolvedValue({ feedbackCount: 0, topIssues: [], topMissingTools: [], ratingTrend: [] }),
  };
  return { prisma, metrics, feedback };
}

function build(mocks: ReturnType<typeof createMocks>) {
  // Partial service doubles, same pattern as metrics.service.test.ts.
  return new UsageAnalyticsService(mocks.prisma as any, mocks.metrics as any, mocks.feedback as any);
}

const SELF: SelfScope = { userId: 'member-a' };

describe('UsageAnalyticsService.getWorkspaceUsage', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('composes every read on one window basis and reports both halves (AC-1, BR-16)', async () => {
    const result = await build(mocks).getWorkspaceUsage('ws-1', 3);

    const since = new Date(result.window.since);
    expect(result.window.days).toBe(3);
    // since is UTC midnight and the previous window is exactly `days` earlier.
    expect(result.window.since.endsWith('T00:00:00.000Z')).toBe(true);
    expect(new Date(result.window.previousSince).getTime()).toBe(since.getTime() - 3 * 86_400_000);

    // Timeseries: 2 x days on the same alignment, self-scope forwarded.
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'mcp_calls', 6, undefined, undefined);
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'sessions', 6, undefined, undefined);
    // Breakdown, empty-result and feedback reads get the explicit `since`.
    expect(mocks.metrics.getMcpQueryBreakdown).toHaveBeenCalledWith('ws-1', 3, undefined, since, expect.any(Date));
    expect(mocks.metrics.getMcpEmptyResultBreakdown).toHaveBeenCalledWith(
      'ws-1',
      3,
      undefined,
      since,
      expect.any(Date),
    );
    expect(mocks.feedback.getRoadmap).toHaveBeenCalledWith('ws-1', 3, undefined, since, expect.any(Date));
    // Session rows reach back to the previous window and stop strictly before
    // `until` (the exclusive end of the window), so neither a clock-skewed
    // future row nor the first row of the next day lands in this window.
    const sessionWhere = (mocks.prisma.agentSession.findMany as any).mock.calls[0][0].where;
    expect(sessionWhere.startedAt.gte.toISOString()).toBe(result.window.previousSince);
    expect(sessionWhere.startedAt.lt.toISOString()).toBe(result.window.until);
    expect(sessionWhere.OR).toBeDefined();
    const groupByWhere = (mocks.prisma.mcpQueryMetric.groupBy as any).mock.calls[0][0].where;
    expect(groupByWhere.queriedAt.gte.getTime()).toBe(since.getTime());
    expect(groupByWhere.queriedAt.lt.toISOString()).toBe(result.window.until);
    expect(groupByWhere.toolName).toEqual({ not: { startsWith: 'rest:' } });

    // KPI counters are the sums of the two halves of the series.
    expect(result.kpis.mcpCalls).toEqual({ current: 12, previous: 3 });
    expect(result.kpis.sessions).toEqual({ current: 12, previous: 3 });
    expect(result.series.mcpCalls.reduce((n, p) => n + p.value, 0)).toBe(result.kpis.mcpCalls.current);
    expect(result.series.sessions.reduce((n, p) => n + p.value, 0)).toBe(result.kpis.sessions.current);
    expect(result.series.spendUsd).toHaveLength(3);
    expect(result.priceMap.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('propagates a member self-scope to every composed read (AC-4, BR-4)', async () => {
    await build(mocks).getWorkspaceUsage('ws-1', 7, SELF);

    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'mcp_calls', 14, SELF, undefined);
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'sessions', 14, SELF, undefined);
    expect(mocks.metrics.getMcpQueryBreakdown).toHaveBeenCalledWith(
      'ws-1',
      7,
      SELF,
      expect.any(Date),
      expect.any(Date),
    );
    expect(mocks.metrics.getMcpEmptyResultBreakdown).toHaveBeenCalledWith(
      'ws-1',
      7,
      SELF,
      expect.any(Date),
      expect.any(Date),
    );
    expect(mocks.feedback.getRoadmap).toHaveBeenCalledWith('ws-1', 7, SELF, expect.any(Date), expect.any(Date));
    expect((mocks.prisma.agentSession.findMany as any).mock.calls[0][0].where.userId).toBe('member-a');
    expect((mocks.prisma.mcpQueryMetric.groupBy as any).mock.calls[0][0].where.userId).toBe('member-a');
  });

  it('carries no user filter when unscoped (admin / service token)', async () => {
    await build(mocks).getWorkspaceUsage('ws-1', 7);

    expect((mocks.prisma.agentSession.findMany as any).mock.calls[0][0].where).not.toHaveProperty('userId');
    expect((mocks.prisma.mcpQueryMetric.groupBy as any).mock.calls[0][0].where).not.toHaveProperty('userId');
  });

  it('composes a custom range on its own bounds and ends the day buckets on `until`', async () => {
    const custom = {
      days: 3,
      since: new Date('2026-08-01T00:00:00.000Z'),
      untilExclusive: new Date('2026-08-04T00:00:00.000Z'),
    };

    const result = await build(mocks).getWorkspaceUsage('ws-1', 30, undefined, custom);

    expect(result.window).toMatchObject({
      days: 3,
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-04T00:00:00.000Z',
      previousSince: '2026-07-29T00:00:00.000Z',
    });
    // The 2 * days series must end on the requested `until` day, not today.
    const endUtcMidnightMs = new Date('2026-08-03T00:00:00.000Z').getTime();
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'mcp_calls', 6, undefined, endUtcMidnightMs);
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith('ws-1', 'sessions', 6, undefined, endUtcMidnightMs);
    // Every composed read shares the same custom bounds (BR-16).
    expect(mocks.metrics.getMcpQueryBreakdown).toHaveBeenCalledWith(
      'ws-1',
      3,
      undefined,
      custom.since,
      custom.untilExclusive,
    );
    expect(mocks.metrics.getMcpEmptyResultBreakdown).toHaveBeenCalledWith(
      'ws-1',
      3,
      undefined,
      custom.since,
      custom.untilExclusive,
    );
    expect(mocks.feedback.getRoadmap).toHaveBeenCalledWith('ws-1', 3, undefined, custom.since, custom.untilExclusive);
    const sessionWhere = (mocks.prisma.agentSession.findMany as any).mock.calls[0][0].where;
    expect(sessionWhere.startedAt.gte.toISOString()).toBe('2026-07-29T00:00:00.000Z');
    expect(sessionWhere.startedAt.lt.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(result.series.spendUsd).toHaveLength(3);
  });

  it('clamps days to the analytics ceiling (LIM-4)', async () => {
    const result = await build(mocks).getWorkspaceUsage('ws-1', 500);

    expect(result.window.days).toBe(MAX_ANALYTICS_DAYS);
    expect(mocks.metrics.getTimeseries).toHaveBeenCalledWith(
      'ws-1',
      'mcp_calls',
      MAX_ANALYTICS_DAYS * 2,
      undefined,
      undefined,
    );
    expect(mocks.metrics.getMcpQueryBreakdown).toHaveBeenCalledWith(
      'ws-1',
      MAX_ANALYTICS_DAYS,
      undefined,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('splits the loaded session rows into the current and previous windows', async () => {
    const now = Date.now();
    const inCurrent = new Date(now);
    const inPrevious = new Date(now - 5 * 86_400_000);
    (mocks.prisma.agentSession.findMany as any).mockResolvedValue([
      {
        provider: 'claude-code',
        sessionId: 'cur',
        userId: 'u1',
        userEmail: 'u1@acme.test',
        model: 'claude-sonnet-4-6',
        tokensInput: 1_000_000,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
        startedAt: inCurrent,
      },
      {
        provider: 'claude-code',
        sessionId: 'prev',
        userId: 'u2',
        userEmail: 'u2@acme.test',
        model: 'claude-sonnet-4-6',
        tokensInput: 2_000_000,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensReasoning: 0,
        startedAt: inPrevious,
      },
    ]);

    const result = await build(mocks).getWorkspaceUsage('ws-1', 3);

    expect(result.kpis.spend.currentUsd).toBeCloseTo(3, 10);
    expect(result.kpis.spend.previousUsd).toBeCloseTo(6, 10);
    // Only the current-window session feeds developers and members.
    expect(result.kpis.developers.current).toBe(1);
    expect(result.kpis.developers.current).toBe(result.adoption.developersActive);
    expect(result.members.map((m) => m.userId)).toEqual(['u1']);
    // The session row carries no Coredoc evidence and the mocked MCP rows are empty, so the
    // adoption figures degrade rather than reporting a measured zero.
    expect(result.adoption.developersUsingCoredoc).toBe(0);
    expect(result.adoption.coredocSuccessRate).toBeNull();
  });
});
