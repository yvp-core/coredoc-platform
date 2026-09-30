/**
 * The review decision matrix, ported from the archive's `review.ts` tests to
 * per-decision results.
 *
 * Where the archive asserted "Review refused: nothing was written" for the whole
 * batch, the assertion here is that THIS decision carries a refusal code — the
 * batch-level behaviour is proven in the PostgreSQL integration suite, which is
 * the only place a sibling decision can actually be observed to have landed.
 *
 * The rules under test are the ones that make an unrepresentable state
 * unrepresentable: nothing but a candidate is accepted or rejected, nothing but
 * an accepted item is superseded, a replacement was declared at propose time and
 * shares its predecessor's kind, and no decision applies against a version the
 * reviewer did not look at.
 */
import { describe, expect, it } from 'vitest';
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { IntentReviewAction, type IntentReviewDecisionInput } from './contract/index.js';
import {
  IntentReviewEffect,
  IntentReviewOutcome,
  planReviewDecision,
  reviewSubjectIds,
  type IntentReviewPlan,
  type ReviewItemFacts,
} from './intent-review.plan.js';
import { IntentErrorCode } from './contract/index.js';

const PATH = ['decisions', '0'];

function facts(overrides: Partial<ReviewItemFacts> = {}): ReviewItemFacts {
  return {
    id: 'br-refund-window',
    kind: 'business_rule',
    authority: IntentItemAuthority.candidate,
    version: 1,
    proposedSuccessorOfId: null,
    ...overrides,
  };
}

function decision(overrides: Partial<IntentReviewDecisionInput> = {}): IntentReviewDecisionInput {
  return {
    itemId: 'br-refund-window',
    expectedVersion: 1,
    action: IntentReviewAction.Accept,
    reason: 'The spec says so.',
    ...overrides,
  } as IntentReviewDecisionInput;
}

/** The refusal code of a plan that must be a refusal. */
function refusal(plan: IntentReviewPlan): { code: string; path: string[] } {
  if (plan.effect !== IntentReviewEffect.Refusal) throw new Error(`expected a refusal, got ${plan.effect}`);
  expect(plan.outcome).toBe(IntentReviewOutcome.Refused);
  return { code: plan.refusal.code, path: plan.refusal.path };
}

describe('planReviewDecision — accept and reject', () => {
  it('accepts a candidate as one candidate→accepted transition', () => {
    const plan = planReviewDecision(decision(), { subject: facts(), replacement: undefined }, PATH);
    expect(plan).toEqual({
      effect: IntentReviewEffect.Transition,
      outcome: IntentReviewOutcome.Accepted,
      transition: {
        itemId: 'br-refund-window',
        expectedVersion: 1,
        from: IntentItemAuthority.candidate,
        to: IntentItemAuthority.accepted,
      },
    });
  });

  it('rejects a candidate as one candidate→rejected transition', () => {
    const plan = planReviewDecision(
      decision({ action: IntentReviewAction.Reject }),
      { subject: facts(), replacement: undefined },
      PATH,
    );
    expect(plan).toMatchObject({
      effect: IntentReviewEffect.Transition,
      outcome: IntentReviewOutcome.Rejected,
      transition: { to: IntentItemAuthority.rejected },
    });
  });

  it('lets a candidate whose predecessor moved be rejected without naming that predecessor', () => {
    const plan = planReviewDecision(
      decision({ action: IntentReviewAction.Reject }),
      { subject: facts({ proposedSuccessorOfId: 'br-old-rule' }), replacement: undefined },
      PATH,
    );
    expect(plan.outcome).toBe(IntentReviewOutcome.Rejected);
  });

  it.each([
    IntentItemAuthority.accepted,
    IntentItemAuthority.rejected,
    IntentItemAuthority.superseded,
  ])('refuses accepting a %s item — an authority change out of it is unrepresentable', (authority) => {
    const plan = planReviewDecision(decision(), { subject: facts({ authority }), replacement: undefined }, PATH);
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ItemNotCandidate,
      path: ['decisions', '0', 'itemId'],
    });
  });

  it.each([
    IntentItemAuthority.accepted,
    IntentItemAuthority.rejected,
    IntentItemAuthority.superseded,
  ])('refuses rejecting a %s item', (authority) => {
    const plan = planReviewDecision(
      decision({ action: IntentReviewAction.Reject }),
      { subject: facts({ authority }), replacement: undefined },
      PATH,
    );
    expect(refusal(plan).code).toBe(IntentErrorCode.ItemNotCandidate);
  });

  it('refuses a plain accept of a candidate that proposes a replacement, naming the supersede route', () => {
    const plan = planReviewDecision(
      decision(),
      { subject: facts({ proposedSuccessorOfId: 'br-old-rule' }), replacement: undefined },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ReplacementDecisionRequired,
      path: ['decisions', '0', 'action'],
    });
  });
});

describe('planReviewDecision — existence and versions', () => {
  it('refuses a decision on an item this workspace does not hold', () => {
    const plan = planReviewDecision(decision(), { subject: undefined, replacement: undefined }, PATH);
    expect(refusal(plan)).toEqual({ code: IntentErrorCode.ItemNotFound, path: ['decisions', '0', 'itemId'] });
  });

  it('refuses a decision formed against a version that has moved, naming the current one', () => {
    const plan = planReviewDecision(decision(), { subject: facts({ version: 3 }), replacement: undefined }, PATH);
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.VersionConflict,
      path: ['decisions', '0', 'expectedVersion'],
    });
    if (plan.effect !== IntentReviewEffect.Refusal) throw new Error('unreachable');
    expect(plan.refusal.message).toContain('current version is 3');
  });

  it.each([
    IntentReviewAction.Defer,
    IntentReviewAction.NeedsEdit,
  ])('refuses a %s formed against a stale version too — a judgement of content nobody saw', (action) => {
    const plan = planReviewDecision(
      decision({ action }),
      { subject: facts({ version: 2 }), replacement: undefined },
      PATH,
    );
    expect(refusal(plan).code).toBe(IntentErrorCode.VersionConflict);
  });
});

describe('planReviewDecision — defer and needs_edit write nothing', () => {
  it.each([
    [IntentReviewAction.Defer, IntentReviewOutcome.Deferred],
    [IntentReviewAction.NeedsEdit, IntentReviewOutcome.NeedsEdit],
  ])('reports %s without any effect', (action, outcome) => {
    const plan = planReviewDecision(decision({ action }), { subject: facts(), replacement: undefined }, PATH);
    expect(plan).toEqual({ effect: IntentReviewEffect.None, outcome });
  });

  it('reports a defer on an accepted item rather than refusing it — nothing is being changed', () => {
    const plan = planReviewDecision(
      decision({ action: IntentReviewAction.Defer }),
      { subject: facts({ authority: IntentItemAuthority.accepted }), replacement: undefined },
      PATH,
    );
    expect(plan.outcome).toBe(IntentReviewOutcome.Deferred);
  });
});

describe('planReviewDecision — replacement planner', () => {
  const supersede = decision({
    itemId: 'br-old-rule',
    expectedVersion: 4,
    action: IntentReviewAction.Supersede,
    replacementItemId: 'br-new-rule',
    replacementExpectedVersion: 2,
  });
  const predecessorFacts = facts({ id: 'br-old-rule', authority: IntentItemAuthority.accepted, version: 4 });
  const successorFacts = facts({ id: 'br-new-rule', version: 2, proposedSuccessorOfId: 'br-old-rule' });

  it('plans both transitions, in ascending id order, with the supersession pointer on the predecessor', () => {
    const plan = planReviewDecision(supersede, { subject: predecessorFacts, replacement: successorFacts }, PATH);
    expect(plan).toEqual({
      effect: IntentReviewEffect.Replacement,
      outcome: IntentReviewOutcome.Superseded,
      predecessor: {
        itemId: 'br-old-rule',
        expectedVersion: 4,
        from: IntentItemAuthority.accepted,
        to: IntentItemAuthority.superseded,
        supersededById: 'br-new-rule',
      },
      successor: {
        itemId: 'br-new-rule',
        expectedVersion: 2,
        from: IntentItemAuthority.candidate,
        to: IntentItemAuthority.accepted,
      },
      ordered: [expect.objectContaining({ itemId: 'br-new-rule' }), expect.objectContaining({ itemId: 'br-old-rule' })],
    });
  });

  it('orders the two writes by id whichever way round the ids sort', () => {
    const plan = planReviewDecision(
      decision({
        itemId: 'br-aaa',
        expectedVersion: 4,
        action: IntentReviewAction.Supersede,
        replacementItemId: 'br-zzz',
        replacementExpectedVersion: 2,
      }),
      {
        subject: facts({ id: 'br-aaa', authority: IntentItemAuthority.accepted, version: 4 }),
        replacement: facts({ id: 'br-zzz', version: 2, proposedSuccessorOfId: 'br-aaa' }),
      },
      PATH,
    );
    if (plan.effect !== IntentReviewEffect.Replacement) throw new Error('expected a replacement');
    expect(plan.ordered.map((transition) => transition.itemId)).toEqual(['br-aaa', 'br-zzz']);
  });

  it.each([
    IntentItemAuthority.candidate,
    IntentItemAuthority.rejected,
    IntentItemAuthority.superseded,
  ])('refuses superseding a %s item — only an accepted item has authority to lose', (authority) => {
    const plan = planReviewDecision(
      supersede,
      { subject: facts({ id: 'br-old-rule', authority, version: 4 }), replacement: successorFacts },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ItemNotAccepted,
      path: ['decisions', '0', 'itemId'],
    });
  });

  it('refuses a replacement this workspace does not hold', () => {
    const plan = planReviewDecision(supersede, { subject: predecessorFacts, replacement: undefined }, PATH);
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ItemNotFound,
      path: ['decisions', '0', 'replacementItemId'],
    });
  });

  it('refuses a replacement whose version moved — the second half of the pair is checked too', () => {
    const plan = planReviewDecision(
      supersede,
      { subject: predecessorFacts, replacement: { ...successorFacts, version: 3 } },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.VersionConflict,
      path: ['decisions', '0', 'replacementExpectedVersion'],
    });
  });

  it('refuses a replacement that is not itself a candidate', () => {
    const plan = planReviewDecision(
      supersede,
      { subject: predecessorFacts, replacement: { ...successorFacts, authority: IntentItemAuthority.accepted } },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ItemNotCandidate,
      path: ['decisions', '0', 'replacementItemId'],
    });
  });

  it('refuses a replacement that never proposed to replace this item', () => {
    const plan = planReviewDecision(
      supersede,
      { subject: predecessorFacts, replacement: { ...successorFacts, proposedSuccessorOfId: null } },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ReplacementNotProposed,
      path: ['decisions', '0', 'replacementItemId'],
    });
  });

  it('refuses a replacement that proposed to replace a DIFFERENT item', () => {
    const plan = planReviewDecision(
      supersede,
      { subject: predecessorFacts, replacement: { ...successorFacts, proposedSuccessorOfId: 'br-other-rule' } },
      PATH,
    );
    expect(refusal(plan).code).toBe(IntentErrorCode.ReplacementNotProposed);
  });

  it('refuses a replacement of a different kind (archive rule)', () => {
    const plan = planReviewDecision(
      supersede,
      { subject: predecessorFacts, replacement: { ...successorFacts, kind: 'limitation' } },
      PATH,
    );
    expect(refusal(plan)).toEqual({
      code: IntentErrorCode.ReplacementKindMismatch,
      path: ['decisions', '0', 'replacementItemId'],
    });
  });
});

describe('reviewSubjectIds', () => {
  it('lists subjects and replacements alike, so both halves of a pair are locked', () => {
    expect(
      reviewSubjectIds([
        decision(),
        decision({
          itemId: 'br-old-rule',
          action: IntentReviewAction.Supersede,
          replacementItemId: 'br-new-rule',
          replacementExpectedVersion: 1,
        }),
      ]),
    ).toEqual(['br-refund-window', 'br-old-rule', 'br-new-rule']);
  });
});
