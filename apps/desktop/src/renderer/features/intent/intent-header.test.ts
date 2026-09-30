/**
 * The header. The gate that matters: a member never sees a Review segment,
 * because the server refuses the queue for anyone but an admin/owner and an
 * affordance that always fails is worse than none.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentHeader, type IntentHeaderProps } from './IntentHeader';
import { IntentPanelTab } from './intent-panel-state';

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

function render(overrides: Partial<IntentHeaderProps> = {}): string {
  const props: IntentHeaderProps = {
    workspaceLabel: 'acme-eng',
    tab: IntentPanelTab.Browse,
    pendingCount: 0,
    onTabChange: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IntentHeader, props));
}

describe('IntentHeader', () => {
  it('names the product and the workspace, with no role label (AC-11)', () => {
    const html = render();
    expect(html).toContain('Coredoc Cloud');
    expect(html).toContain('Product intent');
    expect(html).toContain('acme-eng');
    expect(html).not.toContain('read only');
    expect(html).not.toContain('Admin · can review');
  });

  it('offers the Review segment to every reader (BR-1)', () => {
    const html = render({ pendingCount: 4 });
    expect(html).toContain('Browse');
    expect(html).toContain('Review');
    expect(html).toContain('>4<');
  });

  it('carries the waiting count on Review, and shows no badge at zero', () => {
    expect(render({ pendingCount: 7 })).toContain('>7<');
    expect(render({ pendingCount: 0 })).not.toContain('>0<');
  });
});
