import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunsPanel } from './AgentRunsPanel';

const SETTINGS_PATH = '/api/v1/workspaces/ws1/cloud-agent-runs/settings';
const STATUSES_PATH = '/api/v1/workspaces/ws1/cloud-agent-runs/settings/jira-statuses';

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
    startedStatus: null,
    doneStatus: null,
    failedStatus: null,
    cancelledStatus: null,
    questionsPolicy: 'pause',
    scopeAcceptancePolicy: 'required',
    maxSpendUsd: 25,
    maxTurnDurationSeconds: 3 * 3600,
    maxActiveSeconds: 24 * 3600,
    waitingLimitSeconds: 7 * 86_400,
    maxStartedRuns: 2,
    maxRepositories: 5,
    model: null,
    availability: { available: true, reasons: [] },
    trigger: { ready: false, projectKeys: ['ORD'], reasons: [] },
    repositories: [],
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
      if (path === STATUSES_PATH) return new Response(JSON.stringify({ statuses: ['Done', 'In Progress', 'To Do'] }));
      return new Promise<Response>(() => undefined);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(select: string, option: string) {
  const trigger = await screen.findByRole('combobox', { name: select });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

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
        runnerToken({
          id: 'tok3',
          name: 'runner-misconfigured',
          lastSeenAt: new Date().toISOString(),
          lastAction: 'startup_check',
          refusal: 'startup_check_failed',
          refusalDetail: 'The coredoc-workflows plugin did not load',
        }),
      ],
    };
    mount();

    expect(await screen.findByText(/heartbeat just now/)).toBeInTheDocument();
    expect(screen.getByText(/runner 1\.1\.0 · sdk 0\.3\.285/)).toBeInTheDocument();
    expect(screen.getByText(/creator is no longer an admin/)).toBeInTheDocument();
    expect(screen.getByText('runner-misconfigured').closest('tr')!.textContent).toMatch(
      /Start-up check failed: The coredoc-workflows plugin did not load.*just now/,
    );
  });

  it('lists what keeps runs from starting, why the trigger is idle, and each repository’s eligibility', async () => {
    settings = {
      ...settings,
      enabled: true,
      runOwner: { userId: 'u1', email: 'admin@x.test', valid: true },
      availability: {
        available: false,
        reasons: [{ code: 'github_connector_inactive', message: 'The GitHub connector is paused.' }],
      },
      trigger: {
        ready: false,
        projectKeys: [],
        reasons: [{ code: 'no_project_keys', message: 'The Jira connector has no project keys; nothing is searched.' }],
      },
      repositories: [
        { key: 'orders-api', name: 'orders-api', eligible: true, reason: null },
        { key: null, name: 'legacy-billing', eligible: false, reason: 'repository_key_missing' },
      ],
    };
    mount();

    expect(await screen.findByText('The GitHub connector is paused.')).toBeInTheDocument();
    expect(screen.getByText(/nothing is searched/)).toBeInTheDocument();
    const rows = within(screen.getByRole('region', { name: 'Repositories' })).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Key'),
      expect.stringMatching(/orders-api.*Eligible/),
      expect.stringMatching(/legacy-billing.*push again with a current CLI or desktop/),
    ]);
  });

  it('saves the trigger label, policies, budgets and model in one update', async () => {
    settings = { ...settings, enabled: true, runOwner: { userId: 'u1', email: 'admin@x.test', valid: true } };
    mount();

    fireEvent.change(await screen.findByLabelText('Trigger label'), { target: { value: 'ai-build' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assume' }));
    fireEvent.click(screen.getByRole('button', { name: 'Automatic' }));
    fireEvent.change(screen.getByLabelText('Spend per run (USD)'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Turn duration (hours)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Active time per run (hours)'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Waiting limit (days)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Started runs at once'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Repositories per run'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'test-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: 'PUT',
          path: SETTINGS_PATH,
          body: {
            triggerLabel: 'ai-build',
            startedStatus: null,
            doneStatus: null,
            failedStatus: null,
            cancelledStatus: null,
            questionsPolicy: 'assume',
            scopeAcceptancePolicy: 'automatic',
            maxSpendUsd: 40,
            maxTurnDurationSeconds: 7200,
            maxActiveSeconds: 43_200,
            waitingLimitSeconds: 259_200,
            maxStartedRuns: 4,
            maxRepositories: 3,
            model: 'test-model',
          },
        },
      ]),
    );
  });

  it('offers the Jira connector’s known statuses for each event and saves the chosen ones', async () => {
    settings = { ...settings, enabled: true, runOwner: { userId: 'u1', email: 'admin@x.test', valid: true } };
    mount();

    const started = await screen.findByRole('combobox', { name: 'Started status' });
    expect(started).toHaveTextContent('No change');
    fireEvent.keyDown(started, { key: 'ArrowDown' });
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'No change',
      'Done',
      'In Progress',
      'To Do',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    await choose('Done status', 'Done');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      startedStatus: 'In Progress',
      doneStatus: 'Done',
      failedStatus: null,
      cancelledStatus: null,
    });
  });

  it('clearing a status saves no transition for that event, even for a status the connector no longer lists', async () => {
    settings = { ...settings, enabled: true, failedStatus: 'Blocked', cancelledStatus: 'To Do' };
    mount();

    expect(await screen.findByRole('combobox', { name: 'Failed status' })).toHaveTextContent('Blocked');
    await choose('Failed status', 'No change');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({ failedStatus: null, cancelledStatus: 'To Do' });
  });
});
