/**
 * Reads and writes behind the Intent page (`/api/v1/workspaces/:id/intent/…`).
 *
 * Query keys are literal tuples of the arguments that select the data. Nothing
 * time-derived ever enters a key: an inlined `Date.now()` changes the key on
 * every render and loops the query.
 *
 * PAGINATION. Every intent list route is cursor-paged, and reading one page and
 * dropping `nextCursor` is a silent lie about the workspace. Browse (tree, item
 * index, decision history) pages with `useInfiniteQuery` and an explicit "load
 * more"; Review reads the server's own queue route, which answers the filter's
 * `total` and the workspace's waiting summary with the first page. The
 * exhaustive walk survives only where a list must be COMPLETE to be correct — a
 * feature's seeds (the list is also the only place a seed can be removed) and a
 * domain's features.
 */

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type {
  IntentAnchorRefreshInput,
  IntentAnchorRefreshResponse,
  IntentArchiveInput,
  IntentContextListQuery,
  IntentContextListResponse,
  IntentContextQuery,
  IntentContextResponse,
  IntentDeleteInput,
  IntentDeleteResponse,
  IntentDimensionsResponse,
  IntentDomainCreateInput,
  IntentDomainMutationResponse,
  IntentDomainUpdateInput,
  IntentFeatureCreateInput,
  IntentFeatureMutationResponse,
  IntentFeatureSeed,
  IntentFeatureSeedsResponse,
  IntentFeatureUpdateInput,
  IntentFeatureView,
  IntentFeaturesQuery,
  IntentFeaturesResponse,
  IntentItemsQuery,
  IntentItemsResponse,
  IntentReviewQueueQuery,
  IntentReviewQueueResponse,
  IntentReviewRequest,
  IntentReviewResponse,
  IntentSeedDeleteInput,
  IntentSeedMutationResponse,
  IntentSeedPutInput,
  IntentTransitionsQuery,
  IntentTransitionsResponse,
  IntentTreeResponse,
  IntentNodeDocument,
  IntentPendingNodesResponse,
} from '../../features/intent/types.js';

/** How many items a browse page and a transitions page ask for. */
export const INTENT_BROWSE_PAGE_SIZE = 100;
export const INTENT_HISTORY_PAGE_SIZE = 25;

/** How many decisions the product overview's feed shows. First page only. */
export const INTENT_RECENT_DECISIONS_LIMIT = 10;

/**
 * How many ITEMS one context read may answer with (`INTENT_CONTEXT_LIMITS.max`).
 * It is a hard refusal, not a clamp: a bigger `limit` fails the whole read, so
 * anything resolving records by exact id bounds its request by this number.
 */
export const INTENT_CONTEXT_ITEM_LIMIT = 20;

/**
 * How many candidates one review page carries — bounded by what ONE context
 * read can answer with, because each loaded page resolves its candidates' full
 * records and its predecessors' current versions by exact id.
 */
export const INTENT_REVIEW_PAGE_SIZE = INTENT_CONTEXT_ITEM_LIMIT;

/**
 * What a reviewer narrows the queue by. Paging belongs to the query option, not
 * to the caller: a `cursor` in the filter would give every page its own entry.
 */
export type IntentReviewQueueFilter = Omit<IntentReviewQueueQuery, 'cursor' | 'limit'>;

/** How many pages an exhaustive read follows before it stops. */
const EXHAUSTIVE_PAGE_LIMIT = 20;

/** The result of walking every page of a cursor-paged list, ceiling included. */
export interface IntentExhaustiveRead<T> {
  rows: T[];
  /** True when the ceiling stopped the walk while the server still had pages. */
  truncated: boolean;
}

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

/* ------------------------------------------------------------------ paths --- */

function intentPath(workspaceId: string, suffix: string, query?: URLSearchParams): string {
  const search = query && [...query.keys()].length > 0 ? `?${query.toString()}` : '';
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/intent/${suffix}${search}`;
}

/** Only defined values reach the query string. */
function intentQuery(entries: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params;
}

/** The paged-read query shape shared by every cursor-paged list route. */
const pageQuery = (cursor: string | undefined, limit = INTENT_BROWSE_PAGE_SIZE) => ({
  limit,
  ...(cursor === undefined ? {} : { cursor }),
});

const get = <T>(path: string) => request<T>(path);

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------------------------ reads --- */

/** The domain tree, page by page. */
export const intentTreeQueryOptions = (workspaceId: string, includeArchived: boolean) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'tree', workspaceId, includeArchived] as const,
    queryFn: ({ pageParam }) =>
      get<IntentTreeResponse>(
        intentPath(workspaceId, 'tree', intentQuery({ includeArchived, ...pageQuery(pageParam ?? undefined) })),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentTreeResponse) => last.nextCursor,
    staleTime: 60_000,
  });

/**
 * The workspace's context-dimension registry (intent-dimensions spec), for
 * READ-ONLY display beside the tree. Archived dimensions stay hidden; there is
 * no create/edit/archive UI (spec non-goal, `intent_tree` writes are agent
 * actions).
 */
export const intentDimensionsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'dimensions', workspaceId] as const,
    queryFn: () =>
      get<IntentDimensionsResponse>(intentPath(workspaceId, 'dimensions', intentQuery({ includeArchived: false }))),
    staleTime: 60_000,
  });

/** The browse index for one tree scope, page by page. */
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
      get<IntentItemsResponse>(
        intentPath(workspaceId, 'items', intentQuery({ ...query, ...pageQuery(pageParam ?? undefined) })),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentItemsResponse) => last.nextCursor,
    staleTime: 30_000,
  });

/**
 * The review queue: one page of waiting candidates, plus the filter's `total`
 * and the workspace's waiting summary, from the server's own route.
 */
/** Waiting candidates per tree node, for the browse tree's counts. */
export const intentPendingNodesQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'review-nodes', workspaceId] as const,
    queryFn: () => get<IntentPendingNodesResponse>(intentPath(workspaceId, 'review-queue/nodes')),
    staleTime: 30_000,
  });

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
      get<IntentReviewQueueResponse>(
        intentPath(
          workspaceId,
          'review-queue',
          intentQuery({ ...filter, ...pageQuery(pageParam ?? undefined, INTENT_REVIEW_PAGE_SIZE) }),
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentReviewQueueResponse) => last.nextCursor,
    staleTime: 30_000,
  });

/** The rich read (`mode=context`), by exact ids. `intentIds` is repeated, never comma-joined. */
function contextPath(workspaceId: string, query: IntentContextQuery): string {
  const params = intentQuery({
    mode: 'context',
    limit: query.limit,
    includeCandidates: query.includeCandidates,
  });
  for (const id of query.intentIds ?? []) params.append('intentIds', id);
  return intentPath(workspaceId, 'context', params);
}

/**
 * "Preview as": the browse scope read through the context LIST mode with a
 * reader `context`, because the items index takes no context. The context is
 * one JSON query parameter (like `files`) and already canonical, so it is the key.
 */
export const intentContextListQueryOptions = (workspaceId: string, query: IntentContextListQuery) =>
  infiniteQueryOptions({
    queryKey: [
      'intent',
      'context-list',
      workspaceId,
      query.domain ?? null,
      query.feature ?? null,
      query.kinds?.join(',') ?? null,
      query.query ?? null,
      query.includeCandidates,
      query.context,
    ] as const,
    queryFn: ({ pageParam }) =>
      get<IntentContextListResponse>(
        intentPath(
          workspaceId,
          'context',
          intentQuery({
            mode: 'list',
            domain: query.domain,
            feature: query.feature,
            kind: query.kinds?.join(','),
            query: query.query,
            includeCandidates: query.includeCandidates,
            // Labels each entry with its production state, as the browse list does.
            effectivity: true,
            context: query.context,
            ...pageQuery(pageParam ?? undefined),
          }),
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentContextListResponse) => last.nextCursor,
    staleTime: 30_000,
  });

/** One tree node as its document; neither id reads the product root. */
export const intentDocumentQueryOptions = (
  workspaceId: string,
  node: { domainId: string | null; featureId: string | null },
  includeCandidates: boolean,
) =>
  queryOptions({
    queryKey: ['intent', 'document', workspaceId, node.domainId, node.featureId, includeCandidates] as const,
    queryFn: () =>
      get<IntentNodeDocument>(
        intentPath(
          workspaceId,
          'document',
          intentQuery({
            domainId: node.featureId === null ? (node.domainId ?? undefined) : undefined,
            featureId: node.featureId ?? undefined,
            includeCandidates,
          }),
        ),
      ),
    staleTime: 30_000,
  });

/** The rich read for one item. `includeCandidates` is always on — the pane must open a candidate. */
export const intentItemContextQueryOptions = (workspaceId: string, itemId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'item-context', workspaceId, itemId] as const,
    queryFn: () => {
      if (itemId === null) throw new Error('No intent item selected');
      return get<IntentContextResponse>(
        contextPath(workspaceId, { intentIds: [itemId], includeCandidates: true, limit: 1 }),
      );
    },
    enabled: itemId !== null,
    staleTime: 30_000,
  });

/**
 * The workspace's most recent decisions — the product overview's feed, read
 * from the decision ledger rather than inferred from item state. First page
 * only: this is a glance at what the team just decided.
 */
export const intentTransitionsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'transitions', workspaceId] as const,
    queryFn: () =>
      get<IntentTransitionsResponse>(
        intentPath(workspaceId, 'transitions', intentQuery({ limit: INTENT_RECENT_DECISIONS_LIMIT })),
      ),
    staleTime: 30_000,
  });

/** Decision history for one item, newest page first, with older pages on request. */
export const intentItemTransitionsQueryOptions = (workspaceId: string, itemId: string | null) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'item-transitions', workspaceId, itemId] as const,
    queryFn: ({ pageParam }) => {
      if (itemId === null) throw new Error('No intent item selected');
      const query: IntentTransitionsQuery = pageQuery(pageParam ?? undefined, INTENT_HISTORY_PAGE_SIZE);
      return get<IntentTransitionsResponse>(
        intentPath(workspaceId, `items/${encodeURIComponent(itemId)}/transitions`, intentQuery({ ...query })),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: IntentTransitionsResponse) => last.nextCursor,
    enabled: itemId !== null,
    staleTime: 30_000,
  });

/**
 * Every feature of one domain — what "show all features" reads when the tree
 * route reports `featuresTruncated`.
 */
export const intentDomainFeaturesQueryOptions = (workspaceId: string, domainId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'domain-features', workspaceId, domainId] as const,
    queryFn: () => {
      if (domainId === null) throw new Error('No domain selected');
      return fetchAllPages<IntentFeatureView>(async (cursor) => {
        const query: IntentFeaturesQuery = { domainId, ...pageQuery(cursor) };
        const page = await get<IntentFeaturesResponse>(intentPath(workspaceId, 'features', intentQuery({ ...query })));
        return { rows: page.features, nextCursor: page.nextCursor };
      });
    },
    enabled: domainId !== null,
    staleTime: 30_000,
  });

/**
 * Every seed on a feature. Exhaustive rather than paged: this list is also the
 * only place a seed can be REMOVED, so a seed it never shows is a seed nobody
 * can delete.
 */
export const intentFeatureSeedsQueryOptions = (workspaceId: string, featureId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'feature-seeds', workspaceId, featureId] as const,
    queryFn: () => {
      if (featureId === null) throw new Error('No feature selected');
      return fetchAllPages<IntentFeatureSeed>(async (cursor) => {
        const page = await get<IntentFeatureSeedsResponse>(
          intentPath(
            workspaceId,
            `features/${encodeURIComponent(featureId)}/seeds`,
            intentQuery({ ...pageQuery(cursor) }),
          ),
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
export const submitIntentReview = (workspaceId: string, body: IntentReviewRequest) =>
  post<IntentReviewResponse>(intentPath(workspaceId, 'items/review'), body);

export const createIntentDomain = (workspaceId: string, body: IntentDomainCreateInput) =>
  post<IntentDomainMutationResponse>(intentPath(workspaceId, 'domains'), body);

export const updateIntentDomain = (workspaceId: string, body: IntentDomainUpdateInput) =>
  patch<IntentDomainMutationResponse>(intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}`), body);

export const archiveIntentDomain = (workspaceId: string, body: IntentArchiveInput) =>
  post<IntentDomainMutationResponse>(intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}/archive`), body);

export const deleteIntentDomain = (workspaceId: string, body: IntentDeleteInput) =>
  post<IntentDeleteResponse>(intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}/delete`), body);

export const createIntentFeature = (workspaceId: string, body: IntentFeatureCreateInput) =>
  post<IntentFeatureMutationResponse>(intentPath(workspaceId, 'features'), body);

export const updateIntentFeature = (workspaceId: string, body: IntentFeatureUpdateInput) =>
  patch<IntentFeatureMutationResponse>(intentPath(workspaceId, `features/${encodeURIComponent(body.id)}`), body);

export const archiveIntentFeature = (workspaceId: string, body: IntentArchiveInput) =>
  post<IntentFeatureMutationResponse>(intentPath(workspaceId, `features/${encodeURIComponent(body.id)}/archive`), body);

export const deleteIntentFeature = (workspaceId: string, body: IntentDeleteInput) =>
  post<IntentDeleteResponse>(intentPath(workspaceId, `features/${encodeURIComponent(body.id)}/delete`), body);

export const putIntentSeed = (workspaceId: string, body: IntentSeedPutInput) =>
  post<IntentSeedMutationResponse>(
    intentPath(workspaceId, `features/${encodeURIComponent(body.featureId)}/seeds`),
    body,
  );

export const deleteIntentSeed = (workspaceId: string, body: IntentSeedDeleteInput) =>
  post<IntentDeleteResponse>(
    intentPath(workspaceId, `features/${encodeURIComponent(body.featureId)}/seeds/delete`),
    body,
  );

/**
 * Re-capture one anchor's baseline. The ids in the path are ALSO in the body —
 * the server asserts the two agree — so both travel.
 */
export const refreshIntentAnchor = (workspaceId: string, body: IntentAnchorRefreshInput) =>
  post<IntentAnchorRefreshResponse>(
    intentPath(workspaceId, `items/${encodeURIComponent(body.itemId)}/anchors/refresh`),
    body,
  );

/**
 * Mint one idempotency key. Callers do not call this per click — they go through
 * `IntentAttemptKeys`, which reuses a key while the attempt's content is
 * unchanged (so a double-click or a retry replays instead of writing twice) and
 * mints a new one once the input changes, because the ledger keys on
 * `(key, request hash)`.
 */
export function newIntentIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Select the complete matching set only when it fits one release. Never silently
 * substitute the first page for "all results". Revalidation still pins content at confirmation. */
export async function selectMatchingIntentItems(workspaceId: string, query: IntentItemsQuery) {
  const result = await get<IntentItemsResponse>(
    intentPath(workspaceId, 'items', intentQuery({ ...query, limit: 200 })),
  );
  if (result.nextCursor)
    throw new Error(
      'More than 200 rules match. Narrow the search or choose a smaller domain or feature before selecting all.',
    );
  return result.items;
}

export interface IntentSourceOption {
  kind: string;
  ref: string;
  title: string | null;
  url: string | null;
}
export const intentSourceOptions = (workspaceId: string, search: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['intent', workspaceId, 'sources', search],
    queryFn: () =>
      get<{ sources: IntentSourceOption[]; truncated: boolean }>(
        intentPath(workspaceId, 'sources', intentQuery({ search })),
      ),
    enabled,
  });
