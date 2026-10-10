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

const REQUEST_ID = '5d7e8f90-1a2b-4c3d-9e8f-7a6b5c4d3e2f';

function openQuestion() {
  return {
    requestId: REQUEST_ID,
    kind: 'clarification',
    phase: 'scope',
    state: 'open',
    questions: [
      {
        question: 'Which colour should the export button use?',
        header: 'Colour',
        options: [
          { label: 'Red', description: 'Matches the alerts' },
          { label: 'Blue', description: 'Matches the brand', preview: '<button class="blue">Export</button>' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which formats should the export offer?',
        header: 'Formats',
        options: [
          { label: 'CSV', description: 'Spreadsheets' },
          { label: 'JSON', description: 'Integrations' },
        ],
        multiSelect: true,
      },
    ],
    answers: null,
    askedAt: '2026-10-10T09:00:00.000Z',
    answeredAt: null,
    answeredBy: null,
  };
}

let answerReply: 'ok' | 'already_answered' = 'ok';

let specs: ReturnType<typeof spec>[] = [];
let reviewAnswer: 'ok' | 'stale' = 'ok';

let agentRunsEnabled = true;
let posts: { path: string; body: unknown }[] = [];
let detail: Record<string, unknown>;
let timelineEvents: Array<{
  seq: number;
  turnId?: string | null;
  type: string;
  payload: Record<string, unknown>;
  truncated: boolean;
  createdAt: string;
}> = EVENTS;
let availability: { available: boolean; reasons: { code: string; message: string }[] };
let runnerTokens: Record<string, unknown>[] = [];
let listNextOffset: number | null = null;
const NO_ACTIVITY = { turns: [], skills: [], tools: [] };
let activity: Record<string, unknown> = NO_ACTIVITY;

beforeEach(() => {
  agentRunsEnabled = true;
  posts = [];
  detail = run();
  timelineEvents = EVENTS;
  specs = [];
  reviewAnswer = 'ok';
  answerReply = 'ok';
  availability = { available: true, reasons: [] };
  runnerTokens = [];
  listNextOffset = null;
  activity = NO_ACTIVITY;
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
        if (/\/questions\/[^/]+\/answer$/.test(path)) {
          if (answerReply === 'already_answered') {
            return new Response(
              JSON.stringify({
                statusCode: 409,
                code: 'QUESTION_ALREADY_ANSWERED',
                message: 'This question has already been answered',
              }),
              { status: 409 },
            );
          }
          return new Response(JSON.stringify(detail));
        }
        if (path.endsWith('/cancel')) {
          detail = { ...detail, status: 'cancelled', currentTurn: null };
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
        return new Response(JSON.stringify({ runs: [run()], nextOffset: listNextOffset }));
      if (path === '/api/v1/workspaces/ws1/cloud-agent-runs/settings')
        return new Response(JSON.stringify({ availability, runnerTokens }));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}`) return new Response(JSON.stringify(detail));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RERUN_ID}`)
        return new Response(JSON.stringify(run({ id: RERUN_ID, trigger: 'rerun', previousRunId: RUN_ID })));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/activity`)
        return new Response(JSON.stringify(activity));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/specs`)
        return new Response(JSON.stringify({ versions: specs }));
      if (path === `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/events`) {
        const params = new URL(url, 'http://local.test').searchParams;
        const after = Number(params.get('after') ?? 0);
        const limit = Number(params.get('limit') ?? 200);
        const page = [...timelineEvents]
          .sort((a, b) => a.seq - b.seq)
          .filter((event) => event.seq > after)
          .slice(0, limit);
        const lastSeq = Math.max(0, ...timelineEvents.map((event) => event.seq));
        return new Response(JSON.stringify({ events: page, lastSeq }));
      }
      // Unrelated shell reads (repos, members) stay pending.
      return new Promise<Response>(() => undefined);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('deep-links to a run: header, the stage under way, and the waiting note', async () => {
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    expect(await screen.findByRole('heading', { name: 'PROJ-7' })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for an agent runner since/)).toBeInTheDocument();
    const stages = await screen.findByRole('navigation', { name: 'Stages' });
    expect(await within(stages).findByRole('button', { name: /Scope.*so far/ })).toBeInTheDocument();
    expect(within(stages).getByText('Total')).toBeInTheDocument();
    const conversation = screen.getByRole('region', { name: 'Conversation' });
    expect(within(conversation).getByText('Started')).toBeInTheDocument();
    // Raw runner lines stay in the trace.
    expect(within(conversation).queryByText(/no agent configured/)).toBeNull();
  });

  it('heads the run page with the Jira issue link, status and phase, and lists the agent’s current tasks', async () => {
    detail = run({ issueUrl: 'https://example.atlassian.net/browse/PROJ-7' });
    timelineEvents = [
      ...EVENTS,
      { seq: 5, type: 'todos', payload: { items: [{ text: 'Read the PRD', status: 'in_progress' }] } },
      {
        seq: 6,
        type: 'todos',
        payload: {
          items: [
            { text: 'Read the PRD', status: 'completed' },
            { text: 'Draft the spec', status: 'in_progress' },
            { text: 'Propose the scope', status: 'pending' },
          ],
        },
      },
    ].map((event) => ({ ...event, truncated: false, createdAt: '2026-10-10T09:00:00.000Z' }));
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    expect(await screen.findByRole('link', { name: /Open PROJ-7 in Jira/ })).toHaveAttribute(
      'href',
      'https://example.atlassian.net/browse/PROJ-7',
    );
    expect(screen.getByText('Scope phase')).toBeInTheDocument();

    const tasks = await screen.findByRole('list', { name: 'Agent tasks' });
    expect(
      within(tasks)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/Done.*Read the PRD/),
      expect.stringMatching(/In progress.*Draft the spec/),
      expect.stringMatching(/To do.*Propose the scope/),
    ]);
  });

  it('shows when each runner token last claimed or heartbeated', async () => {
    runnerTokens = [
      {
        id: 'rt1',
        name: 'prod-runner',
        lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        lastAction: 'heartbeat',
        refusal: null,
      },
      { id: 'rt2', name: 'spare-runner', lastSeenAt: null, lastAction: null, refusal: null },
      {
        id: 'rt3',
        name: 'new-runner',
        lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        lastAction: 'startup_check',
        refusal: 'startup_check_failed',
        refusalDetail: 'The bot account can administer acme/orders',
      },
    ];
    mount('/w/acme/agent-runs');

    const runners = await screen.findByRole('list', { name: 'Agent runners' });
    expect(
      within(runners)
        .getByText(/prod-runner/)
        .closest('li')!.textContent,
    ).toMatch(/heartbeat .*2 min/);
    expect(
      within(runners)
        .getByText(/spare-runner/)
        .closest('li')!.textContent,
    ).toMatch(/never connected/i);
    expect(
      within(runners)
        .getByText(/new-runner/)
        .closest('li')!.textContent,
    ).toMatch(/Start-up check failed: The bot account can administer acme\/orders.*1 min/);
  });

  it('says when the run list shows only the newest runs', async () => {
    listNextOffset = 50;
    mount('/w/acme/agent-runs');
    expect(await screen.findByText(/Showing the 50 newest runs/)).toBeInTheDocument();
  });

  it('reads the whole timeline of a finished run, page after page', async () => {
    detail = run({ status: 'done', currentTurn: null });
    timelineEvents = Array.from({ length: 1_200 }, (_, index) => ({
      seq: index + 1,
      type: index === 1_199 ? 'run_event' : 'raw',
      payload:
        index === 1_199
          ? { code: 'workflow_diff_withheld', text: 'Workflow changes withheld', paths: ['ci.yml'], diff: null }
          : { text: `line ${index + 1}` },
      truncated: false,
      createdAt: '2026-10-10T09:00:00.000Z',
    }));
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    const conversation = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(conversation).findByText('Workflow changes withheld')).toBeInTheDocument();
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

  it('cancels an active run once the member confirms, and then offers a re-run', async () => {
    mount(`/w/acme/agent-runs/${RUN_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    await waitFor(() =>
      expect(posts).toEqual([{ path: `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/cancel`, body: undefined }]),
    );
    expect(await screen.findByRole('button', { name: 'Re-run' })).toBeInTheDocument();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  it('offers no cancel once the run has ended', async () => {
    detail = run({ status: 'done', currentTurn: null });
    mount(`/w/acme/agent-runs/${RUN_ID}`);
    expect(await screen.findByRole('button', { name: 'Re-run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  describe('questions', () => {
    beforeEach(() => {
      detail = run({
        status: 'awaiting_answer',
        currentTurn: null,
        openQuestion: openQuestion(),
        questions: [openQuestion()],
        assumptions: [],
      });
    });

    it('shows the open question with headers, option descriptions, previews and the right kind of choice', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const card = await screen.findByRole('region', { name: 'Question from the agent' });

      const colour = within(card).getByRole('group', { name: /Colour/ });
      expect(within(colour).getByText('Which colour should the export button use?')).toBeInTheDocument();
      expect(within(colour).getByRole('radio', { name: /Blue/ })).toBeInTheDocument();
      expect(within(colour).getByText('Matches the brand')).toBeInTheDocument();
      expect(within(colour).getByText('<button class="blue">Export</button>')).toBeInTheDocument();
      expect(card.querySelector('button.blue')).toBeNull();

      const formats = within(card).getByRole('group', { name: /Formats/ });
      expect(within(formats).getAllByRole('checkbox')).toHaveLength(2);
      expect(within(formats).queryByRole('radio')).toBeNull();
    });

    it('answers with the chosen options and free text', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const card = await screen.findByRole('region', { name: 'Question from the agent' });
      const send = within(card).getByRole('button', { name: 'Send answer' });
      expect(send).toBeDisabled();

      const colour = within(card).getByRole('group', { name: /Colour/ });
      fireEvent.click(within(colour).getByRole('radio', { name: /Blue/ }));
      const formats = within(card).getByRole('group', { name: /Formats/ });
      fireEvent.click(within(formats).getByRole('checkbox', { name: /CSV/ }));
      fireEvent.change(within(formats).getByLabelText('Other answer'), { target: { value: 'Parquet' } });
      fireEvent.click(send);

      await waitFor(() =>
        expect(posts).toEqual([
          {
            path: `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/questions/${REQUEST_ID}/answer`,
            body: { answers: [{ labels: ['Blue'] }, { labels: ['CSV'], other: 'Parquet' }] },
          },
        ]),
      );
    });

    it('a single-choice question can be answered with free text instead of an option', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const card = await screen.findByRole('region', { name: 'Question from the agent' });
      const colour = within(card).getByRole('group', { name: /Colour/ });
      fireEvent.click(within(colour).getByRole('radio', { name: /Red/ }));
      fireEvent.click(within(colour).getByRole('radio', { name: 'Other' }));
      fireEvent.change(within(colour).getByLabelText('Other answer'), { target: { value: 'Brand green' } });
      const formats = within(card).getByRole('group', { name: /Formats/ });
      fireEvent.click(within(formats).getByRole('checkbox', { name: /JSON/ }));
      fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }));

      await waitFor(() =>
        expect(posts[0]?.body).toEqual({ answers: [{ labels: [], other: 'Brand green' }, { labels: ['JSON'] }] }),
      );
    });

    it('a repository request offers only "Add" and "Don\'t add", with no free text', async () => {
      const request = {
        ...openQuestion(),
        kind: 'repository_request',
        phase: 'implement',
        questions: [
          {
            question: 'The agent asks to add repository `search-api` to this run. Add it?',
            header: 'Repository',
            options: [
              { label: 'Add', description: "Clone it into the run. The agent's reason: Owns the search index" },
              { label: "Don't add", description: 'The agent continues without it.' },
            ],
            multiSelect: false,
          },
        ],
      };
      detail = run({ status: 'awaiting_answer', currentTurn: null, openQuestion: request, questions: [request] });
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const card = await screen.findByRole('region', { name: 'Repository request from the agent' });
      expect(within(card).getByText(/Owns the search index/)).toBeInTheDocument();
      expect(within(card).getAllByRole('radio')).toHaveLength(2);
      expect(within(card).queryByLabelText('Other answer')).toBeNull();

      fireEvent.click(within(card).getByRole('radio', { name: /Don't add/ }));
      fireEvent.click(within(card).getByRole('button', { name: 'Send decision' }));
      await waitFor(() => expect(posts[0]?.body).toEqual({ answers: [{ labels: ["Don't add"] }] }));
    });

    it('says so when someone else answered first', async () => {
      answerReply = 'already_answered';
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const card = await screen.findByRole('region', { name: 'Question from the agent' });
      fireEvent.click(within(within(card).getByRole('group', { name: /Colour/ })).getByRole('radio', { name: /Red/ }));
      fireEvent.click(
        within(within(card).getByRole('group', { name: /Formats/ })).getByRole('checkbox', { name: /CSV/ }),
      );
      fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }));

      expect(await within(card).findByText(/already been answered/)).toBeInTheDocument();
    });

    it('shows an answered question with the chosen options marked, and no answer form', async () => {
      const answered = {
        ...openQuestion(),
        state: 'answered',
        answers: [{ labels: ['Blue'] }, { labels: ['CSV'], other: 'Parquet' }],
        answeredAt: '2026-10-10T09:05:00.000Z',
        answeredBy: 'u1',
      };
      detail = run({ status: 'scoping', currentTurn: null, openQuestion: null, questions: [answered] });
      mount(`/w/acme/agent-runs/${RUN_ID}`);

      const colour = await screen.findByRole('list', { name: 'Options: Colour' });
      expect(within(colour).getByText('Blue')).toHaveAttribute('aria-current', 'true');
      expect(within(colour).getByText('Red')).not.toHaveAttribute('aria-current');
      const formats = screen.getByRole('list', { name: 'Options: Formats' });
      expect(within(formats).getByText('Parquet').closest('li')).toHaveAttribute('aria-current', 'true');
      expect(screen.queryByRole('region', { name: 'Question from the agent' })).toBeNull();
    });
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

    it('shows both proposals and the review between them, with the review actions on the latest only', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      const conversation = await screen.findByRole('region', { name: 'Conversation' });

      expect(await within(conversation).findByText('Scope v1')).toBeInTheDocument();
      expect(within(conversation).getByText('Scope v2')).toBeInTheDocument();
      expect(within(conversation).getByText('Changes requested on v1')).toBeInTheDocument();
      expect(within(conversation).getByText('Cover billing too.')).toBeInTheDocument();
      expect(within(conversation).getAllByRole('region', { name: 'Scope review' })).toHaveLength(1);
      expect(
        within(conversation).getByText('Scope v2').closest('li')!.querySelector('[aria-label="Scope review"]'),
      ).not.toBeNull();
    });

    it('opens the spec in a drawer: repositories with eligibility, dropped seeds and candidates', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Spec: v2 · Proposed' }));

      const drawer = await screen.findByRole('dialog', { name: 'Spec' });
      const document = within(drawer).getByRole('article', { name: 'Spec v2' });
      const rows = within(within(document).getByRole('table', { name: 'Repositories' }))
        .getAllByRole('row')
        .map((row) => row.textContent);
      expect(rows[1]).toContain('orders-api');
      expect(rows[1]).toContain('Owns the order records');
      expect(rows[2]).toMatch(/billing-api.*Not eligible/);
      expect(within(document).getByText(/legacy-tool/)).toBeInTheDocument();
      expect(within(document).getByText('Should exports include refunds?')).toBeInTheDocument();
    });

    it('never renders a remote image from agent-written markdown', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Open spec v2' }));
      const drawer = await screen.findByRole('dialog', { name: 'Spec' });

      expect(drawer.querySelector('img')).toBeNull();
      expect(within(drawer).getByText(/architecture/)).toHaveTextContent('https://images.example.com/diagram.png');
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

    it('switches the spec drawer to an earlier version with the reviewer’s feedback', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Spec: v2 · Proposed' }));
      const drawer = await screen.findByRole('dialog', { name: 'Spec' });
      fireEvent.click(await within(drawer).findByRole('button', { name: 'v1' }));

      const document = within(drawer).getByRole('article', { name: 'Spec v1' });
      expect(within(document).getByText('Changes requested')).toBeInTheDocument();
      expect(within(document).getByText('Cover billing too.')).toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: 'Accept scope' })).toBeNull();
    });
  });

  describe('implementation', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    it('shows the result with what is not built or tested, what was withheld, the assumptions and the withheld workflow diff', async () => {
      detail = run({
        status: 'delivering',
        phase: 'delivery',
        currentTurn: null,
        openQuestion: null,
        questions: [],
        assumptions: [{ phase: 'implement', text: 'Exports are CSV only' }],
        result: { summary: 'Added the orders export.', repositories: [], notes: '' },
        repositories: [
          {
            key: 'billing-api',
            reason: 'Owns invoices',
            mergeOrder: 0,
            origin: 'proposal',
            eligible: true,
            branchCreated: false,
            touched: false,
            lastPushedHead: null,
            notBuiltOrTested: 'Its tests need Docker compose',
            withheldPaths: ['.env'],
          },
          {
            key: 'orders-api',
            reason: 'Owns orders',
            mergeOrder: 1,
            origin: 'label',
            eligible: true,
            branchCreated: true,
            touched: true,
            lastPushedHead: HEAD,
            notBuiltOrTested: null,
            withheldPaths: ['.github/workflows/ci.yml'],
          },
        ],
      });
      timelineEvents = [
        ...EVENTS,
        {
          seq: 5,
          type: 'run_event',
          payload: { code: 'branch_pushed', text: 'Pushed coredoc/PROJ-7 in orders-api', head: HEAD },
          truncated: false,
          createdAt: '2026-10-10T09:00:00.000Z',
        },
        {
          seq: 6,
          type: 'run_event',
          payload: {
            code: 'workflow_diff_withheld',
            text: 'Workflow changes in orders-api were withheld from the push for a person to apply',
            repository: 'orders-api',
            paths: ['.github/workflows/ci.yml'],
            diff: '+    runs-on: ubuntu-latest',
            note: null,
          },
          truncated: false,
          createdAt: '2026-10-10T09:00:00.000Z',
        },
      ] as typeof EVENTS;
      mount(`/w/acme/agent-runs/${RUN_ID}`);

      const conversation = await screen.findByRole('region', { name: 'Conversation' });
      const result = (await within(conversation).findByText('Result')).closest('li')!;
      expect(within(result).getByText('Added the orders export.')).toBeInTheDocument();
      expect(within(result).getByText(/Exports are CSV only/)).toBeInTheDocument();
      expect(
        within(result)
          .getAllByRole('listitem')
          .map((row) => row.textContent),
      ).toEqual([
        'billing-api: not built or tested in the runner (Its tests need Docker compose)',
        'billing-api: left out of the push: .env',
        'orders-api: left out of the push: .github/workflows/ci.yml',
        'Exports are CSV only',
      ]);

      expect(await within(conversation).findByText(/Workflow changes in orders-api were withheld/)).toBeInTheDocument();
      expect(
        within(conversation).getByText('+    runs-on: ubuntu-latest', { normalizer: (text) => text }),
      ).toBeInTheDocument();
    });
  });

  describe('trace', () => {
    const at = (minute: number) => `2026-10-10T09:${String(minute).padStart(2, '0')}:00.000Z`;
    const event = (seq: number, turnId: string | null, type: string, payload: Record<string, unknown>) => ({
      seq,
      turnId,
      type,
      payload,
      truncated: false,
      createdAt: at(seq),
    });

    beforeEach(() => {
      activity = {
        turns: [
          {
            id: 'turn-1',
            ordinal: 1,
            kind: 'scope',
            state: 'completed',
            outcome: 'no_outcome',
            startedAt: at(1),
            endedAt: at(12),
            durationSeconds: 660,
            spendUsd: 0.4,
            toolCalls: 3,
            failedToolCalls: 1,
          },
          {
            id: 'turn-2',
            ordinal: 2,
            kind: 'scope',
            state: 'claimed',
            outcome: null,
            startedAt: at(13),
            endedAt: null,
            durationSeconds: null,
            spendUsd: null,
            toolCalls: 1,
            failedToolCalls: 0,
          },
        ],
        skills: [{ name: 'coredoc-workflows:coredoc-spec', count: 2 }],
        tools: [
          { name: 'Read', server: null, count: 2 },
          { name: 'Bash', server: null, count: 1 },
          { name: 'search_symbols', server: 'coredoc', count: 1 },
        ],
      };
      timelineEvents = [
        event(1, 'turn-1', 'turn_started', { kind: 'scope', attempt: 1 }),
        event(2, 'turn-1', 'raw', { text: '[init] model=default' }),
        event(3, 'turn-1', 'skill', { name: 'coredoc-workflows:coredoc-spec' }),
        event(4, 'turn-1', 'tool', { name: 'Read', target: 'PRD.md', summary: '42 lines', isError: false }),
        event(5, 'turn-1', 'message', { text: 'The PRD names one service.' }),
        event(6, 'turn-1', 'tool', {
          name: 'Bash',
          target: 'pnpm test',
          summary: '2 failed',
          isError: true,
          errorOutput: 'FAIL orders.test.ts > exports CSV',
        }),
        event(7, 'turn-1', 'tool', {
          name: 'search_symbols',
          server: 'coredoc',
          target: 'order export',
          summary: '6 symbols',
          isError: false,
        }),
        event(8, 'turn-1', 'turn_ended', { outcome: 'no_outcome', spendUsd: 0.4 }),
        event(9, 'turn-2', 'turn_started', { kind: 'scope', attempt: 1 }),
        event(10, 'turn-2', 'skill', { name: 'coredoc-workflows:coredoc-spec' }),
        event(11, 'turn-2', 'tool', { name: 'Read', target: 'src/orders.ts', summary: '10 lines', isError: false }),
      ];
    });

    it('opens every turn’s trace in a drawer: tool rows with results, failures with their output, messages, and the transcript download', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: /^Trace: / }));

      const drawer = await screen.findByRole('dialog', { name: 'Trace' });
      const first = within(drawer).getByRole('list', { name: 'Scope 1 trace' });
      expect(
        within(first)
          .getAllByRole('listitem')
          .map((row) => row.textContent),
      ).toEqual([
        expect.stringContaining('[init] model=default'),
        expect.stringMatching(/Skill.*coredoc-spec/),
        expect.stringMatching(/Read.*PRD\.md.*42 lines/),
        expect.stringContaining('The PRD names one service.'),
        expect.stringMatching(/Bash.*pnpm test.*2 failed.*FAIL orders\.test\.ts > exports CSV/),
        expect.stringMatching(/MCP.*search_symbols order export.*6 symbols/),
      ]);
      expect(within(first).getByText('FAIL orders.test.ts > exports CSV').closest('li')).toHaveAttribute(
        'data-failed',
        'true',
      );
      expect(within(drawer).getByRole('list', { name: 'Scope 2 trace' })).toBeInTheDocument();
      expect(within(drawer).getByRole('link', { name: /Download transcript/ })).toHaveAttribute(
        'href',
        `/api/v1/workspaces/ws1/cloud-agent-runs/${RUN_ID}/transcript?phase=scope`,
      );
    });

    it('opens a turn’s trace from its timeline line, with only that turn expanded', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Trace of turn 2' }));

      const drawer = await screen.findByRole('dialog', { name: 'Trace' });
      expect(within(drawer).getByRole('list', { name: 'Scope 2 trace' }).closest('details')).toHaveAttribute('open');
      expect(within(drawer).getByRole('list', { name: 'Scope 1 trace' }).closest('details')).not.toHaveAttribute(
        'open',
      );
    });

    it('shows a question the turn asked, with the options the person chose', async () => {
      detail = run({
        status: 'scoping',
        currentTurn: null,
        questions: [
          {
            ...openQuestion(),
            state: 'answered',
            answers: [{ labels: ['Blue'] }, { labels: ['CSV'], other: 'Parquet' }],
            askedAt: at(5),
            answeredAt: at(9),
            answeredBy: 'u1',
            askedInTurnId: 'turn-1',
          },
        ],
      });
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Trace of turn 1' }));

      const first = within(await screen.findByRole('dialog', { name: 'Trace' })).getByRole('list', {
        name: 'Scope 1 trace',
      });
      const rows = within(first)
        .getAllByRole('listitem')
        .map((row) => row.textContent);
      expect(rows.indexOf(rows.find((row) => row?.includes('Colour · Formats'))!)).toBe(4);
      expect(rows[4]).toMatch(/Ask.*Colour · Formats.*answered.*Colour.*Blue.*Formats.*CSV, Other: Parquet/);
    });

    it('counts the skills and tools the agent used', async () => {
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: /^Skills and tools: / }));

      const drawer = await screen.findByRole('dialog', { name: 'Skills and tools' });
      const rows = (name: string) =>
        within(within(drawer).getByRole('list', { name }))
          .getAllByRole('listitem')
          .map((row) => row.textContent);
      expect(rows('Skills')).toEqual(['coredoc-spec2']);
      expect(rows('Tools')).toEqual(['Read2', 'Bash1', 'search_symbols1']);
    });
  });

  describe('product intent and stages', () => {
    const ref = (id: string, title: string | null, authority: string | null, location: string | null) => ({
      id,
      title,
      kind: title ? 'business_rule' : null,
      authority,
      location,
    });

    it('lists the intent the agent read and the candidates it proposed, linking to Intent review', async () => {
      activity = {
        ...NO_ACTIVITY,
        turns: [
          {
            id: 'turn-1',
            ordinal: 1,
            kind: 'implement',
            state: 'completed',
            outcome: 'result_submitted',
            startedAt: '2026-10-10T09:00:00.000Z',
            endedAt: '2026-10-10T09:10:00.000Z',
            durationSeconds: 600,
            spendUsd: 1,
            toolCalls: 4,
            failedToolCalls: 0,
          },
        ],
        intent: {
          read: [
            ref('br-default-table', 'Status output stays human-readable by default', 'accepted', 'CLI · Status'),
            ref('br-gone', null, null, null),
          ],
          proposed: [ref('br-json-opt-in', 'JSON status output is opt-in', 'candidate', 'CLI · Status')],
        },
      };
      mount(`/w/acme/agent-runs/${RUN_ID}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Product intent: 2 items read' }));

      const drawer = await screen.findByRole('dialog', { name: 'Product intent' });
      expect(
        within(within(drawer).getByRole('list', { name: 'Read by the agent' }))
          .getAllByRole('listitem')
          .map((row) => row.textContent),
      ).toEqual([
        'Status output stays human-readable by defaultCLI · Status',
        'br-goneNo longer in the product intent',
      ]);
      expect(within(drawer).getByRole('list', { name: 'Proposed' }).textContent).toBe(
        'JSON status output is opt-inCLI · StatusWaiting for Intent review',
      );
      expect(within(drawer).getByRole('link', { name: 'Open Intent review' })).toHaveAttribute(
        'href',
        '/w/acme/intent',
      );
    });

    it('scrolls the conversation to a stage when it is clicked', async () => {
      const scrolled: string[] = [];
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
        scrolled.push(this.id);
      });
      specs = [
        spec(1, 'changes_requested', { reviewText: 'Cover billing too.', reviewedAt: '2026-10-10T09:20:00.000Z' }),
      ];
      detail = run({ status: 'scoping', latestSpec: specs[0], currentTurn: null });
      timelineEvents = [
        { seq: 1, type: 'status_changed', payload: { to: 'scoping' }, createdAt: '2026-10-10T09:00:00.000Z' },
        {
          seq: 2,
          type: 'status_changed',
          payload: { to: 'awaiting_scope_acceptance' },
          createdAt: '2026-10-10T09:00:00.000Z',
        },
        { seq: 3, type: 'status_changed', payload: { to: 'scoping' }, createdAt: '2026-10-10T09:20:00.000Z' },
      ].map((event) => ({ ...event, truncated: false }));
      mount(`/w/acme/agent-runs/${RUN_ID}`);

      const stages = await screen.findByRole('navigation', { name: 'Stages' });
      fireEvent.click(await within(stages).findByRole('button', { name: /^Review/ }));
      expect(scrolled).toEqual(['run-review-1']);
    });
  });

  describe('delivery', () => {
    const pull = (repository: string, number: number, state = 'open') => ({
      repository,
      number,
      url: `https://github.com/example-org/${repository}/pull/${number}`,
      state,
      draft: state === 'open',
      created: true,
      verifiedAt: '2026-10-10T09:00:00.000Z',
    });

    it('links the verified pull requests in merge order and shows the Jira outcome', async () => {
      detail = run({
        status: 'done',
        phase: 'delivery',
        currentTurn: null,
        openQuestion: null,
        questions: [],
        assumptions: [],
        repositories: [],
        pullRequests: [pull('billing-api', 4), pull('orders-api', 9, 'merged')],
        jiraOutcome: {
          done: { state: 'posted', attempts: 0, nextAttemptAt: null, commentId: '20001' },
          transition: { outcome: 'warning', reason: 'No transition to Done is available for the issue.' },
        },
      });
      mount(`/w/acme/agent-runs/${RUN_ID}`);

      const links = await screen.findAllByRole('link', { name: /^Pull request #/ });
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        'https://github.com/example-org/billing-api/pull/4',
        'https://github.com/example-org/orders-api/pull/9',
      ]);
      expect(links.map((link) => link.textContent)).toEqual([
        expect.stringContaining('#4 · Draft'),
        expect.stringContaining('#9 · Merged'),
      ]);
      const conversation = screen.getByRole('region', { name: 'Conversation' });
      expect(within(conversation).getByText('PR #4, PR #9')).toBeInTheDocument();
      expect(within(conversation).getByText(/Done comment posted on Jira/)).toBeInTheDocument();
      expect(within(conversation).getByText(/No transition to Done is available/)).toBeInTheDocument();
    });

    it('says when the Jira failure comment could not be posted', async () => {
      detail = run({
        status: 'failed',
        failureCode: 'delivery_failed',
        failureReason: 'GitHub refused.',
        phase: 'delivery',
        currentTurn: null,
        openQuestion: null,
        questions: [],
        assumptions: [],
        repositories: [],
        pullRequests: [],
        jiraOutcome: {
          failure: { state: 'not_posted', attempts: 5, nextAttemptAt: null, reason: 'Jira answered 503.' },
        },
      });
      mount(`/w/acme/agent-runs/${RUN_ID}`);

      const conversation = await screen.findByRole('region', { name: 'Conversation' });
      expect(
        within(conversation).getByText(/Failure comment not posted on Jira: Jira answered 503\./),
      ).toBeInTheDocument();
    });
  });
});
