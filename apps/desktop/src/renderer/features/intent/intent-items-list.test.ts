/**
 * The Items column, rendered with `renderToStaticMarkup` in the node environment
 * (vitest.config.ts). `window.electronAPI` is mocked and deliberately EMPTY: the
 * column is pure props, so a passing test also proves no IPC hides inside it.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentAuthority, IntentItemKind, type IntentItemSummary } from '../../../shared/intent-types.js';
import { IntentItemsList, type IntentItemsListProps } from './IntentItemsList';
import { DEFAULT_INTENT_ITEM_FILTER } from './intent-panel-state';

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
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 30 days',
  authority: IntentAuthority.Accepted,
  version: 3,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

const ITEMS = [
  item(),
  item({
    id: 'br-refunds-window-v2',
    title: 'Refunds close after 60 days',
    authority: IntentAuthority.Candidate,
    version: 1,
    proposedSuccessorOfId: 'br-refunds-window',
  }),
  item({ id: 'cap-payouts', kind: IntentItemKind.Capability, title: 'Payouts', featureId: null }),
];

function render(overrides: Partial<IntentItemsListProps> = {}): string {
  const props: IntentItemsListProps = {
    title: 'Payments · Refunds',
    items: ITEMS,
    scopedCount: ITEMS.length,
    deliverySelection: [],
    selectingAll: false,
    onToggleDelivery: () => undefined,
    onSelectVisible: () => undefined,
    onSelectAllMatching: () => undefined,
    filter: DEFAULT_INTENT_ITEM_FILTER,
    selection: { domainId: 'payments', featureId: 'refunds' },
    featureTitles: { refunds: 'Refunds' },
    selectedItemId: null,
    loading: false,
    hasMore: false,
    loadingMore: false,
    onSearch: () => undefined,
    onToggleKind: () => undefined,
    onToggleCandidates: () => undefined,
    onToggleResolved: () => undefined,
    onSelectItem: () => undefined,
    onLoadMore: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentItemsList, props));
}

describe('IntentItemsList header', () => {
  it('names the selection and says how much of the scope is on screen', () => {
    const html = render();
    expect(html).toContain('Payments · Refunds');
    expect(html).toContain('3 of 3');
  });

  it('offers every kind so filtering is not limited to loaded pages', () => {
    const html = render();
    expect(html).toContain('Business rule');
    expect(html).toContain('Capability');
    expect(html).toContain('Limitation');
  });

  it('offers the two authority chips', () => {
    const html = render();
    expect(html).toContain('Accepted + candidates');
    expect(html).toContain('Include resolved');
  });
});

describe('IntentItemsList rows', () => {
  it('groups by kind and renders an authority badge per row', () => {
    const html = render();
    expect(html).toContain('Refunds close after 30 days');
    expect(html).toContain('Accepted');
    expect(html).toContain('Candidate');
    expect(html).toContain('br-refunds-window-v2');
  });

  it('calls out a replacement proposal where it is browsed, not only in review', () => {
    expect(render()).toContain('replacement');
  });

  it('says WHY an item that is not attached here applies', () => {
    // The domain's own item, seen from a feature: inherited, not attached.
    expect(render()).toContain('inherited · domain');
    // A domain view names the feature an item lives in instead.
    const domainView = render({
      selection: { domainId: 'payments', featureId: null },
      title: 'Payments',
    });
    expect(domainView).toContain('in Refunds');
  });

  it('gives a candidate a rail, and an accepted item none', () => {
    const candidateOnly = render({ items: [ITEMS[1]!] });
    const acceptedOnly = render({ items: [ITEMS[0]!] });
    expect(candidateOnly).toContain('bg-dodger-blue-500');
    expect(acceptedOnly).not.toContain('bg-dodger-blue-500');
  });
});

describe('IntentItemsList empty and paging states', () => {
  it('separates "nothing applies here" from "nothing matches the filters"', () => {
    expect(render({ items: [], scopedCount: 0 })).toContain('No intent items apply here yet.');
    const filteredOut = render({ items: [], scopedCount: 3 });
    expect(filteredOut).toContain('No item matches these filters.');
    expect(filteredOut).toContain('3 in scope');
  });

  it('renders neither rows nor an empty claim while the read is in flight', () => {
    const html = render({ loading: true, items: [], scopedCount: 0 });
    expect(html).not.toContain('No intent items apply here yet.');
    expect(html).not.toContain('Refunds close after 30 days');
  });

  it('offers load-more exactly when the server has another page', () => {
    expect(render()).not.toContain('Load more items');
    expect(render({ hasMore: true })).toContain('Load more items');
    expect(render({ hasMore: true, loadingMore: true })).toContain('Loading…');
  });
});

it('shows production evidence separately from authority and offers bounded selection', () => {
  const html = render({ items: [item({ authority: IntentAuthority.Superseded, effectivity: 'effective' })] });
  expect(html).toContain('In production');
  expect(html).toContain('Superseded');
  expect(html).toContain('Select all matching rules');
  expect(html).toContain('Select Refunds close after 30 days for delivery');
});
