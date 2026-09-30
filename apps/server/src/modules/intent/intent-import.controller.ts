/**
 * `POST /api/v1/workspaces/:workspaceId/intent/import` — onboarding import
 * (spec §8.1).
 *
 * A controller of its own for the same reason `IntentReviewController` is one:
 * its gate is the strict one and belongs to a class whose every route shares
 * it. Import lands ACCEPTED items and writes authority transitions, so it is an
 * authority write in everything but name — `@WorkspaceRole('member')` plus
 * `UserSessionGuard`, and deliberately NO `@RequirePermission`. A CI token
 * resolves to the user who created it and would sail through every role check;
 * only the session guard's structural test refuses it (spec §5).
 *
 * The content walk runs with the IMPORT node budget: a legitimate full-size
 * overlay is an order of magnitude larger than any single mutation and must not
 * be refused as oversized structure.
 */
import { Body, Controller, Get, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import {
  INTENT_CONTENT_LIMITS,
  ImportIntentOverlaySchema,
  IntentExceptionFilter,
  intentContractPipe,
} from './contract/index.js';
import type { IntentActor } from './intent-idempotency.js';
import { IntentImportService } from './intent-import.service.js';
import { IntentActorRole } from '../../mcp/intent-auth.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentImportController {
  constructor(private readonly imports: IntentImportService) {}

  @Post('import')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async import(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(
      intentContractPipe(ImportIntentOverlaySchema, {
        maxStructureNodes: INTENT_CONTENT_LIMITS.maxImportStructureNodes,
      }),
    )
    input: z.infer<typeof ImportIntentOverlaySchema>,
  ) {
    const actor: IntentActor = { id: user.id, role: role ?? IntentActorRole.ServiceToken };
    return this.imports.import(workspaceId, actor, input);
  }

  /**
   * `GET …/intent/import/preflight` — the import's preconditions, read-only.
   *
   * An ordinary intent READ (member + `intent:read`), not the import's own gate.
   * It returns counts and registered repo identities that any member can already
   * page through, and the question it answers — "would an import be refused
   * here?" — must be answerable BEFORE someone in their own session spends the
   * one-way cutover finding out. The import's stricter gate still stands on the
   * import itself.
   */
  @Get('import/preflight')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async preflight(@Param('workspaceId') workspaceId: string) {
    return this.imports.preflight(workspaceId);
  }
}
