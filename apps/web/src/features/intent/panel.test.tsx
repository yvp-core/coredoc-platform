import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntentPanel } from './panel.js';

const rows = Array.from({ length: 225 }, (_, i) => ({
  id: `br-rule-${i}`,
  title: `Rule ${i}`,
  authority: 'accepted',
  effectivity: i >= 220 ? 'planned' : 'unknown',
  kind: 'business_rule',
  version: 1,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  openCommentCount: i === 5 ? 1 : 0,
  ...(i === 2 ? { conditions: { own: [{ dimension: 'country', notIn: ['br'] }], variants: 2 } } : {}),
}));
const DIMENSIONS = [
  {
    id: 'country',
    title: 'Country',
    multi: false,
    values: [
      { id: 'br', title: 'Brazil' },
      { id: 'us', title: 'United States' },
    ],
  },
  { id: 'plan', title: 'Plan', multi: false, values: [{ id: 'pro', title: 'Pro' }] },
  { id: 'product', title: 'Product', multi: true, values: [{ id: 'ta', title: 'Time & Attendance' }] },
];
const PREVIEW_ENTRIES = [
  {
    id: 'br-us-only',
    kind: 'business_rule',
    title: 'US-only rule',
    authority: 'accepted',
    version: 1,
    domainId: null,
    featureId: null,
    matchReason: 'default',
    contextMatch: { state: 'match', open: [] },
    conditions: { own: [{ dimension: 'country', in: ['us', 'br'] }] },
  },
  {
    id: 'br-plan-rule',
    kind: 'business_rule',
    title: 'Plan-dependent rule',
    authority: 'accepted',
    version: 1,
    domainId: null,
    featureId: null,
    matchReason: 'default',
    contextMatch: { state: 'open', open: ['plan'] },
    conditions: { inherited: true },
  },
];
let treeDomains: unknown[] = [];
let contextListCalls = 0;
beforeEach(() => {
  treeDomains = [];
  contextListCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'http://local.test');
      if (u.pathname.endsWith('/sources'))
        return new Response(
          JSON.stringify({ sources: [{ kind: 'spec', ref: 'spec/uploads', title: 'Uploads spec' }], truncated: false }),
        );
      if (u.pathname.endsWith('/tree'))
        return new Response(
          // The product-root count is what keeps a domain-less workspace out of onboarding.
          JSON.stringify({ root: { itemCount: rows.length, pendingCount: 0 }, domains: treeDomains, nextCursor: null }),
        );
      if (u.pathname.endsWith('/document'))
        return new Response(
          JSON.stringify({
            node: { kind: 'root', id: null, title: 'Product root', domainId: null },
            sections: [],
            related: [],
            features: [],
            domains: [],
            overview: null,
            moreDomains: 0,
            delivery: { effective: 0, planned: 0, unrecorded: 0 },
            truncated: false,
          }),
        );
      if (u.pathname.endsWith('/dimensions')) return new Response(JSON.stringify({ dimensions: DIMENSIONS }));
      if (u.pathname.endsWith('/context') && u.searchParams.get('mode') !== 'list') {
        const row = rows.find((entry) => entry.id === u.searchParams.get('intentIds'));
        const matches = row
          ? [
              {
                ...row,
                statement: row.title,
                rationale: null,
                payload: null,
                matchReason: 'id',
                sources: [],
                anchors: [],
              },
            ]
          : [];
        return new Response(JSON.stringify({ mode: 'context', matches, graph: null }));
      }
      if (u.pathname.endsWith('/context')) {
        contextListCalls += 1;
        const hasCursor = u.searchParams.get('cursor') !== null;
        return new Response(
          JSON.stringify({
            mode: 'list',
            // Second page's entries don't matter for these assertions; only that a
            // second fetch happened and the first page's contextExcluded is kept.
            entries: hasCursor ? [] : PREVIEW_ENTRIES,
            nextCursor: hasCursor ? null : 'p2',
            truncated: false,
            contextExcluded: 3,
          }),
        );
      }
      if (u.pathname.endsWith('/items')) {
        const offset = Number(u.searchParams.get('cursor') ?? 0);
        const limit = Number(u.searchParams.get('limit') ?? 100);
        const search = (u.searchParams.get('search') ?? '').toLowerCase();
        const matching = rows.filter(
          (row) =>
            `${row.id} ${row.title}`.toLowerCase().includes(search) &&
            (!u.searchParams.get('effectivity') || row.effectivity === u.searchParams.get('effectivity')) &&
            (!u.searchParams.get('sourceRef') || row.id === 'br-rule-224') &&
            (u.searchParams.get('openQuestions') !== 'true' || row.id === 'br-rule-7') &&
            (u.searchParams.get('openComments') !== 'true' || row.openCommentCount > 0),
        );
        return new Response(
          JSON.stringify({
            items: matching.slice(offset, offset + limit),
            nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
          }),
        );
      }
      throw new Error(`Unexpected request ${u.pathname}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
/** The browse cases exercise the catalogue list, so they switch the centre column to it. */
async function mount() {
  function Wrapper() {
    const [id, setId] = useState<string | null>(null);
    return <IntentPanel workspaceId="test-ws" role={String('admin')} selectedItemId={id} onSelectItem={setId} />;
  }
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Wrapper />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'List' }));
  return view;
}
it('keeps selected rules when the catalogue filter hides them and clears them from the basket', async () => {
  await mount();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Rule 1 for delivery' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Rule 99' } });
  await screen.findByRole('checkbox', { name: 'Select Rule 99 for delivery' });
  expect(screen.queryByRole('checkbox', { name: 'Select Rule 0 for delivery' })).not.toBeInTheDocument();
  expect(screen.getByText('2 rules selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  expect(await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' })).not.toBeChecked();
});
it('selects loaded results explicitly and enforces the 200-rule confirmation bound across pages', async () => {
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Select visible rules (up to 200 more)' }));
  expect(screen.getByText('100 rules selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more items' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 199 for delivery' });
  fireEvent.click(screen.getByRole('button', { name: 'Select visible rules (up to 100 more)' }));
  expect(screen.getByText('200 rules selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more items' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Rule 224 for delivery' })).toBeDisabled());
  expect(screen.getByRole('checkbox', { name: 'Select Rule 0 for delivery' })).toBeEnabled();
  // Pages through 200+ rules; under a full parallel `pnpm test` the default 15s is not enough.
}, 30_000);

it('searches beyond loaded pages and selects the complete matching set', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Rule 22' } });
  await screen.findByRole('checkbox', { name: 'Select Rule 224 for delivery' });
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching rules' }));
  await screen.findByText('6 rules selected');
});
it('refuses oversized matching sets without partially changing the basket', async () => {
  await mount();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching rules' }));
  await screen.findByText(/More than 200 rules match/);
  expect(screen.getByText('1 rule selected')).toBeInTheDocument();
});

it('filters production states before paging and keeps the filter for bulk selection', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Production status' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Planned' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 224 for delivery' });
  expect(screen.queryByRole('checkbox', { name: 'Select Rule 0 for delivery' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching rules' }));
  await screen.findByText('5 rules selected');
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Production status' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'All production states' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.getByText('5 rules selected')).toBeInTheDocument();
});
it('selects an exact source and applies it to the catalogue and bulk selection', async () => {
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Choose spec or issue' }));
  fireEvent.click(await screen.findByRole('button', { name: /Uploads spec/ }));
  await screen.findByRole('checkbox', { name: 'Select Rule 224 for delivery' });
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching rules' }));
  await screen.findByText('1 rule selected');
  fireEvent.click(screen.getByRole('button', { name: 'Clear source filter' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.getByText('1 rule selected')).toBeInTheDocument();
});

it('narrows the list to open questions from the tree toggle, and clears both from the list chip', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  const toggle = screen.getByRole('button', { name: 'Only with open questions' });
  fireEvent.click(toggle);
  await screen.findByRole('checkbox', { name: 'Select Rule 7 for delivery' });
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'Select Rule 0 for delivery' })).not.toBeInTheDocument(),
  );
  const chip = screen.getByRole('button', { name: 'Open questions only' });
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Bulk selection honours the same narrowed query.
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching rules' }));
  await screen.findByText('1 rule selected');

  fireEvent.click(chip);
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.getByRole('button', { name: 'Only with open questions' })).toHaveAttribute('aria-pressed', 'false');
});

it('shows condition chips on browse rows', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 2 for delivery' });
  expect(screen.getByText('not Brazil')).toBeInTheDocument();
  expect(screen.getByText('2 variants')).toBeInTheDocument();
});

it('previews the list as a reader context through the context read, and clears back', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Country' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Brazil' }));

  expect(await screen.findByText('3 rules hidden by these conditions')).toBeInTheDocument();
  expect(screen.getByText('US-only rule')).toBeInTheDocument();
  expect(screen.getByText('United States, Brazil')).toBeInTheDocument();
  expect(screen.getByText('inherited')).toBeInTheDocument();
  expect(screen.getByText('depends on Plan')).toBeInTheDocument();
  expect(screen.queryByText('Rule 0')).not.toBeInTheDocument();

  const contextCall = vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), 'http://local.test'))
    .find((u) => u.pathname.endsWith('/context'));
  expect(contextCall?.searchParams.get('mode')).toBe('list');
  expect(contextCall?.searchParams.get('context')).toBe('{"country":"br"}');

  fireEvent.click(screen.getByRole('button', { name: 'Clear preview' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.queryByText(/rules hidden by these conditions/)).not.toBeInTheDocument();
});

const contextListUrls = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), 'http://local.test'))
    .filter((u) => u.pathname.endsWith('/context') && u.searchParams.get('mode') === 'list');

it('previews a multi dimension as "none of these" with an explicit empty list', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.click(await screen.findByRole('button', { name: 'None' }));

  expect(await screen.findByText('3 rules hidden by these conditions')).toBeInTheDocument();
  expect(contextListUrls().at(-1)?.searchParams.get('context')).toBe('{"product":[]}');

  // A value chip replaces "none"; removing the last value returns to "not set".
  fireEvent.click(screen.getByRole('button', { name: 'Time & Attendance' }));
  await waitFor(() => expect(contextListUrls().at(-1)?.searchParams.get('context')).toBe('{"product":["ta"]}'));
  expect(screen.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Time & Attendance' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.queryByText(/rules hidden by these conditions/)).not.toBeInTheDocument();
});

it('previews every selected kind through the context read, not a browser-side filter', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.click(screen.getByRole('button', { name: 'Use case' }));
  fireEvent.click(screen.getByRole('button', { name: 'Business rule' }));
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Country' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Brazil' }));

  expect(await screen.findByText('US-only rule')).toBeInTheDocument();
  expect(contextListUrls().at(-1)?.searchParams.getAll('kind')).toEqual(['business_rule,use_case']);
});

it('labels the hidden count as a lower bound once a second preview page has loaded', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Country' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Brazil' }));

  expect(await screen.findByText('3 rules hidden by these conditions')).toBeInTheDocument();

  fireEvent.click(await screen.findByRole('button', { name: 'Load more items' }));

  // Second page's own contextExcluded is not re-summed (it would double-count
  // rows the first page's window already scanned) — the first page's count
  // stands, now flagged as a lower bound instead of an exact total.
  expect(await screen.findByText('at least 3 rules hidden by these conditions')).toBeInTheDocument();
  expect(screen.queryByText('3 rules hidden by these conditions')).not.toBeInTheDocument();
});

it('disables "select all matching" while a context preview is active, so hidden rules cannot land in the basket', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  const selectAllButton = screen.getByRole('button', { name: 'Select all matching rules' });
  expect(selectAllButton).toBeEnabled();

  fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Country' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'Brazil' }));
  await screen.findByText('3 rules hidden by these conditions');

  expect(selectAllButton).toBeDisabled();
  expect(selectAllButton).toHaveAttribute('title', expect.stringContaining('context preview'));

  fireEvent.click(screen.getByRole('button', { name: 'Clear preview' }));
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.getByRole('button', { name: 'Select all matching rules' })).toBeEnabled();
});

it('opens the node panel for a selected domain, and returns to it from a rule', async () => {
  treeDomains = [
    {
      id: 'billing',
      title: 'Billing',
      statement: 'Invoices and payments.',
      archived: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      appliesWhen: [{ dimension: 'country', notIn: ['br'] }],
      itemCount: 0,
      pendingCount: 0,
      subtreeItemCount: 0,
      subtreePendingCount: 0,
      features: [],
      featuresTruncated: false,
    },
  ];
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
  expect(await screen.findByText('Invoices and payments.')).toBeInTheDocument();
  expect(screen.getByText('country not in br')).toBeInTheDocument();
  expect(screen.getByText('These conditions filter every rule below this domain.')).toBeInTheDocument();

  fireEvent.click(await screen.findByRole('button', { name: /^Rule 0 / }));
  fireEvent.click(await screen.findByRole('button', { name: '← Back to Billing' }));
  expect(await screen.findByText('Invoices and payments.')).toBeInTheDocument();
});

it('keeps one item pane per selection when switching between items', async () => {
  await mount();
  fireEvent.click(await screen.findByText('Rule 0'));
  await screen.findByText('Needs a fix');
  fireEvent.click(screen.getByText('Rule 1'));
  await screen.findByRole('heading', { name: 'Rule 1' });
  fireEvent.click(screen.getByText('Rule 2'));
  await screen.findByRole('heading', { name: 'Rule 2' });
  expect(screen.getAllByText('Needs a fix')).toHaveLength(1);
});

it('narrows the list to items with open comment threads and marks them', async () => {
  await mount();
  await screen.findByRole('checkbox', { name: 'Select Rule 0 for delivery' });
  expect(screen.getByText('1 open comment')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Open comments only' }));
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'Select Rule 0 for delivery' })).not.toBeInTheDocument(),
  );
  expect(await screen.findByRole('checkbox', { name: 'Select Rule 5 for delivery' })).toBeInTheDocument();
});

it('keeps the nodes with open comment threads when the structure is filtered to them', async () => {
  const domain = (id: string, subtreeOpenCommentCount: number, features: unknown[] = []) => ({
    id,
    title: id,
    statement: '',
    archived: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    itemCount: 1,
    pendingCount: 0,
    openQuestionCount: 0,
    openCommentCount: 0,
    subtreeItemCount: 1,
    subtreePendingCount: 0,
    subtreeOpenQuestionCount: 0,
    subtreeOpenCommentCount,
    features,
    featuresTruncated: false,
  });
  const feature = (id: string, domainId: string, openCommentCount: number) => ({
    id,
    title: id,
    domainId,
    parentFeatureId: null,
    statement: '',
    archived: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    itemCount: 1,
    pendingCount: 0,
    openQuestionCount: 0,
    openCommentCount,
  });
  treeDomains = [
    domain('cloud', 1, [feature('create-cloud-account', 'cloud', 1), feature('billing-setup', 'cloud', 0)]),
    domain('graph', 0),
  ];
  await mount();
  await screen.findByRole('button', { name: /graph/ });

  fireEvent.click(screen.getByRole('button', { name: 'Only with open comments' }));
  expect(await screen.findByRole('button', { name: /create-cloud-account/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^cloud/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /billing-setup/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /graph/ })).not.toBeInTheDocument();
});
