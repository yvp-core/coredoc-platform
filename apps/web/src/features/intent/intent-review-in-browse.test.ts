import { describe, expect, it } from 'vitest';
import { intentDocumentProposals, intentTreeCounts } from './intent-panel-state.js';
import {
  INTENT_MANUAL_REVIEW_REF,
  buildReviewRequest,
  issueReviewSource,
  manualReviewSource,
  planReviewBatch,
} from './intent-review-request.js';
import {
  IntentAuthority,
  IntentItemKind,
  IntentReviewAction,
  IntentSourceKind,
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

describe('intentTreeCounts', () => {
  it("takes the domain's subtree counts, each feature's own, and keeps the product root apart", () => {
    const node = { title: '', statement: '', archived: false, createdAt: '', updatedAt: '', itemCount: 4 };
    expect(
      intentTreeCounts(
        [
          {
            root: { itemCount: 2, pendingCount: 2 },
            domains: [
              {
                ...node,
                id: 'billing',
                pendingCount: 1,
                subtreeItemCount: 9,
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
    ).toEqual({
      root: { items: 2, pending: 2 },
      domains: { billing: { items: 9, pending: 5 } },
      features: { refunds: { items: 4, pending: 3 }, chargebacks: { items: 4, pending: 1 } },
    });
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

describe('review sources', () => {
  it('always references the cloud review, never a person, which the server refuses as content', () => {
    expect(manualReviewSource('2026-10-02')).toEqual({
      kind: IntentSourceKind.Manual,
      ref: INTENT_MANUAL_REVIEW_REF,
      localId: '2026-10-02',
    });
  });

  it('files a ticket-authorized pass under the issue key', () => {
    expect(issueReviewSource('  PROJ-12 ')).toEqual({
      kind: IntentSourceKind.Issue,
      ref: 'PROJ-12',
      localId: 'PROJ-12',
    });
  });
});

describe('buildReviewRequest', () => {
  const decision = { itemId: 'br-a', expectedVersion: 2, action: IntentReviewAction.Accept, reason: ' ok ' };

  it('puts the one authorizing source on the batch and trims each reason', () => {
    expect(buildReviewRequest(manualReviewSource('2026-10-02'), [decision], 'key-1')).toEqual({
      ok: true,
      request: {
        idempotencyKey: 'key-1',
        authorizingSource: { kind: IntentSourceKind.Manual, ref: INTENT_MANUAL_REVIEW_REF, localId: '2026-10-02' },
        decisions: [{ itemId: 'br-a', expectedVersion: 2, action: IntentReviewAction.Accept, reason: 'ok' }],
      },
    });
  });

  it('refuses an empty batch, a duplicate decision and a blank reason', () => {
    const source = manualReviewSource('2026-10-02');
    expect(buildReviewRequest(source, [], 'k')).toEqual({ ok: false, issues: ['There is no decision to submit.'] });
    expect(buildReviewRequest(source, [decision, { ...decision, reason: ' ' }], 'k')).toEqual({
      ok: false,
      issues: ["Two decisions on 'br-a' in one batch.", "The decision on 'br-a' needs a reason."],
    });
  });
});
