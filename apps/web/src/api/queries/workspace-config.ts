import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { IntentReleaseTrigger } from '../../features/intent/release-types.js';
import type { WorkspaceConfig, WorkspaceConfigWorkspace } from '../types.js';

// Same `signal`-omission rationale as meQueryOptions (src/api/queries/me.ts):
// the client normalizes AbortError into ApiError{code:'network_error'}, so
// wiring TanStack's cancellation signal through would surface spurious
// network errors on route-change cancellation.
export const workspaceConfigQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'config'] as const,
    queryFn: () => request<WorkspaceConfig>(`/api/v1/workspaces/${wsId}/config`),
    // Workspace/repo/member list churns slowly — a short staleTime avoids a
    // refetch on every remount while still picking up admin changes (repo
    // connect, member join) within half a minute of revisiting the page.
    staleTime: 30_000,
  });

/**
 * PATCH /workspaces/:id (workspaces.controller.ts `updateWorkspace`, admin
 * role) — mirrors the plain-exported-async-function mutation convention
 * from queries/members.ts. `UpdateWorkspaceDto` (server) also carries
 * `ciCdEnabled?: boolean` — that field is toggled by `setCiCdEnabled` below
 * (Teams → CI/CD), not by the settings page's rename form; `slug` is NOT in
 * the DTO at all — the server has no rename-slug capability, so the settings
 * page never offers one. Returns the sanitized `Workspace` row (same shape
 * as `WorkspaceConfigWorkspace` minus `repos`/`members`).
 */
export function renameWorkspace(params: { wsId: string; name: string }): Promise<WorkspaceConfigWorkspace> {
  const { wsId, name } = params;
  return request<WorkspaceConfigWorkspace>(`/api/v1/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/**
 * Toggle the workspace's CI/CD flag — same PATCH endpoint and admin guard as
 * `renameWorkspace`, sending only `{ ciCdEnabled }`. The flag gates the
 * GitHub-Action setup panel on the Teams → CI/CD tab; callers invalidate
 * `['ws', wsId, 'config']` on success (NOT `['me']` — `/me` doesn't carry
 * `ciCdEnabled`).
 */
export function setCiCdEnabled(params: { wsId: string; ciCdEnabled: boolean }): Promise<WorkspaceConfigWorkspace> {
  const { wsId, ciCdEnabled } = params;
  return request<WorkspaceConfigWorkspace>(`/api/v1/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciCdEnabled }),
  });
}

/**
 * Set the workspace's intent release trigger — same PATCH endpoint and admin
 * guard as `setCiCdEnabled`, sending only `{ intentReleaseTrigger }`. The value
 * is read back from `GET /workspaces/:id` (`['intent','release-trigger', wsId]`,
 * api/queries/intent-release.ts), which is the only response carrying it —
 * `/config` does not — so callers invalidate that key, not `['ws', wsId, 'config']`.
 */
export function setIntentReleaseTrigger(params: {
  wsId: string;
  intentReleaseTrigger: IntentReleaseTrigger;
}): Promise<WorkspaceConfigWorkspace> {
  const { wsId, intentReleaseTrigger } = params;
  return request<WorkspaceConfigWorkspace>(`/api/v1/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentReleaseTrigger }),
  });
}
