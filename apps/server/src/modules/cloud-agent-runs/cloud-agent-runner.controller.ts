import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ClaimRequestSchema,
  CompleteTurnRequestSchema,
  EventBatchSchema,
  HeartbeatRequestSchema,
  RUNNER_LEASE_HEADER,
  type ClaimRequest,
  type CompleteTurnRequest,
  type EventBatch,
  type HeartbeatRequest,
} from '@coredoc/core/agent-runner';
import { AgentRunnerTokenGuard } from '../../auth/agent-runner-token.guard.js';
import { AuthGuard } from '../../auth/auth.guard.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CloudAgentTurnService, type RunnerPrincipal } from './cloud-agent-turn.service.js';

type RunnerRequest = Request & { serviceTokenId?: string; serviceTokenWorkspaceId?: string };

function principal(request: RunnerRequest): RunnerPrincipal {
  // AgentRunnerTokenGuard guarantees a runner token bound to the path's workspace.
  return { workspaceId: request.serviceTokenWorkspaceId!, tokenId: request.serviceTokenId! };
}

/**
 * The runner API: exact agent-runner tokens of the path's workspace only.
 * `@RequirePermission(AgentRunnerRun)` is what the AuthGuard fence keys on;
 * `@WorkspaceRole('admin')` refuses a token whose creator left or was demoted;
 * AgentRunnerTokenGuard refuses human sessions, which PermissionsGuard passes.
 * Every `/turns/:turnId` route is fenced on the live lease token.
 */
@Controller('workspaces/:workspaceId/agent-runner')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, AgentRunnerTokenGuard)
export class CloudAgentRunnerController {
  constructor(private readonly turns: CloudAgentTurnService) {}

  @Post('claim')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  async claim(
    @Req() request: RunnerRequest,
    @Body(new ZodValidationPipe(ClaimRequestSchema)) body: ClaimRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const assignment = await this.turns.claim(principal(request), body);
    if (!assignment) response.status(204);
    return assignment ?? undefined;
  }

  @Post('turns/:turnId/heartbeat')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  heartbeat(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(HeartbeatRequestSchema)) body: HeartbeatRequest,
  ) {
    return this.turns.heartbeat(principal(request), turnId, lease ?? '', body.versions);
  }

  @Post('turns/:turnId/events')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  events(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(EventBatchSchema)) body: EventBatch,
  ) {
    return this.turns.recordEvents(principal(request), turnId, lease ?? '', body);
  }

  @Post('turns/:turnId/complete')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  complete(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(CompleteTurnRequestSchema)) body: CompleteTurnRequest,
  ) {
    return this.turns.complete(principal(request), turnId, lease ?? '', body);
  }
}
