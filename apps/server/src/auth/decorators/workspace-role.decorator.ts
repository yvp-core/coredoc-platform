import { SetMetadata } from '@nestjs/common';

export const WORKSPACE_ROLE_KEY = 'workspaceRole';

/**
 * What a route asks of the caller's workspace role. Each level is an action a
 * role must allow (auth/iam.ts): `member` = belongs to the workspace, `code` =
 * may read code (every route that exposes the graph, source, agent runs or
 * coding sessions), `admin` = manages it, `owner` = owns it, `consultant` =
 * may read the question threads of runs on no repository.
 */
export const WorkspaceRole = (role: 'member' | 'code' | 'admin' | 'owner' | 'consultant') =>
  SetMetadata(WORKSPACE_ROLE_KEY, role);
