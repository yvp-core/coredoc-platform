/**
 * Trusted MCP request context.
 *
 * `McpRewriteMiddleware` is the only writer of these properties, and it writes
 * them only after token verification and workspace-membership checks pass;
 * `McpTrustedContextGuard` refuses any request that reaches a tool without
 * them. Tools therefore read them as server-set facts, never as client input.
 */

import type { Request } from 'express';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';

/**
 * How an MCP transport request authenticated.
 *
 * Two kinds only: the MCP transport accepts Bearer credentials exclusively (a
 * browser session credential confers no MCP access — enforced by an invariant
 * test on the middleware), so the REST-side third kind has no counterpart here.
 */
export enum McpAuthKind {
  /** A user's OAuth access token — a human session driving an agent. */
  Jwt = 'jwt',
  /** A `cdt_` service token — a machine identity, never a human decision. */
  ServiceToken = 'service',
}

/** Express request carrying the trusted context the MCP middleware attaches. */
export type AuthenticatedMcpRequest = Request & {
  workspaceId?: string;
  user?: AuthUser;
  /** The principal's role in `workspaceId`. For a service token this is its CREATOR's role. */
  userWorkspaceRole?: string;
  mcpAuthKind?: McpAuthKind;
  /** Present only for `McpAuthKind.ServiceToken`. */
  serviceTokenPermissions?: string[];
};
