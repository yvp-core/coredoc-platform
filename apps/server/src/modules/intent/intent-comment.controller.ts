import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentActorRole } from '../../mcp/intent-auth.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import {
  CreateIntentCommentSchema,
  INTENT_CONTRACT_LIMITS,
  IntentExceptionFilter,
  ListIntentCommentsQuerySchema,
  SetIntentCommentStatusSchema,
  intentContractPipe,
} from './contract/index.js';
import { IntentCommentService } from './intent-comment.service.js';
import { parseIntentPageLimit } from './intent-cursor.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { assertPathMatchesBody } from './intent-state-errors.js';

/** A comment body may run to its full length across several paragraphs; the other content checks still apply. */
const COMMENT_CONTENT = { maxMultilineChars: INTENT_CONTRACT_LIMITS.text };

@Controller('workspaces/:workspaceId/intent/comments')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentCommentController {
  constructor(private readonly comments: IntentCommentService) {}

  @Get()
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentCommentsQuerySchema)) query: z.infer<typeof ListIntentCommentsQuerySchema>,
  ) {
    return this.comments.listThreads(workspaceId, query, parseIntentPageLimit(query.limit));
  }

  @Post()
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(CreateIntentCommentSchema, COMMENT_CONTENT)) body: z.infer<
      typeof CreateIntentCommentSchema
    >,
  ) {
    return this.comments.create(workspaceId, { id: user.id, role: role ?? IntentActorRole.ServiceToken }, body);
  }

  @Post(':commentId/status')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  setStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(SetIntentCommentStatusSchema)) body: z.infer<typeof SetIntentCommentStatusSchema>,
  ) {
    assertPathMatchesBody(commentId, body.id, 'id');
    return this.comments.setStatus(workspaceId, { id: user.id, role: role ?? IntentActorRole.ServiceToken }, body);
  }
}
