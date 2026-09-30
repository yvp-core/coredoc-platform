import { describe, expect, it } from 'vitest';
import { readValidIntentFixtureJson } from './__fixtures__/load.js';
import {
  CaptureOutcome,
  IntentCaptureError,
  IntentCaptureErrorCode,
  captureIntentItems,
  deriveIntentId,
} from './capture.js';
import { validateIntentFile } from './schema.js';
import { serializeIntentFile } from './storage.js';
import type { IntentFileV2, IntentItemProposal } from './types.js';
import { INTENT_ID_MAX_LENGTH, IntentAuthority, IntentKind, IntentSourceKind } from './types.js';

function fixture(): IntentFileV2 {
  const result = validateIntentFile(readValidIntentFixtureJson());
  if (!result.ok) throw new Error('fixture is not valid');
  return result.file;
}

/** Declares the domain the proposals use: an item may only name a declared one (BR-18). */
function emptyFile(): IntentFileV2 {
  return {
    schemaVersion: 2,
    projectId: 'sample-project',
    domains: [{ id: 'returns', title: 'Returns' }],
    items: [],
    relations: [],
  };
}

const proposal = (overrides: Partial<IntentItemProposal> = {}): IntentItemProposal =>
  ({
    id: 'cap-widget-returns',
    domain: 'returns',
    kind: IntentKind.Capability,
    title: 'Widget returns',
    statement: 'A store operator can return a widget within the return window.',
    payload: {
      outcome: 'A returned widget is credited back to the operator',
      beneficiary: 'Store operator',
      boundary: 'Returns inside the return window only',
    },
    sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-9' }],
    ...overrides,
  }) as IntentItemProposal;

describe('captureIntentItems — BR-1 candidates only', () => {
  it('appends a proposal as a candidate and returns a valid file', () => {
    const baseline = emptyFile();
    const { file, results } = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });

    expect(results[0]).toMatchObject({
      proposalIndex: 0,
      itemId: 'cap-widget-returns',
      outcome: CaptureOutcome.CreatedCandidate,
    });
    expect(file.items).toHaveLength(1);
    expect(file.items[0]?.authority).toBe(IntentAuthority.Candidate);
    expect(validateIntentFile(file).ok).toBe(true);
  });

  it('does not mutate the file it was given', () => {
    const baseline = emptyFile();
    const before = serializeIntentFile(baseline);
    captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    expect(serializeIntentFile(baseline)).toBe(before);
  });
});

describe('captureIntentItems — AC-4 / BR-6 idempotent re-capture', () => {
  it('updates the existing candidate in place for the same exact source identity', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });

    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [proposal({ id: 'cap-widget-returns-renamed', statement: 'A store operator can return a widget.' })],
    });

    expect(second.file.items).toHaveLength(1);
    expect(second.results[0]?.outcome).toBe(CaptureOutcome.UpdatedCandidate);
    expect(second.file.items[0]?.id).toBe('cap-widget-returns');
    expect(second.file.items[0]?.statement).toBe('A store operator can return a widget.');
  });

  it('is byte-stable when the same proposal is captured twice', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const second = captureIntentItems({ baseline: first.file, current: first.file, proposals: [proposal()] });
    expect(serializeIntentFile(second.file)).toBe(serializeIntentFile(first.file));
  });

  it('keeps two similar-but-not-identical source identities as separate candidates (BR-7)', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [
        proposal({
          id: 'cap-widget-return-window',
          title: 'Widget return',
          sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-10' }],
        }),
      ],
    });

    expect(second.results[0]?.outcome).toBe(CaptureOutcome.CreatedCandidate);
    expect(second.file.items.map((i) => i.id)).toEqual(['cap-widget-returns', 'cap-widget-return-window']);
  });

  it('refuses an ambiguous proposal whose sources match two existing candidates', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [
        proposal({
          id: 'cap-widget-return-window',
          sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-10' }],
        }),
      ],
    });

    expect(() =>
      captureIntentItems({
        baseline: second.file,
        current: second.file,
        proposals: [
          proposal({
            id: 'cap-widget-return-credit',
            sources: [
              { kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-9' },
              { kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-10' },
            ],
          }),
        ],
      }),
    ).toThrow(IntentCaptureError);
  });

  it('refuses a new proposal that reuses an existing item ID', () => {
    const file = fixture();
    try {
      captureIntentItems({ baseline: file, current: file, proposals: [proposal({ id: 'cap-widget-ordering' })] });
      throw new Error('expected a capture refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentCaptureError);
      expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.ItemIdCollision);
    }
  });
});

// AC-15 / BR-16 / BR-17 — derived slug ids and id immutability
describe('deriveIntentId — deterministic slug derivation', () => {
  it('derives a kind-prefixed slug from the title', () => {
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window is 30 days', [])).toBe('br-refund-window-is-30-days');
    expect(deriveIntentId(IntentKind.UseCase, 'Place a widget order', [])).toBe('uc-place-a-widget-order');
    expect(deriveIntentId(IntentKind.Decision, "Refuse over-stock orders — don't reconcile", [])).toBe(
      'dec-refuse-over-stock-orders-don-t-reconcile',
    );
  });

  it('resolves collisions with a deterministic numeric suffix', () => {
    const taken = ['br-refund-window'];
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken)).toBe('br-refund-window-2');
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', [...taken, 'br-refund-window-2'])).toBe(
      'br-refund-window-3',
    );
    // Same inputs, same output — a re-run of the same batch cannot drift.
    expect(deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken)).toBe(
      deriveIntentId(IntentKind.BusinessRule, 'Refund window', taken),
    );
  });

  it('refuses a title whose slug does not fit the id cap, naming the stub it would have written', () => {
    const long = 'Orders beyond the available stock of the addressed warehouse are refused immediately';
    try {
      deriveIntentId(IntentKind.BusinessRule, long, []);
      throw new Error('expected a derivation refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentCaptureError);
      // Ids are immutable, so a silently shortened id is carried forever — and
      // a dropped word can invert the rule ('are not' -> 'are').
      expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.IdWouldTruncate);
      expect((error as IntentCaptureError).message).toContain('br-orders-beyond-the-available-stock');
    }
  });

  it('still rebuilds a shorter base for the collision suffix of a title that does fit', () => {
    const fits = 'Orders beyond the available stock of the addressed warehouse';
    const derived = deriveIntentId(IntentKind.BusinessRule, fits, []);
    expect(derived).toBe('br-orders-beyond-the-available-stock-of-the-addressed-warehouse');
    expect(derived.length).toBeLessThanOrEqual(INTENT_ID_MAX_LENGTH);

    // The suffix must fit INSIDE the cap, so the base drops its last word here —
    // the one shortening that is legitimate, because the title itself derived.
    const suffixed = deriveIntentId(IntentKind.BusinessRule, fits, [derived]);
    expect(suffixed).toBe('br-orders-beyond-the-available-stock-of-the-addressed-2');
    expect(suffixed.length).toBeLessThanOrEqual(INTENT_ID_MAX_LENGTH);
  });

  it('lets an explicit proposal id carry a title too long to derive from', () => {
    const baseline = emptyFile();
    const { results } = captureIntentItems({
      baseline,
      current: baseline,
      proposals: [
        proposal({
          id: 'cap-long-title',
          title: 'Orders beyond the available stock of the addressed warehouse are refused immediately',
        }),
      ],
    });
    expect(results[0]?.itemId).toBe('cap-long-title');
  });

  it('refuses a title that carries no sluggable characters', () => {
    try {
      deriveIntentId(IntentKind.Capability, '—— ???', []);
      throw new Error('expected a derivation refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentCaptureError);
      expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.UnderivableItemId);
    }
  });
});

describe('captureIntentItems — AC-15 ids are derived and then immutable', () => {
  it('derives the id of a proposal that omits one and reports it as derived', () => {
    const baseline = emptyFile();
    const { id: _id, ...withoutId } = proposal() as { id?: string } & Record<string, unknown>;
    const { file, results } = captureIntentItems({
      baseline,
      current: baseline,
      proposals: [withoutId as IntentItemProposal],
    });

    expect(results[0]?.itemId).toBe('cap-widget-returns');
    expect(results[0]?.derivedId).toBe(true);
    expect(file.items[0]?.id).toBe('cap-widget-returns');
  });

  it('suffixes a derived id that collides with an existing item', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const { id: _id, ...withoutId } = proposal({
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-11' }],
    }) as { id?: string } & Record<string, unknown>;

    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [withoutId as IntentItemProposal],
    });

    expect(second.results[0]?.itemId).toBe('cap-widget-returns-2');
    expect(second.file.items.map((item) => item.id)).toEqual(['cap-widget-returns', 'cap-widget-returns-2']);
  });

  it('updates a matched source identity under the EXISTING id and reports the ignored one (BR-17)', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });

    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [proposal({ id: 'cap-widget-returns-renamed', statement: 'A store operator can return a widget.' })],
    });

    expect(second.file.items.map((item) => item.id)).toEqual(['cap-widget-returns']);
    expect(second.results[0]?.ignoredProposalId).toBe('cap-widget-returns-renamed');
    expect(second.results[0]?.outcome).toBe(CaptureOutcome.UpdatedCandidate);
  });

  it('reports no ignored id when the proposal repeats the item its own id', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [proposal({ statement: 'A store operator can return a widget.' })],
    });
    expect(second.results[0]?.ignoredProposalId).toBeUndefined();
  });

  it('refuses a supplied id that violates the kind prefix or the slug format (BR-16)', () => {
    const baseline = emptyFile();
    for (const id of ['CAP-9', 'br-widget-returns', 'cap widget returns', 'cap']) {
      try {
        captureIntentItems({ baseline, current: baseline, proposals: [proposal({ id })] });
        throw new Error(`expected a refusal for id '${id}'`);
      } catch (error) {
        expect(error).toBeInstanceOf(IntentCaptureError);
        expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.InvalidProposalId);
      }
    }
  });
});

describe('captureIntentItems — AC-4 / BR-2 accepted items are untouchable', () => {
  it('preserves an accepted item byte-for-byte and proposes a separate candidate for its source identity', () => {
    const file = fixture();
    const acceptedBefore = JSON.stringify(file.items.find((i) => i.id === 'cap-widget-ordering'));

    const { file: next, results } = captureIntentItems({
      baseline: file,
      current: file,
      proposals: [
        proposal({
          id: 'cap-widget-ordering-proposal',
          statement: 'The capability now also covers cross-warehouse orders.',
          sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' }],
        }),
      ],
    });

    const acceptedAfter = next.items.find((i) => i.id === 'cap-widget-ordering');
    expect(JSON.stringify(acceptedAfter)).toBe(acceptedBefore);
    expect(acceptedAfter?.authority).toBe(IntentAuthority.Accepted);

    const candidate = next.items.find((i) => i.id === 'cap-widget-ordering-proposal');
    expect(candidate?.authority).toBe(IntentAuthority.Candidate);
    expect(results[0]?.outcome).toBe(CaptureOutcome.CreatedCandidate);
    expect(results[0]?.preservedAcceptedItemIds).toEqual(['cap-widget-ordering']);
    expect(validateIntentFile(next).ok).toBe(true);
  });

  it('re-capturing against an accepted source identity updates the same candidate proposal', () => {
    const file = fixture();
    const sources = [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-ordering', localId: 'CAP-1' }];
    const first = captureIntentItems({
      baseline: file,
      current: file,
      proposals: [proposal({ id: 'cap-widget-ordering-proposal', sources })],
    });
    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [proposal({ id: 'cap-widget-ordering-proposal-2', sources, title: 'Widget ordering, extended' })],
    });

    expect(second.file.items.filter((i) => i.authority === IntentAuthority.Candidate)).toHaveLength(2);
    expect(second.results[0]?.outcome).toBe(CaptureOutcome.UpdatedCandidate);
    expect(second.file.items.find((i) => i.id === 'cap-widget-ordering-proposal')?.title).toBe(
      'Widget ordering, extended',
    );
  });

  it('refuses the whole capture when the file changed an accepted payload since capture start', () => {
    const baseline = fixture();
    const current = fixture();
    const tampered = current.items.find((i) => i.id === 'cap-widget-ordering');
    if (!tampered || tampered.kind !== IntentKind.Capability) throw new Error('fixture drift');
    tampered.payload = { ...tampered.payload, boundary: 'Any warehouse' };

    try {
      captureIntentItems({ baseline, current, proposals: [proposal()] });
      throw new Error('expected a capture refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentCaptureError);
      expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.AcceptedItemMutation);
      expect((error as IntentCaptureError).message).toContain('cap-widget-ordering');
    }
  });

  it('refuses the whole capture when an accepted item was demoted or dropped since capture start', () => {
    const baseline = fixture();
    const demoted = fixture();
    const item = demoted.items.find((i) => i.id === 'br-orders-never-exceed-stock');
    if (!item) throw new Error('fixture drift');
    item.authority = IntentAuthority.Candidate;
    expect(() => captureIntentItems({ baseline, current: demoted, proposals: [] })).toThrow(IntentCaptureError);

    const dropped = fixture();
    dropped.items = dropped.items.filter((i) => i.id !== 'br-orders-never-exceed-stock');
    expect(() => captureIntentItems({ baseline, current: dropped, proposals: [] })).toThrow(IntentCaptureError);
  });

  it('accepts a maintainer edit that only touches candidate items since capture start', () => {
    const baseline = fixture();
    const current = fixture();
    const candidate = current.items.find((i) => i.id === 'dec-refuse-over-stock-orders');
    if (!candidate) throw new Error('fixture drift');
    candidate.title = 'Refuse over-stock orders (reworded by a maintainer)';
    expect(() => captureIntentItems({ baseline, current, proposals: [] })).not.toThrow();
  });
});

describe('captureIntentItems — BR-6 identity is (ref, localId)', () => {
  it('updates the existing candidate when a re-capture reclassifies the source kind', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });

    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [
        proposal({
          id: 'cap-widget-returns-reclassified',
          sources: [{ kind: IntentSourceKind.Issue, ref: 'spec/widget-returns', localId: 'CAP-9' }],
        }),
      ],
    });

    expect(second.results[0]?.outcome).toBe(CaptureOutcome.UpdatedCandidate);
    expect(second.file.items).toHaveLength(1);
    expect(second.file.items[0]?.id).toBe('cap-widget-returns');
    expect(second.file.items[0]?.sources[0]?.kind).toBe(IntentSourceKind.Issue);
  });
});

// An update is a MERGE: a capture states what one batch of documents says about
// an intent, not a redefinition of the item. What the proposal omits survives,
// and the one field it still replaces is reported.
describe('captureIntentItems — an update preserves what the proposal omits (BR-6)', () => {
  const specSource = { kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-9' };
  const ticketSource = { kind: IntentSourceKind.Issue, ref: 'tracker/WID-9', localId: 'T-9' };

  const anchor = (nodeId: string) => ({
    repo: 'sample-repo',
    nodeId,
    nodeType: 'function' as never,
    capturedVersionedId: `${nodeId}@1111`,
    rationale: 'Entry point that performs the returns outcome',
  });

  /** A candidate citing both the spec and the ticket, as a first capture would write it. */
  function twoSourceCandidate() {
    const baseline = emptyFile();
    return captureIntentItems({
      baseline,
      current: baseline,
      proposals: [proposal({ sources: [specSource, ticketSource] })],
    }).file;
  }

  it('keeps the source identities a single-source proposal did not repeat', () => {
    const current = twoSourceCandidate();
    const second = captureIntentItems({
      baseline: current,
      current,
      proposals: [proposal({ sources: [specSource], statement: 'A store operator can return a widget.' })],
    });

    expect(second.file.items).toHaveLength(1);
    expect(second.file.items[0]?.sources).toEqual([specSource, ticketSource]);
    expect(second.results[0]?.retainedSourceCount).toBe(1);
    // The new statement still landed — preservation is per FIELD, not a refusal.
    expect(second.file.items[0]?.statement).toBe('A store operator can return a widget.');
  });

  it('does not append a duplicate when a later capture cites the identity the last one omitted', () => {
    const current = twoSourceCandidate();
    const narrowed = captureIntentItems({
      baseline: current,
      current,
      proposals: [proposal({ sources: [specSource] })],
    }).file;

    // The whole point of the union: the ticket identity is still on the item, so
    // a capture citing only the ticket matches it instead of creating the second
    // candidate for one intent that BR-6/BR-7 exist to prevent.
    const third = captureIntentItems({
      baseline: narrowed,
      current: narrowed,
      proposals: [proposal({ sources: [ticketSource] })],
    });

    expect(third.results[0]?.outcome).toBe(CaptureOutcome.UpdatedCandidate);
    expect(third.file.items).toHaveLength(1);
    expect(third.file.items[0]?.sources.map((source) => source.localId)).toEqual(['CAP-9', 'T-9']);
  });

  it('appends a source identity only the proposal cites, existing order first', () => {
    const baseline = emptyFile();
    const first = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] });
    const second = captureIntentItems({
      baseline: first.file,
      current: first.file,
      proposals: [proposal({ sources: [specSource, ticketSource] })],
    });

    expect(second.file.items[0]?.sources).toEqual([specSource, ticketSource]);
    expect(second.results[0]?.retainedSourceCount).toBeUndefined();
  });

  it('preserves code anchors when the proposal carries none', () => {
    const baseline = emptyFile();
    const created = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] }).file;
    // A maintainer anchors the candidate by hand, then the same spec is captured again.
    const anchored: IntentFileV2 = {
      ...created,
      items: created.items.map((item) => ({ ...item, codeAnchors: [anchor('aaaa:function:src/returns.ts:refund')] })),
    };

    const second = captureIntentItems({ baseline: anchored, current: anchored, proposals: [proposal()] });

    expect(second.file.items[0]?.codeAnchors).toEqual(anchored.items[0]?.codeAnchors);
    expect(second.results[0]?.droppedAnchorCount).toBeUndefined();
  });

  it('reports the anchors a proposal with its own anchor set displaced', () => {
    const baseline = emptyFile();
    const created = captureIntentItems({ baseline, current: baseline, proposals: [proposal()] }).file;
    const anchored: IntentFileV2 = {
      ...created,
      items: created.items.map((item) => ({
        ...item,
        codeAnchors: [anchor('aaaa:function:src/returns.ts:refund'), anchor('aaaa:function:src/returns.ts:credit')],
      })),
    };

    const second = captureIntentItems({
      baseline: anchored,
      current: anchored,
      proposals: [proposal({ codeAnchors: [anchor('aaaa:function:src/returns.ts:refund')] })],
    });

    expect(second.file.items[0]?.codeAnchors).toHaveLength(1);
    // Replacement is allowed — a proposal with anchors is stating the set — but
    // never silent: one touchpoint left the overlay.
    expect(second.results[0]?.droppedAnchorCount).toBe(1);
    expect(validateIntentFile(second.file).ok).toBe(true);
  });
});
