import type { Workspace } from './workspace-store';

/**
 * Returns workspaces that qualify for the invited-user onboarding wizard,
 * sorted newest-first by createdAt.
 *
 * A workspace qualifies when ALL of these are true:
 *  - it is a cloud workspace (isCloud === true)
 *  - the user's role is defined AND is not 'owner' (defensive: unknown
 *    roles are excluded to avoid false positives)
 *  - its id is not in the seen set
 */
export function filterNewInvites(workspaces: Workspace[], seen: Set<string>): Workspace[] {
  return workspaces
    .filter((w) => w.isCloud === true && !!w.role && w.role !== 'owner' && !seen.has(w.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
