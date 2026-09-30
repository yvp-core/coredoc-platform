/**
 * The agent read route (spec §7), under
 * `/api/v1/workspaces/:workspaceId/intent/context`.
 *
 * A THIRD controller on the same base path, for the reason the anchor controller
 * is a second one: this is a distinct operation family with a distinct dependency
 * (graph derivation) and a distinct gate profile, and Nest mounts them all on the
 * same prefix. `intent.controller.ts` stays the tree/propose surface.
 *
 * GUARDS. `@WorkspaceRole('member')` + `@RequirePermission(IntentRead)` — the
 * house read stack. It is deliberately reachable by a SERVICE TOKEN carrying
 * `intent:read`: this is the path an agent in CI reads product intent through,
 * and it writes nothing. Nothing here can reach a tree or authority change, so
 * no `UserSessionGuard` is warranted.
 *
 * ONE ROUTE, TWO MODES. `mode=context` returns payloads, anchors with their
 * §6.4 status, and per-repo graph provenance; `mode=list` returns the payload-free
 * index and pages with a cursor. They are one route because they take the SAME
 * selectors — splitting them would duplicate the selector surface and let the two
 * drift, which is the failure the local overlay read already avoids by keeping
 * one selection implementation.
 */
import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentExceptionFilter, intentContractPipe } from './contract/index.js';
import { IntentContextQuerySchema, normalizeIntentContextRequest } from './intent-context.operations.js';
import { IntentContextService } from './intent-context.service.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentContextController {
  constructor(private readonly context: IntentContextService) {}

  @Get('context')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async read(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(IntentContextQuerySchema)) parsed: z.infer<typeof IntentContextQuerySchema>,
  ) {
    return this.context.read(workspaceId, normalizeIntentContextRequest(parsed));
  }
}
