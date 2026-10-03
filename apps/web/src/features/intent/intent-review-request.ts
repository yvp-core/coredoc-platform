/**
 * Pure request logic for review decisions (the document view's Approve /
 * Reject and "Approve all").
 *
 * **One authorizing source per submitted batch.** The server puts
 * `authorizingSource` on the batch, not the decision (spec §4.7) — one review
 * pass is authorized by one artifact. The browse surface builds exactly two:
 * the reviewer's own manual decision, and an issue named as the ticket.
 * {@link buildReviewRequest} is the only place a request is assembled. A stale
 * version refuses one decision, not the batch: `POST items/review` answers 200
 * with a per-decision result list.
 */

import {
  IntentReviewAction,
  IntentSourceKind,
  type IntentAuthorizingSource,
  type IntentReviewDecisionInput,
  type IntentReviewRequest,
} from './types.js';

/** The server's per-batch cap (`INTENT_CONTRACT_LIMITS.batch`). */
export const INTENT_REVIEW_BATCH_LIMIT = 10;

/** One card's pending decision, as it goes into a batch. */
export interface IntentDraftDecision {
  itemId: string;
  /** The version the card was rendered from — the reviewer's handoff token. */
  expectedVersion: number;
  action: IntentReviewAction;
  reason: string;
  /** Supersede only: the accepted predecessor this candidate replaces. */
  replacementItemId?: string;
  replacementExpectedVersion?: number;
  /**
   * What the reviewer SEES for this decision. A supersession's subject is the
   * predecessor id, which appears on no card — a refusal naming it reads as
   * about a card that does not exist. Messages use this label; the wire request
   * never carries it.
   */
  label?: string;
}

/**
 * The reference a manual decision is authorized by when the reviewer has no
 * handle to sign with. A decision still has to be attributable to SOMETHING —
 * "this was decided in the cloud review UI" is the honest minimum.
 */
export const INTENT_MANUAL_REVIEW_REF = 'cloud-review';

/** `YYYY-MM-DD` in UTC — the local id a manual decision is filed under. */
export function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The reviewer's own decision, citing no spec. The reference is constant: the
 * server records who decided from the token, and an identity here (an email
 * especially) is refused as intent content.
 *
 * `today` is injectable so a test pins the date instead of reading the clock.
 */
export function manualReviewSource(today: string = isoDateOnly(new Date())): IntentAuthorizingSource {
  return { kind: IntentSourceKind.Manual, ref: INTENT_MANUAL_REVIEW_REF, localId: today };
}

/** A pass authorized by a ticket: the issue key is both the reference and the local id. */
export function issueReviewSource(ticket: string): IntentAuthorizingSource {
  const key = ticket.trim();
  return { kind: IntentSourceKind.Issue, ref: key, localId: key };
}

export type IntentReviewRequestBuild =
  | { ok: true; request: IntentReviewRequest }
  | { ok: false; issues: readonly string[] };

/**
 * Assemble one batch. Refuses locally only what the UI can see is wrong —
 * everything else is the server's to judge, and its structured refusal is what
 * the reviewer is shown.
 */
export function buildReviewRequest(
  source: IntentAuthorizingSource,
  drafts: readonly IntentDraftDecision[],
  idempotencyKey: string,
): IntentReviewRequestBuild {
  const issues: string[] = [];

  if (drafts.length === 0) issues.push('There is no decision to submit.');
  if (drafts.length > INTENT_REVIEW_BATCH_LIMIT) {
    issues.push(`A review batch carries at most ${INTENT_REVIEW_BATCH_LIMIT} decisions.`);
  }

  const seen = new Set<string>();
  for (const draft of drafts) {
    const label = draft.label ?? `'${draft.itemId}'`;
    if (seen.has(draft.itemId)) issues.push(`Two decisions on ${label} in one batch.`);
    seen.add(draft.itemId);
    if (draft.reason.trim() === '') issues.push(`The decision on ${label} needs a reason.`);
    if (draft.action === IntentReviewAction.Supersede && draft.replacementItemId === undefined) {
      issues.push(`Supersede on ${label} needs the replacement candidate.`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const decisions: IntentReviewDecisionInput[] = drafts.map((draft) => ({
    itemId: draft.itemId,
    expectedVersion: draft.expectedVersion,
    action: draft.action,
    reason: draft.reason.trim(),
    ...(draft.action === IntentReviewAction.Supersede && draft.replacementItemId !== undefined
      ? {
          replacementItemId: draft.replacementItemId,
          replacementExpectedVersion: draft.replacementExpectedVersion,
        }
      : {}),
  }));

  return {
    ok: true,
    request: {
      idempotencyKey,
      authorizingSource: { kind: source.kind, ref: source.ref.trim(), localId: source.localId.trim() },
      decisions,
    },
  };
}

/** One candidate staged for a single decision, as the batch planner reads it. */
export interface IntentStagedCard {
  itemId: string;
  itemVersion: number;
  title: string;
  proposedSuccessorOfId: string | null;
  action: IntentReviewAction;
  /** The card's own reason; blank takes the batch reason. */
  reason: string;
}

export function stagedCard(
  item: { id: string; version: number; title: string; proposedSuccessorOfId: string | null },
  action: IntentReviewAction,
  reason = '',
): IntentStagedCard {
  return {
    itemId: item.id,
    itemVersion: item.version,
    title: item.title,
    proposedSuccessorOfId: item.proposedSuccessorOfId,
    action,
    reason,
  };
}

export interface IntentReviewBatchPlan {
  /** The decisions that go on the wire, in card order. */
  pending: IntentDraftDecision[];
  /** Cards deliberately left out, each with its own plain reason. */
  skipped: string[];
}

/**
 * Turn the staged cards into decisions. A card whose predecessor version is
 * unknown is left out with its own reason and the rest go ahead: the recorded
 * contract is per-decision (`POST items/review` answers item by item).
 */
export function planReviewBatch(input: {
  cards: readonly IntentStagedCard[];
  predecessorVersions: Readonly<Record<string, number>>;
  /** Used for any card whose own reason is blank — one pass usually has one story. */
  batchReason: string;
}): IntentReviewBatchPlan {
  const pending: IntentDraftDecision[] = [];
  const skipped: string[] = [];

  for (const card of input.cards) {
    const label = `“${card.title}”`;
    const reason = card.reason.trim() !== '' ? card.reason : input.batchReason;
    // The successor's card carries the supersession: when the candidate proposes
    // to replace an accepted item, "accept" means "supersede that predecessor",
    // and BOTH versions must travel (spec §5).
    const predecessorId = card.action === IntentReviewAction.Accept ? card.proposedSuccessorOfId : null;
    if (predecessorId === null) {
      pending.push({ itemId: card.itemId, expectedVersion: card.itemVersion, action: card.action, reason, label });
      continue;
    }
    const predecessorVersion = input.predecessorVersions[predecessorId];
    if (predecessorVersion === undefined) {
      skipped.push(
        `Can't read the current version of '${predecessorId}', so ${label} is left out of this batch — reload before superseding it.`,
      );
      continue;
    }
    pending.push({
      itemId: predecessorId,
      expectedVersion: predecessorVersion,
      action: IntentReviewAction.Supersede,
      reason,
      replacementItemId: card.itemId,
      replacementExpectedVersion: card.itemVersion,
      label: `${label} (replaces '${predecessorId}')`,
    });
  }

  return { pending, skipped };
}
