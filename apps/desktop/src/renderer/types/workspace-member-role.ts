/**
 * Workspace membership roles as they travel on the wire (`role` on members and
 * invites). The server owns its own enum; this is the desktop-local mirror so
 * renderer code never compares bare string literals.
 */
export enum WorkspaceMemberRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
}

const KNOWN_ROLES: readonly string[] = Object.values(WorkspaceMemberRole);

/** Narrow a wire-format role string; unknown values yield `undefined`. */
export function toWorkspaceMemberRole(role: string | undefined | null): WorkspaceMemberRole | undefined {
  const normalized = role?.trim().toLowerCase();
  return normalized && KNOWN_ROLES.includes(normalized) ? (normalized as WorkspaceMemberRole) : undefined;
}

export function isWorkspaceAdminRole(role: WorkspaceMemberRole | undefined): boolean {
  return role === WorkspaceMemberRole.Owner || role === WorkspaceMemberRole.Admin;
}
