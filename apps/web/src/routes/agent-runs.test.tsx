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
    previousRunId: null,
    seeds: [],
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

const RERUN_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

function spec(version: number, status: string, overrides: Record<string, unknown> = {}) {
  return {
    version,
    status,
    title: `Order exports v${version}`,
    summary: 'CSV exports for orders.',
    markdown: `# Spec v${version}\n\nExport orders as CSV.\n\n![architecture](https://images.example.com/diagram.png)`,
    repositories: [
      {
        key: 'orders-api',
        reason: 'Owns the order records',
        changes: 'New export endpoint',
        mergeOrder: 0,
        eligible: true,
        ineligibleReason: null,
      },
      {
        key: 'billing-api',
        reason: 'Invoices in exports',
        changes: 'Read model',
        mergeOrder: 1,
        eligible: false,
        ineligibleReason: 'github_connector_unavailable',
      },
    ],
    risks: ['Large exports may time out'],
    intentReferences: [],
    assumptions: ['CSV only'],
    droppedSeeds: [{ key: 'legacy-tool', reason: 'Retired' }],
    candidates: [{ question: 'Should exports include refunds?', blocks: 'The export columns' }],
    proposedAt: '2026-10-10T09:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    reviewText: null,
    autoAccepted: false,
    ...overrides,
  };
}

let specs: ReturnType<typeof spec>[] = [];
/** What a scope review POST answers: success, or a stale-version refusal. */
let reviewAnswer: 'ok' | 'stale' = 'ok';

let agentRunsEnabled = true;
let posts: { path: string; body: unknown }[] = [];
let detail: Record<string, unknown>;
let availability: { available: boolean; reasons: { code: string; message: string }[] };

beforeEach(() => {
  agentRunsEnabled = true;
  posts = [];
  detail = run();
  specs = [];
  reviewAnswer = 'ok';
  availability = { available: true, reasons: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname: path } = new URL(url, 'http://local.test');
      if (init?.method === 'POST') {
        posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (/\/specs\/\d+\/(accept|request-changes)$/.test(path)) {
          if (reviewAnswer === 'stale') {
            return new Response(
              JSON.stringify({
                statusCode: 409,
                code: 'SPEC_VERSION_STALE',
                message: 'Scope version 2 is not the latest proposed version; reload the run to review the current one',
              }),
              { status: 409 },
            );
          }
          return new Response(JSON.stringify(detail));
        }
        if (path.endsWith('/rerun')) {
          return new Response(JSON.stringify(run({ id: RERUN_ID, trigger: 'rerun', previousRunId: RUN_ID })), {
            status: 201,
          });
        }
        return new Response(JSON.stringify(run({ issueKey: 'PROJ-9' })), { status: 201 });
      }
      if (path === '/api/v1/me') return new Response(JSON.stringify(me(agentRunsEnabled)));
      if (path === '/api/v1/workspaces/ws1/cloud-agent-runs')
        return new Response(JSON.stringify({ runs: [run()], nextOffset: null }));
      if (path === '/api/v1/workspaces/ws1/cloud-agent-runs/settings')
        return new Response(JSON.stringify({ availability }));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}`) return new Response(JSON.stringify(detail));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RERUN_ID}`)
        return new Response(JSON.stringify(run({ id: RERUN_ID, trigger: 'rerun', previousRunId: RUN_ID })));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/specs`)
        return new Response(JSON.stringify({ versions: specs }));
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

  it('starts a run with seed repository keys', async () => {
    mount('/w/acme/agent-runs');
    fireEvent.change(await screen.findByLabelText('Jira issue key'), { target: { value: 'PROJ-9' } });
    fireEvent.change(screen.getByLabelText('Repository keys (optional)'), {
      target: { value: 'orders-api, billing-api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(posts).toEqual([
        {
          path: '/api/v1/workspaces/ws1/cloud-agent-runs',
          body: { issueKey: 'PROJ-9', repositoryKeys: ['orders-api', 'billing-api'] },
        },
      ]),
    );
  });

  it('tells members why runs cannot start', async () => {
    availability = {
      available: false,
      reasons: [{ code: 'github_connector_inactive', message: 'The GitHub connector is paused.' }],
    };
    mount('/w/acme/agent-runs');

    expect(await screen.findByText(/Runs cannot start right now/)).toBeInTheDocument();
    expect(screen.getByText('The GitHub connector is paused.')).toBeInTheDocument();
  });

  it('re-runs a finished run and opens the new run, which links back to the previous one', async () => {
    detail = run({ status: 'failed', failureCode: 'no_outcome', failureReason: 'Stopped', currentTurn: null });
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));

    await waitFor(() =>
      expect(posts).toEqual([{ path: `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/rerun`, body: undefined }]),
    );
    expect(await screen.findByRole('link', { name: 'Previous run' })).toBeInTheDocument();
  });

  it('offers no re-run while the run is active', async () => {
    mount(`/w/acme/agent-runs/${RUN_ID}`);
    expect(await screen.findByRole('heading', { name: 'PROJ-7' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
  });

  describe('scope review', () => {
    beforeEach(() => {
      specs = [spec(1, 'changes_requested', { reviewText: 'Cover billing too.' }), spec(2, 'proposed')];
      detail = run({
        status: 'awaiting_scope_acceptance',
        currentTurn: null,
        seeds: ['legacy-tool'],
        latestSpec: specs[1],
        repositories: [],
        droppedSeeds: [],
      });
    });

    it('shows the latest proposal: spec, repositories with eligibility, dropped seeds and candidates', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const review = await screen.findByRole('region', { name: 'Scope review' });

      expect(within(review).getByRole('heading', { name: 'Spec v2' })).toBeInTheDocument();
      const rows = within(within(review).getByRole('table', { name: 'Repositories' }))
        .getAllByRole('row')
        .map((row) => row.textContent);
      expect(rows[1]).toContain('orders-api');
      expect(rows[1]).toContain('Owns the order records');
      expect(rows[2]).toMatch(/billing-api.*Not eligible/);
      expect(within(review).getByText(/legacy-tool/)).toBeInTheDocument();
      expect(within(review).getByText('Should exports include refunds?')).toBeInTheDocument();
    });

    it('never renders a remote image from agent-written markdown', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const review = await screen.findByRole('region', { name: 'Scope review' });

      expect(review.querySelector('img')).toBeNull();
      expect(within(review).getByText(/architecture/)).toHaveTextContent('https://images.example.com/diagram.png');
    });

    it('accepts the displayed version', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Accept scope' }));

      await waitFor(() =>
        expect(posts).toEqual([
          { path: `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/specs/2/accept`, body: undefined },
        ]),
      );
    });

    it('says so when the displayed version is no longer the latest', async () => {
      reviewAnswer = 'stale';
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Accept scope' }));

      expect(await screen.findByText(/not the latest proposed version/)).toBeInTheDocument();
    });

    it('requests changes with the reviewer’s text on the displayed version', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.change(await screen.findByLabelText('Changes to request'), {
        target: { value: 'Leave billing out.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

      await waitFor(() =>
        expect(posts).toEqual([
          {
            path: `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/specs/2/request-changes`,
            body: { text: 'Leave billing out.' },
          },
        ]),
      );
    });

    it('shows an earlier version with its review text, without review actions', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '1' } });

      const review = screen.getByRole('region', { name: 'Scope review' });
      expect(await within(review).findByRole('heading', { name: 'Spec v1' })).toBeInTheDocument();
      expect(within(review).getByText('Cover billing too.')).toBeInTheDocument();
      expect(within(review).queryByRole('button', { name: 'Accept scope' })).toBeNull();
    });
  });
});
