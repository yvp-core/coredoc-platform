import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { NoSourceCodePipe } from '../../common/pipes/no-source-code.pipe.js';
import { PushService } from './push.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { VersionPushSchema, type VersionPushInput } from './push.contract.js';
import type { ParsedRepo, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import type { PushPayload } from '../../libs/pipeline/job-payload.types.js';
import { publicJobResult } from '../job-queue/dto/job-response.dto.js';
import { GraphBackend } from '../../database/graph-backend.js';

@Controller('workspaces/:workspaceId/repos/:repoName')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class PushController {
  constructor(
    private readonly pushService: PushService,
    private readonly pushQueue: PushQueueService,
  ) {}

  /**
   * Upload parse result to R2 versioned storage.
   * Returns version key for subsequent push call.
   *
   * Body is a bare ParsedRepo JSON — not wrapped in a DTO because wrapping
   * would break the wire format. NoSourceCodePipe enforces the no-sourceCode
   * rule on the raw body.
   */
  @Post('/results/upload')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultWrite)
  async uploadResult(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Body(NoSourceCodePipe) body: ParsedRepo,
    @CurrentUser() _user: AuthUser,
  ) {
    return this.pushService.uploadResult(workspaceId, repoName, body);
  }

  /**
   * Push to graph database.
   * Accepts a version reference payload — the server reads ParsedRepo (and
   * optionally summary/embeddings) from R2 by version key.
   */
  @Post('/push')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.RepoPush)
  async push(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Body(new ZodValidationPipe(VersionPushSchema, dtoFieldMessages)) body: VersionPushInput,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('sync') sync?: string,
    @Query('defer') defer?: string,
    @Query('rebuild') rebuild?: string,
  ) {
    const isSync = sync === 'true' || sync === '1';
    // ?rebuild=true replaces the repo's graph instead of diffing against the
    // previous version. The explicit path for a parse the diff engine refuses
    // to apply — a repo genuinely emptied of code reads identically to a
    // degraded parse, and only the operator can tell them apart.
    const isRebuild = rebuild === 'true' || rebuild === '1';
    // ?defer=true tells the server to skip the per-push workspace resolver run.
    // Callers (e.g. `coredoc sync`) opt in when they're about to push a batch
    // of repos and will trigger a single explicit resolve at the end via
    // `POST /workspaces/:id/resolve`. Without this, N pushes = N full-workspace
    // resolutions back-to-back, which dominated the Turso read budget.
    const deferResolution = defer === 'true' || defer === '1';

    const { parsedVersion, commitSha, summaryVersion, embeddingsVersion, excludeSummaries, excludeEmbeddings } = body;
    if (summaryVersion && excludeSummaries) {
      throw new BadRequestException('summaryVersion cannot be combined with excludeSummaries');
    }
    if (embeddingsVersion && excludeEmbeddings) {
      throw new BadRequestException('embeddingsVersion cannot be combined with excludeEmbeddings');
    }
    const metadataExclusions = {
      excludeSummaries: excludeSummaries === true,
      excludeEmbeddings: excludeEmbeddings === true,
    };
    const payload: PushPayload = {
      parsedVersion,
      ...(summaryVersion ? { summaryVersion } : {}),
      ...(embeddingsVersion ? { embeddingsVersion } : {}),
      ...(excludeSummaries ? { excludeSummaries: true } : {}),
      ...(excludeEmbeddings ? { excludeEmbeddings: true } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(deferResolution ? { deferResolution: true } : {}),
      ...(isRebuild ? { rebuild: true } : {}),
    };
    if (isSync) {
      const backend = await this.pushService.getWorkspaceGraphBackend(workspaceId);
      if (backend !== GraphBackend.FileSnapshot) {
        return this.pushService.pushByVersion(
          workspaceId,
          repoName,
          parsedVersion,
          commitSha ?? null,
          user.id,
          summaryVersion,
          embeddingsVersion,
          deferResolution,
          isRebuild,
          metadataExclusions,
        );
      }
      const job = await this.pushQueue.enqueuePush({ workspaceId, repoName, payload, userId: user.id });
      const terminal = await this.pushQueue.waitForTerminal(workspaceId, job.id);
      return publicJobResult(terminal.result);
    }
    const job = await this.pushQueue.enqueuePush({ workspaceId, repoName, payload, userId: user.id });
    res.status(HttpStatus.ACCEPTED);
    return { jobId: job.id, status: 'queued' as const };
  }

  /**
   * Get the latest summary for a repo.
   * Returns a presigned R2 download URL when available (production),
   * or falls back to serving the data directly (local dev without R2).
   */
  @Get('/summaries/latest')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultRead)
  async getLatestSummary(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @CurrentUser() _user: AuthUser,
  ) {
    // Try presigned URL first (avoids proxying the full payload through server)
    const urlResult = await this.pushService.getLatestSummaryUrl(workspaceId, repoName);
    if (urlResult) {
      return { mode: 'redirect' as const, ...urlResult };
    }

    // Fallback: serve data directly (local dev or R2 not configured)
    const result = await this.pushService.getLatestSummary(workspaceId, repoName);
    if (!result) {
      throw new NotFoundException(`No summary found for repo "${repoName}"`);
    }
    return { mode: 'inline' as const, ...result };
  }

  /**
   * Upload a summary to R2 versioned storage.
   * Returns version key for subsequent push call.
   */
  @Post('/summaries/upload')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultWrite)
  async uploadSummary(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Body() body: SummaryOutput,
    @CurrentUser() _user: AuthUser,
  ) {
    return this.pushService.uploadSummary(workspaceId, repoName, body);
  }

  /**
   * Upload embeddings to R2 versioned storage.
   * Returns version key for subsequent push call.
   */
  @Post('/embeddings/upload')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultWrite)
  async uploadEmbeddings(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Body() body: EmbeddingsOutput,
    @CurrentUser() _user: AuthUser,
  ) {
    return this.pushService.uploadEmbeddings(workspaceId, repoName, body);
  }
}
