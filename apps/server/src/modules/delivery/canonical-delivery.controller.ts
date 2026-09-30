import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { JwtOnlyGuard } from '../../auth/jwt-only.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { ArtifactRevisionBodySchema, type ArtifactRevisionBody } from './canonical-artifact.contract.js';
import {
  CoredocShipEvidenceSchema,
  DeliveryTaskEnsureSchema,
  TaskExternalRefAttachSchema,
  TaskExternalRefDetachSchema,
  deliveryBodyError,
  type CoredocShipEvidenceInput,
  type DeliveryTaskEnsureInput,
  type TaskExternalRefAttachInput,
  type TaskExternalRefDetachInput,
} from './canonical-delivery.contract.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

/**
 * The workspace member a delivery read is restricted to, or null for the whole workspace
 * (ADR-20260908-per-member-delivery-filter). `mine=true` is sugar for the caller's own id and
 * is the only form a plain `member` can use for anyone else — passing another member's id is a
 * 403, not a silently narrowed read. A service token arrives with `role === undefined` (see
 * `@WorkspaceRoleValue`) and is treated as workspace-wide, like every other analytics read.
 */
function resolveDeliveryUserId(
  user: AuthUser,
  role: WorkspaceMemberRole | undefined,
  // Typed `unknown`, not `string | undefined`: Express/qs parses `?userId=a&userId=b` into an
  // array and `?userId[x]=a` into an object, so the declared string type is a lie at the trust
  // boundary. Both are rejected rather than coerced — `String(['a','b'])` would silently filter
  // by the id "a,b" and return an empty page nobody asked for (fail fast).
  mine: unknown,
  userId: unknown,
): string | null {
  if (userId !== undefined && typeof userId !== 'string') {
    throw new BadRequestException('userId must be a single string');
  }
  if (mine !== undefined && mine !== 'true' && mine !== 'false') {
    throw new BadRequestException('mine must be true or false');
  }
  const requested = typeof userId === 'string' && userId.length > 0 ? userId : undefined;
  if (requested !== undefined && mine !== undefined) {
    throw new BadRequestException('mine and userId cannot be combined');
  }
  if (mine === 'true') return user.id;
  if (requested === undefined) return null;
  if (role === WorkspaceMemberRole.Member && requested !== user.id) {
    throw new ForbiddenException('Members may only filter delivery reads by their own id');
  }
  return requested;
}

@Controller('workspaces/:workspaceId/delivery/v2')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class CanonicalDeliveryController {
  constructor(private readonly delivery: CanonicalDeliveryService) {}

  @Put('tasks/:taskId')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  ensureTask(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() actor: AuthUser,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(DeliveryTaskEnsureSchema, deliveryBodyError)) body: DeliveryTaskEnsureInput,
  ) {
    return this.delivery.ensureTask(workspaceId, actor.id, taskId, body);
  }

  @Post('tasks/:taskId/external-refs')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  @UseGuards(JwtOnlyGuard)
  attachExternalRef(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(TaskExternalRefAttachSchema, deliveryBodyError)) body: TaskExternalRefAttachInput,
  ) {
    return this.delivery.attachExternalRef(workspaceId, taskId, body);
  }

  @Post('tasks/:taskId/external-refs/:externalRefId/detach')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  @UseGuards(JwtOnlyGuard)
  detachExternalRef(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Param('externalRefId') externalRefId: string,
    @Body(new ZodValidationPipe(TaskExternalRefDetachSchema, deliveryBodyError)) body: TaskExternalRefDetachInput,
  ) {
    return this.delivery.detachExternalRef(workspaceId, taskId, externalRefId, body);
  }

  @Post('tasks/:taskId/ship-evidence/coredoc')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  @UseGuards(JwtOnlyGuard)
  recordCoredocShipEvidence(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() actor: AuthUser,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(CoredocShipEvidenceSchema, deliveryBodyError)) body: CoredocShipEvidenceInput,
  ) {
    return this.delivery.recordCoredocShipEvidence(workspaceId, actor.id, taskId, body);
  }

  @Put('artifacts/:artifactId/revisions')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  uploadArtifactRevision(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() actor: AuthUser,
    @Param('artifactId') artifactId: string,
    @Body(new ZodValidationPipe(ArtifactRevisionBodySchema, deliveryBodyError)) body: ArtifactRevisionBody,
  ) {
    return this.delivery.uploadArtifactRevision(workspaceId, actor.id, artifactId, body);
  }

  @Get('artifacts/:artifactId/revisions')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  getArtifact(@Param('workspaceId') workspaceId: string, @Param('artifactId') artifactId: string) {
    return this.delivery.getArtifact(workspaceId, artifactId);
  }

  @Get('tasks')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTasks(@Param('workspaceId') workspaceId: string) {
    return this.delivery.listTasks(workspaceId);
  }

  @Get('task-summaries')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskSummaries(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('days') days?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('mine') mine?: unknown,
    @Query('userId') userId?: unknown,
  ) {
    return this.delivery.listTaskSummaries(
      workspaceId,
      limit,
      cursor,
      days,
      lifecycle,
      since,
      until,
      resolveDeliveryUserId(user, role, mine, userId),
    );
  }

  // Fixed segment, declared before `tasks/:taskId` so route order can never make a task id
  // shadow it.
  @Get('summary')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  getDeliverySummary(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Query('days') days?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('mine') mine?: unknown,
    @Query('userId') userId?: unknown,
  ) {
    return this.delivery.getDeliverySummary(
      workspaceId,
      days,
      lifecycle,
      since,
      until,
      resolveDeliveryUserId(user, role, mine, userId),
    );
  }

  @Get('tasks/:taskId')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  getTaskDetail(@Param('workspaceId') workspaceId: string, @Param('taskId') taskId: string) {
    return this.delivery.getTaskDetail(workspaceId, taskId);
  }

  @Get('tasks/:taskId/external-refs')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskExternalRefs(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskExternalRefs(workspaceId, taskId, limit, cursor);
  }

  @Get('tasks/:taskId/external-refs/:externalRefId/state-history')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listExternalRefStateHistory(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Param('externalRefId') externalRefId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listExternalRefStateHistory(workspaceId, taskId, externalRefId, limit, cursor);
  }

  @Get('tasks/:taskId/runs')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskRuns(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskRuns(workspaceId, taskId, limit, cursor);
  }

  @Get('tasks/:taskId/runs/:runId/stage-occurrences')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listRunStageOccurrences(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Param('runId') runId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listRunStageOccurrences(workspaceId, taskId, runId, limit, cursor);
  }

  @Get('tasks/:taskId/code-changes')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskCodeChanges(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskCodeChanges(workspaceId, taskId, limit, cursor);
  }

  @Get('tasks/:taskId/ship-evidence')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskShipEvidence(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskShipEvidence(workspaceId, taskId, limit, cursor);
  }

  @Get('tasks/:taskId/rework-signals')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskReworkSignals(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskReworkSignals(workspaceId, taskId, limit, cursor);
  }

  @Get('tasks/:taskId/artifacts')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  @UseGuards(JwtOnlyGuard)
  listTaskArtifacts(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delivery.listTaskArtifacts(workspaceId, taskId, limit, cursor);
  }
}
