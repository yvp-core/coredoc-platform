/**
 * The Structure column of the browse card: the product root, the domains, and
 * each domain's features.
 *
 * All fetching lives in `IntentPanel`; this component only renders what it is
 * handed, which is what makes its states assertable without a DOM or a live IPC
 * bridge (the repo's renderer test convention — see
 * `../observability/PhaseAActivityView.tsx`).
 *
 * Two honesty rules shape the rows:
 *
 * - **A count is shown only when it is known.** The counts are tallied from the
 *   item pages actually in hand (`intentScopeCounts`); a scope nobody has read
 *   shows no number at all rather than a plausible wrong one.
 * - **Archived nodes are hidden by default and the toggle says so.** Archiving
 *   keeps children readable (spec §4.1/§4.2), so "hidden" must not read as
 *   "gone".
 */

import { AltArrowRight, Archive, Folder2, Notebook } from '@solar-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type {
  IntentDimension,
  IntentFeatureView,
  IntentTreeDomain,
  TreeCondition,
} from '../../../shared/intent-types.js';
import { contextConditionText } from './intent-presentation';
import {
  type IntentCountCell,
  type IntentScopeCounts,
  type IntentTreeSelection,
  EMPTY_INTENT_SCOPE_COUNTS,
  intentKnownCount,
} from './intent-panel-state';

export type { IntentTreeSelection } from './intent-panel-state';

/**
 * The full feature list of ONE domain, loaded on demand.
 *
 * The tree route bounds features per domain and flags `featuresTruncated`; that
 * flag used to be a dead-end sentence. This is the repair: the domain whose
 * "show all features" the reader pressed, and the pages of the features route
 * that came back for it.
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
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Structure</span>
        <Button type="button" variant="ghost" size="xs" title="Edit the tree" onClick={onEditTree}>
          Edit
        </Button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <ul className="flex flex-col gap-0.5 px-2 pb-3">
          <li>
            <TreeRow
              label="Product overview"
              id="product root"
              root
              count={counts.root}
              archived={false}
              selected={selection.domainId === null && selection.featureId === null}
              onClick={() => onSelect({ domainId: null, featureId: null })}
            />
          </li>

          {domains.map((domain) => {
            const expanded = featureExpansion.domainId === domain.id;
            // Once the full list is in hand it REPLACES the bounded one the tree
            // route returned, so the reader is never left comparing two lists.
            const features =
              expanded && featureExpansion.features !== null ? featureExpansion.features : domain.features;
            // A domain the whole-workspace read never mentioned holds nothing —
            // that is what makes "declared, no items yet" reachable.
            const domainCount = intentKnownCount(counts.domains[domain.id], counts);
            return (
              <li key={domain.id}>
                <TreeRow
                  label={domain.title}
                  id={domain.id}
                  archived={domain.archived}
                  count={domainCount}
                  selected={selection.domainId === domain.id && selection.featureId === null}
                  onClick={() => onSelect({ domainId: domain.id, featureId: null })}
                />
                <TreeConditionLine conditions={domain.appliesWhen} indent={false} />
                {features.length === 0 && domainCount !== null && domainCount.items === 0 && (
                  <p className="px-2 py-1 pl-7 text-[11px] leading-4 text-content-quaternary">declared, no items yet</p>
                )}
                <ul className="flex flex-col gap-0.5 pl-3">
                  {features.map((feature) => (
                    <li key={feature.id}>
                      <TreeRow
                        label={feature.title}
                        id={feature.id}
                        archived={feature.archived}
                        count={intentKnownCount(counts.features[feature.id], counts)}
                        nested
                        selected={selection.featureId === feature.id}
                        onClick={() => onSelect({ domainId: domain.id, featureId: feature.id })}
                      />
                      <TreeConditionLine conditions={feature.appliesWhen} indent />
                    </li>
                  ))}
                </ul>
                {domain.featuresTruncated && !(expanded && featureExpansion.features !== null) && (
                  <div className="flex flex-col items-start gap-0.5 px-2 py-1">
                    <p className="text-[11px] leading-4 text-content-quaternary">More features than this page shows.</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={expanded && featureExpansion.loading}
                      onClick={() => onShowAllFeatures(domain.id)}
                    >
                      {expanded && featureExpansion.loading ? 'Loading features…' : 'Show all features'}
                    </Button>
                    {expanded && featureExpansion.errorMessage && (
                      <p className="text-[11px] leading-4 text-content-warning">{featureExpansion.errorMessage}</p>
                    )}
                  </div>
                )}
                {expanded && featureExpansion.features !== null && featureExpansion.truncated && (
                  <p className="px-2 py-1 text-[11px] leading-4 text-content-warning">
                    This domain has more features than one exhaustive read returns.
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {hasMoreDomains && (
          <div className="px-2 pb-3">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-full"
              disabled={loadingMoreDomains}
              onClick={onLoadMoreDomains}
            >
              {loadingMoreDomains ? 'Loading…' : 'Load more domains'}
            </Button>
          </div>
        )}

        <IntentDimensionsSection dimensions={dimensions} />
      </div>

      <div className="border-t border-border-input px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={includeArchived}
          title={includeArchived ? 'Hide archived nodes' : 'Show archived nodes'}
          onClick={onToggleArchived}
        >
          <Archive className="size-3.5" />
          {includeArchived ? 'Archived shown' : 'Show archived'}
        </Button>
      </div>
    </div>
  );
}

// Archived dimensions are excluded by the query, not filtered here.
function IntentDimensionsSection({ dimensions }: { dimensions?: IntentDimension[] | null }) {
  if (!dimensions || dimensions.length === 0) return null;

  return (
    <div className="border-t border-border-input px-2 pb-2 pt-2">
      <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Dimensions</p>
      <ul className="flex flex-col gap-1.5 px-1">
        {dimensions.map((dimension) => (
          <li key={dimension.id} title={dimension.id}>
            <div className="flex items-center gap-1.5 text-xs text-content-secondary">
              <span className="truncate">{dimension.title}</span>
              {dimension.multi && <Badge variant="outlineInitial">multi</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {dimension.values.map((value) => (
                <span
                  key={value.id}
                  title={value.id}
                  className="rounded-full bg-bg-primary-hover px-1.5 py-0.5 text-[11px] text-content-tertiary"
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
 * spec, UC-3), as a compact line under its row. `undefined`/empty renders
 * nothing — most nodes have no tree condition (spec §AC-6).
 */
function TreeConditionLine({ conditions, indent }: { conditions?: TreeCondition[]; indent: boolean }) {
  if (!conditions || conditions.length === 0) return null;
  return (
    <p className={cn('px-2 py-0.5 text-[11px] leading-4 text-content-quaternary', indent ? 'pl-7' : 'pl-2')}>
      {conditions.map((clause) => contextConditionText(clause)).join(' · ')}
    </p>
  );
}

function TreeRow({
  label,
  id,
  archived,
  count,
  nested,
  root,
  selected,
  onClick,
}: {
  label: string;
  id: string;
  archived: boolean;
  /** `null` when nothing has been read for this scope yet — then no number is drawn. */
  count: IntentCountCell | null;
  nested?: boolean;
  root?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={id}
      data-selected={selected}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs/relaxed transition-colors',
        'font-normal text-content-secondary hover:bg-bg-primary-hover',
        'data-[selected=true]:bg-bg-primary-selected data-[selected=true]:font-semibold data-[selected=true]:text-content-primary',
      )}
    >
      {root ? (
        <Notebook className="size-3.5 shrink-0 text-content-quaternary" />
      ) : nested ? (
        <AltArrowRight className="size-3 shrink-0 text-content-quaternary" />
      ) : (
        <Folder2 className="size-3.5 shrink-0 text-content-quaternary" />
      )}
      <span className="truncate">{label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {count !== null && count.candidates > 0 && (
          // Decorative: the dot repeats the candidate state the count and the
          // item rows already say in words (DESIGN.md — dodger-500 is a fill).
          <span aria-hidden="true" className="size-1.5 rounded-full bg-dodger-blue-500" />
        )}
        {/* The product root's own attached items are normally zero, and a "0" on
            the row the header already counts in full read as a contradiction. */}
        {count !== null && (!root || count.items > 0) && (
          <span
            className={cn(
              'font-mono text-[11px]',
              // Beside the candidate dot the number IS the candidate signal, and
              // dodger-600 is the text-safe step for it (DESIGN.md).
              count.candidates > 0 ? 'text-content-tag-progress' : 'text-content-quaternary',
            )}
          >
            {count.items}
          </span>
        )}
        {archived && <Badge variant="outlineInitial">Archived</Badge>}
      </span>
    </button>
  );
}
