/**
 * Access model: a principal (member or group) holds a ROLE on a RESOURCE (the
 * workspace or one repo); a role is a set of ACTIONS. Bindings are stored in
 * `access_bindings`; this file is the only place that says what a role may do.
 *
 * Allow-only: there are no deny rules. A repo is closed by marking it
 * `restricted`, which stops workspace bindings from reaching it.
 */
export type Action = 'workspace.read' | 'workspace.manage' | 'workspace.own' | 'graph.read';

/** Roles that may be bound on a single repo. Managing roles exist on the workspace only. */
export const REPO_ROLES = ['member'] as const;

// `graph.read` covers everything derived from code: the graph, source files, Cypher.
const READ: readonly Action[] = ['workspace.read', 'graph.read'];

export const ROLE_ACTIONS: Record<string, readonly Action[]> = {
  owner: [...READ, 'workspace.manage', 'workspace.own'],
  admin: [...READ, 'workspace.manage'],
  member: READ,
  // Same actions as member: the role differs only in what the intent UI offers it.
  product: READ,
  // Reads product knowledge (intent) but no code: neither the graph nor source.
  // A binding with another role on a repo still opens that repo to the person.
  support: ['workspace.read'],
};

/** An unknown role allows nothing, so a role added to the data but not here fails closed. */
export function roleAllows(role: string | undefined, action: Action): boolean {
  return role !== undefined && (ROLE_ACTIONS[role]?.includes(action) ?? false);
}

export interface Grant {
  role: string;
  resourceType: string;
  resourceId: string;
}

export type Resource = { type: 'workspace' } | { type: 'repo'; key: string; restricted: boolean };

/**
 * `grants` are the bindings of one user and of that user's groups. A binding on
 * the workspace reaches a repo unless the repo is restricted; workspace
 * managers are the exception, since they administer the bindings anyway. A
 * binding on a repo never reaches the workspace or another repo.
 */
export function can(grants: readonly Grant[], action: Action, resource: Resource): boolean {
  return grants.some((grant) => {
    if (!roleAllows(grant.role, action)) return false;
    if (grant.resourceType === 'workspace') {
      return resource.type === 'workspace' || !resource.restricted || roleAllows(grant.role, 'workspace.manage');
    }
    return resource.type === 'repo' && grant.resourceType === 'repo' && grant.resourceId === resource.key;
  });
}
