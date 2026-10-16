import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { AnalyticsWindowKind } from '../shared/ipc-types.js';

// Mock every collaborator so the manager never touches network or real IPC/IO.
// Only the usage-analytics read matters here; the rest exist because the manager
// imports them at module load.
const { getUsageAnalyticsMock, noopReadMock, openExternalMock } = vi.hoisted(() => ({
  getUsageAnalyticsMock: vi.fn(),
  noopReadMock: vi.fn(async () => ({})),
  openExternalMock: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }));

vi.mock('./server-api.js', () => ({
  getUsageAnalytics: getUsageAnalyticsMock,
  getFeedbackRecords: noopReadMock,
}));

vi.mock('./build-env.js', () => ({ BUNDLED_COREDOC_WEB_URL: '' }));

/** Minimal ipcMain double that records handlers registered against it. */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, IpcHandler> } {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

async function registered() {
  const { registerObservabilityHandlers } = await import('./observability-manager.js');
  const { ipcMain, handlers } = fakeIpcMain();
  registerObservabilityHandlers(ipcMain);
  return handlers;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

/** A server payload that satisfies the whole `WorkspaceUsageAnalytics` contract. */
function validPayload(): Record<string, unknown> {
  return {
    window: {
      days: 30,
      since: '2026-08-04T00:00:00.000Z',
      until: '2026-09-02T11:30:00.000Z',
      previousSince: '2026-07-05T00:00:00.000Z',
    },
    priceMap: { version: '2026-08-16', basis: 'standard-global-public-api-5m-cache-writes' },
    kpis: {
      mcpCalls: { current: 120, previous: 90 },
      sessions: { current: 12, previous: 8 },
      developers: { current: 4, usingCoredoc: 3 },
      spend: { currentUsd: 12.5, previousUsd: null, unpricedSessions: 2, sessionsWithoutUsage: 1 },
    },
    series: {
      mcpCalls: [{ date: '2026-08-04', value: 3 }],
      sessions: [{ date: '2026-08-04', value: 1 }],
      spendUsd: [
        { date: '2026-08-04', value: 1.25, unpricedSessions: 0, sessionsWithoutUsage: 0 },
        { date: '2026-08-05', value: null, unpricedSessions: 2, sessionsWithoutUsage: 1 },
      ],
    },
    tools: [
      { toolName: 'explain', calls: 40, errorRate: 0.05, avgMs: 120, emptyRate: 0.1, classifiedCalls: 30 },
      { toolName: 'find-callers', calls: 10, errorRate: 0, avgMs: 40, emptyRate: null, classifiedCalls: 0 },
    ],
    adoption: {
      developersUsingCoredoc: 3,
      developersActive: 4,
      totalCoredocCalls: 120,
      coredocSuccessRate: 0.95,
      avgCallLatencyMs: 88.5,
      medianTokensPerSession: 41000,
    },
    members: [
      {
        userId: 'user-a',
        userEmail: 'a@example.com',
        displayName: 'Ada',
        sessions: 7,
        tokens: 320000,
        estimatedCostUsd: 8.25,
        unpricedSessions: 1,
        coredocCalls: 100,
        topTool: 'explain',
        lastActiveAt: '2026-09-02T09:15:00.000Z',
      },
    ],
    feedback: {
      feedbackCount: 3,
      topIssues: [{ tool: 'explain', issueType: 'noise', count: 2, severityScore: 5 }],
      topSessionIssues: [{ area: 'skill-instructions', issueType: 'confusing', count: 1, severityScore: 4 }],
      topMissingTools: [{ need: 'diff summariser', count: 1 }],
      ratingTrend: [{ month: '2026-08', avgRating: 4.5, count: 3, avgUserRating: 3.5, userCount: 2 }],
      reviews: { unreviewed: 1, confirmed: 1, amended: 1, avgSelfAssessmentGap: 1, gapCount: 2 },
    },
  };
}

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DAYS_WINDOW = { kind: AnalyticsWindowKind.Days, days: 30 } as const;

async function invokeUsageAnalytics(payload: unknown) {
  getUsageAnalyticsMock.mockResolvedValue(payload);
  const handlers = await registered();
  return handlers.get('observability:getUsageAnalytics')!(null, WORKSPACE_ID, DAYS_WINDOW);
}

describe('usage analytics IPC boundary', () => {
  it('projects a valid usage payload into the renderer contract', async () => {
    const response = await invokeUsageAnalytics(validPayload());

    expect(response).toEqual({ success: true, data: validPayload() });
    expect(getUsageAnalyticsMock).toHaveBeenCalledWith(WORKSPACE_ID, DAYS_WINDOW);
  });

  it('drops fields the contract does not carry', async () => {
    const payload = validPayload();
    (payload.members as Record<string, unknown>[])[0].cloudAuthorization = 'Bearer secret-renderer-sentinel';

    const response = await invokeUsageAnalytics(payload);

    expect(JSON.stringify(response)).not.toContain('secret-renderer-sentinel');
  });

  const malformed: Array<[string, (payload: Record<string, unknown>) => void]> = [
    [
      'a missing field',
      (payload) => {
        delete (payload.kpis as Record<string, unknown>).developers;
      },
    ],
    [
      'a string where a number belongs',
      (payload) => {
        (payload.kpis as { mcpCalls: Record<string, unknown> }).mcpCalls.current = '120';
      },
    ],
    [
      'a negative rate',
      (payload) => {
        (payload.tools as Record<string, unknown>[])[0].errorRate = -0.1;
      },
    ],
    [
      'a rate above one',
      (payload) => {
        (payload.adoption as Record<string, unknown>).coredocSuccessRate = 1.2;
      },
    ],
    [
      'a negative spend',
      (payload) => {
        (payload.kpis as { spend: Record<string, unknown> }).spend.currentUsd = -1;
      },
    ],
    [
      'an oversized tool list',
      (payload) => {
        const row = (payload.tools as unknown[])[0];
        payload.tools = Array.from({ length: 201 }, () => structuredClone(row));
      },
    ],
    [
      'an oversized member list',
      (payload) => {
        const row = (payload.members as unknown[])[0];
        payload.members = Array.from({ length: 501 }, () => structuredClone(row));
      },
    ],
    [
      'an oversized series',
      (payload) => {
        const point = (payload.series as { mcpCalls: unknown[] }).mcpCalls[0];
        (payload.series as Record<string, unknown>).mcpCalls = Array.from({ length: 733 }, () =>
          structuredClone(point),
        );
      },
    ],
    [
      'an oversized feedback list',
      (payload) => {
        const issue = (payload.feedback as { topIssues: unknown[] }).topIssues[0];
        (payload.feedback as Record<string, unknown>).topIssues = Array.from({ length: 101 }, () =>
          structuredClone(issue),
        );
      },
    ],
    [
      'a bad timestamp',
      (payload) => {
        (payload.window as Record<string, unknown>).since = '2026-02-30T00:00:00.000Z';
      },
    ],
    [
      'a timestamp where a day bucket belongs',
      (payload) => {
        (payload.series as { mcpCalls: Record<string, unknown>[] }).mcpCalls[0].date = '2026-08-04T00:00:00.000Z';
      },
    ],
    [
      'an unknown feedback issue type',
      (payload) => {
        (payload.feedback as { topIssues: Record<string, unknown>[] }).topIssues[0].issueType = 'confusing';
      },
    ],
    [
      'an unknown session issue area',
      (payload) => {
        (payload.feedback as { topSessionIssues: Record<string, unknown>[] }).topSessionIssues[0].area = 'vibes';
      },
    ],
    [
      'a self-assessment gap outside the rating range',
      (payload) => {
        (payload.feedback as { reviews: Record<string, unknown> }).reviews.avgSelfAssessmentGap = 7;
      },
    ],
    [
      'a window wider than the selector ceiling',
      (payload) => {
        (payload.window as Record<string, unknown>).days = 365;
      },
    ],
  ];

  it.each(malformed)('fails the envelope on %s (AC-13)', async (_label, corrupt) => {
    const payload = validPayload();
    corrupt(payload);

    const response = await invokeUsageAnalytics(payload);

    expect(response).toEqual({ success: false, error: 'Invalid observability response' });
  });

  it('refuses a workspace id that is not a UUID without reading the server', async () => {
    const handlers = await registered();

    const response = await handlers.get('observability:getUsageAnalytics')!(null, '../admin', 30);

    expect(response).toEqual({ success: false, error: 'Invalid observability response' });
    expect(getUsageAnalyticsMock).not.toHaveBeenCalled();
  });

  // The session-scope feedback fields are newer than the desktop's oldest
  // supported server; their absence is a version skew, not a hostile payload.
  it('projects a pre-session-scope feedback payload with empty defaults', async () => {
    const { projectUsageAnalytics } = await import('./observability-manager.js');
    const payload = validPayload();
    const feedback = payload.feedback as Record<string, unknown>;
    delete feedback.topSessionIssues;
    delete feedback.reviews;
    feedback.ratingTrend = [{ month: '2026-08', avgRating: 4.5, count: 3 }];

    const projected = projectUsageAnalytics(payload);
    expect(projected.feedback.topSessionIssues).toEqual([]);
    expect(projected.feedback.reviews).toEqual({
      unreviewed: 0,
      confirmed: 0,
      amended: 0,
      avgSelfAssessmentGap: null,
      gapCount: 0,
    });
    expect(projected.feedback.ratingTrend).toEqual([
      { month: '2026-08', avgRating: 4.5, count: 3, avgUserRating: null, userCount: 0 },
    ]);
  });

  it('keeps a month with no agent self-rating as null rather than a zero', async () => {
    const { projectUsageAnalytics } = await import('./observability-manager.js');
    const payload = validPayload();
    (payload.feedback as Record<string, unknown>).ratingTrend = [
      { month: '2026-08', avgRating: null, count: 0, avgUserRating: 3.5, userCount: 2 },
    ];

    const projected = projectUsageAnalytics(payload);

    expect(projected.feedback.ratingTrend).toEqual([
      { month: '2026-08', avgRating: null, count: 0, avgUserRating: 3.5, userCount: 2 },
    ]);
  });

  it('throws a TypeError from the projector itself, not a plain Error', async () => {
    const { projectUsageAnalytics } = await import('./observability-manager.js');
    const payload = validPayload();
    delete payload.adoption;

    expect(() => projectUsageAnalytics(payload)).toThrow(TypeError);
  });
});
