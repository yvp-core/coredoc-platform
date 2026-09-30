/**
 * The browse surface's pure derivations.
 *
 * Two of them carry rules the UI cannot restate: `Empty` must be tellable apart
 * from "still loading" and "the read failed" (otherwise the invitation to create
 * the first domain renders over a transient null, or an error reads as an empty
 * product), and a count must be ABSENT rather than wrong whenever the pages it
 * would be tallied from are not all in hand.
 */

import { describe, expect, it } from 'vitest';
import {
  IntentAuthority,
  IntentItemKind,
  type IntentContextMatch,
  type IntentItemSummary,
  type IntentTreeDomain,
} from '../../../shared/intent-types.js';
import { INTENT_KIND_ORDER } from './intent-presentation';
import {
  DEFAULT_INTENT_ITEM_FILTER,
  EMPTY_INTENT_SCOPE_COUNTS,
  IntentBrowseState,
  IntentItemScope,
  authorityShare,
  filterIntentItems,
  groupIntentItemsByKind,
  intentAnchorKey,
  intentAuthorityTally,
  intentBrowseState,
  intentItemScope,
  intentItemsInScope,
  intentKindCounts,
  intentMatchesById,
  intentKnownCount,
  intentScopeCounts,
  intentTreeNames,
  versionsById,
  ZERO_INTENT_COUNT,
} from './intent-panel-state';

const input = (over: Partial<Parameters<typeof intentBrowseState>[0]> = {}) =>
  intentBrowseState({ treeLoading: false, treeError: false, domainCount: 3, rootItemCount: 0, ...over });

const item = (over: Partial<IntentItemSummary> = {}): IntentItemSummary => ({
  id: 'br-one',
  kind: IntentItemKind.BusinessRule,
  title: 'A rule',
  authority: IntentAuthority.Accepted,
  version: 1,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

describe('intentBrowseState', () => {
  it('reports Empty only once the tree resolved and named no domains and no root items', () => {
    expect(input({ domainCount: 0, rootItemCount: 0 })).toBe(IntentBrowseState.Empty);
  });

  it('never reports Empty for a domain-less workspace that still holds product-root items', () => {
    expect(input({ domainCount: 0, rootItemCount: 2 })).toBe(IntentBrowseState.Ready);
  });

  it('reports Loading while the read is in flight or nothing has resolved yet', () => {
    expect(input({ treeLoading: true, domainCount: 0 })).toBe(IntentBrowseState.Loading);
    expect(input({ domainCount: null })).toBe(IntentBrowseState.Loading);
    expect(input({ domainCount: 0, rootItemCount: null })).toBe(IntentBrowseState.Loading);
  });

  it('never reports Empty for a failed read — an error is not an empty product', () => {
    expect(input({ treeError: true, domainCount: 0 })).toBe(IntentBrowseState.Error);
    expect(input({ treeError: true, treeLoading: true, domainCount: null, rootItemCount: null })).toBe(
      IntentBrowseState.Error,
    );
  });

  it('reports Ready when domains exist', () => {
    expect(input()).toBe(IntentBrowseState.Ready);
  });
});

describe('versionsById', () => {
  it('indexes the version a supersession must carry for each predecessor', () => {
    expect(
      versionsById([
        { id: 'br-a', version: 3 },
        { id: 'br-b', version: 1 },
      ]),
    ).toEqual({ 'br-a': 3, 'br-b': 1 });
  });

  it('is empty for an empty read, so a missing version stays missing rather than defaulting', () => {
    expect(versionsById([])).toEqual({});
  });
});

describe('intentItemScope', () => {
  const selection = { domainId: 'payments', featureId: 'refunds' };

  it('calls an item attached to the selected feature attached', () => {
    expect(intentItemScope(item(), selection)).toBe(IntentItemScope.Attached);
  });

  it('calls the domain above the feature inherited, not attached', () => {
    expect(intentItemScope(item({ featureId: null }), selection)).toBe(IntentItemScope.InheritedDomain);
  });

  it('calls the product root inherited from a domain or feature view', () => {
    expect(intentItemScope(item({ domainId: null, featureId: null }), selection)).toBe(IntentItemScope.InheritedRoot);
    expect(intentItemScope(item({ domainId: null, featureId: null }), { domainId: 'payments', featureId: null })).toBe(
      IntentItemScope.InheritedRoot,
    );
  });

  it('names a feature below a domain view, so a domain list says where each item lives', () => {
    expect(intentItemScope(item(), { domainId: 'payments', featureId: null })).toBe(IntentItemScope.InFeature);
  });

  it('treats a product-root item as attached when the root itself is selected', () => {
    expect(intentItemScope(item({ domainId: null, featureId: null }), { domainId: null, featureId: null })).toBe(
      IntentItemScope.Attached,
    );
  });
});

describe('intentItemsInScope', () => {
  const rows = [
    item({ id: 'a', featureId: 'refunds' }),
    item({ id: 'b', featureId: null }),
    item({ id: 'c', featureId: 'chargebacks' }),
    item({ id: 'd', domainId: null, featureId: null }),
  ];

  it('keeps the feature, the domain above it and the root — and drops a sibling feature', () => {
    const ids = intentItemsInScope(rows, { domainId: 'payments', featureId: 'refunds' }).map((row) => row.id);
    expect(ids).toEqual(['a', 'b', 'd']);
  });

  it('keeps everything the domain-scoped read returned for a domain view', () => {
    expect(intentItemsInScope(rows, { domainId: 'payments', featureId: null })).toHaveLength(4);
  });

  it('is empty rather than null while nothing has loaded', () => {
    expect(intentItemsInScope(null, { domainId: null, featureId: null })).toEqual([]);
  });
});

describe('intentScopeCounts', () => {
  const rows = [
    item({ id: 'a', authority: IntentAuthority.Candidate }),
    item({ id: 'b', featureId: null }),
    item({ id: 'c', domainId: null, featureId: null }),
  ];

  it('reports nothing while a page is missing — an unknown count is not a zero', () => {
    expect(intentScopeCounts({ items: rows, scopeDomainId: null, complete: false })).toEqual(EMPTY_INTENT_SCOPE_COUNTS);
    expect(intentScopeCounts({ items: null, scopeDomainId: null, complete: true })).toEqual(EMPTY_INTENT_SCOPE_COUNTS);
  });

  it('tallies domains, features and the product root from a root-scoped read', () => {
    const counts = intentScopeCounts({ items: rows, scopeDomainId: null, complete: true });
    expect(counts.domains.payments).toEqual({ items: 2, candidates: 1 });
    expect(counts.features.refunds).toEqual({ items: 1, candidates: 1 });
    expect(counts.root).toEqual({ items: 1, candidates: 0 });
  });

  it('leaves the product root unknown when the read was filtered to one domain', () => {
    // A domain-scoped read simply never saw the root's items; claiming zero for
    // them would be a statement it has no evidence for.
    expect(intentScopeCounts({ items: rows, scopeDomainId: 'payments', complete: true }).root).toBeNull();
  });

  it('marks a complete unfiltered read as covering the whole workspace, and nothing else', () => {
    expect(intentScopeCounts({ items: rows, scopeDomainId: null, complete: true }).wholeWorkspace).toBe(true);
    expect(intentScopeCounts({ items: rows, scopeDomainId: 'payments', complete: true }).wholeWorkspace).toBe(false);
    expect(intentScopeCounts({ items: rows, scopeDomainId: null, complete: false }).wholeWorkspace).toBe(false);
  });

  it('never emits a zero cell of its own — a scope with no items is simply absent', () => {
    // THIS is why the tree cannot read "declared, no items yet" off the tally:
    // the producer has nothing to tally for an empty domain. The known-zero has
    // to come from the read's coverage, not from the map.
    const counts = intentScopeCounts({ items: rows, scopeDomainId: null, complete: true });
    expect(counts.domains.billing).toBeUndefined();
    expect(Object.values(counts.domains).every((cell) => cell.items > 0)).toBe(true);
  });
});

describe('intentKnownCount', () => {
  const whole = intentScopeCounts({
    items: [item({ id: 'a', domainId: 'payments', featureId: 'refunds' })],
    scopeDomainId: null,
    complete: true,
  });
  const scoped = intentScopeCounts({
    items: [item({ id: 'a', domainId: 'payments', featureId: 'refunds' })],
    scopeDomainId: 'payments',
    complete: true,
  });

  it('reads a domain the complete whole-workspace read never mentioned as a KNOWN ZERO', () => {
    expect(intentKnownCount(whole.domains.billing, whole)).toEqual(ZERO_INTENT_COUNT);
  });

  it('leaves the same domain unknown under a domain-scoped read', () => {
    expect(intentKnownCount(scoped.domains.billing, scoped)).toBeNull();
  });

  it('returns the tallied cell untouched when there is one', () => {
    expect(intentKnownCount(whole.domains.payments, whole)).toEqual({ items: 1, candidates: 0 });
  });
});

describe('filterIntentItems', () => {
  const rows = [
    item({ id: 'br-accepted', authority: IntentAuthority.Accepted, title: 'Refund window' }),
    item({ id: 'br-candidate', authority: IntentAuthority.Candidate, title: 'Longer window' }),
    item({ id: 'br-rejected', authority: IntentAuthority.Rejected, title: 'Rejected idea' }),
    item({ id: 'fl-flow', kind: IntentItemKind.Flow, title: 'Checkout' }),
  ];

  it('shows accepted and candidates but hides resolved items by default', () => {
    const ids = filterIntentItems(rows, DEFAULT_INTENT_ITEM_FILTER).map((row) => row.id);
    expect(ids).toContain('br-candidate');
    expect(ids).not.toContain('br-rejected');
  });

  it('adds the resolved items when the reader asks for them', () => {
    const ids = filterIntentItems(rows, { ...DEFAULT_INTENT_ITEM_FILTER, includeResolved: true }).map((row) => row.id);
    expect(ids).toContain('br-rejected');
  });

  it('drops candidates when only accepted intent is wanted', () => {
    const ids = filterIntentItems(rows, { ...DEFAULT_INTENT_ITEM_FILTER, includeCandidates: false }).map((r) => r.id);
    expect(ids).not.toContain('br-candidate');
  });

  it('filters by kind and searches title and id', () => {
    expect(filterIntentItems(rows, { ...DEFAULT_INTENT_ITEM_FILTER, kinds: [IntentItemKind.Flow] })).toHaveLength(1);
    expect(filterIntentItems(rows, { ...DEFAULT_INTENT_ITEM_FILTER, search: 'window' })).toHaveLength(2);
    expect(filterIntentItems(rows, { ...DEFAULT_INTENT_ITEM_FILTER, search: 'br-candidate' })).toHaveLength(1);
  });
});

describe('intentKindCounts and grouping', () => {
  const rows = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', kind: IntentItemKind.Flow })];

  it('counts only the kinds actually present', () => {
    expect(intentKindCounts(rows)).toEqual({ [IntentItemKind.BusinessRule]: 2, [IntentItemKind.Flow]: 1 });
  });

  it('groups in the declared kind order', () => {
    const groups = groupIntentItemsByKind(rows, INTENT_KIND_ORDER);
    expect(groups.map((group) => group.kind)).toEqual([IntentItemKind.Flow, IntentItemKind.BusinessRule]);
    expect(groups[1]?.items).toHaveLength(2);
  });
});

describe('intentAuthorityTally', () => {
  it('counts each authority and never divides by zero', () => {
    const tally = intentAuthorityTally([
      item({ id: 'a' }),
      item({ id: 'b', authority: IntentAuthority.Candidate }),
      item({ id: 'c', authority: IntentAuthority.Superseded }),
    ]);
    expect(tally).toEqual({ accepted: 1, candidate: 1, rejected: 0, superseded: 1, total: 3 });
    expect(authorityShare(1, 3)).toBe(33);
    expect(authorityShare(0, 0)).toBe(0);
  });
});

describe('intentMatchesById', () => {
  const match = (id: string): IntentContextMatch => ({ ...item({ id }), statement: 'x' }) as IntentContextMatch;

  it('keys the records the review surface holds a SET of', () => {
    expect(intentMatchesById([match('a'), match('b')])).toEqual({ a: match('a'), b: match('b') });
  });

  it('leaves an unanswered id ABSENT, so its consumer can say "not loaded"', () => {
    // A key present with an empty record would render as "nothing changes" in
    // the supersede diff — the one wrong answer this map must not produce.
    const byId = intentMatchesById([match('a')]);
    expect(Object.hasOwn(byId, 'b')).toBe(false);
    expect(intentMatchesById(undefined)).toEqual({});
  });
});

describe('intentTreeNames', () => {
  const domain = (over: Partial<IntentTreeDomain> = {}): IntentTreeDomain =>
    ({
      id: 'payments',
      title: 'Payments',
      statement: '',
      archived: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      featuresTruncated: false,
      features: [],
      ...over,
    }) as IntentTreeDomain;

  it('reads both levels out of the tree pages in hand', () => {
    const names = intentTreeNames(
      [
        domain({
          features: [
            {
              id: 'refunds',
              title: 'Refunds',
              domainId: 'payments',
              statement: '',
              archived: false,
              createdAt: '2026-08-01T00:00:00.000Z',
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        }),
      ],
      null,
    );
    expect(names.domains).toEqual({ payments: 'Payments' });
    expect(names.features).toEqual({ refunds: 'Refunds' });
  });

  it('adds the features a "show all" read brought back, and knows nothing else', () => {
    const names = intentTreeNames(null, [
      {
        id: 'payouts',
        title: 'Payouts',
        domainId: 'payments',
        statement: '',
        archived: false,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(names.features).toEqual({ payouts: 'Payouts' });
    // Absent, not blank: the surface falls back to the id, which is a true label.
    expect(names.domains.payments).toBeUndefined();
    expect(intentTreeNames(null, null)).toEqual({ domains: {}, features: {} });
  });
});

describe('intentAnchorKey', () => {
  it('identifies an anchor by (repo, node) — an anchor has no surrogate id', () => {
    expect(intentAnchorKey({ repoKey: 'acme/api', nodeId: 'h1:function:guard' })).not.toBe(
      intentAnchorKey({ repoKey: 'acme/web', nodeId: 'h1:function:guard' }),
    );
  });
});
