import { Card, CardBody, CardHead } from '@/components/ui/card';

import type { AgentRunDetail, AgentRunJiraComment } from './types';

const STATE_LABEL = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const;

const TRANSITION_TEXT: Record<string, string> = {
  transitioned: 'Issue moved to the done status',
  already_in_status: 'Issue was already in the done status',
  not_configured: 'No done status is configured',
  skipped: 'Issue left unchanged',
};

function commentLine(kind: 'Done' | 'Failure', comment: AgentRunJiraComment | undefined): string | null {
  if (!comment) return null;
  switch (comment.state) {
    case 'posted':
      return `${kind} comment posted on Jira`;
    case 'skipped':
      return `${kind} comment skipped: ${comment.reason ?? 'the issue moved out of the configured projects'}`;
    case 'not_posted':
      return `${kind} comment not posted on Jira: ${comment.reason ?? 'Jira kept failing.'}`;
    default:
      return comment.attempts > 0
        ? `${kind} comment pending (attempt ${comment.attempts + 1})`
        : `${kind} comment pending`;
  }
}

/**
 * The verified draft pull requests, in merge order, and what the run told
 * Jira. Every value here comes from the server's own GitHub read and Jira
 * calls, not from the runner.
 */
export function RunPullRequests({ run }: { run: AgentRunDetail }) {
  const pulls = run.pullRequests ?? [];
  const outcome = run.jiraOutcome ?? {};
  const lines = [
    commentLine('Done', outcome.done),
    outcome.transition
      ? outcome.transition.outcome === 'warning'
        ? `Transition warning: ${outcome.transition.reason ?? 'the issue could not be moved.'}`
        : (TRANSITION_TEXT[outcome.transition.outcome] ?? null)
      : null,
    commentLine('Failure', outcome.failure),
  ].filter((line): line is string => Boolean(line));
  if (pulls.length === 0 && lines.length === 0) return null;
  return (
    <Card role="region" aria-label="Pull requests">
      <CardHead title="Pull requests" sub="Draft pull requests for review, in merge order" />
      <CardBody className="flex flex-col gap-2 text-[13px]">
        {pulls.length > 0 && (
          <ol className="flex flex-col gap-1">
            {pulls.map((pull) => (
              <li key={pull.repository} className="flex items-baseline gap-2">
                <span className="font-mono text-[12.5px]">{pull.repository}</span>
                <a href={pull.url} target="_blank" rel="noreferrer" className="text-brand-text underline">
                  #{pull.number}
                </a>
                <span className="text-ink-4">
                  {pull.state === 'open' && pull.draft ? 'Draft' : STATE_LABEL[pull.state]}
                </span>
              </li>
            ))}
          </ol>
        )}
        {lines.map((line) => (
          <p
            key={line}
            className={line.includes('not posted') || line.includes('warning') ? 'text-warn-text' : 'text-ink-3'}
          >
            {line}
          </p>
        ))}
      </CardBody>
    </Card>
  );
}
