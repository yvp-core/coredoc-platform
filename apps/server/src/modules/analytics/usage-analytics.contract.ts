import type { TimeseriesPoint } from '../metrics/metrics.service.js';
import type { RoadmapView } from '../feedback/feedback.types.js';

/**
 * Wire contract for `GET workspaces/:id/analytics/usage` — the single
 * server-aggregated read behind the desktop Analytics "Usage" view. Mirrored
 * 1:1 in `apps/desktop/src/shared/ipc-types.ts`.
 */

/**
 * LIM-4: the largest day selector value; caps the window in days every analytics read may span.
 * Defined with the window parser in `libs/analytics-window.ts` (a leaf must not import a feature
 * module) and re-exported here so the contract stays the one place analytics consumers read.
 */
export { MAX_ANALYTICS_DAYS } from '../../libs/analytics-window.js';

/** BR-16: one UTC-day-aligned window basis shared by every composed read. */
export interface UsageWindow {
  days: number;
  since: string;
  until: string;
  previousSince: string;
}

export interface UsageCounter {
  current: number;
  previous: number;
}

export interface UsageSpend {
  currentUsd: number | null;
  previousUsd: number | null;
  unpricedSessions: number;
  sessionsWithoutUsage: number;
}

export interface UsageDevelopers {
  current: number;
  usingCoredoc: number;
}

export interface UsageToolRow {
  toolName: string;
  calls: number;
  errorRate: number;
  avgMs: number;
  /** null when no classified (result_count IS NOT NULL) calls exist for the tool */
  emptyRate: number | null;
  classifiedCalls: number;
}

/**
 * BR-3/BR-4: every Coredoc figure is server-observed (`mcp_query_metrics`, `rest:%` excluded);
 * only the token median comes from host session telemetry. The per-session
 * `coredocToolCalls` / `coredocToolStats` columns are deliberately not a source: they are
 * written only from host OTel `tool_result` records naming a Coredoc tool, which no supported
 * host emits, so a session-based adoption rate was structurally empty rather than low.
 */
export interface UsageAdoption {
  /** Distinct attributable `user_id`s with at least one MCP call in the window. */
  developersUsingCoredoc: number;
  /** Distinct session owners unioned with the attributable MCP callers. */
  developersActive: number;
  totalCoredocCalls: number;
  /** null when the window observed no call at all — an unmeasured rate, not a perfect one. */
  coredocSuccessRate: number | null;
  avgCallLatencyMs: number | null;
  medianTokensPerSession: number | null;
}

export interface UsageMemberRow {
  userId: string | null;
  userEmail: string | null;
  displayName: string | null;
  sessions: number;
  tokens: number;
  estimatedCostUsd: number | null;
  unpricedSessions: number;
  coredocCalls: number;
  topTool: string | null;
  lastActiveAt: string | null;
}

/**
 * BR-17: `value` is null (never 0) for a day with sessions but no priced spend —
 * either because a session ran on a model the price map does not cover
 * (`unpricedSessions`) or because a session carried no usable token data at all
 * (`sessionsWithoutUsage`). A day with no session whatsoever is a real 0.
 */
export interface SpendPoint {
  date: string;
  value: number | null;
  unpricedSessions: number;
  sessionsWithoutUsage: number;
}

export interface WorkspaceUsageAnalytics {
  window: UsageWindow;
  priceMap: { version: string; basis: string };
  kpis: {
    mcpCalls: UsageCounter;
    sessions: UsageCounter;
    developers: UsageDevelopers;
    spend: UsageSpend;
  };
  /** current window only, one point per UTC day, oldest first, zero-filled (spend: BR-17) */
  series: {
    mcpCalls: TimeseriesPoint[];
    sessions: TimeseriesPoint[];
    spendUsd: SpendPoint[];
  };
  /** ordered by calls desc */
  tools: UsageToolRow[];
  adoption: UsageAdoption;
  /** ordered by coredocCalls desc, then email */
  members: UsageMemberRow[];
  feedback: RoadmapView;
}
