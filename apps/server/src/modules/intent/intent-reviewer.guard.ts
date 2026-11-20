import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { INTENT_REVIEWER_ROLES } from '../../mcp/intent-auth.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';

/**
 * The REST twin of `authorizeHumanReviewer` (mcp/intent-auth.ts): a human write
 * to intent — review, tree edits, anchors, comments, release plans — needs a
 * reviewer role, so a role that only reads intent cannot change it over either
 * transport. Sits after `WorkspaceRoleGuard`, which resolves the role.
 */
@Injectable()
export class IntentReviewerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { userWorkspaceRole } = context.switchToHttp().getRequest<{ userWorkspaceRole?: string }>();
    if (!INTENT_REVIEWER_ROLES.includes(userWorkspaceRole as WorkspaceMemberRole)) {
      throw new ForbiddenException('Your role can read intent but not change it');
    }
    return true;
  }
}
