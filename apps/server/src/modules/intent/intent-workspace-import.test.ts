import { describe, expect, it } from 'vitest';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { CLOUD_INTENT_WORKSPACE_FORMAT_VERSION, validateWorkspaceDocument } from './intent-workspace-import.js';

const SOURCE = { kind: 'issue', ref: 'tracker:SHOP-1', localId: 'SHOP-1', title: 'Refund window' };

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
    source: { ref: 'kb@main', revision: 'a'.repeat(64) },
    domains: [{ id: 'orders', title: 'Orders' }],
    features: [
      { id: 'refunds', domainId: 'orders', title: 'Refunds' },
      { id: 'checkout', domainId: 'orders', title: 'Checkout' },
    ],
    relations: [
      {
        from: { kind: 'feature', id: 'refunds' },
        to: { kind: 'feature', id: 'checkout' },
        why: 'A refund reverses a checkout',
      },
    ],
    items: [
      {
        id: 'br-refund-window',
        kind: 'business_rule',
        featureId: 'refunds',
        title: 'Refunds close after 30 days',
        statement: 'A refund is refused 30 days after delivery.',
        authority: 'accepted',
        sources: [SOURCE],
      },
      {
        id: 'dec-refund-partial',
        kind: 'decision',
        featureId: 'refunds',
        title: 'Partial refunds',
        statement: 'Open question: may an order be partly refunded?',
        payload: {
          question: 'May an order be partly refunded?',
          choiceStatus: 'open',
          rationale: 'Support asks for it; no rule exists.',
          alternatives: [],
          consequences: [],
        },
        authority: 'accepted',
        sources: [SOURCE],
      },
    ],
    releases: { baseline: { deliveredRef: 'kb-import', itemIds: ['br-refund-window'] } },
    ...overrides,
  };
}

function refusal(raw: Record<string, unknown>) {
  try {
    validateWorkspaceDocument(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(IntentPublicException);
    return (error as IntentPublicException).publicError;
  }
  throw new Error('expected a refusal');
}

describe('validateWorkspaceDocument', () => {
  it('accepts a complete document', () => {
    expect(validateWorkspaceDocument(document()).items).toHaveLength(2);
  });

  it('refuses an item on an undeclared feature, naming its path in the document', () => {
    const items = [{ ...(document().items as object[])[0], featureId: 'returns' }];
    const error = refusal(document({ items, releases: undefined }));
    expect(error.code).toBe(IntentErrorCode.FeatureNotFound);
    expect(error.path).toEqual(['document', 'items', '0', 'featureId']);
  });

  it('refuses an id whose prefix does not match its kind', () => {
    const items = [{ ...(document().items as object[])[0], id: 'lim-refund-window' }];
    const error = refusal(document({ items, releases: undefined }));
    expect(error.path).toEqual(['document', 'items', '0', 'id']);
  });

  it('refuses a relation to an undeclared node and a self-relation', () => {
    const error = refusal(
      document({
        relations: [
          { from: { kind: 'feature', id: 'refunds' }, to: { kind: 'domain', id: 'billing' }, why: 'x' },
          { from: { kind: 'feature', id: 'refunds' }, to: { kind: 'feature', id: 'refunds' }, why: 'x' },
        ],
      }),
    );
    expect(error.details?.map((detail) => detail.code)).toEqual([
      IntentErrorCode.DomainNotFound,
      IntentErrorCode.NodeRelationSelf,
    ]);
  });

  it('refuses a superseded item whose successor does not name it', () => {
    const [rule] = document().items as Record<string, unknown>[];
    const items = [
      { ...rule, authority: 'superseded', supersededById: 'br-refund-window-v2' },
      { ...rule, id: 'br-refund-window-v2', title: 'Refunds close after 14 days' },
    ];
    const error = refusal(document({ items, releases: undefined }));
    expect(error.message).toContain('proposedSuccessorOfId');
  });

  it('accepts a superseded item still in production beside its planned successor', () => {
    const [rule] = document().items as Record<string, unknown>[];
    const items = [
      { ...rule, authority: 'superseded', supersededById: 'br-refund-window-v2' },
      {
        ...rule,
        id: 'br-refund-window-v2',
        title: 'Refunds close after 14 days',
        proposedSuccessorOfId: 'br-refund-window',
      },
    ];
    const releases = {
      baseline: { deliveredRef: 'kb-import', itemIds: ['br-refund-window'] },
      plans: [{ itemId: 'br-refund-window-v2' }],
    };
    expect(validateWorkspaceDocument(document({ items, releases })).items).toHaveLength(2);
  });

  it('refuses a plan for an item that is already in the baseline', () => {
    const error = refusal(
      document({
        releases: {
          baseline: { deliveredRef: 'kb-import', itemIds: ['br-refund-window'] },
          plans: [{ itemId: 'br-refund-window' }],
        },
      }),
    );
    expect(error.code).toBe(IntentErrorCode.PlanNotPlannable);
  });

  it('refuses a condition on a dimension the document does not declare', () => {
    const items = [{ ...(document().items as object[])[0], appliesWhen: [{ dimension: 'country', in: ['br'] }] }];
    const error = refusal(document({ items }));
    expect(error.code).toBe(IntentErrorCode.DimensionNotFound);
    expect(error.path.slice(0, 4)).toEqual(['document', 'items', '0', 'appliesWhen']);
  });

  it('refuses an open decision that carries a choice', () => {
    const items = document().items as Record<string, unknown>[];
    const open = items[1] as { payload: Record<string, unknown> };
    const error = refusal(document({ items: [items[0], { ...open, payload: { ...open.payload, choice: 'Yes' } }] }));
    expect(error.path).toEqual(['document', 'items', '1', 'payload', 'choice']);
  });

  it('refuses a layout slot for an item of another node, and one item placed twice', () => {
    const features = [
      {
        id: 'refunds',
        domainId: 'orders',
        title: 'Refunds',
        layout: [{ item: 'br-refund-window' }, { item: 'br-refund-window' }],
      },
      { id: 'checkout', domainId: 'orders', title: 'Checkout', layout: [{ item: 'dec-refund-partial' }] },
    ];
    const error = refusal(document({ features }));
    expect(error.details?.map((detail) => detail.path.join('.'))).toEqual([
      'document.features.0.layout.1.item',
      'document.features.1.layout.0.item',
    ]);
  });
});
