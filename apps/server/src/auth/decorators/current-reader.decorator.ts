import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';
import type { RepoReader } from '../../database/control-plane.service.js';
import type { AuthUser } from './current-user.decorator.js';

/**
 * Who this request reads repos as, for `readableRepos`.
 * A service token reads as its creator, so a token never sees more than the
 * person who minted it. Throws when `WorkspaceRoleGuard` did not run — fail fast
 * rather than fall back to an unrestricted read.
 */
export const CurrentReader = createParamDecorator((_data: unknown, ctx: ExecutionContext): RepoReader => {
  const { user, userWorkspaceRole } = ctx
    .switchToHttp()
    .getRequest<Request & { user?: AuthUser; userWorkspaceRole?: string }>();
  if (!user || !userWorkspaceRole) {
    throw new InternalServerErrorException('WorkspaceRoleGuard must run before @CurrentReader()');
  }
  return { userId: user.id, role: userWorkspaceRole };
});
