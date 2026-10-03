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
  it("takes the domain's subtree count, each feature's own, and keeps the product root apart", () => {
    const node = { title: '', statement: '', archived: false, createdAt: '', updatedAt: '', itemCount: 0 };
    expect(
      intentPendingCounts(
        [
          {
            root: { itemCount: 2, pendingCount: 2 },
            domains: [
              {
                ...node,
                id: 'billing',
                pendingCount: 1,
                subtreeItemCount: 0,
                subtreePendingCount: 5,
                featuresTruncated: false,
                features: [{ ...node, id: 'refunds', domainId: 'billing', parentFeatureId: null, pendingCount: 3 }],
              },
            ],
            nextCursor: null,
          },
        ],
        [{ ...node, id: 'chargebacks', domainId: 'billing', parentFeatureId: null, pendingCount: 1 }],
      ),
    ).toEqual({ root: 2, domains: { billing: 5 }, features: { refunds: 3, chargebacks: 1 } });
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
