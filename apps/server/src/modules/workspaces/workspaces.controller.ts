import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspacesService } from './workspaces.service.js';
import { ResolverService } from '../mapper/resolver.service.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import { publicJobResult } from '../job-queue/dto/job-response.dto.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import {
  CreateWorkspaceSchema,
  EnableCloudSchema,
  ResolveWorkspaceSchema,
  UpdateWorkspaceSchema,
  type CreateWorkspaceInput,
  type EnableCloudInput,
  type ResolveWorkspaceInput,
  type UpdateWorkspaceInput,
} from './workspaces.contract.js';
import { GraphBackend, resolveGraphBackend } from '../../database/graph-backend.js';

@Controller('workspaces')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly resolverService: ResolverService,
    private readonly pushQueue: PushQueueService,
  ) {}

  @Get()
  async listWorkspaces(@CurrentUser() user: AuthUser) {
    return this.workspacesService.getUserWorkspaces(user);
  }

  @Post()
  async createWorkspace(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateWorkspaceSchema, dtoFieldMessages)) dto: CreateWorkspaceInput,
  ) {
    return this.workspacesService.createWorkspace(user.id, user.email, user.displayName, dto);
  }

  @Get(':workspaceId')
  @WorkspaceRole('member')
  async getWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.getWorkspace(workspaceId);
  }

  // Workspace settings are control-plane administration: the body carries
  // `intentReleaseTrigger` (amendment §5), so without a permission check a service
  // token minted by an admin — a CI token, or one holding only `intent:release` —
  // could switch the workspace to `deploy` and then assert production state itself.
  // The role check alone reads the token CREATOR's role, never the token's grants.
  // Human admins still pass: JWT sessions bypass PermissionsGuard.
  @Patch(':workspaceId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async updateWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceSchema, dtoFieldMessages)) dto: UpdateWorkspaceInput,
  ) {
    return this.workspacesService.updateWorkspace(workspaceId, dto);
  }

  @Get(':workspaceId/mcp-config')
  @WorkspaceRole('member')
  async getMcpConfig(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.getMcpConfig(workspaceId);
  }

  @Post(':workspaceId/cloud/enable')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async enableCloud(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(EnableCloudSchema, dtoFieldMessages)) dto: EnableCloudInput = {},
  ) {
    return this.workspacesService.enableCloud(workspaceId, dto);
  }

  // Same fence, sharper stakes: the role check reads the token CREATOR's role, so an
  // owner-minted token holding only `intent:release` passed `@WorkspaceRole('owner')`
  // and could delete the workspace. Destroying a workspace is workspace management.
  @Delete(':workspaceId')
  @WorkspaceRole('owner')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async deleteWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.deleteWorkspace(workspaceId);
  }

  /**
   * Trigger one workspace-wide cross-repo resolution pass.
   *
   * Lets batched-push callers (e.g. `coredoc sync`) defer resolution off the
   * per-push path with `?defer=true` and run it exactly once at the end of the
   * batch — vs N pushes producing N back-to-back full-workspace resolutions.
   * ResolverService already coalesces concurrent calls per workspace.
   *
   * By default (no ?sync parameter), enqueues the resolution for async processing
   * and returns immediately with { jobId, status: "queued" }.
   * Pass ?sync=true to run the resolution synchronously and block until complete.
   */
  @Post(':workspaceId/resolve')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.RepoPush)
  async resolveWorkspace(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('sync') sync?: string,
    // Last on purpose: this method is called positionally by its tests, and by
    // Nest through decorators either way.
    @Body(new ZodValidationPipe(ResolveWorkspaceSchema, dtoFieldMessages)) body?: ResolveWorkspaceInput,
  ) {
    const targets = body?.targets ?? [];
    const workspace = await this.workspacesService.getWorkspace(workspaceId);
    const fileSnapshot = resolveGraphBackend(workspace) === GraphBackend.FileSnapshot;
    // Guarded BEFORE the sync/async split: Turso has no batch composition — it
    // mutates the shared graph per repository — so accepting targets on the
    // async branch would 202 and then silently run a targetless resolve.
    if (targets.length > 0 && !fileSnapshot) {
      throw new BadRequestException('Batch resolve targets require a file_snapshot workspace');
    }
    if (sync === 'true' || sync === '1') {
      if (!fileSnapshot) {
        return this.resolverService.resolveWorkspace(workspaceId);
      }
      const job = await this.pushQueue.enqueueResolve({ workspaceId, userId: user.id, targets });
      const terminal = await this.pushQueue.waitForTerminal(workspaceId, job.id);
      return publicJobResult(terminal.result);
    }
    const job = await this.pushQueue.enqueueResolve({ workspaceId, userId: user.id, targets });
    res.status(HttpStatus.ACCEPTED);
    return { jobId: job.id, status: 'queued' as const };
  }
}
