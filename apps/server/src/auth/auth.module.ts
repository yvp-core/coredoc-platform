import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { WorkspaceRoleGuard } from './workspace-role.guard.js';
import { PermissionsGuard } from './permissions.guard.js';
import { ExactTelemetryTokenGuard } from './exact-telemetry-token.guard.js';
import { DatabaseModule } from '../database/database.module.js';
import { WorkOSInvitationsService } from './workos-invitations.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    AuthService,
    AuthGuard,
    WorkspaceRoleGuard,
    PermissionsGuard,
    ExactTelemetryTokenGuard,
    WorkOSInvitationsService,
  ],
  exports: [
    AuthService,
    AuthGuard,
    WorkspaceRoleGuard,
    PermissionsGuard,
    ExactTelemetryTokenGuard,
    WorkOSInvitationsService,
  ],
})
export class AuthModule {}
