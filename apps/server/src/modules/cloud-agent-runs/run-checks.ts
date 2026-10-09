/**
 * Run-level conditions re-checked before an agent turn is handed out; a run
 * that no longer meets one fails with its code instead of getting the turn.
 */
import type { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import { activeGithubConnectors } from '../../libs/github/github-repository-resolver.service.js';
import { RunCheckFailure } from './cloud-agent-run-implement.service.js';
import { RunFailureCode } from './run-states.js';

/** The run owner is still a member, and the GitHub connector the run's repositories need is active. */
export async function checkRunOwnerAndConnectors(prisma: PrismaService, run: CloudAgentRun): Promise<void> {
  const [owner, github] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: run.runOwnerId } },
      select: { pending: true },
    }),
    prisma.deliveryConnector.count({ where: activeGithubConnectors(run.workspaceId) }),
  ]);
  if (!owner || owner.pending) {
    throw new RunCheckFailure(RunFailureCode.RunOwnerRemoved, 'The member this run acts as left the workspace.');
  }
  if (github === 0) {
    throw new RunCheckFailure(RunFailureCode.ConnectorInactive, 'The workspace has no active GitHub connector.');
  }
}
