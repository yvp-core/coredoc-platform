/**
 * Permissions Guard
 *
 * Enforces granular permissions on service tokens (cdt_ prefix).
 * User (JWT) sessions are not restricted — they already have role-based access.
 *
 * Works with @RequirePermission() decorator:
 *   - If no decorator is present, the guard passes through.
 *   - If the request came from a user session, the guard passes through.
 *   - If the request came from a service token, the guard checks that
 *     token.permissions includes ALL required permissions.
 */

import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './decorators/require-permission.decorator.js';
import { isWildcardExemptPermission, PERMISSION_WILDCARD } from './token-permissions.js';

export {
  TokenPermission,
  CI_TOKEN_PERMISSIONS,
  INTENT_AGENT_TOKEN_PERMISSIONS,
  TELEMETRY_TOKEN_PERMISSIONS,
  AGENT_RUNNER_TOKEN_PERMISSIONS,
} from './token-permissions.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermission decorator — pass through
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      serviceTokenWorkspaceId?: string;
      serviceTokenPermissions?: string[];
    }>();

    // User (JWT) sessions bypass permission checks — they have full access via roles
    if (!request.serviceTokenWorkspaceId) {
      return true;
    }

    // Service token — check permissions
    const tokenPermissions = request.serviceTokenPermissions ?? [];

    // Wildcard grants every permission EXCEPT the wildcard-exempt ones (intent
    // scopes): a legacy grant-all token predates them and was never reviewed
    // for product-authority access, so those must be listed explicitly on the
    // token. See WILDCARD_EXEMPT_PERMISSIONS for the full rationale.
    if (tokenPermissions.includes(PERMISSION_WILDCARD)) {
      const exempt = required.filter((p) => isWildcardExemptPermission(p) && !tokenPermissions.includes(p));
      if (exempt.length === 0) {
        return true;
      }
      throw new ForbiddenException(
        `Service token missing required permission(s): ${exempt.join(', ')} ` +
          `(the '${PERMISSION_WILDCARD}' wildcard does not grant them)`,
      );
    }

    const missing = required.filter((p) => !tokenPermissions.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Service token missing required permission(s): ${missing.join(', ')}`);
    }

    return true;
  }
}
