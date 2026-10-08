import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunService } from './cloud-agent-run.service.js';
import {
  EventsQuerySchema,
  ListRunsQuerySchema,
  StartRunSchema,
  UpdateSettingsSchema,
  type StartRunInput,
  type UpdateSettingsInput,
} from './cloud-agent-runs.contract.js';

/**
 * The human cloud agent runs API. Human sessions only, reads included: without
 * UserSessionGuard, routes with no permission requirement would admit any
 * member-created service token, a runner token among them. Every handler
 * declares a workspace role, because without one the role guard admits any
 * authenticated session.
 */
@Controller('workspaces/:workspaceId/cloud-agent-runs')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, UserSessionGuard)
export class CloudAgentRunsController {
  constructor(
    private readonly runs: CloudAgentRunService,
    private readonly settings: CloudAgentRunSettingsService,
  ) {}

  // Declared before `/:runId`, so `settings` is never taken for a run id.
  @Get('settings')
  @WorkspaceRole('member')
  getSettings(@Param('workspaceId') workspaceId: string) {
    return this.settings.view(workspaceId);
  }

  @Put('settings')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  updateSettings(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateSettingsSchema)) body: UpdateSettingsInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.settings.update(workspaceId, user.id, body);
  }

  @Get()
  @WorkspaceRole('member')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(ListRunsQuerySchema)) query: { limit: number; offset: number },
  ) {
    return this.runs.list(workspaceId, query.limit, query.offset);
  }

  @Post()
  @WorkspaceRole('member')
  start(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(StartRunSchema)) body: StartRunInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.start(workspaceId, user.id, body);
  }

  @Get(':runId')
  @WorkspaceRole('member')
  detail(@Param('workspaceId') workspaceId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.detail(workspaceId, runId);
  }

  @Post(':runId/rerun')
  @WorkspaceRole('member')
  rerun(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.rerun(workspaceId, user.id, runId);
  }

  @Get(':runId/events')
  @WorkspaceRole('member')
  events(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query(new ZodValidationPipe(EventsQuerySchema)) query: { after: number; limit: number },
  ) {
    return this.runs.events(workspaceId, runId, query.after, query.limit);
  }
}
