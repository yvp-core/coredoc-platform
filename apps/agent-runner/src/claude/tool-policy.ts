/**
 * The runner's tool policy, applied by a pre-tool hook before Claude Code's
 * own automatic approvals. Small and explicit: the pod is the boundary, so
 * this is hygiene and plugin-contract fallbacks, not containment.
 */

export type ToolVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** Web tools, worktrees and scheduling have no place in a runner turn. */
const DENIED_TOOLS = new Set([
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

/**
 * Plugin contract item 4 fallback: until the plugin's hosted mode leaves git
 * delivery to the host, git writes, network git and `gh` pull request or
 * repository commands are refused. Reads (status, diff, log, show) pass.
 */
const GIT_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|pull|fetch|merge|rebase|checkout|switch|reset|restore|tag|am|cherry-pick|revert|stash|clone|worktree|remote|branch\s+-[dDmMcC])\b/;
const GH_WRITE = /\bgh\s+(?:pr|repo|release|api)\b/;

const RUNNER_OWNS_GIT =
  'The runner commits, pushes and opens pull requests after your turn; do not run git writes, network git or gh. Leave your changes in the work tree.';

/**
 * Placeholder until questions are bridged to people (SF-001 ticket 05): no
 * one can answer in this turn, so the agent decides and records the decision.
 */
const NO_QUESTIONS_YET =
  'No one is available to answer. Choose the option you judge best, continue, and list this decision in the assumptions of your next propose_scope call.';

export function evaluateToolUse(toolName: string, input: Record<string, unknown>): ToolVerdict {
  if (DENIED_TOOLS.has(toolName)) {
    return { decision: 'deny', reason: `${toolName} is not available in agent runs.` };
  }
  if (toolName === 'AskUserQuestion') return { decision: 'deny', reason: NO_QUESTIONS_YET };
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (GIT_WRITE.test(command) || GH_WRITE.test(command)) return { decision: 'deny', reason: RUNNER_OWNS_GIT };
  }
  return { decision: 'allow' };
}
