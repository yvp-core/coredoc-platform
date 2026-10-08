/**
 * The closed set of run failure codes (SF-001 Data model), each with the
 * plain-words message the run page and the Jira failure comment show.
 */
export const FAILURE_MESSAGES = {
  invalid_repository_label: 'A repository label names no eligible workspace repository.',
  too_many_repositories: 'More repositories were named than the run’s cap allows.',
  issue_not_readable: 'The Jira issue could not be read through the workspace’s Jira connector.',
  run_owner_removed: 'The member this run acts as is no longer in the workspace.',
  connector_inactive: 'The workspace’s Jira or GitHub connector is missing or paused.',
  plugin_missing: 'The workflow plugin or its skills did not load in the runner.',
  agent_error: 'The model or Claude Code failed: authentication, unavailable after retries, or crashed.',
  session_mismatch: 'Claude Code reported a different session than the run expects.',
  repository_not_eligible:
    'A repository cannot be used: no durable key, a remote outside the GitHub connector, not readable with the bot’s token, or the bot is an admin or maintainer there.',
  branch_exists: 'The run branch already exists on the remote and this run did not create it.',
  push_rejected: 'Someone else pushed to the run branch during the turn.',
  secret_scan_blocked: 'The secret scan blocked the push twice.',
  no_outcome: 'The agent stopped twice in a row without finishing.',
  budget_exhausted: 'The run reached its spend limit.',
  wall_clock_exceeded: 'The run’s active time reached its limit.',
  waiting_expired: 'Nobody answered or reviewed within the waiting limit.',
  no_changes: 'The agent finished without changing any repository.',
  github_error: 'GitHub refused a request or kept failing while the agent worked.',
  jira_error: 'Jira kept failing while the PRD was being read.',
  archive_too_large: 'The agent’s saved session grew beyond the allowed size.',
  report_limit_exceeded: 'The runner sent more events, proposals or questions than a turn allows.',
  delivery_failed: 'Opening or verifying the pull requests, or posting the Jira done comment, failed.',
  runner_lost: 'The agent runner stopped responding during the same turn three times.',
} as const;

export type FailureCode = keyof typeof FAILURE_MESSAGES;
