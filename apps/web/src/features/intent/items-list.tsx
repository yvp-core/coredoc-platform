import { effectivityLabels } from './release-types.js';
/**
 * The Items column of the browse card: what applies to the selected tree node.
 *
 * Pure props — the panel does the reading and the filtering, so every state here
 * (empty scope, empty after filtering, grouped list, a candidate's rail) is
 * assertable from the rendered markup.
 *
 * Two facts the rows are careful about:
 *
 * - **A row says WHY it is here** when it is not attached to the selected node.
 *   An attached item carries no reason badge, because "attached here" on every
 *   row of a list scoped to here says nothing.
 * - **Candidate is a state, not a decoration.** The blue left rail repeats what
 *   the authority badge already says in words.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  groupIntentItemsByKind,
  intentItemScope,
  type IntentItemFilter,
  type IntentTreeSelection,
} from './intent-panel-state.js';
import {
  INTENT_KIND_ORDER,
  effectivityVariant,
  authorityLabel,
  authorityVariant,
  conditionChips,
  contextMatchChip,
  itemScopeLabel,
  kindLabel,
} from './intent-presentation.js';
import { IntentAuthority, type IntentDimension, type IntentItemKind, type IntentItemSummary } from './types.js';

export interface IntentItemsListProps {
  /** The items that survived the filters, in scope order. */
  items: IntentItemSummary[];
  /** How many items are in scope before filtering — the "of <scoped>" half. */
  scopedCount: number;
  /** Active server-side filters. */
  filter: IntentItemFilter;
  selection: IntentTreeSelection;
  /** Feature id → title, so a reason badge can name the feature rather than its slug. */
  featureTitles: Readonly<Record<string, string>>;
  /** The dimension registry, so condition chips name value titles rather than ids. */
  dimensions?: readonly IntentDimension[] | null;
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
  deliverySelection: string[];
  canSelectForDelivery: boolean;
  onToggleDelivery: (item: IntentItemSummary) => void;
  onSelectVisible: () => void;
  selectingAll: boolean;
  onSelectAllMatching: () => void;
  /**
   * "Select all matching rules" reads the unfiltered browse query, so it cannot
   * honor an active reader-context preview. Set while previewing to disable the
   * button with an explanatory title, rather than silently selecting rules the
   * preview hides.
   */
  selectAllMatchingDisabledReason?: string | null;
}

export function IntentItemsList({
  items,
  scopedCount,
  filter,
  selection,
  featureTitles,
  dimensions,
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
  deliverySelection,
  canSelectForDelivery,
  onToggleDelivery,
  onSelectVisible,
  selectingAll,
  onSelectAllMatching,
  selectAllMatchingDisabledReason,
}: IntentItemsListProps) {
  const groups = groupIntentItemsByKind(items, INTENT_KIND_ORDER);

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border-soft px-3.5 py-2.5">
        <Input
          type="search"
          aria-label="Search items"
          placeholder="Search rules by title, statement or id…"
          maxLength={200}
          value={filter.search}
          onChange={(event) => onSearch(event.target.value)}
        />
        <div className="flex flex-wrap gap-[5px]">
          {INTENT_KIND_ORDER.map((kind) => (
            <Chip
              key={kind}
              pressed={filter.kinds.includes(kind)}
              label={kindLabel(kind)}
              onClick={() => onToggleKind(kind)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-[5px]">
          <Chip pressed={filter.includeCandidates} label="Accepted + candidates" onClick={onToggleCandidates} />
          <Chip pressed={filter.includeResolved} label="Include resolved" onClick={onToggleResolved} />
        </div>
      </div>

      <p className="px-3.5 py-2 text-xs text-ink-4">
        Search covers all rules in this scope, including pages not yet loaded.
      </p>
      {canSelectForDelivery && (
        <Button
          variant="outline"
          size="sm"
          className="mx-3.5 my-2 self-start"
          disabled={selectingAll || Boolean(selectAllMatchingDisabledReason)}
          title={selectAllMatchingDisabledReason ?? undefined}
          onClick={onSelectAllMatching}
        >
          {selectingAll ? 'Loading…' : 'Select all matching rules'}
        </Button>
      )}
      {canSelectForDelivery && (
        <Button
          variant="ghost"
          size="sm"
          className="mx-3.5 mb-2 self-start"
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
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3.5 pt-1.5">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner className="text-ink-4" />
          </div>
        ) : scopedCount === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-ink-4">No intent items apply here yet.</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-ink-4">
            No item matches the current filters. {scopedCount} in scope.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.kind}>
              <h4 className="px-3.5 pb-1 pt-2.5 text-[10.5px] uppercase tracking-[0.04em] text-ink-4">
                {kindLabel(group.kind as IntentItemKind)}
              </h4>
              {group.items.map((item) => (
                <div key={item.id} className="flex items-center">
                  {canSelectForDelivery && (item.authority === 'accepted' || item.authority === 'superseded') && (
                    <input
                      type="checkbox"
                      className="ml-3 shrink-0"
                      aria-label={`Select ${item.title} for delivery`}
                      checked={deliverySelection.includes(item.id)}
                      disabled={
                        selectingAll || (!deliverySelection.includes(item.id) && deliverySelection.length >= 200)
                      }
                      onChange={() => onToggleDelivery(item)}
                    />
                  )}
                  <ItemRow
                    item={item}
                    selection={selection}
                    featureTitles={featureTitles}
                    dimensions={dimensions}
                    selected={selectedItemId === item.id}
                    onSelect={() => onSelectItem(item.id)}
                  />
                </div>
              ))}
            </section>
          ))
        )}

        {hasMore && (
          <div className="px-3.5 pt-3">
            <Button variant="outline" size="sm" className="w-full" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? 'Loading…' : 'Load more items'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

export function Chip({ pressed, label, onClick }: { pressed: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'num rounded-full border px-[9px] py-0.5 text-[11px] transition-colors',
        pressed
          ? 'border-border bg-surface-2 text-ink-1'
          : 'border-border-soft text-ink-3 hover:border-border hover:text-ink-1',
      )}
    >
      {label}
    </button>
  );
}

/** One row of the items column, and of the overview's product-level list. */
export function ItemRow({
  item,
  selection,
  featureTitles,
  dimensions,
  selected,
  reasonOverride,
  onSelect,
}: {
  item: IntentItemSummary;
  selection?: IntentTreeSelection;
  featureTitles?: Readonly<Record<string, string>>;
  dimensions?: readonly IntentDimension[] | null;
  selected: boolean;
  /** The overview names the kind where the browse list names the applicability reason. */
  reasonOverride?: string;
  onSelect: () => void;
}) {
  const candidate = item.authority === IntentAuthority.Candidate;
  const reason =
    reasonOverride ??
    (selection === undefined
      ? null
      : itemScopeLabel(
          intentItemScope(item, selection),
          item.featureId === null ? null : (featureTitles?.[item.featureId] ?? item.featureId),
        ));
  const contextChip = contextMatchChip(item.contextMatch, dimensions);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'relative block w-full py-[7px] pl-[17px] pr-3.5 text-left transition-colors',
        selected ? 'bg-brand-wash' : 'hover:bg-surface-2',
      )}
    >
      {/* Decorative rail; the authority badge below carries the meaning. */}
      {candidate && (
        <span aria-hidden="true" className="absolute bottom-[9px] left-[7px] top-[9px] w-[3px] rounded-sm bg-blue" />
      )}
      <span className="block text-[12.5px] leading-[1.35] text-ink-1">{item.title}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <Badge variant={authorityVariant(item.authority)}>{authorityLabel(item.authority)}</Badge>
        {item.effectivity && (
          <Badge variant={effectivityVariant(item.effectivity)}>{effectivityLabels[item.effectivity]}</Badge>
        )}
        {item.proposedSuccessorOfId && <Badge variant="replace">replacement</Badge>}
        {reason && <Badge variant="reason">{reason}</Badge>}
        {conditionChips(item.conditions, dimensions).map((chip) => (
          <Badge key={chip} variant="neutral">
            {chip}
          </Badge>
        ))}
        {contextChip && <Badge variant="warn">{contextChip}</Badge>}
        <span className="truncate font-mono text-[10.5px] text-ink-4">{item.id}</span>
      </span>
    </button>
  );
}
