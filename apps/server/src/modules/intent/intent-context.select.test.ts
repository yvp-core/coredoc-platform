/**
 * The ported selection semantics, asserted against the SAME expectation matrix
 * `packages/core/src/intent/query.test.ts` holds for the local overlay read.
 *
 * These are the rules that must not drift between the two surfaces: which
 * anchors a node query reaches, what order truncation drops, which reason wins
 * when several selectors explain the same item, and what a present-but-empty
 * selector means. They are asserted here — pure, no database — because the
 * PostgreSQL suite proves the SQL implements them, not what they are.
 */
import { describe, expect, it } from 'vitest';
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { IntentMatchReason as IntentDerivationMatchReason } from './derivation/derivation-contract.js';
import { IntentContextMatchReason } from './intent-context.operations.js';
import {
  AUTHORITY_RANK,
  attachmentReason,
  compareFallbackMatches,
  compareMatches,
  enclosingNodeIdCandidates,
  expandNodeIds,
  fileMemberLikePatterns,
  nodeSelectionTruncated,
  graphRepoHashOfNodeId,
  hasSelector,
  likePattern,
  mergeFeatureCandidates,
  mergeDerivationCandidates,
  mergeMatches,
  reasonForDerivedHit,
  strongerReason,
  type SelectedMatch,
} from './intent-context.select.js';

const REPO = 'aaaa1111aaaa';

describe('enclosing-scope node matching (core parity)', () => {
  it('reaches the enclosing class and file from a method id', () => {
    expect(enclosingNodeIdCandidates(`${REPO}:method:src/admin.ts:Guard.check`)).toEqual([
      `${REPO}:method:src/admin.ts:Guard.check`,
      `${REPO}:file:src/admin.ts`,
      `${REPO}:class:src/admin.ts:Guard`,
    ]);
  });

  it('reaches every nested class owner a Python-shaped method names', () => {
    expect(enclosingNodeIdCandidates(`${REPO}:method:app/api.py:Outer.Inner.handle`)).toEqual([
      `${REPO}:method:app/api.py:Outer.Inner.handle`,
      `${REPO}:file:app/api.py`,
      `${REPO}:class:app/api.py:Outer`,
      `${REPO}:class:app/api.py:Outer.Inner`,
    ]);
  });

  it('reaches the file from a plain function id', () => {
    expect(enclosingNodeIdCandidates(`${REPO}:function:src/orders.ts:createOrder`)).toEqual([
      `${REPO}:function:src/orders.ts:createOrder`,
      `${REPO}:file:src/orders.ts`,
    ]);
  });

  it('does not expand a hashed kind, whose third segment is not a path', () => {
    expect(enclosingNodeIdCandidates(`${REPO}:route:GET:deadbeef`)).toEqual([`${REPO}:route:GET:deadbeef`]);
  });

  it('does not expand a bare file id into exact candidates: its members are matched by pattern', () => {
    expect(enclosingNodeIdCandidates(`${REPO}:file:src/orders.ts`)).toEqual([`${REPO}:file:src/orders.ts`]);
  });

  it('derives ONE member pattern per queried file, anchored on hash and exact path', () => {
    expect(fileMemberLikePatterns([`${REPO}:file:src/orders.ts`])).toEqual([`${REPO}:%:src/orders.ts:%`]);
  });

  it('costs one pattern per file id, not one per file id x node kind', () => {
    const nodeIds = Array.from({ length: 50 }, (_, index) => `${REPO}:file:src/file-${index}.ts`);
    expect(fileMemberLikePatterns(nodeIds)).toHaveLength(50);
  });

  it('escapes LIKE wildcards in the path and ignores non-file ids', () => {
    expect(fileMemberLikePatterns([`${REPO}:file:src/a_b%c.ts`])).toEqual([`${REPO}:%:src/a\\_b\\%c.ts:%`]);
    expect(fileMemberLikePatterns([`${REPO}:method:src/orders.ts:Guard.check`, 'not-a-node-id', ''])).toEqual([]);
  });

  it('reports the flat attached-candidates page as a cut when it comes back full', () => {
    const counts = {
      anchoredRows: 0,
      anchorScan: 200,
      anchoredCandidateRows: 0,
      attachedCandidateRows: 51,
      derivationBound: 50,
      attachedPageInUse: true,
    };
    expect(nodeSelectionTruncated(counts)).toBe(true);
    expect(nodeSelectionTruncated({ ...counts, attachedCandidateRows: 50 })).toBe(false);
    // With no derivable feature the attached page serves nothing, so its fullness cuts nothing.
    expect(nodeSelectionTruncated({ ...counts, attachedPageInUse: false })).toBe(false);
    expect(nodeSelectionTruncated({ ...counts, anchoredRows: 201 })).toBe(true);
    expect(nodeSelectionTruncated({ ...counts, anchoredCandidateRows: 51 })).toBe(true);
  });

  it('degrades to exact matching for anything that is not a stable node id', () => {
    expect(enclosingNodeIdCandidates('not-a-node-id')).toEqual(['not-a-node-id']);
    expect(enclosingNodeIdCandidates(`${REPO}:method:src/a.ts:`)).toEqual([`${REPO}:method:src/a.ts:`]);
  });

  it('expands a set without duplicating shared enclosing scopes', () => {
    const expanded = expandNodeIds([
      `${REPO}:method:src/admin.ts:Guard.check`,
      `${REPO}:method:src/admin.ts:Guard.assert`,
    ]);
    expect(expanded.filter((id) => id === `${REPO}:file:src/admin.ts`)).toHaveLength(1);
    expect(expanded.filter((id) => id === `${REPO}:class:src/admin.ts:Guard`)).toHaveLength(1);
  });

  it('reads the graph repo hash back out of a node id, and refuses a bare string', () => {
    expect(graphRepoHashOfNodeId(`${REPO}:function:src/a.ts:f`)).toBe(REPO);
    expect(graphRepoHashOfNodeId('nocolon')).toBeNull();
  });
});

describe('authority ordering', () => {
  it('ranks accepted before candidate, and keeps the retained states last', () => {
    expect(AUTHORITY_RANK[IntentItemAuthority.accepted]).toBeLessThan(AUTHORITY_RANK[IntentItemAuthority.candidate]);
    expect(AUTHORITY_RANK[IntentItemAuthority.candidate]).toBeLessThan(AUTHORITY_RANK[IntentItemAuthority.superseded]);
    expect(AUTHORITY_RANK[IntentItemAuthority.superseded]).toBeLessThan(AUTHORITY_RANK[IntentItemAuthority.rejected]);
  });

  it('orders accepted before candidate, then by id — a total order truncation can rely on', () => {
    const matches: SelectedMatch[] = [
      { id: 'br-c', authorityRank: 1, reason: IntentContextMatchReason.Text },
      { id: 'br-a', authorityRank: 1, reason: IntentContextMatchReason.Text },
      { id: 'br-z', authorityRank: 0, reason: IntentContextMatchReason.Text },
      { id: 'br-b', authorityRank: 0, reason: IntentContextMatchReason.Text },
    ];
    expect([...matches].sort(compareMatches).map((match) => match.id)).toEqual(['br-b', 'br-z', 'br-a', 'br-c']);
    // Stable across repeated identical requests: the same input, the same tail.
    expect([...matches].sort(compareMatches).map((match) => match.id)).toEqual(
      [...matches].sort(compareMatches).map((match) => match.id),
    );
  });

  it('ranks the disjunctive fallback by token-hit count before the ordinary order', () => {
    const matches: SelectedMatch[] = [
      { id: 'br-a', authorityRank: 0, reason: IntentContextMatchReason.Text, hits: 1 },
      { id: 'br-b', authorityRank: 1, reason: IntentContextMatchReason.Text, hits: 2 },
      { id: 'br-c', authorityRank: 0, reason: IntentContextMatchReason.Text, hits: 2 },
    ];
    expect([...matches].sort(compareFallbackMatches).map((match) => match.id)).toEqual(['br-c', 'br-b', 'br-a']);
  });
});

describe('match reasons', () => {
  it('prefers the selector the caller named over what the graph merely reached', () => {
    expect(strongerReason(IntentContextMatchReason.NodeDerived, IntentContextMatchReason.NodeAnchor)).toBe(
      IntentContextMatchReason.NodeAnchor,
    );
    expect(strongerReason(IntentContextMatchReason.Text, IntentContextMatchReason.ExactId)).toBe(
      IntentContextMatchReason.ExactId,
    );
    expect(strongerReason(IntentContextMatchReason.Default, IntentContextMatchReason.Inherited)).toBe(
      IntentContextMatchReason.Inherited,
    );
  });

  it('reads an anchor ON a queried node as node_anchor and everything else as node_derived', () => {
    expect(reasonForDerivedHit([IntentDerivationMatchReason.AnchorInArea])).toBe(IntentContextMatchReason.NodeAnchor);
    expect(reasonForDerivedHit([IntentDerivationMatchReason.AnchorCalledByArea])).toBe(
      IntentContextMatchReason.NodeDerived,
    );
    expect(reasonForDerivedHit([IntentDerivationMatchReason.AnchorCallsArea])).toBe(
      IntentContextMatchReason.NodeDerived,
    );
    expect(reasonForDerivedHit([IntentDerivationMatchReason.Inherited])).toBe(IntentContextMatchReason.NodeDerived);
  });

  it('merges two hits on one item into the stronger reason, keeping every derivation reason', () => {
    const merged = mergeMatches([
      { id: 'br-a', authorityRank: 0, reason: IntentContextMatchReason.NodeAnchor },
      {
        id: 'br-a',
        authorityRank: 0,
        reason: IntentContextMatchReason.NodeDerived,
        derivedReasons: [IntentDerivationMatchReason.AnchorCalledByArea],
      },
      { id: 'br-b', authorityRank: 1, reason: IntentContextMatchReason.NodeDerived },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: 'br-a',
      reason: IntentContextMatchReason.NodeAnchor,
      derivedReasons: [IntentDerivationMatchReason.AnchorCalledByArea],
    });
  });

  it('reports a tree-scope hit as attached on the branch and inherited above it', () => {
    const feature = { domainId: 'ordering', featureId: 'checkout' };
    expect(attachmentReason({ domainId: 'ordering', featureId: 'checkout' }, feature)).toBe(
      IntentContextMatchReason.Attached,
    );
    expect(attachmentReason({ domainId: 'ordering', featureId: null }, feature)).toBe(
      IntentContextMatchReason.Inherited,
    );
    expect(attachmentReason({ domainId: null, featureId: null }, feature)).toBe(IntentContextMatchReason.Inherited);

    const domain = { domainId: 'ordering', featureId: null };
    expect(attachmentReason({ domainId: 'ordering', featureId: 'checkout' }, domain)).toBe(
      IntentContextMatchReason.Attached,
    );
    expect(attachmentReason({ domainId: null, featureId: null }, domain)).toBe(IntentContextMatchReason.Inherited);
  });
});

describe('a present-but-empty selector is a selector, not an absent one', () => {
  it('treats an empty selector array as a question that matched nothing', () => {
    expect(hasSelector({ nodeIds: [] })).toBe(true);
    expect(hasSelector({ intentIds: [] })).toBe(true);
  });

  it('counts a tree scope and a non-blank query as selectors', () => {
    expect(hasSelector({ domain: 'ordering' })).toBe(true);
    expect(hasSelector({ feature: 'checkout' })).toBe(true);
    expect(hasSelector({ query: 'refund' })).toBe(true);
  });

  it('is only absent when nothing at all was selected', () => {
    expect(hasSelector({})).toBe(false);
    expect(hasSelector({ query: '' })).toBe(false);
  });
});

describe('lexical patterns', () => {
  it('escapes the wildcards so a caller token cannot widen its own query', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('back\\slash')).toBe('%back\\\\slash%');
    expect(likePattern('refund')).toBe('%refund%');
  });
});

describe('feature candidates', () => {
  const f = (id: string) => ({ id });

  it('keeps the seeded features and reports what the bound cut', () => {
    const merged = mergeFeatureCandidates([f('z-seeded')], [f('a'), f('b'), f('z-seeded')], 2);
    expect(merged.rows).toEqual([f('z-seeded'), f('a')]);
    expect(merged.truncated).toBe(true);
  });

  it('reports no truncation when every candidate fits, deduplicated', () => {
    const merged = mergeFeatureCandidates([f('a')], [f('a'), f('b')], 100);
    expect(merged.rows).toEqual([f('a'), f('b')]);
    expect(merged.truncated).toBe(false);
  });
});

it('retains accepted attached rules ahead of an anchored candidate page, with stable best-rank deduplication', () => {
  const rows = [
    { id: 'br-anchored-candidate', authorityRank: 1 },
    { id: 'br-shared', authorityRank: 0 },
    { id: 'br-attached-accepted', authorityRank: 0 },
    { id: 'br-shared', authorityRank: 1 },
  ];
  const expected = [
    ['br-attached-accepted', 0],
    ['br-shared', 0],
  ];
  for (const input of [rows, [...rows].reverse()]) {
    const result = mergeDerivationCandidates(input, 2);
    expect([...result.rankById]).toEqual(expected);
    expect(result.truncated).toBe(true);
  }
});
