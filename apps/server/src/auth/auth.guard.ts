import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './decorators/current-user.decorator.js';
import { PERMISSION_KEY } from './decorators/require-permission.decorator.js';
import { isExactTelemetryPurpose, TokenPermission } from './token-permissions.js';
import { AuthService } from './auth.service.js';
import { ControlPlaneService } from '../database/control-plane.service.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE, SESSION_COOKIE } from './web/web-auth.constants.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type AuthRequest = Request & {
  user?: AuthUser;
  /** Set for `cdt_` tokens only: the token's own id, so audit rows can name the machine, not its creator. */
  serviceTokenId?: string;
  serviceTokenWorkspaceId?: string;
  serviceTokenPermissions?: string[];
  authVia?: 'bearer' | 'cookie';
  cookies?: Record<string, string>;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly authService: AuthService,
    private readonly controlPlane: ControlPlaneService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const authHeader = request.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      if (token.startsWith('cdt_')) {
        // Service token — resolve via SHA-256 hash lookup
        request.user = await this.resolveServiceToken(token, request);
        this.enforceExactTelemetryPurpose(context, request);
        request.authVia = 'bearer';
        return true;
      }

      try {
        request.user = await this.authService.verifyAccessToken(token);
        request.authVia = 'bearer';
        return true;
      } catch (error) {
        this.logger.warn(`Token verification failed: ${error instanceof Error ? error.message : error}`);
        throw new UnauthorizedException('Invalid or expired access token');
      }
    }

    const sessionCookie = request.cookies?.[SESSION_COOKIE];
    if (sessionCookie) {
      return this.activateFromCookie(sessionCookie, request);
    }

    throw new UnauthorizedException('Missing credentials: provide a Bearer token or session cookie');
  }

  private enforceExactTelemetryPurpose(context: ExecutionContext, request: AuthRequest): void {
    const permissions = request.serviceTokenPermissions ?? [];
    if (!isExactTelemetryPurpose(permissions)) return;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.includes(TokenPermission.TelemetryWrite)) {
      throw new ForbiddenException('Telemetry tokens may access only telemetry ingestion endpoints');
    }
  }

  private async activateFromCookie(sessionCookie: string, request: AuthRequest): Promise<boolean> {
    try {
      request.user = await this.authService.verifyAccessToken(sessionCookie);
    } catch (error) {
      this.logger.warn(`Session cookie verification failed: ${error instanceof Error ? error.message : error}`);
      throw new UnauthorizedException('Invalid or expired session');
    }

    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new ForbiddenException('Missing CSRF header');
    }

    request.authVia = 'cookie';
    return true;
  }

  private async resolveServiceToken(token: string, request: AuthRequest): Promise<AuthUser> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const serviceToken = await this.controlPlane.getServiceTokenByHash(tokenHash);

    if (!serviceToken) {
      throw new UnauthorizedException('Invalid or expired service token');
    }

    // Store the workspace ID and permissions from the service token for downstream guards
    request.serviceTokenId = serviceToken.id;
    request.serviceTokenWorkspaceId = serviceToken.workspaceId;
    request.serviceTokenPermissions = serviceToken.permissions;

    // Service tokens authenticate as the user who created them. Resolve that
    // user's REAL email from their workspace membership so downstream OTel
    // attribution (agent_sessions.user_email) and per-user dashboards show the
    // person, not `service-token:otel`. One extra lookup per service-token
    // request is fine — this path already hit the DB for the token.
    const member = await this.controlPlane.getMember(serviceToken.workspaceId, serviceToken.createdBy);
    return {
      id: serviceToken.createdBy,
      // Fallback: the creating member was removed (no membership row/email left).
      // Keep the synthetic `service-token:<name>` marker so the principal is
      // still identifiable rather than blank — never a silent empty email.
      email: member?.email ?? `service-token:${serviceToken.name}`,
    };
  }
}
