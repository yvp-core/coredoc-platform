/**
 * Pure request/response logic for the review queue.
 *
 * Two rules live here rather than in the component, because both are contract
 * facts a test must be able to pin without rendering:
 *
 * 1. **One provenance group per submitted batch.** The server puts
 *    `authorizingSource` and `workItem` on the batch, not the decision (spec
 *    §4.7) — one review pass is authorized by one artifact. {@link
 *    buildReviewRequest} is the only place a request is assembled, so the UI
 *    cannot grow a per-card provenance field by accident.
 * 2. **A stale version refuses one decision, not the batch.** `POST items/review`
 *    answers 200 with a per-decision result list, so the response is read
 *    item-by-item; {@link versionConflictItemIds} names exactly the ids that must
 *    be re-fetched and decided again (spec §5).
 */

import {
  INTENT_VERSION_CONFLICT_CODE,
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentAuthorizingSource,
  type IntentItemSource,
  type IntentItemSummary,
  type IntentReviewDecisionInput,
  type IntentReviewDecisionResult,
  type IntentReviewRequest,
  type IntentReviewResponse,
} from '../../../shared/intent-types.js';

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
 * The ids a stale-version refusal named — exactly what the "re-fetch and
 * re-decide" flow must re-read. A refusal for any OTHER reason is not in this
 * list: re-fetching would not change its answer, so it stays on screen with the
 * server's own message.
 */
export function versionConflictItemIds(response: IntentReviewResponse): string[] {
  return response.decisions
    .filter(
      (decision) =>
        decision.outcome === IntentReviewOutcome.Refused && decision.error?.code === INTENT_VERSION_CONFLICT_CODE,
    )
    .map((decision) => decision.itemId);
}

/** Decisions the server applied — their cards leave the queue. */
export function appliedItemIds(response: IntentReviewResponse): string[] {
  const applied = new Set<IntentReviewOutcome>([
    IntentReviewOutcome.Accepted,
    IntentReviewOutcome.Rejected,
    IntentReviewOutcome.Superseded,
  ]);
  return response.decisions.filter((decision) => applied.has(decision.outcome)).map((decision) => decision.itemId);
}

/**
 * The versions a refusal reported back, so a re-decide starts from what the item
 * says NOW instead of the number the reviewer had. `null` means the item no
 * longer exists and cannot be re-decided at all.
 */
export function reportedVersions(response: IntentReviewResponse): Map<string, number | null> {
  return new Map(response.decisions.map((decision) => [decision.itemId, decision.version]));
}

/**
 * Attribute each per-decision result to the CARD the reviewer decided on.
 *
 * THE DEFECT THIS CLOSES: a supersession is decided on the successor's card, but
 * the decision it produces has the PREDECESSOR as its subject — that is the id
 * the batch carries and the version the server checks. Looking results up by the
 * card's own id therefore left every supersede card showing no outcome at all:
 * no "Superseded" badge, and — worse — no refusal message when the server
 * refused it.
 *
 * The response may key such a row on either side (the decision's subject, or the
 * replacement it names), so a card claims a result when the row's `itemId` is
 * the card, when the row's `replacement.itemId` is the card, or when the row's
 * `itemId` is the accepted predecessor this card proposes to replace.
 */
export function reviewResultsByCard(
  results: readonly IntentReviewDecisionResult[] | null,
  // Only the two fields the mapping actually reads: the queue row and the browse
  // index row are different shapes and both are legitimate cards.
  cards: readonly Pick<IntentItemSummary, 'id' | 'proposedSuccessorOfId'>[],
): Map<string, IntentReviewDecisionResult> {
  const byCard = new Map<string, IntentReviewDecisionResult>();
  if (results === null) return byCard;

  const bySubject = new Map<string, IntentReviewDecisionResult>();
  const byReplacement = new Map<string, IntentReviewDecisionResult>();
  for (const result of results) {
    if (!bySubject.has(result.itemId)) bySubject.set(result.itemId, result);
    const replacementId = result.replacement?.itemId;
    if (replacementId !== undefined && !byReplacement.has(replacementId)) byReplacement.set(replacementId, result);
  }

  for (const card of cards) {
    const match =
      bySubject.get(card.id) ??
      byReplacement.get(card.id) ??
      (card.proposedSuccessorOfId === null ? undefined : bySubject.get(card.proposedSuccessorOfId));
    if (match !== undefined) byCard.set(card.id, match);
  }
  return byCard;
}

/** True when at least one decision in the batch still needs the reviewer. */
export function hasUnresolvedDecisions(results: readonly IntentReviewDecisionResult[]): boolean {
  return results.some((result) => result.outcome === IntentReviewOutcome.Refused);
}

/* ------------------------------------------------- provenance assistance --- */

/**
 * The reference a manual decision is authorized by when the reviewer has no
 * handle to sign with. A decision still has to be attributable to SOMETHING —
 * "this was decided in the desktop review UI" is the honest minimum.
 */
export const INTENT_MANUAL_REVIEW_REF = 'desktop-review';

/** The provenance fields the preset and the prefill are allowed to touch. */
export type IntentProvenanceField = 'kind' | 'ref' | 'localId' | 'revision';

/** Fields the reviewer has typed in: neither preset nor prefill overwrites one. */
export type IntentProvenanceTouched = Readonly<Partial<Record<IntentProvenanceField, boolean>>>;

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
  options: { reviewerHandle?: string; today: string },
): IntentProvenanceForm {
  const handle = options.reviewerHandle?.trim();
  return {
    ...current,
    kind: IntentSourceKind.Manual,
    ref: handle === undefined || handle === '' ? INTENT_MANUAL_REVIEW_REF : handle,
    localId: options.today,
  };
}

/** What the staged candidates say about where their content came from. */
export type IntentSharedSource =
  | { state: 'none' }
  /** Every staged candidate cites the same single source — safe to prefill. */
  | { state: 'single'; source: IntentItemSource }
  /** They cite different sources; the reviewer picks, the UI never guesses. */
  | { state: 'mixed'; first: IntentItemSource };

const sourceSignature = (source: IntentItemSource): string =>
  JSON.stringify([source.kind, source.ref, source.localId, source.revision]);

/**
 * Read the staged candidates' sources as one answer.
 *
 * A batch is authorized by ONE artifact (spec §4.7), so a prefill is only
 * honest when every staged candidate cites exactly one source and they are the
 * same source. Anything else is `mixed`: the panel says so and offers the first
 * as a one-click choice rather than silently picking a winner.
 */
export function sharedProvenanceSource(sourceLists: readonly (readonly IntentItemSource[])[]): IntentSharedSource {
  const nonEmpty = sourceLists.filter((list) => list.length > 0);
  if (nonEmpty.length === 0) return { state: 'none' };

  const first = nonEmpty[0][0];
  const identical =
    nonEmpty.length === sourceLists.length &&
    nonEmpty.every((list) => list.length === 1 && sourceSignature(list[0]) === sourceSignature(first));

  return identical ? { state: 'single', source: first } : { state: 'mixed', first };
}

/**
 * Apply a source to the form, field by field, skipping anything the reviewer has
 * typed in. Deriving the effective form this way — rather than writing state
 * when candidates are staged — is what makes the prefill happen "once": a field
 * the reviewer edits is `touched` from then on, so the prefill can never come
 * back and overwrite it, and no effect has to remember that it already ran.
 */
export function applyProvenanceSource(
  form: IntentProvenanceForm,
  touched: IntentProvenanceTouched,
  source: IntentItemSource,
): IntentProvenanceForm {
  return {
    ...form,
    ...(touched.kind === true ? {} : { kind: source.kind }),
    ...(touched.ref === true ? {} : { ref: source.ref }),
    ...(touched.localId === true ? {} : { localId: source.localId }),
    ...(touched.revision === true ? {} : { revision: source.revision ?? '' }),
  };
}

/* ----------------------------------------------------- per-card conflicts --- */

/**
 * A card whose version check cannot pass as it stands.
 *
 * `subjectId` is the item the server will check, which for a supersession is the
 * PREDECESSOR, not the card — that is the id `onRefetchConflicts` must be given.
 */
export interface IntentCardConflict {
  subjectId: string;
  expectedVersion: number;
  /** What the server says the version is now; `null` when it reported none. */
  serverVersion: number | null;
}

/**
 * Decide whether a card is conflicted, from the two independent signals a
 * reviewer can hit (spec §5):
 *
 * 1. The last submit was REFUSED on this card's subject with a stale version.
 * 2. The predecessor moved underneath a staged supersession — the version now
 *    loaded is not the one the reviewer staged against, so accepting would be a
 *    decision about content they never read.
 */
export function cardVersionConflict(input: {
  itemId: string;
  itemVersion: number;
  predecessorId: string | null;
  /** The predecessor's currently loaded version, if it could be read. */
  predecessorVersion?: number;
  /** The predecessor version this card was staged against, if it is staged. */
  stagedPredecessorVersion?: number;
  /** The result the last batch produced for this card, if any. */
  result?: IntentReviewDecisionResult;
}): IntentCardConflict | null {
  const { result } = input;
  if (result?.outcome === IntentReviewOutcome.Refused && result.error?.code === INTENT_VERSION_CONFLICT_CODE) {
    const onPredecessor = result.itemId !== input.itemId;
    // The version the reviewer HOLDS — which is what a re-submit would send, so
    // it is also the number the conflict note must name as "expected".
    const held = onPredecessor ? input.predecessorVersion : input.itemVersion;
    // A refusal survives the re-fetch on purpose (it carries the current
    // version), so the refusal alone cannot mean "still conflicted": once the
    // held version IS the version the server reported, the reviewer is reading
    // the current item and must be able to decide again.
    const repaired = result.version !== null && held !== undefined && held === result.version;
    if (!repaired) {
      return {
        subjectId: result.itemId,
        // A refusal that named a predecessor whose version is unreadable still
        // renders as a conflict; the card's own version is the only number in
        // hand, and the server's is shown beside it.
        expectedVersion: held ?? input.itemVersion,
        serverVersion: result.version,
      };
    }
  }

  if (
    input.predecessorId !== null &&
    input.stagedPredecessorVersion !== undefined &&
    input.predecessorVersion !== undefined &&
    input.stagedPredecessorVersion !== input.predecessorVersion
  ) {
    return {
      subjectId: input.predecessorId,
      expectedVersion: input.stagedPredecessorVersion,
      serverVersion: input.predecessorVersion,
    };
  }

  return null;
}

/* --------------------------------------------------------- staged drafts --- */

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

export type IntentDraftMap = Readonly<Record<string, IntentCardDraft>>;

/**
 * The predecessor version to freeze when an action is staged: the loaded one for
 * an accept on a replacement, and nothing at all otherwise.
 */
export function stagedPredecessorVersion(input: {
  action: IntentReviewAction;
  predecessorId: string | null;
  predecessorVersions: Readonly<Record<string, number>>;
}): number | undefined {
  if (input.action !== IntentReviewAction.Accept || input.predecessorId === null) return undefined;
  return input.predecessorVersions[input.predecessorId];
}

/** Stage (or re-stage) one card, keeping whatever reason the reviewer already typed. */
export function stageDraft(
  drafts: IntentDraftMap,
  itemId: string,
  action: IntentReviewAction,
  predecessorVersion: number | undefined,
): Record<string, IntentCardDraft> {
  const existing = drafts[itemId];
  return {
    ...drafts,
    [itemId]: {
      action,
      reason: existing?.reason ?? '',
      ...(predecessorVersion === undefined ? {} : { predecessorVersion }),
    },
  };
}

/** Drop one card's staged decision entirely — the repair for a card that cannot be decided. */
export function unstageDraft(drafts: IntentDraftMap, itemId: string): Record<string, IntentCardDraft> {
  const { [itemId]: _removed, ...rest } = drafts;
  return rest;
}

/**
 * Re-stamp a staged card against the predecessor version now in hand.
 *
 * "Re-fetch" is the reviewer saying "show me the current one", so the card must
 * become decidable again — freezing the version they staged against and never
 * moving it is what made a moved predecessor permanent. The protection is
 * acknowledged, not spent: if the re-read then returns a NEWER version, the
 * comparison raises the conflict again.
 */
export function restampPredecessorVersion(
  drafts: IntentDraftMap,
  itemId: string,
  predecessorVersion: number | undefined,
): Record<string, IntentCardDraft> {
  const existing = drafts[itemId];
  if (existing === undefined || existing.predecessorVersion === undefined) return { ...drafts };
  return {
    ...drafts,
    [itemId]: {
      ...existing,
      ...(predecessorVersion === undefined ? {} : { predecessorVersion }),
    },
  };
}

/**
 * The drafts that survive a submitted batch.
 *
 * Every decision the server CONFIRMED is cleared — its card has left the queue,
 * and keeping the draft would re-send the same decision on the next submit
 * (`defer` and `needs_edit` are wire actions, so this is not hypothetical). Only
 * a REFUSED decision is kept, because that card still needs the reviewer.
 */
export function draftsAfterResults(
  drafts: IntentDraftMap,
  resultsByCard: ReadonlyMap<string, IntentReviewDecisionResult>,
): Record<string, IntentCardDraft> {
  const kept: Record<string, IntentCardDraft> = {};
  for (const [itemId, draft] of Object.entries(drafts)) {
    const outcome = resultsByCard.get(itemId)?.outcome;
    if (outcome === undefined || outcome === IntentReviewOutcome.Refused) kept[itemId] = draft;
  }
  return kept;
}

/* ---------------------------------------------------------- batch plan --- */

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
