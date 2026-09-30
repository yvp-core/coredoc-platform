import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test over the REAL ExplorerProvider: capture the context api during
// render, then drive generateCypher/runCypher and assert they wire through to the
// (fully mocked) bridge — no jsdom needed because we invoke the callbacks directly
// and assert the side effect on window.electronAPI, not re-rendered markup. No real
// IPC/LLM (feedback_storybook_no_real_ipc_in_ci).

const graphGenerateCypher = vi.fn(async () => ({ success: true, data: { cypher: 'MATCH (n) RETURN n' } }));
const graphCypher = vi.fn(async () => ({
  success: true,
  data: { nodes: [{ id: 'n1' }], edges: [{ id: 'e1' }], truncated: false },
}));

beforeEach(() => {
  graphGenerateCypher.mockClear();
  graphCypher.mockClear();
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      graphGenerateCypher,
      graphCypher,
      graphRepos: async () => ({ success: true, data: { repos: [] } }),
      graphCapabilities: async () => ({ success: true, data: { cypher: true, edgesAmong: true } }),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

async function mount() {
  const { ExplorerProvider, useExplorer } = await import('./explorer-context.js');
  const { graphCapabilitiesQueryOptions, graphReposQueryOptions } = await import('../../api/graph.js');

  const projectId = 'proj-1';
  let captured: ReturnType<typeof useExplorer> | undefined;
  function Capture() {
    captured = useExplorer();
    return null;
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scope = { source: 'local' as const, id: projectId };
  queryClient.setQueryData(graphCapabilitiesQueryOptions(scope).queryKey, { cypher: true, edgesAmong: true });
  queryClient.setQueryData(graphReposQueryOptions(scope).queryKey, { repos: [] });

  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient } as { client: QueryClient; children?: ReactNode },
      // biome-ignore lint/correctness/noChildrenProp: a .ts test cannot use JSX; the 3rd-arg form fails tsc since ExplorerProviderProps requires children.
      createElement(ExplorerProvider, { projectId, children: createElement(Capture) }),
    ),
  );
  if (!captured) throw new Error('context was not captured');
  return { api: captured, scope };
}

describe('explorer context NL→Cypher wiring', () => {
  it('generateCypher sends scope + question to graphGenerateCypher', async () => {
    const { api, scope } = await mount();

    await api.generateCypher('classes that call the push service');

    expect(graphGenerateCypher).toHaveBeenCalledWith(scope, 'classes that call the push service');
  });

  it('runCypher executes the EDITED query text through graphCypher', async () => {
    const { api, scope } = await mount();

    // Stands in for the user editing the generated query before hitting Run.
    await api.runCypher('MATCH (c:Class) RETURN c LIMIT 5');

    expect(graphCypher).toHaveBeenCalledWith(scope, 'MATCH (c:Class) RETURN c LIMIT 5', undefined);
  });

  it('exposes cypher state seeded to idle', async () => {
    const { api } = await mount();

    expect(api.cypher).toEqual({
      query: '',
      generationRevision: 0,
      generating: false,
      running: false,
      error: null,
      truncated: false,
    });
  });
});
