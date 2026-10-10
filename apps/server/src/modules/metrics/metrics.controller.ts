import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { selfScopeFor } from '../../auth/self-scope.js';
import { MetricsService, TIMESERIES_METRICS, type TimeseriesMetric } from './metrics.service.js';
import { parseDaysParam } from '../../libs/coerce.js';

@Controller('workspaces/:workspaceId/metrics')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('summary')
  @WorkspaceRole('member')
  async getWorkspaceSummary(@Param('workspaceId') workspaceId: string) {
    return this.metricsService.getWorkspaceSummary(workspaceId);
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
      parseDaysParam(days, 365),
      selfScopeFor(user, role),
    );
  }
}
