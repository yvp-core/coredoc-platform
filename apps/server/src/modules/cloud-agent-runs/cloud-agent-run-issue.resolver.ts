import { Injectable } from '@nestjs/common';

export interface ResolvedIssue {
  /** The immutable Jira issue id: the run's identity. */
  issueId: string;
  issueKey: string;
  jiraConnectorId: string | null;
}

/**
 * Maps a manual start's issue key to the Jira issue identity.
 *
 * PROVISIONAL (SF-001 ticket 03): the Jira read is not wired yet, so the key
 * stands in for the id. Ticket 04/09 replaces this with a read through the
 * workspace's Jira connector (`ISSUE_NOT_READABLE` when the issue cannot be
 * read or is outside the configured projects). Callers already treat the
 * result as the identity, so only this class changes.
 */
@Injectable()
export class CloudAgentRunIssueResolver {
  async resolve(_workspaceId: string, issueKey: string): Promise<ResolvedIssue> {
    return { issueId: issueKey, issueKey, jiraConnectorId: null };
  }
}
