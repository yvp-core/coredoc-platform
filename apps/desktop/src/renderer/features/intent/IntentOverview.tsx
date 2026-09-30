/**
 * The product overview: what the browse card shows in the Items column when the
 * product root is selected.
 *
 * It answers three questions about the knowledge base as a whole — what state
 * its items are in, what is anchored in code, and what changed recently — and it
 * is careful about the difference between "measured" and "not measured":
 *
 * - The authority strip is counted over the item pages ACTUALLY LOADED, and says
 *   so when the server still has pages.
 * - Anchor health is reported in two units that are not interchangeable (items
 *   that carry an anchor vs. anchors themselves), and right now the desktop has
 *   no read that carries anchors for a whole workspace — so it says that in
 *   words rather than showing a number it cannot stand behind.
 * - The decisions feed is the workspace's own transition ledger — what people
 *   decided, in their words — and it says so when the ledger is empty rather
 *   than falling back to item state, which answers a different question.
 */

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utils';
import type { IntentItemSummary, IntentTransition } from '../../../shared/intent-types.js';
import { authorityLabel, authorityVariant, formatIntentTimestamp, kindLabel } from './intent-presentation';
import { type IntentAuthorityTally, authorityShare } from './intent-panel-state';

export interface IntentOverviewProps {
  /** Authority mix over the loaded items. */
  tally: IntentAuthorityTally;
  /** False while the server still has item pages — every number here is partial. */
  complete: boolean;
  /** Items attached to the product root itself (`domainId: null`). */
  productItems: IntentItemSummary[];
  /**
   * The workspace's most recent decisions, newest first. `null` while the
   * ledger read is in flight or unavailable — the feed then says so instead of
   * claiming nothing has been decided.
   */
  decisions: IntentTransition[] | null;
  /** The decisions read failed; the feed says why rather than reading as empty. */
  decisionsErrorMessage?: string;
  selectedItemId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSelectItem: (itemId: string) => void;
  onLoadMore: () => void;
}

export function IntentOverview({
  tally,
  complete,
  productItems,
  decisions,
  decisionsErrorMessage,
  selectedItemId,
  loading,
  hasMore,
  loadingMore,
  onSelectItem,
  onLoadMore,
}: IntentOverviewProps) {
  if (loading) {
    return (
      <div className="flex min-h-[160px] items-center justify-center">
        <Spinner className="size-5 text-content-quaternary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 py-3">
      <header className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold text-content-primary">Whole product</h3>
        <p className="text-[11px] leading-4 text-content-tertiary">
          {complete
            ? `${tally.total} items across the workspace.`
            : `${tally.total} items loaded so far — the workspace has more pages.`}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Authority</h4>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
          <Segment className="bg-content-brand" count={tally.accepted} total={tally.total} />
          <Segment className="bg-dodger-blue-500" count={tally.candidate} total={tally.total} />
          <Segment className="bg-bg-warning" count={tally.rejected} total={tally.total} />
          <Segment className="bg-alto-300" count={tally.superseded} total={tally.total} />
        </div>
        <ul className="flex flex-wrap items-center gap-3">
          <Legend className="bg-content-brand" label="Accepted" count={tally.accepted} />
          {/* The candidate label is the text-safe blue (DESIGN.md): dodger-500 is
              a fill and drops under AA at 11px, so the dot keeps it and the word
              takes the dodger-600 step. */}
          <Legend
            className="bg-dodger-blue-500"
            labelClassName="text-content-tag-progress"
            label="Candidate"
            count={tally.candidate}
          />
          <Legend className="bg-bg-warning" label="Rejected" count={tally.rejected} />
          <Legend className="bg-alto-300" label="Superseded" count={tally.superseded} />
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Anchor health</h4>
        {/* When a workspace-level anchor aggregate exists, this becomes TWO
            numbers — items carrying an anchor, and anchors — which are different
            units and must never be collapsed into one. Until then a single line
            says where the answer lives; two rows of "not measured here" was a
            large block that measured nothing. */}
        <p className="text-[11px] leading-4 text-content-tertiary">
          Anchor health is read per item — open an item to see its anchors.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">
          Product-level items
        </h4>
        {productItems.length === 0 ? (
          <p className="text-[11px] leading-4 text-content-secondary">
            Nothing is attached to the product root — every item lives in a domain.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {productItems.map((item) => (
              <li key={item.id}>
                <OverviewRow item={item} selected={selectedItemId === item.id} onSelect={() => onSelectItem(item.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Recent decisions</h4>
        {decisionsErrorMessage ? (
          <p className="text-[11px] leading-4 text-content-secondary">
            Couldn't read the decision ledger — {decisionsErrorMessage}
          </p>
        ) : decisions === null ? (
          <Spinner className="size-4 text-content-quaternary" />
        ) : decisions.length === 0 ? (
          <p className="text-[11px] leading-4 text-content-secondary">No decisions recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {decisions.map((transition) => (
              <li key={transition.id} className="flex flex-col gap-0.5 px-1 py-1">
                <span className="flex items-center gap-2">
                  <Badge variant="outlineInitial">
                    {/* A NULL `from` is an arrival, not a decision somebody made. */}
                    {transition.from === null ? `Arrived as ${transition.to}` : `${transition.from} → ${transition.to}`}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => onSelectItem(transition.itemId)}
                    className="min-w-0 flex-1 truncate text-left font-mono text-[11px] leading-4 text-content-primary hover:underline"
                  >
                    {transition.itemId}
                  </button>
                  <span className="shrink-0 font-mono text-[11px] text-content-quaternary">
                    {formatIntentTimestamp(transition.createdAt)}
                  </span>
                </span>
                {transition.reason && (
                  <span className="truncate text-[11px] leading-4 text-content-secondary">{transition.reason}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] leading-4 text-content-tertiary">
          The workspace decision ledger, newest first — the full history of one item is on the item itself.
        </p>
      </section>

      {hasMore && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="self-start"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? 'Loading…' : 'Load more items'}
        </Button>
      )}
    </div>
  );
}

function Segment({ className, count, total }: { className: string; count: number; total: number }) {
  if (count <= 0) return null;
  return <span aria-hidden="true" className={className} style={{ width: `${authorityShare(count, total)}%` }} />;
}

function Legend({
  className,
  labelClassName,
  label,
  count,
}: {
  className: string;
  labelClassName?: string;
  label: string;
  count: number;
}) {
  return (
    <li className="flex items-center gap-1.5 text-[11px] leading-4 text-content-secondary">
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', className)} />
      <span className={labelClassName}>{label}</span>
      <span className="font-mono text-content-quaternary">{count}</span>
    </li>
  );
}

function OverviewRow({
  item,
  selected,
  onSelect,
}: {
  item: IntentItemSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border px-2 py-2 text-left transition-colors',
        'border-transparent hover:bg-bg-primary-hover',
        'data-[selected=true]:border-border-primary-selected data-[selected=true]:bg-bg-primary-selected',
      )}
    >
      <span className="truncate text-xs/relaxed font-medium text-content-primary">{item.title}</span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant={authorityVariant(item.authority)}>{authorityLabel(item.authority)}</Badge>
        <Badge variant="outlineInitial">{kindLabel(item.kind)}</Badge>
      </span>
      <span className="truncate font-mono text-[11px] text-content-quaternary">{item.id}</span>
    </button>
  );
}
