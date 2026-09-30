import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';
import type { AuthUser } from './decorators/current-user.decorator.js';

/**
 * Restricts an analytics read to a single caller's own data. Present only when a
 * workspace `member` (never an admin/owner or a service token) queries a scoped
 * endpoint; absent means workspace-wide visibility.
 */
export interface SelfScope {
  /**
   * coredoc auth user id — server-derived for every ingest path (JWT and
   * service-token), so it is the single reliable self-scope key across
   * agent_sessions.user_id and mcp_query_metrics.user_id.
   */
  userId: string;
}

/**
 * The self-scope for a scoped analytics read: only a plain `member` sees just
 * their own data. Admin/owner keep workspace-wide visibility, and service tokens
 * arrive with `role === undefined` (see `@WorkspaceRoleValue`) so they are never
 * self-scoped — a service token is a workspace-level credential.
 */
export function selfScopeFor(user: AuthUser, role: WorkspaceMemberRole | undefined): SelfScope | undefined {
  return role === WorkspaceMemberRole.Member ? { userId: user.id } : undefined;
}
