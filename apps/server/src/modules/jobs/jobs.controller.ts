import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { JobListQuerySchema, type JobListQueryInput } from './jobs.contract.js';
import { toJobResponse } from '../job-queue/dto/job-response.dto.js';

@Controller('workspaces/:workspaceId/jobs')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class JobsController {
  constructor(private readonly queue: PushQueueService) {}

  @Get(':jobId')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  async getJob(@Param('workspaceId') workspaceId: string, @Param('jobId') jobId: string) {
    const job = await this.queue.getJob(workspaceId, jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found in workspace ${workspaceId}`);
    return toJobResponse(job);
  }

  @Get()
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ResultRead)
  async listJobs(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(JobListQuerySchema, dtoFieldMessages)) query: JobListQueryInput,
  ) {
    const jobs = await this.queue.listJobs(workspaceId, query.status, query.limit);
    return jobs.map(toJobResponse);
  }
}
