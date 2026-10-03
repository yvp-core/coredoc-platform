/**
 * The catalogue list behind the browse card's "List" view: its filters, the
 * debounced search, the browse read, the "Preview as" context read that stands
 * in for it, and "select all matching" into the delivery selection.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  intentContextListQueryOptions,
  intentItemsQueryOptions,
  selectMatchingIntentItems,
  type IntentSourceOption,
} from '@/api/queries/intent';
import {
  DEFAULT_INTENT_ITEM_FILTER,
  intentItemsInScope,
  type IntentItemFilter,
  type IntentTreeSelection,
} from './intent-panel-state.js';
import { canonicalPreviewContext, messageOf } from './intent-presentation.js';
import type { IntentEffectivity, ReleaseSelectionItem } from './release-types.js';
import type { DimensionValueSelection, IntentItemKind, IntentItemSummary } from './types.js';

/** The delivery selection's confirmation bound. */
const DELIVERY_SELECTION_LIMIT = 200;

export interface CatalogueListInput {
  workspaceId: string;
  selection: IntentTreeSelection;
  deliverySelection: ReleaseSelectionItem[];
  onDeliverySelectionChange: Dispatch<SetStateAction<ReleaseSelectionItem[]>>;
}

export function useCatalogueList({
  workspaceId: id,
  selection,
  deliverySelection,
  onDeliverySelectionChange,
}: CatalogueListInput) {
  const [filter, setFilter] = useState<IntentItemFilter>(DEFAULT_INTENT_ITEM_FILTER);
  const [effectivity, setEffectivity] = useState<IntentEffectivity | ''>('');
  const [source, setSource] = useState<IntentSourceOption | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filter.search.trim()), 250);
    return () => clearTimeout(timer);
  }, [filter.search]);

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
  const previewHidden = previewQuery.data?.pages[0]?.contextExcluded ?? 0;
  const previewHiddenIsLowerBound = (previewQuery.data?.pages.length ?? 0) > 1;
  const previewIgnored = [
    ...(effectivity ? ['production status'] : []),
    ...(source ? ['source'] : []),
    ...(filter.includeResolved ? ['resolved rules'] : []),
  ];
  const listQuery = previewing ? previewQuery : resultsQuery;
  const searching = search !== filter.search.trim() || resultsQuery.isFetching;

  const scopedItems = useMemo(
    () => intentItemsInScope(previewing ? previewRows : results, selection),
    [previewing, previewRows, results, selection],
  );

  // Select-all reads the selection after an await; the ref is the current one, not the render's.
  const deliverySelectionRef = useRef(deliverySelection);
  deliverySelectionRef.current = deliverySelection;
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionPending = useRef(false);
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
      if (current.length + added.length > DELIVERY_SELECTION_LIMIT)
        throw new Error(
          'Together with the existing selection this exceeds 200 rules. Clear the selection or narrow the filters.',
        );
      onDeliverySelectionChange([...current, ...added]);
    } catch (error) {
      setSelectionError(messageOf(error) ?? 'Could not select matching rules');
    } finally {
      selectionPending.current = false;
      setSelectingAll(false);
    }
  }

  /** Add the loaded, deliverable rows not yet selected, up to the bound. */
  const selectVisible = () =>
    onDeliverySelectionChange((current) => {
      const remaining = scopedItems.filter(
        (item) =>
          (item.authority === 'accepted' || item.authority === 'superseded') &&
          !current.some((row) => row.id === item.id),
      );
      return [
        ...current,
        ...remaining
          .slice(0, Math.max(0, DELIVERY_SELECTION_LIMIT - current.length))
          .map((item) => ({ id: item.id, title: item.title })),
      ];
    });

  const toggleDelivery = (item: { id: string; title: string }) =>
    onDeliverySelectionChange((current) =>
      current.some((row) => row.id === item.id)
        ? current.filter((row) => row.id !== item.id)
        : [...current, { id: item.id, title: item.title }],
    );

  return {
    filter,
    setFilter,
    effectivity,
    setEffectivity,
    source,
    setSource,
    preview,
    setPreview,
    previewing,
    previewHidden,
    previewHiddenIsLowerBound,
    previewIgnored,
    listQuery,
    /** The debounced search has not caught up, or the browse read is fetching. */
    searching,
    /** The debounced search has not caught up with the box. */
    searchPending: search !== filter.search.trim(),
    scopedItems,
    selectingAll,
    selectionError,
    selectAllMatching,
    selectVisible,
    toggleDelivery,
  };
}
