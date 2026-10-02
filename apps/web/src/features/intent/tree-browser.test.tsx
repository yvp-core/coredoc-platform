import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentTreeBrowser, type IntentTreeBrowserProps } from './tree-browser.js';
import type { IntentDimension } from './types.js';

afterEach(cleanup);

/**
 * The read-only registry PMs/testers see beside the tree (intent-dimensions
 * spec, non-goal: no create/edit/archive UI here).
 */
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

function renderBrowser(overrides: Partial<IntentTreeBrowserProps> = {}) {
  const props: IntentTreeBrowserProps = {
    domains: [],
    dimensions: null,
    selection: { domainId: null, featureId: null },
    includeArchived: false,
    canEdit: false,
    featureExpansion: { domainId: null, features: null, loading: false, truncated: false },
    hasMoreDomains: false,
    loadingMoreDomains: false,
    onSelect: () => undefined,
    onToggleArchived: () => undefined,
    onEditTree: () => undefined,
    onLoadMoreDomains: () => undefined,
    onShowAllFeatures: () => undefined,
    ...overrides,
  };
  return render(<IntentTreeBrowser {...props} />);
}

describe('IntentTreeBrowser dimensions section', () => {
  it('lists a dimension title, its value title, and the multi badge', () => {
    renderBrowser({ dimensions: DIMENSIONS });

    expect(screen.getByText('Country')).toBeInTheDocument();
    expect(screen.getByText('Germany')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('multi')).toBeInTheDocument();
  });

  it('renders nothing for an empty or unloaded registry', () => {
    renderBrowser({ dimensions: [] });
    expect(screen.queryByText('Dimensions')).not.toBeInTheDocument();

    cleanup();
    renderBrowser({ dimensions: null });
    expect(screen.queryByText('Dimensions')).not.toBeInTheDocument();
  });
});

describe('IntentTreeBrowser tree conditions (intent-dimensions-inheritance UC-3)', () => {
  it('marks a conditioned domain and feature with a tooltip carrying the clause text', () => {
    renderBrowser({
      domains: [
        {
          id: 'shifts',
          title: 'Shifts',
          statement: 'Shift scheduling.',
          archived: false,
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          appliesWhen: [{ dimension: 'product', in: ['shifts'] }],
          featuresTruncated: false,
          features: [
            {
              id: 'overtime',
              domainId: 'shifts',
              parentFeatureId: null,
              title: 'Overtime',
              statement: 'Overtime rules.',
              archived: false,
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
              appliesWhen: [{ dimension: 'country', in: ['de', 'pl'] }],
            },
          ],
        },
      ],
    });

    // No inline condition line any more; the text rides the marker's title and accessible name.
    expect(screen.queryByText('product in shifts')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Applies when product in shifts' })).toHaveAttribute(
      'title',
      'Applies when product in shifts',
    );
    expect(screen.getByRole('img', { name: 'Applies when country in de, pl' })).toBeInTheDocument();
  });
});

describe('IntentTreeBrowser nested features', () => {
  it('lists a sub-feature under its parent, and an orphan at the top level', () => {
    const feature = (id: string, parentFeatureId: string | null) => ({
      id,
      domainId: 'bank',
      parentFeatureId,
      title: id,
      statement: '',
      archived: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    renderBrowser({
      domains: [
        {
          id: 'bank',
          title: 'Hours bank',
          statement: '',
          archived: false,
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          featuresTruncated: false,
          features: [feature('payout', null), feature('limits', 'payout'), feature('orphan', 'archived-parent')],
        },
      ],
    });

    const payout = screen.getByRole('button', { name: 'payout' }).closest('li');
    expect(payout?.querySelector('ul')?.textContent).toContain('limits');
    expect(screen.getByRole('button', { name: 'orphan' }).closest('ul')?.parentElement?.textContent).toContain(
      'Hours bank',
    );
  });
});

describe('IntentTreeBrowser pending proposals', () => {
  it('shows server counts and, filtered, only the nodes with proposals at or below them', () => {
    const feature = (id: string, parentFeatureId: string | null) => ({
      id,
      domainId: 'bank',
      parentFeatureId,
      title: id,
      statement: '',
      archived: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const domain = (id: string, features: ReturnType<typeof feature>[]) => ({
      id,
      title: id,
      statement: '',
      archived: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      featuresTruncated: false,
      features,
    });
    renderBrowser({
      domains: [
        domain('bank', [feature('payout', null), feature('limits', 'payout'), feature('report', null)]),
        domain('quiet', []),
      ],
      pending: { root: 0, domains: { bank: 2 }, features: { limits: 2 } },
      onlyPending: true,
      onToggleOnlyPending: () => undefined,
    });

    // The domain, the parent feature (rolled up from its sub-feature) and the sub-feature itself.
    expect(screen.getAllByTitle('2 waiting for review')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /payout/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /limits/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /quiet/ })).not.toBeInTheDocument();
  });
});
