import { HttpStatus, Injectable } from '@nestjs/common';
import { CloudAgentRunIssueReader, JiraReadFailure, type ResolvedIssue } from './cloud-agent-run-issue-reader.js';
import { CloudAgentRunErrorCode, cloudAgentRunError, RunFailureCode } from './run-states.js';

export type { ResolvedIssue } from './cloud-agent-run-issue-reader.js';

/** Missing, invisible to the connector or outside its configured projects is `ISSUE_NOT_READABLE`. */
@Injectable()
export class CloudAgentRunIssueResolver {
  constructor(private readonly jira: CloudAgentRunIssueReader) {}

  async resolve(workspaceId: string, issueKey: string): Promise<ResolvedIssue> {
    try {
      return await this.jira.resolveIssue(workspaceId, issueKey);
    } catch (error) {
      if (!(error instanceof JiraReadFailure)) throw error;
      if (error.code === RunFailureCode.JiraError) {
        throw cloudAgentRunError(
          CloudAgentRunErrorCode.JiraUnavailable,
          'Jira kept failing; try again shortly',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw cloudAgentRunError(CloudAgentRunErrorCode.IssueNotReadable, error.message, HttpStatus.BAD_REQUEST);
    }
  }
}
