import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Regression: this page once crashed for members (a Radix <Tooltip> with no
// <TooltipProvider> above it). Mount the real router so every provider must
// come from RootLayout, and check the Delivery tab is open to members.
it('renders analytics for a member with the Delivery tab enabled', async () => {
  const me = {
    user: { id: 'u1', email: 'm@x.test' },
    workspaces: [{ id: 'ws1', name: 'Acme', slug: 'acme', role: 'member', intentEnabled: false }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://local.test').pathname;
      if (path === '/api/v1/me') return new Response(JSON.stringify(me));
      // Everything else (usage metrics, repos, config) stays pending: those
      // views load via useQuery and render their loading state.
      return new Promise<Response>(() => undefined);
    }),
  );
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/w/acme/analytics'] }) });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText('Workspace analytics')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).toBeNull();
  expect(screen.getByRole('button', { name: 'Delivery' })).toBeEnabled();
});
