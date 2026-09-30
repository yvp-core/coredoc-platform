import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * Asserts the promise neither resolves nor rejects within a short window —
 * the contract for the login-redirect paths: the page is navigating away,
 * so the request chain must suspend forever instead of rejecting (a
 * rejection would flash the router's error boundary for a frame before the
 * browser unloads the page).
 */
async function expectNeverSettles(promise: Promise<unknown>): Promise<void> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([
    promise.then(
      () => 'settled: resolved',
      () => 'settled: rejected',
    ),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), 25)),
  ]);
  expect(outcome).toBe(pending);
}

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    assignMock = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      pathname: '/w/acme/repos',
      search: '?tab=jobs',
      assign: assignMock,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves typed JSON on success and sends the CSRF header + same-origin credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await request<{ ok: boolean }>('/api/v1/ping');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/ping');
    expect(init.credentials).toBe('same-origin');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Coredoc-Csrf')).toBe('1');
  });

  it('sends CSRF header on every request regardless of method', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));

    await request('/api/v1/auth/web/logout', { method: 'POST' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Coredoc-Csrf')).toBe('1');
  });

  it('throws a typed ApiError on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'NOT_FOUND', message: 'nope' }, { status: 404 }));

    await expect(request('/api/v1/things/1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'nope',
    });
  });

  it('ApiError instances are recognizable via instanceof', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }));

    try {
      await request('/api/v1/things/1');
      expect.unreachable('request should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
    }
  });

  it('on 401, refreshes once then retries the original request, resolving on retry success', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(emptyResponse(204)) // refresh call
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // retried original

    const result = await request<{ ok: boolean }>('/api/v1/protected');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/web/refresh');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/protected');
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('redirects to login when refresh itself fails, never calls fetch again, and never settles the request promise', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(emptyResponse(401)); // refresh fails

    await expectNeverSettles(request('/api/v1/protected'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assignMock).toHaveBeenCalledTimes(1);
    const [target] = assignMock.mock.calls[0] as [string];
    expect(target).toBe('/api/v1/auth/web/login?returnTo=%2Fw%2Facme%2Frepos%3Ftab%3Djobs');
  });

  it('redirects to login when the retried request 401s again after a successful refresh, and never settles', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(emptyResponse(204)) // refresh succeeds
      .mockResolvedValueOnce(emptyResponse(401)); // retry still 401s

    await expectNeverSettles(request('/api/v1/protected'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when the refresh endpoint itself returns 403 (auth failure, same as 401), and never settles', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(emptyResponse(403)); // refresh rejects with 403

    await expectNeverSettles(request('/api/v1/protected'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT redirect when the refresh endpoint itself 500s: waiters reject with ApiError(500), a transient server hiccup is not an auth failure', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(jsonResponse({ message: 'refresh exploded' }, { status: 500 })); // refresh 500s

    await expect(request('/api/v1/protected')).rejects.toMatchObject({ status: 500, message: 'refresh exploded' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('a 500 from a shared in-flight refresh rejects every concurrent waiter with ApiError(500) and never redirects', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // request A
      .mockResolvedValueOnce(emptyResponse(401)) // request B
      .mockResolvedValueOnce(jsonResponse({ message: 'refresh exploded' }, { status: 500 })); // the one shared refresh 500s

    const [a, b] = await Promise.allSettled([request('/api/v1/a'), request('/api/v1/b')]);

    for (const settled of [a, b]) {
      expect(settled.status).toBe('rejected');
      const error = (settled as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 500 });
    }
    expect(assignMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never redirect-loops: requests to /api/v1/auth/web/* skip the 401-refresh flow entirely', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(401));

    await expect(request('/api/v1/auth/web/refresh', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);

    // No refresh attempt, no retry, no redirect — just the one call and a thrown error.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('throws a plain ApiError(500) with no redirect when the retry after a successful refresh fails non-401', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // original request
      .mockResolvedValueOnce(emptyResponse(204)) // refresh succeeds
      .mockResolvedValueOnce(jsonResponse({ message: 'exploded' }, { status: 500 })); // retry fails, not auth

    await expect(request('/api/v1/protected')).rejects.toMatchObject({ status: 500, message: 'exploded' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('normalizes fetch rejections into ApiError { status: 0, code: network_error }', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    try {
      await request('/api/v1/ping');
      expect.unreachable('request should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 0, code: 'network_error', message: 'Failed to fetch' });
    }
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('refresh network failure rejects all waiters with a network ApiError and never redirects', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // request A
      .mockResolvedValueOnce(emptyResponse(401)) // request B
      .mockRejectedValueOnce(new TypeError('Failed to fetch')); // the one shared refresh dies on transport

    const [a, b] = await Promise.allSettled([request('/api/v1/a'), request('/api/v1/b')]);

    for (const settled of [a, b]) {
      expect(settled.status).toBe('rejected');
      const error = (settled as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 0, code: 'network_error' });
    }
    // Connectivity loss is not an auth failure — nobody gets sent to login.
    expect(assignMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a network-failed refresh does not poison the single-flight state: the next 401 gets a fresh refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // request 1
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // refresh #1: network failure
      .mockResolvedValueOnce(emptyResponse(401)) // request 2, later
      .mockResolvedValueOnce(emptyResponse(204)) // refresh #2: fresh attempt, succeeds
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // retried request 2

    await expect(request('/api/v1/first')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    await expect(request<{ ok: boolean }>('/api/v1/second')).resolves.toEqual({ ok: true });

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/web/refresh');
    expect(refreshCalls).toHaveLength(2);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('single-flights the refresh: two concurrent 401s share one refresh call', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(401)) // request A
      .mockResolvedValueOnce(emptyResponse(401)) // request B
      .mockResolvedValueOnce(emptyResponse(204)) // the one shared refresh
      .mockResolvedValueOnce(jsonResponse({ id: 'a' })) // retried A
      .mockResolvedValueOnce(jsonResponse({ id: 'b' })); // retried B

    const [a, b] = await Promise.all([request<{ id: string }>('/api/v1/a'), request<{ id: string }>('/api/v1/b')]);

    expect(a).toEqual({ id: 'a' });
    expect(b).toEqual({ id: 'b' });

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/web/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
