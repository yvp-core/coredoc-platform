import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { AnalyticsWindowKind } from '../shared/ipc-types.js';

// Mock the transport so no real network runs. Only the summary, task-summaries
// and code-change reads matter here; the rest exist because the manager imports
// them at module load.
const {
  getDeliverySummaryMock,
  getCanonicalTaskSummariesMock,
  getCanonicalTaskCodeChangesMock,
  noopReadMock,
  openExternalMock,
  ApiErrorClass,
} = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    getDeliverySummaryMock: vi.fn(),
    getCanonicalTaskSummariesMock: vi.fn(),
    getCanonicalTaskCodeChangesMock: vi.fn(),
    noopReadMock: vi.fn(async () => ({})),
    openExternalMock: vi.fn(async () => undefined),
    ApiErrorClass: ApiError,
  };
});

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }));

vi.mock('./server-api.js', () => ({
  ApiError: ApiErrorClass,
  getDeliverySummary: getDeliverySummaryMock,
  getCanonicalTaskSummaries: getCanonicalTaskSummariesMock,
  getCanonicalTaskCodeChanges: getCanonicalTaskCodeChangesMock,
  getCanonicalDeliveryTasks: noopReadMock,
  getCanonicalTaskDetail: noopReadMock,
  getCanonicalTaskExternalRefs: noopReadMock,
  getCanonicalExternalRefStateHistory: noopReadMock,
  getCanonicalTaskRuns: noopReadMock,
  getCanonicalRunStageOccurrences: noopReadMock,
  getCanonicalTaskShipEvidence: noopReadMock,
  getCanonicalTaskReworkSignals: noopReadMock,
  getCanonicalTaskArtifacts: noopReadMock,
  getCanonicalArtifactRevisions: noopReadMock,
}));

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
  const { registerDeliveryHandlers } = await import('./delivery-manager.js');
  const { ipcMain, handlers } = fakeIpcMain();
  registerDeliveryHandlers(ipcMain);
  return handlers;
}

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

/** A server payload that satisfies the whole `CanonicalDeliverySummary` contract. */
function validSummary(): Record<string, unknown> {
  return {
    window: {
      days: 30,
      since: '2026-08-04T00:00:00.000Z',
      until: '2026-09-03T00:00:00.000Z',
      lifecycle: 'shipped',
      userId: null,
    },
    tasks: { matching: 12, shipped: 7, partiallyShipped: 2, withRework: 3, active: 4 },
    leadTimeMs: { value: 172800000, sampleSize: 7 },
    reviewStageMs: { value: 3600000, sampleSize: 5 },
    costPerShippedTaskUsd: { value: 4.25, sampleSize: 6, unpricedTasks: 1 },
    stages: [
      { stageId: 'spec', claimedMs: { value: 900000, sampleSize: 6 }, incomplete: 0, inProgress: 0 },
      { stageId: 'review', claimedMs: { value: null, sampleSize: 0 }, incomplete: 2, inProgress: 1 },
    ],
    unclaimedMs: { value: 7200000, sampleSize: 7 },
    reviewWaitMs: { value: 1800000, sampleSize: 4 },
    editVerifyRoundsPerRun: { value: 2, sampleSize: 9 },
    rework: {
      bySource: [
        { kind: 'tracker_reopened', signals: 1, tasks: 1 },
        { kind: 'review_changes_requested', signals: 3, tasks: 2 },
        { kind: 'review_commented', signals: 0, tasks: 0 },
      ],
    },
  };
}

const daysWindow = (days: number) => ({ kind: AnalyticsWindowKind.Days, days });

async function invokeSummary(
  payload: unknown,
  window: unknown = daysWindow(30),
  lifecycle: unknown = 'shipped',
  mine: unknown = false,
  userId: unknown = null,
) {
  getDeliverySummaryMock.mockResolvedValue(payload);
  const handlers = await registered();
  return handlers.get('delivery:getCanonicalSummary')!(null, WORKSPACE_ID, window, lifecycle, mine, userId);
}

describe('delivery summary IPC boundary', () => {
  it('projects a valid summary into the renderer contract', async () => {
    const response = await invokeSummary(validSummary());

    expect(response).toEqual({ success: true, data: validSummary() });
    expect(getDeliverySummaryMock).toHaveBeenCalledWith(WORKSPACE_ID, daysWindow(30), 'shipped', false, null);
  });

  it('drops fields the contract does not carry', async () => {
    const payload = validSummary();
    payload.internalQuery = 'secret-renderer-sentinel';

    const response = await invokeSummary(payload);

    expect(JSON.stringify(response)).not.toContain('secret-renderer-sentinel');
  });

  const malformed: Array<[string, (payload: Record<string, unknown>) => void]> = [
    [
      'a missing field',
      (payload) => {
        delete (payload.tasks as Record<string, unknown>).withRework;
      },
    ],
    [
      'a string where a number belongs',
      (payload) => {
        (payload.leadTimeMs as Record<string, unknown>).value = '172800000';
      },
    ],
    [
      'a fractional sample size',
      (payload) => {
        (payload.reviewWaitMs as Record<string, unknown>).sampleSize = 4.5;
      },
    ],
    [
      'a negative median',
      (payload) => {
        (payload.unclaimedMs as Record<string, unknown>).value = -1;
      },
    ],
    [
      'an oversized stage list',
      (payload) => {
        const stage = (payload.stages as unknown[])[0];
        payload.stages = Array.from({ length: 65 }, () => structuredClone(stage));
      },
    ],
    [
      'an oversized rework list',
      (payload) => {
        const source = (payload.rework as { bySource: unknown[] }).bySource[0];
        (payload.rework as Record<string, unknown>).bySource = Array.from({ length: 4 }, () => structuredClone(source));
      },
    ],
    [
      'an unknown rework source',
      (payload) => {
        ((payload.rework as { bySource: Record<string, unknown>[] }).bySource[0] as Record<string, unknown>).kind =
          'stage_reentry';
      },
    ],
    [
      'an oversized member id on the window',
      (payload) => {
        (payload.window as Record<string, unknown>).userId = 'u'.repeat(257);
      },
    ],
    [
      'a bad timestamp',
      (payload) => {
        (payload.window as Record<string, unknown>).since = '2026-02-30T00:00:00.000Z';
      },
    ],
    [
      'an unknown lifecycle',
      (payload) => {
        (payload.window as Record<string, unknown>).lifecycle = 'stalled';
      },
    ],
    [
      'an unbounded stage id',
      (payload) => {
        (payload.stages as Record<string, unknown>[])[0].stageId = 'x'.repeat(200);
      },
    ],
    [
      'a negative stage incomplete count',
      (payload) => {
        (payload.stages as Record<string, unknown>[])[0].incomplete = -1;
      },
    ],
    [
      'a non-numeric stage in-progress count',
      (payload) => {
        (payload.stages as Record<string, unknown>[])[0].inProgress = '3';
      },
    ],
  ];

  it.each(malformed)('fails the envelope on %s (AC-13)', async (_label, corrupt) => {
    const payload = validSummary();
    corrupt(payload);

    const response = await invokeSummary(payload);

    expect(response).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });

  it.each([
    ['an out-of-range window', daysWindow(0), 'all', false, null],
    ['a fractional window', daysWindow(1.5), 'all', false, null],
    ['a window past the ceiling', daysWindow(91), 'all', false, null],
    ['a bare day count instead of a window', 30, 'all', false, null],
    [
      'a custom range with reversed dates',
      { kind: 'custom', since: '2026-08-10', until: '2026-08-01' },
      'all',
      false,
      null,
    ],
    [
      'a custom range wider than the ceiling',
      { kind: 'custom', since: '2026-01-01', until: '2026-12-31' },
      'all',
      false,
      null,
    ],
    [
      'a custom range with a malformed date',
      { kind: 'custom', since: '2026-8-1', until: '2026-08-10' },
      'all',
      false,
      null,
    ],
    ['an unknown lifecycle filter', daysWindow(30), 'stalled', false, null],
    ['a non-boolean self-scope', daysWindow(30), 'all', 'yes', null],
    // `mine` is sugar for the caller's own id; both together means the renderer
    // does not know which scope it is asking for.
    ['both self-scope and a member id', daysWindow(30), 'all', true, 'user_42'],
    ['an empty member id', daysWindow(30), 'all', false, ''],
    ['an oversized member id', daysWindow(30), 'all', false, 'u'.repeat(257)],
    ['a non-string member id', daysWindow(30), 'all', false, 42],
  ])('refuses %s before calling the server', async (_label, window, lifecycle, mine, userId) => {
    const response = await invokeSummary(validSummary(), window, lifecycle, mine, userId);

    expect(response).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
    expect(getDeliverySummaryMock).not.toHaveBeenCalled();
  });

  it('accepts a valid custom range', async () => {
    const response = await invokeSummary(validSummary(), { kind: 'custom', since: '2026-08-01', until: '2026-08-14' });

    expect(response).toEqual({ success: true, data: validSummary() });
    expect(getDeliverySummaryMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' },
      'shipped',
      false,
      null,
    );
  });

  it('projects a v1-shaped summary from a server that predates the widenings', async () => {
    const payload = validSummary();
    const window = payload.window as Record<string, unknown>;
    delete window.until;
    delete window.userId;
    delete (payload.tasks as Record<string, unknown>).partiallyShipped;
    delete payload.rework;
    for (const stage of payload.stages as Record<string, unknown>[]) {
      delete stage.incomplete;
      delete stage.inProgress;
    }

    const response = await invokeSummary(payload);

    expect(response).toMatchObject({
      success: true,
      data: {
        window: { since: '2026-08-04T00:00:00.000Z', until: '2026-08-04T00:00:00.000Z', userId: null },
        tasks: { partiallyShipped: 0 },
        stages: [
          { stageId: 'spec', incomplete: 0, inProgress: 0 },
          { stageId: 'review', incomplete: 0, inProgress: 0 },
        ],
        rework: {
          bySource: [
            { kind: 'tracker_reopened', signals: 0, tasks: 0 },
            { kind: 'review_changes_requested', signals: 0, tasks: 0 },
            { kind: 'review_commented', signals: 0, tasks: 0 },
          ],
        },
      },
    });
  });

  it('degrades null stage counts to zero, like the absent ones', async () => {
    const payload = validSummary();
    for (const stage of payload.stages as Record<string, unknown>[]) {
      stage.incomplete = null;
      stage.inProgress = null;
    }

    const response = await invokeSummary(payload);

    expect(response).toMatchObject({
      success: true,
      data: {
        stages: [
          { stageId: 'spec', incomplete: 0, inProgress: 0 },
          { stageId: 'review', incomplete: 0, inProgress: 0 },
        ],
      },
    });
  });

  it('passes a member id through and projects the resolved scope back', async () => {
    const payload = validSummary();
    (payload.window as Record<string, unknown>).userId = 'user_42';

    const response = await invokeSummary(payload, daysWindow(30), 'all', false, 'user_42');

    expect(response).toEqual({ success: true, data: payload });
    expect(getDeliverySummaryMock).toHaveBeenCalledWith(WORKSPACE_ID, daysWindow(30), 'all', false, 'user_42');
  });
});

describe('task summaries filter arguments', () => {
  const emptyPage = { tasks: [], nextCursor: null };

  async function invokeSummaries(...args: unknown[]) {
    getCanonicalTaskSummariesMock.mockResolvedValue(emptyPage);
    const handlers = await registered();
    return handlers.get('delivery:getCanonicalTaskSummaries')!(null, WORKSPACE_ID, ...args);
  }

  it('omits the filter when the renderer does not supply one', async () => {
    const response = await invokeSummaries(25);

    expect(response).toEqual({ success: true, data: emptyPage });
    expect(getCanonicalTaskSummariesMock).toHaveBeenCalledWith(WORKSPACE_ID, 25, undefined);
  });

  it('passes a supplied window, lifecycle and self-scope through', async () => {
    const response = await invokeSummaries(25, undefined, daysWindow(7), 'rework', true);

    expect(response).toEqual({ success: true, data: emptyPage });
    expect(getCanonicalTaskSummariesMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      25,
      undefined,
      daysWindow(7),
      'rework',
      true,
      null,
    );
  });

  it('passes a supplied member id through', async () => {
    const response = await invokeSummaries(25, undefined, daysWindow(7), 'all', false, 'user_42');

    expect(response).toEqual({ success: true, data: emptyPage });
    expect(getCanonicalTaskSummariesMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      25,
      undefined,
      daysWindow(7),
      'all',
      false,
      'user_42',
    );
  });

  it('refuses a member id alongside the self-scope', async () => {
    const response = await invokeSummaries(25, undefined, daysWindow(7), 'all', true, 'user_42');

    expect(response).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
    expect(getCanonicalTaskSummariesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an out-of-range window', daysWindow(91), 'all'],
    ['a custom range wider than the ceiling', { kind: 'custom', since: '2026-01-01', until: '2026-12-31' }, 'all'],
    ['an unknown lifecycle filter', daysWindow(7), 'stalled'],
  ])('refuses %s before calling the server', async (_label, window, lifecycle) => {
    const response = await invokeSummaries(25, undefined, window, lifecycle);

    expect(response).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
    expect(getCanonicalTaskSummariesMock).not.toHaveBeenCalled();
  });
});

describe('code-change PR lifecycle marks', () => {
  const baseChange = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    provider: 'github',
    repoExternalId: 'acme/widgets',
    externalId: '482',
    number: 482,
    title: 'Fix flaky checkout webhook',
    state: 'merged',
    isDraft: false,
    sourceBranch: 'fix/webhook',
    targetBranch: 'main',
    mergedAt: '2026-08-16T10:03:00.000Z',
    updatedAt: '2026-08-16T10:03:00.000Z',
    externalUrl: null,
    reviewCount: null,
    commentCount: null,
    associationSource: 'external_ref',
    associationSourceValue: '42',
  };

  async function invokeCodeChanges(change: Record<string, unknown>) {
    getCanonicalTaskCodeChangesMock.mockResolvedValue({ items: [change], nextCursor: null });
    const handlers = await registered();
    return handlers.get('delivery:getCanonicalTaskCodeChanges')!(null, WORKSPACE_ID, TASK_ID, 50);
  }

  it('reads absent marks as null (older server, additive fields)', async () => {
    const response = await invokeCodeChanges({ ...baseChange });

    expect(response).toMatchObject({
      success: true,
      data: {
        items: [{ createdAtSource: null, readyForReviewAt: null, firstReviewAt: null, approvedAt: null }],
      },
    });
  });

  it('projects present marks', async () => {
    const response = await invokeCodeChanges({
      ...baseChange,
      createdAtSource: '2026-08-16T09:00:00.000Z',
      readyForReviewAt: '2026-08-16T09:30:00.000Z',
      firstReviewAt: '2026-08-16T09:45:00.000Z',
      approvedAt: null,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        items: [
          {
            createdAtSource: '2026-08-16T09:00:00.000Z',
            readyForReviewAt: '2026-08-16T09:30:00.000Z',
            firstReviewAt: '2026-08-16T09:45:00.000Z',
            approvedAt: null,
          },
        ],
      },
    });
  });

  it.each([
    ['a non-timestamp string', 'yesterday'],
    ['a number', 1755338400000],
    ['an impossible calendar date', '2026-02-30T00:00:00.000Z'],
  ])('fails the page on a malformed mark (%s)', async (_label, readyForReviewAt) => {
    const response = await invokeCodeChanges({ ...baseChange, readyForReviewAt });

    expect(response).toEqual({ success: false, error: 'CANONICAL_DELIVERY_UNAVAILABLE' });
  });
});
