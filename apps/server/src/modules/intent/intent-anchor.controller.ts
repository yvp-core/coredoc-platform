/**
 * Anchor surface of the cloud intent service (spec §4.6, §7), under
 * `/api/v1/workspaces/:workspaceId/intent/items/:itemId/anchors…`.
 *
 * A SEPARATE controller from `intent.controller.ts` on the same base path: Nest
 * mounts both, and anchors are a distinct operation family with a distinct
 * dependency (the graph snapshot) that the tree/propose surface does not carry.
 *
 * GUARDS. The class stack is the house one — `AuthGuard` → `WorkspaceRoleGuard`
 * → `PermissionsGuard` — with the same split the tree routes use:
 *
 * - the three writes: `@WorkspaceRole('member')` + `UserSessionGuard`, and
 *   deliberately NO `@RequirePermission`. `AuthGuard` resolves a service token to
 *   the user who created it, so an owner-created CI token already satisfies every
 *   role check; only `UserSessionGuard`'s structural test refuses it. Spec §7:
 *   anchor writes require a user session, and an agent performs them in-session.
 * - preview: `@WorkspaceRole('member')` + `@RequirePermission(IntentRead)`. It
 *   writes nothing and returns graph facts a member can already read.
 *
 * VERBS. Every mutation carries an idempotency key, so every mutation has a
 * body — including the removal, which is an explicit `…/delete` POST rather than
 * a `DELETE` with a body intermediaries are free to drop.
 *
 * PATH VS BODY. Ids in the route path are ALSO in the payload, because the MCP
 * surface has no path; each route asserts the two agree rather than preferring
 * one. That holds for the preview query too.
 */
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
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import {
  AddIntentAnchorSchema,
  IntentExceptionFilter,
  RefreshIntentAnchorSchema,
  RemoveIntentAnchorSchema,
  intentContractPipe,
} from './contract/index.js';
import type { IntentActor } from './intent-idempotency.js';
import { IntentAnchorService } from './intent-anchor.service.js';
import { PreviewIntentAnchorQuerySchema } from './intent-anchor.operations.js';
import { assertPathMatchesBody } from './intent-state-errors.js';
import { IntentActorRole } from '../../mcp/intent-auth.js';

/**
 * The actor recorded on every audit row. Identity and role come from the token
 * via the guards — never from the request payload (spec §4.7). A write route
 * always has a resolved role, because `UserSessionGuard` has already refused
 * every service token by the time this runs.
 */
function actorOf(user: AuthUser, role: WorkspaceMemberRole | undefined): IntentActor {
  return { id: user.id, role: role ?? IntentActorRole.ServiceToken };
}

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentAnchorController {
  constructor(private readonly anchors: IntentAnchorService) {}

  /**
   * The write path's resolution, without the write.
   *
   * Same resolver, same refusals, same accepted-only rule — so a caller can see
   * exactly what would be captured (and whether the stored baseline has drifted)
   * before spending an idempotency key.
   */
  @Get('items/:itemId/anchors/preview')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async previewAnchor(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Query(intentContractPipe(PreviewIntentAnchorQuerySchema)) parsed: z.infer<typeof PreviewIntentAnchorQuerySchema>,
  ) {
    assertPathMatchesBody(itemId, parsed.itemId, 'itemId');
    return this.anchors.preview(workspaceId, parsed);
  }

  @Post('items/:itemId/anchors')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async addAnchor(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(AddIntentAnchorSchema)) input: z.infer<typeof AddIntentAnchorSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.anchors.add(workspaceId, actorOf(user, role), input);
  }

  @Post('items/:itemId/anchors/refresh')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async refreshAnchor(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(RefreshIntentAnchorSchema)) input: z.infer<typeof RefreshIntentAnchorSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.anchors.refresh(workspaceId, actorOf(user, role), input);
  }

  @Post('items/:itemId/anchors/delete')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async removeAnchor(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(RemoveIntentAnchorSchema)) input: z.infer<typeof RemoveIntentAnchorSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.anchors.remove(workspaceId, actorOf(user, role), input);
  }
}
