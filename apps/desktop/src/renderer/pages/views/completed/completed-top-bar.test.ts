/**
 * The top bar's intent discovery badge (issue v1.1-01).
 *
 * WHAT IS BEING PROVEN: a maintainer learns that candidates are waiting WITHOUT
 * opening the Intent tab. Nothing else on this screen says so, which is why the
 * count is a tab affordance rather than something inside the tab.
 *
 * `CompletedTopBar` is pure-props — the count arrives already resolved from
 * `TopBarWithIntentCount`, the one child of `CompletedView`'s query provider —
 * so this renders it with no client and no bridge. `window.electronAPI` is
 * mocked and EMPTY on purpose: an empty mock is itself the proof that no IPC
 * hides in this component (repo rule).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompletedTab, CompletedTopBar, type CompletedTopBarProps } from './CompletedTopBar';

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

function render(overrides: Partial<CompletedTopBarProps> = {}): string {
  const props: CompletedTopBarProps = {
    projectName: 'Acme',
    isCloudMember: false,
    activeTab: CompletedTab.Graph,
    onTabChange: () => undefined,
    onRenameProject: async () => undefined,
    leftPanelOpen: true,
    leftPanelAvailable: true,
    onToggleLeftPanel: () => undefined,
    onOpenWorkspaceGraph: () => undefined,
    onConnectTeamMcp: () => undefined,
    teamMcpConnected: true,
    teamMcpAvailable: true,
    analyticsAvailable: true,
    intentAvailable: true,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(CompletedTopBar, props));
}

describe('intent discovery badge', () => {
  it('shows the waiting count on the Intent tab', () => {
    const html = render({ intentPendingCount: 7 });

    expect(html).toContain('Intent');
    expect(html).toContain('>7<');
    expect(html).toContain('7 intent candidates waiting for review');
  });

  it('shows no badge when nothing is waiting', () => {
    // Zero is not a state to render: an empty queue is the normal one, and a
    // "0" chip on a permanent tab is noise a maintainer learns to ignore.
    const html = render({ intentPendingCount: 0 });

    expect(html).toContain('Intent');
    expect(html).not.toContain('intent candidates waiting for review');
  });

  it('shows no badge when the owner passed no count at all', () => {
    // A member who cannot review, or a workspace still loading, is passed
    // nothing — never a stale or fabricated number.
    expect(render()).not.toContain('intent candidates waiting for review');
  });

  it('renders neither the tab nor its count for a project with no cloud workspace', () => {
    // Intent is workspace-scoped: a local-only project has an ABSENT surface, so
    // a count would advertise a tab that is not there.
    const html = render({ intentAvailable: false, intentPendingCount: 7 });

    expect(html).not.toContain('intent candidates waiting for review');
    expect(html).not.toContain('>Intent<');
  });
});
