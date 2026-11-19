import { SetMetadata } from '@nestjs/common';

export const WORKSPACE_ROLE_KEY = 'workspaceRole';

/**
 * What a route asks of the caller's workspace role. Each level is an action a
 * role must allow (auth/iam.ts): `member` = belongs to the workspace, `code` =
 * may read code (every route that exposes the graph, source, agent runs or
 * coding sessions), `admin` = manages it, `owner` = owns it.
 */
export const WorkspaceRole = (role: 'member' | 'code' | 'admin' | 'owner') => SetMetadata(WORKSPACE_ROLE_KEY, role);
