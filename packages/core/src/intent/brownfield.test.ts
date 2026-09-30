import { describe, expect, it } from 'vitest';
import {
  BrownfieldCandidateFraming,
  BrownfieldPacketInvalidError,
  BrownfieldSourceClass,
  MAX_BROWNFIELD_PACKET_CANDIDATES,
  brownfieldProposeItems,
  parseBrownfieldPacket,
} from './brownfield.js';

const source = {
  kind: 'spec',
  ref: 'spec/returns',
  localId: 'BR-1',
  revision: 'abc123',
};

const proposal = {
  id: 'br-refund-window',
  domainId: 'returns',
  kind: 'business_rule',
  title: 'Refund window',
  statement: 'Refunds are allowed within thirty days.',
  payload: {
    condition: 'A refund is requested within thirty days',
    requiredOutcome: 'The refund may proceed',
    observer: 'Support operator',
  },
  sources: [source],
};

const packet = (overrides: Record<string, unknown> = {}) => ({
  domain: 'returns',
  riskTheme: 'money and refund eligibility',
  sources: [
    {
      id: 'approved-refund-spec',
      class: BrownfieldSourceClass.ExplicitDecision,
      owner: 'Returns product owner',
      source,
    },
  ],
  conflicts: [],
  candidates: [
    {
      framing: BrownfieldCandidateFraming.ProductCandidate,
      sourceIds: ['approved-refund-spec'],
      proposal,
    },
  ],
  ...overrides,
});

describe('parseBrownfieldPacket', () => {
  it('returns a bounded, classified packet whose proposals stay proposals', () => {
    const parsed = parseBrownfieldPacket(packet());

    expect(parsed.domain).toBe('returns');
    expect(parsed.riskTheme).toBe('money and refund eligibility');
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.proposal).not.toHaveProperty('authority');
    expect(parsed.candidates[0]?.proposal.sources).toEqual([source]);
  });

  it('accepts a proposal without a payload (D9) and carries the propose contract fields through', () => {
    const parsed = parseBrownfieldPacket(
      packet({
        candidates: [
          {
            framing: BrownfieldCandidateFraming.ProductCandidate,
            sourceIds: ['approved-refund-spec'],
            proposal: {
              domainId: 'returns',
              kind: 'limitation',
              title: 'No partial refunds',
              statement: 'A refund is all or nothing.',
              rationale: 'The ledger has no partial-reversal entry.',
              proposedSuccessorOfId: 'lim-refund-legacy',
              sources: [source],
              anchorSuggestions: [{ repoKey: 'billing', nodeId: 'abc:function:src/refund.ts:refund' }],
            },
          },
        ],
      }),
    );

    const [item] = parsed.candidates;
    expect(item?.proposal).not.toHaveProperty('payload');
    expect(item?.proposal.id).toBeUndefined();
    expect(item?.proposal.rationale).toBe('The ledger has no partial-reversal entry.');
    expect(item?.proposal.proposedSuccessorOfId).toBe('lim-refund-legacy');
    expect(item?.proposal.anchorSuggestions).toHaveLength(1);
  });

  it('carries proposal appliesWhen through to propose and still validates it', () => {
    const appliesWhen = [{ dimension: 'country', in: ['br'] }, { item: 'br-refund-window' }];
    const parsed = parseBrownfieldPacket(
      packet({
        candidates: [
          {
            framing: BrownfieldCandidateFraming.ProductCandidate,
            sourceIds: ['approved-refund-spec'],
            proposal: { ...proposal, appliesWhen },
          },
        ],
      }),
    );
    expect(brownfieldProposeItems(parsed)[0]?.appliesWhen).toEqual(appliesWhen);
    expect(() =>
      parseBrownfieldPacket(
        packet({
          candidates: [
            {
              framing: BrownfieldCandidateFraming.ProductCandidate,
              sourceIds: ['approved-refund-spec'],
              proposal: { ...proposal, appliesWhen: [{ dimension: 'Country', in: ['br'] }] },
            },
          ],
        }),
      ),
    ).toThrow(BrownfieldPacketInvalidError);
  });

  it('refuses an unknown key anywhere in the packet', () => {
    expect(() => parseBrownfieldPacket(packet({ notes: 'transcript of the session' }))).toThrow(
      BrownfieldPacketInvalidError,
    );
    expect(() =>
      parseBrownfieldPacket(
        packet({
          candidates: [
            {
              framing: BrownfieldCandidateFraming.ProductCandidate,
              sourceIds: ['approved-refund-spec'],
              proposal: { ...proposal, authority: 'accepted' },
            },
          ],
        }),
      ),
    ).toThrow(/candidates.0.proposal/);
  });

  it('refuses more than ten candidates before any propose call', () => {
    const candidate = packet().candidates[0];
    expect(() =>
      parseBrownfieldPacket(
        packet({ candidates: Array.from({ length: MAX_BROWNFIELD_PACKET_CANDIDATES + 1 }, () => candidate) }),
      ),
    ).toThrow(BrownfieldPacketInvalidError);
  });

  it('refuses class C implementation evidence framed as product authority', () => {
    expect(() =>
      parseBrownfieldPacket(
        packet({
          sources: [
            {
              id: 'current-code',
              class: BrownfieldSourceClass.ObservedImplementation,
              owner: 'Returns engineering',
              source,
            },
          ],
          candidates: [
            {
              framing: BrownfieldCandidateFraming.ProductCandidate,
              sourceIds: ['current-code'],
              proposal,
            },
          ],
        }),
      ),
    ).toThrow(/class C\/D evidence as a product candidate/);
  });

  it('keeps class D evidence inside an explicit conflict question with a named owner', () => {
    const staleSource = { ...source, ref: 'wiki/refunds', localId: 'old-rule' };
    const withConflict = (conflicts: unknown[]) =>
      packet({
        sources: [
          {
            id: 'stale-wiki',
            class: BrownfieldSourceClass.StaleOrUnknown,
            owner: 'Unknown; triage by returns owner',
            source: staleSource,
          },
          {
            id: 'approved-refund-spec',
            class: BrownfieldSourceClass.ExplicitDecision,
            owner: 'Returns product owner',
            source,
          },
        ],
        conflicts,
        candidates: [
          {
            framing: BrownfieldCandidateFraming.Question,
            sourceIds: ['stale-wiki'],
            proposal: { ...proposal, id: 'br-stale-refund-window', sources: [staleSource] },
          },
        ],
      });

    const observed = parseBrownfieldPacket(
      withConflict([
        {
          sourceIds: ['stale-wiki', 'approved-refund-spec'],
          question: 'Which refund window is current?',
          decisionOwner: 'Returns product owner',
        },
      ]),
    );
    expect(observed.conflicts).toHaveLength(1);
    expect(observed.candidates[0]?.framing).toBe(BrownfieldCandidateFraming.Question);

    expect(() => parseBrownfieldPacket(withConflict([]))).toThrow(/must stay in an explicit conflict\/debt question/);
  });

  it('refuses a conflict entry without a named decision owner', () => {
    expect(() =>
      parseBrownfieldPacket(
        packet({
          conflicts: [{ sourceIds: ['approved-refund-spec', 'approved-refund-spec'], question: 'Which one?' }],
        }),
      ),
    ).toThrow(/conflicts.0.decisionOwner/);
  });

  it('refuses a conflict or candidate that references an unclassified source', () => {
    expect(() =>
      parseBrownfieldPacket(
        packet({
          conflicts: [{ sourceIds: ['approved-refund-spec', 'ghost'], question: 'Which one?', decisionOwner: 'Owner' }],
        }),
      ),
    ).toThrow(/references unknown source "ghost"/);

    expect(() =>
      parseBrownfieldPacket(
        packet({
          candidates: [{ framing: BrownfieldCandidateFraming.Question, sourceIds: ['ghost'], proposal }],
        }),
      ),
    ).toThrow(/references unknown source "ghost"/);
  });

  it('refuses unclassified or mismatched proposal provenance', () => {
    expect(() =>
      parseBrownfieldPacket(
        packet({
          candidates: [
            {
              framing: BrownfieldCandidateFraming.ProductCandidate,
              sourceIds: ['approved-refund-spec'],
              proposal: { ...proposal, sources: [{ ...source, localId: 'BR-2' }] },
            },
          ],
        }),
      ),
    ).toThrow(/must exactly match its classified sourceIds/);
  });

  it('refuses a candidate outside the packet domain', () => {
    expect(() =>
      parseBrownfieldPacket(
        packet({
          candidates: [
            {
              framing: BrownfieldCandidateFraming.ProductCandidate,
              sourceIds: ['approved-refund-spec'],
              proposal: { ...proposal, domainId: 'payments' },
            },
          ],
        }),
      ),
    ).toThrow(/must be the packet domain "returns"/);
  });

  describe('a packet feature', () => {
    const inFeature = (featureId: string | undefined, feature: string | undefined) =>
      packet({
        ...(feature !== undefined ? { feature } : {}),
        candidates: [
          {
            framing: BrownfieldCandidateFraming.ProductCandidate,
            sourceIds: ['approved-refund-spec'],
            proposal: { ...proposal, ...(featureId !== undefined ? { featureId } : {}) },
          },
        ],
      });

    it('lands every proposal in the named feature, keeping the domain as the check', () => {
      const parsed = parseBrownfieldPacket(inFeature('refund-window', 'refund-window'));
      expect(parsed.feature).toBe('refund-window');
      expect(brownfieldProposeItems(parsed)[0]).toMatchObject({ domainId: 'returns', featureId: 'refund-window' });
    });

    it('refuses a proposal whose feature differs from the packet feature', () => {
      expect(() => parseBrownfieldPacket(inFeature('chargebacks', 'refund-window'))).toThrow(
        /must be the packet feature "refund-window"/,
      );
      expect(() => parseBrownfieldPacket(inFeature(undefined, 'refund-window'))).toThrow(
        /must be the packet feature "refund-window"/,
      );
    });

    it('refuses a proposal feature when the packet names none', () => {
      expect(() => parseBrownfieldPacket(inFeature('refund-window', undefined))).toThrow(/needs a packet feature/);
    });

    it('leaves a packet without a feature exactly as before', () => {
      const parsed = parseBrownfieldPacket(packet());
      expect(parsed).not.toHaveProperty('feature');
      expect(brownfieldProposeItems(parsed)[0]).not.toHaveProperty('featureId');
    });
  });

  it('refuses a duplicate source id', () => {
    const classified = packet().sources[0];
    expect(() => parseBrownfieldPacket(packet({ sources: [classified, classified] }))).toThrow(
      /duplicate source id "approved-refund-spec"/,
    );
  });
});

describe('brownfieldProposeItems', () => {
  it('sends only the proposals — the classification wrapper never reaches propose', () => {
    const parsed = parseBrownfieldPacket(packet());
    const items = brownfieldProposeItems(parsed);

    expect(items).toEqual([proposal]);
    for (const item of items) {
      expect(item).not.toHaveProperty('framing');
      expect(item).not.toHaveProperty('sourceIds');
      expect(item).not.toHaveProperty('class');
      expect(item).not.toHaveProperty('riskTheme');
      expect(item).not.toHaveProperty('conflicts');
    }
  });

  it('preserves packet order so a propose result maps back onto the review cards', () => {
    const second = { ...proposal, id: 'br-refund-fee', title: 'Refund fee' };
    const parsed = parseBrownfieldPacket(
      packet({
        candidates: [
          { framing: BrownfieldCandidateFraming.ProductCandidate, sourceIds: ['approved-refund-spec'], proposal },
          {
            framing: BrownfieldCandidateFraming.ProductCandidate,
            sourceIds: ['approved-refund-spec'],
            proposal: second,
          },
        ],
      }),
    );

    expect(brownfieldProposeItems(parsed).map((item) => item.id)).toEqual(['br-refund-window', 'br-refund-fee']);
  });
});
