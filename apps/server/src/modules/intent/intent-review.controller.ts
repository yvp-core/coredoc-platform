/**
 * The review and decision-history surface (spec §7), alongside
 * `IntentController` under `/api/v1/workspaces/:workspaceId/intent/…`.
 *
 * It is a separate controller because its write route has a different gate from
 * everything in `IntentController`, and a gate that strict is worth stating in
 * one place rather than repeating per route:
 *
 * - `POST items/review` — `@WorkspaceRole('member')` (BR-1: any member) plus
 *   `UserSessionGuard`, and deliberately NO `@RequirePermission`. Spec §5: there
 *   is no machine-only path to an authority change. `AuthGuard` resolves a
 *   service token to the user who CREATED it, so an owner-created CI token
 *   already passes every role check; only `UserSessionGuard`'s structural test
 *   refuses it. Adding a token permission here would be the hole that guard
 *   exists to close.
 * - the two transition reads — `@WorkspaceRole('member')` +
 *   `@RequirePermission(IntentRead)`, like every other read: history is part of
 *   what a member (or a read-scoped agent) is entitled to see.
 *
 * Actor identity for every transition comes from `@CurrentUser` and
 * `@WorkspaceRoleValue`, never from the body (spec §4.7).
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
import { IntentActorRole } from '../../mcp/intent-auth.js';
import { IntentExceptionFilter, ReviewIntentItemsSchema, intentContractPipe } from './contract/index.js';
import { parseIntentPageLimit } from './intent-cursor.js';
import type { IntentActor } from './intent-idempotency.js';
import { IntentReviewService } from './intent-review.service.js';
import { IntentTransitionsService, ListIntentTransitionsQuerySchema } from './intent-transitions.service.js';

/** The actor recorded on every transition. `UserSessionGuard` has already refused every service token. */
function actorOf(user: AuthUser, role: WorkspaceMemberRole | undefined): IntentActor {
  return { id: user.id, role: role ?? IntentActorRole.ServiceToken };
}

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentReviewController {
  constructor(
    private readonly review: IntentReviewService,
    private readonly transitions: IntentTransitionsService,
  ) {}

  @Post('items/review')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async reviewItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(ReviewIntentItemsSchema)) body: z.infer<typeof ReviewIntentItemsSchema>,
  ) {
    return this.review.review(workspaceId, actorOf(user, role), body);
  }

  @Get('items/:itemId/transitions')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listItemTransitions(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Query(intentContractPipe(ListIntentTransitionsQuerySchema)) parsed: z.infer<
      typeof ListIntentTransitionsQuerySchema
    >,
  ) {
    return this.transitions.listItemTransitions(workspaceId, itemId, parsed, parseIntentPageLimit(parsed.limit));
  }

  @Get('transitions')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listTransitions(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentTransitionsQuerySchema)) parsed: z.infer<
      typeof ListIntentTransitionsQuerySchema
    >,
  ) {
    return this.transitions.listWorkspaceTransitions(workspaceId, parsed, parseIntentPageLimit(parsed.limit));
  }
}
