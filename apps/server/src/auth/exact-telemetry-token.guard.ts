import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isExactTelemetryPurpose } from './token-permissions.js';

/** Restrict a machine-only route to the exact telemetry ServiceToken purpose. */
@Injectable()
export class ExactTelemetryTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      serviceTokenWorkspaceId?: string;
      serviceTokenPermissions?: string[];
    }>();

    if (!request.serviceTokenWorkspaceId || !isExactTelemetryPurpose(request.serviceTokenPermissions)) {
      throw new ForbiddenException('This endpoint requires an exact telemetry service token');
    }

    return true;
  }
}
