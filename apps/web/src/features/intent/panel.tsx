/**
 * The intent knowledge base surface.
 *
 * This component owns the browse layout, the tree selection and the delivery
 * selection; the catalogue list, the tree writes, the anchor refresh and the
 * document review each live in their own hook, and release controls own their
 * versioned previews and writes. Two boundaries are deliberate:
 *
 * - **Role.** `role` comes from the workspace row and gates the decision batch
 *   and the tree editor (`hasIntentAccess`: admin, owner, product). It is a UI
 *   affordance, not a security boundary: the server re-checks every write
 *   (any member role on a user session), whatever this renderer shows.
 * - **One writer.** Tree writes, anchor refreshes and review decisions share one
 *   {@link IntentWriter}, so at most one of them is in flight at a time.
 */

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { hasIntentAccess } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  intentDimensionsQueryOptions,
  intentDomainFeaturesQueryOptions,
  intentFeatureSeedsQueryOptions,
  intentItemContextQueryOptions,
  intentItemTransitionsQueryOptions,
  intentTreeQueryOptions,
} from '@/api/queries/intent';
import { IntentCatalogueFilters } from './catalogue-filters.js';
import { IntentComments } from './comments.js';
import { IntentContextPreview } from './context-preview.js';
import { DeliverySelectionBar } from './delivery-selection-bar.js';
import { IntentDocumentView } from './document-view.js';
import { IntentEmptyState } from './empty-state.js';
import {
  INTENT_ROOT_SELECTION,
  IntentBrowseState,
  intentBrowseState,
  intentTreeCounts,
  intentTreeNames,
  type IntentTreeSelection,
} from './intent-panel-state.js';
import { formatIntentTimestamp, messageOf } from './intent-presentation.js';
import { useIntentWriter } from './intent-writer.js';
import { IntentItemAskAgent } from './item-ask-agent.js';
import { IntentItemDetail } from './item-detail.js';
import { ItemProductionState } from './item-production-state.js';
import { IntentItemReview } from './item-review.js';
import { Chip, IntentItemsList } from './items-list.js';
import { IntentNodePanel } from './node-panel.js';
import type { ReleaseSelectionItem } from './release-types.js';
import { IntentTreeBrowser } from './tree-browser.js';
import { IntentTreeEditor } from './tree-editor.js';
import { IntentAuthority, type IntentItemKind } from './types.js';
import { useAnchorRefresh } from './use-anchor-refresh.js';
import { useCatalogueList } from './use-catalogue-list.js';
import { useDocumentReview } from './use-document-review.js';
import { useTreeWrites } from './use-tree-writes.js';

export interface IntentPanelProps {
  workspaceId: string;
  role: string;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
}

export function IntentPanel({
  workspaceId: id,
  role,
  selectedItemId,
  onSelectItem: setSelectedItemId,
}: IntentPanelProps) {
  const queryClient = useQueryClient();
  const canEdit = hasIntentAccess(role);

  const [includeArchived, setIncludeArchived] = useState(false);
  const [selection, setSelection] = useState<IntentTreeSelection>(INTENT_ROOT_SELECTION);
  const [deliverySelection, setDeliverySelection] = useState<ReleaseSelectionItem[]>([]);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [centerView, setCenterView] = useState<'document' | 'list'>('document');
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [onlyPending, setOnlyPending] = useState(false);

  /** Rows are the truth: after any write, everything intent-scoped is re-read. */
  const invalidateIntent = () => queryClient.invalidateQueries({ queryKey: ['intent'] });
  const writer = useIntentWriter();
  const treeWrites = useTreeWrites({ workspaceId: id, writer, invalidateIntent });
  const anchorRefresh = useAnchorRefresh({ workspaceId: id, selectedItemId, canRefresh: canEdit, writer });
  const catalogue = useCatalogueList({
    workspaceId: id,
    selection,
    deliverySelection,
    onDeliverySelectionChange: setDeliverySelection,
  });

  const treeQuery = useInfiniteQuery(intentTreeQueryOptions(id, includeArchived));
  const domains = useMemo(() => treeQuery.data?.pages.flatMap((page) => page.domains) ?? null, [treeQuery.data]);
  const dimensionsQuery = useQuery(intentDimensionsQueryOptions(id));

  const detailQuery = useQuery(intentItemContextQueryOptions(id, selectedItemId));
  const transitionsQuery = useInfiniteQuery(intentItemTransitionsQueryOptions(id, selectedItemId));
  const transitions = useMemo(
    () => transitionsQuery.data?.pages.flatMap((page) => page.transitions) ?? null,
    [transitionsQuery.data],
  );
  const seedsQuery = useQuery(intentFeatureSeedsQueryOptions(id, selection.featureId));
  const domainFeaturesQuery = useQuery(intentDomainFeaturesQueryOptions(id, expandedDomainId));
  // Structure counts are the tree read's own — no item pages are tallied here.
  const counts = useMemo(
    () => (treeQuery.data ? intentTreeCounts(treeQuery.data.pages, domainFeaturesQuery.data?.rows) : null),
    [treeQuery.data, domainFeaturesQuery.data],
  );

  // Product-root items keep a domain-less workspace out of the onboarding state.
  const browseState = intentBrowseState({
    treeLoading: treeQuery.isLoading,
    treeError: treeQuery.isError,
    domainCount: domains === null ? null : domains.length,
    rootItemCount: counts === null ? null : counts.root.items,
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
  const review = useDocumentReview({
    workspaceId: id,
    selection,
    selectedItemId,
    enabled: centerView === 'document',
    detailMatch,
    writer,
    invalidateIntent,
    onOpen: (next, itemId) => {
      setSelection(next);
      setSelectedItemId(itemId);
    },
  });
  // A selected domain/feature with no rule open gets the node panel in the third column.
  const nodeCount =
    selection.featureId !== null
      ? (counts?.features[selection.featureId] ?? null)
      : selection.domainId !== null
        ? (counts?.domains[selection.domainId] ?? null)
        : null;
  const nodeFeature = selection.featureId === null ? null : selectedScope;
  const showNodePanel = selectedDomain !== null && (selection.featureId === null || nodeFeature !== null);
  const thirdColumn = selectedItemId !== null || showNodePanel;

  const onOpenNode = (kind: 'domain' | 'feature', nodeId: string) => {
    if (kind === 'domain') return onSelect({ domainId: nodeId, featureId: null });
    const features = [
      ...(domains ?? []).flatMap((domain) => domain.features),
      ...(domainFeaturesQuery.data?.rows ?? []),
    ];
    const feature = features.find((candidate) => candidate.id === nodeId);
    if (feature) onSelect({ domainId: feature.domainId, featureId: feature.id });
  };

  const onSelect = (next: IntentTreeSelection) => {
    setSelection(next);
    setSelectedItemId(null);
  };

  const { filter, setFilter } = catalogue;
  const toggleOpenQuestions = () => setFilter((current) => ({ ...current, openQuestions: !current.openQuestions }));
  const toggleOpenComments = () => setFilter((current) => ({ ...current, openComments: !current.openComments }));
  const toggleKind = (kind: IntentItemKind) =>
    setFilter((current) => ({
      ...current,
      kinds: current.kinds.includes(kind) ? current.kinds.filter((entry) => entry !== kind) : [...current.kinds, kind],
    }));

  /* -------------------------------------------------------------- render --- */

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
        <p className="text-[13.5px] text-ink-2">Couldn't load the intent tree.</p>
        {messageOf(treeQuery.error) && <p className="max-w-md text-[12px] text-ink-4">{messageOf(treeQuery.error)}</p>}
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
      {...treeWrites}
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
      {/* Delivery selection and catalogue filters act on the list; the document view shows the node whole. */}
      {centerView === 'list' && (
        <>
          <div className="rounded-xl border border-border-soft bg-surface p-4">
            <h2 className="font-medium text-ink-1">Your product rules, from decision to production</h2>
            <p className="mt-1 text-sm text-ink-3">
              Open a rule to see its intent, code links and production state together. Select rules below to confirm a
              delivery, or choose “Already in production” to establish your starting point.
            </p>
          </div>
          <div className="sticky top-2 z-20">
            <DeliverySelectionBar
              workspaceId={id}
              role={role}
              selection={deliverySelection}
              onSelectionChange={setDeliverySelection}
              onOpenItem={setSelectedItemId}
            />
          </div>
          <IntentCatalogueFilters
            workspaceId={id}
            effectivity={catalogue.effectivity}
            onEffectivityChange={catalogue.setEffectivity}
            source={catalogue.source}
            onSourceChange={catalogue.setSource}
          />
          <p className="text-xs text-ink-3">
            Production status reflects recorded evidence. Approval alone does not mean a rule is in production.
          </p>
          {catalogue.selectionError && (
            <p role="alert" className="text-sm text-danger-text">
              {catalogue.selectionError}
            </p>
          )}
          {catalogue.listQuery.error && (
            <p role="alert" className="text-sm text-danger-text">
              {messageOf(catalogue.listQuery.error)}
            </p>
          )}
        </>
      )}
      <Card
        className={cn(
          // From 1100px the card is one viewport tall (shell header + page padding = 100px) and each
          // column scrolls on its own, so the tree and the details stay in reach of a long document.
          'grid min-h-[640px] min-[1100px]:h-[calc(100dvh-100px)] min-[1100px]:grid-rows-[minmax(0,1fr)]',
          // Structure, document and details share the width 1 : 3 : 2, each with a floor.
          treeCollapsed
            ? 'grid-cols-[40px_minmax(0,1fr)] min-[1100px]:grid-cols-[40px_minmax(0,3fr)_minmax(320px,2fr)]'
            : 'grid-cols-[minmax(200px,1fr)_minmax(0,3fr)] min-[1100px]:grid-cols-[minmax(220px,1fr)_minmax(0,3fr)_minmax(320px,2fr)]',
        )}
      >
        {treeCollapsed ? (
          <button
            type="button"
            title="Show structure"
            aria-label="Show structure"
            onClick={() => setTreeCollapsed(false)}
            className="flex min-w-0 flex-col items-center gap-3 pt-3 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
          >
            <span aria-hidden="true">»</span>
            <span className="text-[12px] uppercase tracking-[0.04em] [writing-mode:vertical-rl]">Structure</span>
          </button>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-col">
            <ColHead
              title="Structure"
              right={
                <button
                  type="button"
                  title="Hide structure"
                  aria-label="Hide structure"
                  onClick={() => setTreeCollapsed(true)}
                  className="rounded px-1 text-[14px] text-ink-4 hover:bg-surface-2 hover:text-ink-1"
                >
                  «
                </button>
              }
            />
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
              onlyPending={onlyPending}
              onToggleOnlyPending={() => setOnlyPending((value) => !value)}
              onlyOpenQuestions={filter.openQuestions}
              onToggleOnlyOpenQuestions={toggleOpenQuestions}
              onlyOpenComments={filter.openComments}
              onToggleOnlyOpenComments={toggleOpenComments}
            />
          </div>
        )}

        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-col border-l border-border-soft',
            thirdColumn ? '' : 'min-[1100px]:col-span-2',
          )}
        >
          <ColHead
            title={itemsTitle}
            right={
              <span className="flex items-center gap-1">
                <Chip pressed={centerView === 'document'} label="Document" onClick={() => setCenterView('document')} />
                <Chip pressed={centerView === 'list'} label="List" onClick={() => setCenterView('list')} />
              </span>
            }
          />
          {centerView === 'document' ? (
            <IntentDocumentView
              document={review.documentQuery.data ?? null}
              loading={review.documentQuery.isLoading}
              errorMessage={messageOf(review.documentQuery.error)}
              includeCandidates={review.includeCandidates}
              selectedItemId={selectedItemId}
              onToggleCandidates={review.setIncludeCandidates}
              onSelectItem={setSelectedItemId}
              onOpenNode={onOpenNode}
              onRetry={() => void review.documentQuery.refetch()}
              waiting={review.waiting}
              onNextProposal={() => void review.nextProposal()}
              proposalCount={review.proposalCount}
              approveAll={{ canReview: canEdit, busy: review.submitting, onApprove: review.approveAll }}
            />
          ) : (
            <>
              <IntentContextPreview
                dimensions={dimensionsQuery.data?.dimensions ?? null}
                value={catalogue.preview}
                onChange={catalogue.setPreview}
                hiddenCount={catalogue.previewing ? catalogue.previewHidden : null}
                hiddenCountIsLowerBound={catalogue.previewing && catalogue.previewHiddenIsLowerBound}
                ignoredFilters={catalogue.previewIgnored}
              />
              <IntentItemsList
                items={catalogue.scopedItems}
                deliverySelection={deliverySelection.map((item) => item.id)}
                canSelectForDelivery={canEdit}
                selectingAll={catalogue.selectingAll || catalogue.searching}
                onSelectAllMatching={() => void catalogue.selectAllMatching()}
                selectAllMatchingDisabledReason={
                  catalogue.previewing
                    ? 'Clear the context preview to select all matching rules — it cannot honor the preview.'
                    : null
                }
                onToggleDelivery={catalogue.toggleDelivery}
                onSelectVisible={catalogue.selectVisible}
                scopedCount={catalogue.scopedItems.length}
                filter={filter}
                selection={selection}
                featureTitles={featureTitles}
                dimensions={dimensionsQuery.data?.dimensions ?? null}
                selectedItemId={selectedItemId}
                loading={catalogue.listQuery.isLoading || catalogue.searchPending}
                hasMore={catalogue.listQuery.hasNextPage}
                loadingMore={catalogue.listQuery.isFetchingNextPage}
                onSearch={(search) => setFilter((current) => ({ ...current, search }))}
                onToggleKind={toggleKind}
                onToggleCandidates={() =>
                  setFilter((current) => ({ ...current, includeCandidates: !current.includeCandidates }))
                }
                onToggleResolved={() =>
                  setFilter((current) => ({ ...current, includeResolved: !current.includeResolved }))
                }
                onToggleOpenQuestions={toggleOpenQuestions}
                onToggleOpenComments={toggleOpenComments}
                onSelectItem={setSelectedItemId}
                onLoadMore={() => void catalogue.listQuery.fetchNextPage()}
              />
            </>
          )}
        </div>

        {selectedItemId === null && showNodePanel && selectedDomain && (
          <div className="col-span-2 flex min-h-0 min-w-0 flex-col border-t border-border-soft min-[1100px]:col-span-1 min-[1100px]:border-l min-[1100px]:border-t-0">
            <ColHead title={nodeFeature ? 'Feature' : 'Domain'} />
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              <IntentNodePanel
                domain={selectedDomain}
                feature={nodeFeature}
                dimensions={dimensionsQuery.data?.dimensions ?? null}
                count={nodeCount}
                seeds={seedsQuery.data?.rows ?? null}
                seedsTruncated={seedsQuery.data?.truncated ?? false}
              />
              {nodeFeature && (
                <div className="border-t border-border-soft px-4 py-3">
                  <IntentComments
                    key={nodeFeature.id}
                    workspaceId={id}
                    target={{ kind: 'feature', id: nodeFeature.id }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {selectedItemId !== null && (
          <div className="col-span-2 flex min-h-0 min-w-0 flex-col border-t border-border-soft min-[1100px]:col-span-1 min-[1100px]:border-l min-[1100px]:border-t-0">
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
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              {detailMatch?.authority === IntentAuthority.Candidate && (
                <IntentItemReview
                  key={`${detailMatch.id}:${detailMatch.version}`}
                  match={detailMatch}
                  {...(review.predecessor ? { predecessor: review.predecessor } : {})}
                  predecessorLoading={review.predecessorLoading}
                  canReview={canEdit}
                  submitting={review.submitting}
                  results={review.results}
                  {...(review.submitErrorMessage ? { errorMessage: review.submitErrorMessage } : {})}
                  onDecide={review.decideOne}
                />
              )}
              {detailMatch && <IntentItemAskAgent key={detailMatch.id} match={detailMatch} />}
              <IntentItemDetail
                comments={
                  <IntentComments
                    key={`comments:${selectedItemId}`}
                    workspaceId={id}
                    target={{ kind: 'item', id: selectedItemId }}
                  />
                }
                productionState={
                  <ItemProductionState key={selectedItemId} workspaceId={id} role={role} itemId={selectedItemId} />
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
                anchorRefresh={anchorRefresh}
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
      <span className="truncate text-[12px] uppercase tracking-[0.04em] text-ink-4">{title}</span>
      {right ? <span className="num shrink-0 text-[11.5px] text-ink-4">{right}</span> : null}
    </div>
  );
}
