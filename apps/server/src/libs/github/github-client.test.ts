import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GithubClient,
  GithubApiError,
  GithubAuthError,
  GithubRateLimitError,
  normalizeGithubBaseUrl,
} from './github-client.js';

/** Build a mock `Response`-like object with JSON body + header support. */
function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const status = init?.status ?? 200;
  const headers = init?.headers ?? {};
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

/** A PR item whose `updated_at` is `offsetMs` after the epoch anchor. */
function pr(id: number, updatedAt: string): Record<string, unknown> {
  return { id, updated_at: updatedAt };
}

/** An array of `count` PR items all newer than `newerThan` (ISO). */
function fullPageNewerThan(count: number, updatedAt: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => pr(i, updatedAt));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GithubClient.listPullsUpdatedSince', () => {
  it('case 1: requests the correct path + headers and returns the parsed array', async () => {
    const items = fullPageNewerThan(3, '2026-07-20T00:00:00Z');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(items));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 'tok-abc' });
    const out = await client.listPullsUpdatedSince('o', 'r', null, 1);

    expect(out).toEqual(items);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1',
    );
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer tok-abc',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'coredoc-server',
    });
  });

  it('case 2: pagination stops early once items older than `since` appear', async () => {
    const since = '2026-07-10T00:00:00Z';
    // Page 1: 100 items, all newer than `since`.
    const page1 = fullPageNewerThan(100, '2026-07-15T00:00:00Z');
    // Page 2: items 1-2 newer, item 3 older → stop after collecting 1-2.
    const page2 = [
      pr(200, '2026-07-12T00:00:00Z'),
      pr(201, '2026-07-11T00:00:00Z'),
      pr(202, '2026-07-05T00:00:00Z'), // older → boundary
      pr(203, '2026-07-04T00:00:00Z'),
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    const out = await client.listPullsUpdatedSince('o', 'r', since, 10);

    // pages 1 (100) + page 2 first two = 102, no older items included.
    expect(out).toHaveLength(102);
    expect(out.slice(100)).toEqual([page2[0], page2[1]]);
    // Only two requests — no page-3 fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('page=2');
  });

  it('case 3: since=null pages until maxPages when every page is full', async () => {
    const full = () => jsonResponse(fullPageNewerThan(100, '2026-07-20T00:00:00Z'));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(full())
      .mockResolvedValueOnce(full())
      .mockResolvedValueOnce(full())
      .mockResolvedValueOnce(full()); // would be page 4 if it did not stop
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    const out = await client.listPullsUpdatedSince('o', 'r', null, 3);

    expect(out).toHaveLength(300);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain('page=3');
  });
});

describe('GithubClient error taxonomy', () => {
  it('case 4a: 403 with x-ratelimit-remaining: 0 throws GithubRateLimitError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        { message: 'rate limited' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    await expect(client.listReviews('o', 'r', 1)).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it('case 4b: 401 throws GithubAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'bad creds' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    await expect(client.listReviews('o', 'r', 1)).rejects.toBeInstanceOf(GithubAuthError);
  });

  it('case 4c: 500 throws a plain Error (transient)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    const err = await client.listReviews('o', 'r', 1).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GithubAuthError);
    expect(err).not.toBeInstanceOf(GithubRateLimitError);
  });
});

describe('GithubClient sub-resource paths', () => {
  it('case 5: listReviews/listFiles/listCommits hit correct paths; listFiles pages to maxPages', async () => {
    // listReviews
    const reviewsMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ r: 1 }]));
    vi.stubGlobal('fetch', reviewsMock);
    const client = new GithubClient({ token: 't' });
    await client.listReviews('o', 'r', 7);
    expect(reviewsMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100');

    // listCommits
    const commitsMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ c: 1 }]));
    vi.stubGlobal('fetch', commitsMock);
    await expect(client.listCommits('o', 'r', 7)).resolves.toEqual({ items: [{ c: 1 }], incomplete: false });
    expect(commitsMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7/commits?per_page=100');

    // listFiles: three full pages → stops at default maxPages of 3.
    const files = () => jsonResponse(Array.from({ length: 100 }, (_, i) => ({ f: i })));
    const filesMock = vi
      .fn()
      .mockResolvedValueOnce(files())
      .mockResolvedValueOnce(files())
      .mockResolvedValueOnce(files())
      .mockResolvedValueOnce(files());
    vi.stubGlobal('fetch', filesMock);
    const out = await client.listFiles('o', 'r', 7);
    expect(out).toHaveLength(300);
    expect(filesMock).toHaveBeenCalledTimes(3);
    expect(filesMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=1');
    expect(filesMock.mock.calls[2][0]).toContain('page=3');
  });

  it('returns an explicit incomplete commit-list result when GitHub advertises another page', async () => {
    const commits = Array.from({ length: 100 }, (_, i) => ({ sha: `sha-${i}` }));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(commits, {
        headers: {
          link: '<https://api.github.com/repositories/1/pulls/7/commits?per_page=100&page=2>; rel="next"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    const out = await client.listCommits('o', 'r', 7);

    expect(out).toEqual({ items: commits, incomplete: true });
    // The existing bounded source stays one page; truth moves with the items rather
    // than silently presenting the retained prefix as the complete commit history.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('getPull hits the single-PR path and returns the parsed detail body', async () => {
    const detail = { number: 7, additions: 12, deletions: 3, changed_files: 2, commits: 4, review_comments: 5 };
    const getMock = vi.fn().mockResolvedValueOnce(jsonResponse(detail));
    vi.stubGlobal('fetch', getMock);
    const client = new GithubClient({ token: 't' });
    const out = await client.getPull('o', 'r', 7);
    expect(getMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(out).toEqual(detail);
  });

  it('getPull returns {} for a non-object body (tolerant)', async () => {
    const getMock = vi.fn().mockResolvedValueOnce(jsonResponse([1, 2, 3]));
    vi.stubGlobal('fetch', getMock);
    const client = new GithubClient({ token: 't' });
    await expect(client.getPull('o', 'r', 1)).resolves.toEqual({});
  });

  it('getPull degrades to {} on a transient 5xx (supplementary read never aborts the PR ingest)', async () => {
    const getMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }));
    vi.stubGlobal('fetch', getMock);
    const client = new GithubClient({ token: 't' });
    await expect(client.getPull('o', 'r', 1)).resolves.toEqual({});
  });

  it('getPull degrades to {} on a 404 (PR vanished between list and detail)', async () => {
    const getMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'not found' }, { status: 404 }));
    vi.stubGlobal('fetch', getMock);
    const client = new GithubClient({ token: 't' });
    await expect(client.getPull('o', 'r', 1)).resolves.toEqual({});
  });

  it('getPull still propagates auth + rate-limit (meaningful queue-classification signals)', async () => {
    const authMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'bad creds' }, { status: 401 }));
    vi.stubGlobal('fetch', authMock);
    const client = new GithubClient({ token: 't' });
    await expect(client.getPull('o', 'r', 1)).rejects.toBeInstanceOf(GithubAuthError);

    const rlMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      );
    vi.stubGlobal('fetch', rlMock);
    await expect(client.getPull('o', 'r', 1)).rejects.toBeInstanceOf(GithubRateLimitError);
  });
});

describe('GitHub base URL boundary', () => {
  it('normalizes a bounded HTTPS GitHub Enterprise API root', () => {
    expect(normalizeGithubBaseUrl(' https://github.acme.invalid/api/v3/// ')).toBe(
      'https://github.acme.invalid/api/v3',
    );
  });

  it.each([
    ['non-HTTPS URL', 'http://github.acme.invalid'],
    ['relative URL', 'github.acme.invalid'],
    ['empty host', 'https://'],
    ['credentials', 'https://user:secret@github.acme.invalid'],
    ['query', 'https://github.acme.invalid?tenant=secret'],
    ['fragment', 'https://github.acme.invalid#internal'],
    ['over 512 characters', `https://github.acme.invalid/${'x'.repeat(500)}`],
  ])('rejects %s before any fetch', (_label, baseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => new GithubClient({ token: 'secret', baseUrl })).toThrow(/GitHub baseUrl/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GithubClient tolerance', () => {
  it('case 6: non-array JSON body returns [] without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GithubClient({ token: 't' });
    await expect(client.listReviews('o', 'r', 1)).resolves.toEqual([]);
  });
});

describe('handoff source error classification', () => {
  it.each([403, 404, 503])('preserves HTTP %s for the caller to classify', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status })));
    const error = await new GithubClient({ token: 'test' }).getPullMetadata('o', 'r', 1).catch((e) => e);
    expect(error).toBeInstanceOf(GithubApiError);
    expect(error.status).toBe(status);
  });
  it.each([
    [429, {}],
    [403, { 'retry-after': '60' }],
    [403, { 'x-ratelimit-remaining': '0' }],
  ])('keeps throttled HTTP %s retryable', async (status, headers) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status, headers })));
    await expect(new GithubClient({ token: 'test' }).getPullMetadata('o', 'r', 1)).rejects.toBeInstanceOf(
      GithubRateLimitError,
    );
  });
});
