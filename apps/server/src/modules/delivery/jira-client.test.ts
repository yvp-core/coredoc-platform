import { describe, it, expect, vi, afterEach } from 'vitest';
import { JiraApiError, JiraClient, JiraAuthError, JiraNotFoundError, JiraRateLimitError } from './jira-client.js';

/** Build a mock `Response`-like object with a JSON body + header support. */
function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const status = init?.status ?? 200;
  const headers = init?.headers ?? {};
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const BASE = 'https://acme.atlassian.net';
const EMAIL = 'e@x.com';
const TOKEN = 'tok';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

function makeClient(baseUrl: string = BASE): JiraClient {
  return new JiraClient({ baseUrl, email: EMAIL, apiToken: TOKEN });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JiraClient.searchIssues', () => {
  it('case 1: POSTs /rest/api/3/search/jql with correct headers + body, returns issues', async () => {
    const issues = [{ id: '1', key: 'KEY-1' }];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ issues }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const out = await client.searchIssues('project = FOO', ['summary', 'status']);

    expect(out).toEqual({ items: issues, nextPageToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toMatchObject({
      Authorization: EXPECTED_AUTH,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      jql: 'project = FOO',
      maxResults: 100,
      fields: ['summary', 'status'],
      // /search/jql takes `expand` as a comma-separated STRING (the removed
      // /search took an array). Live Jira Cloud 400s on the array shape.
      expand: 'changelog',
    });
    // No pagination token on the first page.
    expect(body).not.toHaveProperty('nextPageToken');
  });

  it('case 2: follows nextPageToken across pages and stops when absent', async () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [a], nextPageToken: 'T' }))
      .mockResolvedValueOnce(jsonResponse({ issues: [b] }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().searchIssues('jql', ['summary']);

    expect(out).toEqual({ items: [a, b], nextPageToken: null });
    // Exactly two requests — no page-3 fetch once the token is gone.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const page1Body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(page1Body).not.toHaveProperty('nextPageToken');
    const page2Body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(page2Body.nextPageToken).toBe('T');
  });

  it('case 3: page cap stops after maxPages even when every page returns a token', async () => {
    const page = () => jsonResponse({ issues: [{ id: 'x' }], nextPageToken: 'MORE' });
    const fetchMock = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().searchIssues('jql', ['summary'], { maxPages: 2 });

    expect(out).toEqual({ items: [{ id: 'x' }, { id: 'x' }], nextPageToken: 'MORE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('case 3b: resumes from an opaque nextPageToken without altering it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [{ id: 'later' }], nextPageToken: 'opaque-next' }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().searchIssues('project = FOO ORDER BY updated ASC', ['summary'], {
      maxPages: 1,
      nextPageToken: 'opaque-resume',
    });

    expect(out).toEqual({ items: [{ id: 'later' }], nextPageToken: 'opaque-next' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.nextPageToken).toBe('opaque-resume');
  });

  it('case 3c: expandChangelog false leaves changelog expansion out of the request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ issues: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().searchIssues('project = FOO', ['labels'], { expandChangelog: false });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('expand');
  });
});

describe('JiraClient error taxonomy', () => {
  it('case 4a: 401 throws JiraAuthError (status+path only, no body reflected)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .listStatuses()
      .catch((e) => e);
    expect(err).toBeInstanceOf(JiraAuthError);
    // Conservative: never echo the response body on an auth path.
    expect((err as Error).message).toBe('Jira auth/permission failure (401) for /rest/api/3/status');
    expect((err as Error).message).not.toContain('unauthorized');
  });

  it('case 4b: 403 throws JiraAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().listStatuses()).rejects.toBeInstanceOf(JiraAuthError);
  });

  it('case 4c: 429 throws JiraRateLimitError (status+path only, no body reflected)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'slow down' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .listStatuses()
      .catch((e) => e);
    expect(err).toBeInstanceOf(JiraRateLimitError);
    // Conservative: never echo the response body on a rate-limit path.
    expect((err as Error).message).toBe('Jira rate limit (429) for /rest/api/3/status');
    expect((err as Error).message).not.toContain('slow down');
  });

  it('case 4d: 500 throws a body-free plain Error (transient, not Auth/RateLimit)', async () => {
    const response = jsonResponse({ errorMessages: ['secret provider detail'] }, { status: 500 });
    const textSpy = vi.spyOn(response, 'text');
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .listStatuses()
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JiraAuthError);
    expect(err).not.toBeInstanceOf(JiraRateLimitError);
    expect((err as Error).message).toBe('Jira API 500 for /rest/api/3/status');
    expect((err as Error).message).not.toContain('secret provider detail');
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('case 4e: generic errors never consume or reflect a long provider body', async () => {
    const longBody = `${'x'.repeat(120)}\nsecond line ${'y'.repeat(120)}`;
    const response = jsonResponse(longBody, { status: 400 });
    const textSpy = vi.spyOn(response, 'text');
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .searchIssues('project = FOO', ['summary'])
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Jira API 400 for /rest/api/3/search/jql');
    expect((err as Error).message).not.toContain('second line');
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('case 4f: generic errors do not touch an unreadable response body', async () => {
    const textSpy = vi.fn(async () => {
      throw new Error('stream already consumed');
    });
    const failingResponse = {
      status: 502,
      ok: false,
      headers: { get: () => null },
      json: async () => ({}),
      text: textSpy,
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(failingResponse);
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .listStatuses()
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Jira API 502 for /rest/api/3/status');
    expect(textSpy).not.toHaveBeenCalled();
  });
});

describe('JiraClient.listChangelog', () => {
  it('case 5: GETs changelog with startAt pagination, merges values oldest-first', async () => {
    const v1 = { id: '1' };
    const v2 = { id: '2' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ values: [v1], isLast: false, total: 2 }))
      .mockResolvedValueOnce(jsonResponse({ values: [v2], isLast: true }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listChangelog('KEY-1');

    expect(out).toEqual({ items: [v1, v2], total: 2, nextStartAt: null, incomplete: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/KEY-1/changelog?startAt=0&maxResults=100',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/KEY-1/changelog?startAt=1&maxResults=100',
    );
    // GET with no body.
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('case 5b: reports an honest continuation when the bounded page cap is reached', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: String(index) }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ values: page, isLast: false, total: 250 }))
      .mockResolvedValueOnce(jsonResponse({ values: page, isLast: false, total: 250 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listChangelog('10001', { maxPages: 2 });

    expect(out).toMatchObject({ total: 250, nextStartAt: 200, incomplete: true });
    expect(out.items).toHaveLength(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('case 5c: an empty non-terminal page stops safely but remains truthfully incomplete', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ values: [], isLast: false, total: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().listChangelog('10001')).resolves.toEqual({
      items: [],
      total: 5,
      nextStartAt: 0,
      incomplete: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('case 5d: follows Jira-clamped 50-item pages contiguously without skipping changelog history', async () => {
    const values = (offset: number) => Array.from({ length: 50 }, (_, index) => ({ id: String(offset + index) }));
    const endpoint = `${BASE}/rest/api/3/issue/KEY-1/changelog`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 0,
          maxResults: 50,
          total: 150,
          isLast: false,
          values: values(0),
          nextPage: `${endpoint}?startAt=50&maxResults=50`,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 50,
          maxResults: 50,
          total: 150,
          isLast: false,
          values: values(50),
          nextPage: `${endpoint}?startAt=100&maxResults=50`,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ startAt: 100, maxResults: 50, total: 150, isLast: true, values: values(100) }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listChangelog('KEY-1');

    expect(out).toEqual({
      items: values(0).concat(values(50), values(100)),
      total: 150,
      nextStartAt: null,
      incomplete: false,
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('startAt'))).toEqual(['0', '50', '100']);
  });

  it('case 5e: a page cap reports the first contiguous unread offset under Jira clamping', async () => {
    const page = Array.from({ length: 50 }, (_, index) => ({ id: String(index) }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ startAt: 0, maxResults: 50, total: 150, isLast: false, values: page }))
      .mockResolvedValueOnce(jsonResponse({ startAt: 50, maxResults: 50, total: 150, isLast: false, values: page }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listChangelog('KEY-1', { maxPages: 2 });

    expect(out).toMatchObject({ total: 150, nextStartAt: 100, incomplete: true });
    expect(out.items).toHaveLength(100);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('startAt'))).toEqual(['0', '50']);
  });

  it('case 5f: ignores a cross-origin nextPage and advances only by values actually returned', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 0,
          total: 2,
          isLast: false,
          values: [{ id: '1' }],
          nextPage: 'https://attacker.invalid/rest/api/3/issue/KEY-1/changelog?startAt=100',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ startAt: 1, total: 2, isLast: true, values: [{ id: '2' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listChangelog('KEY-1');

    expect(out.items).toEqual([{ id: '1' }, { id: '2' }]);
    expect(fetchMock.mock.calls[1][0]).toContain('startAt=1');
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).origin === BASE)).toBe(true);
  });
});

describe('JiraClient.listStatuses', () => {
  it('case 6: GETs /rest/api/3/status and returns the parsed array', async () => {
    const statuses = [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(statuses));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listStatuses();

    expect(out).toEqual(statuses);
    expect(fetchMock.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/status');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});

describe('JiraClient.listProjectStatuses', () => {
  it('case 8: GETs /rest/api/3/project/<key>/statuses with correct headers, returns the RAW array', async () => {
    const payload = [
      { id: '1', name: 'Story', statuses: [{ id: '10', name: 'Backlog', statusCategory: { key: 'new' } }] },
      { id: '2', name: 'Bug', statuses: [{ id: '11', name: 'Done', statusCategory: { key: 'done' } }] },
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const out = await makeClient().listProjectStatuses('TEAM');

    // Returned verbatim — the caller flattens each entry's `statuses` array itself.
    expect(out).toEqual(payload);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/project/TEAM/statuses');
    expect(opts.method).toBe('GET');
    expect(opts.body).toBeUndefined();
    expect(opts.headers).toMatchObject({ Authorization: EXPECTED_AUTH, Accept: 'application/json' });
  });

  it('case 8b: URL-encodes the project key/id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().listProjectStatuses('a b/c');
    expect(fetchMock.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/project/a%20b%2Fc/statuses');
  });

  it('case 8c: non-array body → [] (tolerant)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ not: 'an array' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().listProjectStatuses('TEAM')).resolves.toEqual([]);
  });

  it('case 8d: inherits the error taxonomy — 401 → JiraAuthError (path in message)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'nope' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeClient()
      .listProjectStatuses('TEAM')
      .catch((e) => e);
    expect(err).toBeInstanceOf(JiraAuthError);
    expect((err as Error).message).toBe('Jira auth/permission failure (401) for /rest/api/3/project/TEAM/statuses');
  });
});

describe('JiraClient tolerance', () => {
  it('case 7: tolerates shape surprises and strips a trailing slash on baseUrl', async () => {
    // Non-object search body → [] without throwing; trailing slash is stripped
    // so the URL has a single slash before the REST path.
    let fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse('not-an-object'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient('https://acme.atlassian.net/');
    await expect(client.searchIssues('jql', ['summary'])).resolves.toEqual({ items: [], nextPageToken: null });
    expect(fetchMock.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/search/jql');

    // Non-array `issues` → [] without throwing.
    fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ issues: 'nope' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.searchIssues('jql', ['summary'])).resolves.toEqual({ items: [], nextPageToken: null });

    // Non-array `values` in changelog → [] without throwing.
    fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ values: 'nope', isLast: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listChangelog('KEY-1')).resolves.toEqual({
      items: [],
      total: null,
      nextStartAt: null,
      incomplete: false,
    });
  });

  it.each([
    ['non-HTTPS URL', 'http://acme.atlassian.net'],
    ['relative URL', 'acme.atlassian.net'],
    ['empty host', 'https://'],
    ['credentials', 'https://user:secret@acme.atlassian.net'],
    ['query', 'https://acme.atlassian.net?tenant=secret'],
    ['fragment', 'https://acme.atlassian.net#internal'],
    ['over 512 characters', `https://acme.atlassian.net/${'x'.repeat(500)}`],
  ])('rejects %s before any fetch', async (_label, baseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => makeClient(baseUrl)).toThrow(/Jira baseUrl/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JiraClient reads for agent runs', () => {
  it('getIssue GETs one issue with explicit fields, the description included', async () => {
    const issue = { id: '10001', key: 'PROJ-1', fields: { summary: 'Export', description: { type: 'doc' } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(issue));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().getIssue('PROJ-1', ['summary', 'description'])).resolves.toEqual(issue);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/PROJ-1?fields=summary%2Cdescription',
    );
  });

  it.each([
    404, 400,
  ])('maps %s to a permanent not-found error, since Jira hides missing permission that way', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ errorMessages: ['secret'] }, { status })));
    const error = await makeClient()
      .getIssue('PROJ-404', ['summary'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraNotFoundError);
    expect((error as Error).message).not.toContain('secret');
  });

  it('carries the Retry-After delay on a rate-limit error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '7' } })),
    );
    const error = await makeClient()
      .getIssue('PROJ-1', ['summary'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraRateLimitError);
    expect((error as JiraRateLimitError).retryAfterMs).toBe(7_000);
  });

  it('searches without changelog expansion when asked, leaving the importer default unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().searchIssues('parent = PROJ-1 ORDER BY rank', ['summary'], { expandChangelog: false });
    await makeClient().searchIssues('project = PROJ', ['summary']);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).not.toHaveProperty('expand');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).expand).toBe('changelog');
  });
});

describe('JiraClient writes for agent runs', () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };

  it('adds a comment with an ADF body and returns the id from the 201 body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: '10500', body: adf }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().addComment('10001', adf)).resolves.toEqual({ id: '10500' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/10001/comment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ body: adf });
  });

  it('lists every page of an issue’s comments', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ startAt: 0, total: 3, comments: [{ id: '1' }, { id: '2' }] }))
      .mockResolvedValueOnce(jsonResponse({ startAt: 2, total: 3, comments: [{ id: '3' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const comments = await makeClient().listComments('10001');
    expect(comments.map((comment) => comment.id)).toEqual(['1', '2', '3']);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/10001/comment?startAt=2&maxResults=100&orderBy=created',
    );
  });

  it('lists transitions with their target status and screen flag', async () => {
    const transitions = [{ id: '31', name: 'Done', hasScreen: false, to: { id: '10002', name: 'Done' } }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ transitions })));
    await expect(makeClient().listTransitions('10001')).resolves.toEqual(transitions);
  });

  it('transitions an issue, reading the 204 answer without parsing a body', async () => {
    const noContent = {
      status: 204,
      ok: true,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      text: async () => '',
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(noContent);
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeClient().transitionIssue('10001', '31')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/10001/transitions');
    expect(JSON.parse(init.body as string)).toEqual({ transition: { id: '31' } });
  });

  it.each([409, 413, 422, 503])('a %s answer carries its status for the caller to classify', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ errorMessages: ['secret'] }, { status })));
    const error = await makeClient()
      .transitionIssue('10001', '31')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).status).toBe(status);
    expect((error as Error).message).not.toContain('secret');
  });
});
