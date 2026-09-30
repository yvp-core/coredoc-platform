/**
 * What `IntentPanel` HANDS DOWN — the wiring lane B3 closes.
 *
 * Every view under the panel is pure props, so each of them is already tested
 * against its own inputs. What no view test can catch is the panel handing it
 * nothing: `predecessorItems`, `candidateItems`, `domainNames`, `featureNames`,
 * `onLoadMore` and `reviewerHandle` are all OPTIONAL on `IntentReviewQueueProps`
 * (they have honest fallbacks), so an unwired one type-checks and silently
 * degrades the surface. These tests render the panel and read the props the
 * children actually received.
 *
 * HOW IT RUNS. There is no jsdom in this package (vitest.config.ts is the node
 * environment), so the panel is rendered with `renderToStaticMarkup` over a
 * QueryClient pre-seeded with each query's exact key — the same device
 * `observability-panel.test.ts` uses — which makes every read synchronously
 * "fresh" without any IPC. `window.electronAPI` is mocked and empty on purpose:
 * a seeded read that still reached the bridge would throw here rather than pass.
 * The Review tab is reached by overriding `DEFAULT_INTENT_PANEL_TAB`, and a
 * non-root selection by overriding `INTENT_ROOT_SELECTION`, because a static
 * render can click neither the segmented control nor a tree row.
 */

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentAuthority,
  IntentItemKind,
  type IntentContextMatch,
  type IntentContextResponse,
  type IntentItemSummary,
  type IntentReviewQueueItem,
  type IntentTransition,
  type IntentTreeDomain,
} from '../../../shared/intent-types.js';
import {
  intentItemsByIdQueryOptions,
  intentItemsQueryOptions,
  intentReviewQueueQueryOptions,
  intentTransitionsQueryOptions,
  intentTreeQueryOptions,
} from './intent-api';
import { IntentPanelTab, type IntentTreeSelection } from './intent-panel-state';
import type { IntentItemDetailProps } from './IntentItemDetail';
import type { IntentOverviewProps } from './IntentOverview';
import type { IntentReviewQueueProps } from './IntentReviewQueue';

// GraphQueryProvider owns a module-private QueryClient singleton, which would
// shadow the seeded client this test wraps the panel in.
vi.mock('../../lib/graph-query-client', () => ({
  GraphQueryProvider: ({ children }: { children: ReactNode }) => children,
}));

/** Set per test; a static render has no way to press the Review segment. */
let forcedTab: IntentPanelTab | undefined;
/** Same device for the panel's initial tree selection — no row can be clicked. */
let forcedSelection: IntentTreeSelection | undefined;
vi.mock('./intent-panel-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./intent-panel-state')>();
  return {
    ...actual,
    get DEFAULT_INTENT_PANEL_TAB() {
      return forcedTab ?? actual.DEFAULT_INTENT_PANEL_TAB;
    },
    get INTENT_ROOT_SELECTION() {
      return forcedSelection ?? actual.INTENT_ROOT_SELECTION;
    },
  };
});

// Radix Tabs runs a layout effect the server renderer cannot honour, and the
// header has its own test — this keeps the panel's render quiet and on subject.
vi.mock('./IntentHeader', () => ({ IntentHeader: () => null }));
vi.mock('./IntentReleases', () => ({ IntentReleases: () => null }));

const reviewProps: IntentReviewQueueProps[] = [];
vi.mock('./IntentReviewQueue', () => ({
  IntentReviewQueue: (props: IntentReviewQueueProps) => {
    reviewProps.push(props);
    return null;
  },
}));

const detailProps: IntentItemDetailProps[] = [];
vi.mock('./IntentItemDetail', () => ({
  IntentItemDetail: (props: IntentItemDetailProps) => {
    detailProps.push(props);
    return null;
  },
}));

const overviewProps: IntentOverviewProps[] = [];
vi.mock('./IntentOverview', () => ({
  IntentOverview: (props: IntentOverviewProps) => {
    overviewProps.push(props);
    return null;
  },
}));

// Imported AFTER the mocks so the panel binds to them.
const { IntentPanel } = await import('./IntentPanel');

const WORKSPACE = 'ws-1';

const DOMAIN: IntentTreeDomain = {
  id: 'payments',
  title: 'Payments',
  statement: 'Money in and out.',
  archived: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  featuresTruncated: false,
  features: [
    {
      id: 'refunds',
      domainId: 'payments',
      title: 'Refunds',
      statement: 'Giving money back.',
      archived: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

const ITEM: IntentItemSummary = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 30 days',
  authority: IntentAuthority.Accepted,
  version: 3,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T10:00:00.000Z',
};

const CANDIDATE: IntentReviewQueueItem = {
  id: 'br-refunds-window-v2',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 45 days',
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: 'br-refunds-window',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

const match = (over: Partial<IntentContextMatch> & { id: string }): IntentContextMatch => ({
  ...ITEM,
  statement: 'A refund request is refused more than 30 days after the order.',
  rationale: null,
  payload: {},
  matchReason: 'exact_id',
  sources: [],
  anchors: [],
  ...over,
});

/** The wire shape around a set of matches; only `matches` is read here. */
const contextResponse = (matches: IntentContextMatch[]): IntentContextResponse => ({
  mode: 'context',
  limit: matches.length,
  matches,
  truncated: false,
  omittedCount: 0,
  totalMatched: matches.length,
  scanTruncated: false,
  unknownIntentIds: [],
  unresolvedNodeIds: [],
  matchedFeatureIds: [],
  evidence: { available: true },
  graph: { repos: [], truncated: false, limits: [] },
  anchorWarning: '',
  pendingReview: {
    waiting: 0,
    oldestWaitingAt: null,
    hasReplacementCandidate: false,
    byDomain: [],
    byDomainTruncated: false,
  },
});

const TRANSITION: IntentTransition = {
  id: 'tr-1',
  itemId: 'br-refunds-window',
  from: 'candidate',
  to: 'accepted',
  actorId: 'user-1',
  actorRole: 'owner',
  reason: 'Confirmed against the shipped guard.',
  authorizingSource: { kind: 'spec', ref: 'spec/refunds', localId: '§3', revision: null },
  workItem: null,
  createdAt: '2026-08-20T10:00:00.000Z',
};

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(intentTreeQueryOptions(WORKSPACE, false).queryKey, {
    pages: [{ domains: [DOMAIN], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(intentItemsQueryOptions(WORKSPACE, {}).queryKey, {
    pages: [{ items: [ITEM], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(intentTransitionsQueryOptions(WORKSPACE).queryKey, {
    transitions: [TRANSITION],
    nextCursor: null,
  });
  client.setQueryData(intentReviewQueueQueryOptions(WORKSPACE).queryKey, {
    pages: [
      {
        summary: {
          waiting: 1,
          oldestWaitingAt: CANDIDATE.createdAt,
          hasReplacementCandidate: true,
          byDomain: [],
          byDomainTruncated: false,
        },
        total: 1,
        items: [CANDIDATE],
        // A second page exists: `onLoadMore` must be offered.
        nextCursor: 'cur-2',
      },
    ],
    pageParams: [null],
  });
  // The two by-id reads the loaded queue page provokes.
  client.setQueryData(
    intentItemsByIdQueryOptions(WORKSPACE, [CANDIDATE.id]).queryKey,
    contextResponse([match({ id: CANDIDATE.id, title: CANDIDATE.title, statement: 'Refunds close after 45 days.' })]),
  );
  client.setQueryData(
    intentItemsByIdQueryOptions(WORKSPACE, ['br-refunds-window']).queryKey,
    contextResponse([match({ id: 'br-refunds-window' })]),
  );
  return client;
}

function render(props: { role?: string; reviewerHandle?: string } = {}): QueryClient {
  const client = seededClient();
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(IntentPanel, { workspaceId: WORKSPACE, workspaceSlug: 'acme', role: 'admin', ...props }),
    ),
  );
  return client;
}

beforeEach(() => {
  forcedTab = undefined;
  forcedSelection = undefined;
  reviewProps.length = 0;
  detailProps.length = 0;
  overviewProps.length = 0;
  (globalThis as { window?: unknown }).window = {
    electronAPI: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('IntentPanel → IntentReviewQueue wiring', () => {
  beforeEach(() => {
    forcedTab = IntentPanelTab.Review;
  });

  const props = (): IntentReviewQueueProps => {
    render({ reviewerHandle: 'reviewer@acme.test' });
    const last = reviewProps.at(-1);
    if (last === undefined) throw new Error('IntentReviewQueue was not rendered');
    return last;
  };

  it('hands over the full records of the candidates on the page', () => {
    // Without these the card has no statement and no source chips — the queue
    // row is the server's payload-free projection.
    const wired = props();
    expect(wired.candidateItems?.[CANDIDATE.id]?.statement).toBe('Refunds close after 45 days.');
  });

  it('hands over the predecessors those candidates name, and their versions', () => {
    const wired = props();
    expect(wired.predecessorItems?.['br-refunds-window']?.id).toBe('br-refunds-window');
    expect(wired.predecessorVersions['br-refunds-window']).toBe(ITEM.version);
    expect(wired.predecessorTitles?.['br-refunds-window']).toBe(ITEM.title);
    // Every named predecessor came back, so nothing is claimed to be missing.
    expect(wired.predecessorsTruncated).toBe(false);
  });

  it('names the tree nodes instead of leaving the queue to print ids', () => {
    const wired = props();
    expect(wired.domainNames?.payments).toBe('Payments');
    expect(wired.featureNames?.refunds).toBe('Refunds');
  });

  it('offers "load more" exactly when the server has another page', () => {
    expect(props().onLoadMore).toBeTypeOf('function');
    expect(props().candidatesTruncated).toBe(true);
  });

  it('passes the signed-in handle through for the manual-decision preset', () => {
    expect(props().reviewerHandle).toBe('reviewer@acme.test');
  });

  it('leaves the preset to its own fallback when no session handle is in hand', () => {
    render();
    expect(reviewProps.at(-1)?.reviewerHandle).toBeUndefined();
  });
});

describe('IntentPanel → browse wiring', () => {
  it('feeds the overview the workspace decision ledger, not item state', () => {
    render();
    expect(overviewProps.at(-1)?.decisions).toEqual([TRANSITION]);
  });

  it('gives the detail pane a freshness re-check it can call', () => {
    forcedSelection = { domainId: DOMAIN.id, featureId: null };
    render();
    const freshness = detailProps.at(-1)?.freshness;
    expect(freshness?.busy).toBe(false);
    expect(freshness?.onRecheck).toBeTypeOf('function');
    // Nothing failed yet, so nothing is claimed to have failed.
    expect(freshness?.errorMessage).toBeUndefined();
  });

  it('gives the product overview the detail column too while no item is selected', () => {
    // The overview answers about the whole workspace and has no subject for the
    // detail pane; rendering the third column anyway left it permanently idle.
    render();
    expect(overviewProps.length).toBeGreaterThan(0);
    expect(detailProps).toHaveLength(0);
  });

  it('offers a member the same edit affordances as an admin (AC-11)', () => {
    forcedSelection = { domainId: DOMAIN.id, featureId: null };
    render({ role: 'member' });
    expect(detailProps.at(-1)?.anchorRefresh?.onRequestRefresh).toBeInstanceOf(Function);
  });

  it('keeps the detail column on a domain view, which does have a subject', () => {
    forcedSelection = { domainId: DOMAIN.id, featureId: null };
    render();
    expect(detailProps.length).toBeGreaterThan(0);
  });
});

describe('IntentPanel re-fetch after a version conflict', () => {
  beforeEach(() => {
    forcedTab = IntentPanelTab.Review;
  });

  it('invalidates the caches the card versions actually come from', () => {
    const client = render();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wired = reviewProps.at(-1);
    if (wired === undefined) throw new Error('IntentReviewQueue was not rendered');

    wired.onRefetchConflicts(['br-refunds-window']);

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    // The candidate's version lives on the queue page and the predecessors'
    // versions in the by-id reads. The browse index carries neither.
    expect(keys).toContainEqual(['intent', 'review-queue', WORKSPACE]);
    expect(keys).toContainEqual(['intent', 'items-by-id', WORKSPACE]);
    expect(keys).toContainEqual(['intent', 'item-context', WORKSPACE, 'br-refunds-window']);
    expect(keys).not.toContainEqual(['intent', 'items']);
  });

  it('tells the queue whether the predecessor reads have settled', () => {
    render();
    // Every by-id read is seeded, so nothing is in flight and nothing is claimed
    // to be missing either.
    expect(reviewProps.at(-1)?.predecessorsLoading).toBe(false);
  });
});
