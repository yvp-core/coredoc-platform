/**
 * Same-origin fetch wrapper (docs/attic/web-ui-plan-2026-07.md §3.3). Framework
 * agnostic — TanStack Query hooks call `request<T>()` directly.
 *
 * - Same-origin relative URLs, `credentials: 'same-origin'` (cookie session
 *   auth, no CORS — apps/server/src/main.ts disables CORS entirely).
 * - Always sends the CSRF header the server's composite AuthGuard requires
 *   on cookie-authenticated mutations. Value must match
 *   apps/server/src/auth/web/web-auth.constants.ts (CSRF_HEADER /
 *   CSRF_HEADER_VALUE) — sending it unconditionally is harmless for
 *   GET/HEAD/Bearer-authenticated requests, which don't require it.
 * - On 401: one single-flight refresh attempt (concurrent 401s share the
 *   same in-flight refresh promise), then retries the original request
 *   once. If the refresh fails or the retry still 401s, hard-redirects to
 *   the server login with a returnTo back to the current location and the
 *   request promise never settles (the page is unloading; rejecting would
 *   flash error UI during the redirect).
 * - Requests to the web auth routes themselves are excluded from the
 *   401-refresh flow so a broken session can never redirect-loop.
 * - Transport failures (offline, DNS) are normalized into the same ApiError
 *   contract as HTTP failures: `{ status: 0, code: 'network_error' }`. They
 *   never trigger the login redirect — redirect is for auth failure, not
 *   connectivity.
 */

const CSRF_HEADER = 'X-Coredoc-Csrf';
const CSRF_HEADER_VALUE = '1';

const REFRESH_PATH = '/api/v1/auth/web/refresh';
const LOGIN_PATH = '/api/v1/auth/web/login';
const AUTH_ROUTE_PREFIX = '/api/v1/auth/web/';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Shared across concurrent callers so two requests that both 401 at the same
// time trigger exactly one POST /refresh — the second waits on the first's
// promise instead of firing its own.
let inFlightRefresh: Promise<boolean> | null = null;

/**
 * Resolves true when the session was refreshed, false when the server
 * REJECTED the refresh with 401/403 (an auth failure — the caller redirects
 * to login). Rejects with an ApiError for any other non-ok status (5xx, etc):
 * a transient server hiccup on the refresh endpoint is not an auth failure,
 * so it must not bounce the user through OAuth — the caller lets that error
 * propagate instead. Also rejects with a network ApiError when the refresh
 * request never reached the server, for the same reason. The finally()
 * clears the single-flight slot either way, so a later 401 starts a fresh
 * attempt.
 */
function refresh(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = rawFetch(REFRESH_PATH, { method: 'POST' })
      .then(async (res) => {
        if (res.ok) return true;
        if (res.status === 401 || res.status === 403) return false;
        throw await toApiError(res);
      })
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
  try {
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch (error) {
    // Transport failure (offline, DNS, connection reset) — fetch rejects
    // with a bare TypeError. Normalize into the ApiError contract so
    // callers only ever face one error shape.
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new ApiError(0, message, 'network_error');
  }
}

function redirectToLogin(): void {
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`${LOGIN_PATH}?returnTo=${returnTo}`);
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText || `Request failed with status ${res.status}`;
  let code: string | undefined;
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      if (typeof (body as { message?: unknown }).message === 'string') {
        message = (body as { message: string }).message;
      }
      if (typeof (body as { code?: unknown }).code === 'string') {
        code = (body as { code: string }).code;
      }
    }
  } catch {
    // No/invalid JSON body — fall back to statusText.
  }
  return new ApiError(res.status, message, code);
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
  const isAuthRoute = path.startsWith(AUTH_ROUTE_PREFIX);
  const res = await rawFetch(path, init);

  if (res.ok) {
    return parseBody<T>(res);
  }

  if (res.status === 401 && !isAuthRoute) {
    const refreshed = await refresh();
    if (refreshed) {
      const retryRes = await rawFetch(path, init);
      if (retryRes.ok) {
        return parseBody<T>(retryRes);
      }
      if (retryRes.status === 401) {
        redirectToLogin();
        // The page is navigating away to the server login; suspend the chain
        // (standard SPA pattern) — location.assign doesn't halt JS, so a
        // throw here would flash the router's error boundary for a frame.
        return new Promise<never>(() => {
          /* intentionally never settles: page is unloading */
        });
      }
      throw await toApiError(retryRes);
    }
    redirectToLogin();
    // Same as above: navigating away — never settle instead of throwing.
    return new Promise<never>(() => {
      /* intentionally never settles: page is unloading */
    });
  }

  throw await toApiError(res);
}
