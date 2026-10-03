import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntentDocumentView } from './document-view.js';
import { IntentAuthority, IntentItemKind, type IntentDocumentItem, type IntentNodeDocument } from './types.js';

afterEach(cleanup);

const item = (id: string, statement: string, extra: Partial<IntentDocumentItem> = {}): IntentDocumentItem => ({
  id,
  kind: IntentItemKind.BusinessRule,
  title: id,
  statement,
  body: [],
  authority: IntentAuthority.Accepted,
  version: 1,
  effectivity: 'effective',
  openQuestion: false,
  proposedSuccessorOfId: null,
  appliesWhen: [],
  pendingSuccessor: null,
  ...extra,
});

const DOCUMENT: IntentNodeDocument = {
  node: { kind: 'feature', id: 'refunds', title: 'Refunds', domainId: 'billing' },
  sections: [
    { heading: null, blocks: [{ type: 'prose', lines: ['Money goes back to the original method.'] }] },
    {
      heading: 'Rules',
      blocks: [
        {
          type: 'item',
          style: 'bullet',
          item: item('br-window', 'Refunds within 14 days.', {
            pendingSuccessor: { id: 'br-window-v2', title: 'Window', statement: 'Refunds within 30 days.', version: 1 },
          }),
        },
        {
          type: 'item',
          style: 'bullet',
          item: item('br-chargeback', 'No refund during a chargeback.', { authority: IntentAuthority.Candidate }),
        },
      ],
    },
  ],
  related: [{ kind: 'feature', id: 'invoices', title: 'Invoices', why: 'Credit notes' }],
  features: [],
  domains: [],
  overview: null,
  moreDomains: 0,
  delivery: { effective: 1, planned: 0, unrecorded: 1 },
  truncated: false,
};

it('renders the node as a document, marks proposals in place and opens what is clicked', () => {
  const onSelectItem = vi.fn();
  const onOpenNode = vi.fn();
  render(
    <IntentDocumentView
      document={DOCUMENT}
      loading={false}
      includeCandidates
      selectedItemId={null}
      onToggleCandidates={() => undefined}
      onSelectItem={onSelectItem}
      onOpenNode={onOpenNode}
      onRetry={() => undefined}
    />,
  );

  expect(screen.getByRole('heading', { level: 1, name: 'Refunds' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'Rules' })).toBeTruthy();
  expect(screen.getByText('Proposed')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Change proposed/ }));
  expect(onSelectItem).toHaveBeenLastCalledWith('br-window-v2');
  fireEvent.click(screen.getByRole('button', { name: /Refunds within 14 days/ }));
  expect(onSelectItem).toHaveBeenLastCalledWith('br-window');
  fireEvent.click(screen.getByRole('button', { name: 'Invoices' }));
  expect(onOpenNode).toHaveBeenCalledWith('feature', 'invoices');
});

it('reads the product root as the whole product: domains with counts open in the tree, delivery across everything', () => {
  const onOpenNode = vi.fn();
  render(
    <IntentDocumentView
      document={{
        node: { kind: 'root', id: null, title: 'Product root', domainId: null },
        sections: [],
        related: [],
        features: [],
        domains: [
          {
            id: 'absence',
            title: 'Absence Management',
            itemCount: 44,
            pendingCount: 3,
            openQuestionCount: 2,
            effective: 30,
          },
          { id: 'billing', title: 'Billing', itemCount: 1, pendingCount: 0, openQuestionCount: 0, effective: 1 },
        ],
        overview: { itemCount: 45, pendingCount: 3, openQuestionCount: 2 },
        moreDomains: 0,
        delivery: { effective: 31, planned: 2, unrecorded: 10 },
        truncated: false,
      }}
      loading={false}
      includeCandidates
      selectedItemId={null}
      onToggleCandidates={() => undefined}
      onSelectItem={() => undefined}
      onOpenNode={onOpenNode}
      onRetry={() => undefined}
    />,
  );

  expect(screen.getByText('The whole product: 2 domains, 45 items.')).toBeTruthy();
  const absence = screen.getByRole('button', { name: /Absence Management/ });
  expect(absence.textContent).toContain('44 items');
  expect(absence.textContent).toContain('30 in production');
  expect(screen.getByTitle('3 waiting for review')).toBeTruthy();
  expect(screen.getByTitle('2 open questions')).toBeTruthy();
  // No root-attached items: the domain list is the content, not an empty-node notice.
  expect(screen.queryByText(/No items are attached here/)).toBeNull();
  expect(screen.queryByText('Product-wide items')).toBeNull();
  expect(
    screen.getByText(/31 in production, 2 planned, 10 with no delivery record across the whole product/),
  ).toBeTruthy();

  fireEvent.click(absence);
  expect(onOpenNode).toHaveBeenCalledWith('domain', 'absence');
});
