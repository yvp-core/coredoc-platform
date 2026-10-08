import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router.js';

const RUN_ID = '0b6a3c3e-6c1f-4a51-9f0c-6a0d1f2e3b4c';

function me(agentRunsEnabled: boolean) {
  return {
    user: { id: 'u1', email: 'm@x.test' },
    workspaces: [{ id: 'ws1', name: 'Acme', slug: 'acme', role: 'member', intentEnabled: false, agentRunsEnabled }],
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    issueKey: 'PROJ-7',
    status: 'scoping',
    phase: 'scope',
    trigger: 'manual',
    startedBy: 'u1',
    runOwner: { userId: 'u1', email: 'm@x.test' },
    questionsPolicy: 'pause',
    scopeAcceptancePolicy: 'required',
    model: null,
    branch: 'coredoc/PROJ-7',
    failureCode: null,
    failureReason: null,
    spend: { usd: 0, maxUsd: 25, unknownTurns: 0 },
    currentTurn: {
      id: 't1',
      kind: 'scope',
      state: 'queued',
      ordinal: 1,
      attempt: 0,
      queuedAt: '2026-10-10T09:00:00.000Z',
      claimedAt: null,
    },
    createdAt: '2026-10-10T09:00:00.000Z',
    startedAt: '2026-10-10T09:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const EVENTS = [
  { seq: 2, type: 'status_changed', payload: { from: 'queued', to: 'scoping' } },
  { seq: 1, type: 'status_changed', payload: { from: null, to: 'queued' } },
  { seq: 3, type: 'turn_started', payload: { kind: 'scope', attempt: 1 } },
  { seq: 4, type: 'raw', payload: { text: '[runner] no agent configured' } },
].map((event) => ({ ...event, truncated: false, createdAt: '2026-10-10T09:00:00.000Z' }));

let agentRunsEnabled = true;
let posts: { path: string; body: unknown }[] = [];

beforeEach(() => {
  agentRunsEnabled = true;
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname: path } = new URL(url, 'http://local.test');
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(run({ issueKey: 'PROJ-9' })), { status: 201 });
      }
      if (path === '/api/v1/me') return new Response(JSON.stringify(me(agentRunsEnabled)));
      if (path === '/api/v1/workspaces/ws1/cloud-agent-runs')
        return new Response(JSON.stringify({ runs: [run()], nextOffset: null }));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}`) return new Response(JSON.stringify(run()));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/events`)
        return new Response(JSON.stringify({ events: EVENTS, lastSeq: 4 }));
      // Unrelated shell reads (repos, members) stay pending.
      return new Promise<Response>(() => undefined);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  render(<RouterProvider router={createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })} />);
}

describe('agent runs routes', () => {
  it('shows the navigation entry only when the /me flag is on', async () => {
    mount('/w/acme/agent-runs');
    expect(await screen.findAllByRole('link', { name: /Agent runs/ })).not.toHaveLength(0);

    cleanup();
    agentRunsEnabled = false;
    mount('/w/acme/agent-runs');
    expect(await screen.findAllByRole('link', { name: /Intent|Settings/ })).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: /Agent runs/ })).toBeNull();
  });

  it('lists runs and starts one from an issue key', async () => {
    mount('/w/acme/agent-runs');
    expect(await screen.findByRole('link', { name: 'PROJ-7' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Jira issue key'), { target: { value: 'proj-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(posts).toEqual([{ path: '/api/v1/workspaces/ws1/cloud-agent-runs', body: { issueKey: 'PROJ-9' } }]),
    );
  });

  it('deep-links to a run: status, waiting note and the timeline in sequence order', async () => {
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    expect(await screen.findByRole('heading', { name: 'PROJ-7' })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for an agent runner since/)).toBeInTheDocument();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    const rows = within(timeline)
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Status: Queued'),
      expect.stringContaining('Status: Scoping'),
      expect.stringContaining('Scope turn started (attempt 1)'),
      expect.stringContaining('Agent activity (1)'),
    ]);
  });
});
