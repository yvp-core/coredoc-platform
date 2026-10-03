/**
 * Review inside the browse document: the node document read, the waiting
 * queue behind "Next proposal", and the three decisions
 * (one candidate, every proposal on the page, the predecessor a supersede checks).
 *
 * Writes go through the panel's {@link IntentWriter}, shared with the tree
 * editor and the anchor refresh, so a review and a tree write never run at once.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  intentDocumentQueryOptions,
  intentItemContextQueryOptions,
  intentReviewQueueQueryOptions,
  submitIntentReview,
} from '@/api/queries/intent';
import { IntentWriteForm } from './intent-attempt-keys.js';
import { intentDocumentProposals, type IntentTreeSelection } from './intent-panel-state.js';
import { messageOf } from './intent-presentation.js';
import {
  INTENT_REVIEW_BATCH_LIMIT,
  buildReviewRequest,
  issueReviewSource,
  manualReviewSource,
  planReviewBatch,
  type IntentDraftDecision,
} from './intent-review-request.js';
import type { IntentWriter } from './intent-writer.js';
import {
  IntentAuthority,
  IntentReviewOutcome,
  type IntentAuthorizingSource,
  type IntentContextMatch,
  type IntentReviewDecisionResult,
} from './types.js';

export interface DocumentReviewInput {
  workspaceId: string;
  selection: IntentTreeSelection;
  selectedItemId: string | null;
  /** The document view is showing; the queue and the document are read only then. */
  enabled: boolean;
  detailMatch: IntentContextMatch | null;
  /** The panel's writer: a review and a tree write never run at once. */
  writer: IntentWriter;
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
  writer,
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

  /**
   * One batch under the writer's key for it: unchanged decisions retry under the
   * same key (the server replays its answer), while a corrected batch is a new
   * attempt and gets a new key — the ledger keys on (key, request hash).
   */
  const sendBatch = (source: IntentAuthorizingSource, drafts: IntentDraftDecision[]) =>
    writer.send(IntentWriteForm.ReviewBatch, { drafts, source }, ({ idempotencyKey }) => {
      const built = buildReviewRequest(source, drafts, idempotencyKey);
      if (!built.ok) throw new Error(built.issues.join(' '));
      return submitIntentReview(id, built.request);
    });

  const submit = async (drafts: IntentDraftDecision[], source: IntentAuthorizingSource) => {
    if (writer.busy) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await writer.exclusive(async () => {
        const response = await sendBatch(source, drafts);
        setResults(response.decisions);
        await invalidateIntent();
      });
    } catch (error) {
      // Rendered beside the decision in the detail pane; the pane stays.
      setSubmitError(error);
    } finally {
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
    if (proposals === null || writer.busy) return 'Another write is still running.';
    const plan = planReviewBatch({
      cards: proposals.cards,
      predecessorVersions: proposals.predecessorVersions,
      batchReason: reason.trim() || 'Approved in the document view',
    });
    const source = ticket.trim() === '' ? manualReviewSource() : issueReviewSource(ticket);
    setSubmitting(true);
    let approved = 0;
    let refused = 0;
    try {
      await writer.exclusive(async () => {
        for (let start = 0; start < plan.pending.length; start += INTENT_REVIEW_BATCH_LIMIT) {
          const response = await sendBatch(source, plan.pending.slice(start, start + INTENT_REVIEW_BATCH_LIMIT));
          for (const result of response.decisions) {
            if (result.outcome === IntentReviewOutcome.Refused) refused += 1;
            else approved += 1;
          }
        }
      });
    } catch (error) {
      return `Stopped after ${approved} approved: ${messageOf(error) ?? 'the request failed'}.`;
    } finally {
      setSubmitting(false);
      await invalidateIntent();
    }
    const parts = [`${approved} approved`];
    if (refused > 0) parts.push(`${refused} refused — open them to see why`);
    if (plan.skipped.length > 0)
      parts.push(`${plan.skipped.length} left out (their replaced item is not on this page)`);
    return `${parts.join(', ')}.`;
  };

  const decideOne = (decision: IntentDraftDecision) => void submit([decision], manualReviewSource());

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
