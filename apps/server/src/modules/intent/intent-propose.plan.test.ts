/**
 * Propose semantics, ported from core's `capture.test.ts` to the row adapter.
 *
 * Every expectation here is a rule the storage change must NOT have altered:
 * candidates only, accepted items untouchable, `(ref, localId)` dedupe, no
 * similarity matching, derived-then-immutable ids — plus the one widening the
 * plan adopted (an explicit id wins).
 */
import { IntentKind } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { ProposalOutcome, planProposal, sourceIdentity, type ExistingItemFacts } from './intent-propose.plan.js';

const PATH = ['items', '0'];

function proposal(overrides: Partial<Parameters<typeof planProposal>[0]> = {}) {
  return {
    kind: IntentKind.BusinessRule,
    title: 'Refund window is 30 days',
    sources: [{ ref: 'spec/refunds', localId: 'BR-1' }],
    ...overrides,
  };
}

function facts(id: string, authority: ExistingItemFacts['authority'], kind = IntentKind.BusinessRule) {
  return { id, kind, authority };
}

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentPublicException);
    return (error as IntentPublicException).publicError.code;
  }
  throw new Error('expected a refusal');
}

describe('planProposal — BR-1 candidates only, BR-16/17 ids', () => {
  it('creates a candidate with a derived kind-prefixed slug when the proposal has no id', () => {
    const plan = planProposal(proposal(), { byId: undefined, sourceMatches: [], takenIds: [] }, PATH);
    expect(plan).toEqual({
      outcome: ProposalOutcome.CreatedCandidate,
      itemId: 'br-refund-window-is-30-days',
      derivedId: true,
      preservedAcceptedItemIds: [],
    });
  });

  it('suffixes a derived id that collides with an existing item', () => {
    const plan = planProposal(
      proposal(),
      { byId: undefined, sourceMatches: [], takenIds: ['br-refund-window-is-30-days'] },
      PATH,
    );
    expect(plan.itemId).toBe('br-refund-window-is-30-days-2');
  });

  it('refuses a title whose derived id would drop words, pointing at that item s title', () => {
    const long = 'Orders beyond the available stock of the addressed warehouse are refused immediately';
    const path = ['items', '1'];
    try {
      planProposal(proposal({ title: long }), { byId: undefined, sourceMatches: [], takenIds: [] }, path);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      const publicError = (error as IntentPublicException).publicError;
      // The whole batch is refused: nothing is written under a stub id an
      // accepted item would then carry forever.
      expect(publicError.code).toBe(IntentErrorCode.IdWouldTruncate);
      expect(publicError.path).toEqual(['items', '1', 'title']);
      expect(publicError.message).toContain('br-orders-beyond-the-available-stock');
    }
  });

  it('creates a candidate under an explicit id that is not taken', () => {
    const plan = planProposal(
      proposal({ id: 'br-refund-window' }),
      { byId: undefined, sourceMatches: [], takenIds: [] },
      PATH,
    );
    expect(plan).toEqual({
      outcome: ProposalOutcome.CreatedCandidate,
      itemId: 'br-refund-window',
      derivedId: false,
      preservedAcceptedItemIds: [],
    });
  });

  it('refuses an explicit id whose prefix contradicts the kind (BR-16)', () => {
    expect(
      refusalCode(() =>
        planProposal(proposal({ id: 'uc-refund-window' }), { byId: undefined, sourceMatches: [], takenIds: [] }, PATH),
      ),
    ).toBe(IntentErrorCode.ItemIdKindMismatch);
  });
});

describe('planProposal — BR-6 dedupe by (ref, localId)', () => {
  it('updates the existing candidate for the same exact source identity', () => {
    const plan = planProposal(
      proposal(),
      {
        byId: undefined,
        sourceMatches: [facts('br-refund-window', IntentItemAuthority.candidate)],
        takenIds: ['br-refund-window'],
      },
      PATH,
    );
    expect(plan).toEqual({
      outcome: ProposalOutcome.UpdatedCandidate,
      itemId: 'br-refund-window',
      derivedId: false,
      preservedAcceptedItemIds: [],
    });
  });

  it('is stable when the same proposal is planned twice', () => {
    const context = {
      byId: undefined,
      sourceMatches: [facts('br-refund-window', IntentItemAuthority.candidate)],
      takenIds: ['br-refund-window'],
    };
    expect(planProposal(proposal(), context, PATH)).toEqual(planProposal(proposal(), context, PATH));
  });

  it('keeps a similar-but-not-identical source identity separate (BR-7 — no similarity matching)', () => {
    // The row layer only reports EXACT `(ref, localId)` matches, so a proposal
    // citing `BR-2` reaches the plan with no matches at all.
    const plan = planProposal(
      proposal({ sources: [{ ref: 'spec/refunds', localId: 'BR-2' }] }),
      { byId: undefined, sourceMatches: [], takenIds: ['br-refund-window-is-30-days'] },
      PATH,
    );
    expect(plan.outcome).toBe(ProposalOutcome.CreatedCandidate);
    expect(plan.itemId).toBe('br-refund-window-is-30-days-2');
  });

  it('refuses a proposal whose sources match two existing candidates', () => {
    expect(
      refusalCode(() =>
        planProposal(
          proposal(),
          {
            byId: undefined,
            sourceMatches: [
              facts('br-refund-window', IntentItemAuthority.candidate),
              facts('br-refund-days', IntentItemAuthority.candidate),
            ],
            takenIds: [],
          },
          PATH,
        ),
      ),
    ).toBe(IntentErrorCode.AmbiguousSourceIdentity);
  });

  it('refuses an explicit id that disagrees with the candidate its sources belong to', () => {
    expect(
      refusalCode(() =>
        planProposal(
          proposal({ id: 'br-refund-days' }),
          {
            byId: undefined,
            sourceMatches: [facts('br-refund-window', IntentItemAuthority.candidate)],
            takenIds: [],
          },
          PATH,
        ),
      ),
    ).toBe(IntentErrorCode.SourceIdentityConflict);
  });
});

describe('planProposal — BR-2 accepted items are untouchable', () => {
  it("proposes a separate candidate for an accepted item's source identity and reports the preserved id", () => {
    const plan = planProposal(
      proposal(),
      {
        byId: undefined,
        sourceMatches: [facts('br-refund-window', IntentItemAuthority.accepted)],
        takenIds: ['br-refund-window'],
      },
      PATH,
    );
    expect(plan.outcome).toBe(ProposalOutcome.CreatedCandidate);
    expect(plan.itemId).toBe('br-refund-window-is-30-days');
    expect(plan.preservedAcceptedItemIds).toEqual(['br-refund-window']);
  });

  it('re-proposing against an accepted source identity updates the SAME candidate proposal', () => {
    const plan = planProposal(
      proposal(),
      {
        byId: undefined,
        sourceMatches: [
          facts('br-refund-window', IntentItemAuthority.accepted),
          facts('br-refund-window-is-30-days', IntentItemAuthority.candidate),
        ],
        takenIds: ['br-refund-window', 'br-refund-window-is-30-days'],
      },
      PATH,
    );
    expect(plan.outcome).toBe(ProposalOutcome.UpdatedCandidate);
    expect(plan.itemId).toBe('br-refund-window-is-30-days');
    expect(plan.preservedAcceptedItemIds).toEqual(['br-refund-window']);
  });

  it('refuses an explicit id naming an accepted, rejected, or superseded item', () => {
    for (const authority of [
      IntentItemAuthority.accepted,
      IntentItemAuthority.rejected,
      IntentItemAuthority.superseded,
    ]) {
      expect(
        refusalCode(() =>
          planProposal(
            proposal({ id: 'br-refund-window' }),
            { byId: facts('br-refund-window', authority), sourceMatches: [], takenIds: [] },
            PATH,
          ),
        ),
      ).toBe(IntentErrorCode.ItemNotCandidate);
    }
  });
});

describe('planProposal — an item never changes kind', () => {
  it('refuses an explicit id whose stored item has another kind', () => {
    expect(
      refusalCode(() =>
        planProposal(
          proposal({ id: 'br-refund-window' }),
          {
            byId: facts('br-refund-window', IntentItemAuthority.candidate, IntentKind.Limitation),
            sourceMatches: [],
            takenIds: [],
          },
          PATH,
        ),
      ),
    ).toBe(IntentErrorCode.ItemKindImmutable);
  });

  it('refuses a source match whose stored item has another kind', () => {
    expect(
      refusalCode(() =>
        planProposal(
          proposal(),
          {
            byId: undefined,
            sourceMatches: [facts('lim-refund-window', IntentItemAuthority.candidate, IntentKind.Limitation)],
            takenIds: [],
          },
          PATH,
        ),
      ),
    ).toBe(IntentErrorCode.ItemKindImmutable);
  });
});

describe('sourceIdentity', () => {
  it('is (ref, localId) and deliberately excludes the source kind', () => {
    expect(sourceIdentity({ ref: 'spec/refunds', localId: 'BR-1' })).toBe(
      sourceIdentity({ ref: 'spec/refunds', localId: 'BR-1' }),
    );
    expect(sourceIdentity({ ref: 'spec/refunds', localId: 'BR-1' })).not.toBe(
      sourceIdentity({ ref: 'spec/refunds', localId: 'BR-2' }),
    );
  });
});
