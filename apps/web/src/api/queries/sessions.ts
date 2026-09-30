import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { SessionSummary } from '../types.js';

// SDLC session metrics roll up on the server per time window. staleTime 60s:
// telemetry ingests continuously but the medians only meaningfully shift over
// minutes, so a 1-minute cache spares repeat renders without showing stale data.
export const sessionSummaryQueryOptions = (wsId: string, days = 30) =>
  queryOptions({
    queryKey: ['ws', wsId, 'sessions-summary', days] as const,
    queryFn: () => request<SessionSummary>(`/api/v1/workspaces/${wsId}/sessions/summary?days=${days}`),
    staleTime: 60_000,
  });
