import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import { IntentDeploymentSchema } from './intent-handoff.operations.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { Body, Controller, Get, Param, Post, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import type { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentExceptionFilter, intentContractPipe, parseContract } from './contract/index.js';
import {
  BatchPreviewIntentReleaseSchema,
  ChangeIntentPlanSchema,
  ListIntentReleasesSchema,
  PlanIntentReleaseSchema,
  HumanRecordIntentReleaseSchema,
  RollbackIntentReleaseSchema,
} from './intent-release.operations.js';
import { ReleaseActorKind } from './intent-release.fold.js';
import { IntentReleaseService } from './intent-release.service.js';
import { assertPathMatchesBody } from './intent-state-errors.js';
import { IntentActorRole } from '../../mcp/intent-auth.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
@UseFilters(IntentExceptionFilter)
export class IntentReleaseController {
  constructor(
    private readonly releases: IntentReleaseService,
    private readonly handoffs: IntentHandoffProcessor,
  ) {}

  @Get('items/:itemId/release-preview')
  @UseGuards(IntentEnabledGuard)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  preview(@Param('workspaceId') workspaceId: string, @Param('itemId') itemId: string) {
    return this.releases.preview(workspaceId, itemId);
  }

  @Post('items/release-preview')
  @UseGuards(IntentEnabledGuard)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  batchPreview(
    @Param('workspaceId') workspaceId: string,
    @Body(intentContractPipe(BatchPreviewIntentReleaseSchema)) body: z.infer<typeof BatchPreviewIntentReleaseSchema>,
  ) {
    return this.releases.previewMany(workspaceId, body.itemIds);
  }

  @Get('releases')
  @UseGuards(IntentEnabledGuard)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentReleasesSchema)) query: z.infer<typeof ListIntentReleasesSchema>,
  ) {
    return this.releases.list(workspaceId, query);
  }

  /**
   * The one intent write with a machine path (amendment §4). It cannot carry
   * `UserSessionGuard` like its siblings, because whether a service token is
   * admissible depends on the workspace's release trigger — a fact no guard
   * decorator can read. `@RequirePermission` still holds back every token that
   * was not deliberately minted with `intent:release` (user sessions pass
   * through PermissionsGuard untouched), and the trigger check below refuses
   * the rest by name.
   *
   * `IntentEnabledGuard` answers the same `409 intent_disabled` the deploy
   * branch raises inside `recordDeployment`, so both branches refuse "off" by name.
   */
  @Post('releases')
  @UseGuards(IntentEnabledGuard)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRelease)
  async record(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole,
    // The one intent body that stays `unknown` at the boundary: the schema is chosen by
    // inspecting the body ('repoKey' in body), so it cannot be named in a pipe. `parseContract`
    // still runs, below, on whichever branch matched.
    @Body() body: unknown,
    // Last on purpose: this method is called positionally by its tests.
    @Req() request: Request,
  ) {
    // AuthGuard sets this for cdt_ tokens only, and it is unforgeable from
    // outside — the same fact UserSessionGuard turns on.
    const token = request as Request & { serviceTokenWorkspaceId?: string; serviceTokenId?: string };
    const serviceToken = Boolean(token.serviceTokenWorkspaceId);
    // A token authenticates as its creator; the audit row names the machine instead.
    const actor = serviceToken
      ? { id: `service-token:${token.serviceTokenId}`, role: IntentActorRole.ServiceToken }
      : { id: user.id, role };
    if (body && typeof body === 'object' && 'repoKey' in body) {
      return this.handoffs.recordDeployment(
        workspaceId,
        parseContract(IntentDeploymentSchema, body),
        actor,
        serviceToken ? ReleaseActorKind.Ci : ReleaseActorKind.Maintainer,
      );
    }
    const input = parseContract(HumanRecordIntentReleaseSchema, body);
    if (serviceToken) {
      await this.releases.assertServiceTokenMayRecord(workspaceId, input);
    }
    return this.releases.record(
      workspaceId,
      actor,
      input,
      serviceToken ? ReleaseActorKind.Ci : ReleaseActorKind.Maintainer,
    );
  }

  @Post('releases/:seq/rollback')
  @UseGuards(UserSessionGuard, IntentEnabledGuard)
  @WorkspaceRole('member')
  rollback(
    @Param('workspaceId') workspaceId: string,
    @Param('seq') seq: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole,
    @Body(intentContractPipe(RollbackIntentReleaseSchema)) input: z.infer<typeof RollbackIntentReleaseSchema>,
  ) {
    assertPathMatchesBody(seq, String(input.releaseSeq), 'releaseSeq');
    return this.releases.record(workspaceId, { id: user.id, role }, { ...input, kind: 'rollback' });
  }

  @Post('items/:itemId/plan')
  @UseGuards(UserSessionGuard, IntentEnabledGuard)
  @WorkspaceRole('member')
  plan(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole,
    @Body(intentContractPipe(PlanIntentReleaseSchema)) input: z.infer<typeof PlanIntentReleaseSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.releases.record(workspaceId, { id: user.id, role }, { ...input, kind: 'plan' });
  }

  @Post('items/:itemId/plan/withdraw')
  @UseGuards(UserSessionGuard, IntentEnabledGuard)
  @WorkspaceRole('member')
  withdraw(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole,
    @Body(intentContractPipe(ChangeIntentPlanSchema)) input: z.infer<typeof ChangeIntentPlanSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.releases.record(workspaceId, { id: user.id, role }, { ...input, kind: 'withdraw' });
  }

  @Post('items/:itemId/plan/reinstate')
  @UseGuards(UserSessionGuard, IntentEnabledGuard)
  @WorkspaceRole('member')
  reinstate(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole,
    @Body(intentContractPipe(ChangeIntentPlanSchema)) input: z.infer<typeof ChangeIntentPlanSchema>,
  ) {
    assertPathMatchesBody(itemId, input.itemId, 'itemId');
    return this.releases.record(workspaceId, { id: user.id, role }, { ...input, kind: 'reinstate' });
  }
}
