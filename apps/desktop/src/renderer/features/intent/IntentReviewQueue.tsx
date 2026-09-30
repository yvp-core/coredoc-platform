/**
 * The review surface: the waiting queue on the left, ONE decision batch panel on
 * the right (spec §3.3 of the desktop redesign).
 *
 * Four contract facts shape this component:
 *
 * 1. Provenance is per BATCH (spec §4.7). It lives in `IntentBatchPanel`, once,
 *    and `buildReviewRequest` is the only assembler — a card cannot grow its own
 *    provenance field.
 * 2. A refusal is a per-item VALUE inside a 200 response, not a failed request.
 *    Results render next to the card they belong to.
 * 3. A stale `expectedVersion` is the one refusal with a repair: the conflicted
 *    id is re-fetched and the reviewer decides again against what the item says
 *    now. Nothing is auto-retried — the decision is always a human's.
 * 4. A supersession is expressed on the SUCCESSOR's card: the candidate carrying
 *    `proposedSuccessorOfId` is the one offering to replace an accepted item, so
 *    its card is where the reviewer chooses "supersede", where the diff opens,
 *    and where both versions travel from.
 *
 * The queue row (`IntentReviewQueueItem`) is payload-free by design — it is the
 * server's queue projection. Statements, sources and the successor half of a
 * supersede diff therefore arrive through `candidateItems`, and every one of
 * them degrades to a plain sentence when the record is not loaded: this surface
 * never renders an empty diff or a blank statement as if it were the content.
 */

import { useEffect, useMemo, useState } from 'react';
import { IntentSourceLabel } from './IntentSourceLabel';
import { Danger, Refresh } from '@solar-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Textarea } from '../../components/ui/textarea';
import {
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentContextMatch,
  type IntentItemSource,
  type IntentReviewDecisionResult,
  type IntentReviewQueueItem,
} from '../../../shared/intent-types.js';
import { IntentBatchPanel, type IntentStagedCount } from './IntentBatchPanel';
import { IntentSupersedeDiff } from './IntentSupersedeDiff';
import { IntentDetails } from './IntentDetails';
import {
  authoringHintText,
  intentPayloadVariants,
  kindLabel,
  outcomeLabel,
  outcomeVariant,
} from './intent-presentation';
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
} from './intent-review-request';

/**
 * The actions a reviewer picks from a card. `defer` and `needs_edit` are wire
 * actions like the other two — the server records the transition and leaves the
 * authority alone — so they are staged, counted and submitted exactly the same
 * way, and are not a local-only UI state.
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
 * product root LAST (spec §3.3). First-appearance order rather than an
 * alphabetical sort keeps the server's ordering — oldest waiting first — visible
 * inside and between the groups.
 */
export function groupQueueByDomain(rows: readonly IntentReviewQueueItem[]): IntentQueueGroup[] {
  // Keyed on `domainId` ITSELF, `null` included: a Map takes null as a key, so
  // the product root needs no sentinel string at all — and a sentinel is exactly
  // what a real domain id could collide with. (The previous key was a raw NUL
  // byte, which made git read this whole file as binary.)
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
  /**
   * Current version of every accepted item a candidate proposes to replace. A
   * supersession checks the version on BOTH items (spec §5), and the predecessor
   * is not on the candidate row — so the panel resolves it and the batch is
   * refused locally, with a plain reason, when it is unknown.
   */
  predecessorVersions: Readonly<Record<string, number>>;
  /** Titles of those same predecessors, so a supersede card can say WHAT it replaces. */
  predecessorTitles?: Readonly<Record<string, string>>;
  /**
   * Full predecessor records, keyed by id — the "before" half of the supersede
   * diff. Missing entries are expected (`predecessorsTruncated`) and render as
   * "Predecessor not loaded", never as an empty diff.
   */
  predecessorItems?: Readonly<Record<string, IntentContextMatch>>;
  /**
   * Full records for the CANDIDATES on this page, keyed by id: the queue row
   * carries no statement, sources or payload, and those are what a reviewer
   * decides on. Absent entries degrade the card, never break it.
   */
  candidateItems?: Readonly<Record<string, IntentContextMatch>>;
  /** Domain id → display name, for the group headers. Falls back to the id. */
  domainNames?: Readonly<Record<string, string>>;
  /** Feature id → display name, for the card's feature badge. Falls back to the id. */
  featureNames?: Readonly<Record<string, string>>;
  /**
   * The by-id reads that resolve the predecessors are still in flight. Kept
   * SEPARATE from `predecessorsTruncated`: a record that has not arrived yet is
   * not a record that could not be read, and saying so while the read is running
   * accuses the server of a failure that has not happened.
   */
  predecessorsLoading?: boolean;
  /** A named predecessor's current version could not be read — it may be missing. */
  predecessorsTruncated?: boolean;
  /** The queue has pages this list does not show yet. */
  candidatesTruncated?: boolean;
  /** Load the next queue page. Absent: the "Load more" affordance is not offered. */
  onLoadMore?: () => void;
  loading: boolean;
  submitting: boolean;
  /** Per-decision results from the last submitted batch. */
  results: IntentReviewDecisionResult[] | null;
  /** The QUEUE could not be read — the only failure that replaces the surface. */
  errorMessage?: string;
  /**
   * The last SUBMIT failed. Rendered beside the cards, never instead of them: an
   * error that unmounts the queue takes the reviewer's typed decisions with it.
   */
  submitErrorMessage?: string;
  /** The reviewer's handle, for the "Manual decision" preset's reference. */
  reviewerHandle?: string;
  /**
   * Today, as `YYYY-MM-DD`, for that same preset. Injected as a FUNCTION and
   * called only from the click handler: no render path may read the clock.
   */
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
   * re-sent by the next submit — `defer` and `needs_edit` are wire actions, so
   * that meant a second transition on an item nobody decided again.
   */
  useEffect(() => {
    if (results === null) return;
    setDrafts((current) => draftsAfterResults(current, reviewResultsByCard(results, rows)));
  }, [results, rows]);

  /**
   * The batch's authorizing source, prefilled from the staged candidates when
   * they all cite the same one (issue v1.1-01). Derived, not written into state:
   * a field the reviewer edits is `touched` from then on, so the prefill applies
   * exactly once and can never come back over their typing.
   */
  const sharedSource = sharedProvenanceSource(stagedRows.map((row) => candidateItems[row.id]?.sources ?? []));
  const effectiveProvenance =
    sharedSource.state === 'single' ? applyProvenanceSource(provenance, touched, sharedSource.source) : provenance;

  if (loading) {
    return (
      <div className="flex min-h-[160px] flex-1 items-center justify-center">
        <Spinner className="size-6 text-content-quaternary" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="flex min-h-[160px] flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-content-secondary">Couldn't load the review queue.</p>
        <p className="max-w-md text-xs leading-4 text-content-tertiary">{errorMessage}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
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
    // on the wire, so only that action freezes it; a reject/defer/needs-edit on
    // the same card says nothing about the predecessor and must not be blocked
    // by one that moves.
    const frozen = stagedPredecessorVersion({
      action,
      predecessorId: item.proposedSuccessorOfId,
      predecessorVersions,
    });
    setDrafts((current) => stageDraft(current, item.id, action, frozen));
  };

  /** Clear one card's decision — the way out of a card that cannot be decided. */
  const unstage = (itemId: string) => setDrafts((current) => unstageDraft(current, itemId));

  /**
   * Re-fetch one conflicted card and acknowledge the version it conflicted on.
   * Without the re-stamp the frozen number never moves and the card stays
   * blocked forever; if the re-read then brings a NEWER version, the comparison
   * raises the conflict again, so the protection is acknowledged, not spent.
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

    // A conflicted card is LEFT OUT with its own reason; the rest of the batch
    // goes. Aborting everything because one predecessor moved held every other
    // decision hostage to a repair the reviewer may not want to make now, and
    // the wire contract is per-decision anyway.
    const plan = planReviewBatch({ cards, predecessorVersions, batchReason });

    // Local shape check only; the server owns every other judgment and its
    // structured refusal is what the reviewer is shown. The key here is a
    // placeholder — the caller mints the real one per submitted attempt.
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 min-[1100px]:flex-row min-[1100px]:items-start">
      <div className="surface-b flex min-w-0 flex-1 flex-col gap-4 rounded-xl border border-border-secondary p-4">
        {candidatesTruncated && (
          <p className="text-[11px] leading-4 text-content-warning">
            More candidates are waiting; this queue lists the pages loaded so far.
          </p>
        )}
        {/* In flight and unreadable are two different sentences: the failure one
            is only true once the read has settled without the record. */}
        {predecessorsLoading ? (
          <p className="text-[11px] leading-4 text-content-tertiary">
            Reading the current version of the predecessors named here…
          </p>
        ) : (
          predecessorsTruncated && (
            <p className="text-[11px] leading-4 text-content-warning">
              A predecessor's current version could not be read, so a supersession naming it may be refused here.
            </p>
          )
        )}

        {rows.length === 0 ? (
          <p className="px-1 py-10 text-center text-xs leading-5 text-content-quaternary">
            No candidates waiting. Capture and propose feed this queue.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.domainId ?? 'product-root'} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-xs/relaxed font-semibold text-content-primary">
                  {group.domainId === null ? 'Product root' : (domainNames[group.domainId] ?? group.domainId)}
                </h3>
                <span className="text-[11px] leading-4 text-content-tag-progress tabular-nums">
                  {group.items.length} waiting
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <DecisionCard
                      item={item}
                      draft={drafts[item.id]}
                      conflict={conflictOf(item)}
                      result={resultsByCard.get(item.id)}
                      disabled={submitting}
                      record={candidateItems[item.id]}
                      featureName={item.featureId === null ? undefined : featureNames[item.featureId]}
                      predecessorTitle={
                        item.proposedSuccessorOfId === null ? undefined : predecessorTitles[item.proposedSuccessorOfId]
                      }
                      predecessorVersion={
                        item.proposedSuccessorOfId === null
                          ? undefined
                          : predecessorVersions[item.proposedSuccessorOfId]
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
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {candidatesTruncated && onLoadMore && (
          <Button type="button" variant="ghost" size="sm" className="self-center" onClick={onLoadMore}>
            Load more
          </Button>
        )}
      </div>

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
    </div>
  );
}

function DecisionCard({
  item,
  draft,
  conflict,
  result,
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
  const blocked = disabled || conflict !== null;

  return (
    <div
      data-intent-decision-card={item.id}
      className={`flex flex-col gap-2 rounded-xl border p-3 ${stagedBorderClass(draft?.action)}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="info">Candidate</Badge>
        <Badge variant="initial">{kindLabel(item.kind)}</Badge>
        {item.featureId !== null && <Badge variant="initial">{featureName ?? item.featureId}</Badge>}
        {result && <Badge variant={outcomeVariant(result.outcome)}>{outcomeLabel(result.outcome)}</Badge>}
        <span className="font-mono text-[11px] leading-4 text-content-quaternary">
          {item.id} · v{item.version}
        </span>
      </div>

      <h4 className="text-xs/relaxed font-semibold text-content-primary">{item.title}</h4>
      {record !== undefined && (
        <>
          <p className="text-[11px] leading-4 text-content-secondary">{record.statement}</p>
          {((record.appliesWhen?.length ?? 0) > 0 ||
            (record.inheritedConditions?.domain?.length ?? 0) > 0 ||
            (record.inheritedConditions?.feature?.length ?? 0) > 0 ||
            intentPayloadVariants(record.payload) !== null) && (
            <div className="mt-1">
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
        <ul className="flex flex-col gap-0.5 rounded-md bg-bg-tag-warning px-2 py-1.5 text-[11px] leading-4 text-content-warning">
          {item.hints.map((hint) => (
            <li key={JSON.stringify(hint)}>{authoringHintText(hint)}</li>
          ))}
        </ul>
      )}

      {sources.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1">
          {sources.map((source) => (
            <li
              key={`${source.kind}|${source.ref}|${source.localId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border-input px-1.5 py-0.5 text-[11px] leading-4"
            >
              <span className="font-medium uppercase tracking-[0.02em] text-content-tertiary">{source.kind}</span>
              <IntentSourceLabel source={source} />
            </li>
          ))}
        </ul>
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
        <p className="text-[11px] leading-4 text-content-secondary">
          Replaces <span className="font-medium text-content-primary">“{predecessorTitle}”</span> — accepting supersedes
          it in one transaction.
        </p>
      )}

      {conflict !== null && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-tag-warning px-2 py-1.5">
          <span className="flex items-start gap-1.5 text-[11px] leading-4 text-content-secondary">
            <Danger className="mt-0.5 size-3.5 shrink-0" />
            Version conflict: v{conflict.expectedVersion} expected,{' '}
            {conflict.serverVersion === null ? 'the server no longer has it' : `server has v${conflict.serverVersion}`}.
            Re-fetch and decide against the current version.
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onRefetch(conflict.subjectId)}>
            <Refresh className="size-3" />
            Re-fetch
          </Button>
        </div>
      )}

      {result?.error && (
        <p className="rounded-md bg-bg-tag-warning px-2 py-1 text-[11px] leading-4 text-content-primary">
          <span className="font-mono">{result.error.code}</span> — {result.error.message}
          {result.version !== null && result.outcome === IntentReviewOutcome.Refused
            ? ` (current version: v${result.version})`
            : ''}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {CARD_ACTIONS.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={draft?.action === action}
            className={stagedActionClass(action, draft?.action === action)}
            disabled={blocked}
            onClick={() => onStage(action)}
          >
            {action === IntentReviewAction.Accept && replaces !== null
              ? ACTION_LABELS[IntentReviewAction.Supersede]
              : ACTION_LABELS[action]}
          </Button>
        ))}
        {/* Enabled while a CONFLICT blocks the actions: a staged card the
            reviewer cannot decide must still be clearable, or one moved
            predecessor pins the decision to the batch forever. */}
        {draft !== undefined && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onUnstage}>
            Unstage
          </Button>
        )}
      </div>

      {draft && (
        <Textarea
          value={draft.reason}
          placeholder="Why this decision"
          disabled={blocked}
          className="border-border-input bg-bg-input"
          onChange={(event) => onReason(event.target.value)}
        />
      )}
    </div>
  );
}

/**
 * The staged action colours the card's border — the only signal that reads at a
 * glance. Reject borrows `content-warning` (red-700) rather than `bg-warning`
 * (red-600, a FILL token): a border painted from a fill token reads a shade off
 * every other hairline on the surface.
 */
export function stagedBorderClass(action: IntentReviewAction | undefined): string {
  if (action === IntentReviewAction.Accept) return 'border-content-brand';
  if (action === IntentReviewAction.Reject) return 'border-content-warning';
  if (action === IntentReviewAction.Defer || action === IntentReviewAction.NeedsEdit) return 'border-border-tertiary';
  return 'border-border-input';
}

/**
 * The pressed face of an action button. `aria-pressed` alone is invisible: the
 * staged action has to read from the card, not from a screen reader, so it takes
 * its action's own wash and border and the heavier weight.
 *
 * Every wash is repeated under `hover:`. The `outline` variant these buttons use
 * ships `hover:bg-bg-primary-hover` / `hover:text-content-action-secondary-hover`,
 * and a bare `bg-*` does not out-rank a `hover:bg-*` — tailwind-merge only
 * resolves classes that share a modifier. Without the guard the mint/amber face
 * vanished for exactly as long as the pointer rested on the button the reviewer
 * had just clicked, which is the whole moment the feedback is for.
 */
export function stagedActionClass(action: IntentReviewAction, pressed: boolean): string {
  if (!pressed) return '';
  if (action === IntentReviewAction.Accept) {
    return 'bg-bg-tag-success hover:bg-bg-tag-success text-content-primary hover:text-content-primary border-content-brand font-semibold';
  }
  if (action === IntentReviewAction.Reject) {
    return 'bg-bg-tag-warning hover:bg-bg-tag-warning text-content-primary hover:text-content-primary border-content-warning font-semibold';
  }
  return 'bg-bg-primary-selected hover:bg-bg-primary-selected text-content-primary hover:text-content-primary border-border-tertiary font-semibold';
}
