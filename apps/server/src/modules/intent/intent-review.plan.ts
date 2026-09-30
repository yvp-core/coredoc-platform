/**
 * What one review decision DOES — decided as pure logic, before any row moves.
 *
 * This is the archived `reviewIntentItems` / `supersedeIntentItem`
 * (packages/core/src/intent/review.ts) adapted from an in-memory overlay to
 * relational rows, with ONE deliberate change of shape: the archive refused the
 * WHOLE batch when any decision was invalid ("Review refused: nothing was
 * written"), and this planner returns a per-decision refusal instead. Spec §5
 * requires item-by-item results — a reviewer working a queue must not lose nine
 * good decisions because the tenth item moved under them.
 *
 * Rules carried over unchanged from the archive:
 *  - only a CANDIDATE can be accepted or rejected;
 *  - only an ACCEPTED item can be superseded;
 *  - a replacement is itself a candidate, of the SAME kind as its predecessor,
 *    and nothing ever supersedes itself.
 *
 * Rules the relational model adds:
 *  - the replacement must already CARRY `proposedSuccessorOfId` naming this
 *    predecessor. Replacement is declared at propose time (spec §5) and merely
 *    ratified at review time; letting a reviewer pair two unrelated items here
 *    would make the supersession relation an artifact of the review call rather
 *    than of the proposal it records.
 *  - a plain `accept` on a candidate that carries `proposedSuccessorOfId` is
 *    REFUSED, not silently widened into a replacement. The accept shape carries
 *    one expected version, and spec §5 demands a version check on BOTH items;
 *    accepting on one version check would let the predecessor move unseen.
 *  - every decision states the `version` it was formed against, and a moved
 *    version refuses that decision — including `defer` and `needs_edit`, which
 *    write nothing either way but must not report a judgement of content the
 *    reviewer did not actually see.
 *
 * Pure: no IO, no clock, no randomness. The facts arrive already read (and, in
 * the service, already row-locked), so the same matrix is unit-testable without
 * a database.
 */
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import type { IntentErrorDetail } from './contract/index.js';
import { IntentReviewAction, type IntentReviewDecisionInput } from './contract/index.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateRefusal } from './intent-state-errors.js';

type Authority = (typeof IntentItemAuthority)[keyof typeof IntentItemAuthority];

/** What a decision DID, as reported back to the reviewer. */
export enum IntentReviewOutcome {
  Accepted = 'accepted',
  Rejected = 'rejected',
  /** The subject was superseded and its replacement accepted, in one transaction. */
  Superseded = 'superseded',
  Deferred = 'deferred',
  NeedsEdit = 'needs_edit',
  Refused = 'refused',
}

/** How the service must execute a planned decision. */
export enum IntentReviewEffect {
  /** `defer` / `needs_edit`: reported, never written. */
  None = 'none',
  /** One item changes authority. */
  Transition = 'transition',
  /** Two items change authority together, or neither does. */
  Replacement = 'replacement',
  /** Nothing is written; the caller gets a structured refusal for this decision. */
  Refusal = 'refusal',
}

/** The item facts a decision is judged against. Everything else stays in the database. */
export interface ReviewItemFacts {
  id: string;
  kind: string;
  authority: Authority;
  version: number;
  proposedSuccessorOfId: string | null;
}

export interface ReviewDecisionContext {
  /** The decision's subject, when it exists in this workspace. */
  subject: ReviewItemFacts | undefined;
  /** The named replacement of a `supersede` decision, when it exists. */
  replacement: ReviewItemFacts | undefined;
}

/** One item's authority move, ready to apply. */
export interface PlannedTransition {
  itemId: string;
  expectedVersion: number;
  from: Authority;
  to: Authority;
  /** Set on the predecessor of a replacement; `intent_items_superseded_by_authority_check` requires the pair. */
  supersededById?: string;
}

export type IntentReviewPlan =
  | { effect: IntentReviewEffect.None; outcome: IntentReviewOutcome.Deferred | IntentReviewOutcome.NeedsEdit }
  | {
      effect: IntentReviewEffect.Transition;
      outcome: IntentReviewOutcome.Accepted | IntentReviewOutcome.Rejected;
      transition: PlannedTransition;
    }
  | {
      effect: IntentReviewEffect.Replacement;
      outcome: IntentReviewOutcome.Superseded;
      predecessor: PlannedTransition;
      successor: PlannedTransition;
      /**
       * The two transitions in ascending id order — the order the service
       * writes them in. Deterministic ordering is what keeps two concurrent
       * replacements from deadlocking on each other's rows (spec §13).
       */
      ordered: [PlannedTransition, PlannedTransition];
    }
  | { effect: IntentReviewEffect.Refusal; outcome: IntentReviewOutcome.Refused; refusal: IntentErrorDetail };

function refuse(code: IntentErrorCode, message: string, path: string[]): IntentReviewPlan {
  return {
    effect: IntentReviewEffect.Refusal,
    outcome: IntentReviewOutcome.Refused,
    refusal: intentStateRefusal(code, message, path),
  };
}

function notFound(itemId: string, path: string[]): IntentReviewPlan {
  return refuse(IntentErrorCode.ItemNotFound, `Intent item '${itemId}' does not exist in this workspace`, path);
}

function versionConflict(item: ReviewItemFacts, expected: number, path: string[]): IntentReviewPlan {
  return refuse(
    IntentErrorCode.VersionConflict,
    `Intent item '${item.id}' changed: expected version ${expected}, current version is ${item.version}. Re-read the item and decide again.`,
    path,
  );
}

/**
 * Decide what a single review decision does.
 *
 * `path` is this decision's request path (`['decisions', '0']`), so every
 * refusal names the exact decision in the batch and the exact field that failed.
 */
export function planReviewDecision(
  decision: IntentReviewDecisionInput,
  context: ReviewDecisionContext,
  path: string[],
): IntentReviewPlan {
  const subject = context.subject;
  if (subject === undefined) return notFound(decision.itemId, [...path, 'itemId']);
  if (subject.version !== decision.expectedVersion) {
    return versionConflict(subject, decision.expectedVersion, [...path, 'expectedVersion']);
  }

  switch (decision.action) {
    case IntentReviewAction.Defer:
      return { effect: IntentReviewEffect.None, outcome: IntentReviewOutcome.Deferred };
    case IntentReviewAction.NeedsEdit:
      return { effect: IntentReviewEffect.None, outcome: IntentReviewOutcome.NeedsEdit };
    case IntentReviewAction.Accept:
      return planAccept(subject, path);
    case IntentReviewAction.Reject:
      return planReject(subject, path);
    case IntentReviewAction.Supersede:
      return planSupersede(decision, subject, context.replacement, path);
  }
}

function planAccept(subject: ReviewItemFacts, path: string[]): IntentReviewPlan {
  if (subject.authority !== IntentItemAuthority.candidate) return notCandidate(subject, [...path, 'itemId']);
  if (subject.proposedSuccessorOfId !== null) {
    return refuse(
      IntentErrorCode.ReplacementDecisionRequired,
      `Intent item '${subject.id}' proposes to replace '${subject.proposedSuccessorOfId}'. Decide it as a 'supersede' of that item, which checks both versions.`,
      [...path, 'action'],
    );
  }
  return {
    effect: IntentReviewEffect.Transition,
    outcome: IntentReviewOutcome.Accepted,
    transition: {
      itemId: subject.id,
      expectedVersion: subject.version,
      from: IntentItemAuthority.candidate,
      to: IntentItemAuthority.accepted,
    },
  };
}

/**
 * A candidate is rejectable whatever it proposes to replace: spec §5 says a
 * replacement whose predecessor moved stays a candidate "for re-targeting or
 * rejection", so rejection must not need the predecessor at all.
 */
function planReject(subject: ReviewItemFacts, path: string[]): IntentReviewPlan {
  if (subject.authority !== IntentItemAuthority.candidate) return notCandidate(subject, [...path, 'itemId']);
  return {
    effect: IntentReviewEffect.Transition,
    outcome: IntentReviewOutcome.Rejected,
    transition: {
      itemId: subject.id,
      expectedVersion: subject.version,
      from: IntentItemAuthority.candidate,
      to: IntentItemAuthority.rejected,
    },
  };
}

function planSupersede(
  decision: IntentReviewDecisionInput,
  subject: ReviewItemFacts,
  replacement: ReviewItemFacts | undefined,
  path: string[],
): IntentReviewPlan {
  // The schema guarantees both replacement fields are present on a supersede
  // decision and that the replacement is not the subject itself.
  const replacementItemId = decision.replacementItemId as string;
  const replacementExpectedVersion = decision.replacementExpectedVersion as number;
  const replacementPath = [...path, 'replacementItemId'];

  if (subject.authority !== IntentItemAuthority.accepted) {
    return refuse(
      IntentErrorCode.ItemNotAccepted,
      `Intent item '${subject.id}' is ${subject.authority}; only an accepted item can be superseded.`,
      [...path, 'itemId'],
    );
  }
  if (replacement === undefined) return notFound(replacementItemId, replacementPath);
  if (replacement.version !== replacementExpectedVersion) {
    return versionConflict(replacement, replacementExpectedVersion, [...path, 'replacementExpectedVersion']);
  }
  if (replacement.authority !== IntentItemAuthority.candidate) return notCandidate(replacement, replacementPath);
  if (replacement.proposedSuccessorOfId !== subject.id) {
    return refuse(
      IntentErrorCode.ReplacementNotProposed,
      `Intent item '${replacement.id}' does not propose to replace '${subject.id}'. Propose it as the successor first, then decide the supersession.`,
      replacementPath,
    );
  }
  if (replacement.kind !== subject.kind) {
    return refuse(
      IntentErrorCode.ReplacementKindMismatch,
      `A replacement is of the same kind as the item it replaces; got ${replacement.kind} for a ${subject.kind}.`,
      replacementPath,
    );
  }

  const predecessor: PlannedTransition = {
    itemId: subject.id,
    expectedVersion: subject.version,
    from: IntentItemAuthority.accepted,
    to: IntentItemAuthority.superseded,
    supersededById: replacement.id,
  };
  const successor: PlannedTransition = {
    itemId: replacement.id,
    expectedVersion: replacement.version,
    from: IntentItemAuthority.candidate,
    to: IntentItemAuthority.accepted,
  };
  return {
    effect: IntentReviewEffect.Replacement,
    outcome: IntentReviewOutcome.Superseded,
    predecessor,
    successor,
    ordered: predecessor.itemId < successor.itemId ? [predecessor, successor] : [successor, predecessor],
  };
}

function notCandidate(item: ReviewItemFacts, path: string[]): IntentReviewPlan {
  return refuse(
    IntentErrorCode.ItemNotCandidate,
    `Intent item '${item.id}' is ${item.authority}, not a candidate; only a candidate can be accepted, rejected, or accepted as a replacement.`,
    path,
  );
}

/** Every item a batch decides on, subjects and replacements alike, in request order. */
export function reviewSubjectIds(decisions: readonly IntentReviewDecisionInput[]): string[] {
  const ids: string[] = [];
  for (const decision of decisions) {
    ids.push(decision.itemId);
    if (decision.replacementItemId !== undefined) ids.push(decision.replacementItemId);
  }
  return ids;
}
