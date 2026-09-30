import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthoringHintKind,
  INTENT_VERSION_CONFLICT_CODE,
  IntentAuthority,
  IntentItemKind,
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentContextMatch,
  type IntentReviewDecisionResult,
  type IntentReviewQueueItem,
} from '../../../shared/intent-types.js';
import {
  IntentReviewQueue,
  groupQueueByDomain,
  stagedActionClass,
  stagedBorderClass,
  type IntentReviewQueueProps,
} from './IntentReviewQueue';

// Node-environment render harness (vitest.config.ts has no jsdom/@testing-library).
// window.electronAPI is fully mocked and EMPTY: IntentReviewQueue is pure-props — every
// submit goes out through the injected callback, never through the bridge — so an empty
// mock is itself the proof that no real IPC hides in this component (repo rule).
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

const CANDIDATE: IntentReviewQueueItem = {
  id: 'lim-no-partial-refund',
  kind: IntentItemKind.Limitation,
  title: 'Partial refunds are not supported',
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

const REPLACEMENT: IntentReviewQueueItem = {
  ...CANDIDATE,
  id: 'br-refunds-window-v2',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 60 days',
  proposedSuccessorOfId: 'br-refunds-window',
};

const record = (id: string, statement: string): IntentContextMatch => ({
  id,
  kind: IntentItemKind.BusinessRule,
  title: id,
  authority: IntentAuthority.Candidate,
  version: 1,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-30T00:00:00.000Z',
  statement,
  rationale: null,
  payload: null,
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
});

function render(overrides: Partial<IntentReviewQueueProps> = {}): string {
  const props: IntentReviewQueueProps = {
    candidates: [CANDIDATE, REPLACEMENT],
    predecessorVersions: { 'br-refunds-window': 3 },
    loading: false,
    submitting: false,
    results: null,
    onSubmit: () => undefined,
    onRefetchConflicts: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentReviewQueue, props));
}

describe('groupQueueByDomain', () => {
  it('keeps the server order between domains and puts the product root LAST', () => {
    const rows = [
      { ...CANDIDATE, id: 'a', domainId: null },
      { ...CANDIDATE, id: 'b', domainId: 'payments' },
      { ...CANDIDATE, id: 'c', domainId: 'billing' },
      { ...CANDIDATE, id: 'd', domainId: 'payments' },
    ];
    const groups = groupQueueByDomain(rows);

    expect(groups.map((group) => group.domainId)).toEqual(['payments', 'billing', null]);
    // Rows keep their order inside the group — the queue is oldest-first.
    expect(groups[0].items.map((item) => item.id)).toEqual(['b', 'd']);
  });

  it('returns nothing for an empty page', () => {
    expect(groupQueueByDomain([])).toEqual([]);
  });
});

describe('stagedBorderClass', () => {
  it('colours the card by the staged action, and only by it', () => {
    expect(stagedBorderClass(IntentReviewAction.Accept)).toBe('border-content-brand');
    // `content-warning` (red-700) is the BORDER token; `bg-warning` (red-600) is
    // a fill, and a hairline painted from it reads a shade off every other one.
    expect(stagedBorderClass(IntentReviewAction.Reject)).toBe('border-content-warning');
    expect(stagedBorderClass(IntentReviewAction.Defer)).toBe('border-border-tertiary');
    expect(stagedBorderClass(IntentReviewAction.NeedsEdit)).toBe('border-border-tertiary');
    expect(stagedBorderClass(undefined)).toBe('border-border-input');
  });
});

describe('IntentReviewQueue decision cards', () => {
  it('renders one card per candidate with its id, title and version', () => {
    const html = render();
    expect(html).toContain('Partial refunds are not supported');
    expect(html).toContain('lim-no-partial-refund');
    expect(html).toContain('Refunds close after 60 days');
    expect(html).toContain('v1');
  });

  it('groups the queue by domain and counts what is waiting in each', () => {
    const html = render({
      candidates: [{ ...CANDIDATE, domainId: null }, REPLACEMENT],
      domainNames: { payments: 'Payments' },
    });

    expect(html).toContain('Payments');
    expect(html).toContain('Product root');
    expect(html).toContain('1 waiting');
    // Product root is rendered after the named domain (spec §3.3).
    expect(html.indexOf('Payments')).toBeLessThan(html.indexOf('Product root'));
  });

  it('falls back to the domain id when no name was supplied', () => {
    expect(render()).toContain('payments');
  });

  it('shows the statement and source chips from the loaded candidate record', () => {
    const html = render({
      candidateItems: { 'lim-no-partial-refund': record('lim-no-partial-refund', 'Refunds are all-or-nothing.') },
    });

    expect(html).toContain('Refunds are all-or-nothing.');
    expect(html).toContain('spec/refunds#§4');
  });

  it('renders appliesWhen as a readable clause and payload variants as a table (gates IntentDetails inside the queue)', () => {
    const withConditions: IntentContextMatch = {
      ...record('br-refunds-window-v2', 'Refunds close after a window that depends on region.'),
      appliesWhen: [{ dimension: 'country', in: ['br'] }],
      payload: { variants: [{ when: { country: 'br' }, outcome: '60 days', inputs: ['country'] }] },
    };
    const html = render({ candidateItems: { 'br-refunds-window-v2': withConditions } });

    // The readable clause from `contextConditionText`, not the raw condition shape.
    expect(html).toContain('country in br');
    // The variant table's "when" cell from `variantWhenText`, and its outcome.
    expect(html).toContain('country = br');
    expect(html).toContain('60 days');
  });

  it('shows the candidate hints as a readable, non-blocking notice list (BR-3, BR-5)', () => {
    const html = render({
      candidates: [
        {
          ...CANDIDATE,
          hints: [
            { kind: AuthoringHintKind.MissingCondition, dimension: 'country', value: 'br', matched: 'Brazilian' },
            { kind: AuthoringHintKind.DeadVariant, variant: 2 },
          ],
        },
        REPLACEMENT,
      ],
    });

    expect(html).toContain('Mentions “Brazilian” (country = br) but has no country condition');
    expect(html).toContain('Variant 3 can never apply under the item');
  });

  it('renders a card with no loaded record without inventing a statement', () => {
    const html = render();
    expect(html).toContain('Partial refunds are not supported');
    expect(html).not.toContain('undefined');
  });

  it('shows the proposed-successor link and offers supersede on the SUCCESSOR card', () => {
    const html = render({ predecessorTitles: { 'br-refunds-window': 'Refunds close after 30 days' } });
    // The replacement candidate names the accepted item it intends to replace,
    // and its primary action reads as a supersession rather than a plain accept.
    expect(html).toContain('br-refunds-window');
    expect(html).toContain('Proposes to replace');
    expect(html).toContain('(v3)');
    expect(html).toContain('Show diff');
    expect(html).toContain('Supersede predecessor');
  });

  it('carries ONE provenance group beside the cards, never one per card', () => {
    const html = render();
    const groups = html.match(/Authorizing source/g) ?? [];
    expect(groups).toHaveLength(1);
    // The rule itself lives in the note under Submit, not in the field label.
    expect(html).not.toContain('Authorizing source · one per batch');
    expect(html).toContain('One authorizing source per batch · versions are checked on every item');
  });

  it('invites capture rather than reporting an error on an empty queue', () => {
    const html = render({ candidates: [] });
    expect(html).toContain('No candidates waiting. Capture and propose feed this queue.');
    // The batch panel stays, and its submit is disabled with nothing staged.
    expect(html).toContain('Submit decisions');
  });
});

describe('IntentReviewQueue version-conflict flow', () => {
  const conflicted: IntentReviewDecisionResult[] = [
    {
      decisionIndex: 0,
      itemId: 'lim-no-partial-refund',
      action: IntentReviewAction.Accept,
      outcome: IntentReviewOutcome.Refused,
      authority: IntentAuthority.Candidate,
      version: 4,
      error: {
        code: INTENT_VERSION_CONFLICT_CODE,
        message: "Intent item 'lim-no-partial-refund' changed: expected version 1, current version is 4.",
        path: ['decisions', '0', 'expectedVersion'],
      },
    },
    {
      decisionIndex: 1,
      itemId: 'br-refunds-window-v2',
      action: IntentReviewAction.Supersede,
      outcome: IntentReviewOutcome.Superseded,
      authority: IntentAuthority.Superseded,
      version: 4,
    },
  ];

  it('re-renders the refused card with the server code, message and current version', () => {
    const html = render({ results: conflicted });

    expect(html).toContain(INTENT_VERSION_CONFLICT_CODE);
    expect(html).toContain('expected version 1, current version is 4');
    // The version to decide against next time is stated, not left to be inferred.
    expect(html).toContain('current version: v4');
    expect(html).toContain('Refused');
  });

  it('states the two versions and DISABLES the actions while the card is conflicted', () => {
    const clean = render();
    expect(clean).not.toContain('Version conflict:');
    expect(clean).not.toMatch(/aria-pressed="false" disabled=""/);

    const html = render({ results: conflicted });
    expect(html).toContain('Version conflict: v1 expected, server has v4.');
    expect(html).toContain('Re-fetch and decide against the current version.');
    expect(html).toMatch(/aria-pressed="false" disabled=""/);
    expect(html).toContain('Re-fetch');
  });

  it('offers the re-fetch only when a stale version caused the refusal', () => {
    // A refusal that re-fetching cannot repair gets no re-fetch affordance —
    // it stays on screen with the server's own message.
    const otherRefusal = render({
      results: [
        {
          ...conflicted[0],
          error: { code: 'item_not_candidate', message: 'already decided', path: ['decisions', '0'] },
        },
      ],
    });
    expect(otherRefusal).toContain('item_not_candidate');
    expect(otherRefusal).not.toContain('Version conflict:');
  });

  it('clears the conflict once the card carries the version the server reported', () => {
    // The refusal deliberately survives the re-fetch (it carries the current
    // version); what must NOT survive is the disabled state, or the reviewer
    // could never decide again.
    const html = render({ candidates: [{ ...CANDIDATE, version: 4 }], results: [conflicted[0]] });
    expect(html).not.toContain('Version conflict:');
    expect(html).not.toMatch(/aria-pressed="false" disabled=""/);
  });

  it('keeps the applied sibling applied — one stale version never rolls back the batch', () => {
    const html = render({ results: conflicted });
    expect(html).toContain('Superseded');
    expect(html).toContain('Refused');
  });
});

describe('IntentReviewQueue supersede results', () => {
  // The supersession's SUBJECT is the predecessor: that is the id the batch
  // carried and the id the server answers on. The card is the successor's.
  const onPredecessor: IntentReviewDecisionResult = {
    decisionIndex: 0,
    itemId: 'br-refunds-window',
    action: IntentReviewAction.Supersede,
    outcome: IntentReviewOutcome.Refused,
    authority: IntentAuthority.Accepted,
    version: 9,
    replacement: { itemId: 'br-refunds-window-v2', authority: IntentAuthority.Candidate, version: 1 },
    error: {
      code: INTENT_VERSION_CONFLICT_CODE,
      message: "Intent item 'br-refunds-window' changed: expected version 3, current version is 9.",
      path: ['decisions', '0', 'expectedVersion'],
    },
  };

  it('renders the outcome on the successor card even though the row keys on the predecessor', () => {
    // Before the fix this card rendered nothing at all — including no refusal.
    const html = render({ results: [onPredecessor] });

    expect(html).toContain('current version is 9');
    expect(html).toContain('Refused');
    expect(html).toContain('current version: v9');
    // The conflict names the PREDECESSOR's versions, not the card's.
    expect(html).toContain('Version conflict: v3 expected, server has v9.');
  });
});

describe('IntentReviewQueue failure and paging', () => {
  it('keeps the cards on screen when a submit fails, instead of replacing them', () => {
    // The defect this closes: a submit error rendered the load-failure screen,
    // unmounting the queue and discarding every decision the reviewer had typed.
    const html = render({ submitErrorMessage: 'network unreachable' });

    expect(html).toContain('network unreachable');
    expect(html).toContain('Your decisions are kept');
    expect(html).toContain('Partial refunds are not supported');
    expect(html).toContain('Decision batch');
  });

  it('still replaces the surface when the QUEUE ITSELF could not be read', () => {
    const html = render({ errorMessage: 'intent read refused' });
    expect(html).toMatch(/Couldn(&#x27;|')t load the review queue\./);
    expect(html).not.toContain('Decision batch');
  });

  it('offers "Load more" only when there IS another page and a way to fetch it', () => {
    expect(render()).not.toContain('Load more');
    expect(render({ candidatesTruncated: true })).toContain('More candidates are waiting');
    // Without the callback the affordance would be a dead button.
    expect(render({ candidatesTruncated: true })).not.toContain('Load more');
    expect(render({ candidatesTruncated: true, onLoadMore: () => undefined })).toContain('Load more');
  });

  it('warns when a named predecessor version could not be read', () => {
    const html = render({ predecessorsTruncated: true });
    // `renderToStaticMarkup` HTML-escapes the apostrophe, so match either form.
    expect(html).toMatch(/predecessor(&#x27;|')s current version could not be read/);
  });
});

describe('IntentReviewQueue source hygiene', () => {
  it('carries no control character in its source, so git reads the file as text', () => {
    // REGRESSION: the product-root group key was a literal NUL byte, which made
    // `git diff` treat this component as a binary blob. The grouping needs no
    // sentinel at all — a Map takes `null` as a key.
    const source = readFileSync(fileURLToPath(new URL('./IntentReviewQueue.tsx', import.meta.url)), 'utf8');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching one is the point of this assertion.
    expect(source).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});

describe('IntentReviewQueue staged action styling', () => {
  it('gives the pressed action a visible face, not only aria-pressed', () => {
    expect(stagedActionClass(IntentReviewAction.Accept, true)).toBe(
      'bg-bg-tag-success hover:bg-bg-tag-success text-content-primary hover:text-content-primary border-content-brand font-semibold',
    );
    expect(stagedActionClass(IntentReviewAction.Reject, true)).toBe(
      'bg-bg-tag-warning hover:bg-bg-tag-warning text-content-primary hover:text-content-primary border-content-warning font-semibold',
    );
    expect(stagedActionClass(IntentReviewAction.Defer, true)).toBe(
      'bg-bg-primary-selected hover:bg-bg-primary-selected text-content-primary hover:text-content-primary border-border-tertiary font-semibold',
    );
    expect(stagedActionClass(IntentReviewAction.NeedsEdit, true)).toBe(
      'bg-bg-primary-selected hover:bg-bg-primary-selected text-content-primary hover:text-content-primary border-border-tertiary font-semibold',
    );
  });

  // The `outline` variant these buttons use ships `hover:bg-bg-primary-hover`,
  // and tailwind-merge only resolves classes that share a modifier — so a bare
  // `bg-bg-tag-success` loses to it under the pointer and the just-clicked
  // button goes white. Every wash the pressed face paints must be repeated
  // under `hover:` or the feedback disappears exactly when it is being read.
  it('repeats every pressed wash under hover so the variant cannot mask it', () => {
    for (const action of [
      IntentReviewAction.Accept,
      IntentReviewAction.Reject,
      IntentReviewAction.Defer,
      IntentReviewAction.NeedsEdit,
    ]) {
      const classes = stagedActionClass(action, true).split(' ');
      const washes = classes.filter((name) => name.startsWith('bg-') || name.startsWith('text-'));
      expect(washes.length).toBeGreaterThan(0);
      for (const wash of washes) {
        expect(classes).toContain(`hover:${wash}`);
      }
    }
  });

  it('adds nothing at all to an action nobody staged', () => {
    for (const action of [
      IntentReviewAction.Accept,
      IntentReviewAction.Reject,
      IntentReviewAction.Defer,
      IntentReviewAction.NeedsEdit,
    ]) {
      expect(stagedActionClass(action, false)).toBe('');
    }
  });
});

describe('IntentReviewQueue predecessor read state', () => {
  it('says the predecessors are being read while the by-id reads are in flight', () => {
    const html = render({ predecessorsLoading: true, predecessorsTruncated: true });

    expect(html).toContain('Reading the current version of the predecessors named here…');
    // "could not be read" is a claim about a FINISHED read.
    expect(html).not.toContain('could not be read');
  });

  it('reports the miss only once the read has settled without the record', () => {
    const html = render({ predecessorsLoading: false, predecessorsTruncated: true });

    // The apostrophe is HTML-escaped in the rendered markup.
    expect(html).toContain('current version could not be read');
    expect(html).not.toContain('Reading the current version');
  });
});

describe('IntentReviewQueue candidate blue', () => {
  it('paints the waiting count in the text-safe candidate blue', () => {
    // dodger-500 is a fill token and drops under AA at 11px; `content-tag-progress`
    // is the text step DESIGN.md reserves for exactly this semantic.
    expect(render()).toContain('text-content-tag-progress');
  });
});
