/**
 * The review-queue read route (spec §7), under
 * `/api/v1/workspaces/:workspaceId/intent/review-queue`.
 *
 * WHY IT IS NOT ON `IntentReviewController`. That controller exists to hold ONE
 * gate — `UserSessionGuard` plus `@WorkspaceRole('member')`, spec §5's "no
 * machine-only path to an authority change" — and its two transition reads are
 * already the exception it documents. The queue is an ORDINARY intent read:
 * member role plus `intent:read`, reachable by a service token, writing nothing.
 * Mixing a plain read into a class whose reason for existing is a strict write
 * gate is exactly how a route ends up on the wrong one, so it gets its own
 * class on the same route prefix — the same split the module header describes.
 *
 * It is a READ of authority state, never a decision: nothing here can accept,
 * reject, or supersede anything. Deciding stays `POST items/review`.
 */
import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentExceptionFilter, intentContractPipe, ListIntentReviewQueueQuerySchema } from './contract/index.js';
import { parseIntentPageLimit } from './intent-cursor.js';
import { IntentReviewQueueService } from './intent-review-queue.service.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentReviewQueueController {
  constructor(private readonly queue: IntentReviewQueueService) {}

  @Get('review-queue')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async read(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentReviewQueueQuerySchema)) parsed: z.infer<
      typeof ListIntentReviewQueueQuerySchema
    >,
  ) {
    return this.queue.readQueue(workspaceId, parsed, parseIntentPageLimit(parsed.limit));
  }

  @Get('review-queue/nodes')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async nodes(@Param('workspaceId') workspaceId: string) {
    return this.queue.nodeCounts(workspaceId);
  }
}
