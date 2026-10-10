import type { RunnerStartupProblem, RunnerVersions } from '@coredoc/core/agent-runner';
import type { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { redactSecrets } from './redact-secrets.js';
import { RUNNER_STARTUP_PROBLEM_TEXT, type RunnerSeenAction } from './run-states.js';
import type { RunnerPrincipal } from './turn-lease.js';

/** The width of `agent_runner_seen.refused_reason`. */
const MAX_REFUSED_REASON = 200;

/**
 * Settings show each runner token's last successful claim or heartbeat with
 * its versions, or why it was refused or claims nothing.
 */
export async function recordRunnerSeen(
  prisma: PrismaService,
  runner: RunnerPrincipal,
  action: RunnerSeenAction,
  report: { protocolVersion: number | null; versions: RunnerVersions; refusedReason: string | null },
  at: Date,
): Promise<void> {
  const data = {
    lastSeenAt: at,
    lastAction: action,
    versions: report.versions as Prisma.InputJsonObject,
    refusedReason: report.refusedReason,
  };
  if (report.protocolVersion === null) {
    // Heartbeats carry no protocol version; they refresh the row the turn's claim wrote.
    await prisma.agentRunnerSeen.updateMany({
      where: { serviceTokenId: runner.tokenId, workspaceId: runner.workspaceId },
      data,
    });
    return;
  }
  const seen = { ...data, protocolVersion: report.protocolVersion };
  await prisma.agentRunnerSeen.upsert({
    where: { serviceTokenId: runner.tokenId },
    create: { serviceTokenId: runner.tokenId, workspaceId: runner.workspaceId, ...seen },
    update: seen,
  });
}

/**
 * The server's wording for the code, then the runner's detail with common
 * credential shapes masked, cut to fit `refused_reason`.
 */
export function startupProblemText(report: RunnerStartupProblem): string {
  const text = RUNNER_STARTUP_PROBLEM_TEXT[report.code];
  if (!report.detail) return text;
  const room = MAX_REFUSED_REASON - text.length - 3;
  if (room < 8) return text;
  const detail = redactSecrets(report.detail);
  return `${text} (${detail.length > room ? `${detail.slice(0, room - 1)}…` : detail})`;
}
