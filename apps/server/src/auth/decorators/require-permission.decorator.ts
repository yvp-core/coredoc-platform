import { SetMetadata } from '@nestjs/common';
import { TokenPermission } from '../token-permissions.js';

export const PERMISSION_KEY = 'requiredPermissions';

/**
 * Decorator to require specific permissions for a route.
 * Service tokens are checked against their permissions[] array.
 * User (JWT) sessions bypass permission checks — they have full access.
 *
 * @example @RequirePermission(TokenPermission.ParserRead)
 * @example @RequirePermission(TokenPermission.RepoPush, TokenPermission.ParserRead)
 */
export const RequirePermission = (...permissions: TokenPermission[]) => SetMetadata(PERMISSION_KEY, permissions);
