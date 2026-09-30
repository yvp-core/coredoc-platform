import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntentAuthority,
  IntentItemKind,
  IntentSourceKind,
  type IntentContextMatch,
} from '../../../shared/intent-types.js';
import {
  IntentSupersedeDiff,
  flattenPayload,
  supersedeDiffRows,
  type IntentSupersedeDiffProps,
} from './IntentSupersedeDiff';

// Pure-props component; `window.electronAPI` is mocked EMPTY on purpose (repo rule).
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

const base: IntentContextMatch = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 30 days',
  authority: IntentAuthority.Accepted,
  version: 3,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  statement: 'A refund can be issued within 30 days.',
  rationale: null,
  payload: { window: '30d', channels: ['card', 'bank'], scope: { region: 'EU' } },
  matchReason: 'exact',
  sources: [
    {
      kind: IntentSourceKind.Spec,
      ref: 'spec/refunds',
      localId: '§4',
      revision: null,
      locator: null,
      title: null,
      url: null,
    },
  ],
  anchors: [],
};

const successor: IntentContextMatch = {
  ...base,
  id: 'br-refunds-window-v2',
  version: 1,
  authority: IntentAuthority.Candidate,
  proposedSuccessorOfId: 'br-refunds-window',
  statement: 'A refund can be issued within 60 days.',
  payload: { window: '60d', channels: ['card', 'bank'], scope: { region: 'EU' }, note: 'per legal' },
};

function render(overrides: Partial<IntentSupersedeDiffProps> = {}): string {
  const props: IntentSupersedeDiffProps = {
    predecessorId: 'br-refunds-window',
    predecessorVersion: 3,
    predecessor: base,
    successor,
    defaultOpen: true,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentSupersedeDiff, props));
}

describe('flattenPayload', () => {
  it('flattens nested objects by dotted key and joins arrays by line', () => {
    expect(flattenPayload({ a: 1, b: { c: 'x' }, d: ['p', 'q'] })).toEqual({
      a: '1',
      'b.c': 'x',
      d: 'p\nq',
    });
  });

  it('treats an absent payload as no fields at all, never as an empty string field', () => {
    expect(flattenPayload(null)).toEqual({});
    expect(flattenPayload(undefined)).toEqual({});
  });

  it('keeps a scalar payload comparable under a single key', () => {
    expect(flattenPayload('free text')).toEqual({ value: 'free text' });
  });
});

describe('supersedeDiffRows', () => {
  it('compares statement, every payload field and the sources', () => {
    const rows = supersedeDiffRows(base, successor);
    const labels = rows.map((row) => row.label);

    expect(labels[0]).toBe('Statement');
    expect(labels).toContain('window');
    expect(labels).toContain('scope.region');
    expect(labels).toContain('note');
    expect(labels[labels.length - 1]).toBe('Sources');
  });

  it('marks only what actually differs as changed', () => {
    const rows = supersedeDiffRows(base, successor);
    const changed = rows.filter((row) => row.changed).map((row) => row.label);

    expect(changed).toEqual(['Statement', 'window', 'note']);
    // A field only the successor has diffs against an empty "before".
    expect(rows.find((row) => row.label === 'note')?.before).toBe('');
  });

  it('diffs the item-level appliesWhen as its own row, readable, not JSON', () => {
    const conditioned: IntentContextMatch = {
      ...successor,
      appliesWhen: [{ dimension: 'country', notIn: ['ua'] }],
    };
    const rows = supersedeDiffRows(base, conditioned);
    const row = rows.find((r) => r.label === 'Applies when');

    expect(row?.before).toBe('');
    expect(row?.after).toBe('country not in ua');
    expect(row?.changed).toBe(true);
  });
});

describe('IntentSupersedeDiff', () => {
  it('is collapsed by default and names the predecessor with its version', () => {
    const html = renderToStaticMarkup(
      createElement(IntentSupersedeDiff, {
        predecessorId: 'br-refunds-window',
        predecessorVersion: 3,
        predecessor: base,
        successor,
      } satisfies IntentSupersedeDiffProps),
    );

    expect(html).toContain('Proposes to replace');
    expect(html).toContain('(v3)');
    expect(html).toContain('Show diff');
    expect(html).not.toContain('A refund can be issued within 60 days.');
  });

  it('shows old and new values and collapses the unchanged ones behind a count', () => {
    const html = render();

    expect(html).toContain('A refund can be issued within 30 days.');
    expect(html).toContain('A refund can be issued within 60 days.');
    expect(html).toContain('line-through');
    // Applies when, channels, scope.region and Sources are identical on both items.
    expect(html).toContain('4 unchanged fields');
  });

  it('says a predecessor is not loaded rather than rendering an empty diff', () => {
    const html = render({ predecessor: undefined });
    expect(html).toContain('Predecessor not loaded');
    expect(html).not.toContain('unchanged');
  });

  it('says the same about the successor half when the queue row carries no record', () => {
    const html = render({ successor: undefined });
    expect(html).toContain('Successor detail not loaded');
  });

  it('reports a restatement as a restatement instead of an empty list', () => {
    const html = render({ successor: { ...base, id: 'br-refunds-window-v2' } });
    expect(html).toContain('the successor restates the predecessor');
  });
});

describe('IntentSupersedeDiff read state and washes', () => {
  it('says the predecessor is being READ while its by-id query is in flight', () => {
    // A record that has not arrived is not a record that could not be read.
    const html = render({ predecessor: undefined, predecessorLoading: true });

    expect(html).toContain('Reading the predecessor…');
    expect(html).not.toContain('could not be read');
  });

  it('claims the miss only once that read has settled', () => {
    const html = render({ predecessor: undefined, predecessorLoading: false });

    expect(html).toContain('Predecessor not loaded');
    expect(html).not.toContain('Reading the predecessor');
  });

  it('paints old and new on the shipped tag washes, not on alpha over a fill token', () => {
    const html = render();

    expect(html).toContain('bg-bg-tag-warning');
    expect(html).toContain('bg-bg-tag-success');
    expect(html).not.toContain('bg-bg-warning/10');
    expect(html).not.toContain('bg-content-brand/10');
  });
});
