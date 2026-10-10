import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { AnalyticsWindowKind, DEFAULT_FEEDBACK_RECORDS_FILTER, FeedbackSort, SortOrder } from '../shared/ipc-types.js';

// Both halves of the records boundary: the request knobs the renderer supplies and
// the page the server answers with. Every collaborator is mocked so nothing reaches
// the network or real IPC.
const { getFeedbackRecordsMock, noopReadMock } = vi.hoisted(() => ({
  getFeedbackRecordsMock: vi.fn(),
  noopReadMock: vi.fn(async () => ({})),
}));

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

vi.mock('./server-api.js', () => ({
  getUsageAnalytics: noopReadMock,
  getFeedbackRecords: getFeedbackRecordsMock,
}));

vi.mock('./build-env.js', () => ({ BUNDLED_COREDOC_WEB_URL: '' }));

const CHANNEL = 'observability:getFeedbackRecords';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const WINDOW = { kind: AnalyticsWindowKind.Days, days: 30 } as const;
const INVALID = 'Invalid observability response';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

async function handler(): Promise<IpcHandler> {
  const { registerObservabilityHandlers } = await import('./observability-manager.js');
  const handlers = new Map<string, IpcHandler>();
  registerObservabilityHandlers({
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain);
  return handlers.get(CHANNEL)!;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

/** A server page that satisfies the whole `FeedbackRecordsPage` contract. */
function validPage(): Record<string, unknown> {
  return {
    items: [
      {
        id: 'fb-1',
        createdAt: '2026-09-08T14:03:22.000Z',
        userId: 'user_alice',
        userEmail: 'alice@example.test',
        sessionId: 'sess-1',
        runId: 'run-1',
        repoKey: 'demo-api',
        overallRating: 4,
        userRating: 2,
        reviewStatus: 'amended',
        summary: 'wrong file for a renamed symbol',
        userNotes: 'cost me twenty minutes',
        perToolIssues: [
          { tool: 'explain', issueType: 'misleading_description', severity: 4, description: 'stale path' },
        ],
        sessionIssues: [
          {
            area: 'skill-instructions',
            issueType: 'confusing',
            severity: 3,
            description: 'read the spec twice',
            skill: 'coredoc-implement',
          },
        ],
        missingCapabilities: [{ need: 'Code-owners lookup' }],
        misleadingMetadata: [{ toolOrAttr: 'find_callers.count', why: 'counts dedupe differently' }],
      },
    ],
    page: 1,
    limit: 25,
    total: 312,
    window: { days: 30, since: '2026-08-10T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z' },
  };
}

describe('feedback records response projection', () => {
  it('projects a well-formed page and fills the server optionals with null', async () => {
    getFeedbackRecordsMock.mockResolvedValue(validPage());

    const response = (await (
      await handler()
    )(null, WORKSPACE, WINDOW, DEFAULT_FEEDBACK_RECORDS_FILTER)) as {
      success: boolean;
      data: { items: Array<Record<string, unknown>>; total: number };
    };

    expect(response.success).toBe(true);
    expect(response.data.total).toBe(312);
    const record = response.data.items[0] as Record<string, unknown>;
    expect((record.perToolIssues as Array<Record<string, unknown>>)[0]?.exampleQuery).toBeNull();
    expect((record.sessionIssues as Array<Record<string, unknown>>)[0]?.stageId).toBeNull();
    expect((record.missingCapabilities as Array<Record<string, unknown>>)[0]?.useCase).toBeNull();
  });

  const malformed: Array<[string, (page: Record<string, unknown>) => void]> = [
    ['a page over the server limit', (page) => (page.limit = 500)],
    [
      'more items than the server may return',
      (page) => {
        page.items = Array.from({ length: 101 }, () => (validPage().items as unknown[])[0]);
      },
    ],
    [
      'an unbounded nested issue list',
      (page) => {
        const record = (page.items as Array<Record<string, unknown>>)[0]!;
        record.sessionIssues = Array.from({ length: 51 }, () => ({
          area: 'capture',
          issueType: 'wrong',
          severity: 1,
          description: 'x',
        }));
      },
    ],
    [
      'a description past the text bound',
      (page) => {
        const record = (page.items as Array<Record<string, unknown>>)[0]!;
        (record.perToolIssues as Array<Record<string, unknown>>)[0]!.description = 'x'.repeat(2001);
      },
    ],
    [
      'a rating outside 1..5',
      (page) => {
        (page.items as Array<Record<string, unknown>>)[0]!.overallRating = 9;
      },
    ],
    [
      'an unknown review status',
      (page) => {
        (page.items as Array<Record<string, unknown>>)[0]!.reviewStatus = 'rubber-stamped';
      },
    ],
    [
      'an unknown session issue area',
      (page) => {
        const record = (page.items as Array<Record<string, unknown>>)[0]!;
        (record.sessionIssues as Array<Record<string, unknown>>)[0]!.area = 'vibes';
      },
    ],
    [
      'a window wider than the selector ceiling',
      (page) => {
        (page.window as Record<string, unknown>).days = 365;
      },
    ],
  ];

  it.each(malformed)('fails the envelope on %s', async (_label, corrupt) => {
    const page = validPage();
    corrupt(page);
    getFeedbackRecordsMock.mockResolvedValue(page);

    const response = await (await handler())(null, WORKSPACE, WINDOW, DEFAULT_FEEDBACK_RECORDS_FILTER);

    expect(response).toEqual({ success: false, error: INVALID });
  });
});

describe('feedback records request validation', () => {
  beforeEach(() => {
    getFeedbackRecordsMock.mockResolvedValue(validPage());
  });

  it('passes a well-formed filter through to the read unchanged', async () => {
    const filter = {
      ...DEFAULT_FEEDBACK_RECORDS_FILTER,
      area: 'capture' as const,
      sort: FeedbackSort.OverallRating,
      order: SortOrder.Asc,
      page: 3,
    };

    await (await handler())(null, WORKSPACE, WINDOW, filter);

    expect(getFeedbackRecordsMock).toHaveBeenCalledWith(WORKSPACE, WINDOW, filter);
  });

  it('drops the retired review, tool and rating knobs instead of forwarding them', async () => {
    await (await handler())(null, WORKSPACE, WINDOW, {
      ...DEFAULT_FEEDBACK_RECORDS_FILTER,
      reviewStatus: 'unreviewed',
      tool: 'explain',
      maxRating: 2,
    });

    expect(getFeedbackRecordsMock).toHaveBeenCalledWith(WORKSPACE, WINDOW, DEFAULT_FEEDBACK_RECORDS_FILTER);
  });

  const rejected: Array<[string, Record<string, unknown>]> = [
    ['an unknown area', { area: 'vibes' }],
    ['an unknown sort column', { sort: 'severity' }],
    ['an unknown order', { order: 'sideways' }],
    ['a page below 1', { page: 0 }],
    ['a fractional page', { page: 1.5 }],
    ['a limit past the server maximum', { limit: 500 }],
    // `mine` is sugar for the caller's own id: answering both would silently pick
    // a scope the user never chose.
    ['both mine and an explicit member', { mine: true, userId: 'user_bob' }],
    ['an empty member id', { userId: '' }],
  ];

  it.each(rejected)('refuses %s without reading the server', async (_label, patch) => {
    const response = await (await handler())(null, WORKSPACE, WINDOW, {
      ...DEFAULT_FEEDBACK_RECORDS_FILTER,
      ...patch,
    });

    expect(response).toEqual({ success: false, error: INVALID });
    expect(getFeedbackRecordsMock).not.toHaveBeenCalled();
  });

  it('refuses a workspace id that is not a UUID', async () => {
    const response = await (await handler())(null, '../admin', WINDOW, DEFAULT_FEEDBACK_RECORDS_FILTER);

    expect(response).toEqual({ success: false, error: INVALID });
    expect(getFeedbackRecordsMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed window', async () => {
    const response = await (await handler())(
      null,
      WORKSPACE,
      { kind: AnalyticsWindowKind.Custom, since: '2026-02-31', until: '2026-03-01' },
      DEFAULT_FEEDBACK_RECORDS_FILTER,
    );

    expect(response).toEqual({ success: false, error: 'Invalid analytics window' });
    expect(getFeedbackRecordsMock).not.toHaveBeenCalled();
  });
});
