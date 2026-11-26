import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router.js';

const RUN_A = '1a2b3c4d-0000-4000-8000-000000000001';
const RUN_B = '1a2b3c4d-0000-4000-8000-000000000002';
const RUN_C = '1a2b3c4d-0000-4000-8000-000000000003';

const LIST_PATH = '/api/v1/workspaces/ws1/consultant-runs';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function listRun(id: string, name: string | null, openQuestions: number, unansweredQuestions: number) {
  return { id, name, createdAt: hoursAgo(48), updatedAt: hoursAgo(1), openQuestions, unansweredQuestions };
}

const OPEN_RECORD = {
  requestId: 'r-open',
  state: 'open',
  questions: [
    {
      question: 'Which export format should be the default?',
      header: 'Format',
      options: [
        { label: 'CSV (Recommended)', description: 'Opens in spreadsheets' },
        { label: 'JSON', description: 'For integrations' },
      ],
      multiSelect: false,
    },
  ],
  answers: null,
  askedAt: hoursAgo(1),
  answeredAt: null,
};

const ANSWERED_RECORD = {
  requestId: 'r-answered',
  state: 'answered',
  questions: [
    {
      question: 'How should partial units round?',
      header: 'Rounding',
      options: [
        { label: 'Up', description: 'Always to the next unit', preview: 'In     Out\n7.05   7.25' },
        { label: 'Down', description: 'Always to the previous unit' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which channels get the notice?',
      header: 'Channels',
      options: [
        { label: 'Email', description: 'A message to the inbox' },
        { label: 'Chat', description: 'A message in the team channel' },
      ],
      multiSelect: true,
    },
  ],
  answers: [{ labels: ['Up'] }, { labels: ['Email'], other: 'Only on weekdays' }],
  askedAt: hoursAgo(30),
  answeredAt: hoursAgo(26),
};

const CANCELLED_RECORD = {
  requestId: 'r-cancelled',
  state: 'cancelled',
  questions: [
    {
      question: 'Should archived items be included?',
      header: 'Archive',
      options: [
        { label: 'Yes', description: 'Include them' },
        { label: 'No', description: 'Leave them out' },
      ],
      multiSelect: false,
    },
  ],
  answers: null,
  askedAt: hoursAgo(40),
  answeredAt: null,
};

let role: string;
let listPages: Record<number, { runs: ReturnType<typeof listRun>[]; nextOffset: number | null }>;
let listStatus: number;
let questionsStatus: number;
let records: Record<string, unknown[]>;
let requested: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  role = 'consultant';
  listPages = {
    0: {
      runs: [
        listRun(RUN_A, 'Export settings', 2, 0),
        listRun(RUN_B, null, 0, 1),
        listRun(RUN_C, 'Search filters', 0, 0),
      ],
      nextOffset: null,
    },
  };
  listStatus = 200;
  questionsStatus = 200;
  records = { [RUN_A]: [OPEN_RECORD, ANSWERED_RECORD, CANCELLED_RECORD], [RUN_B]: [CANCELLED_RECORD], [RUN_C]: [] };
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url, 'http://local.test');
      const path = parsed.pathname;
      requested.push(url);
      if (path === '/api/v1/me') {
        return json({
          user: { id: 'u1', email: 'c@example.test' },
          workspaces: [{ id: 'ws1', name: 'Acme', slug: 'acme', role, intentEnabled: false, agentRunsEnabled: true }],
        });
      }
      if (path === LIST_PATH) {
        if (listStatus !== 200) return json({ statusCode: listStatus, message: 'Forbidden' }, listStatus);
        return json(listPages[Number(parsed.searchParams.get('offset'))] ?? { runs: [], nextOffset: null });
      }
      const match = path.match(/^\/api\/v1\/workspaces\/ws1\/consultant-runs\/([^/]+)\/questions$/);
      if (match) {
        const runId = match[1]!;
        if (questionsStatus !== 200) return json({ statusCode: questionsStatus, message: 'Nope' }, questionsStatus);
        const listed = Object.values(listPages)
          .flatMap((page) => page.runs)
          .find((run) => run.id === runId);
        if (!listed || !records[runId]) return json({ statusCode: 404, message: 'Not found' }, 404);
        const { openQuestions: _o, unansweredQuestions: _u, ...run } = listed;
        return json({ run, records: records[runId] });
      }
      // Workspace reads the shell or other pages would issue stay pending.
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
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  return router;
}

async function landsOn(router: ReturnType<typeof createAppRouter>, pathname: string) {
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
}

describe('consultant routing', () => {
  it.each([
    '/w/acme',
    '/w/acme/repos',
    `/w/acme/agent-runs/${RUN_A}`,
    '/w/acme/unknown-page',
  ])('sends a consultant at %s to the consultant page', async (path) => {
    const router = mount(path);
    await landsOn(router, '/consultant/acme');
    expect(await screen.findByRole('navigation', { name: 'Runs' })).toBeInTheDocument();
  });

  it('sends a plain member at the consultant page back to the workspace', async () => {
    role = 'member';
    const router = mount('/consultant/acme');
    await landsOn(router, '/w/acme');
  });

  it('lets an admin open the consultant page with the preview strip', async () => {
    role = 'admin';
    const router = mount('/consultant/acme');
    expect(await screen.findByText('Preview: this is what consultants see in this workspace.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the workspace' })).toHaveAttribute('href', '/w/acme');
    expect(router.state.location.pathname).toBe('/consultant/acme');
  });

  it('shows no preview strip to a consultant', async () => {
    mount('/consultant/acme');
    await screen.findByRole('navigation', { name: 'Runs' });
    expect(screen.queryByText(/Preview: this is what consultants see/)).toBeNull();
  });
});

describe('consultant page', () => {
  it('lists runs with their badges and asks to choose one', async () => {
    mount('/consultant/acme');
    const nav = await screen.findByRole('navigation', { name: 'Runs' });
    const items = await within(nav).findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Export settings2 waiting2 questions wait for an answerUpdated 1 hour ago',
      'Untitled run1 unanswered1 question was closed without an answerUpdated 1 hour ago',
      'Search filtersUpdated 1 hour ago',
    ]);
    expect(within(items[0]!).getByText('2 waiting')).toHaveAttribute('aria-hidden', 'true');
    expect(within(items[0]!).getByText('2 questions wait for an answer')).toHaveClass('sr-only');
    expect(within(items[1]!).getByText('1 unanswered').closest('span.bg-danger-wash')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByText('Choose a run to see its questions.')).toBeInTheDocument();
    expect(requested.some((url) => url.includes('/questions'))).toBe(false);
  });

  it('selects a run through the URL and moves focus to its heading', async () => {
    const router = mount(`/consultant/acme?run=${RUN_A}`);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Export settings' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/^Started/)).toHaveTextContent('Started 2 days ago');
    const nav = screen.getByRole('navigation', { name: 'Runs' });
    expect(within(nav).getByRole('link', { name: /Export settings/ })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(within(nav).getByRole('link', { name: /Untitled run/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Untitled run' })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ run: RUN_B });
    expect(screen.getByRole('main')).toHaveTextContent('1 question was closed without an answer');
  });

  it('shows the records newest first as given, with their states, choices and own answers', async () => {
    mount(`/consultant/acme?run=${RUN_A}`);
    const summary = await screen.findByRole('link', { name: '1 question waits for an answer' });
    expect(summary).toHaveAttribute('href', '#q-r-open');

    const articles = screen.getAllByRole('article');
    expect(articles.map((article) => article.id)).toEqual(['q-r-open', 'q-r-answered', 'q-r-cancelled']);
    expect(screen.getByRole('article', { name: 'Waiting for an answer' })).toHaveTextContent('Open');
    expect(screen.getByRole('article', { name: 'Waiting for an answer' })).toHaveTextContent('CSV (Recommended)');

    const answered = screen.getByRole('article', { name: 'Answered' });
    expect(answered).toHaveTextContent('Asked yesterday · answered yesterday');
    const rounding = within(answered).getByRole('list', { name: 'Options: Rounding' });
    const [up, down] = within(rounding).getAllByRole('listitem');
    expect(within(up!).getByText('Chosen')).toBeInTheDocument();
    expect(within(down!).queryByText('Chosen')).toBeNull();
    const preview = within(up!).getByRole('region', { name: 'Example for Up' });
    expect(preview).toHaveClass('overflow-x-auto');
    expect(preview).toHaveAttribute('tabindex', '0');
    const text = preview.querySelector('pre');
    expect(text).toHaveClass('whitespace-pre');
    expect(text?.textContent).toBe('In     Out\n7.05   7.25');
    expect(within(answered).getByText('Any number can be chosen')).toBeInTheDocument();
    expect(within(answered).getByText('Only on weekdays').parentElement).toHaveTextContent(
      'Own answer: Only on weekdays',
    );

    const cancelled = screen.getByRole('article', { name: 'Closed without an answer' });
    expect(within(cancelled).getByText('Left undecided')).toBeInTheDocument();
    expect(within(cancelled).queryByText('Chosen')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says when a run has no questions and when nothing waits', async () => {
    records[RUN_C] = [];
    mount(`/consultant/acme?run=${RUN_C}`);
    expect(await screen.findByText('No questions on this run yet.')).toBeInTheDocument();

    cleanup();
    records[RUN_C] = [{ ...ANSWERED_RECORD }];
    mount(`/consultant/acme?run=${RUN_C}`);
    expect(await screen.findByText('No open questions')).toBeInTheDocument();
  });

  it('shows the empty list, an unavailable run, and the no-access card', async () => {
    listPages = { 0: { runs: [], nextOffset: null } };
    mount('/consultant/acme?run=unknown-run');
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
    expect(await screen.findByText('This run is not available. Choose another run from the list.')).toBeInTheDocument();

    cleanup();
    questionsStatus = 403;
    mount(`/consultant/acme?run=${RUN_A}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'No access to this page' })).toBeInTheDocument();
    expect(screen.getByText(/but your access to Acme has changed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull();
  });

  it('pages through older runs and keeps the page in the URL', async () => {
    listPages = {
      0: { runs: [listRun(RUN_A, 'Export settings', 0, 0)], nextOffset: 50 },
      50: { runs: [listRun(RUN_C, 'Search filters', 0, 0)], nextOffset: null },
    };
    const router = mount('/consultant/acme');
    expect(await screen.findByText('Runs 1–1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Runs 51–51')).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ offset: 50 });
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled();
    expect(requested).toContain(`${LIST_PATH}?limit=50&offset=50`);
    expect(screen.getByRole('link', { name: /Search filters/ })).toHaveAttribute(
      'href',
      `/consultant/acme?run=${RUN_C}&offset=50`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findByText('Runs 1–1')).toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
  });

  it('issues no request other than me and the two consultant reads', async () => {
    mount(`/consultant/acme?run=${RUN_A}`);
    await screen.findByRole('heading', { level: 1, name: 'Export settings' });
    fireEvent.click(screen.getByRole('link', { name: /Search filters/ }));
    await screen.findByText('No questions on this run yet.');
    const paths = new Set(requested.map((url) => new URL(url, 'http://local.test').pathname));
    expect([...paths].sort()).toEqual([
      '/api/v1/me',
      LIST_PATH,
      `${LIST_PATH}/${RUN_A}/questions`,
      `${LIST_PATH}/${RUN_C}/questions`,
    ]);
  });
});

describe('consultant view entry point', () => {
  it('shows the Consultant view button to an admin on the agent runs page, not to a member', async () => {
    role = 'admin';
    mount('/w/acme/agent-runs');
    expect(await screen.findByRole('link', { name: 'Consultant view' })).toHaveAttribute('href', '/consultant/acme');

    cleanup();
    role = 'member';
    mount('/w/acme/agent-runs');
    await screen.findByRole('heading', { level: 1, name: 'Agent runs' });
    expect(screen.queryByRole('link', { name: 'Consultant view' })).toBeNull();
  });
});
