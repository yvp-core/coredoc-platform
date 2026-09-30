import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type {
  InviteMemberResult,
  Member,
  PendingInvite,
  RemoveMemberResult,
  ResendInviteResult,
  RevokeInviteResult,
} from '../types.js';

// Same `signal`-omission rationale as meQueryOptions (src/api/queries/me.ts).
//
// staleTime: 0 — same rationale as jobsQueryOptions (src/api/queries/jobs.ts):
// membership/role state is point-in-time and every mutation below
// invalidates the exact key it affects, so there is no "fresh enough" window
// worth caching against.
export const membersQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'members'] as const,
    queryFn: () => request<Member[]>(`/api/v1/workspaces/${wsId}/members`),
    staleTime: 0,
  });

export const invitesQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'invites'] as const,
    queryFn: () => request<PendingInvite[]>(`/api/v1/workspaces/${wsId}/members/invites`),
    staleTime: 0,
  });

/**
 * MUTATION-PATTERN CONVENTION (the other query modules copy this):
 *
 * Mutations are plain exported async functions, not `mutationOptions`
 * objects or a `useXMutation` hook wrapper. Each one is a thin, typed
 * wrapper around `request()` that returns the parsed body. Callsites do:
 *
 *   const mutation = useMutation({ mutationFn: inviteMember });
 *   mutation.mutate({ wsId, email, role }, {
 *     onSuccess: () => { queryClient.invalidateQueries({ queryKey: [...] }); ... },
 *     onError: (error) => { ... },
 *   });
 *
 * Why plain functions over `mutationOptions`: `mutationOptions` (TanStack
 * Query v5) is built for sharing a mutation's config (mutationFn +
 * onSuccess/onError) across multiple callsites. Every mutation here has
 * exactly one callsite (its row/form on this page) and each needs
 * DIFFERENT invalidation logic depending on component-local state (e.g. "was
 * this the current user's own row?") that only the component has — baking
 * onSuccess into a shared options object would just move it back out via
 * overrides. A plain function keeps the copyable unit small: one function
 * per server mutation, invalidation stays colocated with the component that
 * knows which keys it affects.
 *
 * Cache-key discipline: invalidate exactly the keys a mutation can affect,
 * never a broad prefix-less invalidation. `['ws', wsId, 'members']` and
 * `['ws', wsId, 'invites']` are disjoint — invite/revoke touch 'invites',
 * remove/role-change touch 'members'; every member mutation ALSO invalidates
 * `['ws', wsId, 'config']`, because the Overview page renders
 * `config.members.length` from that key. Role change additionally
 * invalidates `['me']` exactly when the changed
 * userId is the caller's own id, because `me.workspaces[].role` drives nav
 * gating elsewhere in the shell.
 */

export function inviteMember(params: { wsId: string; email: string; role?: string }): Promise<InviteMemberResult> {
  const { wsId, email, role } = params;
  return request<InviteMemberResult>(`/api/v1/workspaces/${wsId}/members/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(role ? { email, role } : { email }),
  });
}

export function resendInvite(params: { wsId: string; invitationId: string }): Promise<ResendInviteResult> {
  const { wsId, invitationId } = params;
  return request<ResendInviteResult>(`/api/v1/workspaces/${wsId}/members/invites/${invitationId}/resend`, {
    method: 'POST',
  });
}

export function revokeInvite(params: { wsId: string; invitationId: string }): Promise<RevokeInviteResult> {
  const { wsId, invitationId } = params;
  return request<RevokeInviteResult>(`/api/v1/workspaces/${wsId}/members/invites/${invitationId}`, {
    method: 'DELETE',
  });
}

export function removeMember(params: { wsId: string; userId: string }): Promise<RemoveMemberResult> {
  const { wsId, userId } = params;
  return request<RemoveMemberResult>(`/api/v1/workspaces/${wsId}/members/${userId}`, {
    method: 'DELETE',
  });
}

export function updateMemberRole(params: { wsId: string; userId: string; role: string }): Promise<Member> {
  const { wsId, userId, role } = params;
  return request<Member>(`/api/v1/workspaces/${wsId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}
