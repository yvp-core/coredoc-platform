import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntentAuthority,
  IntentReviewAction,
  IntentReviewOutcome,
  IntentSourceKind,
  type IntentItemSource,
} from '../../../shared/intent-types.js';
import { IntentBatchPanel, type IntentBatchPanelProps } from './IntentBatchPanel';
import { EMPTY_PROVENANCE_FORM } from './IntentReviewQueue';

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

const SOURCE: IntentItemSource = {
  kind: IntentSourceKind.Spec,
  ref: 'spec/refunds',
  localId: '§4',
  revision: null,
  locator: null,
  title: null,
  url: null,
};

function render(overrides: Partial<IntentBatchPanelProps> = {}): string {
  const props: IntentBatchPanelProps = {
    stagedCounts: [],
    stagedTotal: 0,
    provenance: EMPTY_PROVENANCE_FORM,
    sharedSource: { state: 'none' },
    batchReason: '',
    issues: [],
    submitting: false,
    results: null,
    onProvenanceChange: () => undefined,
    onBatchReasonChange: () => undefined,
    onManualPreset: () => undefined,
    onUseSharedSource: () => undefined,
    onSubmit: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentBatchPanel, props));
}

describe('IntentBatchPanel', () => {
  it('shows the approved specification revision in an editable field', () => {
    const html = render({ provenance: { ...EMPTY_PROVENANCE_FORM, revision: 'sha256:approved' } });
    expect(html).toContain('Revision (required)');
    expect(html).toContain('id="intent-provenance-revision"');
    expect(html).toContain('value="sha256:approved"');
  });

  it('disables the submit while nothing is staged', () => {
    const html = render();
    expect(html).toContain('Nothing staged yet.');
    expect(html).toContain('Submit decisions');
    expect(html).toContain('disabled=""');
  });

  it('names the staged count on the submit and counts the actions', () => {
    const html = render({
      stagedTotal: 3,
      stagedCounts: [
        { label: 'Accept', count: 2 },
        { label: 'Reject', count: 1 },
      ],
    });

    expect(html).toContain('Submit 3 decisions');
    expect(html).toContain('Accept');
    expect(html).toContain('Reject');
    expect(html).not.toContain('disabled=""');
  });

  it('says "1 decision" in the singular', () => {
    expect(render({ stagedTotal: 1, stagedCounts: [{ label: 'Accept', count: 1 }] })).toContain('Submit 1 decision<');
  });

  it('repeats the two batch rules under the submit', () => {
    expect(render()).toContain('One authorizing source per batch · versions are checked on every item');
  });

  it('offers the Manual decision preset', () => {
    expect(render()).toContain('Manual decision');
  });

  // As a `ghost` the preset painted nothing but text, right beside a label that
  // is also text — the one gesture on the row read as part of the caption. It
  // must carry the shipped white/tertiary recipe (`outline`: white fill plus a
  // hairline) so it is discoverable as an action.
  it('renders the preset as a real button on the outline recipe', () => {
    const html = render();
    const button = /<button[^>]*>Manual decision<\/button>/.exec(html);
    expect(button).not.toBeNull();

    const markup = button?.[0] ?? '';
    expect(markup).toContain('data-variant="outline"');
    expect(markup).toContain('bg-bg-primary');
    expect(markup).toContain('border-border-action-secondary');
    // It sits beside a single-line label in a 320px panel: it may not shrink
    // into a wrap, and it may not wrap its own words.
    expect(markup).toContain('shrink-0');
    expect(markup).toContain('whitespace-nowrap');
  });

  it('says so when the staged candidates cite different sources, and offers the first', () => {
    const html = render({ sharedSource: { state: 'mixed', first: SOURCE } });
    expect(html).toContain('Staged candidates cite different sources');
    expect(html).toContain('Use spec/refunds#§4');
  });

  it('stays silent about sources when they all agree — the form is already filled', () => {
    const html = render({ sharedSource: { state: 'single', source: SOURCE } });
    expect(html).not.toContain('cite different sources');
  });

  it('renders the local refusals beside the form instead of submitting', () => {
    const html = render({ issues: ['Choose an action on at least one candidate before submitting.'] });
    expect(html).toContain('Choose an action on at least one candidate');
  });

  it('keeps a failed submit beside the button and says the drafts survived', () => {
    const html = render({ submitErrorMessage: 'network unreachable' });
    expect(html).toContain('network unreachable');
    expect(html).toContain('Your decisions are kept');
  });

  it('reports what the last batch actually did', () => {
    const html = render({
      results: [
        {
          decisionIndex: 0,
          itemId: 'a',
          action: IntentReviewAction.Accept,
          outcome: IntentReviewOutcome.Accepted,
          authority: IntentAuthority.Accepted,
          version: 2,
        },
        {
          decisionIndex: 1,
          itemId: 'b',
          action: IntentReviewAction.Accept,
          outcome: IntentReviewOutcome.Refused,
          authority: IntentAuthority.Candidate,
          version: 4,
          error: { code: 'version_conflict', message: 'stale', path: ['decisions', '1'] },
        },
      ],
    });

    expect(html).toContain('Last batch: 1 accepted · 1 refused');
  });
});

describe('IntentBatchPanel provenance label', () => {
  it('keeps the field label on one line and states the rule under Submit', () => {
    // "Authorizing source · one per batch" wrapped into the "Manual decision"
    // button; the rule belongs in the note line, which already carries it.
    const html = render();

    expect(html).toContain('Authorizing source');
    expect(html).not.toContain('Authorizing source · one per batch');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('One authorizing source per batch');
  });
});
