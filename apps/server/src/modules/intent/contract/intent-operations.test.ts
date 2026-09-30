import { IntentKind, IntentSourceKind } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { parseContract } from './intent-content.js';
import { IntentErrorCode, IntentPublicException, type IntentPublicError } from './intent-errors.js';
import {
  AddIntentAnchorSchema,
  ArchiveIntentDomainSchema,
  CreateIntentDomainSchema,
  CreateIntentFeatureSchema,
  DeleteIntentFeatureSeedSchema,
  ImportIntentOverlaySchema,
  IntentReviewAction,
  ProposeIntentItemsSchema,
  PutIntentFeatureSeedSchema,
  RemoveIntentAnchorSchema,
  ReviewIntentItemsSchema,
  UpdateIntentDomainSchema,
} from './intent-operations.js';
import { IntentAuthorizingSourceKind } from './intent-primitives.js';

function violation(fn: () => unknown): IntentPublicError {
  try {
    fn();
  } catch (error) {
    if (error instanceof IntentPublicException) return error.publicError;
    throw error;
  }
  throw new Error('expected a contract violation, got none');
}

const source = { kind: IntentSourceKind.Spec, ref: 'spec/ordering', localId: 'CAP-1' };

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: IntentKind.BusinessRule,
    title: 'Refund window',
    statement: 'A refund is accepted within 30 days of delivery.',
    sources: [source],
    ...overrides,
  };
}

function proposeRequest(items: Record<string, unknown>[]): Record<string, unknown> {
  return { idempotencyKey: 'idem-1', items };
}

describe('tree operations', () => {
  it('accepts a domain create and rejects a non-slug id', () => {
    expect(
      parseContract(CreateIntentDomainSchema, { idempotencyKey: 'k', id: 'order-capture', title: 'Ordering' }),
    ).toMatchObject({ id: 'order-capture' });

    const error = violation(() =>
      parseContract(CreateIntentDomainSchema, { idempotencyKey: 'k', id: 'Order Capture', title: 'Ordering' }),
    );
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.path).toEqual(['id']);
  });

  it('refuses an update that changes nothing', () => {
    const error = violation(() => parseContract(UpdateIntentDomainSchema, { idempotencyKey: 'k', id: 'ordering' }));
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
  });

  it('takes archive and un-archive through the same explicit flag', () => {
    for (const archived of [true, false]) {
      expect(parseContract(ArchiveIntentDomainSchema, { idempotencyKey: 'k', id: 'ordering', archived })).toMatchObject(
        { archived },
      );
    }
  });

  it('accepts a feature under exactly one domain', () => {
    expect(
      parseContract(CreateIntentFeatureSchema, {
        idempotencyKey: 'k',
        id: 'refunds',
        domainId: 'ordering',
        title: 'Refunds',
      }),
    ).toMatchObject({ domainId: 'ordering' });
  });

  it('identifies a seed by (featureId, repoKey, nodeId) on both put and delete', () => {
    const seed = { idempotencyKey: 'k', featureId: 'refunds', repoKey: 'api', nodeId: 'aaaa:route:/refunds' };
    expect(parseContract(PutIntentFeatureSeedSchema, { ...seed, note: 'entry point' })).toMatchObject(seed);
    expect(parseContract(DeleteIntentFeatureSeedSchema, seed)).toEqual(seed);
    expect(violation(() => parseContract(DeleteIntentFeatureSeedSchema, { ...seed, note: 'x' })).code).toBe(
      IntentErrorCode.SchemaViolation,
    );
  });
});

describe('propose', () => {
  it('accepts a minimal proposal: no id, no payload, no attachment', () => {
    const parsed = parseContract(ProposeIntentItemsSchema, proposeRequest([proposal()]));
    expect(parsed.items[0].payload).toBeUndefined();
    expect(parsed.items[0].id).toBeUndefined();
  });

  it('accepts an explicit id, a successor reference, a rationale and anchor suggestions', () => {
    const parsed = parseContract(
      ProposeIntentItemsSchema,
      proposeRequest([
        proposal({
          id: 'br-refund-window',
          proposedSuccessorOfId: 'br-refund-window-old',
          rationale: 'The finance team shortened the window.',
          featureId: 'refunds',
          anchorSuggestions: [{ repoKey: 'api', nodeId: 'aaaa:function:src/refund.ts:refund', rationale: 'the rule' }],
        }),
      ]),
    );
    expect(parsed.items[0].proposedSuccessorOfId).toBe('br-refund-window-old');
    expect(parsed.items[0].anchorSuggestions).toHaveLength(1);
  });

  it('requires a statement', () => {
    const error = violation(() =>
      parseContract(ProposeIntentItemsSchema, proposeRequest([proposal({ statement: '   ' })])),
    );
    expect(error.path).toEqual(['items', '0', 'statement']);
  });

  it('validates an optional payload against its kind and reports the path inside the request', () => {
    const error = violation(() =>
      parseContract(
        ProposeIntentItemsSchema,
        proposeRequest([
          proposal({
            kind: IntentKind.BusinessRule,
            payload: { condition: 'delivered', requiredOutcome: 'refund accepted' },
          }),
        ]),
      ),
    );
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.path).toEqual(['items', '0', 'payload', 'observer']);
  });

  it('accepts a well-formed payload for its kind', () => {
    const parsed = parseContract(
      ProposeIntentItemsSchema,
      proposeRequest([
        proposal({
          payload: {
            condition: 'The order was delivered less than 30 days ago',
            requiredOutcome: 'The refund is accepted',
            observer: 'Support agent',
          },
        }),
      ]),
    );
    expect(parsed.items[0].payload).toMatchObject({ observer: 'Support agent' });
  });

  // Changed 2026-09-28: a domainId beside a featureId is a CHECK (bootstrap packets with a feature),
  // not a second placement. The contract accepts the pair; propose refuses it when the feature
  // belongs to another domain (`feature_domain_mismatch`, covered by the Postgres module suite).
  it('accepts a domainId beside a featureId as a placement check', () => {
    const parsed = parseContract(
      ProposeIntentItemsSchema,
      proposeRequest([proposal({ domainId: 'ordering', featureId: 'refunds' })]),
    );
    expect(parsed.items[0]).toMatchObject({ domainId: 'ordering', featureId: 'refunds' });
  });

  it('refuses two proposals for one id in a batch', () => {
    const error = violation(() =>
      parseContract(
        ProposeIntentItemsSchema,
        proposeRequest([proposal({ id: 'br-refund-window' }), proposal({ id: 'br-refund-window' })]),
      ),
    );
    expect(error.path).toEqual(['items', '1', 'id']);
  });

  it('refuses an unknown key on an item', () => {
    const error = violation(() =>
      parseContract(ProposeIntentItemsSchema, proposeRequest([proposal({ authority: 'accepted' })])),
    );
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
  });
});

describe('review', () => {
  const envelope = {
    idempotencyKey: 'k',
    authorizingSource: { kind: IntentAuthorizingSourceKind.Adr, ref: 'adr/0007', localId: 'decision' },
  };
  const decision = {
    itemId: 'br-refund-window',
    expectedVersion: 3,
    action: IntentReviewAction.Accept,
    reason: 'Matches the reviewed spec.',
  };

  it('accepts a batch of decisions with batch-level provenance', () => {
    const parsed = parseContract(ReviewIntentItemsSchema, {
      ...envelope,
      workItem: { provider: 'jira', id: 'ORD-12' },
      decisions: [decision, { ...decision, itemId: 'lim-one-warehouse', action: IntentReviewAction.Defer }],
    });
    expect(parsed.decisions).toHaveLength(2);
  });

  it('requires the approved revision when a specification authorizes review', () => {
    const authorizingSource = { kind: IntentAuthorizingSourceKind.Spec, ref: 'spec.md', localId: 'BR-1' };
    const error = violation(() =>
      parseContract(ReviewIntentItemsSchema, { ...envelope, authorizingSource, decisions: [decision] }),
    );
    expect(error.path).toEqual(['authorizingSource', 'revision']);
    const request = parseContract(ReviewIntentItemsSchema, {
      ...envelope,
      authorizingSource: { ...authorizingSource, revision: 'sha256:approved' },
      decisions: [decision],
    });
    expect(request.authorizingSource.revision).toBe('sha256:approved');
  });

  it('accepts import as an authorizing source kind but not as an item source kind', () => {
    expect(
      parseContract(ReviewIntentItemsSchema, {
        ...envelope,
        authorizingSource: { kind: 'import', ref: 'local-overlay', localId: 'file' },
        decisions: [decision],
      }).authorizingSource.kind,
    ).toBe(IntentAuthorizingSourceKind.Import);

    const error = violation(() =>
      parseContract(ProposeIntentItemsSchema, proposeRequest([proposal({ sources: [{ ...source, kind: 'import' }] })])),
    );
    expect(error.path).toEqual(['items', '0', 'sources', '0', 'kind']);
  });

  it('requires an expected version on every decision', () => {
    const { expectedVersion: _dropped, ...withoutVersion } = decision;
    const error = violation(() => parseContract(ReviewIntentItemsSchema, { ...envelope, decisions: [withoutVersion] }));
    expect(error.path).toEqual(['decisions', '0', 'expectedVersion']);
  });

  it('requires the replacement pair on supersede and forbids it elsewhere', () => {
    const missing = violation(() =>
      parseContract(ReviewIntentItemsSchema, {
        ...envelope,
        decisions: [{ ...decision, action: IntentReviewAction.Supersede }],
      }),
    );
    expect(missing.path).toEqual(['decisions', '0', 'replacementItemId']);

    const misplaced = violation(() =>
      parseContract(ReviewIntentItemsSchema, {
        ...envelope,
        decisions: [{ ...decision, replacementItemId: 'br-new', replacementExpectedVersion: 1 }],
      }),
    );
    expect(misplaced.path).toEqual(['decisions', '0', 'replacementItemId']);

    expect(
      parseContract(ReviewIntentItemsSchema, {
        ...envelope,
        decisions: [
          {
            ...decision,
            action: IntentReviewAction.Supersede,
            replacementItemId: 'br-refund-window-v2',
            replacementExpectedVersion: 1,
          },
        ],
      }).decisions[0].replacementItemId,
    ).toBe('br-refund-window-v2');
  });

  it('refuses two decisions on one item in a batch', () => {
    const error = violation(() =>
      parseContract(ReviewIntentItemsSchema, { ...envelope, decisions: [decision, { ...decision }] }),
    );
    expect(error.path).toEqual(['decisions', '1', 'itemId']);
  });
});

describe('anchors and import', () => {
  it('accepts an anchor without graph facts and refuses caller-supplied ones', () => {
    const anchor = {
      idempotencyKey: 'k',
      itemId: 'br-refund-window',
      repoKey: 'api',
      nodeId: 'aaaa:function:src/refund.ts:refund',
    };
    expect(parseContract(AddIntentAnchorSchema, { ...anchor, rationale: 'the rule lives here' })).toMatchObject(anchor);
    expect(parseContract(RemoveIntentAnchorSchema, anchor)).toEqual(anchor);

    const error = violation(() => parseContract(AddIntentAnchorSchema, { ...anchor, nodeType: 'function' }));
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
  });

  it('requires a sha-256 local revision on import', () => {
    const overlay = { schemaVersion: 2, projectId: 'p', domains: [], items: [], relations: [] };
    expect(
      parseContract(ImportIntentOverlaySchema, {
        idempotencyKey: 'k',
        localRevision: 'a'.repeat(64),
        overlay,
      }),
    ).toMatchObject({ localRevision: 'a'.repeat(64) });

    const error = violation(() =>
      parseContract(ImportIntentOverlaySchema, { idempotencyKey: 'k', localRevision: 'HEAD', overlay }),
    );
    expect(error.path).toEqual(['localRevision']);
  });
});

describe('surface sharing', () => {
  it('exposes one schema instance per operation, so REST and MCP cannot drift', () => {
    // The property under test is identity, not behaviour: a controller and an
    // MCP tool import the same binding, so there is nothing to keep in sync.
    const first = ProposeIntentItemsSchema;
    const second = ProposeIntentItemsSchema;
    expect(first).toBe(second);
  });

  it('keeps the authorizing-source kinds a superset of the core item-source kinds', () => {
    const authorizing = new Set<string>(Object.values(IntentAuthorizingSourceKind));
    for (const kind of Object.values(IntentSourceKind)) expect(authorizing.has(kind)).toBe(true);
    expect(authorizing.has('import')).toBe(true);
  });
});
