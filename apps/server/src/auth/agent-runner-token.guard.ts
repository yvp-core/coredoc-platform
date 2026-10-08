import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isExactAgentRunnerPurpose } from './token-permissions.js';

/**
 * Restrict the runner API to exact agent-runner service tokens. Needed on top
 * of `@RequirePermission`, because PermissionsGuard passes every human session.
 */
@Injectable()
export class AgentRunnerTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      serviceTokenWorkspaceId?: string;
      serviceTokenPermissions?: string[];
    }>();

    if (!request.serviceTokenWorkspaceId || !isExactAgentRunnerPurpose(request.serviceTokenPermissions)) {
      throw new ForbiddenException('This endpoint requires an agent runner token');
    }

    return true;
  }
}
