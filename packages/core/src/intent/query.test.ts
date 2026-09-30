import { describe, expect, it } from 'vitest';
import {
  INTENT_CONTEXT_LIMITS,
  INTENT_INDEX_LIMITS,
  IntentMatchReason,
  IntentQueryError,
  IntentQueryErrorCode,
  clampIntentLimit,
  listIntentIndex,
  selectIntentContext,
} from './query.js';
import {
  DecisionStatus,
  type IntentFileV2,
  type IntentItem,
  IntentAuthority,
  IntentKind,
  IntentRelationType,
  IntentSourceKind,
} from './types.js';
import { NodeType } from '../types/graph.js';

const DEFAULT_DOMAIN = 'ordering';

function capability(id: string, authority: IntentAuthority, overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id,
    domain: DEFAULT_DOMAIN,
    kind: IntentKind.Capability,
    title: `${id} title`,
    statement: `${id} statement`,
    authority,
    payload: { outcome: `${id} outcome`, beneficiary: 'Operator', boundary: 'Single warehouse' },
    sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget', localId: id }],
    ...overrides,
  } as IntentItem;
}

function file(
  items: IntentItem[],
  relations: IntentFileV2['relations'] = [],
  domains: IntentFileV2['domains'] = [
    { id: DEFAULT_DOMAIN, title: 'Ordering' },
    { id: 'stock', title: 'Stock' },
    { id: 'returns', title: 'Returns' },
  ],
): IntentFileV2 {
  return { schemaVersion: 2, projectId: 'sample-project', domains, items, relations };
}

const anchor = (nodeId: string) => ({
  repo: 'sample-repo',
  nodeId,
  nodeType: NodeType.Function as never,
  capturedVersionedId: `${nodeId}@1111`,
  rationale: 'touchpoint',
});

describe('clampIntentLimit', () => {
  it('defaults to the compact default and clamps into 1..20', () => {
    expect(clampIntentLimit(undefined)).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(INTENT_CONTEXT_LIMITS.default).toBeLessThanOrEqual(INTENT_CONTEXT_LIMITS.max);
    expect(clampIntentLimit(0)).toBe(INTENT_CONTEXT_LIMITS.min);
    expect(clampIntentLimit(-4)).toBe(INTENT_CONTEXT_LIMITS.min);
    expect(clampIntentLimit(999)).toBe(INTENT_CONTEXT_LIMITS.max);
    expect(clampIntentLimit(3.7)).toBe(3);
    expect(clampIntentLimit(Number.NaN)).toBe(INTENT_CONTEXT_LIMITS.default);
  });

  it('stretches an omitted limit to cover the exact ids, never past the max', () => {
    expect(clampIntentLimit(undefined, 6)).toBe(6);
    expect(clampIntentLimit(undefined, 2)).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(clampIntentLimit(undefined, INTENT_CONTEXT_LIMITS.max + 5)).toBe(INTENT_CONTEXT_LIMITS.max);
    // An explicit limit still wins over the ids that were named.
    expect(clampIntentLimit(2, 6)).toBe(2);
  });
});

// F1 — an exact-id read answers every id it was given
describe('exact intentIds and the default limit', () => {
  const overlay = file(Array.from({ length: 8 }, (_, index) => capability(`cap-${index}`, IntentAuthority.Accepted)));

  it('answers all six named ids without truncation when no limit was supplied', () => {
    const ids = ['cap-0', 'cap-1', 'cap-2', 'cap-3', 'cap-4', 'cap-5'];
    const result = selectIntentContext(overlay, { intentIds: ids });
    expect(result.matches.map((match) => match.item.id)).toEqual(ids);
    expect(result.truncated).toBe(false);
    expect(result.omittedCount).toBe(0);
    expect(result.limit).toBe(6);
  });

  it('leaves a discovery read on the compact default', () => {
    const result = selectIntentContext(overlay, {});
    expect(result.limit).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(result.truncated).toBe(true);
  });
});

// AC-8 / BR-13 — authority filtering
describe('authority filtering (BR-13)', () => {
  const overlay = file([
    capability('cap-a', IntentAuthority.Accepted),
    capability('cap-cand-a', IntentAuthority.Candidate),
    capability('cap-rej-a', IntentAuthority.Rejected),
    capability('cap-sup-a', IntentAuthority.Superseded),
  ]);

  it('returns accepted current items only by default', () => {
    const result = selectIntentContext(overlay, {});
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-a']);
  });

  it('includes candidates only on explicit opt-in', () => {
    const result = selectIntentContext(overlay, { includeCandidates: true });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-a', 'cap-cand-a']);
  });

  it('never surfaces rejected or superseded items through text or node matching', () => {
    const byText = selectIntentContext(overlay, { query: 'title', includeCandidates: true });
    expect(byText.matches.map((m) => m.item.id)).not.toContain('cap-rej-a');
    expect(byText.matches.map((m) => m.item.id)).not.toContain('cap-sup-a');

    const withAnchors = file([
      capability('cap-rej-b', IntentAuthority.Rejected, { codeAnchors: [anchor('h:function:a.ts:f')] }),
      capability('cap-sup-b', IntentAuthority.Superseded, { codeAnchors: [anchor('h:function:a.ts:f')] }),
    ]);
    const byNode = selectIntentContext(withAnchors, { nodeIds: ['h:function:a.ts:f'] });
    expect(byNode.matches).toEqual([]);
  });

  it('returns rejected and superseded items when fetched by exact ID', () => {
    const result = selectIntentContext(overlay, { intentIds: ['cap-rej-a', 'cap-sup-a'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-rej-a', 'cap-sup-a']);
    expect(result.matches.every((m) => m.matchReason === IntentMatchReason.ExactId)).toBe(true);
  });
});

describe('exact-ID precedence', () => {
  it('orders exact-ID matches before text and node matches', () => {
    const overlay = file([
      capability('cap-a', IntentAuthority.Accepted, { statement: 'shared token here' }),
      capability('cap-b', IntentAuthority.Accepted, { statement: 'shared token here' }),
      capability('cap-rej-a', IntentAuthority.Rejected, { statement: 'shared token here' }),
    ]);
    const result = selectIntentContext(overlay, { intentIds: ['cap-rej-a'], query: 'shared token' });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-rej-a', 'cap-a', 'cap-b']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.ExactId);
    expect(result.matches[1].matchReason).toBe(IntentMatchReason.Text);
  });

  it('preserves the requested order of exact IDs and reports unknown ones', () => {
    const overlay = file([
      capability('cap-a', IntentAuthority.Accepted),
      capability('cap-b', IntentAuthority.Accepted),
    ]);
    const result = selectIntentContext(overlay, { intentIds: ['cap-b', 'cap-b', 'cap-a', 'ghost'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-b', 'cap-a']);
    expect(result.unknownIntentIds).toEqual(['ghost']);
  });
});

describe('deterministic lexical matching', () => {
  const overlay = file([
    capability('cap-a', IntentAuthority.Accepted, {
      title: 'Widget ordering',
      statement: 'A store operator can order widgets.',
    }),
    {
      ...capability('dec-1', IntentAuthority.Accepted),
      kind: IntentKind.Decision,
      title: 'Refuse over-stock orders',
      statement: 'Orders beyond stock are refused.',
      payload: {
        question: 'How should over-stock be handled?',
        choice: 'Refuse at submission time',
        choiceStatus: DecisionStatus.Accepted,
        rationale: 'Keeps stock consistent',
        alternatives: ['Reconcile later'],
        consequences: ['Operators retry after restock'],
      },
    } as IntentItem,
  ]);

  it('matches case-insensitively across title, statement and payload text', () => {
    expect(selectIntentContext(overlay, { query: 'WIDGET' }).matches.map((m) => m.item.id)).toEqual(['cap-a']);
    expect(selectIntentContext(overlay, { query: 'reconcile' }).matches.map((m) => m.item.id)).toEqual(['dec-1']);
  });

  it('requires every query token to appear (AND) while the conjunction matches something', () => {
    expect(selectIntentContext(overlay, { query: 'widget ordering' }).matches.map((m) => m.item.id)).toEqual(['cap-a']);
    // `dec-1` holds `stock`, `cap-a` does not: the conjunction stays narrow and
    // the disjunctive fallback never runs for a query that already matched.
    expect(selectIntentContext(overlay, { query: 'stock orders' }).matches.map((m) => m.item.id)).toEqual(['dec-1']);
    expect(selectIntentContext(overlay, { query: 'widgts' }).matches).toEqual([]);
  });

  it('treats a blank query as no text selector', () => {
    const result = selectIntentContext(overlay, { query: '   ' });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-a', 'dec-1']);
  });

  it('is stable for repeated identical requests', () => {
    const first = selectIntentContext(overlay, { query: 'orders' });
    const second = selectIntentContext(overlay, { query: 'orders' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// The disjunctive fallback: conjunction first, disjunction only from an empty
// result, never mixed.
describe('zero-match multi-word fallback', () => {
  const payload = { outcome: 'tracked', beneficiary: 'Operator', boundary: 'One site' };
  const overlay = file([
    capability('cap-warehouse-stock', IntentAuthority.Accepted, {
      title: 'Warehouse stock levels',
      statement: 'Stock is tracked per warehouse.',
      payload,
    }),
    capability('cap-shortfall-alert', IntentAuthority.Accepted, {
      title: 'Shortfall alerts',
      statement: 'Operators are alerted on a shortfall.',
      payload,
    }),
    capability('cap-refund-window', IntentAuthority.Accepted, {
      title: 'Refund window',
      statement: 'Refunds are accepted for a fortnight.',
      payload,
    }),
    capability('cap-cand-stock-audit', IntentAuthority.Candidate, {
      title: 'Stock audit',
      statement: 'A periodic audit.',
      payload,
    }),
    capability('cap-stock-domain-shortfall', IntentAuthority.Accepted, {
      domain: 'stock',
      title: 'Shortfall ledger',
      statement: 'A ledger of every shortfall.',
      payload,
    }),
  ]);
  const QUERY = 'warehouse stock shortfall';

  it('returns disjunctive matches ranked by token-hit count when nothing matches all tokens', () => {
    const result = selectIntentContext(overlay, { query: QUERY });
    // `cap-warehouse-stock` hits two tokens, the shortfall items one; no item
    // hits all three, which is what licenses the fallback at all.
    expect(result.matches.map((m) => m.item.id)).toEqual([
      'cap-warehouse-stock',
      'cap-shortfall-alert',
      'cap-stock-domain-shortfall',
    ]);
    expect(result.matches.every((m) => m.matchReason === IntentMatchReason.Text)).toBe(true);
    expect(result.matches.map((m) => m.item.id)).not.toContain('cap-refund-window');
  });

  it('is stable across repeated identical requests', () => {
    expect(JSON.stringify(selectIntentContext(overlay, { query: QUERY }))).toBe(
      JSON.stringify(selectIntentContext(overlay, { query: QUERY })),
    );
  });

  it('leaves single-word queries untouched', () => {
    expect(selectIntentContext(overlay, { query: 'shortfall' }).matches.map((m) => m.item.id)).toEqual([
      'cap-shortfall-alert',
      'cap-stock-domain-shortfall',
    ]);
    expect(selectIntentContext(overlay, { query: 'nonexistenttoken' }).matches).toEqual([]);
  });

  it('honours the authority filter: a candidate only surfaces on opt-in, after accepted items', () => {
    expect(selectIntentContext(overlay, { query: QUERY }).matches.map((m) => m.item.id)).not.toContain(
      'cap-cand-stock-audit',
    );
    const withCandidates = selectIntentContext(overlay, { query: QUERY, includeCandidates: true });
    // Hit count is the primary key, so the two-hit item leads; the candidate
    // ties the accepted one-hit items on hits and falls behind them on
    // authority.
    expect(withCandidates.matches.map((m) => m.item.id)).toEqual([
      'cap-warehouse-stock',
      'cap-shortfall-alert',
      'cap-stock-domain-shortfall',
      'cap-cand-stock-audit',
    ]);
  });

  it('honours the domain filter', () => {
    const result = selectIntentContext(overlay, { query: QUERY, domain: 'stock' });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-stock-domain-shortfall']);
  });

  it('reports truncation metadata over the fallback result', () => {
    const result = selectIntentContext(overlay, { query: QUERY, limit: 1 });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-warehouse-stock']);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(2);
    expect(result.totalMatched).toBe(3);
  });

  it('never mixes the two semantics: exact IDs and a matching conjunction are unaffected', () => {
    const conjunctive = selectIntentContext(overlay, { query: 'warehouse stock' });
    expect(conjunctive.matches.map((m) => m.item.id)).toEqual(['cap-warehouse-stock']);

    const exact = selectIntentContext(overlay, { intentIds: ['cap-refund-window'], query: 'warehouse stock' });
    expect(exact.matches.map((m) => m.item.id)).toEqual(['cap-refund-window', 'cap-warehouse-stock']);
    expect(exact.matches[0].matchReason).toBe(IntentMatchReason.ExactId);
  });
});

// AC-16 / BR-20 — the domain filter
describe('domain filtering (BR-20)', () => {
  const overlay = file([
    capability('cap-order-form', IntentAuthority.Accepted, { statement: 'shared token here' }),
    capability('cap-stock-guard', IntentAuthority.Accepted, { domain: 'stock', statement: 'shared token here' }),
    capability('cap-stock-count', IntentAuthority.Candidate, { domain: 'stock', statement: 'shared token here' }),
    capability('cap-legacy-stock', IntentAuthority.Superseded, { domain: 'stock' }),
  ]);

  it('returns only the items of that domain', () => {
    expect(selectIntentContext(overlay, { domain: 'stock' }).matches.map((m) => m.item.id)).toEqual([
      'cap-stock-guard',
    ]);
    expect(selectIntentContext(overlay, { domain: DEFAULT_DOMAIN }).matches.map((m) => m.item.id)).toEqual([
      'cap-order-form',
    ]);
  });

  it('composes with a text query and with candidate opt-in', () => {
    const byQuery = selectIntentContext(overlay, { domain: 'stock', query: 'shared token' });
    expect(byQuery.matches.map((m) => m.item.id)).toEqual(['cap-stock-guard']);
    expect(byQuery.matches[0].matchReason).toBe(IntentMatchReason.Text);

    const withCandidates = selectIntentContext(overlay, { domain: 'stock', includeCandidates: true });
    expect(withCandidates.matches.map((m) => m.item.id)).toEqual(['cap-stock-guard', 'cap-stock-count']);
  });

  it('composes with node ids', () => {
    const anchored = file([
      capability('cap-order-form', IntentAuthority.Accepted, { codeAnchors: [anchor('h:function:src/a.ts:f')] }),
      capability('cap-stock-guard', IntentAuthority.Accepted, {
        domain: 'stock',
        codeAnchors: [anchor('h:function:src/a.ts:f')],
      }),
    ]);
    const result = selectIntentContext(anchored, { domain: 'stock', nodeIds: ['h:function:src/a.ts:f'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-stock-guard']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.NodeAnchor);
  });

  it('never filters exact intentIds — an exact routed lookup stays authoritative (BR-8)', () => {
    const result = selectIntentContext(overlay, { domain: 'stock', intentIds: ['cap-order-form', 'cap-legacy-stock'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-order-form', 'cap-legacy-stock']);
    expect(result.matches.every((m) => m.matchReason === IntentMatchReason.ExactId)).toBe(true);
  });

  it('returns an empty result for a declared domain nobody uses', () => {
    const result = selectIntentContext(overlay, { domain: 'returns' });
    expect(result.matches).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });

  it('errors on an undeclared domain, naming the declared ones — distinct from an empty result', () => {
    try {
      selectIntentContext(overlay, { domain: 'payments' });
      throw new Error('expected a query refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentQueryError);
      expect((error as IntentQueryError).code).toBe(IntentQueryErrorCode.UnknownDomain);
      expect((error as IntentQueryError).message).toContain('ordering');
      expect((error as IntentQueryError).message).toContain('stock');
    }
  });

  it('does not reorder by domain (LIM-13: ordering stays accepted-first then id)', () => {
    const mixed = file([
      capability('cap-z-order', IntentAuthority.Accepted),
      capability('cap-a-stock', IntentAuthority.Accepted, { domain: 'stock' }),
      capability('cap-b-order', IntentAuthority.Candidate),
    ]);
    expect(selectIntentContext(mixed, { includeCandidates: true }).matches.map((m) => m.item.id)).toEqual([
      'cap-a-stock',
      'cap-z-order',
      'cap-b-order',
    ]);
  });
});

describe('code-anchor node matching', () => {
  it('matches items whose anchors reference the requested node ids', () => {
    const overlay = file([
      capability('cap-a', IntentAuthority.Accepted, { codeAnchors: [anchor('h:function:src/a.ts:f')] }),
      capability('cap-b', IntentAuthority.Accepted, { codeAnchors: [anchor('h:function:src/b.ts:g')] }),
      capability('cap-c', IntentAuthority.Accepted),
    ]);
    const result = selectIntentContext(overlay, { nodeIds: ['h:function:src/b.ts:g'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-b']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.NodeAnchor);
  });

  it('does not match a node id by substring', () => {
    const overlay = file([
      capability('cap-a', IntentAuthority.Accepted, { codeAnchors: [anchor('h:function:src/a.ts:findUser')] }),
    ]);
    expect(selectIntentContext(overlay, { nodeIds: ['h:function:src/a.ts:find'] }).matches).toEqual([]);
  });
});

// A caller that computed its selector from a diff and matched nothing asked the
// NARROWEST possible question. Answering it with the whole default accepted set
// is the widest possible answer, labelled `default` as its only hint.
describe('a present-but-empty selector is a selector, not an absent one', () => {
  const overlay = file([capability('cap-a', IntentAuthority.Accepted), capability('cap-b', IntentAuthority.Accepted)]);

  it('returns nothing for an empty nodeIds array', () => {
    const result = selectIntentContext(overlay, { nodeIds: [] });
    expect(result.matches).toEqual([]);
    expect(result.totalMatched).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('returns nothing for an empty intentIds array', () => {
    const result = selectIntentContext(overlay, { intentIds: [] });
    expect(result.matches).toEqual([]);
    expect(result.unknownIntentIds).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });

  it('still returns the default accepted set when no selector is supplied at all', () => {
    const result = selectIntentContext(overlay, {});
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-a', 'cap-b']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.Default);
  });

  it('composes an empty array with a selector that does match', () => {
    const result = selectIntentContext(overlay, { nodeIds: [], intentIds: ['cap-b'] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-b']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.ExactId);
  });
});

describe('ordering and truncation metadata (AC-8)', () => {
  it('orders accepted before candidate, then by id, and truncates deterministically', () => {
    const overlay = file([
      capability('cap-z', IntentAuthority.Accepted),
      capability('cap-cand-a', IntentAuthority.Candidate),
      capability('cap-a', IntentAuthority.Accepted),
      capability('cap-cand-z', IntentAuthority.Candidate),
    ]);
    const all = selectIntentContext(overlay, { includeCandidates: true, limit: 20 });
    expect(all.matches.map((m) => m.item.id)).toEqual(['cap-a', 'cap-z', 'cap-cand-a', 'cap-cand-z']);
    expect(all.truncated).toBe(false);
    expect(all.omittedCount).toBe(0);

    const limited = selectIntentContext(overlay, { includeCandidates: true, limit: 2 });
    expect(limited.matches.map((m) => m.item.id)).toEqual(['cap-a', 'cap-z']);
    expect(limited.truncated).toBe(true);
    expect(limited.omittedCount).toBe(2);
    expect(limited.totalMatched).toBe(4);
    expect(limited.limit).toBe(2);
  });
});

describe('one-hop relations', () => {
  it('returns only relations touching a returned item', () => {
    const overlay = file(
      [
        capability('cap-a', IntentAuthority.Accepted),
        capability('cap-uc-1', IntentAuthority.Accepted),
        capability('cap-uc-2', IntentAuthority.Accepted),
      ],
      [
        { from: 'cap-a', type: IntentRelationType.Contains, to: 'cap-uc-1' },
        { from: 'cap-uc-2', type: IntentRelationType.DependsOn, to: 'cap-uc-1' },
      ],
    );
    const result = selectIntentContext(overlay, { intentIds: ['cap-a'] });
    expect(result.relations).toEqual([{ from: 'cap-a', type: IntentRelationType.Contains, to: 'cap-uc-1' }]);
  });
});

describe('one-hop relations are bounded', () => {
  it('caps the returned relations and reports the omission', () => {
    const attached = INTENT_CONTEXT_LIMITS.relations + 7;
    const items = [capability('cap-a', IntentAuthority.Accepted)];
    const relations: IntentFileV2['relations'] = [];
    for (let i = 0; i < attached; i++) {
      const id = `uc-${String(i).padStart(3, '0')}`;
      items.push(capability(id, IntentAuthority.Accepted));
      relations.push({ from: 'cap-a', type: IntentRelationType.Contains, to: id });
    }
    const overlay = file(items, relations);

    const result = selectIntentContext(overlay, { intentIds: ['cap-a'] });

    expect(result.relations).toHaveLength(INTENT_CONTEXT_LIMITS.relations);
    expect(result.relationsTruncated).toBe(true);
    expect(result.omittedRelationCount).toBe(attached - INTENT_CONTEXT_LIMITS.relations);
    // Deterministic: the same overlay yields the same relations every run.
    expect(selectIntentContext(overlay, { intentIds: ['cap-a'] }).relations).toEqual(result.relations);
  });

  it('reports no truncation when the relations fit', () => {
    const overlay = file(
      [capability('cap-a', IntentAuthority.Accepted), capability('cap-uc-1', IntentAuthority.Accepted)],
      [{ from: 'cap-a', type: IntentRelationType.Contains, to: 'cap-uc-1' }],
    );
    const result = selectIntentContext(overlay, { intentIds: ['cap-a'] });
    expect(result.relationsTruncated).toBe(false);
    expect(result.omittedRelationCount).toBe(0);
  });
});

describe('code-anchor enclosing-scope matching', () => {
  const HASH = '40080b8c38fc';
  const PATH = 'src/pricing/price-calculator.ts';
  const methodId = `${HASH}:method:${PATH}:PriceCalculator.priceLine`;

  it('matches a class-anchored item from a method query (the review flow)', () => {
    const overlay = file([
      capability('cap-br-1', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:class:${PATH}:PriceCalculator`)],
      }),
    ]);
    const result = selectIntentContext(overlay, { nodeIds: [methodId] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-br-1']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.NodeAnchor);
  });

  it('matches the full nested Python class owner from a method query', () => {
    const nestedMethodId = `${HASH}:method:${PATH}:Outer.Inner.priceLine`;
    const overlay = file([
      capability('cap-br-nested', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:class:${PATH}:Outer.Inner`)],
      }),
    ]);

    expect(selectIntentContext(overlay, { nodeIds: [nestedMethodId] }).matches.map((m) => m.item.id)).toEqual([
      'cap-br-nested',
    ]);
  });

  it('matches a file-anchored item from a method query', () => {
    const overlay = file([
      capability('cap-br-2', IntentAuthority.Accepted, { codeAnchors: [anchor(`${HASH}:file:${PATH}`)] }),
    ]);
    expect(selectIntentContext(overlay, { nodeIds: [methodId] }).matches.map((m) => m.item.id)).toEqual(['cap-br-2']);
  });

  it('matches a file-anchored item from a function query', () => {
    const overlay = file([
      capability('cap-br-3', IntentAuthority.Accepted, { codeAnchors: [anchor(`${HASH}:file:${PATH}`)] }),
    ]);
    const fnId = `${HASH}:function:${PATH}:computeTotal`;
    expect(selectIntentContext(overlay, { nodeIds: [fnId] }).matches.map((m) => m.item.id)).toEqual(['cap-br-3']);
  });

  it('still matches an exact method anchor', () => {
    const overlay = file([capability('cap-br-4', IntentAuthority.Accepted, { codeAnchors: [anchor(methodId)] })]);
    expect(selectIntentContext(overlay, { nodeIds: [methodId] }).matches.map((m) => m.item.id)).toEqual(['cap-br-4']);
  });

  it('does not leak across classes, files, or repos', () => {
    const overlay = file([
      capability('cap-other-class', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:class:${PATH}:TaxTable`)],
      }),
      capability('cap-other-file', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:file:src/pricing/tax-table.ts`)],
      }),
      capability('cap-other-repo', IntentAuthority.Accepted, { codeAnchors: [anchor(`ffffffffffff:file:${PATH}`)] }),
      capability('cap-sibling-method', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:method:${PATH}:PriceCalculator.priceOrder`)],
      }),
    ]);
    expect(selectIntentContext(overlay, { nodeIds: [methodId] }).matches).toEqual([]);
  });

  it('matches a member anchor from a bare file query (both directions)', () => {
    const overlay = file([capability('cap-br-5', IntentAuthority.Accepted, { codeAnchors: [anchor(methodId)] })]);
    const result = selectIntentContext(overlay, { nodeIds: [`${HASH}:file:${PATH}`] });
    expect(result.matches.map((m) => m.item.id)).toEqual(['cap-br-5']);
    expect(result.matches[0].matchReason).toBe(IntentMatchReason.NodeAnchor);
  });

  it('keeps a file query inside its own repo and its exact path', () => {
    const overlay = file([
      capability('cap-other-repo', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`ffffffffffff:function:${PATH}:computeTotal`)],
      }),
      capability('cap-path-prefix', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:function:${PATH}.bak:computeTotal`)],
      }),
      capability('cap-hashed-kind', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:entrypoint:${PATH}:1a2b3c4d`)],
      }),
      // The two ids a `hash:%:path:%` SQL pattern would admit — asserted here
      // AND in `apps/server/.../intent-context.select.test.ts`, because the
      // cloud read matches files by that pattern and re-checks the shape in TS.
      // A divergence between the two is a difference in what the same query
      // means locally and in the cloud.
      capability('cap-extra-segment', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:method:${PATH}:Guard:check`)],
      }),
      capability('cap-empty-name', IntentAuthority.Accepted, {
        codeAnchors: [anchor(`${HASH}:function:${PATH}:`)],
      }),
    ]);
    expect(selectIntentContext(overlay, { nodeIds: [`${HASH}:file:${PATH}`] }).matches).toEqual([]);
  });

  it('degrades to exact-only matching for unparseable node ids', () => {
    const overlay = file([
      capability('cap-br-6', IntentAuthority.Accepted, { codeAnchors: [anchor('not-an-id')] }),
      capability('cap-br-7', IntentAuthority.Accepted, { codeAnchors: [anchor(`${HASH}:file:${PATH}`)] }),
    ]);
    expect(() => selectIntentContext(overlay, { nodeIds: ['not-an-id', '', 'a:b'] })).not.toThrow();
    expect(selectIntentContext(overlay, { nodeIds: ['not-an-id', '', 'a:b'] }).matches.map((m) => m.item.id)).toEqual([
      'cap-br-6',
    ]);
  });

  it('derives no file candidate for hashed node kinds', () => {
    const overlay = file([
      capability('cap-ep-file', IntentAuthority.Accepted, { codeAnchors: [anchor(`${HASH}:file:http`)] }),
    ]);
    expect(selectIntentContext(overlay, { nodeIds: [`${HASH}:entrypoint:http:1a2b3c4d`] }).matches).toEqual([]);
  });
});

// =============================================================================
// listIntentIndex — the payload-free browse surface (BR-23..BR-27)
// =============================================================================

/** Index entries carry no payload, so the capability payload is irrelevant here. */
function indexed(
  id: string,
  kind: IntentKind,
  domain: string,
  authority: IntentAuthority = IntentAuthority.Accepted,
): IntentItem {
  return capability(id, authority, { kind, domain }) as IntentItem;
}

describe('listIntentIndex', () => {
  const overlay = file([
    indexed('cap-order', IntentKind.Capability, 'ordering'),
    indexed('br-stock', IntentKind.BusinessRule, 'stock'),
    indexed('dec-stock', IntentKind.Decision, 'stock', IntentAuthority.Candidate),
    indexed('cap-stock', IntentKind.Capability, 'stock'),
    indexed('cap-old', IntentKind.Capability, 'ordering', IntentAuthority.Superseded),
    indexed('cap-dropped', IntentKind.Capability, 'ordering', IntentAuthority.Rejected),
  ]);

  it('always returns the full declared registry, in registry order (BR-23)', () => {
    const result = listIntentIndex(overlay, { domain: 'stock' });
    expect(result.domains).toEqual([
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock' },
      { id: 'returns', title: 'Returns' },
    ]);
  });

  it('returns payload-free entries only (BR-23)', () => {
    const [entry] = listIntentIndex(overlay, { domain: 'ordering' }).entries;
    expect(entry).toEqual({
      id: 'cap-order',
      title: 'cap-order title',
      kind: IntentKind.Capability,
      domain: 'ordering',
      authority: IntentAuthority.Accepted,
    });
  });

  it('composes domain and kind conjunctively (BR-24)', () => {
    expect(listIntentIndex(overlay, { domain: 'stock' }).entries.map((e) => e.id)).toEqual(['cap-stock', 'br-stock']);
    expect(listIntentIndex(overlay, { kind: IntentKind.Capability }).entries.map((e) => e.id)).toEqual([
      'cap-order',
      'cap-stock',
    ]);
    expect(listIntentIndex(overlay, { domain: 'stock', kind: IntentKind.Capability }).entries.map((e) => e.id)).toEqual(
      ['cap-stock'],
    );
  });

  it('answers an empty index for a declared domain that holds nothing (BR-24)', () => {
    const result = listIntentIndex(overlay, { domain: 'returns' });
    expect(result.entries).toEqual([]);
    expect(result.totalMatched).toBe(0);
    expect(result.domains).toHaveLength(3);
  });

  it('rejects an undeclared domain naming the declared ones (BR-24)', () => {
    expect(() => listIntentIndex(overlay, { domain: 'payments' })).toThrow(IntentQueryError);
    try {
      listIntentIndex(overlay, { domain: 'payments' });
    } catch (error) {
      expect((error as IntentQueryError).code).toBe(IntentQueryErrorCode.UnknownDomain);
      expect((error as IntentQueryError).message).toContain('ordering, stock, returns');
    }
  });

  it('rejects an unknown kind naming the valid kinds (BR-24)', () => {
    expect(() => listIntentIndex(overlay, { kind: 'note' as IntentKind })).toThrow(IntentQueryError);
    try {
      listIntentIndex(overlay, { kind: 'note' as IntentKind });
    } catch (error) {
      expect((error as IntentQueryError).code).toBe(IntentQueryErrorCode.UnknownKind);
      expect((error as IntentQueryError).message).toContain('capability');
      expect((error as IntentQueryError).message).toContain('decision');
    }
  });

  it('lists accepted items only by default and adds candidates on opt-in (BR-25)', () => {
    expect(listIntentIndex(overlay, {}).entries.map((e) => e.id)).toEqual(['cap-order', 'cap-stock', 'br-stock']);
    expect(listIntentIndex(overlay, { includeCandidates: true }).entries.map((e) => e.id)).toEqual([
      'cap-order',
      'cap-stock',
      'br-stock',
      'dec-stock',
    ]);
  });

  it('never lists rejected or superseded items, on any filter (BR-25)', () => {
    for (const request of [
      {},
      { includeCandidates: true },
      { domain: 'ordering', includeCandidates: true },
      { kind: IntentKind.Capability, includeCandidates: true },
    ]) {
      const ids = listIntentIndex(overlay, request).entries.map((e) => e.id);
      expect(ids).not.toContain('cap-old');
      expect(ids).not.toContain('cap-dropped');
    }
  });

  it('orders by domain registry order, then kind enum order, then id (BR-27)', () => {
    const ordered = file(
      [
        indexed('br-z', IntentKind.BusinessRule, 'stock'),
        indexed('cap-b', IntentKind.Capability, 'stock'),
        indexed('cap-a', IntentKind.Capability, 'stock'),
        indexed('uc-first', IntentKind.UseCase, 'ordering'),
        indexed('cap-first', IntentKind.Capability, 'ordering'),
      ],
      [],
      [
        { id: 'ordering', title: 'Ordering' },
        { id: 'stock', title: 'Stock' },
      ],
    );
    expect(listIntentIndex(ordered, {}).entries.map((e) => e.id)).toEqual([
      'cap-first',
      'uc-first',
      'cap-a',
      'cap-b',
      'br-z',
    ]);
  });

  it('truncates at its own bound with the omitted count, deterministically (BR-27)', () => {
    const many = file(
      Array.from({ length: INTENT_INDEX_LIMITS.max + 7 }, (_, index) =>
        indexed(`cap-${String(index).padStart(4, '0')}`, IntentKind.Capability, 'ordering'),
      ),
    );
    const first = listIntentIndex(many, {});
    const second = listIntentIndex(many, {});

    expect(INTENT_INDEX_LIMITS.max).toBeGreaterThan(INTENT_CONTEXT_LIMITS.max);
    expect(first.entries).toHaveLength(INTENT_INDEX_LIMITS.max);
    expect(first.truncated).toBe(true);
    expect(first.omittedCount).toBe(7);
    expect(first.totalMatched).toBe(INTENT_INDEX_LIMITS.max + 7);
    expect(first.entries.at(-1)?.id).toBe('cap-0099');
    expect(second.entries).toEqual(first.entries);
  });

  it('reports no truncation under the bound', () => {
    const result = listIntentIndex(overlay, {});
    expect(result.truncated).toBe(false);
    expect(result.omittedCount).toBe(0);
    expect(result.totalMatched).toBe(result.entries.length);
  });
});
