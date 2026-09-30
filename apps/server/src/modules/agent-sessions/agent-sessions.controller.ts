import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { selfScopeFor } from '../../auth/self-scope.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { AgentSessionsService } from './agent-sessions.service.js';

function parseDays(v?: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : 30;
}

@Controller('workspaces/:workspaceId/sessions')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

  @Get('summary')
  @WorkspaceRole('member')
  // Keeps the telemetry:write ingest token write-only — service tokens need an
  // explicit read grant here; JWT members pass through the permissions guard.
  @RequirePermission(TokenPermission.ResultRead)
  async summary(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.sessions.getWorkspaceSessionSummary(workspaceId, parseDays(days), selfScopeFor(user, role));
  }

  @Get('by-user')
  @WorkspaceRole('member')
  // Same read gate as `summary`: JWT members pass through; service tokens need
  // an explicit result:read grant.
  @RequirePermission(TokenPermission.ResultRead)
  async byUser(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.sessions.getWorkspaceSessionsByUser(workspaceId, parseDays(days), selfScopeFor(user, role));
  }

  @Get('activity')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  async activity(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.sessions.getWorkspaceActivity(workspaceId, parseDays(days), selfScopeFor(user, role));
  }

  @Post(':sessionId/context')
  @HttpCode(204)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  async context(
    @Param('workspaceId') workspaceId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
    const pr = Number(body?.prNumber);
    await this.sessions.applySessionContext(workspaceId, sessionId.slice(0, 128), {
      repoKey: str(body?.repoKey, 256),
      branch: str(body?.branch, 256),
      issueKey: str(body?.issueKey, 64),
      prNumber: Number.isInteger(pr) && pr > 0 ? pr : undefined,
      headShaStart: str(body?.headShaStart, 64),
      headShaEnd: str(body?.headShaEnd, 64),
    });
  }
}
