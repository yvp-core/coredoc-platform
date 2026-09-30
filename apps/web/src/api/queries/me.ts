import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { MeResponse } from '../types.js';

// `signal` is deliberately NOT wired through to `request` — the client
// currently normalizes AbortError into ApiError{code:'network_error'}, which
// would surface as a spurious network error on route-change cancellation.
// KISS for this task; revisit when a task needs cancellation-aware fetches.
export const meQueryOptions = queryOptions({
  queryKey: ['me'] as const,
  queryFn: () => request<MeResponse>('/api/v1/me'),
  // Session identity doesn't go stale mid-visit: fetch once, never refetch
  // on refocus/remount. Logout explicitly clears the whole cache
  // (WorkspaceShell.handleLogout), which is the only invalidation needed.
  staleTime: Number.POSITIVE_INFINITY,
});
