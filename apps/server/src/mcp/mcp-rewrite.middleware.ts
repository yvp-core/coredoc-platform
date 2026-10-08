/**
 * MCP Rewrite + Auth Middleware
 *
 * Runs before MCP-Nest's generated controllers. Handles two request shapes:
 *
 * A. Workspace-scoped path (back-compat, unchanged behavior):
 *    1. URL rewrite: /api/v1/workspaces/:id/mcp → /mcp
 *    2. Authentication: Bearer JWT (self-hosted OAuth server) or cdt_ service tokens
 *    3. Workspace membership validation
 *
 * B. Direct root path (workspace-agnostic): /mcp, /sse, /messages hit with a
 *    bearer token but no workspace in the URL. Same auth stack, then the
 *    workspace is resolved server-side:
 *    - cdt_ service tokens are workspace-bound: their workspaceId wins. An
 *      X-Coredoc-Workspace header that contradicts it is a 403, never a
 *      silent override.
 *    - User JWTs: exactly one accessible workspace → auto-select. Multiple →
 *      an X-Coredoc-Workspace header (workspace id or slug) must pick one;
 *      missing → 400 listing the accessible workspaces (fail fast, never
 *      guess). Zero accessible workspaces → 403.
 *
 * Both shapes attach the trusted context (`req.user`, `req.workspaceId`,
 * `req.userWorkspaceRole`, `req.mcpAuthKind` and — for a service token —
 * `req.serviceTokenPermissions`) only after auth succeeds; McpTrustedContextGuard
 * remains the route-level enforcement point that no request reaches tool
 * execution without that server-set context. `mcpAuthKind` is what lets a tool
 * tell a human session from a machine identity: a service token authenticates
 * AS the user who created it, so its principal and role are indistinguishable
 * from that user's own by any other means.
 *
 * Every 401 leaves through `unauthorized()` so it carries the RFC 9728
 * challenge — see that method for why a bare 401 wedges MCP clients.
 *
 * Auth is done here (not via MCP-Nest guards) because the dynamically
 * generated controller lives in MCP-Nest's module scope, which may not
 * resolve our guard's dependencies (AuthService from AuthModule).
 */

import { Injectable, type NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';
import { AuthService } from '../auth/auth.service.js';
import { isExactAgentRunnerPurpose, isExactTelemetryPurpose } from '../auth/token-permissions.js';
import { ControlPlaneService } from '../database/control-plane.service.js';
import { serverUrl } from '../auth/oauth/server-url.js';
import { McpAuthKind, type AuthenticatedMcpRequest } from './mcp-auth-context.js';
import { McpToolset, mcpToolsetContext, parseToolsetParam } from './mcp-toolset.js';

/**
 * Exact-purpose machine tokens never reach MCP: telemetry tokens are write-only
 * ingest credentials, runner tokens work only on the agent runner API.
 */
function exactPurposeRefusal(permissions: readonly string[]): string | null {
  if (isExactTelemetryPurpose(permissions)) return 'Telemetry tokens may access only telemetry ingestion endpoints';
  if (isExactAgentRunnerPurpose(permissions)) return 'Agent runner tokens may access only the agent runner API';
  return null;
}

/** Header a client sets to pick one of several accessible workspaces. */
export const WORKSPACE_HEADER = 'x-coredoc-workspace';

// Anchored: `/mcp` must be followed by a subpath, a query string, or the end
// of the URL, so sibling routes like /workspaces/:id/mcp-config never match.
const WORKSPACE_PATH_RE = /^\/api\/v1\/workspaces\/([^/]+)\/mcp(\/[^?]*)?(?:\?.*)?$/;
// Root-mounted MCP transport paths (Streamable HTTP + SSE). Anchored so
// unrelated root routes (/.well-known/*, /authorize, /token, ...) never match.
const DIRECT_PATH_RE = /^\/(?:mcp|sse|messages)\/?(?:\?|$)/;

/**
 * True when the URL is an MCP transport request this middleware must handle —
 * either the workspace-scoped API path or a direct root transport path.
 * Shared with main.ts so the Express-level matcher and the middleware's own
 * dispatch can never drift apart.
 */
export function isMcpRequestPath(url: string): boolean {
  return WORKSPACE_PATH_RE.test(url) || DIRECT_PATH_RE.test(url);
}

@Injectable()
export class McpRewriteMiddleware implements NestMiddleware {
  private readonly logger = new Logger(McpRewriteMiddleware.name);

  constructor(
    private readonly authService: AuthService,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const match = req.originalUrl.match(WORKSPACE_PATH_RE);
    if (!match && !DIRECT_PATH_RE.test(req.originalUrl)) {
      return next();
    }

    const param = parseToolsetParam(req.originalUrl);
    if (!param.ok) {
      res.status(400).json({ error: param.error, validToolsets: Object.values(McpToolset) });
      return;
    }
    const { toolset } = param;
    // The request body is already parsed (main.ts), so the rest of the request
    // runs inside this context; see mcp-toolset.ts.
    const proceed: NextFunction = toolset === undefined ? next : () => mcpToolsetContext.run(toolset, next);

    if (match) {
      return this.handleWorkspacePath(req, res, proceed, match);
    }
    return this.handleDirectPath(req, res, proceed);
  }

  /**
   * Workspace-scoped path: /api/v1/workspaces/:id/mcp[/(sse|messages)].
   * Behavior is byte-identical to the pre-direct-path middleware.
   */
  private async handleWorkspacePath(req: Request, res: Response, next: NextFunction, match: RegExpMatchArray) {
    // Step 1: URL rewrite — extract workspaceId and rewrite to internal path
    // /api/v1/workspaces/:id/mcp      → /mcp       (Streamable HTTP)
    // /api/v1/workspaces/:id/mcp/sse  → /sse       (SSE transport)
    // /api/v1/workspaces/:id/mcp/messages → /messages (SSE messages)
    const workspaceId = match[1]!;
    const subpath = match[2] || '';
    const trusted = req as AuthenticatedMcpRequest;
    trusted.workspaceId = workspaceId;
    req.url = subpath || '/mcp';

    // Step 2: Authenticate
    const token = this.extractBearer(req, res);
    if (token === undefined) return;

    let user: AuthUser;
    let authKind: McpAuthKind = McpAuthKind.Jwt;
    let serviceTokenPermissions: string[] | undefined;

    try {
      if (token.startsWith('cdt_')) {
        // Service token — SHA-256 hash lookup
        const serviceToken = await this.lookupServiceToken(token);
        if (!serviceToken) {
          this.unauthorized(res, 'Invalid or expired service token', true);
          return;
        }
        const refusal = exactPurposeRefusal(serviceToken.permissions);
        if (refusal) {
          res.status(403).json({ error: refusal });
          return;
        }
        // Enforce workspace scope
        if (serviceToken.workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Service token is not authorized for this workspace' });
          return;
        }
        user = { id: serviceToken.createdBy, email: `service-token:${serviceToken.name}` };
        authKind = McpAuthKind.ServiceToken;
        serviceTokenPermissions = [...serviceToken.permissions];
      } else {
        // JWT — verify the access token issued by our OAuth server (HS256)
        user = await this.authService.verifyAccessToken(token);
      }
    } catch (error) {
      this.logger.warn(`MCP auth failed: ${error instanceof Error ? error.message : error}`);
      this.unauthorized(res, 'Invalid or expired access token', true);
      return;
    }

    // Step 3: Authorize workspace membership
    const member = await this.controlPlane.getMember(workspaceId, user.id);
    if (!member) {
      res.status(403).json({ error: 'Workspace membership required' });
      return;
    }

    // Attach user context for downstream tools
    trusted.user = user;
    trusted.userWorkspaceRole = member.role;
    trusted.mcpAuthKind = authKind;
    if (serviceTokenPermissions) trusted.serviceTokenPermissions = serviceTokenPermissions;

    next();
  }

  /**
   * Direct root path: /mcp, /sse, /messages with no workspace in the URL.
   * Authenticates with the same token stack, then resolves the workspace
   * server-side (service-token binding, or the user's memberships plus the
   * optional X-Coredoc-Workspace header). No URL rewrite needed — the request
   * already targets the root-mounted transport.
   */
  private async handleDirectPath(req: Request, res: Response, next: NextFunction) {
    const trusted = req as AuthenticatedMcpRequest;
    const token = this.extractBearer(req, res);
    if (token === undefined) return;

    const requestedRaw = req.headers[WORKSPACE_HEADER];
    const requested = typeof requestedRaw === 'string' ? requestedRaw.trim() : undefined;

    if (token.startsWith('cdt_')) {
      // Service token — workspace-bound: the token's workspace is the scope.
      let serviceToken;
      try {
        serviceToken = await this.lookupServiceToken(token);
      } catch (error) {
        this.logger.warn(`MCP auth failed: ${error instanceof Error ? error.message : error}`);
        this.unauthorized(res, 'Invalid or expired access token', true);
        return;
      }
      if (!serviceToken) {
        this.unauthorized(res, 'Invalid or expired service token', true);
        return;
      }
      const refusal = exactPurposeRefusal(serviceToken.permissions);
      if (refusal) {
        res.status(403).json({ error: refusal });
        return;
      }

      const workspaceId = serviceToken.workspaceId;

      // A workspace header may confirm the binding (by id or slug) but never
      // change it — a contradiction is a hard 403, not a silent override.
      if (requested && requested !== workspaceId) {
        const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
        const slugMatches = workspace && requested.toLowerCase() === workspace.slug.toLowerCase();
        if (!slugMatches) {
          res.status(403).json({ error: 'Service token is not authorized for this workspace' });
          return;
        }
      }

      const user: AuthUser = { id: serviceToken.createdBy, email: `service-token:${serviceToken.name}` };

      // Same membership requirement as the workspace-scoped path.
      const member = await this.controlPlane.getMember(workspaceId, user.id);
      if (!member) {
        res.status(403).json({ error: 'Workspace membership required' });
        return;
      }

      trusted.workspaceId = workspaceId;
      trusted.user = user;
      trusted.userWorkspaceRole = member.role;
      trusted.mcpAuthKind = McpAuthKind.ServiceToken;
      trusted.serviceTokenPermissions = [...serviceToken.permissions];
      return next();
    }

    // User JWT
    let user: AuthUser;
    try {
      user = await this.authService.verifyAccessToken(token);
    } catch (error) {
      this.logger.warn(`MCP auth failed: ${error instanceof Error ? error.message : error}`);
      this.unauthorized(res, 'Invalid or expired access token', true);
      return;
    }

    // Membership list doubles as the membership check: only workspaces the
    // user belongs to are selectable, so whatever gets picked is authorized.
    const workspaces = await this.controlPlane.listWorkspacesForUser(user.id);

    if (workspaces.length === 0) {
      res.status(403).json({ error: 'No accessible workspaces for this user' });
      return;
    }

    let selected: (typeof workspaces)[number];

    if (requested) {
      const matches = workspaces.filter((w) => w.id === requested || w.slug.toLowerCase() === requested.toLowerCase());
      if (matches.length === 0) {
        res.status(403).json({ error: `Not a member of workspace '${requested}'` });
        return;
      }
      if (matches.length > 1) {
        res.status(400).json({
          error:
            `The ${WORKSPACE_HEADER} header value '${requested}' matches more than one accessible workspace. ` +
            `Set it to a workspace id instead.`,
          accessibleWorkspaces: matches.map((w) => ({ id: w.id, slug: w.slug, name: w.name })),
        });
        return;
      }
      selected = matches[0]!;
    } else if (workspaces.length === 1) {
      selected = workspaces[0]!;
    } else {
      res.status(400).json({
        error:
          `Multiple workspaces are accessible with this token. ` +
          `Set the ${WORKSPACE_HEADER} header to one of the listed workspace ids (or slugs) and reconnect.`,
        accessibleWorkspaces: workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name })),
      });
      return;
    }

    trusted.workspaceId = selected.id;
    trusted.user = user;
    trusted.userWorkspaceRole = selected.role;
    trusted.mcpAuthKind = McpAuthKind.Jwt;
    next();
  }

  /**
   * End the response with a 401 that always carries the RFC 9728 challenge.
   *
   * The challenge is load-bearing, not decorative: it is the only signal that
   * tells an MCP client to discard the token it holds and re-run the OAuth
   * flow. When only the no-token branch sent it, a client holding an expired
   * or foreign token saw a bare 401 forever and never re-authenticated — it
   * had nothing to distinguish "your token is dead" from "you are not allowed
   * here". Access tokens expire daily (OAUTH_ACCESS_TTL), so every client
   * reaches this branch routinely.
   *
   * `error="invalid_token"` (RFC 6750 §3.1) is sent only when credentials were
   * actually presented — a missing header is not an invalid token.
   *
   * 403s deliberately get no challenge: a membership or workspace-scope
   * failure is not fixable by minting a new token, so challenging would send
   * the user through login to no effect.
   */
  private unauthorized(res: Response, error: string, credentialsPresented: boolean): void {
    const params = credentialsPresented ? ['error="invalid_token"'] : [];
    params.push(`resource_metadata="${serverUrl()}/.well-known/oauth-protected-resource"`);
    res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    res.status(401).json({ error });
  }

  /**
   * Extract the Bearer token, or end the response with the OAuth-discovery
   * 401 (WWW-Authenticate → protected-resource metadata) and return undefined.
   */
  private extractBearer(req: Request, res: Response): string | undefined {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      this.unauthorized(res, 'Missing or invalid Authorization header', false);
      return undefined;
    }
    return authHeader.slice(7);
  }

  private async lookupServiceToken(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.controlPlane.getServiceTokenByHash(tokenHash);
  }
}
