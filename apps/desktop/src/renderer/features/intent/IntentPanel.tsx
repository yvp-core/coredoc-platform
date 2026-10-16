import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
} from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { effectivityLabels, type IntentEffectivity } from '../../../shared/intent-release-types';
import type { IntentSourceOption } from '../../../shared/intent-types';
import type { ReleaseSelectionItem } from './IntentReleases';
import { intentSourceOptions, selectMatchingIntentItems } from './intent-api';
import { IntentReleases } from './IntentReleases';
/**
 * The intent knowledge base surface (issue 11, spec §11 — desktop only).
 *
 * This component owns every query and mutation; the views below it are
 * pure-props so their states stay assertable without a DOM. Three boundaries are
 * deliberate:
 *
 * - **Cloud only.** Intent lives in the workspace, so a project without one
 *   gets an upsell rather than an empty tree.
 * - **Every member acts (BR-1).** Review, tree edits, anchors, delivery and
 *   releases are offered to any workspace member. The server remains the
 *   security boundary.
 * - **Reads follow the tree, not the click.** A feature's items are read at the
 *   DOMAIN's scope, once, because the items route filters by exactly one node
 *   and a feature's applicable set includes what the domain above it declares.
 *   The split into "attached here" and "inherited" is then a pure derivation
 *   (`intent-panel-state.ts`) rather than a second round trip.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Notebook } from '@solar-icons/react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Spinner } from '../../components/ui/spinner';
import { GraphQueryProvider } from '../../lib/graph-query-client';
import type {
  IntentErrorEnvelope,
  IntentItemAnchor,
  IntentItemKind,
  IntentReviewDecisionResult,
} from '../../../shared/intent-types.js';
import type { IntentAnchorRefreshOutcome } from './IntentAnchorRow';
import { IntentEmptyState } from './IntentEmptyState';
import { IntentHeader } from './IntentHeader';
import { IntentItemDetail } from './IntentItemDetail';
import { IntentItemsList } from './IntentItemsList';
import { IntentOverview } from './IntentOverview';
import { IntentReviewQueue } from './IntentReviewQueue';
import { IntentTreeBrowser } from './IntentTreeBrowser';
import { IntentTreeEditor } from './IntentTreeEditor';
import {
  IntentRequestError,
  archiveIntentDomain,
  archiveIntentFeature,
  createIntentDomain,
  createIntentFeature,
  intentDomainFeaturesQueryOptions,
  intentFeatureSeedsQueryOptions,
  intentItemContextQueryOptions,
  intentItemTransitionsQueryOptions,
  intentItemsByIdQueryOptions,
  intentItemsQueryOptions,
  intentPredecessorsQueryOptions,
  intentReviewQueueQueryOptions,
  intentTransitionsQueryOptions,
  intentDimensionsQueryOptions,
  intentTreeQueryOptions,
  putIntentSeed,
  deleteIntentSeed,
  refetchIntentItemContextFresh,
  refreshIntentAnchor,
  submitIntentReview,
  updateIntentDomain,
  updateIntentFeature,
} from './intent-api';
import { IntentAttemptKeys, IntentWriteForm } from '@coredoc/core/browser/intent-attempt-keys';
import {
  DEFAULT_INTENT_ITEM_FILTER,
  DEFAULT_INTENT_PANEL_TAB,
  INTENT_ROOT_SELECTION,
  IntentBrowseState,
  IntentPanelTab,
  type IntentItemFilter,
  type IntentTreeSelection,
  intentAnchorKey,
  intentAuthorityTally,
  intentBrowseState,
  intentItemsInScope,
  intentMatchesById,
  intentScopeCounts,
  intentTreeNames,
  versionsById,
} from './intent-panel-state';
import { buildReviewRequest, type IntentDraftDecision, type IntentProvenanceForm } from './intent-review-request';
import { useIntentPendingCount } from './use-intent-pending-review';

export { IntentPanelTab } from './intent-panel-state';

export interface IntentPanelProps {
  workspaceId: string | null;
  /** The workspace slug, when the caller has the row; the id is shown otherwise. */
  workspaceSlug?: string;
  role?: string;
  /**
   * The signed-in user's handle (their email), for the review batch's "Manual
   * decision" preset. Absent — a session that has not resolved yet — leaves the
   * preset's own `desktop-review` fallback, which is still a well-formed
   * reference; the server records the actor id either way.
   */
  reviewerHandle?: string;
}

const messageOf = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : error ? String(error) : undefined;

const detailOf = (error: unknown): IntentErrorEnvelope | null =>
  error instanceof IntentRequestError ? (error.detail ?? null) : null;

function IntentPanelInner({ workspaceId, workspaceSlug, reviewerHandle }: IntentPanelProps) {
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<IntentPanelTab>(DEFAULT_INTENT_PANEL_TAB);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selection, setSelection] = useState<IntentTreeSelection>(INTENT_ROOT_SELECTION);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
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

  // Anchor refresh (issue v1.1-01): which confirm is open, which write is in
  // flight, what each landed refresh moved, and the one refusal on screen.
  const [anchorConfirmKey, setAnchorConfirmKey] = useState<string | null>(null);
  const [anchorRefreshingKey, setAnchorRefreshingKey] = useState<string | null>(null);
  const [anchorOutcomes, setAnchorOutcomes] = useState<Record<string, IntentAnchorRefreshOutcome>>({});
  const [anchorErrorKey, setAnchorErrorKey] = useState<string | null>(null);
  const [anchorError, setAnchorError] = useState<unknown>(null);

  // Freshness re-check: a READ, so it has no attempt key and no write latch —
  // but its refusal is kept WITH the item it was raised on, so switching items
  // never shows the previous pane's failure.
  const [freshnessBusy, setFreshnessBusy] = useState(false);
  const [freshnessFailure, setFreshnessFailure] = useState<{ itemId: string; error: unknown } | null>(null);

  /**
   * One write at a time, latched in a ref rather than in state: two clicks
   * dispatched in the same frame would both read a stale `false` from state, and
   * two writes is exactly the defect being closed.
   */
  const writeInFlight = useRef(false);
  /** One idempotency key per logical attempt — see `@coredoc/core/browser/intent-attempt-keys`. */
  const attemptKeys = useRef(new IntentAttemptKeys());

  const id = workspaceId as string;
  const sourcesQuery = useQuery(intentSourceOptions(id, sourceTerm, sourceOpen));

  const treeQuery = useInfiniteQuery(intentTreeQueryOptions(id, includeArchived));
  const dimensionsQuery = useQuery(intentDimensionsQueryOptions(id));
  const domains = useMemo(() => treeQuery.data?.pages.flatMap((page) => page.domains) ?? null, [treeQuery.data]);

  // ONE scoped read per branch: a feature is read at its domain's scope, so the
  // domain's own items (which a feature inherits) arrive in the same call.
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
  const searching = search !== filter.search.trim() || resultsQuery.isFetching;
  async function selectAllMatching() {
    if (selectionPending.current || searching) return;
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

  // The workspace's decision ledger — the overview's feed. One page, because it
  // is a glance at what the team just decided; the full history of an item is on
  // the item. Gated to the surface that shows it, like the queue read: a domain
  // view never renders the feed and must not pay for it.
  const showsOverview = selection.domainId === null && selection.featureId === null;
  const decisionsQuery = useQuery({
    ...intentTransitionsQueryOptions(id),
    enabled: tab === IntentPanelTab.Browse && showsOverview,
  });

  // Review reads the server's queue route: entering the tab costs its summary
  // plus one page, and the size of the backlog arrives with them. The badge on
  // the Review segment is the cheaper summary-only read, so a maintainer who
  // never leaves Browse still learns that something is waiting.
  const pendingCount = useIntentPendingCount(workspaceId);
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
   * Two context reads PER LOADED PAGE, both by exact id.
   *
   * - The candidates' own records: the queue row is the server's payload-free
   *   projection, and a statement and its sources are what a reviewer decides on.
   * - The predecessors those rows name: a supersession checks the version on
   *   BOTH items (spec §5), and that version must be the CURRENT one — so it is
   *   read, not remembered from a browse page.
   *
   * Per page rather than over the whole loaded list because a context read
   * answers at most `INTENT_CONTEXT_ITEM_LIMIT` items and refuses a bigger
   * `limit` outright: one page is sized to fit one read, so the second page a
   * reviewer loads gets its own pair instead of pushing the first page's records
   * out of the answer.
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

  /**
   * The by-id reads have not settled. Kept apart from the truncation flag below:
   * "could not be read" is a claim about a finished read, and making it while
   * one is in flight accuses the server of a failure that has not happened.
   */
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

  const scopedItems = useMemo(() => intentItemsInScope(results, selection), [results, selection]);
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

  // Display names for both surfaces: the browse list's feature badges and the
  // review queue's group headers and feature badges.
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

  const tally = useMemo(() => intentAuthorityTally(items), [items]);
  const productItems = useMemo(() => (items ?? []).filter((item) => item.domainId === null), [items]);

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
  ) => {
    if (writeInFlight.current) return;
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
    } catch (error) {
      // The key is deliberately NOT settled: pressing again with the same input
      // replays this attempt rather than starting a second one.
      setTreeWriteError(error);
    } finally {
      writeInFlight.current = false;
      setTreeWriteBusy(false);
    }
  };

  /**
   * Re-capture one anchor's baseline (issue v1.1-01). Two clicks — the button
   * opens the confirm, the confirm writes — because a refresh asserts that the
   * code moved and the intent still holds, which only a human can say.
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

  /**
   * Re-read the open item with the local checkout resolved again (spec §6.3,
   * B2-Browse finding 3). It is a read, so it is offered to every role and takes
   * no attempt key; `refresh` is main's signal to drop its per-session checkout
   * cache and never reaches the server, and the answer lands under the pane's
   * own cache key so the pane simply re-renders with it.
   */
  const onRecheckFreshness = async () => {
    if (selectedItemId === null || freshnessBusy) return;
    const itemId = selectedItemId;
    setFreshnessBusy(true);
    setFreshnessFailure(null);
    try {
      await refetchIntentItemContextFresh(queryClient, id, itemId);
    } catch (error) {
      // The pane keeps the answer it already had; only the re-check failed.
      setFreshnessFailure({ itemId, error });
    } finally {
      setFreshnessBusy(false);
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
    // queue page (the candidate's own version) and the by-id reads (the
    // predecessors' and the candidates' records). Invalidating the browse index
    // instead re-read a list this surface does not show and left both numbers
    // exactly as stale as before.
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

  // A failed re-check belongs to the item it was raised on, not to the pane.
  const freshnessErrorMessage =
    freshnessFailure !== null && freshnessFailure.itemId === selectedItemId
      ? messageOf(freshnessFailure.error)
      : undefined;
  const decisionsErrorMessage = messageOf(decisionsQuery.error);

  /**
   * The Product overview is about the whole workspace and has no subject for the
   * detail pane, so it takes the detail column's width too and the third column
   * is not rendered at all. Selecting an item — from "Product-level items" or
   * from the decision feed — brings the column back with that item in it.
   */
  const showsDetail = !(showsOverview && selectedItemId === null);

  const treeEditor = editorOpen && (
    <IntentTreeEditor
      domains={domains}
      selectedDomainId={selection.domainId}
      selectedFeatureId={selection.featureId}
      seeds={seedsQuery.data?.rows ?? null}
      seedsTruncated={seedsQuery.data?.truncated ?? false}
      busy={treeWriteBusy}
      error={detailOf(treeWriteError)}
      errorMessage={detailOf(treeWriteError) ? undefined : messageOf(treeWriteError)}
      onClose={() => setEditorOpen(false)}
      onCreateDomain={(input) =>
        void runWrite(IntentWriteForm.CreateDomain, input, (body) => createIntentDomain(id, body))
      }
      onCreateFeature={(input) =>
        void runWrite(IntentWriteForm.CreateFeature, input, (body) => createIntentFeature(id, body))
      }
      onRenameDomain={(input) =>
        void runWrite(IntentWriteForm.RenameDomain, input, (body) => updateIntentDomain(id, body))
      }
      onRenameFeature={(input) =>
        void runWrite(IntentWriteForm.RenameFeature, input, (body) => updateIntentFeature(id, body))
      }
      onArchiveDomain={(input) =>
        void runWrite(IntentWriteForm.ArchiveDomain, input, (body) => archiveIntentDomain(id, body))
      }
      onArchiveFeature={(input) =>
        void runWrite(IntentWriteForm.ArchiveFeature, input, (body) => archiveIntentFeature(id, body))
      }
      onAddSeed={(input) => void runWrite(IntentWriteForm.AddSeed, input, (body) => putIntentSeed(id, body))}
      onRemoveSeed={(input) => void runWrite(IntentWriteForm.RemoveSeed, input, (body) => deleteIntentSeed(id, body))}
    />
  );

  const browseFilters = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 text-xs text-content-tertiary">
          <Select
            value={effectivity || 'all'}
            onValueChange={(value) => setEffectivity(value === 'all' ? '' : (value as IntentEffectivity))}
          >
            <SelectTrigger
              aria-label="Production status"
              title="Status reflects recorded delivery evidence, not approval"
              className="max-w-full"
              size="sm"
            >
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
        <Button variant="outline" size="sm" className="max-w-full" onClick={() => setSourceOpen(!sourceOpen)}>
          <span className="truncate">{source ? `Source: ${source.title || source.ref}` : 'Choose spec or issue'}</span>
        </Button>
        {source && (
          <Button variant="ghost" size="sm" onClick={() => setSource(null)}>
            Clear source filter
          </Button>
        )}
      </div>
      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent showCloseButton className="flex max-h-[80vh] flex-col">
          <DialogHeader>
            <DialogTitle>Choose spec or issue</DialogTitle>
            <DialogDescription>Search sources by title or reference.</DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 overflow-y-auto">
            <Input
              type="search"
              aria-label="Find source"
              placeholder="Find a spec, issue or ADR by title or reference…"
              maxLength={200}
              value={sourceSearch}
              onChange={(e) => setSourceSearch(e.target.value)}
            />
            {sourcesQuery.isFetching || sourceSearch.trim() !== sourceTerm ? (
              <p className="text-xs text-content-tertiary">Finding sources…</p>
            ) : sourcesQuery.error ? (
              <p role="alert">{messageOf(sourcesQuery.error)}</p>
            ) : (
              <>
                <div className="space-y-1">
                  {sourcesQuery.data?.sources.map((option) => (
                    <button
                      type="button"
                      key={`${option.kind}:${option.ref}`}
                      className="block w-full rounded p-2 text-left text-sm text-content-primary hover:bg-bg-primary-hover"
                      onClick={() => {
                        setSource(option);
                        setSourceOpen(false);
                      }}
                    >
                      <span className="block">{option.title || option.ref}</span>
                      <span className="block break-all text-xs text-content-tertiary">
                        {option.kind} · {option.ref}
                      </span>
                    </button>
                  ))}
                </div>
                {sourcesQuery.data?.sources.length === 0 && (
                  <p className="text-xs text-content-tertiary">No matching sources.</p>
                )}
                {sourcesQuery.data?.truncated && (
                  <p className="text-xs text-content-tertiary">Showing 50 sources. Narrow the search to find more.</p>
                )}
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <IntentHeader workspaceLabel={workspaceSlug ?? id} tab={tab} pendingCount={pendingCount} onTabChange={setTab} />

      {tab === IntentPanelTab.Releases ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <IntentReleases
            workspaceId={id}
            view="history"
            onOpenItem={(itemId) => {
              setSelectedItemId(itemId);
              setTab(IntentPanelTab.Browse);
            }}
          />
        </div>
      ) : tab === IntentPanelTab.Browse ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0">
            <IntentReleases
              workspaceId={id}
              view="selection"
              selection={deliverySelection}
              onSelectionChange={setDeliverySelection}
              onOpenItem={setSelectedItemId}
            />
            {selectionError && (
              <p role="alert" className="text-sm text-content-warning">
                {selectionError}
              </p>
            )}
            {resultsQuery.error && (
              <p role="alert" className="text-sm text-content-warning">
                {messageOf(resultsQuery.error)}
              </p>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 gap-3">
            {browseState === IntentBrowseState.Loading && (
              <div className="surface-b flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border-secondary">
                <Spinner className="size-6 text-content-quaternary" />
              </div>
            )}

            {browseState === IntentBrowseState.Error && (
              <div className="surface-b flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-border-secondary p-6 text-center">
                <p className="text-sm text-content-secondary">Couldn't load the intent tree.</p>
                {messageOf(treeQuery.error) && (
                  <p className="max-w-md text-xs leading-4 text-content-tertiary">{messageOf(treeQuery.error)}</p>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => void treeQuery.refetch()}>
                  Retry
                </Button>
              </div>
            )}

            {browseState === IntentBrowseState.Empty && (
              <IntentEmptyState
                archivedDomainCount={archivedDomainCount}
                onShowArchived={() => setIncludeArchived(true)}
                onCreateFirstDomain={() => setEditorOpen(true)}
              />
            )}

            {browseState === IntentBrowseState.Ready && (
              <div className="surface-b flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-secondary min-[1100px]:flex-row">
                <div className="flex min-h-0 min-w-0 shrink-0 flex-col border-b border-border-input min-[1100px]:w-[250px] min-[1100px]:border-b-0 min-[1100px]:border-r">
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
                  className={
                    showsDetail
                      ? 'flex min-h-0 min-w-0 flex-1 flex-col border-b border-border-input min-[1100px]:border-b-0 min-[1100px]:border-r'
                      : 'flex min-h-0 min-w-0 flex-1 flex-col'
                  }
                >
                  {showsOverview && (
                    <details className="shrink-0 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-content-tertiary">Product overview</summary>
                      <IntentOverview
                        tally={tally}
                        complete={!itemsQuery.hasNextPage}
                        productItems={productItems}
                        decisions={decisionsQuery.data?.transitions ?? null}
                        {...(decisionsErrorMessage === undefined ? {} : { decisionsErrorMessage })}
                        selectedItemId={selectedItemId}
                        loading={itemsQuery.isLoading}
                        hasMore={itemsQuery.hasNextPage}
                        loadingMore={itemsQuery.isFetchingNextPage}
                        onSelectItem={setSelectedItemId}
                        onLoadMore={() => void itemsQuery.fetchNextPage()}
                      />
                    </details>
                  )}
                  <IntentItemsList
                    filters={browseFilters}
                    title={itemsTitle}
                    items={shownItems}
                    deliverySelection={deliverySelection.map((item) => item.id)}
                    selectingAll={selectingAll || searching}
                    onSelectAllMatching={() => void selectAllMatching()}
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
                    selectedItemId={selectedItemId}
                    loading={resultsQuery.isLoading || search !== filter.search.trim()}
                    hasMore={resultsQuery.hasNextPage}
                    loadingMore={resultsQuery.isFetchingNextPage}
                    onSearch={(search) => setFilter((current) => ({ ...current, search }))}
                    onToggleKind={toggleKind}
                    onToggleCandidates={() =>
                      setFilter((current) => ({ ...current, includeCandidates: !current.includeCandidates }))
                    }
                    onToggleResolved={() =>
                      setFilter((current) => ({ ...current, includeResolved: !current.includeResolved }))
                    }
                    onSelectItem={setSelectedItemId}
                    onLoadMore={() => void resultsQuery.fetchNextPage()}
                  />
                </div>

                {showsDetail && (
                  <div className="flex min-h-0 min-w-0 w-full flex-col min-[1100px]:w-[420px] min-[1100px]:shrink-0">
                    <IntentItemDetail
                      productionState={
                        <IntentReleases workspaceId={id} view="item" itemId={selectedItemId ?? undefined} />
                      }
                      itemId={selectedItemId}
                      scope={selectedScope}
                      match={detailQuery.data?.matches[0] ?? null}
                      graph={detailQuery.data?.graph ?? null}
                      anchorWarning={detailQuery.data?.anchorWarning}
                      transitions={transitions}
                      hasMoreTransitions={transitionsQuery.hasNextPage}
                      loadingMoreTransitions={transitionsQuery.isFetchingNextPage}
                      loading={detailQuery.isLoading}
                      errorMessage={messageOf(detailQuery.error)}
                      anchorRefresh={{
                        confirmingKey: anchorConfirmKey,
                        refreshingKey: anchorRefreshingKey,
                        outcomes: anchorOutcomes,
                        errorKey: anchorErrorKey,
                        error: detailOf(anchorError),
                        errorMessage: detailOf(anchorError) ? undefined : messageOf(anchorError),
                        onRequestRefresh: (anchor) => setAnchorConfirmKey(intentAnchorKey(anchor)),
                        onCancelRefresh: () => setAnchorConfirmKey(null),
                        onConfirmRefresh: (anchor) => void onConfirmRefresh(anchor),
                      }}
                      freshness={{
                        busy: freshnessBusy,
                        ...(freshnessErrorMessage === undefined ? {} : { errorMessage: freshnessErrorMessage }),
                        onRecheck: () => void onRecheckFreshness(),
                      }}
                      onRetry={() => void detailQuery.refetch()}
                      onLoadMoreTransitions={() => void transitionsQuery.fetchNextPage()}
                    />
                  </div>
                )}
              </div>
            )}

            {treeEditor}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <IntentReviewQueue
            candidates={candidates}
            predecessorVersions={predecessorVersions}
            predecessorTitles={predecessorTitles}
            // The two halves of the supersede diff and the card's own statement
            // and sources. A named predecessor whose record did not come back
            // cannot be superseded safely, and the queue says so rather than
            // guessing — hence the truncation flag beside them.
            predecessorItems={predecessorItems}
            candidateItems={candidateItems}
            domainNames={treeNames.domains}
            featureNames={treeNames.features}
            // Compared against the DISTINCT ids that came back: two pages naming
            // the same predecessor return it twice, and counting rows would let
            // a duplicate stand in for a predecessor that never arrived.
            predecessorsLoading={predecessorsLoading}
            predecessorsTruncated={predecessorIds.size > Object.keys(predecessorItems).length}
            candidatesTruncated={queueQuery.hasNextPage}
            {...(queueQuery.hasNextPage ? { onLoadMore: () => void queueQuery.fetchNextPage() } : {})}
            loading={queueQuery.isLoading}
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
        </div>
      )}
    </div>
  );
}

/** Shown when the project has no cloud workspace: intent is workspace-scoped. */
export function IntentUpsell() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-md items-center gap-3 px-6 py-7 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-bg-tertiary text-content-brand">
          <Notebook weight="Bold" className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-content-primary">Product intent lives in the cloud</h3>
        <p className="text-xs leading-5 text-content-secondary">
          The Domain → Feature tree, its reviewed items and their decision history belong to a cloud workspace. Move
          this project to one to browse and review them here.
        </p>
      </Card>
    </div>
  );
}

export function IntentPanel(props: IntentPanelProps) {
  if (props.workspaceId === null) return <IntentUpsell />;
  return (
    <GraphQueryProvider>
      <IntentPanelInner {...props} />
    </GraphQueryProvider>
  );
}
