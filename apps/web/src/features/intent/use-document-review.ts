/**
 * Review inside the browse document: the node document read, the waiting
 * queue behind "Next proposal", and the three decisions
 * (one candidate, every proposal on the page, the predecessor a supersede checks).
 *
 * Writes share the panel's one-write latch and attempt keys with the tree
 * editor, so a review and a tree write can never run at once.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { MutableRefObject } from 'react';
import { useMemo, useState } from 'react';
import {
  intentDocumentQueryOptions,
  intentItemContextQueryOptions,
  intentReviewQueueQueryOptions,
  submitIntentReview,
} from '@/api/queries/intent';
import { type IntentAttemptKeys, IntentWriteForm } from './intent-attempt-keys.js';
import { intentDocumentProposals, type IntentTreeSelection } from './intent-panel-state.js';
import {
  EMPTY_PROVENANCE_FORM,
  INTENT_REVIEW_BATCH_LIMIT,
  buildReviewRequest,
  manualProvenancePreset,
  planReviewBatch,
  todayIsoDate,
  type IntentDraftDecision,
  type IntentProvenanceForm,
} from './intent-review-request.js';
import {
  IntentAuthority,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentContextMatch,
  type IntentReviewDecisionResult,
} from './types.js';

const messageOf = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : error ? String(error) : undefined;

export interface DocumentReviewInput {
  workspaceId: string;
  selection: IntentTreeSelection;
  selectedItemId: string | null;
  /** The document view is showing; the queue and the document are read only then. */
  enabled: boolean;
  detailMatch: IntentContextMatch | null;
  writeInFlight: MutableRefObject<boolean>;
  attemptKeys: MutableRefObject<IntentAttemptKeys>;
  invalidateIntent: () => Promise<unknown>;
  /** Show a node and open one item in it. */
  onOpen: (selection: IntentTreeSelection, itemId: string) => void;
}

export function useDocumentReview({
  workspaceId: id,
  selection,
  selectedItemId,
  enabled,
  detailMatch,
  writeInFlight,
  attemptKeys,
  invalidateIntent,
  onOpen,
}: DocumentReviewInput) {
  const [includeCandidates, setIncludeCandidates] = useState(true);
  const [results, setResults] = useState<IntentReviewDecisionResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const documentQuery = useQuery({ ...intentDocumentQueryOptions(id, selection, includeCandidates), enabled });
  // "Next proposal" walks the server's review queue, oldest first; its summary is the waiting count.
  const queueQuery = useInfiniteQuery({ ...intentReviewQueueQueryOptions(id), enabled });
  const candidates = useMemo(() => queueQuery.data?.pages.flatMap((page) => page.items) ?? null, [queueQuery.data]);
  const proposals = useMemo(
    () => (documentQuery.data ? intentDocumentProposals(documentQuery.data) : null),
    [documentQuery.data],
  );

  // A candidate that replaces an approved item is decided against that item's current version.
  const predecessorId = detailMatch?.authority === IntentAuthority.Candidate ? detailMatch.proposedSuccessorOfId : null;
  const predecessorQuery = useQuery(intentItemContextQueryOptions(id, predecessorId));

  const submit = async (drafts: IntentDraftDecision[], provenance: IntentProvenanceForm) => {
    if (writeInFlight.current) return;
    // One key per batch attempt: unchanged decisions retry under the same key
    // (the server replays its answer), while a corrected batch is a new attempt
    // and gets a new key — the ledger keys on (key, request hash).
    const key = attemptKeys.current.keyFor(IntentWriteForm.ReviewBatch, { drafts, provenance });
    const built = buildReviewRequest(provenance, drafts, key);
    if (!built.ok) {
      setSubmitError(new Error(built.issues.join(' ')));
      return;
    }
    writeInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await submitIntentReview(id, built.request);
      setResults(response.decisions);
      attemptKeys.current.settle(IntentWriteForm.ReviewBatch);
      await invalidateIntent();
    } catch (error) {
      // Rendered beside the decision in the detail pane; the pane stays.
      setSubmitError(error);
    } finally {
      writeInFlight.current = false;
      setSubmitting(false);
    }
  };

  /** Open the waiting proposal after the selected one, oldest first; wraps to the start. */
  const nextProposal = async () => {
    let rows = candidates ?? [];
    const index = rows.findIndex((row) => row.id === selectedItemId);
    if (index === rows.length - 1 && queueQuery.hasNextPage) {
      const fetched = await queueQuery.fetchNextPage();
      rows = fetched.data?.pages.flatMap((page) => page.items) ?? rows;
    }
    const next = rows[index + 1] ?? rows[0];
    if (!next) return;
    setIncludeCandidates(true);
    onOpen({ domainId: next.domainId, featureId: next.featureId }, next.id);
  };

  /** Approve every proposal the document shows, in batches the review route accepts. */
  const approveAll = async ({ reason, ticket }: { reason: string; ticket: string }): Promise<string> => {
    if (proposals === null || writeInFlight.current) return 'Another write is still running.';
    const plan = planReviewBatch({
      cards: proposals.cards,
      predecessorVersions: proposals.predecessorVersions,
      batchReason: reason.trim() || 'Approved in the document view',
    });
    const provenance: IntentProvenanceForm =
      ticket.trim() === ''
        ? manualProvenancePreset(EMPTY_PROVENANCE_FORM, { today: todayIsoDate() })
        : { ...EMPTY_PROVENANCE_FORM, kind: IntentSourceKind.Issue, ref: ticket.trim(), localId: ticket.trim() };
    writeInFlight.current = true;
    setSubmitting(true);
    let approved = 0;
    let refused = 0;
    try {
      for (let start = 0; start < plan.pending.length; start += INTENT_REVIEW_BATCH_LIMIT) {
        const drafts = plan.pending.slice(start, start + INTENT_REVIEW_BATCH_LIMIT);
        const key = attemptKeys.current.keyFor(IntentWriteForm.ReviewBatch, { drafts, provenance });
        const built = buildReviewRequest(provenance, drafts, key);
        if (!built.ok) return built.issues[0] ?? 'The decision could not be built.';
        const response = await submitIntentReview(id, built.request);
        attemptKeys.current.settle(IntentWriteForm.ReviewBatch);
        for (const result of response.decisions) {
          if (result.outcome === IntentReviewOutcome.Refused) refused += 1;
          else approved += 1;
        }
      }
    } catch (error) {
      return `Stopped after ${approved} approved: ${messageOf(error) ?? 'the request failed'}.`;
    } finally {
      writeInFlight.current = false;
      setSubmitting(false);
      await invalidateIntent();
    }
    const parts = [`${approved} approved`];
    if (refused > 0) parts.push(`${refused} refused — open them to see why`);
    if (plan.skipped.length > 0)
      parts.push(`${plan.skipped.length} left out (their replaced item is not on this page)`);
    return `${parts.join(', ')}.`;
  };

  const decideOne = (decision: IntentDraftDecision) =>
    void submit([decision], manualProvenancePreset(EMPTY_PROVENANCE_FORM, { today: todayIsoDate() }));

  return {
    documentQuery,
    includeCandidates,
    setIncludeCandidates,
    waiting: queueQuery.data?.pages[0]?.summary.waiting ?? 0,
    proposalCount: proposals?.cards.length ?? 0,
    predecessor: predecessorQuery.data?.matches[0],
    predecessorLoading: predecessorQuery.isLoading,
    /** Results for the selected candidate and the item it replaces only. */
    results: results?.filter((result) => result.itemId === detailMatch?.id || result.itemId === predecessorId) ?? null,
    submitting,
    submitErrorMessage: messageOf(submitError),
    nextProposal,
    approveAll,
    decideOne,
  };
}
