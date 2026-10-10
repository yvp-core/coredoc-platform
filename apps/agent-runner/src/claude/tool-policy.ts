/** Hygiene and plugin-contract fallbacks, not containment: the pod is the boundary. */

export type ToolVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string };

export const DENIED_TOOLS: ReadonlySet<string> = new Set([
  'WebSearch',
  'WebFetch',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
]);

/** The runner owns git delivery until the plugin's hosted mode leaves it to the host; git reads pass. */
const GIT_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|pull|fetch|merge|rebase|checkout|switch|reset|restore|tag|am|cherry-pick|revert|stash|clone|worktree|remote|branch\s+-[dDmMcC])\b/;
const GH_WRITE = /\bgh\s+(?:pr|repo|release|api)\b/;

const RUNNER_OWNS_GIT =
  'The runner commits, pushes and opens pull requests after your turn; do not run git writes, network git or gh. Leave your changes in the work tree.';

export function evaluateToolUse(toolName: string, input: Record<string, unknown>): ToolVerdict {
  if (DENIED_TOOLS.has(toolName)) {
    return { decision: 'deny', reason: `${toolName} is not available in agent runs.` };
  }
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (GIT_WRITE.test(command) || GH_WRITE.test(command)) return { decision: 'deny', reason: RUNNER_OWNS_GIT };
  }
  return { decision: 'allow' };
}
