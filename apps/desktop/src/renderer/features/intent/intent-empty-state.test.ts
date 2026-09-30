/**
 * The zero-domain invitation (issue v1.1-01). The rule it pins: an unstarted
 * knowledge base is a normal first state, so the card never reads as an error.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentEmptyState, type IntentEmptyStateProps } from './IntentEmptyState';

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

const render = (over: Partial<IntentEmptyStateProps> = {}) =>
  renderToStaticMarkup(createElement(IntentEmptyState, { onCreateFirstDomain: () => undefined, ...over }));

describe('IntentEmptyState', () => {
  it('says in one sentence what the knowledge base is', () => {
    expect(render()).toContain('what this product promises');
  });

  it('offers the first write to any member', () => {
    expect(render()).toContain('Create the first domain');
  });

  it('names the CLI path for a repo overlay that already exists', () => {
    expect(render()).toContain('coredoc intent import');
  });

  it('never uses an error tone', () => {
    const html = render();
    expect(html.toLowerCase()).not.toContain('error');
    expect(html.toLowerCase()).not.toContain('failed');
    expect(html).not.toContain('Retry');
  });
});

describe('IntentEmptyState with everything archived', () => {
  it('offers the way back when the only domains there are are archived', () => {
    // The default tree read hides archived nodes, so an all-archived workspace
    // lands on this card. Without the toggle it is a dead end: the invitation
    // asks for a first domain that already exists.
    const html = render({ archivedDomainCount: 2, onShowArchived: () => undefined });

    expect(html).toContain('2 archived domains are hidden');
    expect(html).toContain('Show archived');
  });

  it('says "domain is" for exactly one', () => {
    const html = render({ archivedDomainCount: 1, onShowArchived: () => undefined });
    expect(html).toContain('1 archived domain is hidden');
  });

  it('offers nothing extra on the ordinary first state', () => {
    const html = render({ archivedDomainCount: 0, onShowArchived: () => undefined });
    expect(html).not.toContain('Show archived');
    expect(html).not.toContain('hidden');
  });
});
