/**
 * `POST /api/v1/workspaces/:workspaceId/intent/import/workspace` — a whole
 * knowledge base into an empty workspace.
 *
 * A controller of its own for the same reason `IntentReviewController` is one:
 * its gate is the strict one and belongs to a class whose every route shares
 * it. Import lands ACCEPTED items and release evidence, so it is an authority
 * write in everything but name — `@WorkspaceRole('member')` plus
 * `UserSessionGuard`, and deliberately NO `@RequirePermission`. A CI token
 * resolves to the user who created it and would sail through every role check;
 * only the session guard's structural test refuses it (spec §5).
 *
 * The content walk runs with the IMPORT node budget: a legitimate full-size
 * document is an order of magnitude larger than any single mutation and must
 * not be refused as oversized structure.
 */
import { Body, Controller, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { INTENT_CONTENT_LIMITS, IntentExceptionFilter, intentContractPipe } from './contract/index.js';
import { ImportIntentWorkspaceSchema, IntentWorkspaceImportService } from './intent-workspace-import.js';
import { intentActorOf } from '../../mcp/intent-auth.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentImportController {
  constructor(private readonly workspaceImports: IntentWorkspaceImportService) {}

  /**
   * `POST …/intent/import/workspace` — a whole knowledge base (tree, relations,
   * items, delivery status) into an empty workspace.
   */
  @Post('import/workspace')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async importWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(
      intentContractPipe(ImportIntentWorkspaceSchema, {
        maxStructureNodes: INTENT_CONTENT_LIMITS.maxImportStructureNodes,
      }),
    )
    input: z.infer<typeof ImportIntentWorkspaceSchema>,
  ) {
    const actor = intentActorOf(user, role);
    return this.workspaceImports.import(workspaceId, actor, input);
  }
}
