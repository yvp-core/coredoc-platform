/**
 * The review surface: the waiting queue on the left, ONE decision batch panel on
 * the right.
 *
 * Four contract facts shape this component:
 *
 * 1. Provenance is per BATCH. It lives in `IntentBatchPanel`, once, and
 *    `buildReviewRequest` is the only assembler — a card cannot grow its own
 *    provenance field.
 * 2. A refusal is a per-item VALUE inside a 200 response, not a failed request.
 *    Results render next to the card they belong to.
 * 3. A stale `expectedVersion` is the one refusal with a repair: the conflicted
 *    id is re-fetched and the reviewer decides again against what the item says
 *    now. Nothing is auto-retried — the decision is always a human's.
 * 4. A supersession is expressed on the SUCCESSOR's card: the candidate carrying
 *    `proposedSuccessorOfId` is the one offering to replace an accepted item.
 *
 * The queue row is payload-free by design — it is the server's queue projection.
 * Statements, sources and the successor half of a supersede diff arrive through
 * `candidateItems`, and every one of them degrades to a plain sentence when the
 * record is not loaded: this surface never renders a blank statement as if it
 * were the content.
 *
 * A member may READ the queue (`@WorkspaceRole('member')` on the route) but not
 * decide it, so their actions are disabled rather than hidden and the panel says
 * who can act.
 */

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IntentBatchPanel, type IntentStagedCount } from './batch-panel.js';
import { IntentSupersedeDiff } from './supersede-diff.js';
import { IntentDetails } from './intent-details.js';
import { IntentSourceLabel } from './source-label.js';
import {
  authoringHintText,
  intentPayloadVariants,
  kindLabel,
  outcomeLabel,
  outcomeVariant,
} from './intent-presentation.js';
import {
  applyProvenanceSource,
  buildReviewRequest,
  cardVersionConflict,
  draftsAfterResults,
  manualProvenancePreset,
  planReviewBatch,
  restampPredecessorVersion,
  reviewResultsByCard,
  sharedProvenanceSource,
  stageDraft,
  stagedPredecessorVersion,
  todayIsoDate,
  unstageDraft,
  type IntentCardConflict,
  type IntentCardDraft,
  type IntentDraftDecision,
  type IntentProvenanceField,
  type IntentProvenanceForm,
  type IntentProvenanceTouched,
  type IntentStagedCard,
} from './intent-review-request.js';
import {
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentContextMatch,
  type IntentItemSource,
  type IntentReviewDecisionResult,
  type IntentReviewQueueItem,
} from './types.js';

/**
 * The actions a reviewer picks from a card. `defer` and `needs_edit` are wire
 * actions like the other two — the server records the transition and leaves the
 * authority alone — so they are staged, counted and submitted the same way.
 */
const CARD_ACTIONS: readonly IntentReviewAction[] = [
  IntentReviewAction.Accept,
  IntentReviewAction.Reject,
  IntentReviewAction.Defer,
  IntentReviewAction.NeedsEdit,
];

const ACTION_LABELS: Record<IntentReviewAction, string> = {
  [IntentReviewAction.Accept]: 'Accept',
  [IntentReviewAction.Reject]: 'Reject',
  [IntentReviewAction.Supersede]: 'Supersede predecessor',
  [IntentReviewAction.Defer]: 'Defer',
  [IntentReviewAction.NeedsEdit]: 'Needs edit',
};

export const EMPTY_PROVENANCE_FORM: IntentProvenanceForm = {
  kind: IntentSourceKind.Spec,
  ref: '',
  localId: '',
  revision: '',
  workItemProvider: '',
  workItemId: '',
  workItemDisplayKey: '',
  workItemUrl: '',
};

/** One domain's share of the loaded page. `domainId: null` is the product root. */
export interface IntentQueueGroup {
  domainId: string | null;
  items: IntentReviewQueueItem[];
}

/**
 * Group the page by domain, in the order the server returned the rows, with the
 * product root LAST. First-appearance order rather than an alphabetical sort
 * keeps the server's ordering — oldest waiting first — visible.
 */
export function groupQueueByDomain(rows: readonly IntentReviewQueueItem[]): IntentQueueGroup[] {
  // Keyed on `domainId` ITSELF, `null` included: a Map takes null as a key, so
  // the product root needs no sentinel a real domain id could collide with.
  const groups = new Map<string | null, IntentQueueGroup>();
  for (const row of rows) {
    const group = groups.get(row.domainId) ?? { domainId: row.domainId, items: [] };
    group.items.push(row);
    groups.set(row.domainId, group);
  }
  const ordered = [...groups.values()];
  return [...ordered.filter((group) => group.domainId !== null), ...ordered.filter((group) => group.domainId === null)];
}

export interface IntentReviewQueueProps {
  candidates: IntentReviewQueueItem[] | null;
  /** Current version of every accepted item a candidate proposes to replace. */
  predecessorVersions: Readonly<Record<string, number>>;
  predecessorTitles?: Readonly<Record<string, string>>;
  /** Full predecessor records — the "before" half of the supersede diff. */
  predecessorItems?: Readonly<Record<string, IntentContextMatch>>;
  /** Full records for the CANDIDATES on this page: statement, sources, payload. */
  candidateItems?: Readonly<Record<string, IntentContextMatch>>;
  domainNames?: Readonly<Record<string, string>>;
  featureNames?: Readonly<Record<string, string>>;
  /** The by-id reads are still in flight — not the same as "could not be read". */
  predecessorsLoading?: boolean;
  predecessorsTruncated?: boolean;
  candidatesTruncated?: boolean;
  onLoadMore?: () => void;
  loading: boolean;
  /** Admin/owner only; a member reads the queue but decides nothing (spec §5). */
  canReview: boolean;
  submitting: boolean;
  /** Per-decision results from the last submitted batch. */
  results: IntentReviewDecisionResult[] | null;
  /** The QUEUE could not be read — the only failure that replaces the surface. */
  errorMessage?: string;
  /** The last SUBMIT failed. Rendered beside the cards, never instead of them. */
  submitErrorMessage?: string;
  /** The reviewer's handle, for the "Manual decision" preset's reference. */
  reviewerHandle?: string;
  /** Today as `YYYY-MM-DD`, injected as a FUNCTION: no render path reads the clock. */
  today?: () => string;
  onSubmit: (drafts: IntentDraftDecision[], provenance: IntentProvenanceForm) => void;
  /** Re-read exactly the ids a stale-version refusal named. */
  onRefetchConflicts: (itemIds: string[]) => void;
  onRetry: () => void;
}

export function IntentReviewQueue({
  candidates,
  predecessorVersions,
  predecessorTitles = {},
  predecessorItems = {},
  candidateItems = {},
  domainNames = {},
  featureNames = {},
  predecessorsLoading = false,
  predecessorsTruncated = false,
  candidatesTruncated = false,
  onLoadMore,
  loading,
  canReview,
  submitting,
  results,
  errorMessage,
  submitErrorMessage,
  reviewerHandle,
  today = todayIsoDate,
  onSubmit,
  onRefetchConflicts,
  onRetry,
}: IntentReviewQueueProps) {
  const [provenance, setProvenance] = useState<IntentProvenanceForm>(EMPTY_PROVENANCE_FORM);
  /** Fields the reviewer typed in: a prefill never overwrites one of these. */
  const [touched, setTouched] = useState<IntentProvenanceTouched>({});
  const [drafts, setDrafts] = useState<Record<string, IntentCardDraft>>({});
  const [batchReason, setBatchReason] = useState('');
  const [issues, setIssues] = useState<readonly string[]>([]);

  const rows = useMemo(() => candidates ?? [], [candidates]);
  const groups = useMemo(() => groupQueueByDomain(rows), [rows]);

  // A supersede decision's subject is the predecessor, so a card's result is not
  // necessarily keyed on the card — see `reviewResultsByCard`.
  const resultsByCard = reviewResultsByCard(results, rows);
  const stagedRows = rows.filter((row) => drafts[row.id] !== undefined);

  /**
   * A submitted batch clears the drafts the server CONFIRMED and keeps only the
   * refused ones. Without this every confirmed decision stayed staged and was
   * re-sent by the next submit — `defer` and `needs_edit` are wire actions.
   */
  // Keyed on `results` alone: `rows` changes on every queue refetch, and
  // re-running there would re-apply a batch's outcomes to fresh drafts.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (results === null) return;
    setDrafts((current) => draftsAfterResults(current, reviewResultsByCard(results, rowsRef.current)));
  }, [results]);

  /**
   * The batch's authorizing source, prefilled from the staged candidates when
   * they all cite the same one. Derived, not written into state: a field the
   * reviewer edits is `touched` from then on, so the prefill applies exactly
   * once and can never come back over their typing.
   */
  const sharedSource = sharedProvenanceSource(stagedRows.map((row) => candidateItems[row.id]?.sources ?? []));
  const effectiveProvenance =
    sharedSource.state === 'single' ? applyProvenanceSource(provenance, touched, sharedSource.source) : provenance;

  if (loading) {
    return (
      <Card className="flex justify-center py-12">
        <Spinner className="text-ink-4" />
      </Card>
    );
  }

  if (errorMessage) {
    return (
      <Card className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-[12.5px] text-ink-2">Couldn't load the review queue.</p>
        <p className="max-w-md text-[11px] text-ink-4">{errorMessage}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </Card>
    );
  }

  const conflictOf = (item: IntentReviewQueueItem): IntentCardConflict | null => {
    const predecessorId = item.proposedSuccessorOfId;
    const loaded = predecessorId === null ? undefined : predecessorVersions[predecessorId];
    const staged = drafts[item.id]?.predecessorVersion;
    const result = resultsByCard.get(item.id);
    return cardVersionConflict({
      itemId: item.id,
      itemVersion: item.version,
      predecessorId,
      ...(loaded === undefined ? {} : { predecessorVersion: loaded }),
      ...(staged === undefined ? {} : { stagedPredecessorVersion: staged }),
      ...(result === undefined ? {} : { result }),
    });
  };

  const stageAction = (item: IntentReviewQueueItem, action: IntentReviewAction) => {
    // Only an ACCEPT on a replacement carries the predecessor's expected version
    // on the wire, so only that action freezes it.
    const frozen = stagedPredecessorVersion({
      action,
      predecessorId: item.proposedSuccessorOfId,
      predecessorVersions,
    });
    setDrafts((current) =>
      current[item.id]?.action === action
        ? unstageDraft(current, item.id)
        : stageDraft(current, item.id, action, frozen),
    );
  };

  /** Clear one card's decision — the way out of a card that cannot be decided. */
  const unstage = (itemId: string) => setDrafts((current) => unstageDraft(current, itemId));

  /**
   * Re-fetch one conflicted card and acknowledge the version it conflicted on.
   * Without the re-stamp the frozen number never moves and the card stays
   * blocked forever; if the re-read brings a NEWER version, the comparison
   * raises the conflict again — the protection is acknowledged, not spent.
   */
  const refetchCard = (item: IntentReviewQueueItem, subjectId: string) => {
    const predecessorId = item.proposedSuccessorOfId;
    if (predecessorId !== null) {
      setDrafts((current) => restampPredecessorVersion(current, item.id, predecessorVersions[predecessorId]));
    }
    onRefetchConflicts([subjectId]);
  };

  const setReason = (itemId: string, reason: string) => {
    setDrafts((current) => {
      const existing = current[itemId];
      if (existing === undefined) return current;
      return { ...current, [itemId]: { ...existing, reason } };
    });
  };

  const changeProvenance = (patch: Partial<IntentProvenanceForm>, field?: IntentProvenanceField) => {
    setProvenance((current) => ({ ...current, ...patch }));
    if (field !== undefined) setTouched((current) => ({ ...current, [field]: true }));
  };

  const useSharedSource = () => {
    if (sharedSource.state === 'none') return;
    const source: IntentItemSource = sharedSource.state === 'single' ? sharedSource.source : sharedSource.first;
    // Chosen explicitly, so it is the reviewer's own value from now on.
    setProvenance((current) => applyProvenanceSource(current, {}, source));
    setTouched({ kind: true, ref: true, localId: true, revision: true });
  };

  const applyManualPreset = () => {
    setProvenance((current) =>
      manualProvenancePreset(current, {
        ...(reviewerHandle === undefined ? {} : { reviewerHandle }),
        today: today(),
      }),
    );
    setTouched((current) => ({ ...current, kind: true, ref: true, localId: true }));
  };

  const submit = () => {
    const cards: IntentStagedCard[] = [];
    for (const item of rows) {
      const draft = drafts[item.id];
      if (draft === undefined) continue;
      cards.push({
        itemId: item.id,
        itemVersion: item.version,
        title: item.title,
        proposedSuccessorOfId: item.proposedSuccessorOfId,
        draft,
        conflicted: conflictOf(item) !== null,
      });
    }

    // A conflicted card is LEFT OUT with its own reason and the rest of the
    // batch goes: the wire contract is per-decision anyway.
    const plan = planReviewBatch({ cards, predecessorVersions, batchReason });

    // Local shape check only; the server owns every other judgment. The key here
    // is a placeholder — the caller mints the real one per submitted attempt.
    const built = buildReviewRequest(effectiveProvenance, plan.pending, 'preflight');
    if (!built.ok) {
      setIssues([...built.issues, ...plan.skipped]);
      return;
    }
    setIssues(plan.skipped);
    onSubmit(plan.pending, effectiveProvenance);
  };

  const stagedCounts: IntentStagedCount[] = CARD_ACTIONS.map((action) => ({
    label: ACTION_LABELS[action],
    count: stagedRows.filter((row) => drafts[row.id]?.action === action).length,
  })).filter((row) => row.count > 0);

  return (
    <div className="grid grid-cols-1 items-start gap-3 min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="min-w-0 pb-3">
        {candidatesTruncated && (
          <p className="px-4 pt-3 text-[11px] text-warn-text">
            More candidates are waiting; this queue lists the pages loaded so far.
          </p>
        )}
        {/* In flight and unreadable are two different sentences: the failure one
            is only true once the read has settled without the record. */}
        {predecessorsLoading ? (
          <p className="px-4 pt-3 text-[11px] text-ink-4">
            Reading the current version of the predecessors named here…
          </p>
        ) : (
          predecessorsTruncated && (
            <p className="px-4 pt-3 text-[11px] text-warn-text">
              A predecessor's current version could not be read, so a supersession naming it may be refused here.
            </p>
          )
        )}

        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px] text-ink-4">
            No candidates waiting. Capture and propose feed this queue.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.domainId ?? 'product-root'}>
              <div className="flex items-baseline gap-2 px-4 pb-1 pt-3">
                <span className="text-[12px] font-medium text-ink-1">
                  {group.domainId === null ? 'Product root' : (domainNames[group.domainId] ?? group.domainId)}
                </span>
                <span className="num text-[11px] text-ink-4">{group.items.length} waiting</span>
              </div>
              {group.items.map((item) => (
                <DecisionCard
                  key={item.id}
                  item={item}
                  draft={drafts[item.id]}
                  conflict={conflictOf(item)}
                  result={resultsByCard.get(item.id)}
                  canReview={canReview}
                  disabled={submitting}
                  record={candidateItems[item.id]}
                  featureName={item.featureId === null ? undefined : featureNames[item.featureId]}
                  predecessorTitle={
                    item.proposedSuccessorOfId === null ? undefined : predecessorTitles[item.proposedSuccessorOfId]
                  }
                  predecessorVersion={
                    item.proposedSuccessorOfId === null ? undefined : predecessorVersions[item.proposedSuccessorOfId]
                  }
                  predecessorRecord={
                    item.proposedSuccessorOfId === null ? undefined : predecessorItems[item.proposedSuccessorOfId]
                  }
                  predecessorLoading={predecessorsLoading}
                  onStage={(action) => stageAction(item, action)}
                  onUnstage={() => unstage(item.id)}
                  onReason={(reason) => setReason(item.id, reason)}
                  onRefetch={(subjectId) => refetchCard(item, subjectId)}
                />
              ))}
            </section>
          ))
        )}

        {candidatesTruncated && onLoadMore && (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" onClick={onLoadMore}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      {canReview ? (
        <IntentBatchPanel
          stagedCounts={stagedCounts}
          stagedTotal={stagedRows.length}
          provenance={effectiveProvenance}
          sharedSource={sharedSource}
          batchReason={batchReason}
          issues={issues}
          submitting={submitting}
          {...(submitErrorMessage === undefined ? {} : { submitErrorMessage })}
          results={results}
          onProvenanceChange={changeProvenance}
          onBatchReasonChange={setBatchReason}
          onManualPreset={applyManualPreset}
          onUseSharedSource={useSharedSource}
          onSubmit={submit}
        />
      ) : (
        <Card className="sticky top-4 p-4">
          <h3 className="text-[11px] uppercase tracking-[0.04em] text-ink-4">Decision batch</h3>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            Deciding candidates needs the admin or owner role. You can read the queue and every accepted item and its
            history.
          </p>
        </Card>
      )}
    </div>
  );
}

function DecisionCard({
  item,
  draft,
  conflict,
  result,
  canReview,
  disabled,
  record,
  featureName,
  predecessorTitle,
  predecessorVersion,
  predecessorRecord,
  predecessorLoading,
  onStage,
  onUnstage,
  onReason,
  onRefetch,
}: {
  item: IntentReviewQueueItem;
  draft: IntentCardDraft | undefined;
  conflict: IntentCardConflict | null;
  result: IntentReviewDecisionResult | undefined;
  canReview: boolean;
  disabled: boolean;
  record?: IntentContextMatch;
  featureName?: string;
  predecessorTitle?: string;
  predecessorVersion?: number;
  predecessorRecord?: IntentContextMatch;
  /** The by-id read for this predecessor has not settled yet. */
  predecessorLoading: boolean;
  onStage: (action: IntentReviewAction) => void;
  onUnstage: () => void;
  onReason: (reason: string) => void;
  onRefetch: (subjectId: string) => void;
}) {
  const replaces = item.proposedSuccessorOfId;
  const sources = record?.sources ?? [];
  const blocked = !canReview || disabled || conflict !== null;

  return (
    <div
      data-intent-decision-card={item.id}
      className={cn(
        'mx-4 my-2 rounded-[10px] border px-3.5 py-3',
        conflict !== null ? 'border-warn-text' : stagedBorderClass(draft?.action),
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="candidate">Candidate</Badge>
        <Badge variant="reason">{kindLabel(item.kind)}</Badge>
        {item.featureId !== null && <Badge variant="reason">{featureName ?? item.featureId}</Badge>}
        {result && <Badge variant={outcomeVariant(result.outcome)}>{outcomeLabel(result.outcome)}</Badge>}
        <span className="font-mono text-[10.5px] text-ink-4">
          {item.id} · v{item.version}
        </span>
      </div>

      <h4 className="mt-[3px] text-[13px] font-medium text-ink-1">{item.title}</h4>
      {record !== undefined && (
        <>
          <p className="mt-[3px] text-[12.5px] leading-relaxed text-ink-2">{record.statement}</p>
          {((record.appliesWhen?.length ?? 0) > 0 ||
            (record.inheritedConditions?.domain?.length ?? 0) > 0 ||
            (record.inheritedConditions?.feature?.length ?? 0) > 0 ||
            intentPayloadVariants(record.payload) !== null) && (
            <div className="mt-1.5">
              <IntentDetails
                payload={record.payload}
                appliesWhen={record.appliesWhen}
                inheritedConditions={record.inheritedConditions}
                domainId={record.domainId}
                featureId={record.featureId}
              />
            </div>
          )}
        </>
      )}

      {item.hints && item.hints.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 rounded-md bg-warn-wash px-2 py-1.5 text-[11.5px] leading-relaxed text-warn-text">
          {item.hints.map((hint) => (
            <li key={JSON.stringify(hint)}>{authoringHintText(hint)}</li>
          ))}
        </ul>
      )}

      {sources.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sources.map((source) => (
            <span
              key={`${source.kind}|${source.ref}|${source.localId}`}
              className="flex items-start gap-1.5 rounded border border-border-soft px-[5px] py-0.5 text-[11px]"
            >
              <span className="text-[10px] uppercase tracking-[0.03em] text-ink-4">{source.kind}</span>
              <IntentSourceLabel source={source} />
            </span>
          ))}
        </div>
      )}

      {replaces !== null && (
        <IntentSupersedeDiff
          predecessorId={replaces}
          predecessorLoading={predecessorLoading}
          {...(predecessorVersion === undefined ? {} : { predecessorVersion })}
          {...(predecessorRecord === undefined ? {} : { predecessor: predecessorRecord })}
          {...(record === undefined ? {} : { successor: record })}
        />
      )}
      {replaces !== null && predecessorTitle !== undefined && (
        <p className="mt-1.5 text-[11.5px] text-ink-2">
          Replaces <span className="font-medium text-ink-1">“{predecessorTitle}”</span> — accepting supersedes it in one
          transaction.
        </p>
      )}

      {conflict !== null && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-wash px-2.5 py-[7px] text-[11.5px] text-warn-text">
          <span>
            Version conflict: v{conflict.expectedVersion} was expected,{' '}
            {conflict.serverVersion === null
              ? 'the server no longer has it'
              : `the server now has v${conflict.serverVersion}`}
            . Re-fetch and decide against the current version.
          </span>
          <Button variant="ghost" size="sm" onClick={() => onRefetch(conflict.subjectId)}>
            Re-fetch
          </Button>
        </div>
      )}

      {result?.error && (
        <p className="mt-2 rounded-lg bg-danger-wash px-2.5 py-1.5 text-[11.5px] text-danger-text">
          <span className="font-mono">{result.error.code}</span> — {result.error.message}
          {result.version !== null && result.outcome === IntentReviewOutcome.Refused
            ? ` (current version: v${result.version})`
            : ''}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {CARD_ACTIONS.map((action) => {
          const pressed = draft?.action === action;
          return (
            <button
              key={action}
              type="button"
              aria-pressed={pressed}
              disabled={blocked}
              onClick={() => onStage(action)}
              className={cn(
                'rounded-[7px] border px-3 py-1 text-[11.5px] transition-colors disabled:pointer-events-none disabled:opacity-50',
                pressed
                  ? actionPressedClass(action)
                  : 'border-border bg-surface text-ink-2 hover:border-axis hover:text-ink-1',
              )}
            >
              {action === IntentReviewAction.Accept && replaces !== null
                ? ACTION_LABELS[IntentReviewAction.Supersede]
                : ACTION_LABELS[action]}
            </button>
          );
        })}
        {/* Enabled while a CONFLICT blocks the actions: a staged card the
            reviewer cannot decide must still be clearable. */}
        {draft !== undefined && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onUnstage}>
            Unstage
          </Button>
        )}
      </div>

      {!canReview && <p className="mt-1.5 text-[11px] text-ink-4">Deciding needs the admin or owner role.</p>}

      {draft && (
        <Textarea
          value={draft.reason}
          placeholder="Reason (recorded on the transition)…"
          disabled={blocked}
          className="mt-2 min-h-10"
          onChange={(event) => onReason(event.target.value)}
        />
      )}
    </div>
  );
}

/** The staged action colours the card's border — the only signal that reads at a glance. */
export function stagedBorderClass(action: IntentReviewAction | undefined): string {
  if (action === IntentReviewAction.Accept) return 'border-brand';
  if (action === IntentReviewAction.Reject) return 'border-danger';
  if (action === IntentReviewAction.Defer || action === IntentReviewAction.NeedsEdit) return 'border-axis';
  return 'border-border-soft';
}

/**
 * The pressed face of an action button. `aria-pressed` alone is invisible: the
 * staged action has to read from the card, so it takes its action's own wash and
 * border. Each wash is repeated under `hover:` — a bare `bg-*` does not out-rank
 * a `hover:bg-*`, and the face must not vanish under the pointer that just set it.
 */
function actionPressedClass(action: IntentReviewAction): string {
  if (action === IntentReviewAction.Accept) {
    return 'border-brand bg-brand-wash text-brand-text hover:bg-brand-wash font-medium';
  }
  if (action === IntentReviewAction.Reject) {
    return 'border-danger bg-danger-wash text-danger-text hover:bg-danger-wash font-medium';
  }
  return 'border-axis bg-surface-2 text-ink-1 hover:bg-surface-2 font-medium';
}
