import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentItemDetail } from './item-detail.js';
import { IntentAuthority, IntentItemKind, type IntentContextMatch } from './types.js';

afterEach(cleanup);

// A candidate carrying both an item-level condition and rule variants
// (intent-dimensions spec, worked example): AC-8 requires the readable clause
// text and the variant table cells to actually appear, not merely that
// *something* non-empty rendered.
const MATCH: IntentContextMatch = {
  id: 'br-weekly-overtime-threshold',
  kind: IntentItemKind.BusinessRule,
  title: 'Weekly overtime threshold',
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-09-26T00:00:00.000Z',
  statement: 'Hours worked above the weekly threshold count as overtime.',
  rationale: null,
  appliesWhen: [{ dimension: 'country', notIn: ['ua'] }],
  payload: {
    condition: 'Weekly worked hours exceed the threshold',
    requiredOutcome: 'Hours above the threshold count as overtime',
    observer: 'Payroll export',
    variants: [
      { when: { country: 'de' }, outcome: '40h' },
      { outcome: 'contractHoursPerWeek × 1.1, capped at 48h', inputs: ['contractHoursPerWeek'] },
    ],
  },
  matchReason: 'exact_id',
  sources: [],
  anchors: [],
};

describe('IntentItemDetail inherited conditions (intent-dimensions-inheritance UC-3)', () => {
  it('shows an inherited group above the item own clauses, each labelled by its source', () => {
    const match: IntentContextMatch = {
      ...MATCH,
      domainId: 'shifts',
      featureId: 'overtime',
      appliesWhen: [{ dimension: 'role', in: ['manager'] }],
      inheritedConditions: {
        domain: [{ dimension: 'product', in: ['shifts'] }],
        feature: [{ dimension: 'country', in: ['de', 'pl'] }],
      },
    };

    render(
      <IntentItemDetail
        itemId={match.id}
        match={match}
        graph={null}
        transitions={[]}
        loading={false}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText('product in shifts')).toBeInTheDocument();
    expect(screen.getByText('from domain shifts')).toBeInTheDocument();
    expect(screen.getByText('country in de, pl')).toBeInTheDocument();
    expect(screen.getByText('from feature overtime')).toBeInTheDocument();
    expect(screen.getByText('role in manager')).toBeInTheDocument();
  });
});

describe('IntentItemDetail with conditions and variants (AC-8)', () => {
  it('shows the readable clause and both variant rows, not JSON', () => {
    render(
      <IntentItemDetail
        itemId={MATCH.id}
        match={MATCH}
        graph={null}
        transitions={[]}
        loading={false}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText('country not in ua')).toBeInTheDocument();
    expect(screen.getByText('country = de')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('40h')).toBeInTheDocument();
    expect(screen.getByText('contractHoursPerWeek × 1.1, capped at 48h')).toBeInTheDocument();
    expect(screen.getByText('contractHoursPerWeek')).toBeInTheDocument();
    // The generic grid still carries the rest of the payload.
    expect(screen.getByText('Payroll export')).toBeInTheDocument();
  });
});

describe('IntentItemDetail text', () => {
  it('shows the statement and the body lines as one text, without inline source refs', () => {
    const match: IntentContextMatch = {
      ...MATCH,
      kind: IntentItemKind.Flow,
      payload: null,
      appliesWhen: undefined,
      statement: 'An employee signs in with SSO. *(jira:ACME-308)*',
      body: ['1. **Start.** The employee picks SSO.', '2. **Return.** The app opens their company.'],
    };
    render(
      <IntentItemDetail
        itemId={match.id}
        match={match}
        graph={null}
        transitions={[]}
        loading={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('An employee signs in with SSO.')).toBeInTheDocument();
    expect(screen.getByText('The employee picks SSO.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('The app opens their company.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/ACME-308/)).toBeNull();
  });
});
