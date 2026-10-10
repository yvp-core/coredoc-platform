/**
 * TanStack query options + write helpers for the intent knowledge base.
 *
 * Mirrors the `unwrap()` envelope idiom from `../observability/observability-api.ts`
 * — the main process returns `{ success, data?, error?, detail? }` and these
 * helpers throw on failure so React Query routes it to one error state.
 *
 * The thrown error keeps the server's structured `detail` attached
 * ({@link IntentRequestError}), because a refused tree or seed write is only
 * useful to a maintainer with its code and failing field paths intact (spec §12).
 *
 * Query keys are literal tuples of the arguments that select the data. Nothing
 * time-derived ever enters a key: an inlined `Date.now()` changes the key on
 * every render and loops the query (a bug this repo has shipped twice).
 *
 * PAGINATION. Every intent list route is cursor-paged, and reading one page and
 * dropping `nextCursor` is a silent lie about the workspace. Two strategies,
 * chosen by what the surface is for:
 *
 * - **Browse** (tree, item index, decision history) uses `useInfiniteQuery` and
 *   an explicit "load more" affordance. A reader who never scrolls past the
 *   first page has lost nothing, and the page they are on is honest about there
 *   being more.
 * - **Review** reads the server's own queue route: one page of candidates plus
 *   the `total` for the filter and the workspace's waiting summary. The client
 *   used to learn the size of the queue by walking every page to a ceiling it
 *   then had to report on screen; the count and the first page are two different
 *   questions and the server answers both in one round trip (issue v1.1-04).
 *   The predecessors a page actually needs are read by exact id, so a
 *   supersession still carries the predecessor's current version without anyone
 *   paging the accepted set.
 *
 * The exhaustive walk survives only where a list must be COMPLETE to be correct
 * — a feature's seeds (the list is also the only place a seed can be removed)
 * and a domain's features — and its bound is private to this module.
 */

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  IntentAnchorRefreshInput,
  IntentAnchorRefreshResponse,
  IntentArchiveInput,
  IntentContextResponse,
  IntentDeleteInput,
  IntentDeleteResponse,
  IntentDimensionsResponse,
  IntentDomainCreateInput,
  IntentDomainMutationResponse,
  IntentDomainUpdateInput,
  IntentErrorEnvelope,
  IntentFeatureCreateInput,
  IntentFeatureUpdateInput,
  IntentFeatureMutationResponse,
  IntentFeatureSeed,
  IntentFeatureSeedsResponse,
  IntentFeatureView,
  IntentFeaturesResponse,
  IntentItemsQuery,
  IntentItemsResponse,
  IntentResult,
  IntentReviewQueueQuery,
  IntentReviewQueueResponse,
  IntentReviewRequest,
  IntentReviewResponse,
  IntentSeedDeleteInput,
  IntentSeedMutationResponse,
  IntentSeedPutInput,
  IntentTransitionsResponse,
  IntentTreeResponse,
} from '../../../shared/intent-types.js';

/** How many items a browse page and a transitions page ask for. */
export const INTENT_BROWSE_PAGE_SIZE = 100;
export const INTENT_HISTORY_PAGE_SIZE = 25;

/** How many decisions the product overview's feed shows. First page only. */
export const INTENT_RECENT_DECISIONS_LIMIT = 10;

/**
 * How many ITEMS one context read may answer with — `INTENT_CONTEXT_LIMITS.max`
 * in `@coredoc/core`, mirrored here because the renderer imports the shared
 * types type-only.
 *
 * It is a hard refusal, not a clamp: a context-mode read asking for a bigger
 * `limit` comes back `invalid_page_limit` and the whole read fails. Anything
 * that resolves records by exact id therefore bounds its request by this number.
 */
export const INTENT_CONTEXT_ITEM_LIMIT = 20;

/**
 * How many candidates one review page carries.
 *
 * Bounded by what ONE context read can answer with, not by taste: each loaded
 * page has its candidates' full records (statement, sources, payload) and its
 * predecessors' current versions resolved by exact id, and a context read
 * answers at most {@link INTENT_CONTEXT_ITEM_LIMIT} items. A larger page would
 * leave the overflow without a statement to review and without the version a
 * supersession needs — B1 sized this against the route's 50-id cap, which is the
 * bound on what may be ASKED, not on what comes back (B3).
 */
export const INTENT_REVIEW_PAGE_SIZE = INTENT_CONTEXT_ITEM_LIMIT;

/**
 * What a reviewer narrows the queue by. Paging belongs to the query option, not
 * to the caller: a `cursor` in the filter would end up in the cache key and give
 * every page its own entry.
 */
export type IntentReviewQueueFilter = Omit<IntentReviewQueueQuery, 'cursor' | 'limit'>;

/**
 * How many pages an exhaustive read follows before it stops. Private: the two
 * remaining exhaustive readers (feature seeds, a domain's features) report
 * `truncated` to their own surface, and nothing outside this module needs the
 * number. The renderer must not be able to walk an unbounded workspace one
 * blocking IPC round-trip at a time.
 */
const EXHAUSTIVE_PAGE_LIMIT = 20;

/** The result of walking every page of a cursor-paged list, ceiling included. */
export interface IntentExhaustiveRead<T> {
  rows: T[];
  /** True when the ceiling stopped the walk while the server still had pages. */
  truncated: boolean;
}

/**
 * Follow `nextCursor` until the server runs out of pages or the ceiling is hit.
 * `read` is handed the cursor for the page it should fetch (`undefined` first).
 */
async function fetchAllPages<T>(
  read: (cursor: string | undefined) => Promise<{ rows: T[]; nextCursor: string | null }>,
): Promise<IntentExhaustiveRead<T>> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < EXHAUSTIVE_PAGE_LIMIT; page += 1) {
    const response = await read(cursor);
    rows.push(...response.rows);
    if (response.nextCursor === null || response.nextCursor === '') return { rows, truncated: false };
    cursor = response.nextCursor;
  }
  return { rows, truncated: true };
}

/** The paged-read query shape shared by every cursor-paged list route. */
const pageQuery = (cursor: string | undefined, limit = INTENT_BROWSE_PAGE_SIZE) => ({
  limit,
  ...(cursor === undefined ? {} : { cursor }),
});

/** An intent request that failed, carrying the server's structured body when it sent one. */
export class IntentRequestError extends Error {
  constructor(
    message: string,
    readonly detail?: IntentErrorEnvelope,
  ) {
    super(message);
    this.name = 'IntentRequestError';
  }
}

async function unwrap<T>(p: Promise<IntentResult<T>>): Promise<T> {
  const res = await p;
  if (!res.success || res.data === undefined) {
    throw new IntentRequestError(res.error ?? 'Intent request failed', res.detail);
  }
  return res.data;
}

/* ------------------------------------------------------------------ reads --- */

/**
 * The domain tree, page by page. Browse: the reader loads the next page when
 * they want it, and the button's presence is how the UI admits there is more.
 */
export const intentTreeQueryOptions = (workspaceId: string, includeArchived: boolean) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'tree', workspaceId, includeArchived] as const,
    queryFn: ({ pageParam }) =>
      unwrap<IntentTreeResponse>(
        window.electronAPI.intentGetTree(workspaceId, { includeArchived, ...pageQuery(pageParam ?? undefined) }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentTreeResponse) => last.nextCursor,
    staleTime: 60_000,
  });

export const intentDimensionsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'dimensions', workspaceId] as const,
    queryFn: () =>
      unwrap<IntentDimensionsResponse>(
        window.electronAPI.intentListDimensions(workspaceId, { includeArchived: false }),
      ),
    staleTime: 60_000,
  });

/**
 * The browse index for one tree scope, page by page. The scope is a plain tuple
 * in the key so a domain view and a feature view never share a cache entry.
 */
export const intentItemsQueryOptions = (workspaceId: string, query: IntentItemsQuery) =>
  infiniteQueryOptions({
    queryKey: [
      'intent',
      'items',
      workspaceId,
      query.domainId ?? null,
      query.featureId ?? null,
      query.authority ?? null,
      query.kind ?? null,
      query.production ?? null,
      query.effectivity ?? null,
      query.sourceRef ?? null,
      query.sourceKind ?? null,
      query.search ?? null,
      query.authorities ?? null,
      query.kinds ?? null,
      query.scopeFeatureId ?? null,
    ] as const,
    queryFn: ({ pageParam }) =>
      unwrap<IntentItemsResponse>(
        window.electronAPI.intentListItems(workspaceId, { ...query, ...pageQuery(pageParam ?? undefined) }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentItemsResponse) => last.nextCursor,
    staleTime: 30_000,
  });

/**
 * The review queue: one page of waiting candidates, plus the filter's `total`
 * and the workspace's waiting summary, from the server's own route.
 *
 * Infinite rather than exhaustive — a reviewer works the backlog down oldest
 * first and loads the next page when they get there — and the size of the queue
 * arrives with the first page instead of being counted by fetching it.
 */
export const intentReviewQueueQueryOptions = (workspaceId: string, filter: IntentReviewQueueFilter = {}) =>
  infiniteQueryOptions({
    queryKey: [
      'intent',
      'review-queue',
      workspaceId,
      filter.domainId ?? null,
      filter.featureId ?? null,
      filter.kind ?? null,
    ] as const,
    queryFn: ({ pageParam }) =>
      unwrap<IntentReviewQueueResponse>(
        window.electronAPI.intentReviewQueue(workspaceId, {
          ...filter,
          ...pageQuery(pageParam ?? undefined, INTENT_REVIEW_PAGE_SIZE),
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentReviewQueueResponse) => last.nextCursor,
    staleTime: 30_000,
  });

/**
 * How many candidates are waiting, for a surface that shows only the number —
 * the top-bar discovery badge (issue v1.1-01).
 *
 * ONE call, and the smallest one the route offers: the summary rides on every
 * queue read, so `limit=1` buys it with a single row rather than a page. Its own
 * cache entry under the `['intent']` prefix, so a decision invalidates it with
 * everything else and the badge cannot go stale behind a review pass.
 */
export const intentPendingReviewQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'pending-review', workspaceId] as const,
    queryFn: async () =>
      (await unwrap<IntentReviewQueueResponse>(window.electronAPI.intentReviewQueue(workspaceId, { limit: 1 })))
        .summary,
    staleTime: 60_000,
  });

/**
 * The full current records of specific items, by exact id — statement, sources,
 * payload, anchors and the version.
 *
 * This is what replaced paging the whole accepted set to find one predecessor (a
 * supersession needs the predecessor's CURRENT version, spec §5), and it is also
 * how the review queue gets the statements and sources its rows do not carry:
 * `IntentReviewQueueItem` is the server's payload-free queue projection.
 *
 * The key carries the ids so two different pages never share an entry, and the
 * ids are deduplicated and sorted so the same SET in a different order is the
 * same key. `limit` is bounded by {@link INTENT_CONTEXT_ITEM_LIMIT} because a
 * larger one is refused outright; a caller that asked about more ids than came
 * back sees the shortfall in the answer and says so on screen.
 */
export const intentItemsByIdQueryOptions = (workspaceId: string, itemIds: readonly string[]) => {
  const ids = [...new Set(itemIds)].sort();
  return queryOptions({
    queryKey: ['intent', 'items-by-id', workspaceId, ids.join(',')] as const,
    queryFn: () =>
      unwrap<IntentContextResponse>(
        window.electronAPI.intentGetContext(workspaceId, {
          intentIds: ids,
          // A queue page is candidates; without this they are not matched.
          includeCandidates: true,
          limit: Math.min(ids.length, INTENT_CONTEXT_ITEM_LIMIT),
        }),
      ),
    enabled: ids.length > 0,
    staleTime: 30_000,
  });
};

/**
 * The predecessors a queue page names. The same read as
 * {@link intentItemsByIdQueryOptions} under the name the review surface uses —
 * one implementation, one cache entry per id set.
 */
export const intentPredecessorsQueryOptions = intentItemsByIdQueryOptions;

/**
 * The workspace's most recent decisions — the product overview's feed (spec
 * §3.2), read from the decision ledger rather than inferred from item state.
 *
 * FIRST PAGE ONLY, and no cursor in the key: this is a glance at what the team
 * just decided, not a browsable history. The per-item history
 * ({@link intentItemTransitionsQueryOptions}) is where paging belongs.
 */
export const intentTransitionsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'transitions', workspaceId] as const,
    queryFn: () =>
      unwrap<IntentTransitionsResponse>(
        window.electronAPI.intentListTransitions(workspaceId, { limit: INTENT_RECENT_DECISIONS_LIMIT }),
      ),
    staleTime: 30_000,
  });

/**
 * Every feature of one domain — what the tree's "show all features" action
 * reads when the server reports `featuresTruncated` on a domain node. The tree
 * route bounds features per domain; this route pages through them properly.
 */
export const intentDomainFeaturesQueryOptions = (workspaceId: string, domainId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'domain-features', workspaceId, domainId] as const,
    queryFn: () => {
      if (domainId === null) throw new IntentRequestError('No domain selected');
      return fetchAllPages<IntentFeatureView>(async (cursor) => {
        const page = await unwrap<IntentFeaturesResponse>(
          window.electronAPI.intentListFeatures(workspaceId, { domainId, ...pageQuery(cursor) }),
        );
        return { rows: page.features, nextCursor: page.nextCursor };
      });
    },
    enabled: domainId !== null,
    staleTime: 30_000,
  });

/**
 * The rich read for one item. `refresh` is MAIN's signal, never the server's: it
 * drops the per-session observed-checkout cache so freshness is judged against
 * the working tree as it is now (spec §6.3). It is not a different question, so
 * it is not a different cache entry — see {@link refetchIntentItemContextFresh}.
 */
const readIntentItemContext = (workspaceId: string, itemId: string, refresh: boolean) =>
  unwrap<IntentContextResponse>(
    window.electronAPI.intentGetContext(workspaceId, {
      intentIds: [itemId],
      includeCandidates: true,
      limit: 1,
      ...(refresh ? { refresh: true } : {}),
    }),
  );

/**
 * The rich read for one item: statement, payload, sources, anchors with their
 * §6.4 status, and the graph provenance those anchors were judged against.
 * `includeCandidates` is always on — the detail pane must open a candidate.
 */
export const intentItemContextQueryOptions = (workspaceId: string, itemId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'item-context', workspaceId, itemId] as const,
    queryFn: () => {
      if (itemId === null) throw new IntentRequestError('No intent item selected');
      return readIntentItemContext(workspaceId, itemId, false);
    },
    enabled: itemId !== null,
    staleTime: 30_000,
  });

/**
 * Read one item's context again with the local checkout re-resolved — the
 * renderer's "re-check freshness" gesture (B2-Browse finding 3).
 *
 * SAME KEY, forced read. `refresh` says how hard to look, not what to look at:
 * putting it in the key would give the pane two entries for one item and leave
 * the reader staring at whichever the last render happened to select.
 */
export const refetchIntentItemContextFresh = (client: QueryClient, workspaceId: string, itemId: string) =>
  client.fetchQuery({
    queryKey: intentItemContextQueryOptions(workspaceId, itemId).queryKey,
    queryFn: () => readIntentItemContext(workspaceId, itemId, true),
    staleTime: 0,
  });

/** Decision history, newest page first, with older pages on request. */
export const intentItemTransitionsQueryOptions = (workspaceId: string, itemId: string | null) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'item-transitions', workspaceId, itemId] as const,
    queryFn: ({ pageParam }) => {
      if (itemId === null) throw new IntentRequestError('No intent item selected');
      return unwrap<IntentTransitionsResponse>(
        window.electronAPI.intentListItemTransitions(
          workspaceId,
          itemId,
          pageQuery(pageParam ?? undefined, INTENT_HISTORY_PAGE_SIZE),
        ),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentTransitionsResponse) => last.nextCursor,
    enabled: itemId !== null,
    staleTime: 30_000,
  });

/**
 * Every seed on a feature. Exhaustive rather than paged: the editor's list is
 * also the only place a seed can be REMOVED, so a seed the list never shows is
 * a seed nobody can delete.
 */
export const intentFeatureSeedsQueryOptions = (workspaceId: string, featureId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'feature-seeds', workspaceId, featureId] as const,
    queryFn: () => {
      if (featureId === null) throw new IntentRequestError('No feature selected');
      return fetchAllPages<IntentFeatureSeed>(async (cursor) => {
        const page = await unwrap<IntentFeatureSeedsResponse>(
          window.electronAPI.intentListFeatureSeeds(workspaceId, featureId, pageQuery(cursor)),
        );
        return { rows: page.seeds, nextCursor: page.nextCursor };
      });
    },
    enabled: featureId !== null,
    staleTime: 30_000,
  });

/* ----------------------------------------------------------------- writes --- */

/**
 * Submit one review batch. A 200 with per-decision refusals is a SUCCESS here —
 * the caller reads each `outcome`. Only transport/contract failures throw.
 */
export const submitIntentReview = (workspaceId: string, body: IntentReviewRequest): Promise<IntentReviewResponse> =>
  unwrap<IntentReviewResponse>(window.electronAPI.intentReviewItems(workspaceId, body));

export const createIntentDomain = (workspaceId: string, body: IntentDomainCreateInput) =>
  unwrap<IntentDomainMutationResponse>(window.electronAPI.intentCreateDomain(workspaceId, body));

export const updateIntentDomain = (workspaceId: string, body: IntentDomainUpdateInput) =>
  unwrap<IntentDomainMutationResponse>(window.electronAPI.intentUpdateDomain(workspaceId, body));

export const archiveIntentDomain = (workspaceId: string, body: IntentArchiveInput) =>
  unwrap<IntentDomainMutationResponse>(window.electronAPI.intentArchiveDomain(workspaceId, body));

export const deleteIntentDomain = (workspaceId: string, body: IntentDeleteInput) =>
  unwrap<IntentDeleteResponse>(window.electronAPI.intentDeleteDomain(workspaceId, body));

export const createIntentFeature = (workspaceId: string, body: IntentFeatureCreateInput) =>
  unwrap<IntentFeatureMutationResponse>(window.electronAPI.intentCreateFeature(workspaceId, body));

export const updateIntentFeature = (workspaceId: string, body: IntentFeatureUpdateInput) =>
  unwrap<IntentFeatureMutationResponse>(window.electronAPI.intentUpdateFeature(workspaceId, body));

export const archiveIntentFeature = (workspaceId: string, body: IntentArchiveInput) =>
  unwrap<IntentFeatureMutationResponse>(window.electronAPI.intentArchiveFeature(workspaceId, body));

export const deleteIntentFeature = (workspaceId: string, body: IntentDeleteInput) =>
  unwrap<IntentDeleteResponse>(window.electronAPI.intentDeleteFeature(workspaceId, body));

/**
 * Re-capture one anchor's baseline against the current snapshot. Any member on
 * a user session; the answer names the previous versioned id, so the row can
 * show what it moved FROM as well as to.
 */
export const refreshIntentAnchor = (
  workspaceId: string,
  body: IntentAnchorRefreshInput,
): Promise<IntentAnchorRefreshResponse> =>
  unwrap<IntentAnchorRefreshResponse>(window.electronAPI.intentRefreshAnchor(workspaceId, body));

export const putIntentSeed = (workspaceId: string, body: IntentSeedPutInput) =>
  unwrap<IntentSeedMutationResponse>(window.electronAPI.intentPutSeed(workspaceId, body));

export const deleteIntentSeed = (workspaceId: string, body: IntentSeedDeleteInput) =>
  unwrap<IntentDeleteResponse>(window.electronAPI.intentDeleteSeed(workspaceId, body));

export const intentSourceOptions = (workspaceId: string, search: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['intent', 'sources', workspaceId, search],
    queryFn: () => unwrap(window.electronAPI.intentListSources(workspaceId, search)),
    enabled,
  });
export async function selectMatchingIntentItems(workspaceId: string, query: IntentItemsQuery) {
  const result = await unwrap(window.electronAPI.intentListItems(workspaceId, { ...query, limit: 200 }));
  if (result.nextCursor)
    throw new Error(
      'More than 200 rules match. Narrow the search or choose a smaller domain or feature before selecting all.',
    );
  return result.items;
}
