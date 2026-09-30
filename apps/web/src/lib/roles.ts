/**
 * Workspace-role gating for the UI. Mirrors the server's ROLE_HIERARCHY
 * (member < admin < owner, apps/server/src/auth/workspace-role.guard.ts):
 * every admin-gated route (`@WorkspaceRole('admin')`) accepts both admin
 * and owner. Role values come from `me.workspaces[].role`
 * (WorkspaceMemberRole enum, 'owner' | 'admin' | 'member').
 *
 * UI gating only — the server re-checks the role on every request; a stale
 * or spoofed client-side role never grants anything.
 */
export function hasAdminAccess(role: string): boolean {
  return role === 'admin' || role === 'owner';
}
