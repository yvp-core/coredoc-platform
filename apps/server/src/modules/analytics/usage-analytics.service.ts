import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { SelfScope } from '../../auth/self-scope.js';
import { GHOST_SESSION_EXCLUSION } from '../../libs/usage/ghost-session-exclusion.js';
import { PRICE_MAP_BASIS, PRICE_MAP_VERSION } from '../../libs/usage/session-pricing.js';
import { FeedbackService } from '../feedback/feedback.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import type { CustomWindowBounds } from '../../libs/analytics-window.js';
import { MAX_ANALYTICS_DAYS, type WorkspaceUsageAnalytics } from './usage-analytics.contract.js';
import {
  foldAdoption,
  foldMembers,
  foldSpendKpi,
  mergeToolRows,
  priceSessions,
  spendSeries,
  splitWindows,
  sumPoints,
  usageWindowBounds,
  usageWindowBoundsFrom,
  utcDayKeys,
} from './usage-analytics.fold.js';

// Re-exported so the controller and the delivery reads share one ceiling.
export { MAX_ANALYTICS_DAYS };

/**
 * Read-model composer for the desktop Analytics "Usage" view (ADR-1). It owns
 * no storage of its own: the metrics and feedback services supply their reads
 * with explicit window bounds (BR-16), and this service prices the session
 * rows and folds them into the wire contract.
 */
const DAY_MS = 86_400_000;

@Injectable()
export class UsageAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly feedback: FeedbackService,
  ) {}

  async getWorkspaceUsage(
    workspaceId: string,
    days: number,
    scope?: SelfScope,
    /** Explicit calendar range (validated in the controller); wins over `days` when present. */
    custom?: CustomWindowBounds | null,
  ): Promise<WorkspaceUsageAnalytics> {
    const windowDays = custom ? custom.days : Math.min(Math.max(Math.floor(days), 1), MAX_ANALYTICS_DAYS);
    const { since, until, previousSince } = custom
      ? usageWindowBoundsFrom(custom.since, custom.untilExclusive)
      : usageWindowBounds(windowDays, new Date());
    // Custom ranges end the day buckets on the requested `until` day instead of today.
    const seriesEndUtcMidnightMs = custom ? custom.untilExclusive.getTime() - DAY_MS : undefined;
    const userWhere = scope ? { userId: scope.userId } : {};

    const [mcpSeries, sessionSeries, breakdown, empties, sessionRows, mcpUserToolRows, memberRows, feedback] =
      await Promise.all([
        // getTimeseries is already UTC-day aligned and ends on the window's last day, so a
        // 2 * days series is exactly [previous window, current window].
        this.metrics.getTimeseries(workspaceId, 'mcp_calls', windowDays * 2, scope, seriesEndUtcMidnightMs),
        this.metrics.getTimeseries(workspaceId, 'sessions', windowDays * 2, scope, seriesEndUtcMidnightMs),
        this.metrics.getMcpQueryBreakdown(workspaceId, windowDays, scope, since, until),
        this.metrics.getMcpEmptyResultBreakdown(workspaceId, windowDays, scope, since, until),
        this.prisma.agentSession.findMany({
          where: {
            workspaceId,
            startedAt: { gte: previousSince, lt: until },
            OR: GHOST_SESSION_EXCLUSION,
            ...userWhere,
          },
          select: {
            provider: true,
            sessionId: true,
            userId: true,
            userEmail: true,
            model: true,
            tokensInput: true,
            tokensOutput: true,
            tokensCacheRead: true,
            tokensCacheCreation: true,
            tokensReasoning: true,
            startedAt: true,
          },
        }),
        this.prisma.mcpQueryMetric.groupBy({
          by: ['userId', 'toolName'],
          where: {
            workspaceId,
            queriedAt: { gte: since, lt: until },
            toolName: { not: { startsWith: 'rest:' } },
            ...userWhere,
          },
          _count: { _all: true },
        }),
        this.prisma.workspaceMember.findMany({
          where: { workspaceId },
          select: { userId: true, email: true, displayName: true },
        }),
        this.feedback.getRoadmap(workspaceId, windowDays, scope, since, until),
      ]);

    const priced = priceSessions(
      sessionRows.map((row) => ({
        ...row,
        tokensInput: Number(row.tokensInput),
        tokensOutput: Number(row.tokensOutput),
        tokensCacheRead: Number(row.tokensCacheRead),
        tokensCacheCreation: Number(row.tokensCacheCreation),
        tokensReasoning: Number(row.tokensReasoning),
      })),
    );
    const sinceMs = since.getTime();
    const current = priced.filter((session) => session.startedAt.getTime() >= sinceMs);
    const previous = priced.filter((session) => session.startedAt.getTime() < sinceMs);

    const mcpHalves = splitWindows(mcpSeries.points, windowDays);
    const sessionHalves = splitWindows(sessionSeries.points, windowDays);
    const mcpUserTools = mcpUserToolRows.map((row) => ({
      userId: row.userId,
      toolName: row.toolName,
      count: row._count._all,
    }));
    const adoption = foldAdoption(current, mcpUserTools, breakdown);

    return {
      window: {
        days: windowDays,
        since: since.toISOString(),
        until: until.toISOString(),
        previousSince: previousSince.toISOString(),
      },
      priceMap: { version: PRICE_MAP_VERSION, basis: PRICE_MAP_BASIS },
      kpis: {
        mcpCalls: { current: sumPoints(mcpHalves.current), previous: sumPoints(mcpHalves.previous) },
        sessions: { current: sumPoints(sessionHalves.current), previous: sumPoints(sessionHalves.previous) },
        // One definition of "developer" on the tab: the adoption fold's union of session
        // owners and attributable MCP callers, so the tile and the meter cannot disagree.
        developers: { current: adoption.developersActive, usingCoredoc: adoption.developersUsingCoredoc },
        spend: foldSpendKpi(current, previous),
      },
      series: {
        mcpCalls: mcpHalves.current,
        sessions: sessionHalves.current,
        spendUsd: spendSeries(current, utcDayKeys(since, windowDays)),
      },
      tools: mergeToolRows(breakdown, empties),
      adoption,
      members: foldMembers(current, mcpUserTools, memberRows),
      feedback,
    };
  }
}
