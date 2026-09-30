import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { AgentSessionsService } from './agent-sessions.service.js';
import { parseOtlpLogRecords, parseOtlpMetrics } from './otlp-parser.js';

interface AuthedRequest {
  user?: { id?: string; email?: string };
}

@Controller('workspaces/:workspaceId/otel/v1')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class OtelIngestController {
  constructor(private readonly sessions: AgentSessionsService) {}

  // Attribution is server-derived from the authenticated principal (the service
  // token's creator, or the JWT member). The payload's user.* resource attrs are
  // spoofable by any token holder and are never trusted for identity.
  private identityOf(req: AuthedRequest): { userId: string | undefined; userEmail: string | undefined } {
    return { userId: req.user?.id, userEmail: req.user?.email };
  }

  @Post('metrics')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  async metrics(@Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const identity = this.identityOf(req);
    const deltas = parseOtlpMetrics(body).map((d) => ({ ...d, ...identity }));
    await this.sessions.applyMetricDeltas(workspaceId, deltas);
    return { partialSuccess: {} }; // OTLP success envelope
  }

  @Post('logs')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  async logs(@Param('workspaceId') workspaceId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const identity = this.identityOf(req);
    const batches = parseOtlpLogRecords(body).map((b) => ({ ...b, ...identity }));
    await this.sessions.applyLogDeltas(workspaceId, batches);
    return { partialSuccess: {} };
  }
}
