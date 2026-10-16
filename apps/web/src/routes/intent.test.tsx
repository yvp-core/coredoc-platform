import { cleanup, render, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens the tree node and item named in a shared link', async () => {
  const me = {
    user: { id: 'u1', email: 'm@x.test' },
    workspaces: [{ id: 'ws1', name: 'Acme', slug: 'acme', role: 'member', intentEnabled: true }],
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (new URL(url, 'http://local.test').pathname === '/api/v1/me') return new Response(JSON.stringify(me));
    return new Promise<Response>(() => undefined);
  });
  vi.stubGlobal('fetch', fetchMock);
  const history = createMemoryHistory({ initialEntries: ['/w/acme/intent?domain=D-1&feature=F-1&item=INT-1'] });
  render(<RouterProvider router={createAppRouter({ history })} />);

  await waitFor(() => {
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url, 'http://local.test'));
    expect(urls.some((url) => url.pathname.endsWith('/context') && url.searchParams.get('intentIds') === 'INT-1')).toBe(
      true,
    );
    expect(urls.some((url) => url.pathname.endsWith('/features/F-1/seeds'))).toBe(true);
  });
  expect(history.location.search).toBe('?domain=D-1&feature=F-1&item=INT-1');
});
