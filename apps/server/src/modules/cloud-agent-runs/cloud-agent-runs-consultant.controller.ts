import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CloudAgentRunConsultantService } from './cloud-agent-run-consultant.service.js';
import { type ConsultantRunsQuery, ConsultantRunsQuerySchema } from './cloud-agent-runs.contract.js';

/** The consultant's view: runs on no repository and the questions asked in them. Owners and admins preview it. */
@Controller('workspaces/:workspaceId/consultant-runs')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, UserSessionGuard)
export class CloudAgentRunsConsultantController {
  constructor(private readonly consultant: CloudAgentRunConsultantService) {}

  @Get()
  @WorkspaceRole('consultant')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(ConsultantRunsQuerySchema)) query: ConsultantRunsQuery,
  ) {
    return this.consultant.list(workspaceId, query.limit, query.offset);
  }

  @Get(':runId/questions')
  @WorkspaceRole('consultant')
  questions(@Param('workspaceId') workspaceId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.consultant.questions(workspaceId, runId);
  }
}
