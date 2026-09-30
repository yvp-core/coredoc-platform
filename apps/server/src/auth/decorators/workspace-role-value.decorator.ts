import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';
import { WorkspaceMemberRole } from '../../modules/members/dto/workspace-role.enum.js';

/**
 * The authenticated caller's role in the workspace, as set by `WorkspaceRoleGuard`
 * (`request.userWorkspaceRole = member.role`). Use alongside `@CurrentUser()` to
 * decide self-scoping on analytics reads.
 *
 * Returns `undefined` for service-token principals: a service token is a
 * workspace-level credential, and the guard resolves its `userWorkspaceRole` from
 * the *token creator's* membership — not the caller's — so that role must never
 * drive self-scoping. Callers treat `undefined` as "workspace-wide".
 *
 * Throws when neither signal is present: a JWT caller with no `userWorkspaceRole`
 * means the guard did not run on this route — fail fast rather than silently
 * granting workspace-wide data.
 */
export const WorkspaceRoleValue = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceMemberRole | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { userWorkspaceRole?: string; serviceTokenWorkspaceId?: string }>();
    if (request.serviceTokenWorkspaceId) return undefined;
    if (!request.userWorkspaceRole) {
      throw new InternalServerErrorException('WorkspaceRoleGuard must run before @WorkspaceRoleValue()');
    }
    return request.userWorkspaceRole as WorkspaceMemberRole;
  },
);
