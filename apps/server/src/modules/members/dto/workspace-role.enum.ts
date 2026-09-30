export enum WorkspaceMemberRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
}

/** Roles assignable via the API — excludes owner. */
export const ASSIGNABLE_ROLES = [WorkspaceMemberRole.Admin, WorkspaceMemberRole.Member] as const;
