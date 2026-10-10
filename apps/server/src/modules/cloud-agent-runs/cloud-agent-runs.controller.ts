import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CloudAgentRunActivityService } from './cloud-agent-run-activity.service.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunQuestionService } from './cloud-agent-run-questions.service.js';
import { CloudAgentRunService } from './cloud-agent-run.service.js';
import {
  type AnswerQuestionInput,
  AnswerQuestionSchema,
  EventsQuerySchema,
  ListRunsQuerySchema,
  RequestScopeChangesSchema,
  StartRunSchema,
  type TranscriptQuery,
  TranscriptQuerySchema,
  type RequestScopeChangesInput,
  UpdateSettingsSchema,
  type StartRunInput,
  type UpdateSettingsInput,
} from './cloud-agent-runs.contract.js';

/**
 * Human sessions only, reads included: without UserSessionGuard, routes with no
 * permission requirement would admit any member-created service token, a runner
 * token among them. Every handler declares a workspace role, because without
 * one the role guard admits any authenticated session.
 */
@Controller('workspaces/:workspaceId/cloud-agent-runs')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, UserSessionGuard)
export class CloudAgentRunsController {
  constructor(
    private readonly runs: CloudAgentRunService,
    private readonly settings: CloudAgentRunSettingsService,
    private readonly questions: CloudAgentRunQuestionService,
    private readonly activity: CloudAgentRunActivityService,
  ) {}

  // Declared before `/:runId`, so `settings` is never taken for a run id.
  @Get('settings')
  @WorkspaceRole('member')
  getSettings(@Param('workspaceId') workspaceId: string) {
    return this.settings.view(workspaceId);
  }

  @Get('settings/jira-statuses')
  @WorkspaceRole('member')
  getJiraStatuses(@Param('workspaceId') workspaceId: string) {
    return this.settings.jiraStatuses(workspaceId);
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

  @Get(':runId/specs')
  @WorkspaceRole('member')
  specs(@Param('workspaceId') workspaceId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.specs(workspaceId, runId);
  }

  /** Only the latest proposed version; the web app sends the version it displayed. */
  @Post(':runId/specs/:version/accept')
  @HttpCode(200)
  @WorkspaceRole('member')
  acceptScope(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.acceptScope(workspaceId, runId, version, user.id);
  }

  @Post(':runId/specs/:version/request-changes')
  @HttpCode(200)
  @WorkspaceRole('member')
  requestScopeChanges(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodValidationPipe(RequestScopeChangesSchema)) body: RequestScopeChangesInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.requestScopeChanges(workspaceId, runId, version, user.id, body.text);
  }

  @Post(':runId/questions/:requestId/answer')
  @HttpCode(200)
  @WorkspaceRole('member')
  async answerQuestion(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body(new ZodValidationPipe(AnswerQuestionSchema)) body: AnswerQuestionInput,
    @CurrentUser() user: AuthUser,
  ) {
    await this.questions.answer(workspaceId, runId, requestId, user.id, body.answers);
    return this.runs.detail(workspaceId, runId);
  }

  @Post(':runId/cancel')
  @HttpCode(200)
  @WorkspaceRole('member')
  cancel(@Param('workspaceId') workspaceId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.cancel(workspaceId, runId);
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

  @Get(':runId/activity')
  @WorkspaceRole('member')
  runActivity(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @WorkspaceRoleValue() role: string | undefined,
  ) {
    return this.activity.activity(workspaceId, runId, role);
  }

  @Get(':runId/transcript')
  @WorkspaceRole('member')
  async transcript(
    @Param('workspaceId') workspaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query(new ZodValidationPipe(TranscriptQuerySchema)) query: TranscriptQuery,
    @Res() response: Response,
  ) {
    const download = await this.activity.transcript(workspaceId, runId, query.phase);
    response.set({
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${download.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // A failure after the headers went out can only cut the response short.
    await pipeline(download.stream, response).catch(() => response.destroy());
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
