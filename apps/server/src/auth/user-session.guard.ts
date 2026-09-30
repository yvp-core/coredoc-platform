import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from './decorators/current-user.decorator.js';

/**
 * Restricts a route to an authenticated USER session — a JWT bearer or a
 * session cookie — and refuses every service token (cdt_), whatever role or
 * permissions it carries.
 *
 * Structural, not role-based, on purpose: `AuthGuard` resolves a service token
 * to the user who CREATED it, so an owner-created CI token already satisfies
 * `@WorkspaceRole('admin')` and `PermissionsGuard` (which passes every non-
 * service-token request through). Role checks therefore cannot express "a human
 * must be at the keyboard". The presence of `serviceTokenWorkspaceId` — set by
 * AuthGuard only for cdt_ tokens, and unforgeable from outside — can.
 *
 * Used for actions that must never have a machine-only path: intent review,
 * tree CRUD and anchor writes (an agent performs them in-session on the user's
 * behalf), self-service telemetry-token minting, and human-only reads.
 *
 * Compose it after AuthGuard, house style:
 *   `@UseGuards(AuthGuard, WorkspaceRoleGuard, UserSessionGuard)`
 * A missing `request.user` means the guard was wired without AuthGuard in front
 * of it — refused rather than silently passed.
 */
@Injectable()
export class UserSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: AuthUser;
      serviceTokenWorkspaceId?: string;
    }>();

    if (request.serviceTokenWorkspaceId) {
      throw new ForbiddenException('This endpoint requires a user session, not a service token');
    }
    if (!request.user) {
      throw new ForbiddenException('This endpoint requires an authenticated user session');
    }
    return true;
  }
}
