import { BadRequestException, Body, Controller, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { ExactTelemetryTokenGuard } from '../../auth/exact-telemetry-token.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { CaptureService } from './capture.service.js';

function assertEmptyProbeBody(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new BadRequestException('Capture readiness probe body must be an empty JSON object');
  }
}

@Controller('workspaces/:workspaceId/capture/v1')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class CaptureController {
  constructor(private readonly capture: CaptureService) {}

  @Post('events')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  ingest(@Param('workspaceId') workspaceId: string, @CurrentUser() actor: AuthUser, @Body() body: unknown) {
    return this.capture.ingest(workspaceId, { id: actor.id, email: actor.email }, body);
  }

  @Post('repositories/resolve')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  @UseGuards(ExactTelemetryTokenGuard)
  resolveRepository(@Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    return this.capture.resolveRepository(workspaceId, body);
  }

  @Post('probe')
  @HttpCode(200)
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.TelemetryWrite)
  @UseGuards(ExactTelemetryTokenGuard)
  probe(@Body() body: unknown): { status: 'ready' } {
    assertEmptyProbeBody(body);
    return { status: 'ready' };
  }

  @Put('repositories/:repoKey')
  @WorkspaceRole('member')
  @UseGuards(UserSessionGuard)
  bindRepository(@Param('workspaceId') workspaceId: string, @Param('repoKey') repoKey: string, @Body() body: unknown) {
    return this.capture.bindRepository(workspaceId, repoKey, body);
  }

  @Put('provisioning')
  @WorkspaceRole('member')
  @UseGuards(UserSessionGuard)
  reportProvisioning(@Param('workspaceId') workspaceId: string, @CurrentUser() actor: AuthUser, @Body() body: unknown) {
    return this.capture.reportProvisioning(workspaceId, actor.id, body);
  }
}
