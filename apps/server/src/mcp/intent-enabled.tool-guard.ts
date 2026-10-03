import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service.js';
import { isIntentEnabled } from '../modules/intent/intent-enabled.guard.js';

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
 */
@Injectable()
export class IntentEnabledToolGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // `workspaceId` is the trusted context McpRewriteMiddleware attaches after
    // token + membership auth — the same field BaseCoredocTool reads.
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const workspaceId = request?.workspaceId as string | undefined;
    if (!workspaceId) return false;

    return isIntentEnabled(this.prisma, workspaceId);
  }
}
