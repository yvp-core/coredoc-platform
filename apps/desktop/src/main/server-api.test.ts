import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport `apiRequest` depends on — the auth token source and the
// server URL — plus global fetch, so no real IPC/network runs.
const { getValidTokensMock, getConfiguredServerUrlMock } = vi.hoisted(() => ({
  getValidTokensMock: vi.fn(),
  getConfiguredServerUrlMock: vi.fn(() => 'https://api.example'),
}));

vi.mock('./auth-manager.js', () => ({ getValidTokens: getValidTokensMock }));
vi.mock('./server-url.js', () => ({
  getConfiguredServerUrl: getConfiguredServerUrlMock,
  setServerUrl: vi.fn(),
}));

describe('apiRequest authorization', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no bearer when auth-manager reports no usable credentials', async () => {
    // The credential store refuses tokens issued by a server other than the
    // resolved (managed-pinned) one, so this is the migrated-fleet case: the
    // previous server's bearer must never reach the new host.
    getValidTokensMock.mockResolvedValue(null);
    const api = await import('./server-api.js');

    await api.getServerMeta();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.example/api/v1/meta');
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe('canonical delivery read wrappers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getValidTokensMock.mockResolvedValue({ accessToken: 'jwt-canonical' });
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the JWT-only canonical task timeline', async () => {
    const api = await import('./server-api.js');

    await api.getCanonicalDeliveryTasks('ws-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.example/api/v1/workspaces/ws-1/delivery/v2/tasks');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-canonical');
    expect(init.body).toBeUndefined();
  });

  it('GETs a bounded canonical task-summary page without changing the legacy task route', async () => {
    const api = await import('./server-api.js');
    const workspaceId = 'workspace/id?probe=1';
    const encodedWorkspaceId = encodeURIComponent(workspaceId);

    await api.getCanonicalTaskSummaries(workspaceId, 50, 'eyJ2IjoxLCJzY29wZSI6InRhc2tzIn0');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/task-summaries?limit=50&cursor=eyJ2IjoxLCJzY29wZSI6InRhc2tzIn0`,
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-canonical');
    expect(init.body).toBeUndefined();
  });

  it('carries the analytics window and the member scope on the three analytics reads', async () => {
    const api = await import('./server-api.js');
    const { AnalyticsWindowKind } = await import('../shared/ipc-types.js');
    const days = { kind: AnalyticsWindowKind.Days, days: 30 } as const;
    const custom = { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' } as const;

    await api.getUsageAnalytics('ws-1', days);
    await api.getUsageAnalytics('ws-1', custom);
    await api.getDeliverySummary('ws-1', days, 'all', false, null);
    await api.getDeliverySummary('ws-1', custom, 'shipped', true, null);
    await api.getDeliverySummary('ws-1', days, 'all', false, 'user_42');
    await api.getCanonicalTaskSummaries('ws-1', 50, undefined, custom, 'rework', true);
    await api.getCanonicalTaskSummaries('ws-1', 50, undefined, days, 'all', false);
    await api.getCanonicalTaskSummaries('ws-1', 50, undefined, days, 'all', false, 'user_42');

    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual([
      'https://api.example/api/v1/workspaces/ws-1/analytics/usage?days=30',
      'https://api.example/api/v1/workspaces/ws-1/analytics/usage?since=2026-08-01&until=2026-08-14',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/summary?days=30&lifecycle=all',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/summary?since=2026-08-01&until=2026-08-14&lifecycle=shipped&mine=true',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/summary?days=30&lifecycle=all&userId=user_42',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/task-summaries?limit=50&since=2026-08-01&until=2026-08-14&lifecycle=rework&mine=true',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/task-summaries?limit=50&days=30&lifecycle=all',
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/task-summaries?limit=50&days=30&lifecycle=all&userId=user_42',
    ]);
  });

  it('composes the feedback records URL from the window and only the filters that are set', async () => {
    const api = await import('./server-api.js');
    const { AnalyticsWindowKind, DEFAULT_FEEDBACK_RECORDS_FILTER, FeedbackSort, SortOrder } = await import(
      '../shared/ipc-types.js'
    );
    const days = { kind: AnalyticsWindowKind.Days, days: 30 } as const;
    const custom = { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' } as const;

    await api.getFeedbackRecords('ws-1', days, DEFAULT_FEEDBACK_RECORDS_FILTER);
    await api.getFeedbackRecords('ws-1', custom, {
      ...DEFAULT_FEEDBACK_RECORDS_FILTER,
      area: 'capture',
      sort: FeedbackSort.OverallRating,
      order: SortOrder.Asc,
      page: 3,
    });
    await api.getFeedbackRecords('ws-1', days, { ...DEFAULT_FEEDBACK_RECORDS_FILTER, mine: true });
    await api.getFeedbackRecords('ws-1', days, { ...DEFAULT_FEEDBACK_RECORDS_FILTER, userId: 'user_42' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/api/v1/workspaces/ws-1/mcp-feedback/records?days=30&page=1&limit=25&sort=createdAt&order=desc',
      'https://api.example/api/v1/workspaces/ws-1/mcp-feedback/records?since=2026-08-01&until=2026-08-14&page=3&limit=25&sort=overallRating&order=asc&area=capture',
      'https://api.example/api/v1/workspaces/ws-1/mcp-feedback/records?days=30&page=1&limit=25&sort=createdAt&order=desc&mine=true',
      'https://api.example/api/v1/workspaces/ws-1/mcp-feedback/records?days=30&page=1&limit=25&sort=createdAt&order=desc&userId=user_42',
    ]);
  });

  it('GETs scalar task detail and every independently paged canonical fact route', async () => {
    const api = await import('./server-api.js');
    const workspaceId = 'workspace/id?probe=1';
    const encodedWorkspaceId = encodeURIComponent(workspaceId);
    const taskId = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const runId = 'cdr-20260816-a1b2c3';

    await api.getCanonicalTaskDetail(workspaceId, taskId);
    await api.getCanonicalTaskExternalRefs(workspaceId, taskId, 25);
    await api.getCanonicalExternalRefStateHistory(workspaceId, taskId, '42', 25, 'next/ref');
    await api.getCanonicalTaskRuns(workspaceId, taskId, 25);
    await api.getCanonicalRunStageOccurrences(workspaceId, taskId, runId, 25, 'next/stage');
    await api.getCanonicalTaskCodeChanges(workspaceId, taskId, 25);
    await api.getCanonicalTaskShipEvidence(workspaceId, taskId, 25);
    await api.getCanonicalTaskReworkSignals(workspaceId, taskId, 25);
    await api.getCanonicalTaskArtifacts(workspaceId, taskId, 25);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/external-refs?limit=25`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/external-refs/42/state-history?limit=25&cursor=next%2Fref`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/runs?limit=25`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/runs/${runId}/stage-occurrences?limit=25&cursor=next%2Fstage`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/code-changes?limit=25`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/ship-evidence?limit=25`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/rework-signals?limit=25`,
      `https://api.example/api/v1/workspaces/${encodedWorkspaceId}/delivery/v2/tasks/${taskId}/artifacts?limit=25`,
    ]);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit & { headers: Record<string, string> }]>) {
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer jwt-canonical');
      expect(init.body).toBeUndefined();
    }
  });

  it('GETs one explicitly expanded artifact with an encoded canonical id', async () => {
    const api = await import('./server-api.js');

    await api.getCanonicalArtifactRevisions('ws-1', 'cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(
      'https://api.example/api/v1/workspaces/ws-1/delivery/v2/artifacts/cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revisions',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-canonical');
  });
});

describe('invitation wrappers', () => {
  it('POSTs the workspace-scoped resend endpoint', async () => {
    getValidTokensMock.mockResolvedValue({ accessToken: 'jwt-abc' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ resent: true, emailSent: true, expiresAt: '2026-08-20T00:00:00Z', signInUrl: '/login' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resendInvite } = await import('./server-api.js');

    await resendInvite('ws-1', 'invite-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/api/v1/workspaces/ws-1/members/invites/invite-1/resend',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });
});

describe('feedback read wrappers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getValidTokensMock.mockResolvedValue({ accessToken: 'jwt-abc' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getFeedbackRoadmap GETs the mcp-feedback/roadmap path with `days`', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ feedbackCount: 0, topIssues: [], topMissingTools: [], ratingTrend: [] }),
    });
    const { getFeedbackRoadmap } = await import('./server-api.js');

    await getFeedbackRoadmap('ws-1', 30);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/api/v1/workspaces/ws-1/mcp-feedback/roadmap?days=30');
  });

  it('getFeedbackCorrelation GETs the mcp-feedback/correlation path with `days`', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const { getFeedbackCorrelation } = await import('./server-api.js');

    await getFeedbackCorrelation('ws-1', 7);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example/api/v1/workspaces/ws-1/mcp-feedback/correlation?days=7',
    );
  });
});

describe('intent context read wire shape', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getValidTokensMock.mockResolvedValue({ accessToken: 'jwt-intent' });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ matches: [] }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const urlOf = (): string => (fetchMock.mock.calls[0] as [string, RequestInit])[0];

  it('forwards production, source and search filters without dropping pagination', async () => {
    const api = await import('./server-api.js');
    await api.listIntentItems('ws/scope', {
      production: 'true',
      effectivity: 'planned',
      sourceKind: 'spec',
      sourceRef: 'spec/uploads?x=1',
      search: 'upload limits',
      authorities: 'accepted,superseded',
      kinds: 'business_rule',
      scopeFeatureId: 'uploads',
      limit: 200,
    });
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/api/v1/workspaces/ws%2Fscope/intent/items');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      production: 'true',
      effectivity: 'planned',
      sourceRef: 'spec/uploads?x=1',
      search: 'upload limits',
      limit: '200',
    });
  });
  it('searches source references using the scoped read endpoint', async () => {
    const api = await import('./server-api.js');
    await api.listIntentSources('ws/scope', 'Upload & validation');
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/api/v1/workspaces/ws%2Fscope/intent/sources');
    expect(url.searchParams.get('search')).toBe('Upload & validation');
  });
  it('sends the pinned delivery request unchanged with encoded workspace scope', async () => {
    const api = await import('./server-api.js');
    const body = {
      idempotencyKey: 'qa-release',
      expectedHeadSeq: 4,
      reason: 'Deployed',
      kind: 'release' as const,
      deliveredRef: 'deploy-b',
      included: [{ itemId: 'br-b', contentHash: 'a'.repeat(64) }],
      retired: ['br-a'],
    };
    await api.recordIntentRelease('ws/scope', 'release', body);
    expect(new URL(urlOf()).pathname).toBe('/api/v1/workspaces/ws%2Fscope/intent/releases');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
  });

  it('does not let an unknown release action become an arbitrary REST path', async () => {
    const api = await import('./server-api.js');
    expect(() =>
      api.recordIntentRelease('ws-1', 'delete' as never, { idempotencyKey: 'qa', expectedHeadSeq: 0, reason: 'test' }),
    ).toThrow('Unsupported intent release action');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repeats `observed` once per repo rather than collapsing it to one value', async () => {
    // `intentQuery` uses `params.set`, which OVERWRITES: the observed list only
    // survives because it is appended separately, once per repo.
    const api = await import('./server-api.js');

    await api.getIntentContext('ws-1', { observed: ['acme/api@abc1234', 'web@def5678:dirty'] });

    const query = new URL(urlOf()).searchParams;
    expect(query.getAll('observed')).toEqual(['acme/api@abc1234', 'web@def5678:dirty']);
  });

  it('never serializes `refresh` — it is the desktop main process talking to itself', async () => {
    const api = await import('./server-api.js');

    await api.getIntentContext('ws-1', { refresh: true, intentIds: ['i-1'], limit: 5 });

    const url = urlOf();
    expect(url).not.toContain('refresh');
    const query = new URL(url).searchParams;
    expect(query.getAll('intentIds')).toEqual(['i-1']);
    expect(query.get('limit')).toBe('5');
    expect(query.get('mode')).toBe('context');
  });

  it('sends no observed parameter when the caller has nothing to observe', async () => {
    const api = await import('./server-api.js');

    await api.getIntentContext('ws-1', { intentIds: ['i-1'] });

    expect(urlOf()).not.toContain('observed');
  });
});
