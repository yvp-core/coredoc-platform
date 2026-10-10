import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { AgentRunsService, type AgentRunIdentity } from './agent-runs.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { CreateAgentRunSchema, type CreateAgentRunInput } from './agent-runs.contract.js';

interface AuthedRequest {
  user?: { id?: string; email?: string };
}

@Controller('workspaces/:workspaceId/agent-runs')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class AgentRunsController {
  constructor(private readonly agentRuns: AgentRunsService) {}

  // Attribution is server-derived from the authenticated principal (the service
  // token's creator, or the JWT member). The DTO carries no user field — any
  // payload user.* is stripped by the whitelist — so identity can only come from
  // here, never the body.
  private identityOf(req: AuthedRequest): AgentRunIdentity {
    return { userId: req.user?.id, userEmail: req.user?.email };
  }

  @Post()
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateAgentRunSchema, dtoFieldMessages)) body: CreateAgentRunInput,
    @Req() req: AuthedRequest,
  ) {
    await this.agentRuns.record(workspaceId, body, this.identityOf(req));
    return {};
  }

  // Human/JWT-member read only. UserSessionGuard rejects any request carrying a
  // service-token principal (serviceTokenWorkspaceId), so a leaked write-only
  // telemetry token cannot READ the workspace's agent-run history (userEmail,
  // userId, cost/token counts). PermissionsGuard still passes through here —
  // the route has no @RequirePermission — so browser/JWT members reach it via
  // role, while service tokens are barred regardless of their permissions.
  @Get()
  @WorkspaceRole('member')
  @UseGuards(UserSessionGuard)
  async list(@Param('workspaceId') workspaceId: string) {
    return this.agentRuns.getWorkspaceAgentRuns(workspaceId);
  }
}
