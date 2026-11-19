import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessPanel } from './AccessPanel';

const ACCESS = {
  groups: [{ id: 'g1', name: 'Core team', memberUserIds: ['u1'] }],
  repos: [
    { repoKey: 'core', repoName: 'core', restricted: true, bindings: [{ userId: 'u1', role: 'member' }] },
    { repoKey: 'web', repoName: 'web', restricted: false, bindings: [] },
  ],
};
const MEMBERS = [
  { userId: 'u1', email: 'one@example.com', displayName: 'One', role: 'member' },
  { userId: 'u2', email: 'two@example.com', displayName: 'Two', role: 'member' },
];

let writes: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') {
        writes.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return new Response('{}');
      }
      return new Response(JSON.stringify(url.endsWith('/access') ? ACCESS : MEMBERS));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AccessPanel', () => {
  it('saves a repo access whole: the flag plus every group and member binding', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AccessPanel wsId="ws1" />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(await screen.findByText('Restricted · 0 groups, 1 members')).toBeInTheDocument();
    expect(screen.getByText('All members')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit access to core' }));
    await user.click(screen.getByRole('checkbox', { name: /Core team/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Two' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      url: '/api/v1/workspaces/ws1/access/repos/core',
      method: 'PUT',
      body: {
        restricted: true,
        bindings: [
          { groupId: 'g1', role: 'member' },
          { userId: 'u1', role: 'member' },
          { userId: 'u2', role: 'member' },
        ],
      },
    });
  });
});
