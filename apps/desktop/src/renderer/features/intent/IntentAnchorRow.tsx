/**
 * One code anchor in the item detail pane, with the "Refresh baseline"
 * affordance (issue v1.1-01).
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
 * re-capture, and removing it is a different decision (out of scope here).
 */

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { IntentAnchorStatus, type IntentErrorEnvelope, type IntentItemAnchor } from '../../../shared/intent-types.js';
import {
  anchorStatusMark,
  anchorStatusVariant,
  snapshotFreshnessMark,
  snapshotFreshnessVariant,
} from './intent-presentation';

/** What a landed refresh moved the baseline from and to. */
export interface IntentAnchorRefreshOutcome {
  previousCapturedVersionedId: string;
  capturedVersionedId: string;
  /** False when the stored baseline already matched — the row's mark was stale, not the anchor. */
  changed: boolean;
}

export interface IntentAnchorRowProps {
  anchor: IntentItemAnchor;
  /** This row's inline confirm is open (the panel holds the one open confirm). */
  confirming: boolean;
  refreshing: boolean;
  outcome?: IntentAnchorRefreshOutcome | null;
  /** The server's structured refusal, rendered verbatim beside the row (spec §12). */
  error?: IntentErrorEnvelope | null;
  errorMessage?: string;
  onRequestRefresh: () => void;
  onCancelRefresh: () => void;
  onConfirmRefresh: () => void;
}

export function IntentAnchorRow({
  anchor,
  confirming,
  refreshing,
  outcome = null,
  error = null,
  errorMessage,
  onRequestRefresh,
  onCancelRefresh,
  onConfirmRefresh,
}: IntentAnchorRowProps) {
  const refreshable = anchor.status === IntentAnchorStatus.Changed;

  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border-input p-2">
      {/* A node id is a path, and a path that is cut in the middle names nothing
          — it wraps instead of truncating, and the title carries the versioned
          id the marks below are judged against. */}
      <span
        className="break-all font-mono text-[11px] leading-4 text-content-secondary"
        title={anchor.capturedVersionedId}
      >
        {anchor.repoKey} · {anchor.nodeId}
      </span>

      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant={anchorStatusVariant(anchor.status)}>{anchorStatusMark(anchor.status)}</Badge>
        <Badge variant={snapshotFreshnessVariant(anchor.snapshotFreshness)}>
          {snapshotFreshnessMark(anchor.snapshotFreshness)}
        </Badge>
        <Badge variant="outlineInitial">{anchor.nodeType}</Badge>
      </span>

      {anchor.mismatchReason && (
        <span className="text-[11px] leading-4 text-content-tertiary">Mismatch: {anchor.mismatchReason}</span>
      )}
      {anchor.rationale && <span className="text-[11px] leading-4 text-content-tertiary">{anchor.rationale}</span>}

      {outcome && (
        <span className="font-mono text-[11px] leading-4 text-content-secondary">
          {outcome.changed
            ? `baseline ${outcome.previousCapturedVersionedId} → ${outcome.capturedVersionedId}`
            : `baseline unchanged at ${outcome.capturedVersionedId}`}
        </span>
      )}

      {refreshable && !confirming && (
        <Button type="button" variant="ghost" size="xs" className="self-start" onClick={onRequestRefresh}>
          Refresh baseline
        </Button>
      )}

      {refreshable && confirming && (
        <div className="flex flex-col gap-1 rounded-md bg-bg-input p-2">
          <span className="text-[11px] leading-4 text-content-primary">
            Refresh to current? The baseline this anchor is judged against moves.
          </span>
          <span className="truncate font-mono text-[11px] text-content-secondary">
            {anchor.capturedVersionedId} → {anchor.currentVersionedId ?? 'current'}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" size="xs" variant="brand" disabled={refreshing} onClick={onConfirmRefresh}>
              {refreshing ? 'Refreshing…' : 'Refresh baseline'}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={refreshing} onClick={onCancelRefresh}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {(error || errorMessage) && (
        <div className="flex flex-col gap-1 rounded-md border border-border-input bg-bg-tag-warning p-2">
          {error ? (
            <>
              <span className="font-mono text-[11px] text-content-primary">{error.code}</span>
              <span className="text-[11px] leading-4 text-content-primary">{error.message}</span>
              {error.path.length > 0 && (
                <span className="font-mono text-[11px] text-content-secondary">at {error.path.join('.')}</span>
              )}
              {(error.details ?? []).map((detail) => (
                <span
                  key={`${detail.code}\n${detail.path.join('.')}\n${detail.message}`}
                  className="text-[11px] leading-4 text-content-secondary"
                >
                  {detail.code}: {detail.message}
                  {detail.path.length > 0 ? ` (${detail.path.join('.')})` : ''}
                </span>
              ))}
            </>
          ) : (
            <span className="text-[11px] leading-4 text-content-primary">{errorMessage}</span>
          )}
        </div>
      )}
    </li>
  );
}
