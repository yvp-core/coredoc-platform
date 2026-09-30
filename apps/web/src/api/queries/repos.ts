import { queryOptions } from '@tanstack/react-query';
import type { RepoStateResponse } from '../../features/repos/types.js';
import { request } from '../client.js';
import type { IntentReleaseTrigger } from '../../features/intent/release-types.js';
import type { WorkspaceRepo } from '../types.js';

// Same `signal`-omission rationale as meQueryOptions (src/api/queries/me.ts).
//
// The list endpoint returns raw control-plane rows (see WorkspaceRepo in
// ../types.ts) — identity plus push counters in ONE call.
export const reposQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'repos'] as const,
    queryFn: () => request<WorkspaceRepo[]>(`/api/v1/workspaces/${wsId}/repos`),
    staleTime: 30_000,
  });

// Per-repo served-graph state (summary version + upload time), which the
// control-plane list row does not carry. One query per repo, fanned out with
// useQueries on the repos page — 60s cache, since it only moves on a push.
export const repoStateQueryOptions = (wsId: string, repoName: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'repo-state', repoName] as const,
    queryFn: () => request<RepoStateResponse>(`/api/v1/workspaces/${wsId}/repos/${encodeURIComponent(repoName)}/state`),
    staleTime: 60_000,
  });

/**
 * DELETE /workspaces/:id/repos/:repoId (repos.controller.ts `disconnectRepo`,
 * admin role + `workspace:manage` permission). Removes the control-plane row;
 * callers invalidate `['ws', wsId, 'repos']` and `['ws', wsId, 'config']`.
 */
export function disconnectRepo(wsId: string, repoId: string): Promise<{ disconnected: true }> {
  return request<{ disconnected: true }>(`/api/v1/workspaces/${wsId}/repos/${repoId}`, { method: 'DELETE' });
}

/**
 * PATCH /workspaces/:id/repos/:repoKey (repos.controller.ts `updateRepo`, admin
 * role + `workspace:manage`). Tri-state per field on the server: `null` clears
 * the production-branch override and restores the branch the delivery connector
 * reports. Callers invalidate `['ws', wsId, 'repos']`.
 */
export function setProductionBranch(params: {
  wsId: string;
  repoKey: string;
  productionBranch: string | null;
}): Promise<WorkspaceRepo> {
  const { wsId, repoKey, productionBranch } = params;
  return request<WorkspaceRepo>(`/api/v1/workspaces/${wsId}/repos/${encodeURIComponent(repoKey)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productionBranch }),
  });
}

/**
 * Same PATCH endpoint and guards as `setProductionBranch`, sending only the
 * per-repo release-trigger override; `null` clears it and restores the
 * workspace default. Callers invalidate `['ws', wsId, 'repos']`.
 */
export function setRepoReleaseTrigger(params: {
  wsId: string;
  repoKey: string;
  intentReleaseTrigger: IntentReleaseTrigger | null;
}): Promise<WorkspaceRepo> {
  const { wsId, repoKey, intentReleaseTrigger } = params;
  return request<WorkspaceRepo>(`/api/v1/workspaces/${wsId}/repos/${encodeURIComponent(repoKey)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentReleaseTrigger }),
  });
}
