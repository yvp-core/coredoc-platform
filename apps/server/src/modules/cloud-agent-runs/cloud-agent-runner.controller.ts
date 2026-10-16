import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ClaimRequestSchema,
  CompleteTurnRequestSchema,
  EventBatchSchema,
  HeartbeatRequestSchema,
  type ProposeScope,
  ProposeScopeRequestSchema,
  type ReportQuestion,
  ReportQuestionRequestSchema,
  type RequestRepo,
  RequestRepoRequestSchema,
  type ReserveBranchRequest,
  ReserveBranchRequestSchema,
  RUNNER_LEASE_HEADER,
  type RunnerStartupProblem,
  RunnerStartupProblemSchema,
  type SubmitResult,
  SubmitResultRequestSchema,
  type ClaimRequest,
  type CompleteTurn,
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
import { CloudAgentTurnArchiveService } from './cloud-agent-turn-archive.service.js';
import { CloudAgentTurnService } from './cloud-agent-turn.service.js';
import type { RunnerPrincipal, TurnLease } from './turn-lease.js';
import { RunnerRateLimitGuard } from './runner-rate-limit.guard.js';

type RunnerRequest = Request & { serviceTokenId?: string; serviceTokenWorkspaceId?: string };

function principal(request: RunnerRequest): RunnerPrincipal {
  // AgentRunnerTokenGuard guarantees a runner token bound to the path's workspace.
  return { workspaceId: request.serviceTokenWorkspaceId!, tokenId: request.serviceTokenId! };
}

function turnLease(request: RunnerRequest, turnId: string, token: string | undefined): TurnLease {
  return { runner: principal(request), turnId, token: token ?? '' };
}

/**
 * `@RequirePermission(AgentRunnerRun)` is what the AuthGuard fence keys on;
 * `@WorkspaceRole('admin')` refuses a token whose creator left or was demoted;
 * AgentRunnerTokenGuard refuses human sessions, which PermissionsGuard passes.
 * Every `/turns/:turnId` route is fenced on the live lease token.
 */
@Controller('workspaces/:workspaceId/agent-runner')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, AgentRunnerTokenGuard, RunnerRateLimitGuard)
export class CloudAgentRunnerController {
  constructor(
    private readonly turns: CloudAgentTurnService,
    private readonly archives: CloudAgentTurnArchiveService,
  ) {}

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

  @Post('startup-check')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  async startupCheck(
    @Req() request: RunnerRequest,
    @Body(new ZodValidationPipe(RunnerStartupProblemSchema)) body: RunnerStartupProblem,
  ) {
    await this.turns.recordStartupProblem(principal(request), body);
    return { recorded: true };
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
    return this.turns.heartbeat(turnLease(request, turnId, lease), body.versions);
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
    return this.turns.recordEvents(turnLease(request, turnId, lease), body);
  }

  /** Validation errors come back in the body (`accepted: false`) for the agent to fix. */
  @Post('turns/:turnId/propose-scope')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  proposeScope(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(ProposeScopeRequestSchema)) body: ProposeScope,
  ) {
    return this.turns.proposeScope(turnLease(request, turnId, lease), body);
  }

  @Post('turns/:turnId/questions')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  reportQuestion(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(ReportQuestionRequestSchema)) body: ReportQuestion,
  ) {
    return this.turns.reportQuestion(turnLease(request, turnId, lease), body);
  }

  /** Validation errors come back in the body (`accepted: false`) for the agent to fix. */
  @Post('turns/:turnId/submit-result')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  submitResult(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(SubmitResultRequestSchema)) body: SubmitResult,
  ) {
    return this.turns.submitResult(turnLease(request, turnId, lease), body);
  }

  /** Validation errors come back in the body (`state: rejected`) for the agent to fix. */
  @Post('turns/:turnId/request-repo')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  requestRepo(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(RequestRepoRequestSchema)) body: RequestRepo,
  ) {
    return this.turns.requestRepo(turnLease(request, turnId, lease), body);
  }

  /** Before the runner's first push of the run branch to a repository. */
  @Post('turns/:turnId/branches')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  reserveBranch(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(ReserveBranchRequestSchema)) body: ReserveBranchRequest,
  ) {
    return this.turns.reserveBranch(turnLease(request, turnId, lease), body.repository);
  }

  /** The previous state archive, streamed only to the turn's live lease. */
  @Get('turns/:turnId/archive')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  async downloadArchive(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Res() response: Response,
  ) {
    const archive = await this.archives.download(turnLease(request, turnId, lease));
    response.set('Content-Type', 'application/gzip');
    response.send(archive);
  }

  /** Raw `application/octet-stream` body on its own body-size tier (see body-limits.ts). */
  @Put('turns/:turnId/archive')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  uploadArchive(
    @Req() request: RunnerRequest & { rawBody?: Buffer },
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
  ) {
    const body = Buffer.isBuffer(request.body) ? request.body : (request.rawBody ?? Buffer.alloc(0));
    if (body.length === 0) throw new BadRequestException('Send the state archive as an application/octet-stream body');
    return this.archives.upload(turnLease(request, turnId, lease), body);
  }

  @Post('turns/:turnId/complete')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.AgentRunnerRun)
  complete(
    @Req() request: RunnerRequest,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @Headers(RUNNER_LEASE_HEADER) lease: string | undefined,
    @Body(new ZodValidationPipe(CompleteTurnRequestSchema)) body: CompleteTurn,
  ) {
    return this.turns.complete(turnLease(request, turnId, lease), body);
  }
}
