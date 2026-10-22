import { Injectable } from '@nestjs/common';
import type { RetryDelay } from '@coredoc/core/agent-runner';
import {
  JiraAuthError,
  type JiraClient,
  JiraNotFoundError,
  JiraRateLimitError,
  normalizeJiraBaseUrl,
} from '../delivery/jira-client.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';
import { buildPrdDocument, type PrdIssue } from './prd-document.js';
import { withRetries } from './retry.js';
import { RunFailureCode } from './run-states.js';
import { asRecord as record } from '../../libs/coerce.js';

const ISSUE_FIELDS = ['summary', 'description', 'labels', 'issuetype', 'status', 'project', 'parent'];

export class JiraReadFailure extends Error {
  constructor(
    readonly code:
      | typeof RunFailureCode.IssueNotReadable
      | typeof RunFailureCode.JiraError
      | typeof RunFailureCode.ConnectorInactive,
    message: string,
  ) {
    super(message);
    this.name = 'JiraReadFailure';
  }
}

export interface SearchRow {
  key: string;
  summary: string;
  issueType: string | null;
  status: string | null;
}

export interface ResolvedIssue {
  /** The immutable Jira issue id: the run's identity. */
  issueId: string;
  issueKey: string;
  jiraConnectorId: string;
}

interface Connector {
  id: string;
  siteUrl: string;
  projects: Set<string>;
  client: JiraClient;
}

function isPermanent(error: unknown): boolean {
  return error instanceof JiraNotFoundError || error instanceof JiraAuthError;
}

/** Everything but not-found/auth is retried; a rate limit's Retry-After is honoured. */
function transientRead(error: unknown): { retryAfterMs: number | null } | false {
  if (isPermanent(error)) return false;
  return { retryAfterMs: error instanceof JiraRateLimitError ? error.retryAfterMs : null };
}

/** Far below the usual 5 minutes: these reads run inside a claim request the runner times out after 30 s. */
const readDelay: RetryDelay = (attempt, retryAfterMs) => Math.min(retryAfterMs ?? 1_000 * attempt, 5_000);

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isEpic(issueType: unknown): boolean {
  const type = record(issueType);
  return type.hierarchyLevel === 1 || text(type.name)?.toLowerCase() === 'epic';
}

/** Only issues in the connector's configured projects are readable. */
@Injectable()
export class CloudAgentRunIssueReader {
  constructor(private readonly jira: CloudAgentRunJiraConnector) {}

  async resolveIssue(workspaceId: string, issueKey: string): Promise<ResolvedIssue> {
    const connector = await this.connector(workspaceId);
    const issue = await this.readIssue(connector, issueKey, ['summary', 'project']);
    return { issueId: String(issue.id), issueKey: String(issue.key), jiraConnectorId: connector.id };
  }

  async readPrd(workspaceId: string, jiraIssueId: string): Promise<{ issueKey: string; markdown: string }> {
    const connector = await this.connector(workspaceId);
    const issue = await this.readIssue(connector, jiraIssueId, ISSUE_FIELDS);
    const fields = record(issue.fields);
    const issueKey = String(issue.key);

    let epicChildren: PrdIssue[] = [];
    if (isEpic(fields.issuetype)) {
      const children = await this.withRetries(() =>
        connector.client.searchIssues(`parent = ${issueKey} ORDER BY rank`, ISSUE_FIELDS, { expandChangelog: false }),
      );
      epicChildren = children.items.filter((child) => inConfiguredProjects(connector, child)).map(toPrdIssue);
    }

    let parentEpic: PrdIssue | null = null;
    const parent = record(fields.parent);
    if (text(parent.key) && isEpic(record(parent.fields).issuetype)) {
      try {
        parentEpic = toPrdIssue(await this.readIssue(connector, String(parent.key), ISSUE_FIELDS));
      } catch (error) {
        // An epic outside the configured projects is left out, like such children.
        if (!(error instanceof JiraReadFailure && error.code === RunFailureCode.IssueNotReadable)) throw error;
      }
    }

    return {
      issueKey,
      markdown: buildPrdDocument({ siteUrl: connector.siteUrl, issue: toPrdIssue(issue), epicChildren, parentEpic }),
    };
  }

  /**
   * The agent's JQL, confined to the configured projects twice: in the query and again on the
   * rows, since a clause such as `x) OR (project = OTHER` escapes the query's parentheses.
   */
  async searchIssues(workspaceId: string, jql: string, limit: number): Promise<SearchRow[]> {
    const connector = await this.connector(workspaceId);
    const projects = [...connector.projects].map(jqlString).join(', ');
    const order = /\s*\border\s+by\b(.*)$/is.exec(jql);
    const condition = (order ? jql.slice(0, order.index) : jql).trim();
    const confined = `project in (${projects})${condition ? ` AND (${condition})` : ''}${order ? ` ORDER BY${order[1]}` : ''}`;
    const found = await this.withRetries(() =>
      connector.client.searchIssues(confined, ['summary', 'issuetype', 'status', 'project'], {
        expandChangelog: false,
        maxPages: 1,
      }),
    );
    return found.items
      .filter((issue) => inConfiguredProjects(connector, issue))
      .slice(0, limit)
      .map((issue) => {
        const { key, summary, issueType, status } = toPrdIssue(issue);
        return { key, summary, issueType, status };
      });
  }

  private async readIssue(connector: Connector, idOrKey: string, fields: string[]) {
    let issue: Record<string, unknown>;
    try {
      issue = await this.withRetries(() => connector.client.getIssue(idOrKey, fields));
    } catch (error) {
      if (isPermanent(error)) throw notReadable(idOrKey);
      throw error;
    }
    if (!inConfiguredProjects(connector, issue)) throw notReadable(idOrKey);
    return issue;
  }

  private async withRetries<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await withRetries(read, transientRead, readDelay);
    } catch (error) {
      if (isPermanent(error)) throw error;
      throw new JiraReadFailure(RunFailureCode.JiraError, 'Jira kept failing while the PRD was being read');
    }
  }

  private async connector(workspaceId: string): Promise<Connector> {
    const state = await this.jira.state(workspaceId);
    if (state.status !== 'active' || !state.connector.baseUrl) {
      throw new JiraReadFailure(RunFailureCode.ConnectorInactive, 'The workspace has no active Jira connector');
    }
    try {
      return {
        id: state.connector.id,
        siteUrl: normalizeJiraBaseUrl(state.connector.baseUrl),
        projects: new Set(state.projectKeys),
        client: this.jira.client(state.connector),
      };
    } catch {
      throw new JiraReadFailure(RunFailureCode.ConnectorInactive, 'The Jira connector’s credentials are unusable');
    }
  }
}

/** A JQL string literal; Atlassian's reference recommends quoting labels and relative dates. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function inConfiguredProjects(connector: Connector, issue: Record<string, unknown>): boolean {
  return connector.projects.has(text(record(record(issue.fields).project).key) ?? '');
}

function notReadable(idOrKey: string): JiraReadFailure {
  return new JiraReadFailure(
    RunFailureCode.IssueNotReadable,
    `Jira issue ${idOrKey} is missing, not visible to the Jira connector, or outside its configured projects`,
  );
}

function toPrdIssue(issue: Record<string, unknown>): PrdIssue {
  const fields = record(issue.fields);
  return {
    key: String(issue.key),
    summary: text(fields.summary) ?? '(no summary)',
    issueType: text(record(fields.issuetype).name),
    status: text(record(fields.status).name),
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter((label): label is string => typeof label === 'string')
      : [],
    description: fields.description ?? null,
  };
}
