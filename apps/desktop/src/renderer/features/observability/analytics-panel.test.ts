import type { ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsWindowKind } from '../../../shared/ipc-types.js';

// AnalyticsPanel wraps its subtree in GraphQueryProvider, which owns a module-private
// QueryClient singleton (see ../../lib/graph-query-client.ts) — that inner provider would
// shadow the QueryClientProvider this test wraps the panel with, defeating the pre-seeded
// client below. Replace it with a passthrough so every useQuery in the panel resolves
// against the single client seeded here.
vi.mock('../../lib/graph-query-client', () => ({
  GraphQueryProvider: ({ children }: { children: ReactNode }) => children,
}));

// Structure coverage for the Analytics shell (step 4): view switch present, the selected
// view rendered, Delivery open to every role. Rendered with
// `renderToStaticMarkup` because the desktop suite runs in the vitest 'node' environment
// (no jsdom): hover, tab switching and sorting are visual QA (LIM-6). window.electronAPI is
// fully mocked; no real IPC (memory: feedback_storybook_no_real_ipc_in_ci).
describe('AnalyticsPanel shell', () => {
  const workspaceId = 'ws-1';
  const days = 30;
  const analyticsWindow = { kind: AnalyticsWindowKind.Days, days } as const;

  const EMPTY_ROADMAP = {
    feedbackCount: 0,
    topIssues: [],
    topSessionIssues: [],
    topMissingTools: [],
    ratingTrend: [],
    reviews: { unreviewed: 0, confirmed: 0, amended: 0, avgSelfAssessmentGap: null, gapCount: 0 },
  };

  const USAGE = {
    window: {
      days,
      since: '2026-08-04T00:00:00.000Z',
      until: '2026-09-02T12:00:00.000Z',
      previousSince: '2026-07-05T00:00:00.000Z',
    },
    priceMap: { version: 'fixture', basis: 'fixture' },
    kpis: {
      mcpCalls: { current: 0, previous: 0 },
      sessions: { current: 0, previous: 0 },
      developers: { current: 0, usingCoredoc: 0 },
      spend: { currentUsd: null, previousUsd: null, unpricedSessions: 0, sessionsWithoutUsage: 0 },
    },
    series: { mcpCalls: [], sessions: [], spendUsd: [] },
    tools: [],
    adoption: {
      developersUsingCoredoc: 0,
      developersActive: 0,
      totalCoredocCalls: 0,
      coredocSuccessRate: null,
      avgCallLatencyMs: null,
      medianTokensPerSession: null,
    },
    members: [],
    feedback: EMPTY_ROADMAP,
  };

  beforeEach(() => {
    // auth-store.ts registers a module-level `window.addEventListener('focus', ...)` on
    // import, which AnalyticsPanel.tsx transitively imports. The 'node' environment has no
    // real `window`, so the mock carries no-op listeners; no DOM events are dispatched.
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        platform: 'darwin',
        getUsageAnalytics: async () => ({ success: true, data: USAGE }),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  async function renderPanel(role: string | undefined) {
    // Deferred imports so the window.electronAPI mock is installed before the panel module
    // graph (and its query-option factories, whose queryFn closures read window.electronAPI)
    // is evaluated. The first import pays vite's transform of the whole graph, hence the
    // raised per-test timeouts below.
    const { AnalyticsPanel } = await import('./AnalyticsPanel');
    const { usageAnalyticsQueryOptions } = await import('./observability-api');
    const { TooltipProvider } = await import('../../components/ui/tooltip');

    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    queryClient.setQueryData(usageAnalyticsQueryOptions(workspaceId, analyticsWindow).queryKey, USAGE);

    // TooltipProvider is mounted app-wide in App.tsx; the panel is rendered standalone here.
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TooltipProvider, null, createElement(AnalyticsPanel, { workspaceId, role })),
      ),
    );
  }

  it('offers both views and renders the selected view', async () => {
    const html = await renderPanel('admin');

    const markers = ['Usage', 'Delivery', 'Usage by member'];
    const positions = markers.map((marker) => {
      const index = html.indexOf(marker);
      expect(index, `expected to find "${marker}" in the rendered panel`).toBeGreaterThanOrEqual(0);
      return index;
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `"${markers[i]}" should render after "${markers[i - 1]}"`).toBeGreaterThan(
        positions[i - 1]!,
      );
    }
    // Usage is the default view (UC-1); Delivery's body must not be mounted.
    expect(html).not.toContain('Delivery view');
  }, 30_000);

  it('offers the Delivery view to a member and keeps the Usage view self-scoped (BR-15)', async () => {
    const html = await renderPanel('member');

    // `disabled=""` is the rendered attribute; the bare word also appears in Tailwind
    // `disabled:` variants of the trigger class, so match the attribute form.
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>\s*Delivery\s*<\/button>/);
    expect(html).toMatch(/<button[^>]*>\s*Delivery\s*<\/button>/);
    expect(html).toContain('Your activity');
    expect(html).toContain('Your usage');
  }, 30_000);
});
