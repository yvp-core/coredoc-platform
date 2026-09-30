/**
 * The product overview. The assertions that matter are about honesty: a partial
 * read says it is partial, the two anchor units are never collapsed into one
 * number, and the decision feed tells an empty ledger apart from one it has not
 * read yet.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntentAuthority,
  IntentItemKind,
  type IntentItemSummary,
  type IntentTransition,
} from '../../../shared/intent-types.js';
import { IntentOverview, type IntentOverviewProps } from './IntentOverview';
import { intentAuthorityTally } from './intent-panel-state';

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electronAPI: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const item = (over: Partial<IntentItemSummary> = {}): IntentItemSummary => ({
  id: 'cap-payouts',
  kind: IntentItemKind.Capability,
  title: 'Payouts',
  authority: IntentAuthority.Accepted,
  version: 2,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T10:00:00.000Z',
  ...over,
});

const ITEMS = [item(), item({ id: 'br-window', domainId: 'payments', authority: IntentAuthority.Candidate })];

const transition = (over: Partial<IntentTransition> = {}): IntentTransition => ({
  id: 'tr-1',
  itemId: 'br-window',
  from: 'candidate',
  to: 'accepted',
  actorId: 'user_1',
  actorRole: 'admin',
  reason: 'Matches the refunds spec',
  authorizingSource: { kind: 'spec', ref: 'SPEC-7', localId: '4.2', revision: null },
  workItem: null,
  createdAt: '2026-08-30T09:00:00.000Z',
  ...over,
});

function render(overrides: Partial<IntentOverviewProps> = {}): string {
  const props: IntentOverviewProps = {
    tally: intentAuthorityTally(ITEMS),
    complete: true,
    productItems: [ITEMS[0]!],
    decisions: [transition()],
    selectedItemId: null,
    loading: false,
    hasMore: false,
    loadingMore: false,
    onSelectItem: () => undefined,
    onLoadMore: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentOverview, props));
}

describe('IntentOverview authority strip', () => {
  it('reports the mix with a legend, so a colour is never the only carrier', () => {
    const html = render();
    expect(html).toContain('Accepted');
    expect(html).toContain('Candidate');
    expect(html).toContain('Rejected');
    expect(html).toContain('Superseded');
    expect(html).toContain('2 items across the workspace.');
  });

  it('says the numbers are partial while the server still has pages', () => {
    const html = render({ complete: false });
    expect(html).toContain('loaded so far');
    expect(html).toContain('has more pages');
  });
});

describe('IntentOverview anchor health', () => {
  it('says where anchor health is read in ONE line, without a block that measures nothing', () => {
    const html = render();

    expect(html).toContain('Anchor health is read per item — open an item to see its anchors.');
    // Two rows of "not measured here" plus a three-line explainer was a large
    // dead block reporting no number at all.
    expect(html).not.toContain('not measured here');
    expect(html).not.toContain('measure different things');
  });

  it('still shows no anchor number it cannot stand behind', () => {
    expect(render()).not.toContain('0 anchors');
  });
});

describe('IntentOverview candidate blue', () => {
  it('paints the Candidate legend label in the text-safe candidate blue', () => {
    // The dot keeps dodger-500 (a fill); the WORD takes the dodger-600 text step
    // DESIGN.md reserves for the candidate/cloud semantic on a light ground.
    const html = render();
    expect(html).toContain('text-content-tag-progress');
    expect(html).toContain('bg-dodger-blue-500');
  });
});

describe('IntentOverview lists', () => {
  it('lists what is attached to the product root itself', () => {
    const html = render();
    expect(html).toContain('Payouts');
    expect(html).toContain('cap-payouts');
  });

  it('says so when nothing is attached to the root', () => {
    expect(render({ productItems: [] })).toContain('Nothing is attached to the product root');
  });

  it('renders a spinner instead of empty claims while the read is in flight', () => {
    const html = render({ loading: true, productItems: [], decisions: [] });
    expect(html).not.toContain('Nothing is attached to the product root');
    expect(html).not.toContain('Recent decisions');
  });
});

describe('IntentOverview decision feed', () => {
  it('shows the workspace ledger — the transition, its reason and the item it moved', () => {
    const html = render();
    expect(html).toContain('Recent decisions');
    expect(html).toContain('candidate → accepted');
    expect(html).toContain('Matches the refunds spec');
    expect(html).toContain('br-window');
    expect(html).toContain('workspace decision ledger');
  });

  it('calls a NULL `from` an arrival, never a decision somebody made', () => {
    const html = render({ decisions: [transition({ from: null, to: 'accepted', reason: 'imported' })] });
    expect(html).toContain('Arrived as accepted');
    expect(html).not.toContain('→ accepted');
  });

  it('tells an empty ledger apart from a ledger it has not read yet', () => {
    expect(render({ decisions: [] })).toContain('No decisions recorded yet');
    const unread = render({ decisions: null });
    expect(unread).not.toContain('No decisions recorded yet');
  });

  it('says the read failed rather than rendering as if nothing was decided', () => {
    const html = render({ decisions: null, decisionsErrorMessage: 'upstream down' });
    // Rendered markup escapes the apostrophe, so the assertion sits after it.
    expect(html).toContain('read the decision ledger');
    expect(html).toContain('upstream down');
  });
});
