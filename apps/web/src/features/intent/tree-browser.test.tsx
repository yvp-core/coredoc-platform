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
