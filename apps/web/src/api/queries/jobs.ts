import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { Job, JobStatus } from '../types.js';

// Same `signal`-omission rationale as meQueryOptions (src/api/queries/me.ts).
// staleTime 0: job status is point-in-time, and the overview's recent-activity
// list should reflect it on every visit.
//
// `limit` mirrors the server's own default of 50 rows (push-queue.service.ts)
// explicitly, so the cap is visible in the query key instead of being a silent
// truncation.
export const jobsQueryOptions = (wsId: string, status?: JobStatus, limit = 50) =>
  queryOptions({
    queryKey: ['ws', wsId, 'jobs', status, limit] as const,
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      params.set('limit', String(limit));
      return request<Job[]>(`/api/v1/workspaces/${wsId}/jobs?${params.toString()}`);
    },
    staleTime: 0,
  });
