/**
 * MCP Trusted-Context Guard
 *
 * Auth gate for the MCP transport controllers, applied via mcp-nest's `guards`
 * option so it runs on EVERY transport route handler (Streamable HTTP
 * POST/GET/DELETE and SSE sse/messages).
 *
 * Why this exists: token + workspace-membership auth is performed by
 * `McpRewriteMiddleware`, which only runs for `/api/v1/workspaces/:id/mcp...`
 * requests. The mcp-nest controllers, however, are mounted at the ROOT paths
 * `/mcp`, `/sse`, `/messages` (excluded from the global `/api/v1` prefix so the
 * rewrite can reach them after rewriting `req.url`). A request sent directly to
 * those root paths never traverses the rewrite middleware, so without this
 * guard it would reach tool execution unauthenticated.
 *
 * This guard closes that direct-path bypass. It runs at the resolved route —
 * immune to the URL casing/normalisation tricks an Express path match would
 * miss — and rejects any request that does not carry the trusted context the
 * rewrite middleware attaches only on successful auth (`req.user` +
 * `req.workspaceId`). Both are server-set properties an external caller cannot
 * forge.
 *
 * It has NO injected dependencies on purpose: the dynamically generated
 * controller lives in mcp-nest's module scope, which cannot resolve
 * AuthModule's providers, so a dependency-free check is the only kind
 * guaranteed to instantiate there. Heavy auth stays in the middleware; this is
 * the route-level enforcement that the middleware alone cannot provide.
 */

import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';
import { serverUrl } from '../auth/oauth/server-url.js';

@Injectable()
export class McpTrustedContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser; workspaceId?: string }>();

    // Both are set together by McpRewriteMiddleware, and only after token
    // verification and membership checks pass. Their presence proves the
    // request arrived through the authenticated workspace path.
    if (request.user && request.workspaceId) {
      return true;
    }

    const response = context.switchToHttp().getResponse<Response>();
    const base = serverUrl();
    response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    throw new UnauthorizedException('MCP endpoints require workspace-scoped authentication');
  }
}
