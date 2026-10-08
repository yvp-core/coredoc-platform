import { HttpStatus, Injectable } from '@nestjs/common';
import { CloudAgentRunJiraService, JiraReadFailure, type ResolvedIssue } from './cloud-agent-run-jira.service.js';
import { CloudAgentRunErrorCode, cloudAgentRunError, RunFailureCode } from './run-states.js';

export type { ResolvedIssue } from './cloud-agent-run-jira.service.js';

/**
 * Maps a manual start's issue key to the Jira issue identity through the
 * workspace's Jira connector. An issue that is missing, invisible to the
 * connector or outside its configured projects is `ISSUE_NOT_READABLE`.
 */
@Injectable()
export class CloudAgentRunIssueResolver {
  constructor(private readonly jira: CloudAgentRunJiraService) {}

  async resolve(workspaceId: string, issueKey: string): Promise<ResolvedIssue> {
    try {
      return await this.jira.resolveIssue(workspaceId, issueKey);
    } catch (error) {
      if (!(error instanceof JiraReadFailure)) throw error;
      if (error.code === RunFailureCode.JiraError) {
        throw cloudAgentRunError(
          CloudAgentRunErrorCode.IssueNotReadable,
          'Jira kept failing; try again shortly',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw cloudAgentRunError(CloudAgentRunErrorCode.IssueNotReadable, error.message, HttpStatus.BAD_REQUEST);
    }
  }
}
