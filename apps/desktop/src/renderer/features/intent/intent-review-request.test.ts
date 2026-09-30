import { describe, expect, it } from 'vitest';
import {
  INTENT_VERSION_CONFLICT_CODE,
  IntentAuthority,
  IntentItemKind,
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentItemSource,
  type IntentItemSummary,
  type IntentReviewDecisionResult,
} from '../../../shared/intent-types.js';
import {
  INTENT_MANUAL_REVIEW_REF,
  appliedItemIds,
  applyProvenanceSource,
  buildReviewRequest,
  cardVersionConflict,
  hasUnresolvedDecisions,
  isoDateOnly,
  manualProvenancePreset,
  reportedVersions,
  reviewResultsByCard,
  sharedProvenanceSource,
  versionConflictItemIds,
  draftsAfterResults,
  planReviewBatch,
  restampPredecessorVersion,
  stageDraft,
  stagedPredecessorVersion,
  unstageDraft,
  type IntentCardDraft,
  type IntentDraftDecision,
  type IntentProvenanceForm,
  type IntentStagedCard,
} from './intent-review-request';

const PROVENANCE: IntentProvenanceForm = {
  kind: IntentSourceKind.Spec,
  ref: 'spec/intent-cloud-design',
  localId: '§5',
  revision: 'sha256:approved',
  workItemProvider: '',
  workItemId: '',
  workItemDisplayKey: '',
  workItemUrl: '',
};

/** The untouched form, as the queue mounts it. */
const EMPTY: IntentProvenanceForm = { ...PROVENANCE, ref: '', localId: '' };

const ACCEPT: IntentDraftDecision = {
  itemId: 'br-refunds-window',
  expectedVersion: 3,
  action: IntentReviewAction.Accept,
  reason: 'Matches the shipped rule.',
};

describe('buildReviewRequest', () => {
  it('requires a specification revision but allows a manual decision without one', () => {
    const missing = buildReviewRequest({ ...PROVENANCE, revision: '' }, [ACCEPT], 'missing');
    expect(missing).toEqual({ ok: false, issues: [expect.stringMatching(/revision/i)] });
    expect(
      buildReviewRequest({ ...PROVENANCE, kind: IntentSourceKind.Manual, revision: '' }, [ACCEPT], 'manual').ok,
    ).toBe(true);
  });

  it('submits ONE provenance group for the batch, never one per decision (spec §4.7)', () => {
    const built = buildReviewRequest(
      PROVENANCE,
      [ACCEPT, { ...ACCEPT, itemId: 'lim-no-partial-refund', expectedVersion: 1 }],
      'idem-1',
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.authorizingSource).toEqual({
      kind: IntentSourceKind.Spec,
      ref: 'spec/intent-cloud-design',
      localId: '§5',
      revision: 'sha256:approved',
    });
    // The shape check that matters: provenance is a sibling of `decisions`, and
    // no decision carries an authorizingSource of its own.
    expect(built.request.decisions).toHaveLength(2);
    for (const decision of built.request.decisions) {
      expect(decision).not.toHaveProperty('authorizingSource');
      expect(decision).not.toHaveProperty('workItem');
    }
    expect(built.request.idempotencyKey).toBe('idem-1');
  });

  it('carries the version the reviewer actually read on every decision', () => {
    const built = buildReviewRequest(PROVENANCE, [ACCEPT], 'idem-2');

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.decisions[0]).toEqual({
      itemId: 'br-refunds-window',
      expectedVersion: 3,
      action: IntentReviewAction.Accept,
      reason: 'Matches the shipped rule.',
    });
  });

  it('carries BOTH versions on a supersede — predecessor and replacement (spec §5)', () => {
    const built = buildReviewRequest(
      PROVENANCE,
      [
        {
          itemId: 'br-refunds-window',
          expectedVersion: 4,
          action: IntentReviewAction.Supersede,
          reason: 'Replaced by the 60-day rule.',
          replacementItemId: 'br-refunds-window-v2',
          replacementExpectedVersion: 1,
        },
      ],
      'idem-3',
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.decisions[0]).toMatchObject({
      itemId: 'br-refunds-window',
      expectedVersion: 4,
      action: IntentReviewAction.Supersede,
      replacementItemId: 'br-refunds-window-v2',
      replacementExpectedVersion: 1,
    });
  });

  it('omits the optional work item entirely rather than sending an empty one', () => {
    const built = buildReviewRequest(PROVENANCE, [ACCEPT], 'idem-4');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.workItem).toBeUndefined();
  });

  it('includes the work item once provider and id are both given', () => {
    const built = buildReviewRequest(
      { ...PROVENANCE, workItemProvider: 'jira', workItemId: '10042', workItemDisplayKey: 'FRONT-123' },
      [ACCEPT],
      'idem-5',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.workItem).toEqual({ provider: 'jira', id: '10042', displayKey: 'FRONT-123' });
  });

  it('refuses a half-filled work item instead of sending a body that can only 400', () => {
    const built = buildReviewRequest({ ...PROVENANCE, workItemProvider: 'jira' }, [ACCEPT], 'idem-6');
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.join(' ')).toContain('provider and an id');
  });

  it('refuses an empty batch, a missing reason, and missing provenance', () => {
    expect(buildReviewRequest(PROVENANCE, [], 'k').ok).toBe(false);
    expect(buildReviewRequest(PROVENANCE, [{ ...ACCEPT, reason: '   ' }], 'k').ok).toBe(false);
    expect(buildReviewRequest({ ...PROVENANCE, ref: '' }, [ACCEPT], 'k').ok).toBe(false);
    expect(buildReviewRequest({ ...PROVENANCE, localId: '' }, [ACCEPT], 'k').ok).toBe(false);
  });

  it('names the CARD in a refusal, not the supersession subject id nobody sees on screen', () => {
    const built = buildReviewRequest(
      PROVENANCE,
      [{ ...ACCEPT, reason: '', label: "“Store team intent as relational rows” (replaces 'dec-old')" }],
      'k',
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.join(' ')).toContain('“Store team intent as relational rows”');
    expect(built.issues.join(' ')).not.toContain(`'${ACCEPT.itemId}'`);
  });

  it('refuses two decisions on one item, which the server also refuses batch-wide', () => {
    const built = buildReviewRequest(PROVENANCE, [ACCEPT, { ...ACCEPT, action: IntentReviewAction.Reject }], 'k');
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.join(' ')).toContain("Two decisions on 'br-refunds-window'");
  });
});

describe('per-decision review results', () => {
  const results: IntentReviewDecisionResult[] = [
    {
      decisionIndex: 0,
      itemId: 'br-refunds-window',
      action: IntentReviewAction.Accept,
      outcome: IntentReviewOutcome.Refused,
      authority: IntentAuthority.Candidate,
      // The CURRENT version, which is what a re-decide must start from.
      version: 7,
      error: { code: INTENT_VERSION_CONFLICT_CODE, message: 'changed since you read it', path: ['decisions', '0'] },
    },
    {
      decisionIndex: 1,
      itemId: 'lim-no-partial-refund',
      action: IntentReviewAction.Accept,
      outcome: IntentReviewOutcome.Accepted,
      authority: IntentAuthority.Accepted,
      version: 2,
    },
    {
      decisionIndex: 2,
      itemId: 'dec-drop-legacy-window',
      action: IntentReviewAction.Accept,
      outcome: IntentReviewOutcome.Refused,
      authority: IntentAuthority.Candidate,
      version: 1,
      error: { code: 'item_not_candidate', message: 'already decided', path: ['decisions', '2'] },
    },
  ];

  it('names exactly the stale-version refusals for the re-fetch flow', () => {
    // The other refusal is NOT in the list: re-fetching would not change its
    // answer, so it stays on screen with the server's own message.
    expect(versionConflictItemIds({ decisions: results })).toEqual(['br-refunds-window']);
  });

  it('reports the applied decisions, so one stale version does not roll back its siblings', () => {
    expect(appliedItemIds({ decisions: results })).toEqual(['lim-no-partial-refund']);
  });

  it('surfaces the versions the server reported back, for the re-decide', () => {
    expect(reportedVersions({ decisions: results }).get('br-refunds-window')).toBe(7);
  });

  it('knows when the batch still needs the reviewer', () => {
    expect(hasUnresolvedDecisions(results)).toBe(true);
    expect(hasUnresolvedDecisions([results[1]])).toBe(false);
  });
});

describe('reviewResultsByCard', () => {
  const successor: IntentItemSummary = {
    id: 'br-refunds-window-v2',
    kind: IntentItemKind.BusinessRule,
    title: 'Refunds close after 60 days',
    authority: IntentAuthority.Candidate,
    version: 1,
    domainId: 'payments',
    featureId: 'refunds',
    proposedSuccessorOfId: 'br-refunds-window',
    supersededById: null,
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
  const plain: IntentItemSummary = { ...successor, id: 'lim-no-partial-refund', proposedSuccessorOfId: null };

  const supersededOnPredecessor: IntentReviewDecisionResult = {
    decisionIndex: 0,
    itemId: 'br-refunds-window',
    action: IntentReviewAction.Supersede,
    outcome: IntentReviewOutcome.Superseded,
    authority: IntentAuthority.Superseded,
    version: 4,
    replacement: { itemId: 'br-refunds-window-v2', authority: IntentAuthority.Accepted, version: 2 },
  };

  it('shows a supersede result on the SUCCESSOR card, whose id the row never carries', () => {
    // The defect this closes: the decision's subject is the predecessor, so a
    // lookup by the card's own id left the supersede card blank — including when
    // the server REFUSED it.
    const byCard = reviewResultsByCard([supersededOnPredecessor], [successor, plain]);

    expect(byCard.get('br-refunds-window-v2')).toBe(supersededOnPredecessor);
    expect(byCard.has('lim-no-partial-refund')).toBe(false);
  });

  it('accepts a row keyed on the replacement instead of the subject', () => {
    const keyedOnSuccessor: IntentReviewDecisionResult = { ...supersededOnPredecessor, itemId: 'br-refunds-window-v2' };
    expect(reviewResultsByCard([keyedOnSuccessor], [successor]).get('br-refunds-window-v2')).toBe(keyedOnSuccessor);
  });

  it('carries a REFUSED supersession to the card so its reason is visible', () => {
    const refused: IntentReviewDecisionResult = {
      ...supersededOnPredecessor,
      outcome: IntentReviewOutcome.Refused,
      error: { code: INTENT_VERSION_CONFLICT_CODE, message: 'predecessor changed', path: ['decisions', '0'] },
    };

    expect(reviewResultsByCard([refused], [successor]).get('br-refunds-window-v2')?.error?.code).toBe(
      INTENT_VERSION_CONFLICT_CODE,
    );
  });

  it('maps a plain decision by its own id and tolerates no results at all', () => {
    const accepted: IntentReviewDecisionResult = {
      decisionIndex: 0,
      itemId: 'lim-no-partial-refund',
      action: IntentReviewAction.Accept,
      outcome: IntentReviewOutcome.Accepted,
      authority: IntentAuthority.Accepted,
      version: 2,
    };

    expect(reviewResultsByCard([accepted], [plain, successor]).get('lim-no-partial-refund')).toBe(accepted);
    expect(reviewResultsByCard(null, [plain]).size).toBe(0);
  });
});

describe('manualProvenancePreset', () => {
  it('fills exactly kind, reference and local id — and nothing else', () => {
    const filled: IntentProvenanceForm = {
      ...PROVENANCE,
      revision: 'abc123',
      workItemProvider: 'jira',
      workItemId: 'PROJ-1',
    };
    const preset = manualProvenancePreset(filled, { reviewerHandle: 'alex', today: '2026-09-02' });

    expect(preset.kind).toBe(IntentSourceKind.Manual);
    expect(preset.ref).toBe('alex');
    expect(preset.localId).toBe('2026-09-02');
    // The preset asserts nothing about an artifact, so it touches no other field.
    const changed = (Object.keys(preset) as (keyof IntentProvenanceForm)[]).filter(
      (key) => preset[key] !== filled[key],
    );
    expect(changed.sort()).toEqual(['kind', 'localId', 'ref']);
  });

  it('falls back to the desktop review reference when there is no handle', () => {
    expect(manualProvenancePreset(PROVENANCE, { today: '2026-09-02' }).ref).toBe(INTENT_MANUAL_REVIEW_REF);
    expect(manualProvenancePreset(PROVENANCE, { reviewerHandle: '  ', today: '2026-09-02' }).ref).toBe(
      INTENT_MANUAL_REVIEW_REF,
    );
  });

  it('files the decision under a plain YYYY-MM-DD date', () => {
    expect(isoDateOnly(new Date('2026-09-02T18:30:00.000Z'))).toBe('2026-09-02');
  });
});

describe('sharedProvenanceSource', () => {
  const spec: IntentItemSource = {
    kind: IntentSourceKind.Spec,
    ref: 'spec/refunds',
    localId: '§4',
    revision: null,
    locator: null,
    title: null,
    url: null,
  };
  const other: IntentItemSource = { ...spec, localId: '§9' };
  it('does not prefill different revisions as one approval source', () => {
    expect(sharedProvenanceSource([[spec], [{ ...spec, revision: 'new' }]]).state).toBe('mixed');
  });
  it('prefills the source revision and preserves an explicitly edited revision', () => {
    const approved = { ...spec, revision: 'sha256:approved' };
    expect(applyProvenanceSource(EMPTY, {}, approved).revision).toBe(approved.revision);
    expect(applyProvenanceSource({ ...EMPTY, revision: 'edited' }, { revision: true }, approved).revision).toBe(
      'edited',
    );
  });

  it('prefills only when every staged candidate cites the SAME single source', () => {
    expect(sharedProvenanceSource([[spec], [{ ...spec }]])).toEqual({ state: 'single', source: spec });
  });

  it('refuses to pick a winner when they differ, and offers the first', () => {
    expect(sharedProvenanceSource([[spec], [other]])).toEqual({ state: 'mixed', first: spec });
    // A candidate citing two sources is not "one shared source" either.
    expect(sharedProvenanceSource([[spec, other]])).toEqual({ state: 'mixed', first: spec });
    // Neither is a staged candidate whose sources are unknown.
    expect(sharedProvenanceSource([[spec], []])).toEqual({ state: 'mixed', first: spec });
  });

  it('says nothing at all when no staged candidate names a source', () => {
    expect(sharedProvenanceSource([])).toEqual({ state: 'none' });
    expect(sharedProvenanceSource([[], []])).toEqual({ state: 'none' });
  });
});

describe('applyProvenanceSource', () => {
  const source: IntentItemSource = {
    kind: IntentSourceKind.Issue,
    ref: 'v1.1-01',
    localId: 'scope',
    revision: null,
    locator: null,
    title: null,
    url: null,
  };

  it('fills the empty form from the shared source', () => {
    const filled = applyProvenanceSource(EMPTY, {}, source);
    expect(filled.kind).toBe(IntentSourceKind.Issue);
    expect(filled.ref).toBe('v1.1-01');
    expect(filled.localId).toBe('scope');
  });

  it('never overwrites a field the reviewer has typed in — which is what makes it happen once', () => {
    const edited: IntentProvenanceForm = { ...EMPTY, ref: 'spec/mine' };
    const filled = applyProvenanceSource(edited, { ref: true }, source);

    expect(filled.ref).toBe('spec/mine');
    expect(filled.localId).toBe('scope');
    // Re-applying to its own output is a no-op: the derived value is stable.
    expect(applyProvenanceSource(filled, { ref: true }, source)).toEqual(filled);
  });
});

describe('cardVersionConflict', () => {
  const conflictResult: IntentReviewDecisionResult = {
    decisionIndex: 0,
    itemId: 'lim-no-partial-refund',
    action: IntentReviewAction.Accept,
    outcome: IntentReviewOutcome.Refused,
    authority: IntentAuthority.Candidate,
    version: 4,
    error: { code: INTENT_VERSION_CONFLICT_CODE, message: 'stale', path: ['decisions', '0'] },
  };

  it('is nothing at all for a card with no refusal and no staged predecessor', () => {
    expect(cardVersionConflict({ itemId: 'lim-no-partial-refund', itemVersion: 1, predecessorId: null })).toBeNull();
  });

  it('names the version the reviewer holds and the one the server reports', () => {
    expect(
      cardVersionConflict({
        itemId: 'lim-no-partial-refund',
        itemVersion: 1,
        predecessorId: null,
        result: conflictResult,
      }),
    ).toEqual({ subjectId: 'lim-no-partial-refund', expectedVersion: 1, serverVersion: 4 });
  });

  it('clears once the card has been re-fetched to the version the server reported', () => {
    // The refusal deliberately stays on screen; the BLOCK must not, or the
    // reviewer could never decide again (spec §5).
    expect(
      cardVersionConflict({
        itemId: 'lim-no-partial-refund',
        itemVersion: 4,
        predecessorId: null,
        result: conflictResult,
      }),
    ).toBeNull();
  });

  it('keeps blocking a card whose subject the server says is gone', () => {
    expect(
      cardVersionConflict({
        itemId: 'lim-no-partial-refund',
        itemVersion: 4,
        predecessorId: null,
        result: { ...conflictResult, version: null },
      })?.serverVersion,
    ).toBeNull();
  });

  it('reports a supersession against the PREDECESSOR, which is the id to re-fetch', () => {
    expect(
      cardVersionConflict({
        itemId: 'br-refunds-window-v2',
        itemVersion: 1,
        predecessorId: 'br-refunds-window',
        predecessorVersion: 3,
        result: { ...conflictResult, itemId: 'br-refunds-window', version: 9 },
      }),
    ).toEqual({ subjectId: 'br-refunds-window', expectedVersion: 3, serverVersion: 9 });
  });

  it('catches a predecessor that moved after the card was staged, before anything is sent', () => {
    expect(
      cardVersionConflict({
        itemId: 'br-refunds-window-v2',
        itemVersion: 1,
        predecessorId: 'br-refunds-window',
        predecessorVersion: 5,
        stagedPredecessorVersion: 3,
      }),
    ).toEqual({ subjectId: 'br-refunds-window', expectedVersion: 3, serverVersion: 5 });

    expect(
      cardVersionConflict({
        itemId: 'br-refunds-window-v2',
        itemVersion: 1,
        predecessorId: 'br-refunds-window',
        predecessorVersion: 3,
        stagedPredecessorVersion: 3,
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------- staged drafts and the batch --- */

const draft = (over: Partial<IntentCardDraft> = {}): IntentCardDraft => ({
  action: IntentReviewAction.Accept,
  reason: 'Reviewed against the spec.',
  ...over,
});

const card = (over: Partial<IntentStagedCard> = {}): IntentStagedCard => ({
  itemId: 'lim-no-partial-refund',
  itemVersion: 1,
  title: 'Partial refunds are not supported',
  proposedSuccessorOfId: null,
  draft: draft(),
  conflicted: false,
  ...over,
});

describe('stagedPredecessorVersion', () => {
  const versions = { 'br-refunds-window': 3 };

  it('freezes the predecessor version for an ACCEPT on a replacement — the one action that sends it', () => {
    expect(
      stagedPredecessorVersion({
        action: IntentReviewAction.Accept,
        predecessorId: 'br-refunds-window',
        predecessorVersions: versions,
      }),
    ).toBe(3);
  });

  it('freezes nothing for reject, defer or needs-edit on that same replacement', () => {
    // These say nothing about the predecessor, so a predecessor moving under
    // them is not a conflict and must never block them.
    for (const action of [IntentReviewAction.Reject, IntentReviewAction.Defer, IntentReviewAction.NeedsEdit]) {
      expect(
        stagedPredecessorVersion({ action, predecessorId: 'br-refunds-window', predecessorVersions: versions }),
      ).toBeUndefined();
    }
  });

  it('freezes nothing on a candidate that replaces nothing', () => {
    expect(
      stagedPredecessorVersion({
        action: IntentReviewAction.Accept,
        predecessorId: null,
        predecessorVersions: versions,
      }),
    ).toBeUndefined();
  });
});

describe('stageDraft / unstageDraft', () => {
  it('keeps the reason already typed when the action changes', () => {
    const staged = stageDraft({ 'i-1': draft({ reason: 'because' }) }, 'i-1', IntentReviewAction.Reject, undefined);
    expect(staged['i-1']).toEqual({ action: IntentReviewAction.Reject, reason: 'because' });
  });

  it('drops the frozen predecessor version when the action stops being an accept', () => {
    const staged = stageDraft({ 'i-1': draft({ predecessorVersion: 3 }) }, 'i-1', IntentReviewAction.Defer, undefined);
    expect(staged['i-1']).not.toHaveProperty('predecessorVersion');
  });

  it('clears a card completely — the way out of one that cannot be decided', () => {
    expect(unstageDraft({ 'i-1': draft(), 'i-2': draft() }, 'i-1')).toEqual({ 'i-2': draft() });
  });
});

describe('restampPredecessorVersion', () => {
  it('acknowledges the version now in hand, so a re-fetched card becomes decidable again', () => {
    const restamped = restampPredecessorVersion({ 'i-1': draft({ predecessorVersion: 3 }) }, 'i-1', 4);
    expect(restamped['i-1']?.predecessorVersion).toBe(4);
  });

  it('leaves a card that never froze a version alone', () => {
    const drafts = { 'i-1': draft() };
    expect(restampPredecessorVersion(drafts, 'i-1', 4)['i-1']).not.toHaveProperty('predecessorVersion');
  });
});

describe('draftsAfterResults', () => {
  const result = (itemId: string, outcome: IntentReviewOutcome): IntentReviewDecisionResult => ({
    decisionIndex: 0,
    itemId,
    action: IntentReviewAction.Accept,
    outcome,
    authority: IntentAuthority.Accepted,
    version: 2,
  });

  it('clears every decision the server confirmed, including defer and needs-edit', () => {
    // `defer` and `needs_edit` are wire actions: a draft kept after the server
    // recorded them is re-sent by the next submit as a second transition.
    const drafts = {
      'i-defer': draft({ action: IntentReviewAction.Defer }),
      'i-edit': draft({ action: IntentReviewAction.NeedsEdit }),
      'i-accept': draft(),
    };
    const kept = draftsAfterResults(
      drafts,
      new Map([
        ['i-defer', result('i-defer', IntentReviewOutcome.Deferred)],
        ['i-edit', result('i-edit', IntentReviewOutcome.NeedsEdit)],
        ['i-accept', result('i-accept', IntentReviewOutcome.Accepted)],
      ]),
    );

    expect(kept).toEqual({});
  });

  it('keeps a refused decision, because that card still needs the reviewer', () => {
    const drafts = { 'i-1': draft(), 'i-2': draft() };
    const kept = draftsAfterResults(drafts, new Map([['i-1', result('i-1', IntentReviewOutcome.Refused)]]));

    // The refused one stays; the one the batch never mentioned stays too.
    expect(Object.keys(kept).sort()).toEqual(['i-1', 'i-2']);
  });
});

describe('planReviewBatch', () => {
  it('EXCLUDES a conflicted card with its own reason and submits the rest', () => {
    const plan = planReviewBatch({
      cards: [
        card({ itemId: 'i-ok' }),
        card({ itemId: 'i-conflicted', title: 'Moved underneath me', conflicted: true }),
        card({ itemId: 'i-ok-2' }),
      ],
      predecessorVersions: {},
      batchReason: '',
    });

    expect(plan.pending.map((decision) => decision.itemId)).toEqual(['i-ok', 'i-ok-2']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toContain('Moved underneath me');
    expect(plan.skipped[0]).toContain('left out of this batch');
  });

  it('turns an accept on a replacement into a supersession carrying BOTH versions', () => {
    const plan = planReviewBatch({
      cards: [card({ itemId: 'br-v2', itemVersion: 1, proposedSuccessorOfId: 'br-v1' })],
      predecessorVersions: { 'br-v1': 3 },
      batchReason: '',
    });

    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]).toMatchObject({
      itemId: 'br-v1',
      expectedVersion: 3,
      action: IntentReviewAction.Supersede,
      replacementItemId: 'br-v2',
      replacementExpectedVersion: 1,
    });
    expect(plan.skipped).toEqual([]);
  });

  it('leaves out only the card whose predecessor version could not be read', () => {
    const plan = planReviewBatch({
      cards: [card({ itemId: 'br-v2', proposedSuccessorOfId: 'br-v1' }), card({ itemId: 'i-ok' })],
      predecessorVersions: {},
      batchReason: '',
    });

    expect(plan.pending.map((decision) => decision.itemId)).toEqual(['i-ok']);
    expect(plan.skipped[0]).toContain("Can't read the current version of 'br-v1'");
  });

  it('falls back to the batch reason for a card with none of its own', () => {
    const plan = planReviewBatch({
      cards: [card({ draft: draft({ reason: '   ' }) })],
      predecessorVersions: {},
      batchReason: 'One pass, one story.',
    });

    expect(plan.pending[0]?.reason).toBe('One pass, one story.');
  });
});
