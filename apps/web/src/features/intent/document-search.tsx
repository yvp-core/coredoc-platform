/**
 * Search from the document view: the items of the whole workspace that match,
 * grouped by the document (product, domain or feature) each one is written in.
 * Opening a row opens that document at the item.
 *
 * Owns its debounce and its read, like the source picker. The read is the List
 * view's own items route, so both views find the same items for the same text.
 */

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { plural } from '@coredoc/core/browser/format';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { intentItemsQueryOptions } from '@/api/queries/intent';
import type { IntentTreeNames, IntentTreeSelection } from './intent-panel-state.js';
import { kindLabel, messageOf } from './intent-presentation.js';
import { ItemRow } from './items-list.js';
import type { IntentItemSummary } from './types.js';

interface IntentDocumentSearchProps {
  workspaceId: string;
  search: string;
  includeCandidates: boolean;
  /** Titles the tree has loaded; a node it has not loaded is named by its id. */
  names: IntentTreeNames;
  selectedItemId: string | null;
  onOpen: (selection: IntentTreeSelection, itemId: string) => void;
}

interface DocumentHits {
  selection: IntentTreeSelection;
  items: IntentItemSummary[];
}

/** Hits by document, in the order the read answers them. */
export function groupHitsByDocument(items: readonly IntentItemSummary[]): DocumentHits[] {
  const groups = new Map<string, DocumentHits>();
  for (const item of items) {
    const key = JSON.stringify([item.domainId, item.featureId]);
    const group = groups.get(key) ?? { selection: { domainId: item.domainId, featureId: item.featureId }, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function IntentDocumentSearch({
  workspaceId,
  search,
  includeCandidates,
  names,
  selectedItemId,
  onOpen,
}: IntentDocumentSearchProps) {
  const [term, setTerm] = useState(search.trim());
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    ...intentItemsQueryOptions(workspaceId, {
      search: term,
      authorities: includeCandidates ? 'accepted,candidate' : 'accepted',
    }),
    enabled: term !== '',
  });
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const groups = useMemo(() => groupHitsByDocument(items), [items]);

  if (query.isLoading || term !== search.trim()) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="text-ink-4" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p role="alert" className="px-4 py-6 text-center text-[13px] text-danger-text">
        {messageOf(query.error)}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-[13px] text-ink-4">
        No {includeCandidates ? '' : 'approved '}item matches “{term}” in its title, statement or id.
      </p>
    );
  }

  const title = ({ domainId, featureId }: IntentTreeSelection) =>
    domainId === null
      ? 'Whole product'
      : [
          names.domains[domainId] ?? domainId,
          ...(featureId === null ? [] : [names.features[featureId] ?? featureId]),
        ].join(' · ');

  return (
    <div className="pb-4">
      <p className="px-3.5 pt-2.5 text-[12px] text-ink-4">
        {plural(items.length, 'item', 'items')}
        {query.hasNextPage ? ' so far' : ''} in {plural(groups.length, 'document', 'documents')}
      </p>
      {groups.map((group) => (
        <section key={JSON.stringify(group.selection)}>
          <h4 className="px-3.5 pb-1 pt-2.5 text-[11.5px] uppercase tracking-[0.04em] text-ink-4">
            {title(group.selection)} · {group.items.length}
          </h4>
          {group.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={selectedItemId === item.id}
              reasonOverride={kindLabel(item.kind)}
              onSelect={() => onOpen(group.selection, item.id)}
            />
          ))}
        </section>
      ))}
      {query.hasNextPage && (
        <div className="px-3.5 pt-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more items'}
          </Button>
        </div>
      )}
    </div>
  );
}
