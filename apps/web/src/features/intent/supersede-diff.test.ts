import { describe, expect, it } from 'vitest';
import { supersedeDiffRows } from './supersede-diff.js';
import { IntentAuthority, IntentItemKind, type IntentContextMatch } from './types.js';

const base: IntentContextMatch = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 30 days',
  authority: IntentAuthority.Accepted,
  version: 3,
  domainId: null,
  featureId: null,
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  statement: 'A refund can be issued within 30 days.',
  rationale: null,
  payload: { window: '30d' },
  matchReason: 'exact',
  sources: [],
  anchors: [],
};

describe('supersedeDiffRows: appliesWhen (intent-dimensions §BR-8/UC-3)', () => {
  it('diffs the item-level appliesWhen as its own readable row, not JSON', () => {
    const successor: IntentContextMatch = { ...base, appliesWhen: [{ dimension: 'country', notIn: ['ua'] }] };
    const rows = supersedeDiffRows(base, successor);
    const row = rows.find((r) => r.label === 'Applies when');

    expect(row?.before).toBe('');
    expect(row?.after).toBe('country not in ua');
    expect(row?.changed).toBe(true);
  });

  it('reports no change when both sides carry the same conditions', () => {
    const withCondition: IntentContextMatch = { ...base, appliesWhen: [{ dimension: 'plan', in: ['pro'] }] };
    const rows = supersedeDiffRows(withCondition, { ...withCondition });
    const row = rows.find((r) => r.label === 'Applies when');

    expect(row?.changed).toBe(false);
  });
});
