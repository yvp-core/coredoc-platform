import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { effectivityLabels, type IntentEffectivity } from './release-types.js';
import { intentSourceOptions, type IntentSourceOption } from '../../api/queries/intent.js';
import { Input } from '@/components/ui/input';
/**
 * The intent knowledge base surface.
 *
 * This component owns browsing, review, and the delivery selection. Release
 * controls own their versioned previews and writes. Two boundaries are deliberate:
 *
 * - **Role.** `role` comes from the workspace row and gates the decision batch
 *   and the tree editor. It is a UI affordance, not a security boundary: the
 *   server refuses both for anyone but an admin/owner on a user session,
 *   whatever this renderer shows.
 * - **Reads follow the tree, not the click.** A feature's items are read at the
 *   DOMAIN's scope, once, because the items route filters by exactly one node
 *   and a feature's applicable set includes what the domain above it declares.
 *   The split into "attached here" and "inherited" is then a pure derivation
 *   (`intent-panel-state.ts`) rather than a second round trip.
 */

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { hasAdminAccess } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  archiveIntentDomain,
  archiveIntentFeature,
  createIntentDomain,
  createIntentFeature,
  deleteIntentDomain,
  deleteIntentFeature,
  deleteIntentSeed,
  intentContextListQueryOptions,
  intentDimensionsQueryOptions,
  intentDomainFeaturesQueryOptions,
  intentFeatureSeedsQueryOptions,
  intentItemContextQueryOptions,
  intentItemTransitionsQueryOptions,
  intentItemsByIdQueryOptions,
  intentItemsQueryOptions,
  selectMatchingIntentItems,
  intentPredecessorsQueryOptions,
  intentReviewQueueQueryOptions,
  intentTreeQueryOptions,
  putIntentSeed,
  refreshIntentAnchor,
  submitIntentReview,
  updateIntentDomain,
  updateIntentFeature,
} from '@/api/queries/intent';
import { IntentEmptyState } from './empty-state.js';
import { IntentItemDetail } from './item-detail.js';
import { IntentItemsList } from './items-list.js';
import { IntentContextPreview } from './context-preview.js';
import { IntentNodePanel } from './node-panel.js';
import { IntentReleases, type ReleaseSelectionItem } from './releases.js';
import { IntentReviewQueue } from './review-queue.js';
import { IntentTreeBrowser } from './tree-browser.js';
import { IntentTreeEditor } from './tree-editor.js';
import type { IntentAnchorRefreshOutcome } from './anchor-row.js';
import { IntentAttemptKeys, IntentWriteForm } from './intent-attempt-keys.js';
import {
  DEFAULT_INTENT_ITEM_FILTER,
  INTENT_ROOT_SELECTION,
  IntentBrowseState,
  intentAnchorKey,
  intentBrowseState,
  intentItemsInScope,
  intentKnownCount,
  intentMatchesById,
  intentScopeCounts,
  intentTreeNames,
  versionsById,
  IntentPanelTab,
  type IntentItemFilter,
  type IntentTreeSelection,
} from './intent-panel-state.js';
import { canonicalPreviewContext, formatIntentTimestamp } from './intent-presentation.js';
import { buildReviewRequest, type IntentDraftDecision, type IntentProvenanceForm } from './intent-review-request.js';
import type {
  DimensionValueSelection,
  IntentItemAnchor,
  IntentItemKind,
  IntentItemSummary,
  IntentReviewDecisionResult,
} from './types.js';

export interface IntentPanelProps {
  workspaceId: string;
  role: string;
  tab: IntentPanelTab;
  /** The signed-in user's handle, for the review batch's "Manual decision" preset. */
  reviewerHandle?: string;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
}

const messageOf = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : error ? String(error) : undefined;

export function IntentPanel({
  workspaceId: id,
  role,
  tab,
  reviewerHandle,
  selectedItemId,
  onSelectItem: setSelectedItemId,
}: IntentPanelProps) {
  const queryClient = useQueryClient();
  const canEdit = hasAdminAccess(role);

  const [includeArchived, setIncludeArchived] = useState(false);
  const [selection, setSelection] = useState<IntentTreeSelection>(INTENT_ROOT_SELECTION);
  const [deliverySelection, setDeliverySelection] = useState<ReleaseSelectionItem[]>([]);
  const deliverySelectionRef = useRef(deliverySelection);
  deliverySelectionRef.current = deliverySelection;
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [filter, setFilter] = useState<IntentItemFilter>(DEFAULT_INTENT_ITEM_FILTER);
  const [effectivity, setEffectivity] = useState<IntentEffectivity | ''>('');
  const [source, setSource] = useState<IntentSourceOption | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceTerm, setSourceTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSourceTerm(sourceSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [sourceSearch]);
  const sourcesQuery = useQuery(intentSourceOptions(id, sourceTerm, sourceOpen));
  const [search, setSearch] = useState('');
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionPending = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filter.search.trim()), 250);
    return () => clearTimeout(timer);
  }, [filter.search]);
  const [reviewResults, setReviewResults] = useState<IntentReviewDecisionResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [treeWriteBusy, setTreeWriteBusy] = useState(false);
  const [treeWriteError, setTreeWriteError] = useState<unknown>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);

  // Anchor refresh: which confirm is open, which write is in flight, what each
  // landed refresh moved, and the one refusal on screen.
  const [anchorConfirmKey, setAnchorConfirmKey] = useState<string | null>(null);
  const [anchorRefreshingKey, setAnchorRefreshingKey] = useState<string | null>(null);
  const [anchorOutcomes, setAnchorOutcomes] = useState<Record<string, IntentAnchorRefreshOutcome>>({});
  const [anchorErrorKey, setAnchorErrorKey] = useState<string | null>(null);
  const [anchorError, setAnchorError] = useState<unknown>(null);

  /**
   * One write at a time, latched in a ref rather than in state: two clicks
   * dispatched in the same frame would both read a stale `false` from state, and
   * two writes is exactly the defect being closed.
   */
  const writeInFlight = useRef(false);
  /** One idempotency key per logical attempt — see `intent-attempt-keys.ts`. */
  const attemptKeys = useRef(new IntentAttemptKeys());

  const treeQuery = useInfiniteQuery(intentTreeQueryOptions(id, includeArchived));
  const domains = useMemo(() => treeQuery.data?.pages.flatMap((page) => page.domains) ?? null, [treeQuery.data]);
  const dimensionsQuery = useQuery(intentDimensionsQueryOptions(id));

  // Keep structure counts independent of catalogue filters.
  const itemsQuery = useInfiniteQuery(
    intentItemsQueryOptions(id, selection.domainId ? { domainId: selection.domainId } : {}),
  );
  const items = useMemo(() => itemsQuery.data?.pages.flatMap((page) => page.items) ?? null, [itemsQuery.data]);
  const browseQuery = {
    production: 'true' as const,
    ...(effectivity ? { effectivity } : {}),
    ...(source ? { sourceRef: source.ref, sourceKind: source.kind } : {}),
    ...(selection.domainId ? { domainId: selection.domainId } : {}),
    ...(selection.featureId ? { scopeFeatureId: selection.featureId } : {}),
    ...(search ? { search } : {}),
    authorities: [
      'accepted',
      ...(filter.includeCandidates ? ['candidate'] : []),
      ...(filter.includeResolved ? ['rejected', 'superseded'] : effectivity ? ['superseded'] : []),
    ].join(','),
    ...(filter.kinds.length ? { kinds: [...filter.kinds].sort().join(',') } : {}),
  };
  const resultsQuery = useInfiniteQuery(intentItemsQueryOptions(id, browseQuery));
  const results = useMemo(() => resultsQuery.data?.pages.flatMap((page) => page.items) ?? [], [resultsQuery.data]);

  // "Preview as": the items index takes no reader context, so a chosen context
  // routes the list through the context read's list mode, same scope. Component
  // state only — never persisted. The canonical JSON is the stable query key.
  const [preview, setPreview] = useState<DimensionValueSelection>({});
  const previewContext = useMemo(() => canonicalPreviewContext(preview), [preview]);
  const previewing = previewContext !== null;
  const previewQuery = useInfiniteQuery({
    ...intentContextListQueryOptions(id, {
      ...(selection.domainId ? { domain: selection.domainId } : {}),
      ...(selection.featureId ? { feature: selection.featureId } : {}),
      ...(filter.kinds.length ? { kinds: [...filter.kinds].sort() as IntentItemKind[] } : {}),
      // The context read refuses more than ten query tokens.
      ...(search ? { query: search.split(/\s+/).slice(0, 10).join(' ') } : {}),
      includeCandidates: filter.includeCandidates,
      context: previewContext ?? '',
    }),
    enabled: previewing,
  });
  const previewRows = useMemo<IntentItemSummary[]>(
    () =>
      // List entries carry no relation fields or timestamp; a preview row shows none.
      (previewQuery.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => ({
        ...entry,
        proposedSuccessorOfId: null,
        supersededById: null,
        updatedAt: '',
      })),
    [previewQuery.data],
  );
  // Not a sum: each page's server window overlaps the next (the cursor resumes
  // after the last KEPT row), so summing `contextExcluded` across pages double-
  // counts rows the next page's window re-scans. The first page's window starts
  // at the top of the list with nothing to overlap, so its count is the only one
  // that's never inflated — use it, and once more pages have loaded (each one
  // hides more rows we never re-count), label it as a lower bound instead of
  // pretending it is exact.
  const previewPageCount = previewQuery.data?.pages.length ?? 0;
  const previewHidden = useMemo(() => {
    const pages = previewQuery.data?.pages ?? [];
    return pages[0]?.contextExcluded ?? 0;
  }, [previewQuery.data]);
  const previewHiddenIsLowerBound = previewPageCount > 1;
  const previewIgnored = [
    ...(effectivity ? ['production status'] : []),
    ...(source ? ['source'] : []),
    ...(filter.includeResolved ? ['resolved rules'] : []),
  ];
  const listQuery = previewing ? previewQuery : resultsQuery;
  const searching = search !== filter.search.trim() || resultsQuery.isFetching;
  async function selectAllMatching() {
    // Reads the unfiltered browse query — never while a context preview hides rows.
    if (selectionPending.current || searching || previewing) return;
    selectionPending.current = true;
    setSelectingAll(true);
    setSelectionError(null);
    try {
      const matching = await selectMatchingIntentItems(id, {
        ...browseQuery,
        authorities: browseQuery.authorities
          .split(',')
          .filter((value) => value === 'accepted' || value === 'superseded')
          .join(','),
      });
      const current = deliverySelectionRef.current;
      const added = matching
        .filter((item) => !current.some((row) => row.id === item.id))
        .map((item) => ({ id: item.id, title: item.title }));
      if (current.length + added.length > 200)
        throw new Error(
          'Together with the existing selection this exceeds 200 rules. Clear the selection or narrow the filters.',
        );
      setDeliverySelection([...current, ...added]);
    } catch (error) {
      setSelectionError(messageOf(error) ?? 'Could not select matching rules');
    } finally {
      selectionPending.current = false;
      setSelectingAll(false);
    }
  }

  const detailQuery = useQuery(intentItemContextQueryOptions(id, selectedItemId));
  const transitionsQuery = useInfiniteQuery(intentItemTransitionsQueryOptions(id, selectedItemId));
  const transitions = useMemo(
    () => transitionsQuery.data?.pages.flatMap((page) => page.transitions) ?? null,
    [transitionsQuery.data],
  );
  const seedsQuery = useQuery(intentFeatureSeedsQueryOptions(id, selection.featureId));
  const domainFeaturesQuery = useQuery(intentDomainFeaturesQueryOptions(id, expandedDomainId));

  // Review reads the server's queue route: entering the tab costs its summary
  // plus one page, and the size of the backlog arrives with them.
  const queueQuery = useInfiniteQuery({
    ...intentReviewQueueQueryOptions(id),
    enabled: tab === IntentPanelTab.Review,
  });
  const queuePages = useMemo(() => queueQuery.data?.pages ?? [], [queueQuery.data]);
  const candidates = useMemo(
    () => (queueQuery.data === undefined ? null : queuePages.flatMap((page) => page.items)),
    [queueQuery.data, queuePages],
  );

  /**
   * Two context reads PER LOADED PAGE, both by exact id: the candidates' own
   * records (the queue row is the server's payload-free projection, and a
   * statement is what a reviewer decides on) and the predecessors those rows
   * name (a supersession checks the version on BOTH items, and that version must
   * be the CURRENT one). Per page, because a context read answers at most
   * `INTENT_CONTEXT_ITEM_LIMIT` items and refuses a bigger `limit` outright.
   */
  const candidateRecordQueries = useQueries({
    queries: queuePages.map((page) =>
      intentItemsByIdQueryOptions(
        id,
        page.items.map((row) => row.id),
      ),
    ),
  });
  const predecessorQueries = useQueries({
    queries: queuePages.map((page) =>
      intentPredecessorsQueryOptions(
        id,
        page.items.map((row) => row.proposedSuccessorOfId).filter((value): value is string => value !== null),
      ),
    ),
  });

  const candidateItems = intentMatchesById(candidateRecordQueries.flatMap((query) => query.data?.matches ?? []));
  const predecessorMatches = predecessorQueries.flatMap((query) => query.data?.matches ?? []);
  const predecessorItems = intentMatchesById(predecessorMatches);
  const predecessorVersions = versionsById(predecessorMatches);
  const predecessorTitles = Object.fromEntries(predecessorMatches.map((row) => [row.id, row.title]));
  const predecessorIds = new Set(
    (candidates ?? []).map((row) => row.proposedSuccessorOfId).filter((value): value is string => value !== null),
  );
  /** A record that has not arrived is not a record that could not be read. */
  const predecessorsLoading = predecessorQueries.some((query) => query.isLoading);

  // Product-root items keep a domain-less workspace out of the onboarding state.
  // The root scope is what an empty tree can only be showing, so the item pages
  // already in hand carry the count — no extra read.
  const rootItemCount = useMemo(
    () => (items === null ? null : items.filter((row) => row.domainId === null && row.featureId === null).length),
    [items],
  );

  const browseState = intentBrowseState({
    treeLoading: treeQuery.isLoading,
    treeError: treeQuery.isError,
    domainCount: domains === null ? null : domains.length,
    rootItemCount,
  });

  /**
   * A workspace whose domains are ALL archived reads as empty, because the
   * default tree read hides them — and the invitation alone would be a dead end
   * with no way back. Only then is the archived tree read, and only to say how
   * many are hidden.
   */
  const archivedTreeQuery = useInfiniteQuery({
    ...intentTreeQueryOptions(id, true),
    enabled: browseState === IntentBrowseState.Empty && !includeArchived,
  });
  const archivedDomainCount = archivedTreeQuery.data?.pages.flatMap((page) => page.domains).length ?? 0;

  /* ------------------------------------------------------- derived views --- */

  const scopedItems = useMemo(
    () => intentItemsInScope(previewing ? previewRows : results, selection),
    [previewing, previewRows, results, selection],
  );
  const shownItems = scopedItems;
  const counts = useMemo(
    () =>
      intentScopeCounts({
        items,
        scopeDomainId: selection.domainId,
        // A count is only honest once every page of the scope is in hand.
        complete: items !== null && !itemsQuery.hasNextPage && !itemsQuery.isFetching,
      }),
    [items, selection.domainId, itemsQuery.hasNextPage, itemsQuery.isFetching],
  );

  const treeNames = useMemo(
    () => intentTreeNames(domains, domainFeaturesQuery.data?.rows ?? null),
    [domains, domainFeaturesQuery.data],
  );
  const featureTitles = treeNames.features;

  const selectedDomain = useMemo(
    () => (domains ?? []).find((domain) => domain.id === selection.domainId) ?? null,
    [domains, selection.domainId],
  );

  const selectedScope = useMemo(() => {
    if (selection.featureId === null) return selectedDomain;
    // The tree carries a bounded feature list per domain; the expanded domain's
    // full list covers features past that bound.
    const features = [...(selectedDomain?.features ?? []), ...(domainFeaturesQuery.data?.rows ?? [])];
    return features.find((feature) => feature.id === selection.featureId) ?? null;
  }, [selectedDomain, selection.featureId, domainFeaturesQuery.data]);

  const itemsTitle =
    selection.domainId === null
      ? 'Whole product'
      : selection.featureId === null
        ? (selectedDomain?.title ?? selection.domainId)
        : `${selectedDomain?.title ?? selection.domainId} · ${featureTitles[selection.featureId] ?? selection.featureId}`;

  const detailMatch = detailQuery.data?.matches[0] ?? null;

  // A selected domain/feature with no rule open gets the node panel in the third column.
  const nodeCount =
    selection.featureId !== null
      ? intentKnownCount(counts.features[selection.featureId], counts)
      : selection.domainId !== null
        ? intentKnownCount(counts.domains[selection.domainId], counts)
        : null;
  const nodeFeature = selection.featureId === null ? null : selectedScope;
  const showNodePanel = selectedDomain !== null && (selection.featureId === null || nodeFeature !== null);
  const thirdColumn = selectedItemId !== null || showNodePanel;

  /* ------------------------------------------------------------- writes --- */

  /** Rows are the truth: after any write, everything intent-scoped is re-read. */
  const invalidateIntent = () => queryClient.invalidateQueries({ queryKey: ['intent'] });

  /**
   * Run one tree write: at most one in flight, and the SAME idempotency key for
   * a repeated attempt with the same input (a double-click, or a retry after a
   * transport error) so the server replays instead of writing twice.
   */
  const runWrite = async <T extends object>(
    form: IntentWriteForm,
    input: T,
    write: (body: T & { idempotencyKey: string }) => Promise<unknown>,
  ): Promise<boolean> => {
    if (writeInFlight.current) return false;
    writeInFlight.current = true;
    setTreeWriteBusy(true);
    setTreeWriteError(null);
    try {
      const body = { ...input, idempotencyKey: attemptKeys.current.keyFor(form, input) } as T & {
        idempotencyKey: string;
      };
      await write(body);
      attemptKeys.current.settle(form);
      await invalidateIntent();
      return true;
    } catch (error) {
      // The key is deliberately NOT settled: pressing again with the same input
      // replays this attempt rather than starting a second one.
      setTreeWriteError(error);
      return false;
    } finally {
      writeInFlight.current = false;
      setTreeWriteBusy(false);
    }
  };

  /**
   * Re-capture one anchor's baseline. Two clicks — the button opens the confirm,
   * the confirm writes — because a refresh asserts that the code moved and the
   * intent still holds, which only a human can say.
   */
  const onConfirmRefresh = async (anchor: IntentItemAnchor) => {
    if (writeInFlight.current || selectedItemId === null) return;
    const key = intentAnchorKey(anchor);
    const input = { itemId: selectedItemId, repoKey: anchor.repoKey, nodeId: anchor.nodeId };
    writeInFlight.current = true;
    setAnchorRefreshingKey(key);
    setAnchorErrorKey(null);
    setAnchorError(null);
    try {
      const idempotencyKey = attemptKeys.current.keyFor(IntentWriteForm.RefreshAnchor, input);
      const response = await refreshIntentAnchor(id, { ...input, idempotencyKey });
      attemptKeys.current.settle(IntentWriteForm.RefreshAnchor);
      setAnchorOutcomes((current) => ({
        ...current,
        [key]: {
          previousCapturedVersionedId: response.previousCapturedVersionedId,
          capturedVersionedId: response.anchor.capturedVersionedId,
          changed: response.changed,
        },
      }));
      setAnchorConfirmKey(null);
      // The new status comes from the server, not from an optimistic guess: the
      // mark is a read-time verdict against the snapshot (§6.4).
      await queryClient.invalidateQueries({ queryKey: ['intent', 'item-context', id, selectedItemId] });
    } catch (error) {
      // Rendered BESIDE the anchor row; the pane and its other anchors survive.
      setAnchorErrorKey(key);
      setAnchorError(error);
    } finally {
      writeInFlight.current = false;
      setAnchorRefreshingKey(null);
    }
  };

  const onSubmitReview = async (drafts: IntentDraftDecision[], provenance: IntentProvenanceForm) => {
    if (writeInFlight.current) return;
    // One key per batch attempt: unchanged decisions retry under the same key
    // (the server replays its answer), while a corrected batch is a new attempt
    // and gets a new key — the ledger keys on (key, request hash).
    const key = attemptKeys.current.keyFor(IntentWriteForm.ReviewBatch, { drafts, provenance });
    const built = buildReviewRequest(provenance, drafts, key);
    if (!built.ok) return;
    writeInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await submitIntentReview(id, built.request);
      setReviewResults(response.decisions);
      attemptKeys.current.settle(IntentWriteForm.ReviewBatch);
      await invalidateIntent();
    } catch (error) {
      // Rendered BESIDE the queue: the reviewer's typed decisions stay on screen.
      setSubmitError(error);
    } finally {
      writeInFlight.current = false;
      setSubmitting(false);
    }
  };

  /**
   * Re-fetch exactly the ids a stale-version refusal named — nothing wider, and
   * no automatic re-submission: the reviewer sees the current state and decides
   * again (spec §5).
   */
  const onRefetchConflicts = (itemIds: string[]) => {
    // The versions the cards are judged against live in exactly two caches: the
    // queue page (the candidate's own version) and the by-id reads.
    void queryClient.invalidateQueries({ queryKey: ['intent', 'review-queue', id] });
    void queryClient.invalidateQueries({ queryKey: ['intent', 'items-by-id', id] });
    for (const itemId of itemIds) {
      void queryClient.invalidateQueries({ queryKey: ['intent', 'item-context', id, itemId] });
    }
    setReviewResults((current) =>
      // Keep the refusals on screen (they carry the current versions) but drop
      // any decision the reviewer no longer has to act on.
      current === null ? null : current.filter((result) => itemIds.includes(result.itemId)),
    );
  };

  const onSelect = (next: IntentTreeSelection) => {
    setSelection(next);
    setSelectedItemId(null);
  };

  const toggleKind = (kind: IntentItemKind) =>
    setFilter((current) => ({
      ...current,
      kinds: current.kinds.includes(kind) ? current.kinds.filter((entry) => entry !== kind) : [...current.kinds, kind],
    }));

  /* -------------------------------------------------------------- render --- */

  if (tab === IntentPanelTab.Review) {
    return (
      <IntentReviewQueue
        candidates={candidates}
        predecessorVersions={predecessorVersions}
        predecessorTitles={predecessorTitles}
        predecessorItems={predecessorItems}
        candidateItems={candidateItems}
        domainNames={treeNames.domains}
        featureNames={treeNames.features}
        // Compared against the DISTINCT ids that came back: two pages naming the
        // same predecessor return it twice, and counting rows would let a
        // duplicate stand in for a predecessor that never arrived.
        predecessorsLoading={predecessorsLoading}
        predecessorsTruncated={predecessorIds.size > Object.keys(predecessorItems).length}
        candidatesTruncated={queueQuery.hasNextPage}
        {...(queueQuery.hasNextPage ? { onLoadMore: () => void queueQuery.fetchNextPage() } : {})}
        loading={queueQuery.isLoading}
        canReview={canEdit}
        submitting={submitting}
        {...(reviewerHandle === undefined ? {} : { reviewerHandle })}
        results={reviewResults}
        // Only a failed QUEUE READ replaces the surface; a failed submit is
        // rendered inside it, so the typed decisions survive.
        errorMessage={messageOf(queueQuery.error)}
        submitErrorMessage={messageOf(submitError)}
        onSubmit={(drafts, provenance) => void onSubmitReview(drafts, provenance)}
        onRefetchConflicts={onRefetchConflicts}
        onRetry={() => void queueQuery.refetch()}
      />
    );
  }

  if (browseState === IntentBrowseState.Loading) {
    return (
      <Card className="flex min-h-[240px] items-center justify-center">
        <Spinner className="text-ink-4" />
      </Card>
    );
  }

  if (browseState === IntentBrowseState.Error) {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <p className="text-[12.5px] text-ink-2">Couldn't load the intent tree.</p>
        {messageOf(treeQuery.error) && <p className="max-w-md text-[11px] text-ink-4">{messageOf(treeQuery.error)}</p>}
        <Button variant="outline" size="sm" onClick={() => void treeQuery.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const editor = canEdit && (
    <IntentTreeEditor
      open={editorOpen}
      onOpenChange={setEditorOpen}
      domains={domains}
      selectedDomainId={selection.domainId}
      selectedFeatureId={selection.featureId}
      seeds={seedsQuery.data?.rows ?? null}
      seedsTruncated={seedsQuery.data?.truncated ?? false}
      busy={treeWriteBusy}
      errorMessage={messageOf(treeWriteError)}
      onCreateDomain={(input) => runWrite(IntentWriteForm.CreateDomain, input, (body) => createIntentDomain(id, body))}
      onCreateFeature={(input) =>
        runWrite(IntentWriteForm.CreateFeature, input, (body) => createIntentFeature(id, body))
      }
      onRenameDomain={(input) => runWrite(IntentWriteForm.RenameDomain, input, (body) => updateIntentDomain(id, body))}
      onRenameFeature={(input) =>
        runWrite(IntentWriteForm.RenameFeature, input, (body) => updateIntentFeature(id, body))
      }
      onArchiveDomain={(input) =>
        void runWrite(IntentWriteForm.ArchiveDomain, input, (body) => archiveIntentDomain(id, body))
      }
      onArchiveFeature={(input) =>
        void runWrite(IntentWriteForm.ArchiveFeature, input, (body) => archiveIntentFeature(id, body))
      }
      onDeleteDomain={(input) =>
        void runWrite(IntentWriteForm.DeleteDomain, input, (body) => deleteIntentDomain(id, body))
      }
      onDeleteFeature={(input) =>
        void runWrite(IntentWriteForm.DeleteFeature, input, (body) => deleteIntentFeature(id, body))
      }
      onAddSeed={(input) => runWrite(IntentWriteForm.AddSeed, input, (body) => putIntentSeed(id, body))}
      onRemoveSeed={(input) => void runWrite(IntentWriteForm.RemoveSeed, input, (body) => deleteIntentSeed(id, body))}
    />
  );

  if (browseState === IntentBrowseState.Empty) {
    return (
      <Card>
        <IntentEmptyState
          canEdit={canEdit}
          archivedDomainCount={archivedDomainCount}
          onShowArchived={() => setIncludeArchived(true)}
          onCreateFirstDomain={() => setEditorOpen(true)}
        />
        {editor}
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border-soft bg-surface p-4">
        <h2 className="font-medium text-ink-1">Your product rules, from decision to production</h2>
        <p className="mt-1 text-sm text-ink-3">
          Open a rule to see its intent, code links and production state together. Select rules below to confirm a
          delivery, or choose “Already in production” to establish your starting point.
        </p>
      </div>
      <div className="sticky top-2 z-20">
        <IntentReleases
          workspaceId={id}
          role={role}
          view="selection"
          selection={deliverySelection}
          onSelectionChange={setDeliverySelection}
          onOpenItem={setSelectedItemId}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 text-xs text-ink-3">
          <span className="block">Production status</span>
          <Select
            value={effectivity || 'all'}
            onValueChange={(value) => setEffectivity(value === 'all' ? '' : (value as IntentEffectivity))}
          >
            <SelectTrigger aria-label="Production status" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All production states</SelectItem>
              {Object.entries(effectivityLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="default" onClick={() => setSourceOpen(!sourceOpen)}>
          {source ? `Source: ${source.title || source.ref}` : 'Choose spec or issue'}
        </Button>
        {source && (
          <Button variant="ghost" size="default" onClick={() => setSource(null)}>
            Clear source filter
          </Button>
        )}
      </div>
      {sourceOpen && (
        <Card className="space-y-2 p-3">
          <Input
            type="search"
            aria-label="Find source"
            placeholder="Find a spec, issue or ADR by title or reference…"
            maxLength={200}
            value={sourceSearch}
            onChange={(e) => setSourceSearch(e.target.value)}
          />
          {sourcesQuery.isFetching || sourceSearch.trim() !== sourceTerm ? (
            <p className="text-xs text-ink-3">Finding sources…</p>
          ) : sourcesQuery.error ? (
            <p role="alert">{messageOf(sourcesQuery.error)}</p>
          ) : (
            <>
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {sourcesQuery.data?.sources.map((option) => (
                  <button
                    type="button"
                    key={`${option.kind}:${option.ref}`}
                    className="block w-full rounded p-2 text-left text-sm text-ink-1 hover:bg-surface-2"
                    onClick={() => {
                      setSource(option);
                      setSourceOpen(false);
                    }}
                  >
                    <span className="block">{option.title || option.ref}</span>
                    <span className="block break-all text-xs text-ink-3">
                      {option.kind} · {option.ref}
                    </span>
                  </button>
                ))}
              </div>
              {sourcesQuery.data?.sources.length === 0 && <p className="text-xs text-ink-3">No matching sources.</p>}
              {sourcesQuery.data?.truncated && (
                <p className="text-xs text-ink-3">Showing 50 sources. Narrow the search to find more.</p>
              )}
            </>
          )}
        </Card>
      )}
      <p className="text-xs text-ink-3">
        Production status reflects recorded evidence. Approval alone does not mean a rule is in production.
      </p>
      {selectionError && (
        <p role="alert" className="text-sm text-danger-text">
          {selectionError}
        </p>
      )}
      {listQuery.error && (
        <p role="alert" className="text-sm text-danger-text">
          {messageOf(listQuery.error)}
        </p>
      )}
      <Card className="grid min-h-[640px] grid-cols-[220px_minmax(0,1fr)] min-[1100px]:grid-cols-[250px_minmax(300px,1fr)_minmax(360px,1.15fr)]">
        <div className="flex min-w-0 flex-col">
          <ColHead title="Structure" />
          <IntentTreeBrowser
            domains={domains}
            dimensions={dimensionsQuery.data?.dimensions ?? null}
            counts={counts}
            featureExpansion={{
              domainId: expandedDomainId,
              features: domainFeaturesQuery.data?.rows ?? null,
              loading: domainFeaturesQuery.isFetching,
              truncated: domainFeaturesQuery.data?.truncated ?? false,
              errorMessage: messageOf(domainFeaturesQuery.error),
            }}
            selection={selection}
            includeArchived={includeArchived}
            canEdit={canEdit}
            hasMoreDomains={treeQuery.hasNextPage}
            loadingMoreDomains={treeQuery.isFetchingNextPage}
            onSelect={onSelect}
            onToggleArchived={() => setIncludeArchived((value) => !value)}
            onEditTree={() => setEditorOpen(true)}
            onLoadMoreDomains={() => void treeQuery.fetchNextPage()}
            onShowAllFeatures={setExpandedDomainId}
          />
        </div>

        <div
          className={cn(
            'flex min-w-0 flex-col border-l border-border-soft',
            thirdColumn ? '' : 'min-[1100px]:col-span-2',
          )}
        >
          <ColHead title={itemsTitle} right={`${shownItems.length} of ${scopedItems.length} loaded`} />
          <IntentContextPreview
            dimensions={dimensionsQuery.data?.dimensions ?? null}
            value={preview}
            onChange={setPreview}
            hiddenCount={previewing ? previewHidden : null}
            hiddenCountIsLowerBound={previewing && previewHiddenIsLowerBound}
            ignoredFilters={previewIgnored}
          />
          <IntentItemsList
            items={shownItems}
            deliverySelection={deliverySelection.map((item) => item.id)}
            canSelectForDelivery={canEdit}
            selectingAll={selectingAll || searching}
            onSelectAllMatching={() => void selectAllMatching()}
            selectAllMatchingDisabledReason={
              previewing
                ? 'Clear the context preview to select all matching rules — it cannot honor the preview.'
                : null
            }
            onToggleDelivery={(item) =>
              setDeliverySelection((current) =>
                current.some((row) => row.id === item.id)
                  ? current.filter((row) => row.id !== item.id)
                  : [...current, { id: item.id, title: item.title }],
              )
            }
            onSelectVisible={() =>
              setDeliverySelection((current) => {
                const remaining = shownItems.filter(
                  (item) =>
                    (item.authority === 'accepted' || item.authority === 'superseded') &&
                    !current.some((row) => row.id === item.id),
                );
                return [
                  ...current,
                  ...remaining
                    .slice(0, Math.max(0, 200 - current.length))
                    .map((item) => ({ id: item.id, title: item.title })),
                ];
              })
            }
            scopedCount={scopedItems.length}
            filter={filter}
            selection={selection}
            featureTitles={featureTitles}
            dimensions={dimensionsQuery.data?.dimensions ?? null}
            selectedItemId={selectedItemId}
            loading={listQuery.isLoading || search !== filter.search.trim()}
            hasMore={listQuery.hasNextPage}
            loadingMore={listQuery.isFetchingNextPage}
            onSearch={(search) => setFilter((current) => ({ ...current, search }))}
            onToggleKind={toggleKind}
            onToggleCandidates={() =>
              setFilter((current) => ({ ...current, includeCandidates: !current.includeCandidates }))
            }
            onToggleResolved={() => setFilter((current) => ({ ...current, includeResolved: !current.includeResolved }))}
            onSelectItem={setSelectedItemId}
            onLoadMore={() => void listQuery.fetchNextPage()}
          />
        </div>

        {selectedItemId === null && showNodePanel && selectedDomain && (
          <div className="col-span-2 flex min-w-0 flex-col border-t border-border-soft min-[1100px]:col-span-1 min-[1100px]:border-l min-[1100px]:border-t-0">
            <ColHead title={nodeFeature ? 'Feature' : 'Domain'} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <IntentNodePanel
                domain={selectedDomain}
                feature={nodeFeature}
                dimensions={dimensionsQuery.data?.dimensions ?? null}
                count={nodeCount}
                seeds={seedsQuery.data?.rows ?? null}
                seedsTruncated={seedsQuery.data?.truncated ?? false}
              />
            </div>
          </div>
        )}

        {selectedItemId !== null && (
          <div className="col-span-2 flex min-w-0 flex-col border-t border-border-soft min-[1100px]:col-span-1 min-[1100px]:border-l min-[1100px]:border-t-0">
            <ColHead
              title="Item"
              right={
                detailMatch === null
                  ? undefined
                  : `v${detailMatch.version} · updated ${formatIntentTimestamp(detailMatch.updatedAt)}`
              }
            />
            {showNodePanel && (
              <Button
                variant="ghost"
                size="sm"
                className="mx-3.5 mt-2 self-start px-2"
                onClick={() => setSelectedItemId(null)}
              >
                ← Back to {(nodeFeature ?? selectedDomain)?.title}
              </Button>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <IntentItemDetail
                productionState={
                  <IntentReleases
                    key={selectedItemId}
                    workspaceId={id}
                    role={role}
                    view="item"
                    itemId={selectedItemId}
                  />
                }
                itemId={selectedItemId}
                scope={selectedScope}
                match={detailMatch}
                graph={detailQuery.data?.graph ?? null}
                anchorWarning={detailQuery.data?.anchorWarning}
                transitions={transitions}
                hasMoreTransitions={transitionsQuery.hasNextPage}
                loadingMoreTransitions={transitionsQuery.isFetchingNextPage}
                loading={detailQuery.isLoading}
                errorMessage={messageOf(detailQuery.error)}
                anchorRefresh={{
                  canRefresh: canEdit,
                  confirmingKey: anchorConfirmKey,
                  refreshingKey: anchorRefreshingKey,
                  outcomes: anchorOutcomes,
                  errorKey: anchorErrorKey,
                  errorMessage: messageOf(anchorError),
                  onRequestRefresh: (anchor) => setAnchorConfirmKey(intentAnchorKey(anchor)),
                  onCancelRefresh: () => setAnchorConfirmKey(null),
                  onConfirmRefresh: (anchor) => void onConfirmRefresh(anchor),
                }}
                onRetry={() => void detailQuery.refetch()}
                onLoadMoreTransitions={() => void transitionsQuery.fetchNextPage()}
              />
            </div>
          </div>
        )}

        {editor}
      </Card>
    </div>
  );
}

function ColHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex min-h-[42px] items-center justify-between gap-2 border-b border-border-soft px-3.5 pb-2 pt-2.5">
      <span className="truncate text-[11px] uppercase tracking-[0.04em] text-ink-4">{title}</span>
      {right ? <span className="num shrink-0 text-[10.5px] text-ink-4">{right}</span> : null}
    </div>
  );
}
