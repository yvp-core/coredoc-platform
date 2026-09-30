import { Checkbox } from '../../components/ui/checkbox';
import type { ReactNode } from 'react';
import { effectivityLabels } from '../../../shared/intent-release-types';
/**
 * The Items column of the browse card: what applies to the selected tree node.
 *
 * Pure props — the panel does the reading and the filtering, so every state here
 * (empty scope, empty after filtering, grouped list, a candidate's rail) is
 * assertable from the rendered markup.
 *
 * Two facts the rows are careful about:
 *
 * - **A row says WHY it is here** when it is not attached to the selected node:
 *   "in <feature>" for a domain view, "inherited · domain" / "inherited ·
 *   product root" for something attached further up the branch. An attached item
 *   carries no reason badge, because "attached here" on every row of a list
 *   scoped to here says nothing.
 * - **Candidate is a state, not a decoration.** The blue left rail repeats what
 *   the authority badge already says in words; it is there to make a queue of
 *   proposals scannable, never as the only carrier of the meaning.
 */

import { Magnifer } from '@solar-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utils';
import { IntentAuthority, type IntentItemKind, type IntentItemSummary } from '../../../shared/intent-types.js';
import {
  INTENT_KIND_ORDER,
  effectivityVariant,
  authorityLabel,
  authorityVariant,
  itemScopeLabel,
  kindLabel,
} from './intent-presentation';
import {
  type IntentItemFilter,
  type IntentTreeSelection,
  groupIntentItemsByKind,
  intentItemScope,
} from './intent-panel-state';

export interface IntentItemsListProps {
  filters?: ReactNode;
  deliverySelection: string[];
  onToggleDelivery: (item: IntentItemSummary) => void;
  onSelectVisible: () => void;
  selectingAll: boolean;
  onSelectAllMatching: () => void;
  /** "Whole product", "<Domain>" or "<Domain> · <Feature>". */
  title: string;
  /** The items that survived the filters, in scope order. */
  items: IntentItemSummary[];
  /** How many items are in scope before filtering — the "of <scoped>" half. */
  scopedCount: number;
  /** Active server-side filters. */
  filter: IntentItemFilter;
  selection: IntentTreeSelection;
  /** Feature id → title, so a reason badge can name the feature rather than its slug. */
  featureTitles: Readonly<Record<string, string>>;
  selectedItemId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSearch: (value: string) => void;
  onToggleKind: (kind: IntentItemKind) => void;
  onToggleCandidates: () => void;
  onToggleResolved: () => void;
  onSelectItem: (itemId: string) => void;
  onLoadMore: () => void;
}

export function IntentItemsList({
  filters,
  title,
  deliverySelection,
  onToggleDelivery,
  onSelectVisible,
  selectingAll,
  onSelectAllMatching,
  items,
  scopedCount,
  filter,
  selection,
  featureTitles,
  selectedItemId,
  loading,
  hasMore,
  loadingMore,
  onSearch,
  onToggleKind,
  onToggleCandidates,
  onToggleResolved,
  onSelectItem,
  onLoadMore,
}: IntentItemsListProps) {
  const groups = groupIntentItemsByKind(items, INTENT_KIND_ORDER);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 px-3 pb-2 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate text-[13px] font-semibold text-content-primary">{title}</h3>
          <span className="shrink-0 font-mono text-[11px] text-content-quaternary">
            {items.length} of {scopedCount}
          </span>
        </div>

        <div className="relative">
          <Magnifer className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-content-quaternary" />
          <Input
            aria-label="Search items"
            type="search"
            maxLength={200}
            placeholder="Search titles, statements and ids"
            value={filter.search}
            className="h-7 pl-7 text-xs"
            onChange={(event) => onSearch(event.target.value)}
          />
        </div>

        {filters}
        <div className="flex flex-wrap items-center gap-1">
          {INTENT_KIND_ORDER.map((kind) => (
            <Chip
              key={kind}
              pressed={filter.kinds.includes(kind)}
              label={kindLabel(kind)}
              onClick={() => onToggleKind(kind)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Chip pressed={filter.includeCandidates} label="Accepted + candidates" onClick={onToggleCandidates} />
          <Chip pressed={filter.includeResolved} label="Include resolved" onClick={onToggleResolved} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        <Button variant="outline" size="sm" disabled={selectingAll} onClick={onSelectAllMatching}>
          {selectingAll ? 'Loading…' : 'Select all matching rules'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={
            selectingAll ||
            deliverySelection.length >= 200 ||
            !items.some(
              (item) =>
                (item.authority === 'accepted' || item.authority === 'superseded') &&
                !deliverySelection.includes(item.id),
            )
          }
          onClick={onSelectVisible}
        >
          Select visible rules (up to {200 - deliverySelection.length} more)
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex min-h-[120px] items-center justify-center">
            <Spinner className="size-5 text-content-quaternary" />
          </div>
        ) : scopedCount === 0 ? (
          <p className="px-1 py-4 text-xs leading-5 text-content-secondary">No intent items apply here yet.</p>
        ) : items.length === 0 ? (
          <p className="px-1 py-4 text-xs leading-5 text-content-secondary">
            No item matches these filters. {scopedCount} in scope.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className="flex flex-col gap-1 pb-3">
              <h4 className="px-1 pt-1 text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">
                {kindLabel(group.kind as IntentItemKind)} · {group.items.length}
              </h4>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-1">
                    {(item.authority === 'accepted' || item.authority === 'superseded') && (
                      <Checkbox
                        className="shrink-0"
                        aria-label={`Select ${item.title} for delivery`}
                        checked={deliverySelection.includes(item.id)}
                        disabled={
                          selectingAll || (!deliverySelection.includes(item.id) && deliverySelection.length >= 200)
                        }
                        onCheckedChange={() => onToggleDelivery(item)}
                      />
                    )}
                    <ItemRow
                      item={item}
                      selection={selection}
                      featureTitles={featureTitles}
                      selected={selectedItemId === item.id}
                      onSelect={() => onSelectItem(item.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {hasMore && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="w-full"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? 'Loading…' : 'Load more items'}
          </Button>
        )}
      </div>
    </div>
  );
}

function Chip({ pressed, label, onClick }: { pressed: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px] leading-4 transition-colors',
        pressed
          ? 'border-border-primary-selected bg-bg-primary-selected font-medium text-content-primary'
          : 'border-border-input bg-bg-input font-normal text-content-secondary hover:bg-bg-primary-hover',
      )}
    >
      {label}
    </button>
  );
}

function ItemRow({
  item,
  selection,
  featureTitles,
  selected,
  onSelect,
}: {
  item: IntentItemSummary;
  selection: IntentTreeSelection;
  featureTitles: Readonly<Record<string, string>>;
  selected: boolean;
  onSelect: () => void;
}) {
  const candidate = item.authority === IntentAuthority.Candidate;
  const reason = itemScopeLabel(
    intentItemScope(item, selection),
    item.featureId === null ? null : (featureTitles[item.featureId] ?? item.featureId),
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        'flex w-full gap-2 rounded-lg border px-2 py-2 text-left transition-colors',
        'border-transparent hover:bg-bg-primary-hover',
        'data-[selected=true]:border-border-primary-selected data-[selected=true]:bg-bg-primary-selected',
      )}
    >
      {/* Decorative rail; the authority badge below carries the meaning. */}
      <span
        aria-hidden="true"
        className={cn(
          'w-[3px] shrink-0 self-stretch rounded-full',
          candidate ? 'bg-dodger-blue-500' : 'bg-transparent',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs/relaxed font-medium text-content-primary">{item.title}</span>
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={authorityVariant(item.authority)}>{authorityLabel(item.authority)}</Badge>
          {item.effectivity && (
            <Badge variant={effectivityVariant(item.effectivity)}>{effectivityLabels[item.effectivity]}</Badge>
          )}
          {item.proposedSuccessorOfId && <Badge variant="outlineInitial">replacement</Badge>}
          {reason && <Badge variant="initial">{reason}</Badge>}
        </span>
        <span className="truncate font-mono text-[11px] text-content-quaternary">{item.id}</span>
      </span>
    </button>
  );
}
