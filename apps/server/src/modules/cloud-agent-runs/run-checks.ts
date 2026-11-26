import { roleAllows } from '../../auth/iam.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import { activeGithubConnectors } from '../../libs/github/github-repository-resolver.service.js';
import { RunCheckFailure } from './cloud-agent-run-implement.service.js';
import { RunFailureCode } from './run-states.js';

/** A member's pending flag and workspace role (its binding on the workspace). */
export const RUN_OWNER_FIELDS = {
  pending: true,
  bindings: { where: { resourceType: 'workspace' }, select: { role: true } },
} as const;

export function runOwnerOf(member: { pending: boolean; bindings: { role: string }[] } | null) {
  return member && { pending: member.pending, role: member.bindings[0]?.role };
}

/**
 * A run acts as its owner, MCP included: a current member whose role reads the workspace.
 * Anyone else, a consultant among them, counts as a removed owner.
 */
export function canActAsRunOwner(member: { pending: boolean; role?: string } | null | undefined): boolean {
  return Boolean(member && !member.pending && roleAllows(member.role, 'workspace.read'));
}

export async function checkRunOwnerAndConnectors(prisma: PrismaService, run: CloudAgentRun): Promise<void> {
  const [owner, github] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: run.runOwnerId } },
      select: RUN_OWNER_FIELDS,
    }),
    prisma.deliveryConnector.count({ where: activeGithubConnectors(run.workspaceId) }),
  ]);
  if (!canActAsRunOwner(runOwnerOf(owner))) {
    throw new RunCheckFailure(
      RunFailureCode.RunOwnerRemoved,
      'The member this run acts as left the workspace or can no longer read it.',
    );
  }
  if (github === 0) {
    throw new RunCheckFailure(RunFailureCode.ConnectorInactive, 'The workspace has no active GitHub connector.');
  }
}
