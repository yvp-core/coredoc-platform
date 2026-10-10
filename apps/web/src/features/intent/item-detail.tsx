import { IntentDetails } from './intent-details.js';
import { IntentSourceLabel } from './source-label.js';
import { IntentMarkdown } from './intent-markdown.js';
/**
 * The item detail pane: statement, per-kind details, sources, code anchors and
 * the decision history.
 *
 * The load-bearing rule is spec §6.4. An anchor carries TWO markers and they are
 * rendered as two marks, side by side, never folded into one status: the
 * anchor's own verdict, and the freshness of the snapshot that verdict came
 * from. The server's own caveat sentence (`anchorWarning`) is shown verbatim
 * rather than paraphrased.
 *
 * Pure props, including the anchor-refresh gesture: the panel holds which
 * confirm is open and which write is in flight, so a failed refresh renders
 * beside its row without this component owning a mutation.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isOpenQuestion } from './intent-agent-prompt.js';
import { Spinner } from '@/components/ui/spinner';
import type { ReactNode } from 'react';
import { IntentAnchorRow, type IntentAnchorRefreshOutcome } from './anchor-row.js';
import { intentAnchorKey } from './intent-panel-state.js';
import {
  authorityLabel,
  authorityVariant,
  formatIntentTimestamp,
  formatPayload,
  intentDetailFields,
  intentFlowSteps,
  intentPayloadVariants,
  kindLabel,
  stripSourceRefs,
} from './intent-presentation.js';
import type { IntentContextMatch, IntentGraphEvidence, IntentItemAnchor, IntentTransition } from './types.js';

/** Everything the anchor rows need from the panel, in one prop rather than five. */
export interface IntentAnchorRefreshState {
  /** Admin, owner or product (`hasIntentAccess`); the server re-checks every write. */
  canRefresh: boolean;
  /** The one anchor whose inline confirm is open, keyed by `intentAnchorKey`. */
  confirmingKey: string | null;
  refreshingKey: string | null;
  outcomes: Readonly<Record<string, IntentAnchorRefreshOutcome>>;
  /** The last refusal, keyed the same way — a failure never wipes the pane. */
  errorKey: string | null;
  errorMessage?: string;
  onRequestRefresh: (anchor: IntentItemAnchor) => void;
  onCancelRefresh: () => void;
  onConfirmRefresh: (anchor: IntentItemAnchor) => void;
}

export interface IntentItemDetailProps {
  itemId: string | null;
  productionState?: ReactNode;
  comments?: ReactNode;
  match: IntentContextMatch | null;
  graph: IntentGraphEvidence | null;
  /** The server's fixed caveat about what an anchor status does and does not prove. */
  anchorWarning?: string;
  /** Every history page loaded so far; the pane asks for older ones on demand. */
  transitions: IntentTransition[] | null;
  hasMoreTransitions?: boolean;
  loadingMoreTransitions?: boolean;
  loading: boolean;
  errorMessage?: string;
  anchorRefresh?: IntentAnchorRefreshState;
  onRetry: () => void;
  onLoadMoreTransitions?: () => void;
  /** The selected domain or feature, described in the pane while no item is open. */
  scope?: { title: string; statement: string } | null;
}

export function IntentItemDetail({
  itemId,
  productionState,
  comments,
  match,
  graph,
  anchorWarning,
  transitions,
  hasMoreTransitions = false,
  loadingMoreTransitions = false,
  loading,
  errorMessage,
  anchorRefresh,
  onRetry,
  onLoadMoreTransitions,
  scope = null,
}: IntentItemDetailProps) {
  if (itemId === null && scope !== null && scope.statement.trim() !== '') {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        <h3 className="text-[16px] font-medium leading-tight tracking-[-0.01em] text-ink-1">{scope.title}</h3>
        <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{scope.statement}</p>
        <p className="text-[13px] text-ink-4">Select an item.</p>
      </div>
    );
  }

  if (itemId === null) {
    return <p className="px-4 py-6 text-center text-[13px] text-ink-4">Select an item.</p>;
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="text-ink-4" />
      </div>
    );
  }

  if (errorMessage || match === null) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <p className="text-[13.5px] text-ink-2">Couldn't load this item.</p>
        {errorMessage && <p className="text-[12px] text-ink-4">{errorMessage}</p>}
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const fields = intentDetailFields(match.payload);
  const steps = intentFlowSteps(match.payload);
  const variants = intentPayloadVariants(match.payload);
  const hasConditions =
    (match.appliesWhen?.length ?? 0) > 0 ||
    (match.inheritedConditions?.domain?.length ?? 0) > 0 ||
    (match.inheritedConditions?.feature?.length ?? 0) > 0;
  // The JSON block is the fallback for a payload neither formatter understood —
  // a payload is free-form on the wire, so it must never simply vanish.
  const rawPayload = fields.length === 0 && steps === null && variants === null ? formatPayload(match.payload) : null;

  return (
    <div className="px-[18px] pb-[18px] pt-3.5">
      <div className="flex flex-col gap-[5px] border-b border-border-soft pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={authorityVariant(match.authority)}>{authorityLabel(match.authority)}</Badge>
          <Badge variant="reason">{kindLabel(match.kind)}</Badge>
          {isOpenQuestion(match) && <Badge variant="warn">Open question</Badge>}
          {match.proposedSuccessorOfId && (
            <Badge variant="replace">proposes to replace {match.proposedSuccessorOfId}</Badge>
          )}
          {match.supersededById && <Badge variant="superseded">superseded by {match.supersededById}</Badge>}
        </div>
        <h3 className="text-[16px] font-medium leading-tight tracking-[-0.01em] text-ink-1">{match.title}</h3>
        <p className="truncate font-mono text-[11.5px] text-ink-4" title={match.id}>
          {match.id}
        </p>
      </div>

      {productionState}
      <Section title="Text">
        {/* The item as written: its statement and the lines under it. Sources are listed below. */}
        <IntentMarkdown
          text={stripSourceRefs([match.statement, ...(match.body ?? [])].join('\n'))}
          className="text-[14.5px] leading-relaxed text-ink-1"
        />
        {match.rationale && <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{match.rationale}</p>}
      </Section>

      {(fields.length > 0 || steps !== null || variants !== null || rawPayload || hasConditions) && (
        <Section title="Details">
          <IntentDetails
            payload={match.payload}
            appliesWhen={match.appliesWhen}
            inheritedConditions={match.inheritedConditions}
            domainId={match.domainId}
            featureId={match.featureId}
          />
        </Section>
      )}

      {comments && <div className="border-b border-border-soft py-3">{comments}</div>}

      <Section title="Sources">
        {match.sources.length === 0 ? (
          <p className="text-[12px] text-ink-4">No provenance rows.</p>
        ) : (
          match.sources.map((source) => (
            <div key={`${source.ref}\n${source.localId}`} className="flex items-baseline gap-2 py-1 text-[13px]">
              <span className="rounded border border-border-soft px-[5px] text-[11px] uppercase tracking-[0.03em] text-ink-4">
                {source.kind}
              </span>
              <IntentSourceLabel source={source} />
            </div>
          ))
        )}
      </Section>

      <Section title="Code anchors">
        {match.anchors.length === 0 ? (
          <p className="text-[12px] text-ink-4">No code anchors.</p>
        ) : (
          <ul>
            {match.anchors.map((anchor) => {
              const key = intentAnchorKey(anchor);
              return (
                <IntentAnchorRow
                  key={key}
                  anchor={anchor}
                  canRefresh={anchorRefresh?.canRefresh ?? false}
                  confirming={anchorRefresh?.confirmingKey === key}
                  refreshing={anchorRefresh?.refreshingKey === key}
                  outcome={anchorRefresh?.outcomes[key] ?? null}
                  errorMessage={anchorRefresh?.errorKey === key ? anchorRefresh.errorMessage : undefined}
                  onRequestRefresh={() => anchorRefresh?.onRequestRefresh(anchor)}
                  onCancelRefresh={() => anchorRefresh?.onCancelRefresh()}
                  onConfirmRefresh={() => anchorRefresh?.onConfirmRefresh(anchor)}
                />
              );
            })}
          </ul>
        )}
        {anchorWarning && <p className="mt-2 text-[12px] text-ink-4">{anchorWarning}</p>}
        {graph?.degradation && (
          <div className="mt-2 rounded-lg bg-warn-wash px-2.5 py-2">
            <p className="text-[12.5px] text-warn-text">Graph unavailable ({graph.degradation.code})</p>
            <p className="mt-1 text-[12px] text-ink-2">{graph.degradation.remediation}</p>
            <p className="mt-1 text-[12px] text-ink-4">
              Intent itself is unaffected — only anchor status and freshness are missing until a snapshot is readable.
            </p>
          </div>
        )}
      </Section>

      <Section title="Decision history">
        {transitions === null ? (
          <Spinner className="text-ink-4" />
        ) : transitions.length === 0 ? (
          <p className="text-[12px] text-ink-4">No transitions recorded.</p>
        ) : (
          transitions.map((transition) => (
            <div
              key={transition.id}
              className="flex gap-2.5 border-b border-dashed border-border-soft py-1.5 text-[12.5px] last:border-b-0"
            >
              <span className="num shrink-0 pt-px text-[11.5px] text-ink-4">
                {formatIntentTimestamp(transition.createdAt)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-ink-1">
                  {/* A NULL `from` is an arrival, not a decision somebody made. */}
                  {transition.from === null ? `Arrived as ${transition.to}` : `${transition.from} → ${transition.to}`} ·{' '}
                  {transition.actorRole}
                </span>
                <span className="block text-[12px] text-ink-3">
                  {transition.reason} · {transition.authorizingSource.kind}:{transition.authorizingSource.ref}
                </span>
              </span>
            </div>
          ))
        )}
        {hasMoreTransitions && onLoadMoreTransitions && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={loadingMoreTransitions}
            onClick={onLoadMoreTransitions}
          >
            {loadingMoreTransitions ? 'Loading…' : 'Load older decisions'}
          </Button>
        )}
      </Section>

      <p className="pt-3 text-[11.5px] leading-4 text-ink-4">
        Intent describes intended behavior. Anchors are navigation evidence, not proof of implementation; anchor state
        and snapshot freshness are independent.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border-soft py-3 last:border-b-0">
      <h4 className="mb-1.5 text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{title}</h4>
      {children}
    </section>
  );
}
