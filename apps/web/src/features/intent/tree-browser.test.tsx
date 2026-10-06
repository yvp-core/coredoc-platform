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

const treeFeature = (id: string, parentFeatureId: string | null) => ({
  id,
  domainId: 'bank',
  parentFeatureId,
  title: id,
  statement: '',
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});
const treeDomain = (id: string, features: ReturnType<typeof treeFeature>[]) => ({
  id,
  title: id,
  statement: '',
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  featuresTruncated: false,
  features,
});

describe('IntentTreeBrowser pending proposals', () => {
  it('shows server counts and, filtered, only the nodes with proposals at or below them', () => {
    renderBrowser({
      domains: [
        treeDomain('bank', [treeFeature('payout', null), treeFeature('limits', 'payout'), treeFeature('report', null)]),
        treeDomain('quiet', []),
      ],
      counts: {
        root: { items: 0, pending: 0, open: 0, comments: 0 },
        domains: { bank: { items: 2, pending: 2, open: 0, comments: 0 } },
        features: { limits: { items: 2, pending: 2, open: 0, comments: 0 } },
      },
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

describe('IntentTreeBrowser open questions', () => {
  const tree = {
    domains: [
      treeDomain('bank', [treeFeature('payout', null), treeFeature('limits', 'payout'), treeFeature('report', null)]),
      treeDomain('quiet', []),
    ],
    counts: {
      root: { items: 0, pending: 0, open: 0, comments: 0 },
      domains: {
        bank: { items: 5, pending: 1, open: 2, comments: 0 },
        quiet: { items: 1, pending: 1, open: 0, comments: 0 },
      },
      features: {
        limits: { items: 2, pending: 0, open: 1, comments: 0 },
        report: { items: 3, pending: 1, open: 1, comments: 0 },
      },
    },
  };

  it('badges the open questions and, filtered, keeps only the nodes with one at or below them', () => {
    const toggled: string[] = [];
    renderBrowser({
      ...tree,
      onlyOpenQuestions: true,
      onToggleOnlyOpenQuestions: () => toggled.push('open'),
    });

    // The domain (subtree), the parent feature (rolled up) and the two features holding one.
    expect(screen.getByTitle('2 open questions')).toBeInTheDocument();
    expect(screen.getAllByTitle('1 open question')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /payout/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /quiet/ })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Only with open questions' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    toggle.click();
    expect(toggled).toEqual(['open']);
  });

  it('combines with "Only with proposals": a node must hold both', () => {
    renderBrowser({
      ...tree,
      onlyPending: true,
      onToggleOnlyPending: () => undefined,
      onlyOpenQuestions: true,
      onToggleOnlyOpenQuestions: () => undefined,
    });

    expect(screen.getByRole('button', { name: /bank/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report/ })).toBeInTheDocument();
    // An open question but no proposal at or below it.
    expect(screen.queryByRole('button', { name: /payout/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /limits/ })).not.toBeInTheDocument();
    // A proposal but no open question.
    expect(screen.queryByRole('button', { name: /quiet/ })).not.toBeInTheDocument();
  });
});

describe('IntentTreeBrowser open comments', () => {
  it('badges nodes with open threads and, filtered, keeps only those with one at or below them', () => {
    const toggled: string[] = [];
    renderBrowser({
      domains: [
        treeDomain('bank', [treeFeature('payout', null), treeFeature('limits', 'payout'), treeFeature('report', null)]),
        treeDomain('quiet', []),
      ],
      counts: {
        root: { items: 0, pending: 0, open: 0, comments: 0 },
        domains: {
          bank: { items: 5, pending: 0, open: 0, comments: 3 },
          quiet: { items: 1, pending: 0, open: 0, comments: 0 },
        },
        features: { limits: { items: 2, pending: 0, open: 0, comments: 3 } },
      },
      onlyOpenComments: true,
      onToggleOnlyOpenComments: () => toggled.push('comments'),
    });

    // The domain, the parent feature (rolled up from its sub-feature) and the sub-feature itself.
    expect(screen.getAllByTitle('3 open comments')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /payout/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /quiet/ })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Only with open comments' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    toggle.click();
    expect(toggled).toEqual(['comments']);
  });
});
