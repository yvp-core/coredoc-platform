import { CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';

/** The one "is intent on for this workspace" read; a missing workspace answers false. */
export async function isIntentEnabled(prisma: Pick<PrismaService, 'workspace'>, workspaceId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { intentEnabled: true },
  });
  return workspace?.intentEnabled === true;
}

/**
 * REST counterpart of `IntentEnabledToolGuard` (`mcp/intent-enabled.tool-guard.ts`):
 * refuses every intent REST route — reads and writes alike — for a workspace
 * with `intentEnabled = false`, with the same `intent_disabled` code the CI
 * deploy path already answers by name (`intent-handoff-processor.service.ts`).
 *
 * THROWS, UNLIKE THE MCP GUARD. The MCP guard returns false so a stale tool
 * listing still fails closed without logging noise on every call. REST has no
 * such listing to hide behind: a caller needs the `{code, message, path}` body
 * to tell "intent is off" from an ordinary 403/404, so this guard throws the
 * same `IntentPublicException` the rest of the module uses, caught by each
 * controller's `IntentExceptionFilter`.
 *
 * Composed after `AuthGuard`/`WorkspaceRoleGuard`, so `params.workspaceId` is
 * already known to be a workspace the caller may address.
 */
@Injectable()
export class IntentEnabledGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ params: { workspaceId?: string } }>();
    const workspaceId = request.params?.workspaceId;
    if (!workspaceId) return true; // no workspace to check — a later guard/handler owns that refusal

    if (!(await isIntentEnabled(this.prisma, workspaceId))) {
      throw intentStateError(
        IntentErrorCode.IntentDisabled,
        'Intent is not enabled for this workspace',
        [],
        HttpStatus.CONFLICT,
      );
    }
    return true;
  }
}
