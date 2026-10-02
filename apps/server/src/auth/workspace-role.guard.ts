import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WORKSPACE_ROLE_KEY } from './decorators/workspace-role.decorator.js';
import type { AuthUser } from './decorators/current-user.decorator.js';
import { ControlPlaneService } from '../database/control-plane.service.js';

const ROLE_HIERARCHY: Record<string, number> = {
  member: 1,
  // Same rank as member: the role differs only in what the intent UI offers it.
  product: 1,
  admin: 2,
  owner: 3,
};

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRole = this.reflector.getAllAndOverride<string | undefined>(WORKSPACE_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<{
      user?: AuthUser;
      params: { workspaceId?: string };
      userWorkspaceRole?: string;
      serviceTokenWorkspaceId?: string;
    }>();

    // Service tokens are workspace-scoped — block them from endpoints without @WorkspaceRole
    // (e.g., GET /workspaces, POST /workspaces) to prevent account-level operations
    if (!requiredRole) {
      if (request.serviceTokenWorkspaceId) {
        throw new ForbiddenException('Service tokens cannot access non-workspace-scoped endpoints');
      }
      return true;
    }

    const { user, params } = request;
    if (!user || !params.workspaceId) {
      throw new ForbiddenException('Workspace membership required');
    }

    // Service tokens are constrained to their workspace — reject cross-workspace usage
    if (request.serviceTokenWorkspaceId && request.serviceTokenWorkspaceId !== params.workspaceId) {
      throw new ForbiddenException('Service token is not authorized for this workspace');
    }

    // Look up the user's role in this workspace from the control plane DB
    const member = await this.controlPlane.getMember(params.workspaceId, user.id);
    if (!member) {
      throw new ForbiddenException('Workspace membership required');
    }

    // Set userWorkspaceRole on request for downstream use
    request.userWorkspaceRole = member.role;

    const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 0;
    const userLevel = ROLE_HIERARCHY[member.role] ?? 0;

    if (userLevel < requiredLevel) {
      throw new ForbiddenException(`Requires ${requiredRole} role, you have ${member.role}`);
    }

    return true;
  }
}
