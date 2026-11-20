export enum WorkspaceMemberRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
  /** Ranks with `member`; the web additionally offers it the intent controls. */
  Product = 'product',
  /** Reads intent, never code: no graph and no source (auth/iam.ts). */
  Support = 'support',
}

/** Roles assignable via the API — excludes owner. */
export const ASSIGNABLE_ROLES = [
  WorkspaceMemberRole.Admin,
  WorkspaceMemberRole.Product,
  WorkspaceMemberRole.Member,
  WorkspaceMemberRole.Support,
] as const;

/**
 * Roles that see and manage the whole workspace. Every other member role is
 * scoped to its own data where a read is self-scoped, so a role added later
 * fails closed rather than inheriting workspace-wide visibility.
 */
export function isWorkspaceManagerRole(role: string | undefined): boolean {
  return role === WorkspaceMemberRole.Owner || role === WorkspaceMemberRole.Admin;
}
