import type { AgentRun } from '../../../stores/agent-run-store';
import type { RunningCommand } from '../../../stores/project-detail-store';

/**
 * A native agent run has no PTY output, so it must replace the terminal while
 * its generate command is active. Legacy generate commands still use the PTY.
 */
export function findAgentRunCommandId(
  repoName: string,
  runningCommands: Map<string, RunningCommand>,
  agentRuns: Map<string, AgentRun>,
): string | null {
  for (const command of runningCommands.values()) {
    if (command.repoName === repoName && command.action === 'generate' && agentRuns.has(command.id)) {
      return command.id;
    }
  }
  return null;
}
