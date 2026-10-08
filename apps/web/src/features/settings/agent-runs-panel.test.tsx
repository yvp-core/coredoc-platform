import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunsPanel } from './AgentRunsPanel';

const SETTINGS_PATH = '/api/v1/workspaces/ws1/cloud-agent-runs/settings';

let settings: Record<string, unknown>;
let writes: { method: string; path: string; body: unknown }[];

function runnerToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok1',
    name: 'runner-prod',
    tokenPrefix: 'cdt_ab12cd34',
    createdBy: 'u1',
    createdByEmail: 'admin@x.test',
    createdAt: '2026-10-01T09:00:00.000Z',
    lastSeenAt: null,
    lastAction: null,
    protocolVersion: null,
    versions: null,
    refusal: null,
    refusalDetail: null,
    ...overrides,
  };
}

beforeEach(() => {
  writes = [];
  settings = {
    enabled: false,
    runOwner: null,
    triggerLabel: 'coredoc-agent',
    questionsPolicy: 'pause',
    scopeAcceptancePolicy: 'required',
    maxSpendUsd: 25,
    maxStartedRuns: 2,
    maxRepositories: 5,
    model: null,
    runnerTokens: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname: path } = new URL(url, 'http://local.test');
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        writes.push({ method, path, body });
        if (path === SETTINGS_PATH) {
          // The server records the caller as run owner when switching on.
          settings = { ...settings, ...body, runOwner: { userId: 'u1', email: 'admin@x.test', valid: true } };
          return new Response(JSON.stringify(settings));
        }
        if (method === 'POST') {
          settings = { ...settings, runnerTokens: [runnerToken({ name: body.name })] };
          return new Response(JSON.stringify({ id: 'tok1', name: body.name, token: 'cdt_secret_value' }), {
            status: 201,
          });
        }
        settings = { ...settings, runnerTokens: [] };
        return new Response(JSON.stringify({ revoked: true }));
      }
      if (path === SETTINGS_PATH) return new Response(JSON.stringify(settings));
      return new Promise<Response>(() => undefined);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentRunsPanel wsId="ws1" />
    </QueryClientProvider>,
  );
}

describe('AgentRunsPanel', () => {
  it('enabling agent runs records the admin as run owner', async () => {
    mount();
    await screen.findByText(/Agent runs are off/);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable agent runs' }));

    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: SETTINGS_PATH, body: { enabled: true } }]));
    expect(await screen.findByText(/Jira-triggered runs act as admin@x.test/)).toBeInTheDocument();
  });

  it('mints a runner token shown once, lists it, and revokes it', async () => {
    settings = { ...settings, enabled: true, runOwner: { userId: 'u1', email: 'admin@x.test', valid: true } };
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Create runner token' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'runner-prod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText('cdt_secret_value')).toBeInTheDocument();
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/v1/workspaces/ws1/tokens',
      body: { name: 'runner-prod', scope: 'agent-runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('cdt_secret_value')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke runner-prod' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/api/v1/workspaces/ws1/tokens/tok1', body: undefined }),
    );
  });

  it('shows when each runner last reported, with its versions, or why it is refused', async () => {
    settings = {
      ...settings,
      enabled: true,
      runnerTokens: [
        runnerToken({
          lastSeenAt: new Date().toISOString(),
          lastAction: 'heartbeat',
          versions: { runner: '1.1.0', sdk: '0.3.285' },
        }),
        runnerToken({ id: 'tok2', name: 'runner-old', refusal: 'creator_not_admin' }),
      ],
    };
    mount();

    expect(await screen.findByText(/heartbeat just now/)).toBeInTheDocument();
    expect(screen.getByText(/runner 1\.1\.0 · sdk 0\.3\.285/)).toBeInTheDocument();
    expect(screen.getByText(/creator is no longer an admin/)).toBeInTheDocument();
  });
});
