/**
 * One code anchor in the item detail pane, with the admin-only "Refresh
 * baseline" affordance.
 *
 * THE TWO MARKS STAY INDEPENDENT (spec §6.4): the anchor's own verdict
 * (`matched` / `changed` / `missing`, or "unevaluated" when the graph could not
 * be read at all) and the freshness of the snapshot that verdict came from are
 * two statements, never one. A matched anchor on a months-old snapshot is a real
 * and honest result, and the row says both halves of it.
 *
 * THE REFRESH IS TWO CLICKS, and the confirm names both versioned ids: refreshing
 * a baseline says "the code moved and the intent still holds", which is a claim
 * only a human can make. A `missing` anchor gets no button — there is nothing to
 * re-capture.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IntentAnchorStatus, type IntentItemAnchor } from './types.js';
import {
  anchorStatusMark,
  anchorStatusVariant,
  snapshotFreshnessMark,
  snapshotFreshnessVariant,
} from './intent-presentation.js';

/** What a landed refresh moved the baseline from and to. */
export interface IntentAnchorRefreshOutcome {
  previousCapturedVersionedId: string;
  capturedVersionedId: string;
  /** False when the stored baseline already matched — the row's mark was stale, not the anchor. */
  changed: boolean;
}

interface IntentAnchorRowProps {
  anchor: IntentItemAnchor;
  /** Admin, owner or product (`hasIntentAccess`); the server re-checks every write. */
  canRefresh: boolean;
  /** This row's inline confirm is open (the panel holds the one open confirm). */
  confirming: boolean;
  refreshing: boolean;
  outcome?: IntentAnchorRefreshOutcome | null;
  errorMessage?: string;
  onRequestRefresh: () => void;
  onCancelRefresh: () => void;
  onConfirmRefresh: () => void;
}

export function IntentAnchorRow({
  anchor,
  canRefresh,
  confirming,
  refreshing,
  outcome = null,
  errorMessage,
  onRequestRefresh,
  onCancelRefresh,
  onConfirmRefresh,
}: IntentAnchorRowProps) {
  const refreshable = canRefresh && anchor.status === IntentAnchorStatus.Changed;

  return (
    <li className="border-b border-dashed border-border-soft py-1.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-[7px]">
        {/* A node id is a path, and a path cut in the middle names nothing — it
            wraps instead of truncating. */}
        <span className="break-all font-mono text-[12.5px] text-ink-2" title={anchor.capturedVersionedId}>
          {anchor.repoKey} · {anchor.nodeId}
        </span>
        <span className="rounded border border-border-soft px-1 text-[10.5px] text-ink-4">{anchor.nodeType}</span>
        <Badge variant={anchorStatusVariant(anchor.status)}>{anchorStatusMark(anchor.status)}</Badge>
        <Badge variant={snapshotFreshnessVariant(anchor.snapshotFreshness)}>
          {snapshotFreshnessMark(anchor.snapshotFreshness)}
        </Badge>
      </div>

      {anchor.mismatchReason && <p className="mt-0.5 text-[12px] text-ink-4">Mismatch: {anchor.mismatchReason}</p>}
      {anchor.rationale && <p className="mt-0.5 text-[12px] text-ink-4">{anchor.rationale}</p>}

      {outcome && (
        <p className="mt-1 font-mono text-[12px] text-ink-2">
          {outcome.changed
            ? `baseline ${outcome.previousCapturedVersionedId} → ${outcome.capturedVersionedId}`
            : `baseline unchanged at ${outcome.capturedVersionedId}`}
        </p>
      )}

      {refreshable && !confirming && (
        <Button variant="ghost" size="sm" className="mt-1 px-2" onClick={onRequestRefresh}>
          Refresh baseline
        </Button>
      )}

      {refreshable && confirming && (
        <div className="mt-1.5 flex flex-col gap-1 rounded-lg bg-surface-2 p-2">
          <span className="text-[12.5px] text-ink-1">
            Refresh to current? The baseline this anchor is judged against moves.
          </span>
          <span className="truncate font-mono text-[12px] text-ink-2">
            {anchor.capturedVersionedId} → {anchor.currentVersionedId ?? 'current'}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={refreshing} onClick={onConfirmRefresh}>
              {refreshing ? 'Refreshing…' : 'Refresh baseline'}
            </Button>
            <Button size="sm" variant="ghost" disabled={refreshing} onClick={onCancelRefresh}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {errorMessage && (
        <p className="mt-1.5 rounded-lg bg-warn-wash px-2.5 py-1.5 text-[12px] text-warn-text">{errorMessage}</p>
      )}
    </li>
  );
}
