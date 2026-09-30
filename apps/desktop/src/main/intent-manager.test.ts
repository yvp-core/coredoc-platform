/**
 * Manager-layer tests for the intent IPC surface.
 *
 * The manager is a thin seam: it registers one handler per intent channel,
 * forwards the renderer's arguments VERBATIM to `server-api.ts`, and wraps the
 * outcome in the `{ success, data?, error?, detail? }` envelope. So the things
 * worth pinning are exactly those three: that every channel is registered, that
 * each one calls its own transport function with the arguments it was given, and
 * that a failure keeps the server's structured body instead of flattening it.
 *
 * `server-api.js` is mocked whole (it reaches Electron's `app.getPath` through
 * `auth-manager.js` at import time), and `ipcMain` is a plain registration
 * recorder — no real IPC, no network, no Electron.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannels } from '../shared/ipc-types.js';

const api = vi.hoisted(() => {
  /** Mirrors `server-api.ts`'s `ApiError`: status + message + raw body. */
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body: string = '',
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    getIntentTree: vi.fn(),
    getIntentDimensions: vi.fn(),
    getIntentReleasePreview: vi.fn(),
    getIntentReleasePreviews: vi.fn(),
    listIntentReleases: vi.fn(),
    recordIntentRelease: vi.fn(),
    listIntentFeatures: vi.fn(),
    listIntentFeatureSeeds: vi.fn(),
    listIntentItems: vi.fn(),
    listIntentSources: vi.fn(),
    listIntentReviewQueue: vi.fn(),
    getIntentContext: vi.fn(),
    listIntentItemTransitions: vi.fn(),
    listIntentTransitions: vi.fn(),
    reviewIntentItems: vi.fn(),
    createIntentDomain: vi.fn(),
    updateIntentDomain: vi.fn(),
    archiveIntentDomain: vi.fn(),
    deleteIntentDomain: vi.fn(),
    createIntentFeature: vi.fn(),
    updateIntentFeature: vi.fn(),
    archiveIntentFeature: vi.fn(),
    deleteIntentFeature: vi.fn(),
    putIntentFeatureSeed: vi.fn(),
    deleteIntentFeatureSeed: vi.fn(),
    refreshIntentAnchor: vi.fn(),
  };
});

vi.mock('./server-api.js', () => api);

/**
 * The observed-checkout resolver is mocked, and its DEFAULT is "nothing
 * observed" — the state of a machine with no local checkout for the workspace.
 * That is what keeps the forwarding cases below honest: `intent:getContext`
 * forwards its arguments verbatim unless main actually has git facts to add, and
 * the two cases that do have them assert the addition explicitly.
 */
const observed = vi.hoisted(() => ({
  resolveObservedCheckouts: vi.fn(async () => [] as string[]),
  invalidateObservedCheckouts: vi.fn(),
}));

vi.mock('./intent-observed-checkout.js', () => observed);

const { registerIntentHandlers } = await import('./intent-manager.js');

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** Records `ipcMain.handle` registrations; duplicates are a bug, so they throw. */
function recordHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
  };
  registerIntentHandlers(ipcMain as unknown as import('electron').IpcMain);
  return handlers;
}

/** Every `INTENT_*` channel declared in the shared contract. */
const intentChannels = Object.entries(IpcChannels)
  .filter(([key]) => key.startsWith('INTENT_'))
  .map(([, channel]) => channel as string);

/** One forwarding case: invoke the channel with `args`, expect `fn(...args)`. */
interface ForwardCase {
  channel: string;
  fn: ReturnType<typeof vi.fn>;
  args: unknown[];
}

const WORKSPACE = 'ws-1';
const KEY = { idempotencyKey: 'idem-1' };

/**
 * The seed inputs carry the repo-scoped anchor coordinates (`repoKey` +
 * `nodeId`); they must reach the transport unchanged, since the server resolves
 * the anchor from exactly those two fields.
 */
const seedPut = { ...KEY, featureId: 'feat-1', repoKey: 'github.com/acme/api', nodeId: 'node-1', note: 'why' };
const seedDelete = { ...KEY, featureId: 'feat-1', repoKey: 'github.com/acme/api', nodeId: 'node-1' };

const forwardCases: ForwardCase[] = [
  { channel: IpcChannels.INTENT_RELEASE_PREVIEW, fn: api.getIntentReleasePreview, args: ['ws-1', 'br-a'] },
  { channel: IpcChannels.INTENT_RELEASE_PREVIEWS, fn: api.getIntentReleasePreviews, args: ['ws-1', ['br-a']] },
  { channel: IpcChannels.INTENT_RELEASE_LIST, fn: api.listIntentReleases, args: ['ws-1', 20] },
  {
    channel: IpcChannels.INTENT_RELEASE_WRITE,
    fn: api.recordIntentRelease,
    args: [
      'ws-1',
      'rollback',
      { idempotencyKey: 'qa-rollback', expectedHeadSeq: 5, releaseSeq: 2, reason: 'Deployment rollback' },
    ],
  },
  { channel: IpcChannels.INTENT_GET_TREE, fn: api.getIntentTree, args: [WORKSPACE, { includeArchived: true }] },
  {
    channel: IpcChannels.INTENT_LIST_DIMENSIONS,
    fn: api.getIntentDimensions,
    args: [WORKSPACE, { includeArchived: false }],
  },
  {
    channel: IpcChannels.INTENT_LIST_FEATURES,
    fn: api.listIntentFeatures,
    args: [WORKSPACE, { domainId: 'dom-1', cursor: 'c1', limit: 25 }],
  },
  {
    channel: IpcChannels.INTENT_LIST_FEATURE_SEEDS,
    fn: api.listIntentFeatureSeeds,
    args: [WORKSPACE, 'feat-1', { limit: 10 }],
  },
  { channel: IpcChannels.INTENT_LIST_SOURCES, fn: api.listIntentSources, args: [WORKSPACE, 'uploads'] },
  {
    channel: IpcChannels.INTENT_LIST_ITEMS,
    fn: api.listIntentItems,
    args: [WORKSPACE, { authority: 'candidate', kind: 'business_rule', featureId: 'feat-1' }],
  },
  {
    channel: IpcChannels.INTENT_REVIEW_QUEUE,
    fn: api.listIntentReviewQueue,
    args: [WORKSPACE, { domainId: 'dom-1', kind: 'limitation', limit: 50 }],
  },
  {
    channel: IpcChannels.INTENT_GET_CONTEXT,
    fn: api.getIntentContext,
    args: [WORKSPACE, { intentIds: ['i-1', 'i-2'], includeCandidates: true, limit: 5 }],
  },
  {
    channel: IpcChannels.INTENT_LIST_ITEM_TRANSITIONS,
    fn: api.listIntentItemTransitions,
    args: [WORKSPACE, 'item-1', { cursor: 'c2', limit: 50 }],
  },
  { channel: IpcChannels.INTENT_LIST_TRANSITIONS, fn: api.listIntentTransitions, args: [WORKSPACE, { limit: 50 }] },
  {
    channel: IpcChannels.INTENT_REVIEW_ITEMS,
    fn: api.reviewIntentItems,
    args: [
      WORKSPACE,
      {
        ...KEY,
        authorizingSource: { kind: 'spec', ref: 'spec.md', localId: 'l-1' },
        decisions: [{ itemId: 'item-1', expectedVersion: 3, action: 'approve', reason: 'looks right' }],
      },
    ],
  },
  {
    channel: IpcChannels.INTENT_CREATE_DOMAIN,
    fn: api.createIntentDomain,
    args: [WORKSPACE, { ...KEY, id: 'dom-1', title: 'Billing', statement: 'money' }],
  },
  {
    channel: IpcChannels.INTENT_UPDATE_DOMAIN,
    fn: api.updateIntentDomain,
    args: [WORKSPACE, { ...KEY, id: 'dom-1', title: 'Billing v2' }],
  },
  {
    channel: IpcChannels.INTENT_ARCHIVE_DOMAIN,
    fn: api.archiveIntentDomain,
    args: [WORKSPACE, { ...KEY, id: 'dom-1', archived: true }],
  },
  { channel: IpcChannels.INTENT_DELETE_DOMAIN, fn: api.deleteIntentDomain, args: [WORKSPACE, { ...KEY, id: 'dom-1' }] },
  {
    channel: IpcChannels.INTENT_CREATE_FEATURE,
    fn: api.createIntentFeature,
    args: [WORKSPACE, { ...KEY, id: 'feat-1', title: 'Invoices', domainId: 'dom-1' }],
  },
  {
    channel: IpcChannels.INTENT_UPDATE_FEATURE,
    fn: api.updateIntentFeature,
    args: [WORKSPACE, { ...KEY, id: 'feat-1', statement: 'new statement' }],
  },
  {
    channel: IpcChannels.INTENT_ARCHIVE_FEATURE,
    fn: api.archiveIntentFeature,
    args: [WORKSPACE, { ...KEY, id: 'feat-1', archived: false }],
  },
  {
    channel: IpcChannels.INTENT_DELETE_FEATURE,
    fn: api.deleteIntentFeature,
    args: [WORKSPACE, { ...KEY, id: 'feat-1' }],
  },
  { channel: IpcChannels.INTENT_PUT_SEED, fn: api.putIntentFeatureSeed, args: [WORKSPACE, seedPut] },
  { channel: IpcChannels.INTENT_DELETE_SEED, fn: api.deleteIntentFeatureSeed, args: [WORKSPACE, seedDelete] },
  {
    channel: IpcChannels.INTENT_REFRESH_ANCHOR,
    fn: api.refreshIntentAnchor,
    args: [WORKSPACE, { ...KEY, itemId: 'item-1', repoKey: 'github.com/acme/api', nodeId: 'node-1' }],
  },
];

let handlers: Map<string, Handler>;

beforeEach(() => {
  for (const value of Object.values(api)) {
    if (typeof value === 'function' && 'mockReset' in value) (value as ReturnType<typeof vi.fn>).mockReset();
  }
  observed.resolveObservedCheckouts.mockReset();
  observed.resolveObservedCheckouts.mockResolvedValue([]);
  observed.invalidateObservedCheckouts.mockReset();
  handlers = recordHandlers();
});

function invoke(channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

describe('registerIntentHandlers registration', () => {
  it('registers exactly the INTENT_* channels of the shared contract', () => {
    expect([...handlers.keys()].sort()).toEqual([...intentChannels].sort());
  });

  it('covers every registered channel with a forwarding case', () => {
    expect(forwardCases.map((c) => c.channel).sort()).toEqual([...intentChannels].sort());
  });
});

describe('argument forwarding', () => {
  it.each(forwardCases)('$channel forwards its arguments verbatim', async ({ channel, fn, args }) => {
    fn.mockResolvedValue({ marker: channel });

    await expect(invoke(channel, args)).resolves.toEqual({ success: true, data: { marker: channel } });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(...args);
  });

  it('does not invoke any other transport function', async () => {
    api.getIntentTree.mockResolvedValue({ domains: [] });

    await invoke(IpcChannels.INTENT_GET_TREE, [WORKSPACE, {}]);

    for (const [name, value] of Object.entries(api)) {
      if (name === 'getIntentTree' || typeof value !== 'function' || !('mock' in value)) continue;
      expect(value as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    }
  });

  it('passes an omitted query through as undefined rather than substituting a default', async () => {
    api.listIntentItems.mockResolvedValue({ items: [], nextCursor: null });

    await invoke(IpcChannels.INTENT_LIST_ITEMS, [WORKSPACE]);

    expect(api.listIntentItems).toHaveBeenCalledWith(WORKSPACE, undefined);
  });

  it('returns success for a review whose decisions were refused inside a 200', async () => {
    const response = {
      decisions: [
        { decisionIndex: 0, itemId: 'item-1', action: 'approve', outcome: 'refused', authority: null, version: 4 },
      ],
    };
    api.reviewIntentItems.mockResolvedValue(response);

    await expect(invoke(IpcChannels.INTENT_REVIEW_ITEMS, [WORKSPACE, { decisions: [] }])).resolves.toEqual({
      success: true,
      data: response,
    });
  });
});

describe('observed checkout folded into the context read (issue v1.1-04)', () => {
  it('appends what the main process observed, without the renderer asking for it', async () => {
    // The renderer never learns git state: it asks for context, and main adds
    // the local checkout of every repo it could map (spec §6.3).
    observed.resolveObservedCheckouts.mockResolvedValue(['acme/api@abc1234', 'web@def5678:dirty']);
    api.getIntentContext.mockResolvedValue({ matches: [] });

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [WORKSPACE, { intentIds: ['i-1'] }]);

    expect(observed.resolveObservedCheckouts).toHaveBeenCalledWith(WORKSPACE);
    expect(api.getIntentContext).toHaveBeenCalledWith(WORKSPACE, {
      intentIds: ['i-1'],
      observed: ['acme/api@abc1234', 'web@def5678:dirty'],
    });
  });

  it('sends no observed parameter at all when nothing could be observed', async () => {
    // An empty list is not a claim; freshness is never asserted by omission, so
    // the query goes out exactly as the renderer wrote it.
    api.getIntentContext.mockResolvedValue({ matches: [] });

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [WORKSPACE, { limit: 5 }]);

    expect(api.getIntentContext).toHaveBeenCalledWith(WORKSPACE, { limit: 5 });
  });

  it('drops the session checkout cache only when the renderer asked for a refresh', async () => {
    api.getIntentContext.mockResolvedValue({ matches: [] });

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [WORKSPACE, { limit: 1 }]);
    expect(observed.invalidateObservedCheckouts).not.toHaveBeenCalled();

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [WORKSPACE, { limit: 1, refresh: true }]);
    expect(observed.invalidateObservedCheckouts).toHaveBeenCalledTimes(1);
    // `refresh` is main's own signal: it is CONSUMED here and never handed on,
    // so the transport is never asked to decide what to do with it.
    expect(api.getIntentContext).toHaveBeenLastCalledWith(WORKSPACE, { limit: 1 });
  });

  it('never forwards an `observed` the RENDERER supplied', async () => {
    // The renderer has no standing to speak for the local worktree: forwarding
    // its value would let it assert any freshness it liked, which is exactly
    // what resolving the checkout in main exists to prevent.
    observed.resolveObservedCheckouts.mockResolvedValue(['acme/api@abc1234']);
    api.getIntentContext.mockResolvedValue({ matches: [] });

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [
      WORKSPACE,
      { intentIds: ['i-1'], observed: ['acme/api@deadbeef', 'evil@0000000'] },
    ]);

    expect(api.getIntentContext).toHaveBeenCalledWith(WORKSPACE, {
      intentIds: ['i-1'],
      observed: ['acme/api@abc1234'],
    });
  });

  it('drops a renderer `observed` even when main could observe nothing', async () => {
    api.getIntentContext.mockResolvedValue({ matches: [] });

    await invoke(IpcChannels.INTENT_GET_CONTEXT, [WORKSPACE, { limit: 5, observed: ['acme/api@deadbeef'] }]);

    expect(api.getIntentContext).toHaveBeenCalledWith(WORKSPACE, { limit: 5 });
  });
});

describe('error mapping', () => {
  const structured = {
    statusCode: 409,
    timestamp: '2026-09-02T00:00:00.000Z',
    requestPath: '/api/workspaces/ws-1/intent/items/review',
    code: 'INTENT_VERSION_CONFLICT',
    message: 'Item item-1 changed since you loaded it',
    path: ['decisions', '0', 'expectedVersion'],
    details: [{ code: 'STALE', message: 'expected 3, current 4', path: ['decisions', '0'] }],
  };

  it('prefers the structured body message and forwards the detail verbatim', async () => {
    api.reviewIntentItems.mockRejectedValue(new api.ApiError(409, 'HTTP 409', JSON.stringify(structured)));

    await expect(invoke(IpcChannels.INTENT_REVIEW_ITEMS, [WORKSPACE, { decisions: [] }])).resolves.toEqual({
      success: false,
      error: structured.message,
      detail: structured,
    });
  });

  it('totalizes a details entry that omitted its path, which used to crash the renderer', async () => {
    const body = JSON.stringify({ code: 'INTENT_INVALID', message: 'bad input', details: [{ code: 'X' }] });
    api.createIntentDomain.mockRejectedValue(new api.ApiError(400, 'HTTP 400', body));

    await expect(
      invoke(IpcChannels.INTENT_CREATE_DOMAIN, [WORKSPACE, { ...KEY, id: 'd', title: 't' }]),
    ).resolves.toEqual({
      success: false,
      error: 'bad input',
      detail: {
        statusCode: 0,
        timestamp: '',
        code: 'INTENT_INVALID',
        message: 'bad input',
        path: [],
        details: [{ code: 'X', message: '', path: [] }],
      },
    });
  });

  it('falls back to the transport message when the body is not a contract envelope', async () => {
    api.getIntentTree.mockRejectedValue(new api.ApiError(502, 'HTTP 502: Bad Gateway', '<html>nginx</html>'));

    const result = (await invoke(IpcChannels.INTENT_GET_TREE, [WORKSPACE, {}])) as Record<string, unknown>;

    expect(result).toEqual({ success: false, error: 'HTTP 502: Bad Gateway' });
    expect(result).not.toHaveProperty('detail');
  });

  it('falls back to the transport message when the body is empty', async () => {
    api.listIntentTransitions.mockRejectedValue(new api.ApiError(401, 'HTTP 401: Unauthorized'));

    await expect(invoke(IpcChannels.INTENT_LIST_TRANSITIONS, [WORKSPACE, {}])).resolves.toEqual({
      success: false,
      error: 'HTTP 401: Unauthorized',
    });
  });

  it('maps a non-ApiError rejection to its message, with no detail', async () => {
    api.putIntentFeatureSeed.mockRejectedValue(new Error('fetch failed'));

    await expect(invoke(IpcChannels.INTENT_PUT_SEED, [WORKSPACE, seedPut])).resolves.toEqual({
      success: false,
      error: 'fetch failed',
    });
  });

  it('stringifies a non-Error rejection', async () => {
    api.deleteIntentFeatureSeed.mockRejectedValue('boom');

    await expect(invoke(IpcChannels.INTENT_DELETE_SEED, [WORKSPACE, seedDelete])).resolves.toEqual({
      success: false,
      error: 'boom',
    });
  });
});
