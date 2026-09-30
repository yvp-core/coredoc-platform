import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntentAnchorStatus,
  IntentAuthority,
  IntentItemKind,
  IntentSnapshotFreshness,
  IntentSourceKind,
  type IntentContextMatch,
  type IntentGraphEvidence,
  type IntentTransition,
} from '../../../shared/intent-types.js';
import { IntentItemDetail, type IntentAnchorRefreshState, type IntentItemDetailProps } from './IntentItemDetail';
import { anchorStatusMark, snapshotFreshnessMark } from './intent-presentation';

// Pure-props component rendered with `renderToStaticMarkup` in the node environment
// (vitest.config.ts). window.electronAPI is mocked and deliberately EMPTY: the detail
// pane must not reach IPC on its own — the panel above it owns every fetch, including
// the anchor refresh whose confirm state is handed in as props.
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

const MATCH: IntentContextMatch = {
  id: 'br-refunds-window',
  kind: IntentItemKind.BusinessRule,
  title: 'Refunds close after 30 days',
  authority: IntentAuthority.Accepted,
  version: 3,
  domainId: 'payments',
  featureId: 'refunds',
  proposedSuccessorOfId: null,
  supersededById: null,
  updatedAt: '2026-08-20T10:00:00.000Z',
  statement: 'A refund request is refused more than 30 days after the order.',
  rationale: 'Chargeback exposure past that window.',
  payload: { condition: 'order older than 30 days', requiredOutcome: 'refuse the refund', exceptions: ['fraud hold'] },
  matchReason: 'exact_id',
  sources: [
    {
      kind: IntentSourceKind.Spec,
      ref: 'spec/refunds',
      localId: '§3',
      revision: 'abc123',
      locator: null,
      title: null,
      url: null,
    },
  ],
  anchors: [
    {
      repoKey: 'acme/api',
      nodeId: 'h1:function:refundGuard',
      nodeType: 'function',
      capturedVersionedId: 'h1:function:refundGuard@v9',
      rationale: null,
      // The anchor still reproduces — but on a snapshot nobody verified.
      status: IntentAnchorStatus.Matched,
      snapshotFreshness: IntentSnapshotFreshness.Unverified,
    },
  ],
};

const CHANGED_ANCHOR = {
  ...MATCH.anchors[0]!,
  status: IntentAnchorStatus.Changed,
  snapshotFreshness: IntentSnapshotFreshness.Current,
  currentVersionedId: 'h1:function:refundGuard@v11',
};

const GRAPH: IntentGraphEvidence = {
  repos: [
    {
      repoKey: 'acme/api',
      repoName: 'api',
      graphRepoHash: 'h1',
      graphVersionId: 'gv-42',
      pushedAt: '2026-06-01T00:00:00.000Z',
      snapshotFreshness: IntentSnapshotFreshness.Unverified,
    },
  ],
  truncated: false,
  limits: [],
};

const TRANSITIONS: IntentTransition[] = [
  {
    id: '1001',
    itemId: 'br-refunds-window',
    from: 'candidate',
    to: 'accepted',
    actorId: 'user-1',
    actorRole: 'owner',
    reason: 'Confirmed against the shipped guard.',
    authorizingSource: { kind: 'spec', ref: 'spec/refunds', localId: '§3', revision: null },
    workItem: null,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
];

const anchorRefresh = (over: Partial<IntentAnchorRefreshState> = {}): IntentAnchorRefreshState => ({
  confirmingKey: null,
  refreshingKey: null,
  outcomes: {},
  errorKey: null,
  error: null,
  onRequestRefresh: () => undefined,
  onCancelRefresh: () => undefined,
  onConfirmRefresh: () => undefined,
  ...over,
});

const ANCHOR_KEY = 'acme/api\nh1:function:refundGuard';

function render(overrides: Partial<IntentItemDetailProps> = {}): string {
  const props: IntentItemDetailProps = {
    itemId: 'br-refunds-window',
    match: MATCH,
    graph: GRAPH,
    anchorWarning: 'An anchor status is a statement about the snapshot it was read from.',
    transitions: TRANSITIONS,
    loading: false,
    onRetry: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentItemDetail, props));
}

describe('IntentItemDetail inherited conditions (intent-dimensions-inheritance UC-3)', () => {
  it('shows an inherited group above the item own clauses, each labelled by its source', () => {
    const html = render({
      match: {
        ...MATCH,
        domainId: 'shifts',
        featureId: 'overtime',
        appliesWhen: [{ dimension: 'role', in: ['manager'] }],
        inheritedConditions: {
          domain: [{ dimension: 'product', in: ['shifts'] }],
          feature: [{ dimension: 'country', in: ['de', 'pl'] }],
        },
      },
    });

    expect(html).toContain('product in shifts');
    expect(html).toContain('from domain shifts');
    expect(html).toContain('country in de, pl');
    expect(html).toContain('from feature overtime');
    expect(html).toContain('role in manager');
  });
});

describe('IntentItemDetail trust markers (spec §6.4)', () => {
  it('renders the anchor verdict and the snapshot freshness as TWO independent marks', () => {
    const html = render();

    const status = anchorStatusMark(IntentAnchorStatus.Matched);
    const freshness = snapshotFreshnessMark(IntentSnapshotFreshness.Unverified);
    expect(status).not.toBe(freshness);

    // Both appear, as separate marks. The failure this pins is the tempting
    // merge: a matched anchor on an unverified snapshot must NOT read as one
    // green "current" verdict — it is a matched anchor whose snapshot nobody
    // checked, and the pane says exactly that.
    expect(html).toContain(status);
    expect(html).toContain(freshness);
    expect(html.indexOf(status)).toBeLessThan(html.indexOf(freshness));
    expect(html).not.toContain('anchor matched · snapshot current');
  });

  it('wraps the anchor path instead of cutting it, and titles it with the versioned id', () => {
    // A node id IS a path; truncated in the middle it names nothing, and the
    // `title` carried only the same truncated string.
    const html = render();

    expect(html).toContain('break-all');
    expect(html).toContain('title="h1:function:refundGuard@v9"');
    expect(html).toContain('h1:function:refundGuard');
  });

  it('does not list workspace-wide graph provenance per repo', () => {
    const html = render();
    expect(html).not.toContain('Graph provenance');
    expect(html).not.toContain('gv-42');
  });

  it('calls an unevaluated anchor unevaluated, never missing, when the graph could not be read', () => {
    const html = render({
      match: { ...MATCH, anchors: [{ ...MATCH.anchors[0]!, status: undefined, snapshotFreshness: undefined }] },
      graph: {
        repos: [],
        degradation: { code: 'graph_object_missing', remediation: 'Push the repository graph.' },
        truncated: false,
        limits: [],
      },
    });

    expect(html).toContain('anchor unevaluated');
    expect(html).not.toContain('anchor missing');
    // Degradation is reported as degradation, not as an error state.
    expect(html).toContain('graph_object_missing');
    expect(html).toContain('Graph unavailable');
    expect(html).toContain('only anchor status and freshness are missing');
  });

  it('shows the server caveat verbatim rather than paraphrasing it, and keeps the standing disclaimer', () => {
    const html = render();
    expect(html).toContain('An anchor status is a statement about the snapshot it was read from.');
    expect(html).toContain('what the product promises, not what the code currently does');
  });
});

describe('IntentItemDetail anchor refresh (issue v1.1-01)', () => {
  const changed = { ...MATCH, anchors: [CHANGED_ANCHOR] };

  it('offers a refresh on a CHANGED anchor to any member', () => {
    expect(render({ match: changed, anchorRefresh: anchorRefresh() })).toContain('Refresh baseline');
  });

  it('never offers a refresh on a matched or missing anchor', () => {
    expect(render({ anchorRefresh: anchorRefresh() })).not.toContain('Refresh baseline');
    const missing = { ...MATCH, anchors: [{ ...CHANGED_ANCHOR, status: IntentAnchorStatus.Missing }] };
    expect(render({ match: missing, anchorRefresh: anchorRefresh() })).not.toContain('Refresh baseline');
  });

  it('asks for a second click, and names both versioned ids in the confirm', () => {
    const html = render({ match: changed, anchorRefresh: anchorRefresh({ confirmingKey: ANCHOR_KEY }) });
    expect(html).toContain('Refresh to current?');
    expect(html).toContain('h1:function:refundGuard@v9');
    expect(html).toContain('h1:function:refundGuard@v11');
    expect(html).toContain('Cancel');
  });

  it('says it is refreshing rather than offering the same write twice', () => {
    const html = render({
      match: changed,
      anchorRefresh: anchorRefresh({ confirmingKey: ANCHOR_KEY, refreshingKey: ANCHOR_KEY }),
    });
    expect(html).toContain('Refreshing…');
  });

  it('shows what the baseline moved from and to once the write lands', () => {
    const html = render({
      match: changed,
      anchorRefresh: anchorRefresh({
        outcomes: {
          [ANCHOR_KEY]: {
            previousCapturedVersionedId: 'h1:function:refundGuard@v9',
            capturedVersionedId: 'h1:function:refundGuard@v11',
            changed: true,
          },
        },
      }),
    });
    expect(html).toContain('baseline h1:function:refundGuard@v9 → h1:function:refundGuard@v11');
  });

  it('renders a refusal beside the row without wiping the pane', () => {
    const html = render({
      match: changed,
      anchorRefresh: anchorRefresh({
        errorKey: ANCHOR_KEY,
        error: {
          statusCode: 409,
          timestamp: '2026-09-02T00:00:00.000Z',
          code: 'anchor_not_found',
          message: 'no anchor for that node',
          path: ['nodeId'],
        },
      }),
    });
    expect(html).toContain('anchor_not_found');
    expect(html).toContain('no anchor for that node');
    expect(html).toContain('at nodeId');
    // The statement is still on screen: a failed write never replaces the item.
    expect(html).toContain('A refund request is refused more than 30 days after the order.');
  });
});

describe('IntentItemDetail content', () => {
  it('describes the selected domain or feature while no item is open', () => {
    const html = render({ itemId: null, scope: { title: 'Payments', statement: 'Money in and out.' } });
    expect(html).toContain('Payments');
    expect(html).toContain('Money in and out.');
    expect(render({ itemId: null, scope: { title: 'Payments', statement: '' } })).not.toContain('Payments');
  });

  it('renders statement, rationale, the per-kind details grid, sources and history', () => {
    const html = render();
    expect(html).toContain('A refund request is refused more than 30 days after the order.');
    expect(html).toContain('Chargeback exposure past that window.');
    expect(html).toContain('Required outcome');
    expect(html).toContain('refuse the refund');
    expect(html).toContain('fraud hold');
    expect(html).toContain('spec/refunds#§3');
    expect(html).toContain('candidate → accepted');
    expect(html).toContain('Confirmed against the shipped guard.');
  });

  it('renders a flow payload as numbered steps with actor, outcome and branches', () => {
    const html = render({
      match: {
        ...MATCH,
        kind: IntentItemKind.Flow,
        payload: {
          trigger: 'customer asks for a refund',
          steps: [
            {
              id: 'ask',
              actor: 'Customer',
              action: 'requests a refund',
              outcome: 'a request row exists',
              branches: [{ condition: 'order is older than 30 days', toStepId: 'refuse' }],
            },
            { id: 'refuse', actor: 'System', action: 'refuses', outcome: 'the customer is told why' },
          ],
        },
      },
    });
    expect(html).toContain('Customer');
    expect(html).toContain('requests a refund → a request row exists');
    expect(html).toContain('if order is older than 30 days → step refuse');
    // The trigger is still a field of the grid, beside the steps.
    expect(html).toContain('Trigger');
  });

  it('falls back to the raw payload rather than dropping a shape it does not understand', () => {
    const html = render({ match: { ...MATCH, payload: [1, 2, 3] } });
    expect(html).toContain('[');
  });

  it('falls back to formatted JSON for a non-scalar field instead of dropping it (AC-8)', () => {
    const html = render({
      match: { ...MATCH, payload: { ...(MATCH.payload as object), scope: { region: 'EU' } } },
    });
    expect(html).toContain('&quot;region&quot;: &quot;EU&quot;');
  });

  it('shows readable clauses and a variant table for a candidate with conditions and variants (AC-8)', () => {
    const html = render({
      match: {
        ...MATCH,
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
      },
    });
    expect(html).toContain('country not in ua');
    expect(html).toContain('country = de');
    expect(html).toContain('default');
    expect(html).toContain('40h');
    expect(html).toContain('contractHoursPerWeek × 1.1, capped at 48h');
    expect(html).toContain('contractHoursPerWeek');
    // The rest of the payload still renders in the generic grid, beside the table.
    expect(html).toContain('Payroll export');
  });

  it('names a replacement in both directions', () => {
    expect(render({ match: { ...MATCH, proposedSuccessorOfId: 'br-old' } })).toContain('proposes to replace br-old');
    expect(render({ match: { ...MATCH, supersededById: 'br-new' } })).toContain('superseded by br-new');
  });

  it('records an import arrival as an arrival, not as a decision somebody made', () => {
    const html = render({
      transitions: [
        {
          ...TRANSITIONS[0]!,
          from: null,
          to: 'accepted',
          authorizingSource: { kind: 'import', ref: 'overlay', localId: null, revision: null },
        },
      ],
    });
    expect(html).toContain('Arrived as accepted · import');
  });

  it('prompts for a selection instead of rendering an empty pane', () => {
    expect(render({ itemId: null })).toContain('Select an item to read its statement and history.');
  });
});

describe('IntentItemDetail history pagination', () => {
  it('offers older decisions only when the server has another page', () => {
    // The history page asks for 25 transitions; without this the 26th decision
    // simply did not exist as far as the pane was concerned.
    expect(render()).not.toContain('Load older decisions');
    expect(render({ hasMoreTransitions: true, onLoadMoreTransitions: () => undefined })).toContain(
      'Load older decisions',
    );
  });

  it('says it is loading rather than offering the same action twice', () => {
    const html = render({
      hasMoreTransitions: true,
      loadingMoreTransitions: true,
      onLoadMoreTransitions: () => undefined,
    });
    expect(html).toContain('Loading…');
    expect(html).not.toContain('Load older decisions');
  });
});

describe('IntentItemDetail freshness re-check (B2-Browse finding 3)', () => {
  it('is absent unless the panel wires the gesture — never a dead control', () => {
    expect(render()).not.toContain('Re-check freshness');
  });

  it('offers the re-read to any reader, because reading is not reviewing', () => {
    // No role gate: `refresh` re-resolves the LOCAL checkout, which is what turns
    // `unverified` into a real freshness verdict. A member reads the same answer.
    const html = render({ freshness: { busy: false, onRecheck: () => undefined } });
    expect(html).toContain('Re-check freshness');
  });

  it('says it is re-checking rather than offering the same click twice', () => {
    const html = render({ freshness: { busy: true, onRecheck: () => undefined } });
    expect(html).toContain('Re-checking…');
    expect(html).toContain('disabled=""');
  });

  it('reports a failed re-check beside the anchors and keeps the pane', () => {
    const html = render({
      freshness: { busy: false, errorMessage: 'git not found', onRecheck: () => undefined },
    });
    expect(html).toContain('re-check freshness');
    expect(html).toContain('git not found');
    // The answer already on screen survives — only the re-read failed.
    expect(html).toContain('h1:function:refundGuard');
  });
});
