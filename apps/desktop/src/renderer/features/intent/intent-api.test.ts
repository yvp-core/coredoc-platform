import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentAuthority } from '../../../shared/intent-types.js';
import {
  INTENT_CONTEXT_ITEM_LIMIT,
  INTENT_RECENT_DECISIONS_LIMIT,
  INTENT_REVIEW_PAGE_SIZE,
  IntentRequestError,
  intentItemContextQueryOptions,
  intentItemsByIdQueryOptions,
  intentItemsQueryOptions,
  intentPendingReviewQueryOptions,
  intentPredecessorsQueryOptions,
  intentReviewQueueQueryOptions,
  intentTransitionsQueryOptions,
  intentTreeQueryOptions,
  refetchIntentItemContextFresh,
  submitIntentReview,
} from './intent-api';

// Fully mocked window.electronAPI — no real IPC. api tests in this repo MUST mock the
// bridge completely (feedback_storybook_no_real_ipc_in_ci).
const intentGetTree = vi.fn();
const intentListItems = vi.fn();
const intentReviewItems = vi.fn();
const intentReviewQueue = vi.fn();
const intentGetContext = vi.fn();
const intentListTransitions = vi.fn();

const queuePage = (ids: readonly string[], nextCursor: string | null, waiting = ids.length) => ({
  success: true,
  data: {
    summary: {
      waiting,
      oldestWaitingAt: '2026-08-29T00:00:00.000Z',
      hasReplacementCandidate: false,
      byDomain: [],
      byDomainTruncated: false,
    },
    total: waiting,
    items: ids.map((id) => ({ id })),
    nextCursor,
  },
});

const itemPage = (ids: readonly string[], nextCursor: string | null) => ({
  success: true,
  data: { items: ids.map((id) => ({ id })), nextCursor },
});

beforeEach(() => {
  intentGetTree.mockReset();
  intentListItems.mockReset();
  intentReviewItems.mockReset();
  intentReviewQueue.mockReset();
  intentGetContext.mockReset();
  intentListTransitions.mockReset();
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      intentGetTree,
      intentListItems,
      intentReviewItems,
      intentReviewQueue,
      intentGetContext,
      intentListTransitions,
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('intent query keys', () => {
  it('are stable across calls with the same arguments', () => {
    // The bug this pins: a time-derived value inlined into a queryKey changes the
    // key on every render and loops the query. Nothing here may be time-derived.
    const first = intentTreeQueryOptions('ws-1', false).queryKey;
    const second = intentTreeQueryOptions('ws-1', false).queryKey;
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toMatch(/\d{13}/);
  });

  it('separate the archived and unarchived views', () => {
    expect(intentTreeQueryOptions('ws-1', true).queryKey).not.toEqual(intentTreeQueryOptions('ws-1', false).queryKey);
  });

  it('separate a domain scope, a feature scope, and an authority filter', () => {
    const domain = intentItemsQueryOptions('ws-1', { domainId: 'payments' }).queryKey;
    const feature = intentItemsQueryOptions('ws-1', { featureId: 'refunds' }).queryKey;
    const candidates = intentItemsQueryOptions('ws-1', { authority: IntentAuthority.Candidate }).queryKey;
    expect(domain).not.toEqual(feature);
    expect(domain).not.toEqual(candidates);
    expect(feature).not.toEqual(candidates);
  });

  it('keeps a null selection out of the cache rather than firing an id-less read', () => {
    expect(intentItemContextQueryOptions('ws-1', null).enabled).toBe(false);
    expect(intentItemContextQueryOptions('ws-1', 'br-1').enabled).toBe(true);
  });
});

describe('browse pagination', () => {
  it('carries the cursor of the page being fetched, and stops when the server has no next one', async () => {
    // The defect this pins: one page was read and `nextCursor` dropped, so a
    // tree or index longer than a page silently shrank to its first 100 rows.
    const options = intentTreeQueryOptions('ws-1', false);
    intentGetTree.mockResolvedValue({ success: true, data: { domains: [], nextCursor: 'cur-2' } });

    await options.queryFn!({ pageParam: 'cur-1' } as never);

    expect(intentGetTree).toHaveBeenCalledWith('ws-1', { includeArchived: false, limit: 100, cursor: 'cur-1' });
    expect(options.getNextPageParam({ domains: [], nextCursor: 'cur-2' }, [], null, [])).toBe('cur-2');
    expect(options.getNextPageParam({ domains: [], nextCursor: null }, [], null, [])).toBeNull();
  });

  it('asks for the first page without a cursor', async () => {
    intentListItems.mockResolvedValue(itemPage([], null));

    await intentItemsQueryOptions('ws-1', { domainId: 'payments' }).queryFn!({ pageParam: null } as never);

    expect(intentListItems).toHaveBeenCalledWith('ws-1', { domainId: 'payments', limit: 100 });
  });
});

describe('review queue (issue v1.1-04: no exhaustive walk)', () => {
  it('reads ONE page from the queue route, carrying the cursor of the page it fetches', async () => {
    // The defect this closes: entering Review paged the whole candidate set to a
    // client-side ceiling. One page plus the server's own total is the contract.
    const options = intentReviewQueueQueryOptions('ws-1');
    intentReviewQueue.mockResolvedValue(queuePage(['a'], 'cur-2', 137));

    const page = await options.queryFn!({ pageParam: 'cur-1' } as never);

    expect(intentReviewQueue).toHaveBeenCalledTimes(1);
    expect(intentReviewQueue).toHaveBeenCalledWith('ws-1', { limit: INTENT_REVIEW_PAGE_SIZE, cursor: 'cur-1' });
    expect(page.total).toBe(137);
    expect(options.getNextPageParam(page, [], null, [])).toBe('cur-2');
  });

  it('asks for the first page without a cursor', async () => {
    intentReviewQueue.mockResolvedValue(queuePage([], null, 0));

    await intentReviewQueueQueryOptions('ws-1').queryFn!({ pageParam: null } as never);

    expect(intentReviewQueue).toHaveBeenCalledWith('ws-1', { limit: INTENT_REVIEW_PAGE_SIZE });
  });

  it('separates the queue filters in the cache key, and keeps paging out of it', () => {
    const all = intentReviewQueueQueryOptions('ws-1').queryKey;
    const scoped = intentReviewQueueQueryOptions('ws-1', { domainId: 'payments' }).queryKey;

    expect(all).toEqual(intentReviewQueueQueryOptions('ws-1').queryKey);
    expect(all).not.toEqual(scoped);
    expect(JSON.stringify(all)).not.toMatch(/cursor|limit/);
    // Under the prefix a write invalidates.
    expect(all[0]).toBe('intent');
  });

  it('buys the waiting summary with a one-row page, not with the queue itself', async () => {
    intentReviewQueue.mockResolvedValue(queuePage(['a'], 'cur-2', 4));

    const summary = await intentPendingReviewQueryOptions('ws-1').queryFn!({} as never);

    expect(intentReviewQueue).toHaveBeenCalledTimes(1);
    expect(intentReviewQueue).toHaveBeenCalledWith('ws-1', { limit: 1 });
    expect(summary.waiting).toBe(4);
  });

  it('keeps the badge count in its own stable cache entry', () => {
    expect(intentPendingReviewQueryOptions('ws-1').queryKey).toEqual(intentPendingReviewQueryOptions('ws-1').queryKey);
    expect(intentPendingReviewQueryOptions('ws-1').queryKey).not.toEqual(
      intentPendingReviewQueryOptions('ws-2').queryKey,
    );
    expect(JSON.stringify(intentPendingReviewQueryOptions('ws-1').queryKey)).not.toMatch(/\d{13}/);
  });
});

describe('records by exact id (supersession correctness, queue statements)', () => {
  it('reads exactly the named ids by id, in ONE call, candidates included', async () => {
    intentGetContext.mockResolvedValue({ success: true, data: { matches: [] } });

    await intentPredecessorsQueryOptions('ws-1', ['br-b', 'br-a']).queryFn!({} as never);

    expect(intentGetContext).toHaveBeenCalledTimes(1);
    expect(intentGetContext).toHaveBeenCalledWith('ws-1', {
      intentIds: ['br-a', 'br-b'],
      includeCandidates: true,
      limit: 2,
    });
  });

  it('is ONE implementation under both names, so one id set is one cache entry', () => {
    expect(intentPredecessorsQueryOptions).toBe(intentItemsByIdQueryOptions);
  });

  it('never asks for a bigger answer than a context read may give', async () => {
    // The defect this closes: a `limit` above the context bound is REFUSED
    // (`invalid_page_limit`), not clamped — the whole read fails and every card
    // on the page loses its statement and its predecessor's version.
    const ids = Array.from({ length: INTENT_CONTEXT_ITEM_LIMIT + 5 }, (_, index) => `br-${index}`);
    intentGetContext.mockResolvedValue({ success: true, data: { matches: [] } });

    await intentItemsByIdQueryOptions('ws-1', ids).queryFn!({} as never);

    expect(intentGetContext.mock.calls[0]?.[1].limit).toBe(INTENT_CONTEXT_ITEM_LIMIT);
  });

  it('sizes a review page so one page fits one such read', () => {
    expect(INTENT_REVIEW_PAGE_SIZE).toBeLessThanOrEqual(INTENT_CONTEXT_ITEM_LIMIT);
  });

  it('collapses a repeated id rather than paying for it twice', async () => {
    intentGetContext.mockResolvedValue({ success: true, data: { matches: [] } });

    await intentItemsByIdQueryOptions('ws-1', ['br-a', 'br-a', 'br-b']).queryFn!({} as never);

    expect(intentGetContext).toHaveBeenCalledWith('ws-1', {
      intentIds: ['br-a', 'br-b'],
      includeCandidates: true,
      limit: 2,
    });
  });

  it('gives the same id SET one cache entry whatever the order, and never fires empty', () => {
    expect(intentPredecessorsQueryOptions('ws-1', ['b', 'a']).queryKey).toEqual(
      intentPredecessorsQueryOptions('ws-1', ['a', 'b']).queryKey,
    );
    expect(intentPredecessorsQueryOptions('ws-1', ['a']).queryKey).not.toEqual(
      intentPredecessorsQueryOptions('ws-1', ['a', 'b']).queryKey,
    );
    expect(intentPredecessorsQueryOptions('ws-1', []).enabled).toBe(false);
    expect(intentPredecessorsQueryOptions('ws-1', ['a']).enabled).toBe(true);
  });
});

describe('workspace decision ledger', () => {
  it('reads ONE page of the workspace transitions, with no cursor in the key', async () => {
    intentListTransitions.mockResolvedValue({ success: true, data: { transitions: [], nextCursor: 'cur-2' } });

    await intentTransitionsQueryOptions('ws-1').queryFn!({} as never);

    expect(intentListTransitions).toHaveBeenCalledTimes(1);
    expect(intentListTransitions).toHaveBeenCalledWith('ws-1', { limit: INTENT_RECENT_DECISIONS_LIMIT });
    const key = intentTransitionsQueryOptions('ws-1').queryKey;
    expect(key).toEqual(intentTransitionsQueryOptions('ws-1').queryKey);
    expect(key).not.toEqual(intentTransitionsQueryOptions('ws-2').queryKey);
    expect(JSON.stringify(key)).not.toMatch(/cursor|\d{13}/);
    // Under the prefix a decision invalidates.
    expect(key[0]).toBe('intent');
  });
});

describe('freshness re-check (observed checkout)', () => {
  it('re-reads the item with `refresh` set, under the SAME key as the pane', async () => {
    // `refresh` says how hard to look, not what to look at: a second cache entry
    // would leave the reader on whichever one the last render happened to pick.
    const client = new QueryClient();
    intentGetContext.mockResolvedValue({ success: true, data: { matches: [{ id: 'br-1' }] } });

    await refetchIntentItemContextFresh(client, 'ws-1', 'br-1');

    expect(intentGetContext).toHaveBeenCalledWith('ws-1', {
      intentIds: ['br-1'],
      includeCandidates: true,
      limit: 1,
      refresh: true,
    });
    expect(client.getQueryData(intentItemContextQueryOptions('ws-1', 'br-1').queryKey)).toEqual({
      matches: [{ id: 'br-1' }],
    });
    expect(JSON.stringify(intentItemContextQueryOptions('ws-1', 'br-1').queryKey)).not.toMatch(/refresh/);
  });

  it('leaves `refresh` off the ordinary read, so a pane render never re-runs git', async () => {
    intentGetContext.mockResolvedValue({ success: true, data: { matches: [] } });

    await intentItemContextQueryOptions('ws-1', 'br-1').queryFn!({} as never);

    expect(intentGetContext).toHaveBeenCalledWith('ws-1', {
      intentIds: ['br-1'],
      includeCandidates: true,
      limit: 1,
    });
  });
});

describe('envelope unwrapping', () => {
  it('returns the payload on success', async () => {
    const data = { domains: [], nextCursor: null };
    intentGetTree.mockResolvedValue({ success: true, data });

    const result = await intentTreeQueryOptions('ws-1', false).queryFn!({} as never);

    expect(intentGetTree).toHaveBeenCalledWith('ws-1', { includeArchived: false, limit: 100 });
    expect(result).toBe(data);
  });

  it('keeps the server structured error attached to the thrown error (spec §12)', async () => {
    const detail = {
      statusCode: 400,
      timestamp: '2026-09-01T00:00:00.000Z',
      code: 'unknown_repo_key',
      message: "repo key 'acme/nope' is not registered; registered: acme/api (api)",
      path: ['repoKey'],
      details: [{ code: 'unknown_repo_key', message: 'acme/api (api)', path: ['repoKey'] }],
    };
    intentReviewItems.mockResolvedValue({ success: false, error: detail.message, detail });

    // The archived CLI's named defect was swallowing this body behind a generic
    // hint; the code and the failing field path must survive to the renderer.
    await expect(
      submitIntentReview('ws-1', {
        idempotencyKey: 'k',
        authorizingSource: { kind: 'spec' as never, ref: 'r', localId: 'l' },
        decisions: [],
      }),
    ).rejects.toMatchObject({ name: 'IntentRequestError', message: detail.message });

    try {
      await submitIntentReview('ws-1', {
        idempotencyKey: 'k',
        authorizingSource: { kind: 'spec' as never, ref: 'r', localId: 'l' },
        decisions: [],
      });
      expect.unreachable('submitIntentReview should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentRequestError);
      expect((error as IntentRequestError).detail).toEqual(detail);
    }
  });

  it('falls back to the transport message when there is no contract body', async () => {
    intentGetTree.mockResolvedValue({ success: false, error: 'API GET /intent/tree failed (503): upstream down' });

    await expect(intentTreeQueryOptions('ws-1', false).queryFn!({} as never)).rejects.toThrow('upstream down');
  });
});
