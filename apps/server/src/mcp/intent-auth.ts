/**
 * Intent authorization helpers for MCP tools.
 *
 * The MCP transport has no Nest guard stack of its own for tool arguments —
 * `McpRewriteMiddleware` authenticates and `McpTrustedContextGuard` proves the
 * trusted context is present, then each tool authorizes itself. These helpers
 * are that authorization step for the intent surface, and the MCP counterpart
 * of `PermissionsGuard` + `UserSessionGuard` on REST:
 *
 * - `authorizeIntentPermission` — read/propose. A service token must carry the
 *   permission explicitly; a user session passes on membership alone (the
 *   middleware already proved it), mirroring PermissionsGuard's pass-through
 *   for non-service-token requests.
 * - `authorizeHumanReviewer` — review, tree CRUD, anchor writes. Requires a
 *   user session of any workspace member (BR-1). The session check is the
 *   fence and is structural: a service token authenticates as its CREATOR, so
 *   an owner-created token carries `userWorkspaceRole: 'owner'` and no role
 *   check could refuse it — there is no machine-only path to authority changes.
 */

import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { TokenPermission } from '../auth/token-permissions.js';
import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';
import { McpAuthKind, type AuthenticatedMcpRequest } from './mcp-auth-context.js';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';
import type { IntentActor } from '../modules/intent/intent-idempotency.js';

/** Roles that may change intent authority in their own session: every member role (BR-1). */
export const INTENT_REVIEWER_ROLES: WorkspaceMemberRole[] = [
  WorkspaceMemberRole.Owner,
  WorkspaceMemberRole.Admin,
  WorkspaceMemberRole.Product,
  WorkspaceMemberRole.Member,
];

/**
 * Actor roles that are NOT workspace member roles — what an audit row records
 * when the acting principal is not a person.
 */
export enum IntentActorRole {
  /**
   * A service-token principal. The token's own kind, never its creator's
   * membership: `AuthGuard` resolves a `cdt_` token to the USER who created it,
   * so `userWorkspaceRole` on a service-token request is the creator's role —
   * recording it would put "owner" in the audit trail for a write no owner made.
   * REST reaches the same answer structurally, because `@WorkspaceRoleValue()`
   * returns `undefined` for a service token by design.
   */
  ServiceToken = 'service_token',
  /** A user session whose workspace role could not be resolved to a known role. */
  Unknown = 'unknown',
}

/**
 * The role an audit row records for this principal (spec §4.7).
 *
 * Derived from the AUTH KIND first, because that is the only signal that
 * distinguishes a machine from the human who minted it.
 */
export function intentActorRole(auth: IntentMcpAuth): string {
  if (auth.authKind === McpAuthKind.ServiceToken) return IntentActorRole.ServiceToken;
  return auth.role ?? IntentActorRole.Unknown;
}

/**
 * The REST actor recorded on every intent audit row and transition. Identity and role come from
 * the token via the guards — never from the request payload (spec §4.7). Intent write routes run
 * behind `UserSessionGuard`, which has already refused every service token, so the role is resolved.
 */
export function intentActorOf(user: AuthUser, role: WorkspaceMemberRole | undefined): IntentActor {
  return { id: user.id, role: role ?? IntentActorRole.ServiceToken };
}

export interface IntentMcpAuth {
  workspaceId: string;
  /** The acting principal — for a service token, the user who created it. */
  actorId: string;
  role: WorkspaceMemberRole | undefined;
  authKind: McpAuthKind;
}

/** A reviewer's context: user session, role resolved and permitted to decide. */
export interface IntentReviewerAuth extends IntentMcpAuth {
  role: WorkspaceMemberRole;
  authKind: McpAuthKind.Jwt;
}

/**
 * Read the server-set trusted context, refusing anything incomplete.
 *
 * An unrecognised role string becomes `undefined` rather than passing through:
 * a role nobody can evaluate must never satisfy a reviewer check.
 */
function trustedContext(request: Request): IntentMcpAuth {
  const trusted = request as AuthenticatedMcpRequest;
  if (!trusted.workspaceId || !trusted.user?.id || !trusted.mcpAuthKind) {
    throw new ForbiddenException('Trusted MCP workspace identity is required');
  }
  return {
    workspaceId: trusted.workspaceId,
    actorId: trusted.user.id,
    role: toMemberRole(trusted.userWorkspaceRole),
    authKind: trusted.mcpAuthKind,
  };
}

function toMemberRole(role: string | undefined): WorkspaceMemberRole | undefined {
  return (Object.values(WorkspaceMemberRole) as string[]).includes(role ?? '')
    ? (role as WorkspaceMemberRole)
    : undefined;
}

/**
 * Authorize an intent read or propose call. A service token needs `permission`
 * on the token itself; a user session is already a workspace member.
 */
export function authorizeIntentPermission(request: Request, permission: TokenPermission): IntentMcpAuth {
  const auth = trustedContext(request);
  const trusted = request as AuthenticatedMcpRequest;

  if (auth.authKind === McpAuthKind.ServiceToken && !trusted.serviceTokenPermissions?.includes(permission)) {
    throw new ForbiddenException(`Service token requires ${permission}`);
  }
  return auth;
}

/**
 * Authorize an authority-changing intent call: accept/reject/supersede, tree
 * CRUD, anchor writes. No token permission can substitute for a user session.
 */
export function authorizeHumanReviewer(request: Request): IntentReviewerAuth {
  const auth = trustedContext(request);

  if (auth.authKind !== McpAuthKind.Jwt) {
    throw new ForbiddenException('Intent review requires a user session, not a service token');
  }
  if (!auth.role || !INTENT_REVIEWER_ROLES.includes(auth.role)) {
    // Membership, not rank: an unresolved or unknown role must never pass.
    throw new ForbiddenException('Intent review requires a workspace member role');
  }
  return { ...auth, role: auth.role, authKind: McpAuthKind.Jwt };
}
