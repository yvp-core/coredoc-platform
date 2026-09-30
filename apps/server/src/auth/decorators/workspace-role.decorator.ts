import { SetMetadata } from '@nestjs/common';

export const WORKSPACE_ROLE_KEY = 'workspaceRole';

/**
 * Decorator to require a minimum workspace role for a route.
 * Roles hierarchy: owner > admin > member
 */
export const WorkspaceRole = (role: 'member' | 'admin' | 'owner') => SetMetadata(WORKSPACE_ROLE_KEY, role);
