/**
 * Pure request logic for review decisions (the document view's Approve /
 * Reject and "Approve all").
 *
 * **One provenance group per submitted batch.** The server puts
 * `authorizingSource` and `workItem` on the batch, not the decision (spec
 * §4.7) — one review pass is authorized by one artifact. {@link
 * buildReviewRequest} is the only place a request is assembled. A stale
 * version refuses one decision, not the batch: `POST items/review` answers
 * 200 with a per-decision result list.
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

/** One card's pending decision, as the queue holds it before submission. */
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

/** The single provenance group the batch is submitted under. */
export interface IntentProvenanceForm {
  kind: IntentSourceKind;
  ref: string;
  localId: string;
  revision: string;
  workItemProvider: string;
  workItemId: string;
  workItemDisplayKey: string;
  workItemUrl: string;
}

/** A blank authorizing-source form; the presets fill it. */
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

export type IntentReviewRequestBuild =
  | { ok: true; request: IntentReviewRequest }
  | { ok: false; issues: readonly string[] };

const trim = (value: string): string => value.trim();

/**
 * Assemble one batch. Refuses locally only what the UI can see is wrong —
 * everything else is the server's to judge, and its structured refusal is what
 * the reviewer is shown.
 */
export function buildReviewRequest(
  provenance: IntentProvenanceForm,
  drafts: readonly IntentDraftDecision[],
  idempotencyKey: string,
): IntentReviewRequestBuild {
  const issues: string[] = [];

  if (drafts.length === 0) issues.push('Choose an action on at least one candidate before submitting.');
  if (drafts.length > INTENT_REVIEW_BATCH_LIMIT) {
    issues.push(`A review batch carries at most ${INTENT_REVIEW_BATCH_LIMIT} decisions.`);
  }
  if (trim(provenance.ref) === '') {
    issues.push(
      "The 'Authorizing source' form (top of this tab) needs the artifact reference that authorizes this pass — e.g. a spec path.",
    );
  }
  if (trim(provenance.localId) === '') {
    issues.push("The 'Authorizing source' form (top of this tab) needs the section or anchor inside that artifact.");
  }

  if (provenance.kind === IntentSourceKind.Spec && trim(provenance.revision) === '') {
    issues.push('The specification needs its approved revision (commit or content digest).');
  }

  const seen = new Set<string>();
  for (const draft of drafts) {
    const label = draft.label ?? `'${draft.itemId}'`;
    if (seen.has(draft.itemId)) issues.push(`Two decisions on ${label} in one batch.`);
    seen.add(draft.itemId);
    if (trim(draft.reason) === '')
      issues.push(`The decision on ${label} needs a reason (its card, or the batch reason).`);
    if (draft.action === IntentReviewAction.Supersede && draft.replacementItemId === undefined) {
      issues.push(`Supersede on ${label} needs the replacement candidate.`);
    }
  }

  // A work item is optional, but a half-filled one is not: provider and id are
  // both required by the server's shape, so refuse here rather than sending a
  // body that can only come back as a schema violation.
  const provider = trim(provenance.workItemProvider);
  const workItemId = trim(provenance.workItemId);
  if ((provider === '') !== (workItemId === '')) {
    issues.push('A work item reference needs both a provider and an id, or neither.');
  }

  if (issues.length > 0) return { ok: false, issues };

  const authorizingSource: IntentAuthorizingSource = {
    kind: provenance.kind,
    ref: trim(provenance.ref),
    localId: trim(provenance.localId),
    ...(trim(provenance.revision) === '' ? {} : { revision: trim(provenance.revision) }),
  };

  const decisions: IntentReviewDecisionInput[] = drafts.map((draft) => ({
    itemId: draft.itemId,
    expectedVersion: draft.expectedVersion,
    action: draft.action,
    reason: trim(draft.reason),
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
      authorizingSource,
      ...(provider === ''
        ? {}
        : {
            workItem: {
              provider,
              id: workItemId,
              ...(trim(provenance.workItemDisplayKey) === ''
                ? {}
                : { displayKey: trim(provenance.workItemDisplayKey) }),
              ...(trim(provenance.workItemUrl) === '' ? {} : { url: trim(provenance.workItemUrl) }),
            },
          }),
      decisions,
    },
  };
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
 * The default `today` injection. It is a FUNCTION and not a rendered value on
 * purpose: a date read during render makes the markup depend on the wall clock,
 * and the tests inject a fixed one.
 */
export function todayIsoDate(): string {
  return isoDateOnly(new Date());
}

/**
 * The "Manual decision" preset (issue v1.1-01): a well-formed authorizing source
 * for a decision that cites no spec. It fills exactly three fields — kind,
 * reference and local id — and leaves the revision and the work item alone,
 * because those are statements about an artifact this preset asserts none of.
 */
export function manualProvenancePreset(
  current: IntentProvenanceForm,
  options: { today: string },
): IntentProvenanceForm {
  // The reference is constant: the server records who decided from the token, and
  // an identity here (an email especially) is refused as intent content.
  return { ...current, kind: IntentSourceKind.Manual, ref: INTENT_MANUAL_REVIEW_REF, localId: options.today };
}

/**
 * What one card holds before it is submitted.
 *
 * `predecessorVersion` is stamped ONLY for an accept on a replacement — the one
 * wire action that carries a predecessor's expected version (spec §5). A reject,
 * defer or needs-edit on the same card says nothing about the predecessor, so a
 * predecessor moving underneath it is not a conflict and must not block it.
 */
export interface IntentCardDraft {
  action: IntentReviewAction;
  reason: string;
  predecessorVersion?: number;
}

/** One staged card, as the batch planner reads it. */
export interface IntentStagedCard {
  itemId: string;
  itemVersion: number;
  title: string;
  proposedSuccessorOfId: string | null;
  draft: IntentCardDraft;
  /** The card cannot be decided as it stands — see `cardVersionConflict`. */
  conflicted: boolean;
}

/** One candidate staged for a single decision — the shape `planReviewBatch` reads. */
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
    draft: { action, reason },
    conflicted: false,
  };
}

export interface IntentReviewBatchPlan {
  /** The decisions that go on the wire, in card order. */
  pending: IntentDraftDecision[];
  /** Cards deliberately left out, each with its own plain reason. */
  skipped: string[];
}

/**
 * Turn the staged cards into ONE batch.
 *
 * A conflicted card is EXCLUDED with its own reason and the rest are submitted:
 * aborting the whole batch because one card's predecessor moved held every other
 * decision hostage to a repair the reviewer may not want to make now, and the
 * recorded contract is per-decision (`POST items/review` answers item by item).
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
    if (card.conflicted) {
      skipped.push(`${label} changed since you staged it — it is left out of this batch; re-fetch it or unstage it.`);
      continue;
    }
    const reason = card.draft.reason.trim() !== '' ? card.draft.reason : input.batchReason;
    // The successor's card carries the supersession: when the candidate proposes
    // to replace an accepted item, "accept" means "supersede that predecessor",
    // and BOTH versions must travel (spec §5).
    const predecessorId = card.draft.action === IntentReviewAction.Accept ? card.proposedSuccessorOfId : null;
    if (predecessorId === null) {
      pending.push({
        itemId: card.itemId,
        expectedVersion: card.itemVersion,
        action: card.draft.action,
        reason,
        label,
      });
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
