import { estimateSessionCostUsd } from '../../libs/usage/session-pricing.js';
import { median } from '../../libs/coerce.js';
import type { TimeseriesPoint } from '../metrics/metrics.service.js';
import type {
  SpendPoint,
  UsageAdoption,
  UsageMemberRow,
  UsageSpend,
  UsageToolRow,
} from './usage-analytics.contract.js';

/**
 * Pure folds behind `UsageAnalyticsService` — every function here takes rows
 * (or `now`) and returns contract shapes, so the arithmetic is testable
 * without Nest or Prisma.
 */

const DAY_MS = 86_400_000;

export interface UsageWindowBounds {
  since: Date;
  until: Date;
  previousSince: Date;
}

/**
 * BR-16: one window basis for every composed read. `since` is UTC midnight
 * `days - 1` days back (so the window covers `days` whole UTC days ending
 * today), matching `MetricsService.getTimeseries` bucketing.
 */
export function usageWindowBounds(days: number, now: Date): UsageWindowBounds {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMs = todayUtcMs - (days - 1) * DAY_MS;
  return {
    since: new Date(sinceMs),
    until: new Date(now.getTime()),
    previousSince: new Date(sinceMs - days * DAY_MS),
  };
}

/**
 * Same basis for an explicit custom range: `untilExclusive` is UTC midnight of the day after
 * the requested `until`, and the comparison window is the equal-length span before `since`.
 */
export function usageWindowBoundsFrom(since: Date, untilExclusive: Date): UsageWindowBounds {
  const days = Math.round((untilExclusive.getTime() - since.getTime()) / DAY_MS);
  return {
    since,
    until: untilExclusive,
    previousSince: new Date(since.getTime() - days * DAY_MS),
  };
}

/** Oldest-first UTC 'YYYY-MM-DD' keys covering `days` days from `since`. */
export function utcDayKeys(since: Date, days: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    keys.push(new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Splits a `2 * days` timeseries (UTC-day aligned, ending today) into the
 * previous and current window halves. A short series (fewer points than
 * requested) still yields the trailing `days` points as the current half.
 */
export function splitWindows(
  points: TimeseriesPoint[],
  days: number,
): { previous: TimeseriesPoint[]; current: TimeseriesPoint[] } {
  const split = Math.max(points.length - days, 0);
  return { previous: points.slice(0, split), current: points.slice(split) };
}

export function sumPoints(points: TimeseriesPoint[]): number {
  return points.reduce((total, point) => total + point.value, 0);
}

export interface ToolBreakdownRow {
  toolName: string;
  count: number;
  errorRate: number;
  avgMs: number;
}

export interface ToolEmptyRow {
  toolName: string;
  total: number;
  empty: number;
  emptyRate: number;
}

/**
 * BR-3: joins the per-tool call breakdown with the per-tool empty-result
 * breakdown. A tool with no classified rows keeps `emptyRate: null` — the
 * empty-result read excludes `result_count IS NULL` rows entirely, so absence
 * means "unknown yield", never "never empty".
 */
export function mergeToolRows(breakdown: ToolBreakdownRow[], empties: ToolEmptyRow[]): UsageToolRow[] {
  const emptyByTool = new Map(empties.map((row) => [row.toolName, row]));
  return breakdown
    .map((row) => {
      const classified = emptyByTool.get(row.toolName);
      return {
        toolName: row.toolName,
        calls: row.count,
        errorRate: row.errorRate,
        avgMs: row.avgMs,
        emptyRate: classified ? classified.emptyRate : null,
        classifiedCalls: classified ? classified.total : 0,
      } satisfies UsageToolRow;
    })
    .sort((left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName));
}

export interface UsageSessionRow {
  provider: string;
  sessionId: string;
  userId: string | null;
  userEmail: string | null;
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensReasoning: number;
  startedAt: Date;
}

export interface PricedSession extends UsageSessionRow {
  /** Any token counter above zero. */
  usageObserved: boolean;
  /** null when usage is absent OR the model carries no price-map entry. */
  estimatedCostUsd: number | null;
}

export function priceSessions(rows: UsageSessionRow[]): PricedSession[] {
  return rows.map((row) => {
    const usageObserved =
      row.tokensInput > 0 ||
      row.tokensOutput > 0 ||
      row.tokensCacheRead > 0 ||
      row.tokensCacheCreation > 0 ||
      row.tokensReasoning > 0;
    const estimatedCostUsd = usageObserved
      ? estimateSessionCostUsd(row.provider, row.model ?? '', {
          input: row.tokensInput,
          output: row.tokensOutput,
          cacheRead: row.tokensCacheRead,
          cacheCreation: row.tokensCacheCreation,
          reasoning: row.tokensReasoning,
        })
      : null;
    return { ...row, usageObserved, estimatedCostUsd };
  });
}

/** BR-1/LIM-1: a window with no priced session reports null, never $0. */
export function rollupSpend(sessions: PricedSession[]): {
  totalUsd: number | null;
  unpricedSessions: number;
  sessionsWithoutUsage: number;
} {
  let totalUsd: number | null = null;
  let unpricedSessions = 0;
  let sessionsWithoutUsage = 0;
  for (const session of sessions) {
    if (!session.usageObserved) {
      sessionsWithoutUsage += 1;
      continue;
    }
    if (session.estimatedCostUsd === null) {
      unpricedSessions += 1;
      continue;
    }
    totalUsd = (totalUsd ?? 0) + session.estimatedCostUsd;
  }
  return { totalUsd, unpricedSessions, sessionsWithoutUsage };
}

export function foldSpendKpi(current: PricedSession[], previous: PricedSession[]): UsageSpend {
  const currentRollup = rollupSpend(current);
  const previousRollup = rollupSpend(previous);
  return {
    currentUsd: currentRollup.totalUsd,
    previousUsd: previousRollup.totalUsd,
    unpricedSessions: currentRollup.unpricedSessions,
    sessionsWithoutUsage: currentRollup.sessionsWithoutUsage,
  };
}

/**
 * BR-17: per-UTC-day spend. A day with no session at all is a real zero
 * (nothing was spent), so it is zero-filled like the other series; a day that
 * has sessions but none priced yields `value: null`, because the spend for
 * that day is unknown rather than zero. `unpricedSessions` and
 * `sessionsWithoutUsage` carry the two distinct reasons a day can go null, so
 * a day where every session lacked usage telemetry is not mistaken for one
 * that simply ran an unpriced model.
 */
export function spendSeries(sessions: PricedSession[], dayKeys: string[]): SpendPoint[] {
  const byDay = new Map<string, PricedSession[]>();
  for (const session of sessions) {
    const day = session.startedAt.toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(session);
    else byDay.set(day, [session]);
  }
  return dayKeys.map((date) => {
    const bucket = byDay.get(date);
    if (!bucket || bucket.length === 0) return { date, value: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 };
    const { totalUsd, unpricedSessions, sessionsWithoutUsage } = rollupSpend(bucket);
    return { date, value: totalUsd, unpricedSessions, sessionsWithoutUsage };
  });
}

/**
 * Groups by userId when the session carries one; sessions without a userId
 * group by email so unattributed ingest stays visible without merging two
 * users (same rule as the activity rollup).
 */
export function sessionUserKey(session: { userId: string | null; userEmail: string | null }): string {
  return session.userId !== null ? `id:${session.userId}` : `email:${session.userEmail ?? ''}`;
}

export interface McpUserToolRow {
  userId: string | null;
  toolName: string;
  count: number;
}

/** User keys of the MCP callers the server could attribute; an unattributed row names nobody. */
function mcpUserKeys(mcpRows: McpUserToolRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of mcpRows) {
    if (row.userId === null || row.count <= 0) continue;
    keys.add(`id:${row.userId}`);
  }
  return keys;
}

/**
 * Distinct developers active in the window: session owners unioned with the
 * MCP callers the server attributed. A member can drive Coredoc from an editor
 * with the MCP server attached and no capture hook, so counting sessions alone
 * would report fewer developers than the members table lists.
 */
export function countDevelopers(sessions: PricedSession[], mcpRows: McpUserToolRow[]): number {
  const keys = new Set(sessions.map(sessionUserKey));
  for (const key of mcpUserKeys(mcpRows)) keys.add(key);
  return keys.size;
}

/**
 * BR-3/BR-4: adoption from server-observed `mcp_query_metrics` plus session medians.
 *
 * The per-session `coredocToolCalls` / `coredocToolStats` columns are not consulted: they are
 * only written from host OTel `tool_result` log records naming a Coredoc tool, which no
 * supported host emits today, so every figure derived from them was structurally empty. The
 * breakdown rows are the same window- and scope-bounded rows the tools list uses, so the
 * adoption call count and the MCP-calls KPI cannot disagree.
 */
export function foldAdoption(
  sessions: PricedSession[],
  mcpRows: McpUserToolRow[],
  breakdown: ToolBreakdownRow[],
): UsageAdoption {
  let totalCalls = 0;
  let weightedErrors = 0;
  let weightedMs = 0;
  for (const row of breakdown) {
    if (row.count <= 0) continue;
    totalCalls += row.count;
    weightedErrors += row.count * row.errorRate;
    weightedMs += row.count * row.avgMs;
  }
  return {
    developersUsingCoredoc: mcpUserKeys(mcpRows).size,
    developersActive: countDevelopers(sessions, mcpRows),
    totalCoredocCalls: totalCalls,
    // No observed call means no observed outcome: a rate over an empty base would assert
    // a perfect (or zero) success rate nobody measured (explicit-degrade ADR, BR-11).
    coredocSuccessRate: totalCalls ? 1 - weightedErrors / totalCalls : null,
    avgCallLatencyMs: totalCalls ? weightedMs / totalCalls : null,
    medianTokensPerSession: median(sessions.map((session) => session.tokensInput + session.tokensOutput)),
  };
}

export interface WorkspaceMemberRow {
  userId: string;
  email: string | null;
  displayName: string | null;
}

export function foldMembers(
  sessions: PricedSession[],
  mcpRows: McpUserToolRow[],
  members: WorkspaceMemberRow[],
): UsageMemberRow[] {
  const rows = new Map<string, UsageMemberRow>();
  for (const session of sessions) {
    const key = sessionUserKey(session);
    const row = rows.get(key) ?? {
      userId: session.userId,
      userEmail: session.userEmail,
      displayName: null,
      sessions: 0,
      tokens: 0,
      estimatedCostUsd: null,
      unpricedSessions: 0,
      coredocCalls: 0,
      topTool: null,
      lastActiveAt: null,
    };
    row.sessions += 1;
    row.tokens += session.tokensInput + session.tokensOutput;
    if (session.estimatedCostUsd !== null) {
      row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + session.estimatedCostUsd;
    } else if (session.usageObserved) {
      row.unpricedSessions += 1;
    }
    const startedAt = session.startedAt.toISOString();
    if (row.lastActiveAt === null || startedAt > row.lastActiveAt) row.lastActiveAt = startedAt;
    rows.set(key, row);
  }

  // Server-observed MCP calls carry only a userId, so they can be attributed
  // to userId-keyed rows alone; an email-keyed row keeps 0 rather than
  // inheriting every unattributed call.
  const callsByUserId = new Map<string, number>();
  const topToolByUserId = new Map<string, { toolName: string; count: number }>();
  for (const row of mcpRows) {
    if (row.userId === null) continue;
    callsByUserId.set(row.userId, (callsByUserId.get(row.userId) ?? 0) + row.count);
    const top = topToolByUserId.get(row.userId);
    if (!top || row.count > top.count) topToolByUserId.set(row.userId, { toolName: row.toolName, count: row.count });
  }

  const memberByUserId = new Map(members.map((member) => [member.userId, member]));
  for (const row of rows.values()) {
    if (row.userId === null) continue;
    row.coredocCalls = callsByUserId.get(row.userId) ?? 0;
    row.topTool = topToolByUserId.get(row.userId)?.toolName ?? null;
    const member = memberByUserId.get(row.userId);
    if (member) {
      row.displayName = member.displayName ?? null;
      row.userEmail = row.userEmail ?? member.email ?? null;
    }
  }

  // A member can call MCP in the window without opening a single non-ghost
  // session (an editor with the MCP server attached and no capture hook).
  // Building rows from sessions alone would drop that member and their calls
  // out of the table entirely, so union the attributable mcp user ids in
  // (same rule as the activity rollup). Session facts are genuinely 0 for such
  // a row, while cost stays null: nothing was priced, and 0.00 would read as
  // measured.
  for (const [userId, calls] of callsByUserId) {
    const key = `id:${userId}`;
    if (calls === 0 || rows.has(key)) continue;
    const member = memberByUserId.get(userId);
    rows.set(key, {
      userId,
      userEmail: member?.email ?? null,
      displayName: member?.displayName ?? null,
      sessions: 0,
      tokens: 0,
      estimatedCostUsd: null,
      unpricedSessions: 0,
      coredocCalls: calls,
      topTool: topToolByUserId.get(userId)?.toolName ?? null,
      lastActiveAt: null,
    });
  }

  return [...rows.values()].sort(
    (left, right) =>
      right.coredocCalls - left.coredocCalls || (left.userEmail ?? '').localeCompare(right.userEmail ?? ''),
  );
}
