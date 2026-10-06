/**
 * The Structure column of the browse card: the product root, the domains, and
 * each domain's features.
 *
 * All fetching lives in the panel; this component only renders what it is
 * handed. Two honesty rules shape the rows:
 *
 * - **Counts are the server's.** The tree read carries each node's live item,
 *   proposal and open-question counts; a node no read in hand has listed shows no number.
 * - **Archived nodes are hidden by default and the toggle says so.** Archiving
 *   keeps children readable, so "hidden" must not read as "gone".
 */

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Archive, CircleHelp, Funnel, MessageSquareDot, MessagesSquare, Settings2 } from 'lucide-react';
import type * as React from 'react';
import { IntentCountBadges } from './count-badges.js';
import type { IntentCountCell, IntentTreeCounts, IntentTreeSelection } from './intent-panel-state.js';
import { contextConditionText } from './intent-presentation.js';
import type { IntentDimension, IntentFeatureView, IntentTreeDomain, TreeCondition } from './types.js';

/**
 * The full feature list of ONE domain, loaded on demand — the repair for the
 * tree route's `featuresTruncated`, which used to be a dead-end sentence.
 */
export interface IntentFeatureExpansion {
  domainId: string | null;
  features: IntentFeatureView[] | null;
  loading: boolean;
  /** The features walk hit its page ceiling — even this list is not the whole domain. */
  truncated: boolean;
  errorMessage?: string;
}

export interface IntentTreeBrowserProps {
  /** Every domain page loaded so far, already flattened by the panel. */
  domains: IntentTreeDomain[] | null;
  dimensions?: IntentDimension[] | null;
  /** Item and waiting-proposal counts per node, from the tree read; `null` while unread. */
  counts?: IntentTreeCounts | null;
  featureExpansion: IntentFeatureExpansion;
  selection: IntentTreeSelection;
  includeArchived: boolean;
  /** Admin, owner or product; a member sees the tree read-only. */
  canEdit: boolean;
  hasMoreDomains: boolean;
  loadingMoreDomains: boolean;
  onSelect: (selection: IntentTreeSelection) => void;
  onToggleArchived: () => void;
  onEditTree: () => void;
  onLoadMoreDomains: () => void;
  onShowAllFeatures: (domainId: string) => void;
  /** Show only the nodes that hold a waiting proposal (or have one below them). */
  onlyPending?: boolean;
  onToggleOnlyPending?: () => void;
  /** Show only the nodes that hold an open question (or have one below them); combines with `onlyPending`. */
  onlyOpenQuestions?: boolean;
  onToggleOnlyOpenQuestions?: () => void;
  /** Show only the nodes with an open comment thread (or one below them); combines with the others. */
  onlyOpenComments?: boolean;
  onToggleOnlyOpenComments?: () => void;
}

/** Which counts a node must have above zero to stay listed; empty means no filter. */
type TreeFilter = readonly ('pending' | 'open' | 'comments')[];

export function IntentTreeBrowser({
  domains: domainPages,
  dimensions,
  counts = null,
  featureExpansion,
  selection,
  includeArchived,
  canEdit,
  hasMoreDomains,
  loadingMoreDomains,
  onSelect,
  onToggleArchived,
  onEditTree,
  onLoadMoreDomains,
  onShowAllFeatures,
  onlyPending = false,
  onToggleOnlyPending,
  onlyOpenQuestions = false,
  onToggleOnlyOpenQuestions,
  onlyOpenComments = false,
  onToggleOnlyOpenComments,
}: IntentTreeBrowserProps) {
  const filter: TreeFilter =
    counts === null
      ? []
      : [
          ...(onlyPending ? ['pending' as const] : []),
          ...(onlyOpenQuestions ? ['open' as const] : []),
          ...(onlyOpenComments ? ['comments' as const] : []),
        ];
  const filtering = filter.length > 0;
  const domains = (domainPages ?? []).filter((domain) =>
    filter.every((field) => (counts?.domains[domain.id]?.[field] ?? 0) > 0),
  );

  return (
    <>
      {/* Icon-only so the toolbar fits the narrow column; the tooltip and
          aria-label carry the words. A local provider keeps the toolbar
          renderable outside the app shell (tests, embeds). */}
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-1 border-b border-border-soft px-2.5 py-1.5">
          <TreeToolbarButton
            label="Show archived"
            tooltip={includeArchived ? 'Showing archived' : 'Show archived'}
            pressed={includeArchived}
            activeClassName="text-brand-text"
            onClick={onToggleArchived}
          >
            <Archive aria-hidden="true" className="size-4" />
          </TreeToolbarButton>
          {onToggleOnlyPending && (
            <TreeToolbarButton
              label="Only with proposals"
              pressed={onlyPending}
              activeClassName="text-blue"
              onClick={onToggleOnlyPending}
            >
              <MessageSquareDot aria-hidden="true" className="size-4" />
            </TreeToolbarButton>
          )}
          {onToggleOnlyOpenQuestions && (
            <TreeToolbarButton
              label="Only with open questions"
              pressed={onlyOpenQuestions}
              activeClassName="text-warn-text"
              onClick={onToggleOnlyOpenQuestions}
            >
              <CircleHelp aria-hidden="true" className="size-4" />
            </TreeToolbarButton>
          )}
          {onToggleOnlyOpenComments && (
            <TreeToolbarButton
              label="Only with open comments"
              pressed={onlyOpenComments}
              activeClassName="text-blue"
              onClick={onToggleOnlyOpenComments}
            >
              <MessagesSquare aria-hidden="true" className="size-4" />
            </TreeToolbarButton>
          )}
          {canEdit && (
            <TreeToolbarButton label="Manage structure" className="ml-auto" onClick={onEditTree}>
              <Settings2 aria-hidden="true" className="size-4" />
            </TreeToolbarButton>
          )}
        </div>
      </TooltipProvider>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
        <TreeRow
          label="All product rules"
          title="product root"
          root
          count={counts ? counts.root.items : null}
          pending={counts ? counts.root.pending : undefined}
          open={counts ? counts.root.open : undefined}
          comments={counts ? counts.root.comments : undefined}
          selected={selection.domainId === null && selection.featureId === null}
          onClick={() => onSelect({ domainId: null, featureId: null })}
        />

        {domains.map((domain) => {
          const expanded = featureExpansion.domainId === domain.id;
          // Once the full list is in hand it REPLACES the bounded one the tree
          // route returned, so the reader never compares two lists.
          const features = expanded && featureExpansion.features !== null ? featureExpansion.features : domain.features;
          const domainCount = counts?.domains[domain.id] ?? null;

          return (
            <div key={domain.id} className="mt-1.5">
              <TreeRow
                label={domain.title}
                title={domain.id}
                archived={domain.archived}
                count={domainCount ? domainCount.items : null}
                pending={counts ? (domainCount?.pending ?? 0) : undefined}
                open={counts ? (domainCount?.open ?? 0) : undefined}
                comments={counts ? (domainCount?.comments ?? 0) : undefined}
                conditions={domain.appliesWhen}
                selected={selection.domainId === domain.id && selection.featureId === null}
                onClick={() => onSelect({ domainId: domain.id, featureId: null })}
              />

              {!filtering && features.length === 0 && domainCount !== null && domainCount.items === 0 && (
                <p className="px-2 pl-[22px] pt-px text-[11.5px] text-ink-4">declared, no items yet</p>
              )}

              {features.length > 0 && (
                <FeatureList
                  features={features}
                  parentId={null}
                  filter={filter}
                  counts={counts}
                  selection={selection}
                  onSelect={onSelect}
                />
              )}

              {domain.featuresTruncated && !(expanded && featureExpansion.features !== null) && (
                <div className="px-2 py-1">
                  <p className="text-[11.5px] text-ink-4">More features than this page shows.</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-2"
                    disabled={expanded && featureExpansion.loading}
                    onClick={() => onShowAllFeatures(domain.id)}
                  >
                    {expanded && featureExpansion.loading ? 'Loading features…' : 'Show all features'}
                  </Button>
                  {expanded && featureExpansion.errorMessage && (
                    <p className="text-[11.5px] text-warn-text">{featureExpansion.errorMessage}</p>
                  )}
                </div>
              )}

              {expanded && featureExpansion.features !== null && featureExpansion.truncated && (
                <p className="px-2 py-1 text-[11.5px] text-warn-text">
                  This domain has more features than one exhaustive read returns.
                </p>
              )}
            </div>
          );
        })}

        {hasMoreDomains && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            disabled={loadingMoreDomains}
            onClick={onLoadMoreDomains}
          >
            {loadingMoreDomains ? 'Loading…' : 'Load more domains'}
          </Button>
        )}

        <IntentDimensionsSection dimensions={dimensions} />
      </nav>
    </>
  );
}

function TreeToolbarButton({
  label,
  tooltip,
  pressed,
  activeClassName,
  className,
  onClick,
  children,
}: {
  /** The accessible name; constant for a toggle, whose state `pressed` carries. */
  label: string;
  /** Visible hint when it should differ from `label`. */
  tooltip?: string;
  /** Set for toggles; omitted for plain actions so no aria-pressed is announced. */
  pressed?: boolean;
  activeClassName?: string;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            'grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2 hover:text-ink-1',
            pressed ? (activeClassName ?? 'text-ink-1') : 'text-ink-3',
            pressed && 'bg-surface-2',
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One level of a domain's features. A sub-feature whose parent is not in the
 * loaded list (archived and hidden, or past the page bound) shows at the top
 * level rather than disappearing.
 */
function FeatureList({
  features,
  parentId,
  filter,
  counts,
  selection,
  onSelect,
}: {
  features: readonly IntentFeatureView[];
  parentId: string | null;
  filter: TreeFilter;
  counts: IntentTreeCounts | null;
  selection: IntentTreeSelection;
  onSelect: (selection: IntentTreeSelection) => void;
}) {
  const loaded = new Set(features.map((feature) => feature.id));
  const childrenOf = (id: string) => features.filter((feature) => feature.parentFeatureId === id);
  // A feature's count includes its sub-features', the way a domain's includes its features'.
  const totalIn = (field: keyof IntentCountCell, id: string, depth = 0): number =>
    (counts?.features[id]?.[field] ?? 0) +
    (depth < 8 ? childrenOf(id).reduce((total, child) => total + totalIn(field, child.id, depth + 1), 0) : 0);
  const level = features.filter(
    (feature) =>
      (parentId === null
        ? feature.parentFeatureId === null || !loaded.has(feature.parentFeatureId)
        : feature.parentFeatureId === parentId) && filter.every((field) => totalIn(field, feature.id) > 0),
  );
  if (level.length === 0) return null;
  return (
    <ul className="ml-3.5 border-l border-border-soft pl-3.5">
      {level.map((feature) => (
        <li key={feature.id}>
          <TreeRow
            label={feature.title}
            title={feature.id}
            archived={feature.archived}
            count={counts?.features[feature.id]?.items ?? null}
            pending={counts ? totalIn('pending', feature.id) : undefined}
            open={counts ? totalIn('open', feature.id) : undefined}
            comments={counts ? totalIn('comments', feature.id) : undefined}
            conditions={feature.appliesWhen}
            selected={selection.featureId === feature.id}
            onClick={() => onSelect({ domainId: feature.domainId, featureId: feature.id })}
          />
          <FeatureList
            features={features}
            parentId={feature.id}
            filter={filter}
            counts={counts}
            selection={selection}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

// Archived dimensions are excluded by the query, not filtered here.
function IntentDimensionsSection({ dimensions }: { dimensions?: IntentDimension[] | null }) {
  if (!dimensions || dimensions.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-soft pt-2.5">
      <p className="px-2 pb-1 text-[11.5px] font-medium uppercase tracking-[0.02em] text-ink-4">Dimensions</p>
      <ul className="flex flex-col gap-1.5 px-2">
        {dimensions.map((dimension) => (
          <li key={dimension.id} title={dimension.id}>
            <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <span className="truncate">{dimension.title}</span>
              {dimension.multi && (
                <span className="rounded border border-border px-1 text-[10.5px] text-ink-4">multi</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {dimension.values.map((value) => (
                <span
                  key={value.id}
                  title={value.id}
                  className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-ink-3"
                >
                  {value.title}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A domain or feature's own structural conditions (intent-dimensions-inheritance
 * spec, UC-3) as a marker on its row: the clause text lives in the tooltip and
 * the accessible name, because a line per node does not scale with the tree.
 * `undefined`/empty renders nothing — most nodes have no tree condition (AC-6).
 */
function TreeConditionMarker({ conditions }: { conditions?: TreeCondition[] }) {
  if (!conditions || conditions.length === 0) return null;
  const text = `Applies when ${conditions.map((clause) => contextConditionText(clause)).join(' and ')}`;
  return (
    <span role="img" title={text} aria-label={text} className="shrink-0 text-ink-4">
      <Funnel aria-hidden="true" className="size-3" />
    </span>
  );
}

function TreeRow({
  label,
  title,
  archived = false,
  count,
  pending,
  open,
  comments,
  conditions,
  root,
  selected,
  onClick,
}: {
  label: string;
  title: string;
  archived?: boolean;
  conditions?: TreeCondition[];
  /** Live items; `null` when no read in hand lists this node — then no number is drawn. */
  count: number | null;
  /** Waiting proposals; `undefined` while the counts are unread. */
  pending?: number;
  /** Open questions; `undefined` while the counts are unread. */
  open?: number;
  /** Open comment threads; `undefined` while the counts are unread. */
  comments?: number;
  root?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-[7px] rounded-md px-2 py-[5px] text-left text-[13.5px] transition-colors',
        selected
          ? 'bg-brand-wash text-brand-text'
          : root
            ? 'text-ink-1 hover:bg-surface-2'
            : 'text-ink-2 hover:bg-surface-2',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <TreeConditionMarker conditions={conditions} />
      {archived && <span className="rounded border border-border px-1 text-[10.5px] text-ink-4">archived</span>}
      <IntentCountBadges pending={pending} open={open} comments={comments} />
      {/* The product root's own attached items are normally zero, and a "0" on the
          row the overview counts in full reads as a contradiction. */}
      {count !== null && (!root || count > 0) && <span className="num shrink-0 text-[11.5px] text-ink-4">{count}</span>}
    </button>
  );
}
