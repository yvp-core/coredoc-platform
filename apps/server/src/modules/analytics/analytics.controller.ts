import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { selfScopeFor } from '../../auth/self-scope.js';
import { parseCustomWindow } from '../../libs/analytics-window.js';
import { MAX_ANALYTICS_DAYS, UsageAnalyticsService } from './usage-analytics.service.js';
import { parseDaysParam } from '../../libs/coerce.js';

@Controller('workspaces/:workspaceId/analytics')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(private readonly usage: UsageAnalyticsService) {}

  @Get('usage')
  @WorkspaceRole('member')
  // Service tokens need an explicit read grant; JWT members pass through and
  // are self-scoped by `selfScopeFor`.
  @RequirePermission(TokenPermission.ResultRead)
  async getUsage(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    // `since`/`until` win over `days` when present; malformed ranges 400 instead of clamping.
    const custom = parseCustomWindow(since, until);
    return this.usage.getWorkspaceUsage(
      workspaceId,
      parseDaysParam(days, MAX_ANALYTICS_DAYS),
      selfScopeFor(user, role),
      custom,
    );
  }
}
