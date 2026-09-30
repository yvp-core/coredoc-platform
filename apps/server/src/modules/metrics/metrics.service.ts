import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SelfScope } from '../../auth/self-scope.js';

/** Series names served by `getTimeseries` (the controller allowlist). */
export const TIMESERIES_METRICS = ['mcp_calls', 'sessions', 'cost', 'nodes'] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

/** One day bucket in a timeseries. `date` is a UTC 'YYYY-MM-DD' key. */
export interface TimeseriesPoint {
  date: string;
  value: number;
}

const DAY_MS = 86_400_000;

/** The historical rolling window base for the breakdown reads: `now - days`. */
function rollingSince(days: number): Date {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return since;
}

export interface RecordPushMetricsInput {
  executionToken?: string;
  workspaceId: string;
  repoKey: string;
  repoName: string;
  commitHash?: string | null;
  pushedByUserId?: string | null;
  pushMode: 'incremental' | 'full';
  pushDurationMs?: number | null;
  diffSkippedPct?: number | null;
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  nodesAdded?: number | null;
  nodesUpdated?: number | null;
  nodesDeleted?: number | null;
  nodesWithSummaries: number;
  nodesWithEmbeddings: number;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordPushMetrics(input: RecordPushMetricsInput): Promise<void> {
    try {
      const nodesByType = input.nodesByType as Record<string, number>;

      const data = {
        workspaceId: input.workspaceId,
        repoKey: input.repoKey,
        repoName: input.repoName,
        commitHash: input.commitHash ?? null,
        pushedByUserId: input.pushedByUserId ?? null,
        pushMode: input.pushMode,
        pushDurationMs: input.pushDurationMs ?? null,
        diffSkippedPct: input.diffSkippedPct ?? null,
        totalNodes: input.totalNodes,
        totalEdges: input.totalEdges,
        nodesByType: input.nodesByType,
        edgesByType: input.edgesByType,
        entrypointCount: nodesByType.entrypoint ?? 0,
        entityCount: nodesByType.entity ?? 0,
        externalCallCount: nodesByType.external_call ?? 0,
        componentCount: nodesByType.component ?? 0,
        nodesAdded: input.nodesAdded ?? null,
        nodesUpdated: input.nodesUpdated ?? null,
        nodesDeleted: input.nodesDeleted ?? null,
        nodesWithSummaries: input.nodesWithSummaries,
        nodesWithEmbeddings: input.nodesWithEmbeddings,
      };
      if (input.executionToken) {
        await this.prisma.pushMetric.upsert({
          where: { executionToken: input.executionToken },
          create: { ...data, executionToken: input.executionToken },
          update: {},
        });
      } else {
        await this.prisma.pushMetric.create({ data });
      }
    } catch (err) {
      this.logger.error(`Failed to record push metrics: ${err}`);
    }
  }

  /**
   * Record an MCP tool invocation. Non-blocking.
   */
  async recordMcpQuery(input: {
    workspaceId: string;
    toolName: string;
    userId?: string | null;
    durationMs: number;
    success: boolean;
    // Retrieval-quality parity fields (C3) — see BaseCoredocTool.resultCountOf.
    // Both default to null: most callers (non-list tools, workspace-wide
    // calls) never resolve a value, and null is the correct "unclassified"
    // marker `getMcpEmptyResultBreakdown` excludes from its rate.
    resultCount?: number | null;
    scope?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.mcpQueryMetric.create({
        data: {
          workspaceId: input.workspaceId,
          toolName: input.toolName,
          userId: input.userId ?? null,
          durationMs: input.durationMs,
          success: input.success,
          resultCount: input.resultCount ?? null,
          scope: input.scope ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to record MCP query metric: ${err}`);
    }
  }

  /**
   * Count MCP queries for a workspace in the current calendar month.
   * Excludes historical `rest:%` rows — explorer REST traffic recorded as MCP
   * metrics by a since-removed GraphService bug; only agent tool calls count.
   */
  async getMcpQueryCount(workspaceId: string, scope?: SelfScope): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    return this.prisma.mcpQueryMetric.count({
      where: {
        workspaceId,
        queriedAt: { gte: startOfMonth },
        toolName: { not: { startsWith: 'rest:' } },
        // Self-scope a member to their own MCP calls (user_id = coredoc auth id).
        ...(scope ? { userId: scope.userId } : {}),
      },
    });
  }

  /**
   * Per-tool MCP call quality for a workspace in a time window: call count,
   * error rate (failed/count, 0..1), and mean duration. Ordered by count desc.
   * Excludes historical `rest:%` rows (see getMcpQueryCount).
   */
  async getMcpQueryBreakdown(
    workspaceId: string,
    days: number = 30,
    scope?: SelfScope,
    since?: Date,
    until?: Date,
  ): Promise<Array<{ toolName: string; count: number; errorRate: number; avgMs: number }>> {
    // An explicit `since` lets a composing read (analytics/usage) pin every
    // sub-read to one UTC-day-aligned window; absent, the rolling `now - days`
    // default the standalone route has always used applies. `until`, when
    // given alongside it, is the window's EXCLUSIVE end (UTC midnight after the
    // last day), so the bound is `<` — `<=` would leak the next window's first
    // instant in, on top of the clock-skewed future rows it exists to exclude.
    const windowStart = since ?? rollingSince(days);
    const windowEnd = until ? Prisma.sql`AND queried_at < ${until}` : Prisma.empty;

    // Self-scope a member to their own MCP calls (user_id = coredoc auth id).
    const userFilter = scope ? Prisma.sql`AND user_id = ${scope.userId}` : Prisma.empty;

    // ::int / ::float casts are load-bearing: COUNT(*) comes back as BigInt,
    // which breaks JSON serialization (same precedent as getFlowSeries).
    return this.prisma.$queryRaw<Array<{ toolName: string; count: number; errorRate: number; avgMs: number }>>`
      SELECT
        tool_name AS "toolName",
        COUNT(*)::int AS count,
        (COUNT(*) FILTER (WHERE success = false))::float / COUNT(*)::float AS "errorRate",
        AVG(duration_ms)::float AS "avgMs"
      FROM mcp_query_metrics
      WHERE workspace_id = ${workspaceId}::uuid
        AND queried_at >= ${windowStart}
        ${windowEnd}
        AND tool_name NOT LIKE 'rest:%'
        ${userFilter}
      GROUP BY tool_name
      ORDER BY COUNT(*) DESC
    `;
  }

  /**
   * Per-tool empty-result rate for a workspace in a time window: how often a
   * list-shaped (or single-entity) tool call yielded zero items. Cloud
   * equivalent of the local server's `getEmptyResultBreakdown()` — the signal
   * that flags failing retrieval (e.g. `search_symbols` returning nothing).
   *
   * Rows with `result_count IS NULL` (unclassified tools/response shapes —
   * see `BaseCoredocTool.resultCountOf`) are excluded from BOTH the numerator
   * and the denominator: they carry no yield information, so counting them as
   * "not empty" would understate the rate and counting them as "empty" would
   * overstate it. Same `rest:%` exclusion as the sibling `getMcpQueryBreakdown`
   * (historical explorer REST traffic, not agent tool calls).
   */
  async getMcpEmptyResultBreakdown(
    workspaceId: string,
    days: number = 30,
    scope?: SelfScope,
    since?: Date,
    until?: Date,
  ): Promise<Array<{ toolName: string; total: number; empty: number; emptyRate: number }>> {
    // Same explicit-window rule as the sibling `getMcpQueryBreakdown`.
    const windowStart = since ?? rollingSince(days);
    const windowEnd = until ? Prisma.sql`AND queried_at < ${until}` : Prisma.empty;

    const userFilter = scope ? Prisma.sql`AND user_id = ${scope.userId}` : Prisma.empty;

    // ::int / ::float casts are load-bearing: COUNT(*) comes back as BigInt,
    // which breaks JSON serialization (same precedent as getMcpQueryBreakdown).
    return this.prisma.$queryRaw<Array<{ toolName: string; total: number; empty: number; emptyRate: number }>>`
      SELECT
        tool_name AS "toolName",
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE result_count = 0))::int AS empty,
        (COUNT(*) FILTER (WHERE result_count = 0))::float / COUNT(*)::float AS "emptyRate"
      FROM mcp_query_metrics
      WHERE workspace_id = ${workspaceId}::uuid
        AND queried_at >= ${windowStart}
        ${windowEnd}
        AND tool_name NOT LIKE 'rest:%'
        AND result_count IS NOT NULL
        ${userFilter}
      GROUP BY tool_name
      ORDER BY COUNT(*) DESC
    `;
  }

  /**
   * Get push metrics history for a specific repo within a time window.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Prisma returns dynamic JSON fields
  async getRepoMetricsHistory(workspaceId: string, repoKey: string, days: number = 30): Promise<any[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.pushMetric.findMany({
      where: {
        workspaceId,
        repoKey,
        pushedAt: { gte: since },
      },
      orderBy: { pushedAt: 'desc' },
      take: 100,
      // Rows are returned verbatim by the controller. Keep an allow-list so a
      // future internal column cannot silently become part of the public API;
      // executionToken is intentionally absent.
      select: {
        id: true,
        workspaceId: true,
        repoKey: true,
        repoName: true,
        commitHash: true,
        pushedByUserId: true,
        pushMode: true,
        pushedAt: true,
        pushDurationMs: true,
        diffSkippedPct: true,
        totalNodes: true,
        totalEdges: true,
        nodesByType: true,
        edgesByType: true,
        entrypointCount: true,
        entityCount: true,
        externalCallCount: true,
        componentCount: true,
        nodesAdded: true,
        nodesUpdated: true,
        nodesDeleted: true,
        nodesWithSummaries: true,
        nodesWithEmbeddings: true,
      },
    });
  }

  /**
   * Get aggregated workspace summary from latest push per repo.
   */
  async getWorkspaceSummary(workspaceId: string): Promise<{
    totalNodes: number;
    totalEdges: number;
    totalEntrypoints: number;
    totalEntities: number;
    totalExternalCalls: number;
    totalComponents: number;
    summaryCoverage: number;
    embeddingCoverage: number;
    repos: Array<{
      repoKey: string;
      repoName: string;
      totalNodes: number;
      totalEdges: number;
      entrypointCount: number;
      entityCount: number;
      externalCallCount: number;
      componentCount: number;
      nodesWithSummaries: number;
      nodesWithEmbeddings: number;
      pushedAt: Date;
    }>;
  }> {
    // Get the latest metric per repo using distinct on repoKey
    const latestPerRepo = await this.prisma.pushMetric.findMany({
      where: { workspaceId },
      orderBy: { pushedAt: 'desc' },
      distinct: ['repoKey'],
      select: {
        repoKey: true,
        repoName: true,
        totalNodes: true,
        totalEdges: true,
        entrypointCount: true,
        entityCount: true,
        externalCallCount: true,
        componentCount: true,
        nodesWithSummaries: true,
        nodesWithEmbeddings: true,
        pushedAt: true,
      },
    });

    const totals = latestPerRepo.reduce(
      (acc, r) => ({
        totalNodes: acc.totalNodes + r.totalNodes,
        totalEdges: acc.totalEdges + r.totalEdges,
        totalEntrypoints: acc.totalEntrypoints + r.entrypointCount,
        totalEntities: acc.totalEntities + r.entityCount,
        totalExternalCalls: acc.totalExternalCalls + r.externalCallCount,
        totalComponents: acc.totalComponents + r.componentCount,
        totalSummaries: acc.totalSummaries + r.nodesWithSummaries,
        totalEmbeddings: acc.totalEmbeddings + r.nodesWithEmbeddings,
      }),
      {
        totalNodes: 0,
        totalEdges: 0,
        totalEntrypoints: 0,
        totalEntities: 0,
        totalExternalCalls: 0,
        totalComponents: 0,
        totalSummaries: 0,
        totalEmbeddings: 0,
      },
    );

    return {
      totalNodes: totals.totalNodes,
      totalEdges: totals.totalEdges,
      totalEntrypoints: totals.totalEntrypoints,
      totalEntities: totals.totalEntities,
      totalExternalCalls: totals.totalExternalCalls,
      totalComponents: totals.totalComponents,
      summaryCoverage: totals.totalNodes > 0 ? totals.totalSummaries / totals.totalNodes : 0,
      embeddingCoverage: totals.totalNodes > 0 ? totals.totalEmbeddings / totals.totalNodes : 0,
      repos: latestPerRepo,
    };
  }

  /**
   * Daily series for KPI sparklines. Returns exactly `days` points, oldest-first,
   * bucketed by UTC calendar day and ending today.
   *
   * - `mcp_calls` / `sessions`: counts per day, gaps zero-filled. `sessions`
   *   applies the same ghost-session filter as
   *   `AgentSessionsService.getWorkspaceSessionSummary` so sparkline totals
   *   match the headline KPI.
   * - `cost`: SUM(cost_usd) per day on `agent_sessions.started_at` —
   *   session-granular attribution (the whole session's cost lands on its
   *   start day), same ghost filter.
   * - `nodes`: a LEVEL, not a flow — carry-forward of the latest
   *   `push_metrics.total_nodes` per repoKey (matches `getWorkspaceSummary`
   *   semantics). Days before the first-ever push are 0; gap days carry the
   *   previous level forward.
   *
   * Empty workspace → a full-length all-zero series, never a throw.
   */
  async getTimeseries(
    workspaceId: string,
    metric: TimeseriesMetric,
    days: number,
    scope?: SelfScope,
    /** UTC midnight of the last bucket; defaults to today. A composing read on a custom range
     * ends the series on its own `until` day so a `2 * days` series is still exactly
     * [previous window, current window]. */
    endUtcMidnightMs?: number,
  ): Promise<{ metric: TimeseriesMetric; days: number; points: TimeseriesPoint[] }> {
    const now = new Date();
    const lastUtcMs = endUtcMidnightMs ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // Oldest-first UTC 'YYYY-MM-DD' bucket keys, ending on the last bucket day.
    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dayKeys.push(new Date(lastUtcMs - i * DAY_MS).toISOString().slice(0, 10));
    }
    // Start of the oldest bucket (UTC midnight).
    const since = new Date(lastUtcMs - (days - 1) * DAY_MS);

    const points =
      metric === 'nodes'
        ? // nodes is a workspace-level graph size, not per-user activity — never self-scoped.
          await this.getNodesLevelSeries(workspaceId, since, dayKeys)
        : await this.getFlowSeries(workspaceId, metric, since, dayKeys, scope);

    return { metric, days, points };
  }

  /** Flow metrics (mcp_calls / sessions / cost): per-day aggregates, zero-filled. */
  private async getFlowSeries(
    workspaceId: string,
    metric: Exclude<TimeseriesMetric, 'nodes'>,
    since: Date,
    dayKeys: string[],
    scope?: SelfScope,
  ): Promise<TimeseriesPoint[]> {
    // ::int / ::float casts are load-bearing: COUNT(*) comes back as BigInt,
    // which breaks JSON serialization (precedent: push-worker.service.ts).
    let rows: Array<{ day: string; value: number }>;
    if (metric === 'mcp_calls') {
      // Self-scope a member to their own MCP calls (user_id = coredoc auth id).
      const userFilter = scope ? Prisma.sql`AND user_id = ${scope.userId}` : Prisma.empty;
      // tool_name NOT LIKE 'rest:%' excludes historical explorer REST rows
      // (see getMcpQueryCount) so the sparkline matches the headline count.
      rows = await this.prisma.$queryRaw<Array<{ day: string; value: number }>>`
        SELECT to_char(queried_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
        FROM mcp_query_metrics
        WHERE workspace_id = ${workspaceId}::uuid AND queried_at >= ${since}
          AND tool_name NOT LIKE 'rest:%'
          ${userFilter}
        GROUP BY 1
        ORDER BY 1
      `;
    } else if (metric === 'sessions') {
      // Self-scope a member to their own sessions by server-derived user_id
      // (matches mcp_calls above — all three flow metrics now scope on user_id).
      const userFilter = scope ? Prisma.sql`AND user_id = ${scope.userId}` : Prisma.empty;
      rows = await this.prisma.$queryRaw<Array<{ day: string; value: number }>>`
        SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
        FROM agent_sessions
        WHERE workspace_id = ${workspaceId}::uuid AND started_at >= ${since}
          AND (last_event_nanos > 0 OR active_time_sec > 0 OR tokens_input > 0 OR tokens_output > 0 OR commit_count > 0)
          ${userFilter}
        GROUP BY 1
        ORDER BY 1
      `;
    } else {
      // cost: same session-granular self-scope on the server-derived user_id.
      const userFilter = scope ? Prisma.sql`AND user_id = ${scope.userId}` : Prisma.empty;
      rows = await this.prisma.$queryRaw<Array<{ day: string; value: number }>>`
        SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, SUM(cost_usd)::float AS value
        FROM agent_sessions
        WHERE workspace_id = ${workspaceId}::uuid AND started_at >= ${since}
          AND (last_event_nanos > 0 OR active_time_sec > 0 OR tokens_input > 0 OR tokens_output > 0 OR commit_count > 0)
          ${userFilter}
        GROUP BY 1
        ORDER BY 1
      `;
    }

    const byDay = new Map(rows.map((r) => [r.day, r.value]));
    return dayKeys.map((date) => ({ date, value: byDay.get(date) ?? 0 }));
  }

  /** Nodes level series: carry-forward of the latest totalNodes per repoKey. */
  private async getNodesLevelSeries(workspaceId: string, since: Date, dayKeys: string[]): Promise<TimeseriesPoint[]> {
    // (a) Baseline: latest push per repo BEFORE the window seeds the level.
    const baseline = await this.prisma.pushMetric.findMany({
      where: { workspaceId, pushedAt: { lt: since } },
      orderBy: { pushedAt: 'desc' },
      distinct: ['repoKey'],
      select: { repoKey: true, totalNodes: true },
    });
    // (b) Pushes inside the window, ascending, grouped by UTC day.
    const windowRows = await this.prisma.pushMetric.findMany({
      where: { workspaceId, pushedAt: { gte: since } },
      orderBy: { pushedAt: 'asc' },
      select: { repoKey: true, totalNodes: true, pushedAt: true },
    });
    const pushesByDay = new Map<string, Array<{ repoKey: string; totalNodes: number }>>();
    for (const row of windowRows) {
      const day = row.pushedAt.toISOString().slice(0, 10);
      const list = pushesByDay.get(day);
      if (list) list.push(row);
      else pushesByDay.set(day, [row]);
    }
    // (c) Walk the days: apply that day's pushes (last push per repo wins),
    // point value = sum of per-repo levels. No pushes yet → 0.
    const level = new Map<string, number>(baseline.map((r) => [r.repoKey, r.totalNodes]));
    return dayKeys.map((date) => {
      for (const push of pushesByDay.get(date) ?? []) {
        level.set(push.repoKey, push.totalNodes);
      }
      let sum = 0;
      for (const v of level.values()) sum += v;
      return { date, value: sum };
    });
  }
}
