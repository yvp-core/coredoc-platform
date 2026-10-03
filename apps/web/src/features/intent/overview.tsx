/**
 * The product overview: what the Items column shows when the product root is
 * selected.
 *
 * It answers three questions about the knowledge base as a whole — what state
 * its items are in, what is anchored in code, and what changed recently — and it
 * is careful about the difference between "measured" and "not measured": the
 * authority strip is counted over the item pages ACTUALLY LOADED and says so
 * while the server still has pages, and anchor health has no workspace-level
 * aggregate to report, so it says where the answer lives instead of showing a
 * number nobody can stand behind.
 */

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { ItemRow } from './items-list.js';
import { authorityShare, type IntentAuthorityTally } from './intent-panel-state.js';
import { formatIntentTimestamp, kindLabel } from './intent-presentation.js';
import type { IntentItemSummary, IntentTransition } from './types.js';

const SEGMENTS = [
  { key: 'accepted', label: 'Accepted', className: 'bg-brand' },
  { key: 'candidate', label: 'Candidate', className: 'bg-blue' },
  { key: 'rejected', label: 'Rejected', className: 'bg-danger' },
  { key: 'superseded', label: 'Superseded', className: 'bg-axis' },
] as const;

export interface IntentOverviewProps {
  /** Authority mix over the loaded items. */
  tally: IntentAuthorityTally;
  /** False while the server still has item pages — every number here is partial. */
  complete: boolean;
  domainCount: number;
  featureCount: number;
  /** Items attached to the product root itself (`domainId: null`). */
  productItems: IntentItemSummary[];
  /**
   * The workspace's most recent decisions, newest first. `null` while the ledger
   * read is in flight — the feed then says so instead of claiming nothing has
   * been decided.
   */
  decisions: IntentTransition[] | null;
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
  domainCount,
  featureCount,
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
      <div className="flex justify-center py-10">
        <Spinner className="text-ink-4" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-[18px] pt-3.5">
      <section>
        <Head>Intent set</Head>
        <div className="flex flex-wrap gap-[18px]">
          <Stat n={tally.total} label={complete ? 'items' : 'items loaded'} />
          <Stat n={domainCount} label="domains" />
          <Stat n={featureCount} label="features" />
        </div>

        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-track">
          {SEGMENTS.map((segment) =>
            tally[segment.key] > 0 ? (
              <span
                key={segment.key}
                aria-hidden="true"
                className={segment.className}
                style={{ width: `${authorityShare(tally[segment.key], tally.total)}%` }}
              />
            ) : null,
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap gap-3 text-[12px] text-ink-3">
          {SEGMENTS.map((segment) => (
            <span key={segment.key} className="num inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('size-[9px] rounded-[3px]', segment.className)} />
              {segment.label} {tally[segment.key]}
            </span>
          ))}
        </div>
        {!complete && (
          <p className="mt-1.5 text-[11.5px] text-ink-4">
            Counted over the item pages loaded so far — the workspace has more.
          </p>
        )}
      </section>

      <section>
        <Head>Anchor health</Head>
        <p className="text-[12px] text-ink-4">
          Anchor health is read one item at a time — open an item to see its anchors. Item-level and anchor-level counts
          measure different things and are never collapsed into one.
        </p>
      </section>

      <section>
        <Head>Product-level items</Head>
        {productItems.length === 0 ? (
          <p className="text-[12px] text-ink-4">
            Nothing is attached to the product root — every item lives in a domain.
          </p>
        ) : (
          <div className="-mx-4">
            {productItems.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                reasonOverride={kindLabel(item.kind)}
                onSelect={() => onSelectItem(item.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <Head>Recent decisions</Head>
        {decisionsErrorMessage ? (
          <p className="text-[12px] text-ink-4">Couldn't read the decision ledger — {decisionsErrorMessage}</p>
        ) : decisions === null ? (
          <Spinner className="text-ink-4" />
        ) : decisions.length === 0 ? (
          <p className="text-[12px] text-ink-4">No decisions recorded yet.</p>
        ) : (
          decisions.map((transition) => (
            <div
              key={transition.id}
              className="flex items-baseline gap-2 border-b border-border-soft py-[5px] text-[12.5px] last:border-b-0"
            >
              <span className="min-w-0 flex-1 text-ink-2">
                {/* A NULL `from` is an arrival, not a decision somebody made. */}
                {transition.from === null ? 'Arrived as ' : `${transition.from} → `}
                {transition.to} ·{' '}
                <button
                  type="button"
                  onClick={() => onSelectItem(transition.itemId)}
                  className="font-mono text-[11.5px] text-ink-3 hover:underline"
                >
                  {transition.itemId}
                </button>
              </span>
              <span className="num shrink-0 text-[11.5px] text-ink-4">
                {formatIntentTimestamp(transition.createdAt)} · {transition.actorRole}
              </span>
            </div>
          ))
        )}
      </section>

      {hasMore && (
        <Button variant="outline" size="sm" className="self-start" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? 'Loading…' : 'Load more items'}
        </Button>
      )}
    </div>
  );
}

function Head({ children }: { children: string }) {
  return <h4 className="mb-1.5 text-[12px] uppercase tracking-[0.04em] text-ink-4">{children}</h4>;
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div className="num text-[21px] font-medium leading-tight tracking-[-0.02em] text-ink-1">{n}</div>
      <div className="text-[12px] text-ink-4">{label}</div>
    </div>
  );
}
