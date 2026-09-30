/**
 * One realistic `WorkspaceUsageAnalytics` shared by the Usage tests. Built to
 * fail the interesting regressions rather than to look tidy:
 *
 * - `sessions.previous = 0` so the "no prior data" branch is exercised beside a
 *   real delta (BR-2);
 * - `spend.currentUsd = null` with unpriced counters, so a `$0.00` anywhere is a
 *   bug, not a rounding choice (BR-1, LIM-1);
 * - one spend day `null` (all its sessions unpriced) beside a `0` day, so the
 *   two are distinguishable (BR-17);
 * - a tool with `emptyRate: null` / `classifiedCalls: 0` (AC-3);
 * - `withoutCoredoc.medianCostUsd = null` so no comparison can be computed;
 * - members deliberately supplied in ascending Coredoc-call order, so a missing
 *   default sort is visible in the rendered order.
 */

import type { WorkspaceUsageAnalytics } from '../../../../shared/ipc-types.js';

export const USAGE_FIXTURE: WorkspaceUsageAnalytics = {
  window: {
    days: 30,
    since: '2026-08-03T00:00:00.000Z',
    until: '2026-09-01T12:00:00.000Z',
    previousSince: '2026-07-04T00:00:00.000Z',
  },
  priceMap: { version: '2026-08-01', basis: 'per-million-tokens' },
  kpis: {
    mcpCalls: { current: 1240, previous: 980 },
    sessions: { current: 86, previous: 0 },
    developers: { current: 6, usingCoredoc: 4 },
    spend: { currentUsd: null, previousUsd: null, unpricedSessions: 3, sessionsWithoutUsage: 2 },
  },
  series: {
    mcpCalls: [
      { date: '2026-08-30', value: 40 },
      { date: '2026-08-31', value: 52 },
      { date: '2026-09-01', value: 61 },
    ],
    sessions: [
      { date: '2026-08-30', value: 3 },
      { date: '2026-08-31', value: 5 },
      { date: '2026-09-01', value: 4 },
    ],
    spendUsd: [
      { date: '2026-08-30', value: 12.5, unpricedSessions: 0, sessionsWithoutUsage: 0 },
      { date: '2026-08-31', value: null, unpricedSessions: 3, sessionsWithoutUsage: 0 },
      { date: '2026-09-01', value: 0, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    ],
  },
  tools: [
    { toolName: 'explain', calls: 420, errorRate: 0.012, avgMs: 180, emptyRate: 0.04, classifiedCalls: 400 },
    { toolName: 'search_symbols', calls: 210, errorRate: 0.061, avgMs: 95, emptyRate: 0.22, classifiedCalls: 200 },
    // No classified calls: there is no empty rate to state, so no "empty" pill.
    { toolName: 'find_callers', calls: 60, errorRate: 0.0, avgMs: 44, emptyRate: null, classifiedCalls: 0 },
  ],
  adoption: {
    developersUsingCoredoc: 4,
    developersActive: 6,
    totalCoredocCalls: 1240,
    coredocSuccessRate: 0.974,
    avgCallLatencyMs: 132.4,
    medianTokensPerSession: 84_000,
  },
  members: [
    {
      userId: 'u-3',
      userEmail: 'carol@example.com',
      displayName: 'Carol Diaz',
      sessions: 4,
      tokens: 12_000,
      estimatedCostUsd: null,
      unpricedSessions: 4,
      coredocCalls: 0,
      topTool: null,
      lastActiveAt: '2026-08-25T09:00:00.000Z',
    },
    {
      userId: 'u-2',
      userEmail: 'bob@example.com',
      displayName: 'Bob Smith',
      sessions: 21,
      tokens: 640_000,
      estimatedCostUsd: 18.4,
      unpricedSessions: 0,
      coredocCalls: 310,
      topTool: 'search_symbols',
      lastActiveAt: '2026-08-31T18:00:00.000Z',
    },
    {
      userId: 'u-1',
      userEmail: 'alice@example.com',
      displayName: 'Alice Nowak',
      sessions: 33,
      tokens: 1_020_000,
      estimatedCostUsd: 42.75,
      unpricedSessions: 1,
      coredocCalls: 780,
      topTool: 'explain',
      lastActiveAt: '2026-09-01T08:00:00.000Z',
    },
  ],
  feedback: {
    feedbackCount: 27,
    topIssues: [
      { tool: 'explain', issueType: 'incomplete', count: 14, severityScore: 38 },
      { tool: 'search_symbols', issueType: 'misleading_description', count: 4, severityScore: 12 },
    ],
    topSessionIssues: [
      { area: 'skill-instructions', issueType: 'confusing', count: 6, severityScore: 21 },
      { area: 'task-context', issueType: 'missing_context', count: 3, severityScore: 9 },
    ],
    topMissingTools: [
      { need: 'Diff-aware impact for uncommitted changes', count: 9 },
      { need: 'Code-owners lookup', count: 5 },
    ],
    ratingTrend: [
      { month: 'Jul', avgRating: 3.9, count: 8, avgUserRating: null, userCount: 0 },
      { month: 'Aug', avgRating: 4.2, count: 11, avgUserRating: 3.4, userCount: 5 },
    ],
    reviews: { unreviewed: 22, confirmed: 2, amended: 3, avgSelfAssessmentGap: 0.8, gapCount: 5 },
  },
};

/** Server "now" for the window — the relative member labels are computed against it. */
export const USAGE_FIXTURE_NOW = new Date(USAGE_FIXTURE.window.until);
