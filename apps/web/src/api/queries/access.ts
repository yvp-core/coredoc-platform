import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';

/** Mirrors `AccessService.list` (apps/server/src/modules/access). */
export interface AccessGroup {
  id: string;
  name: string;
  memberUserIds: string[];
}

/** Exactly one of `userId` and `groupId` is set. */
export interface RepoBinding {
  userId?: string;
  groupId?: string;
  role: string;
}

export interface RepoAccess {
  repoKey: string;
  repoName: string;
  /** True = workspace roles do not reach the repo; only its own bindings (and admins) do. */
  restricted: boolean;
  bindings: RepoBinding[];
}

export interface Access {
  groups: AccessGroup[];
  repos: RepoAccess[];
}

// staleTime: 0 — same rationale as membersQueryOptions: who may read what is
// point-in-time, and every mutation below invalidates this key.
export const accessQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'access'] as const,
    queryFn: () => request<Access>(`/api/v1/workspaces/${wsId}/access`),
    staleTime: 0,
  });

/** POST creates (`groupId` null), PUT replaces the group whole. */
export function saveGroup(params: {
  wsId: string;
  groupId: string | null;
  input: Omit<AccessGroup, 'id'>;
}): Promise<AccessGroup> {
  const { wsId, groupId, input } = params;
  return request<AccessGroup>(`/api/v1/workspaces/${wsId}/access/groups${groupId ? `/${groupId}` : ''}`, {
    method: groupId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteGroup(params: { wsId: string; groupId: string }): Promise<void> {
  return request<void>(`/api/v1/workspaces/${params.wsId}/access/groups/${params.groupId}`, { method: 'DELETE' });
}

/** Replaces whether the repo is restricted and who is bound to it. */
export function saveRepoAccess(params: {
  wsId: string;
  repoKey: string;
  input: Pick<RepoAccess, 'restricted' | 'bindings'>;
}): Promise<unknown> {
  const { wsId, repoKey, input } = params;
  return request(`/api/v1/workspaces/${wsId}/access/repos/${encodeURIComponent(repoKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
