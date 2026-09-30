import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CiCdPanel } from './CiCdPanel';

let trigger = 'manual';
let repoTrigger: string | null = null;
let patches: { url: string; body: Record<string, unknown> }[];
let posts: { url: string; body: Record<string, unknown> }[];
let reads: string[];

function mount(canManage = true, intentEnabled = true) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CiCdPanel wsId="ws1" canManage={canManage} intentEnabled={intentEnabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  trigger = 'manual';
  repoTrigger = null;
  patches = [];
  posts = [];
  reads = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === undefined) reads.push(url);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: 't1', name: 'ci', token: 'cdt_x' }));
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push({ url, body });
        // The panel invalidates the repo list after a write, so the mock has to
        // answer the refetch with what was just saved — a Select whose value
        // never moves fires no second change.
        if ('intentReleaseTrigger' in body && url.includes('/repos/')) repoTrigger = body.intentReleaseTrigger;
        return new Response('{}');
      }
      if (url.endsWith('/workspaces/ws1')) return new Response(JSON.stringify({ intentReleaseTrigger: trigger }));
      if (url.endsWith('/repos'))
        return new Response(
          JSON.stringify([
            {
              id: 'r1',
              repoKey: 'backend',
              repoName: 'backend',
              productionBranch: null,
              intentReleaseTrigger: repoTrigger,
            },
          ]),
        );
      if (url.endsWith('/tokens')) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify({ workspace: { id: 'ws1', ciCdEnabled: false }, members: [] }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Release trigger settings', () => {
  it('patches the workspace with the chosen trigger', async () => {
    mount();
    const select = await screen.findByRole('combobox', { name: 'Intent release trigger' });
    // The control is disabled until the trigger read lands; a disabled trigger swallows the keydown.
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'On merge' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: '/api/v1/workspaces/ws1', body: { intentReleaseTrigger: 'merge' } });
  });

  it('offers a production branch per repository only in an automatic mode', async () => {
    trigger = 'merge';
    mount();
    const branch = await screen.findByRole('textbox', { name: 'Production branch for backend' });
    fireEvent.change(branch, { target: { value: 'release' } });
    fireEvent.blur(branch);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: '/api/v1/workspaces/ws1/repos/backend', body: { productionBranch: 'release' } });
  });

  it('saves a per-repository trigger override and can restore inheritance', async () => {
    trigger = 'merge';
    mount();
    const select = await screen.findByRole('combobox', { name: 'Release trigger for backend' });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Manual' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      url: '/api/v1/workspaces/ws1/repos/backend',
      body: { intentReleaseTrigger: 'manual' },
    });
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Default (On merge)' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({
      url: '/api/v1/workspaces/ws1/repos/backend',
      body: { intentReleaseTrigger: null },
    });
  });

  it('hides the repository section under a manual default with nothing overridden', async () => {
    mount();
    expect(await screen.findByText('Deliveries are recorded here, by a maintainer.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Release trigger for backend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Production branch for backend' })).not.toBeInTheDocument();
  });

  it('shows the repository section under a manual default when one repository overrides it', async () => {
    repoTrigger = 'deploy';
    mount();
    expect(await screen.findByRole('combobox', { name: 'Release trigger for backend' })).toBeInTheDocument();
  });

  it('says intent is off and reads nothing when the workspace has it disabled', async () => {
    mount(true, false);
    expect(await screen.findByText('Intent is not enabled for this workspace.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Intent release trigger' })).not.toBeInTheDocument();
    expect(reads.filter((url) => url.endsWith('/workspaces/ws1') || url.endsWith('/repos'))).toEqual([]);
  });

  it('reads an absent trigger field (older server) as Manual', async () => {
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith('/workspaces/ws1') && init?.method === undefined ? new Response('{}') : base(url, init),
      ),
    );
    mount();
    const select = await screen.findByRole('combobox', { name: 'Intent release trigger' });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Manual');
  });

  it('disables the selector and says unavailable when the trigger read fails', async () => {
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/workspaces/ws1') && init?.method === undefined) throw new TypeError('Connection lost');
        return base(url, init);
      }),
    );
    mount();
    expect(await screen.findByText('Release trigger unavailable')).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Intent release trigger' });
    expect(select).toBeDisabled();
    expect(select).not.toHaveTextContent('Manual');
  });

  it('keeps the trigger read-only for a member', async () => {
    mount(false);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Intent release trigger' })).toBeDisabled());
    expect(patches).toHaveLength(0);
  });
});

describe('Service token scopes', () => {
  it('mints the unified CI token without a separate intent scope', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/v1/workspaces/ws1/tokens',
      body: { name: 'ci', scope: 'ci' },
    });
  });
});
