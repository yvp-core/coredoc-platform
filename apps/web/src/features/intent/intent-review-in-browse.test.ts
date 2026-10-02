import { describe, expect, it } from 'vitest';
import { intentDocumentProposals, intentPendingCounts } from './intent-panel-state.js';
import {
  EMPTY_PROVENANCE_FORM,
  INTENT_MANUAL_REVIEW_REF,
  manualProvenancePreset,
  planReviewBatch,
} from './intent-review-request.js';
import {
  IntentAuthority,
  IntentItemKind,
  IntentReviewAction,
  type IntentDocumentItem,
  type IntentNodeDocument,
} from './types.js';

const item = (id: string, extra: Partial<IntentDocumentItem> = {}): IntentDocumentItem => ({
  id,
  kind: IntentItemKind.BusinessRule,
  title: id,
  statement: id,
  body: [],
  authority: IntentAuthority.Accepted,
  version: 1,
  effectivity: 'effective',
  openQuestion: false,
  proposedSuccessorOfId: null,
  appliesWhen: [],
  pendingSuccessor: null,
  ...extra,
});

describe('intentPendingCounts', () => {
  it('sums features into their domain and keeps the product root apart', () => {
    expect(
      intentPendingCounts([
        { domainId: null, featureId: null, waiting: 2 },
        { domainId: 'billing', featureId: null, waiting: 1 },
        { domainId: 'billing', featureId: 'refunds', waiting: 3 },
      ]),
    ).toEqual({ root: 2, domains: { billing: 4 }, features: { refunds: 3 } });
  });
});

describe('intentDocumentProposals', () => {
  it('collects standalone candidates and riding replacements, and plans the replacement as a supersede', () => {
    const document: IntentNodeDocument = {
      node: { kind: 'feature', id: 'refunds', title: 'Refunds', domainId: 'billing' },
      sections: [
        {
          heading: 'Rules',
          blocks: [
            {
              type: 'item',
              style: 'bullet',
              item: item('br-window', {
                version: 4,
                pendingSuccessor: { id: 'br-window-v2', title: 'Window', statement: '30 days', version: 1 },
              }),
            },
            {
              type: 'item',
              style: 'bullet',
              item: item('br-chargeback', { authority: IntentAuthority.Candidate, version: 2 }),
            },
          ],
        },
      ],
      related: [],
      features: [],
      delivery: { effective: 1, planned: 0, unrecorded: 0 },
      truncated: false,
    };
    const proposals = intentDocumentProposals(document);
    expect(proposals.cards.map((card) => card.itemId)).toEqual(['br-window-v2', 'br-chargeback']);
    expect(proposals.predecessorVersions).toEqual({ 'br-window': 4 });

    const plan = planReviewBatch({ ...proposals, batchReason: 'ok' });
    expect(plan.skipped).toEqual([]);
    expect(plan.pending).toMatchObject([
      {
        itemId: 'br-window',
        expectedVersion: 4,
        action: IntentReviewAction.Supersede,
        replacementItemId: 'br-window-v2',
      },
      { itemId: 'br-chargeback', expectedVersion: 2, action: IntentReviewAction.Accept },
    ]);
  });
});

describe('manualProvenancePreset', () => {
  it('always references the cloud review, never a person, which the server refuses as content', () => {
    const preset = manualProvenancePreset(EMPTY_PROVENANCE_FORM, { today: '2026-10-02' });
    expect(preset).toMatchObject({ ref: INTENT_MANUAL_REVIEW_REF, localId: '2026-10-02' });
  });
});
