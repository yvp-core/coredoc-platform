import { CanActivate, type ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';

import { INTENT_CONFIG, configFromEnv, type IntentConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { isIntentEnabled } from '../modules/intent/intent-enabled.guard.js';
import type { AuthenticatedMcpRequest } from './mcp-auth-context.js';

/**
 * Per-workspace gate for the cloud intent MCP tools.
 *
 * WHY A TOOL GUARD. Tool REGISTRATION stays static per process (see the header
 * of `tools/intent.tools.ts`: MCP-Nest's registry is decorator-based and built
 * once). "Is intent enabled for THIS workspace" is a per-request fact, so it is
 * enforced here instead: MCP-Nest evaluates `@ToolGuards([...])` on both `tools/list`
 * (a tool whose guard returns false is omitted from the listing) and
 * `tools/call` (a failing guard makes the call throw an McpError with
 * `ErrorCode.InvalidRequest` and the message
 * `Access denied: insufficient permissions for tool '<name>'`), so a client
 * holding a stale listing still cannot invoke the tool.
 *
 * RETURNS FALSE, NEVER THROWS. MCP-Nest logs a guard exception as a warning on
 * every listing, so a thrown 403 would be noise on every request from every
 * workspace with intent off. Fail closed: no trusted `workspaceId` on the
 * request, or no such workspace → false.
 *
 * The same answer covers an actor outside the TEMPORARY `INTENT_ROLES` list:
 * the tools are hidden from their listing and refused on call.
 */
@Injectable()
export class IntentEnabledToolGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(INTENT_CONFIG) private readonly intent: IntentConfig = configFromEnv().intent,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // `workspaceId` and `userWorkspaceRole` are the trusted context
    // McpRewriteMiddleware attaches after token + membership auth — the same
    // fields BaseCoredocTool and `intent-auth.ts` read.
    const request = context.switchToHttp().getRequest<AuthenticatedMcpRequest>();
    const workspaceId = request?.workspaceId;
    if (!workspaceId) return false;

    return isIntentEnabled(this.prisma, workspaceId, request.userWorkspaceRole, this.intent);
  }
}
