import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { selfScopeFor } from '../../auth/self-scope.js';
import { MetricsService, TIMESERIES_METRICS, type TimeseriesMetric } from './metrics.service.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * Parse a `?days=` query string into a positive integer, clamped to [1, MAX_DAYS].
 * Falls back to DEFAULT_DAYS for missing, non-numeric, or out-of-range values
 * (e.g. `?days=foo` → NaN → default).
 */
function parseDaysParam(raw?: string): number {
  if (!raw) return DEFAULT_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DAYS;
  return Math.min(parsed, MAX_DAYS);
}

@Controller('workspaces/:workspaceId/metrics')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('summary')
  @WorkspaceRole('member')
  async getWorkspaceSummary(@Param('workspaceId') workspaceId: string) {
    return this.metricsService.getWorkspaceSummary(workspaceId);
  }

  @Get('repos/:repoKey/history')
  @WorkspaceRole('member')
  async getRepoMetricsHistory(
    @Param('workspaceId') workspaceId: string,
    @Param('repoKey') repoKey: string,
    @Query('days') days?: string,
  ) {
    return this.metricsService.getRepoMetricsHistory(workspaceId, repoKey, parseDaysParam(days));
  }

  @Get('mcp/count')
  @WorkspaceRole('member')
  async getMcpQueryCount(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
  ) {
    const count = await this.metricsService.getMcpQueryCount(workspaceId, selfScopeFor(user, role));
    return { count };
  }

  @Get('mcp/breakdown')
  @WorkspaceRole('member')
  async getMcpQueryBreakdown(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.metricsService.getMcpQueryBreakdown(workspaceId, parseDaysParam(days), selfScopeFor(user, role));
  }

  @Get('mcp/empty-results')
  @WorkspaceRole('member')
  async getMcpEmptyResultBreakdown(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
  ) {
    return this.metricsService.getMcpEmptyResultBreakdown(workspaceId, parseDaysParam(days), selfScopeFor(user, role));
  }

  @Get('timeseries')
  @WorkspaceRole('member')
  async getTimeseries(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('metric') metric?: string,
    @Query('days') days?: string,
  ) {
    if (!metric || !(TIMESERIES_METRICS as readonly string[]).includes(metric)) {
      throw new BadRequestException(
        `Invalid metric ${JSON.stringify(metric ?? null)} — expected one of: ${TIMESERIES_METRICS.join(', ')}`,
      );
    }
    return this.metricsService.getTimeseries(
      workspaceId,
      metric as TimeseriesMetric,
      parseDaysParam(days),
      selfScopeFor(user, role),
    );
  }
}
