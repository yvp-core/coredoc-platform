/**
 * The Structure column of the browse card: the product root, the domains, and
 * each domain's features.
 *
 * All fetching lives in the panel; this component only renders what it is
 * handed. Two honesty rules shape the rows:
 *
 * - **A count is shown only when it is known.** The counts are tallied from the
 *   item pages actually in hand; a scope nobody has read shows no number at all
 *   rather than a plausible wrong one.
 * - **Archived nodes are hidden by default and the toggle says so.** Archiving
 *   keeps children readable, so "hidden" must not read as "gone".
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Funnel } from 'lucide-react';
import {
  EMPTY_INTENT_SCOPE_COUNTS,
  intentKnownCount,
  type IntentCountCell,
  type IntentScopeCounts,
  type IntentTreeSelection,
} from './intent-panel-state.js';
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
  /** Counts for the scopes the loaded item pages cover; the rest stay silent. */
  counts?: IntentScopeCounts;
  featureExpansion: IntentFeatureExpansion;
  selection: IntentTreeSelection;
  includeArchived: boolean;
  /** Admin/owner only; a member sees the tree read-only (spec §5). */
  canEdit: boolean;
  hasMoreDomains: boolean;
  loadingMoreDomains: boolean;
  onSelect: (selection: IntentTreeSelection) => void;
  onToggleArchived: () => void;
  onEditTree: () => void;
  onLoadMoreDomains: () => void;
  onShowAllFeatures: (domainId: string) => void;
}

export function IntentTreeBrowser({
  domains: domainPages,
  dimensions,
  counts = EMPTY_INTENT_SCOPE_COUNTS,
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
}: IntentTreeBrowserProps) {
  const domains = domainPages ?? [];

  return (
    <>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
        <TreeRow
          label="All product rules"
          title="product root"
          root
          count={counts.root}
          selected={selection.domainId === null && selection.featureId === null}
          onClick={() => onSelect({ domainId: null, featureId: null })}
        />

        {domains.map((domain) => {
          const expanded = featureExpansion.domainId === domain.id;
          // Once the full list is in hand it REPLACES the bounded one the tree
          // route returned, so the reader never compares two lists.
          const features = expanded && featureExpansion.features !== null ? featureExpansion.features : domain.features;
          // A domain the whole-workspace read never mentioned holds nothing —
          // that is what makes "declared, no items yet" reachable.
          const domainCount = intentKnownCount(counts.domains[domain.id], counts);

          return (
            <div key={domain.id} className="mt-1.5">
              <TreeRow
                label={domain.title}
                title={domain.id}
                archived={domain.archived}
                count={domainCount}
                conditions={domain.appliesWhen}
                selected={selection.domainId === domain.id && selection.featureId === null}
                onClick={() => onSelect({ domainId: domain.id, featureId: null })}
              />

              {features.length === 0 && domainCount !== null && domainCount.items === 0 && (
                <p className="px-2 pl-[22px] pt-px text-[10.5px] text-ink-4">declared, no items yet</p>
              )}

              {features.length > 0 && (
                <ul className="ml-3.5 border-l border-border-soft pl-3.5">
                  {features.map((feature) => (
                    <li key={feature.id}>
                      <TreeRow
                        label={feature.title}
                        title={feature.id}
                        archived={feature.archived}
                        count={intentKnownCount(counts.features[feature.id], counts)}
                        conditions={feature.appliesWhen}
                        selected={selection.featureId === feature.id}
                        onClick={() => onSelect({ domainId: domain.id, featureId: feature.id })}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {domain.featuresTruncated && !(expanded && featureExpansion.features !== null) && (
                <div className="px-2 py-1">
                  <p className="text-[10.5px] text-ink-4">More features than this page shows.</p>
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
                    <p className="text-[10.5px] text-warn-text">{featureExpansion.errorMessage}</p>
                  )}
                </div>
              )}

              {expanded && featureExpansion.features !== null && featureExpansion.truncated && (
                <p className="px-2 py-1 text-[10.5px] text-warn-text">
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

      <div className="flex items-center justify-between gap-2 border-t border-border-soft px-3.5 py-2">
        <button
          type="button"
          aria-pressed={includeArchived}
          onClick={onToggleArchived}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11.5px] transition-colors hover:bg-surface-2 hover:text-ink-1',
            includeArchived ? 'text-brand-text' : 'text-ink-3',
          )}
        >
          {includeArchived ? 'Hide archived' : 'Show archived'}
        </button>
        {canEdit && (
          <Button variant="ghost" size="sm" className="px-2" onClick={onEditTree}>
            Manage structure
          </Button>
        )}
      </div>
    </>
  );
}

// Archived dimensions are excluded by the query, not filtered here.
function IntentDimensionsSection({ dimensions }: { dimensions?: IntentDimension[] | null }) {
  if (!dimensions || dimensions.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-soft pt-2.5">
      <p className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.02em] text-ink-4">Dimensions</p>
      <ul className="flex flex-col gap-1.5 px-2">
        {dimensions.map((dimension) => (
          <li key={dimension.id} title={dimension.id}>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <span className="truncate">{dimension.title}</span>
              {dimension.multi && (
                <span className="rounded border border-border px-1 text-[9.5px] text-ink-4">multi</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {dimension.values.map((value) => (
                <span
                  key={value.id}
                  title={value.id}
                  className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-3"
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
  conditions,
  root,
  selected,
  onClick,
}: {
  label: string;
  title: string;
  archived?: boolean;
  conditions?: TreeCondition[];
  /** `null` when nothing has been read for this scope yet — then no number is drawn. */
  count: IntentCountCell | null;
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
        'flex w-full items-center gap-[7px] rounded-md px-2 py-[5px] text-left text-[12.5px] transition-colors',
        selected
          ? 'bg-brand-wash text-brand-text'
          : root
            ? 'text-ink-1 hover:bg-surface-2'
            : 'text-ink-2 hover:bg-surface-2',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <TreeConditionMarker conditions={conditions} />
      {archived && <span className="rounded border border-border px-1 text-[9.5px] text-ink-4">archived</span>}
      {count !== null && count.candidates > 0 && (
        // Decorative: the count and the item rows already say "candidate" in words.
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-blue" />
      )}
      {/* The product root's own attached items are normally zero, and a "0" on the
          row the overview counts in full reads as a contradiction. */}
      {count !== null && (!root || count.items > 0) && (
        <span className="num shrink-0 text-[10.5px] text-ink-4">{count.items}</span>
      )}
    </button>
  );
}
