import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntentDimension, IntentFeatureView, IntentTreeDomain } from '../../../shared/intent-types.js';
import type { IntentItemSummary } from '../../../shared/intent-types.js';
import { IntentAuthority, IntentItemKind } from '../../../shared/intent-types.js';
import { IntentTreeBrowser, type IntentTreeBrowserProps } from './IntentTreeBrowser';
import { EMPTY_INTENT_SCOPE_COUNTS, intentScopeCounts } from './intent-panel-state';

/**
 * Counts are built by the PRODUCER, never hand-written: `intentScopeCounts`
 * cannot emit a zero cell, so a hand-made `{ items: 0 }` pinned a shape the app
 * never sees — which is how "declared, no items yet" stayed unreachable while
 * its test passed.
 */
const countsOf = (items: IntentItemSummary[], scopeDomainId: string | null = null) =>
  intentScopeCounts({ items, scopeDomainId, complete: true });

const itemIn = (over: Partial<IntentItemSummary>): IntentItemSummary => ({
  id: 'br-one',
  kind: IntentItemKind.BusinessRule,
  title: 'A rule',
  authority: IntentAuthority.Accepted,
  version: 1,
  domainId: 'payments',
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...over,
});

// This renderer has no @testing-library/react/jsdom setup (vitest.config.ts runs in the
// 'node' environment), so components are rendered with `renderToStaticMarkup` and asserted
// on the HTML string — the same harness as ../observability/phase-a-activity-view.test.ts.
// window.electronAPI is fully mocked and left EMPTY on purpose: IntentTreeBrowser is
// pure-props, so a test that passes here also proves no IPC call hides inside the view
// (repo rule: no real IPC in component tests, feedback_storybook_no_real_ipc_in_ci).
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

const DOMAINS: IntentTreeDomain[] = [
  {
    id: 'payments',
    title: 'Payments',
    statement: 'Money in and out.',
    archived: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    featuresTruncated: false,
    features: [
      {
        id: 'refunds',
        domainId: 'payments',
        parentFeatureId: null,
        title: 'Refunds',
        statement: 'Returning money.',
        archived: false,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'chargebacks',
        domainId: 'payments',
        parentFeatureId: null,
        title: 'Chargebacks',
        statement: 'Disputes.',
        archived: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  },
];

const NO_EXPANSION = { domainId: null, features: null, loading: false, truncated: false };

const EXTRA_FEATURE: IntentFeatureView = {
  id: 'disputes',
  domainId: 'payments',
  parentFeatureId: null,
  title: 'Disputes',
  statement: 'Contested charges.',
  archived: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const DIMENSIONS: IntentDimension[] = [
  {
    id: 'country',
    title: 'Country',
    values: [
      { id: 'de', title: 'Germany' },
      { id: 'ua', title: 'Ukraine' },
    ],
    multi: false,
  },
  {
    id: 'product',
    title: 'Product',
    values: [{ id: 'shifts', title: 'Shifts' }],
    multi: true,
  },
];

function render(overrides: Partial<IntentTreeBrowserProps> = {}): string {
  const props: IntentTreeBrowserProps = {
    domains: DOMAINS,
    dimensions: null,
    counts: EMPTY_INTENT_SCOPE_COUNTS,
    featureExpansion: NO_EXPANSION,
    selection: { domainId: 'payments', featureId: null },
    includeArchived: false,
    hasMoreDomains: false,
    loadingMoreDomains: false,
    onSelect: () => undefined,
    onToggleArchived: () => undefined,
    onEditTree: () => undefined,
    onLoadMoreDomains: () => undefined,
    onShowAllFeatures: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentTreeBrowser, props));
}

describe('IntentTreeBrowser structure column', () => {
  it('offers the product root above the domains, so "whole product" is a place you can stand', () => {
    const html = render();
    expect(html).toContain('Product overview');
    expect(html.indexOf('Product overview')).toBeLessThan(html.indexOf('Payments'));
  });

  it('renders domains with their features nested', () => {
    const html = render();
    expect(html).toContain('Payments');
    expect(html).toContain('Refunds');
  });

  it('marks the selected node rather than leaving the reader to guess', () => {
    const html = render({ selection: { domainId: 'payments', featureId: 'refunds' } });
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('font-semibold');
  });

  it('says archived nodes are hidden by default, and flips the label when shown', () => {
    expect(render({ includeArchived: false })).toContain('Show archived');
    const shown = render({ includeArchived: true });
    expect(shown).toContain('Archived shown');
    // The archived feature is still labelled as such rather than silently listed.
    expect(shown).toContain('Chargebacks');
    expect(shown).toContain('Archived<');
  });

  it('offers tree editing to any member', () => {
    expect(render()).toContain('>Edit<');
  });
});

describe('IntentTreeBrowser dimensions section', () => {
  it('lists a dimension title, its value title, and the multi badge', () => {
    const html = render({ dimensions: DIMENSIONS });
    expect(html).toContain('Country');
    expect(html).toContain('Germany');
    expect(html).toContain('Product');
    expect(html).toContain('multi');
  });

  it('renders nothing for an empty or unloaded registry', () => {
    expect(render({ dimensions: [] })).not.toContain('Dimensions');
    expect(render({ dimensions: null })).not.toContain('Dimensions');
  });
});

describe('IntentTreeBrowser counts', () => {
  it('draws no number at all for a scope nothing has been read for', () => {
    // The defect this pins: a zero rendered for an unread scope reads as "empty",
    // which is a claim the panel has no evidence for.
    const html = render();
    expect(html).not.toContain('>0<');
  });

  it('shows the count and a candidate dot for a scope the loaded pages cover', () => {
    const html = render({
      counts: countsOf([
        itemIn({ id: 'a', featureId: 'refunds', authority: IntentAuthority.Candidate }),
        itemIn({ id: 'b', featureId: 'refunds' }),
        itemIn({ id: 'c' }),
        itemIn({ id: 'd' }),
      ]),
    });
    expect(html).toContain('>4<');
    expect(html).toContain('>2<');
    expect(html).toContain('bg-dodger-blue-500');
  });

  it('paints a count that carries candidates in the text-safe candidate blue', () => {
    const withCandidates = render({
      counts: countsOf([itemIn({ id: 'a', authority: IntentAuthority.Candidate })]),
    });
    const withoutCandidates = render({ counts: countsOf([itemIn({ id: 'a' })]) });

    expect(withCandidates).toContain('text-content-tag-progress');
    expect(withoutCandidates).not.toContain('text-content-tag-progress');
  });

  it('says a declared domain simply has nothing in it yet', () => {
    // Producer-emitted: the whole workspace was read completely and this domain
    // is simply not in the tally, which is what makes the zero KNOWN.
    const html = render({
      domains: [{ ...DOMAINS[0]!, features: [] }],
      counts: countsOf([itemIn({ id: 'root-item', domainId: null })]),
    });
    expect(html).toContain('declared, no items yet');
  });

  it('leaves the same domain silent when only ITS OWN scope was read', () => {
    const html = render({
      domains: [{ ...DOMAINS[0]!, features: [] }],
      counts: countsOf([itemIn({ id: 'a', domainId: 'billing' })], 'billing'),
    });
    expect(html).not.toContain('declared, no items yet');
  });

  it('hides a zero on the product-root row, which the header already counts', () => {
    // Zero items attached to the root itself is the norm, and a "0" beside
    // "41 items" in the header reads as a contradiction.
    const html = render({ counts: countsOf([itemIn({ id: 'a' })]) });
    const rootRow = html.slice(html.indexOf('title="product root"'));
    const rootRowMarkup = rootRow.slice(0, rootRow.indexOf('</button>'));

    expect(rootRowMarkup).toContain('Product overview');
    expect(rootRowMarkup).not.toContain('>0<');
    // The domain that DOES hold the item still shows its number.
    expect(html).toContain('>1<');
  });
});

describe('IntentTreeBrowser cursor following', () => {
  it('offers a load-more action exactly when the server has more domain pages', () => {
    expect(render()).not.toContain('Load more domains');
    expect(render({ hasMoreDomains: true })).toContain('Load more domains');
  });

  it('says it is loading rather than offering the same action twice', () => {
    const html = render({ hasMoreDomains: true, loadingMoreDomains: true });
    expect(html).toContain('Loading…');
    expect(html).not.toContain('Load more domains');
  });

  it('turns the featuresTruncated note into an action a reader can take', () => {
    const truncated = [{ ...DOMAINS[0]!, featuresTruncated: true }];
    const html = render({ domains: truncated });
    expect(html).toContain('More features than this page shows.');
    expect(html).toContain('Show all features');
  });

  it('replaces the bounded feature list with the full one once it loads', () => {
    const truncated = [{ ...DOMAINS[0]!, featuresTruncated: true }];
    const html = render({
      domains: truncated,
      featureExpansion: {
        domainId: 'payments',
        features: [...DOMAINS[0]!.features, EXTRA_FEATURE],
        loading: false,
        truncated: false,
      },
    });

    expect(html).toContain('Disputes');
    // The dead-end note and its action are gone: the question has been answered.
    expect(html).not.toContain('Show all features');
    expect(html).not.toContain('More features than this page shows.');
  });

  it('admits when even the exhaustive feature read hit its ceiling', () => {
    const html = render({
      domains: [{ ...DOMAINS[0]!, featuresTruncated: true }],
      featureExpansion: { domainId: 'payments', features: [EXTRA_FEATURE], loading: false, truncated: true },
    });
    expect(html).toContain('more features than one exhaustive read returns');
  });

  it('surfaces a failed feature expansion instead of leaving the button silent', () => {
    const html = render({
      domains: [{ ...DOMAINS[0]!, featuresTruncated: true }],
      featureExpansion: {
        domainId: 'payments',
        features: null,
        loading: false,
        truncated: false,
        errorMessage: 'features read refused',
      },
    });
    expect(html).toContain('features read refused');
  });
});

describe('IntentTreeBrowser tree conditions (intent-dimensions-inheritance UC-3)', () => {
  it('shows a compact condition line under a domain and under a feature that has one', () => {
    const html = render({
      domains: [
        {
          ...DOMAINS[0]!,
          appliesWhen: [{ dimension: 'product', in: ['shifts'] }],
          features: [{ ...DOMAINS[0]!.features[0]!, appliesWhen: [{ dimension: 'country', in: ['de', 'pl'] }] }],
        },
      ],
    });

    expect(html).toContain('product in shifts');
    expect(html).toContain('country in de, pl');
  });
});
