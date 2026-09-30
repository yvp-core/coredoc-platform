import { IntentDetails } from './IntentDetails';
import { IntentSourceLabel } from './IntentSourceLabel';
/**
 * The item detail pane: statement, per-kind details, sources, code anchors and
 * the decision history.
 *
 * The load-bearing rule here is spec §6.4. An anchor carries TWO markers and
 * they are rendered as two marks, side by side, never folded into one status:
 *
 * - the anchor's own verdict (`matched` / `changed` / `missing`, or
 *   "unevaluated" when the graph could not be read at all), and
 * - the freshness of the snapshot that verdict came from.
 *
 * A matched anchor on a months-old snapshot is a real and honest result, and the
 * pane says both halves of it. The server's own caveat sentence
 * (`anchorWarning`) is shown verbatim rather than paraphrased. Workspace-wide
 * per-repo provenance is deliberately not listed: it covers every registered
 * repo, not the anchored ones, and each anchor row already carries freshness.
 *
 * The pane is pure props, including the anchor-refresh gesture: the panel holds
 * which confirm is open and which write is in flight, so a failed refresh can be
 * rendered beside its row without this component owning a mutation.
 */

import { History, Refresh } from '@solar-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import type {
  IntentContextMatch,
  IntentErrorEnvelope,
  IntentGraphEvidence,
  IntentItemAnchor,
  IntentTransition,
} from '../../../shared/intent-types.js';
import { IntentAnchorRow, type IntentAnchorRefreshOutcome } from './IntentAnchorRow';
import {
  authorityLabel,
  authorityVariant,
  formatIntentTimestamp,
  formatPayload,
  intentDetailFields,
  intentFlowSteps,
  intentPayloadVariants,
  kindLabel,
} from './intent-presentation';
import { intentAnchorKey } from './intent-panel-state';

/** Everything the anchor rows need from the panel, in one prop rather than five. */
export interface IntentAnchorRefreshState {
  /** The one anchor whose inline confirm is open, keyed by `intentAnchorKey`. */
  confirmingKey: string | null;
  /** The anchor whose refresh is in flight. */
  refreshingKey: string | null;
  outcomes: Readonly<Record<string, IntentAnchorRefreshOutcome>>;
  /** The last refusal, keyed the same way — a failure never wipes the pane. */
  errorKey: string | null;
  error: IntentErrorEnvelope | null;
  errorMessage?: string;
  onRequestRefresh: (anchor: IntentItemAnchor) => void;
  onCancelRefresh: () => void;
  onConfirmRefresh: (anchor: IntentItemAnchor) => void;
}

/**
 * Re-read this item with the local checkout resolved again (spec §6.3).
 *
 * A READ, so every role gets it: main compares the workspace's snapshot against
 * the commit each repo is actually on, and that answer goes stale the moment
 * someone commits. Without this the freshness a reader sees can only decay.
 */
export interface IntentFreshnessRecheck {
  busy: boolean;
  /** The re-read failed; the pane keeps the answer it already has and says so. */
  errorMessage?: string;
  onRecheck: () => void;
}

export interface IntentItemDetailProps {
  productionState?: React.ReactNode;
  itemId: string | null;
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
  freshness?: IntentFreshnessRecheck;
  onRetry: () => void;
  onLoadMoreTransitions?: () => void;
  /** The selected domain or feature, described in the pane while no item is open. */
  scope?: { title: string; statement: string } | null;
}

export function IntentItemDetail({
  productionState,
  itemId,
  match,
  graph,
  anchorWarning,
  transitions,
  hasMoreTransitions = false,
  loadingMoreTransitions = false,
  loading,
  errorMessage,
  anchorRefresh,
  freshness,
  onRetry,
  onLoadMoreTransitions,
  scope = null,
}: IntentItemDetailProps) {
  if (itemId === null && scope !== null && scope.statement.trim() !== '') {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="text-sm font-medium text-content-primary">{scope.title}</h3>
        <p className="whitespace-pre-wrap text-xs leading-5 text-content-secondary">{scope.statement}</p>
        <p className="text-[11px] leading-4 text-content-tertiary">Select an item to read its statement and history.</p>
      </div>
    );
  }

  if (itemId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-xs leading-5 text-content-tertiary">Select an item to read its statement and history.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-content-quaternary" />
      </div>
    );
  }

  if (errorMessage || match === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-xs text-content-secondary">Couldn't load this item.</p>
        {errorMessage && <p className="text-[11px] leading-4 text-content-tertiary">{errorMessage}</p>}
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
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
  // a payload is free-form on the wire (D9), so it must never simply vanish.
  const rawPayload = fields.length === 0 && steps === null && variants === null ? formatPayload(match.payload) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4 [overflow-wrap:anywhere] [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={authorityVariant(match.authority)}>{authorityLabel(match.authority)}</Badge>
          <Badge variant="outlineInitial">{kindLabel(match.kind)}</Badge>
          {match.proposedSuccessorOfId && (
            <Badge variant="initial">proposes to replace {match.proposedSuccessorOfId}</Badge>
          )}
          {match.supersededById && <Badge variant="initial">superseded by {match.supersededById}</Badge>}
        </div>
        <h3 className="text-sm font-semibold text-content-primary">{match.title}</h3>
        <p className="truncate font-mono text-[11px] text-content-quaternary" title={match.id}>
          {match.id}
        </p>
        <p className="text-[11px] leading-4 text-content-tertiary">
          v{match.version} · updated {formatIntentTimestamp(match.updatedAt)}
        </p>
      </header>

      {productionState}
      <Section title="Statement">
        <p className="text-xs leading-5 text-content-primary">{match.statement}</p>
        {match.rationale && <p className="mt-1.5 text-xs leading-5 text-content-secondary">{match.rationale}</p>}
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

      <Section title="Sources">
        {match.sources.length === 0 ? (
          <p className="text-[11px] text-content-quaternary">No provenance rows.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {match.sources.map((source) => (
              <li key={`${source.ref}\n${source.localId}`} className="flex items-start gap-1.5">
                <Badge variant="outlineInitial">{source.kind}</Badge>
                <IntentSourceLabel source={source} />
                {source.locator && (
                  <span className="text-[11px] leading-4 text-content-tertiary">{source.locator}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Code anchors"
        action={
          freshness && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={freshness.busy}
              onClick={freshness.onRecheck}
              title="Re-read this item with the local checkout resolved again"
            >
              <Refresh className="size-3" />
              {freshness.busy ? 'Re-checking…' : 'Re-check freshness'}
            </Button>
          )
        }
      >
        {match.anchors.length === 0 ? (
          <p className="text-[11px] text-content-quaternary">No code anchors.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {match.anchors.map((anchor) => {
              const key = intentAnchorKey(anchor);
              return (
                <IntentAnchorRow
                  key={key}
                  anchor={anchor}
                  confirming={anchorRefresh?.confirmingKey === key}
                  refreshing={anchorRefresh?.refreshingKey === key}
                  outcome={anchorRefresh?.outcomes[key] ?? null}
                  error={anchorRefresh?.errorKey === key ? anchorRefresh.error : null}
                  errorMessage={anchorRefresh?.errorKey === key ? anchorRefresh.errorMessage : undefined}
                  onRequestRefresh={() => anchorRefresh?.onRequestRefresh(anchor)}
                  onCancelRefresh={() => anchorRefresh?.onCancelRefresh()}
                  onConfirmRefresh={() => anchorRefresh?.onConfirmRefresh(anchor)}
                />
              );
            })}
          </ul>
        )}
        {freshness?.errorMessage && (
          <p className="mt-2 text-[11px] leading-4 text-content-warning">
            Couldn't re-check freshness — {freshness.errorMessage}
          </p>
        )}
        {anchorWarning && <p className="mt-2 text-[11px] leading-4 text-content-tertiary">{anchorWarning}</p>}
        {graph?.degradation && (
          <div className="mt-2 rounded-md bg-bg-tag-warning px-2.5 py-2">
            <p className="text-[11px] font-medium leading-4 text-content-warning">
              Graph unavailable ({graph.degradation.code})
            </p>
            <p className="mt-1 text-[11px] leading-4 text-content-secondary">{graph.degradation.remediation}</p>
            <p className="mt-1 text-[11px] leading-4 text-content-tertiary">
              Intent itself is unaffected — only anchor status and freshness are missing until a snapshot is readable.
            </p>
          </div>
        )}
      </Section>

      <Section title="Decision history">
        {transitions === null ? (
          <Spinner className="size-4 text-content-quaternary" />
        ) : transitions.length === 0 ? (
          <p className="text-[11px] text-content-quaternary">No transitions recorded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {transitions.map((transition) => (
              <li key={transition.id} className="flex flex-col gap-0.5 border-l-2 border-border-input pl-2">
                <span className="flex items-center gap-1.5 text-[11px] leading-4 text-content-primary">
                  <History className="size-3 text-content-quaternary" />
                  {/* A NULL `from` is an arrival, not a decision somebody made. */}
                  {transition.from === null
                    ? `Arrived as ${transition.to} · ${transition.authorizingSource.kind}`
                    : `${transition.from} → ${transition.to}`}
                </span>
                <span className="text-[11px] leading-4 text-content-secondary">{transition.reason}</span>
                <span className="font-mono text-[11px] text-content-quaternary">
                  {transition.actorRole} · {formatIntentTimestamp(transition.createdAt)} ·{' '}
                  {transition.authorizingSource.kind}:{transition.authorizingSource.ref}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hasMoreTransitions && onLoadMoreTransitions && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2 self-start"
            disabled={loadingMoreTransitions}
            onClick={onLoadMoreTransitions}
          >
            {loadingMoreTransitions ? 'Loading…' : 'Load older decisions'}
          </Button>
        )}
      </Section>

      <p className="border-t border-border-input pt-3 text-[11px] leading-4 text-content-tertiary">
        Intent is what the product promises, not what the code currently does. Anchors say where the promise was last
        seen in code; they never prove the code still keeps it.
      </p>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** An affordance that belongs to the section, on the header's trailing edge. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}
