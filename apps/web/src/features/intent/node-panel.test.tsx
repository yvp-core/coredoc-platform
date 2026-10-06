import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { IntentNodePanel } from './node-panel.js';
import type { IntentDimension, IntentDomainView } from './types.js';

afterEach(cleanup);

const DIMENSIONS: IntentDimension[] = [
  { id: 'country', title: 'Country', multi: false, values: [{ id: 'pl', title: 'Poland' }] },
  { id: 'product', title: 'Product', multi: true, values: [{ id: 'shifts', title: 'Shifts' }] },
];
const node = (id: string, title: string, appliesWhen?: IntentDomainView['appliesWhen']): IntentDomainView => ({
  id,
  title,
  statement: `${title} statement.`,
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...(appliesWhen ? { appliesWhen } : {}),
});
const DOMAIN = node('shifts', 'Shifts', [{ dimension: 'product', in: ['shifts'] }]);

it('shows a feature’s own conditions, the domain’s labelled by source, scope and dimensions', () => {
  render(
    <IntentNodePanel
      domain={DOMAIN}
      feature={node('swap-pl', 'Swaps in Poland', [{ dimension: 'country', in: ['pl'] }])}
      dimensions={DIMENSIONS}
      count={{ items: 4, pending: 1, open: 0, comments: 0 }}
      seeds={[{ repoKey: 'app', nodeId: 'swap.ts', note: null, createdBy: 'u', createdAt: '2026-09-01T00:00:00.000Z' }]}
      seedsTruncated={false}
    />,
  );
  expect(screen.getByText('Swaps in Poland statement.')).toBeInTheDocument();
  expect(screen.getByText('country in pl')).toBeInTheDocument();
  expect(screen.getByText('product in shifts')).toBeInTheDocument();
  expect(screen.getByText('from domain Shifts')).toBeInTheDocument();
  expect(screen.getByText('These conditions filter every rule below this feature.')).toBeInTheDocument();
  expect(screen.getByText('4 rules · 1 candidate')).toBeInTheDocument();
  expect(screen.getByText(': Poland', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('app · swap.ts')).toBeInTheDocument();
});

it('says a domain without conditions always applies, and shows no seeds section', () => {
  render(
    <IntentNodePanel
      domain={node('billing', 'Billing')}
      feature={null}
      dimensions={DIMENSIONS}
      count={null}
      seeds={null}
      seedsTruncated={false}
    />,
  );
  expect(screen.getByText('Always — this domain sets no conditions.')).toBeInTheDocument();
  expect(screen.getByText('Not counted yet')).toBeInTheDocument();
  expect(screen.queryByText('Seeds')).not.toBeInTheDocument();
});
