import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { MapperService } from './mapper.service.js';
import { ResolverService, type ResolutionMetrics } from './resolver.service.js';
import { validateMapper } from '@coredoc/core';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { GraphBackend, resolveGraphBackend } from '../../database/graph-backend.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';

const MAX_MAPPER_BYTES = 3 * 1024 * 1024; // 3 MB

@Controller('workspaces/:workspaceId/mapper')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class MapperController {
  private readonly logger = new Logger(MapperController.name);

  constructor(
    private readonly mapperService: MapperService,
    private readonly resolverService: ResolverService,
    private readonly controlPlane: ControlPlaneService,
    private readonly pushQueue: PushQueueService,
  ) {}

  /**
   * Upload/replace the workspace's mapper.json. Validates against MapperSchema,
   * writes R2, upserts MapperArtifact, then runs cross-repo resolution and
   * returns its metrics. Turso resolves inline; file snapshots enqueue a
   * durable job that reads the current mapper when its attempt starts.
   */
  @Put()
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultWrite)
  async putMapper(
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Query('defer') defer?: string,
  ) {
    const content = JSON.stringify(body);
    if (Buffer.byteLength(content) > MAX_MAPPER_BYTES) {
      throw new PayloadTooLargeException(`Mapper exceeds ${MAX_MAPPER_BYTES} bytes`);
    }

    const validation = validateMapper(body);
    if (!validation.ok) {
      throw new UnprocessableEntityException({
        message: 'Mapper validation failed',
        errors: validation.errors,
      });
    }

    const upload = await this.mapperService.uploadMapper(workspaceId, content, user.id);
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException(`Workspace ${workspaceId} not found`);

    const backend = resolveGraphBackend(workspace);
    // Upload-only mode for batch sync: the client is about to finalize with
    // ONE batch resolve that reads the live mapper row, so an inline resolve
    // here would build a second full artifact — and on a fresh workspace whose
    // repositories are upload-only it would fail outright on an empty
    // composition. Only meaningful on file_snapshot: Turso has no later
    // finalizer, so a deferred mapper there would be stored and silently never
    // applied to the graph.
    if (defer === 'true' || defer === '1') {
      if (backend !== GraphBackend.FileSnapshot) {
        throw new BadRequestException('Deferred mapper upload requires a file_snapshot workspace');
      }
      return {
        sha256: upload.sha256,
        r2Key: upload.r2Key,
        sizeBytes: upload.sizeBytes,
        duplicate: upload.duplicate,
        resolution: null,
      };
    }
    if (backend === GraphBackend.FileSnapshot) {
      const job = await this.pushQueue.enqueueResolve({
        workspaceId,
        userId: user.id,
      });
      const terminal = await this.pushQueue.waitForTerminal(workspaceId, job.id);
      const result = terminal.result;
      if (!result || typeof result !== 'object' || !('resolution' in result)) {
        throw new InternalServerErrorException(`Resolve job ${job.id} returned no resolution metrics`);
      }
      // `resolution: null` with `idempotent: true` is the no-op fast path: the
      // mapper (usually a duplicate PUT) left the composition identical to the
      // active version, so its resolution was computed and asserted when that
      // version was first published. The PUT succeeded and nothing changed —
      // this must not surface as an error.
      const idempotent = 'idempotent' in result && result.idempotent === true;
      if (!result.resolution && !idempotent) {
        throw new InternalServerErrorException(`Resolve job ${job.id} returned no resolution metrics`);
      }
      return {
        jobId: job.id,
        sha256: upload.sha256,
        r2Key: upload.r2Key,
        sizeBytes: upload.sizeBytes,
        duplicate: upload.duplicate,
        resolution: (result.resolution as unknown as ResolutionMetrics | null) ?? null,
      };
    }
    // Always run resolution — graph may have drifted since the last run even
    // when the mapper itself is unchanged. Resolver failures must NOT fail the
    // PUT: the mapper is already persisted at this point, so returning a 5xx
    // would tell `coredoc mapper push` that the upload failed and the user
    // would retry. Mirror PushService.runWorkspaceResolver: surface the error
    // on the response, let the client retry resolution explicitly if needed.
    let resolution: ResolutionMetrics | { error: string };
    try {
      resolution = await this.resolverService.resolveWorkspace(workspaceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`resolveWorkspace failed for ${workspaceId} after mapper upload: ${message}`);
      resolution = { error: message };
    }

    return {
      sha256: upload.sha256,
      r2Key: upload.r2Key,
      sizeBytes: upload.sizeBytes,
      duplicate: upload.duplicate,
      resolution,
    };
  }

  /**
   * Download current mapper.json content. Useful for `coredoc mapper pull`
   * and for inspection.
   */
  @Get()
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultRead)
  async getMapper(@Param('workspaceId') workspaceId: string, @Res() res: Response): Promise<void> {
    const found = await this.mapperService.getRawContent(workspaceId);
    if (!found) throw new NotFoundException(`No mapper for workspace ${workspaceId}`);
    res.setHeader('ETag', found.sha256);
    res.setHeader('Content-Type', 'application/json');
    res.send(found.content);
  }

  /**
   * Pointer info only — sha, sizeBytes, uploadedBy, uploadedAt, metadata.
   * Cheap call for UIs that want to display "current mapper" without pulling
   * the full content.
   */
  @Get('metadata')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ResultRead)
  async getMetadata(@Param('workspaceId') workspaceId: string) {
    const meta = await this.mapperService.getMetadata(workspaceId);
    if (!meta) throw new NotFoundException(`No mapper for workspace ${workspaceId}`);
    return meta;
  }
}
