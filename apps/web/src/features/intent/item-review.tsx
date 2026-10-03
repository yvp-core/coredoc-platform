/**
 * Approve or reject one candidate from the detail pane.
 *
 * It submits a one-decision batch through the same `planReviewBatch` that
 * "Approve all" uses, so a candidate that replaces an approved item is decided
 * as a supersede with both versions checked. The batch is recorded as the
 * reviewer's own manual decision.
 */

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useState } from 'react';
import { planReviewBatch, stagedCard, type IntentDraftDecision } from './intent-review-request.js';
import { outcomeLabel } from './intent-presentation.js';
import { IntentSupersedeDiff } from './supersede-diff.js';
import {
  IntentReviewAction,
  IntentReviewOutcome,
  type IntentContextMatch,
  type IntentReviewDecisionResult,
} from './types.js';

export interface IntentItemReviewProps {
  match: IntentContextMatch;
  predecessor?: IntentContextMatch;
  predecessorLoading: boolean;
  canReview: boolean;
  submitting: boolean;
  results: IntentReviewDecisionResult[] | null;
  errorMessage?: string;
  onDecide: (decision: IntentDraftDecision) => void;
}

export function IntentItemReview({
  match,
  predecessor,
  predecessorLoading,
  canReview,
  submitting,
  results,
  errorMessage,
  onDecide,
}: IntentItemReviewProps) {
  const [reason, setReason] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const replaces = match.proposedSuccessorOfId;

  const decide = (action: IntentReviewAction.Accept | IntentReviewAction.Reject) => {
    const plan = planReviewBatch({
      cards: [stagedCard(match, action, reason)],
      predecessorVersions: predecessor ? { [predecessor.id]: predecessor.version } : {},
      batchReason:
        action === IntentReviewAction.Accept ? 'Approved in the document view' : 'Rejected in the document view',
    });
    const decision = plan.pending[0];
    setIssue(plan.skipped[0] ?? null);
    if (decision) onDecide(decision);
  };

  const refused = results?.find((result) => result.outcome === IntentReviewOutcome.Refused);

  return (
    <div className="mx-[18px] mt-3 flex flex-col gap-2 rounded-lg bg-blue-wash px-3 py-2.5">
      <span className="text-[13px] font-medium text-ink-1">
        {replaces ? 'Review the proposed change' : 'Review this proposal'}
      </span>
      {replaces && (
        <IntentSupersedeDiff
          predecessorId={replaces}
          {...(predecessor ? { predecessor, predecessorVersion: predecessor.version } : {})}
          successor={match}
          predecessorLoading={predecessorLoading}
        />
      )}
      <Textarea
        aria-label="Reason"
        placeholder="Reason (optional)"
        maxLength={2000}
        value={reason}
        disabled={!canReview || submitting}
        onChange={(event) => setReason(event.target.value)}
        className="min-h-[52px] bg-surface text-[13.5px]"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="default"
          size="sm"
          disabled={!canReview || submitting || (replaces !== null && predecessor === undefined)}
          onClick={() => decide(IntentReviewAction.Accept)}
        >
          {replaces ? 'Approve change' : 'Approve'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canReview || submitting}
          onClick={() => decide(IntentReviewAction.Reject)}
        >
          Reject
        </Button>
      </div>
      {!canReview && <p className="text-[12.5px] text-ink-3">Deciding needs the admin, owner or product role.</p>}
      {issue && <p className="text-[12.5px] text-warn-text">{issue}</p>}
      {refused && (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {outcomeLabel(refused.outcome)}: {refused.error?.message ?? 'the server refused this decision'}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
