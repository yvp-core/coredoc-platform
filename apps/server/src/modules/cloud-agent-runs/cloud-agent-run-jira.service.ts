import { Inject, Injectable, Optional } from '@nestjs/common';
import { decrypt, isEncryptionAvailable } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  JiraAuthError,
  type JiraClient,
  JiraClient as DefaultJiraClient,
  JiraNotFoundError,
  JiraRateLimitError,
  normalizeJiraBaseUrl,
} from '../delivery/jira-client.js';
import { JIRA_CLIENT_FACTORY, type JiraClientFactory } from '../delivery/jira-importer.service.js';
import { buildPrdDocument, type PrdIssue } from './prd-document.js';
import { RunFailureCode } from './run-states.js';

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISSUE_FIELDS = ['summary', 'description', 'labels', 'issuetype', 'status', 'project', 'parent'];
/** In-process retries for rate limits and server errors before a read gives up. */
const JIRA_ATTEMPTS = 4;
/**
 * Waits are capped well below the spec's 5 minutes: these reads run inside a
 * runner's claim request, which the runner times out after 30 seconds.
 */
const MAX_RETRY_WAIT_MS = 5_000;

/** A run-level failure found while reading Jira: the run fails with `code`. */
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

export type Sleep = (ms: number) => Promise<void>;
export const CLOUD_AGENT_RUNS_SLEEP = Symbol('CLOUD_AGENT_RUNS_SLEEP');

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isEpic(issueType: unknown): boolean {
  const type = record(issueType);
  return type.hierarchyLevel === 1 || text(type.name)?.toLowerCase() === 'epic';
}

/**
 * Reads a run's Jira issue through the workspace's Jira Delivery analytics
 * connector: the identity at manual start, and the PRD when a scope turn is
 * claimed (fresh every turn). Only issues in the connector's configured
 * projects are readable.
 */
@Injectable()
export class CloudAgentRunJiraService {
  private readonly clientFactory: JiraClientFactory;
  private readonly sleep: Sleep;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(JIRA_CLIENT_FACTORY) clientFactory?: JiraClientFactory,
    @Optional() @Inject(CLOUD_AGENT_RUNS_SLEEP) sleep?: Sleep,
  ) {
    this.clientFactory = clientFactory ?? ((options) => new DefaultJiraClient(options));
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async resolveIssue(workspaceId: string, issueKey: string): Promise<ResolvedIssue> {
    const connector = await this.connector(workspaceId);
    const issue = await this.readIssue(connector, issueKey, ['summary', 'project']);
    return { issueId: String(issue.id), issueKey: String(issue.key), jiraConnectorId: connector.id };
  }

  /** The PRD document for a scope turn, with the issue's current key. */
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
      epicChildren = children.items
        .filter((child) => connector.projects.has(text(record(record(child.fields).project).key) ?? ''))
        .map(toPrdIssue);
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

  private async readIssue(connector: Connector, idOrKey: string, fields: string[]) {
    let issue: Record<string, unknown>;
    try {
      issue = await this.withRetries(() => connector.client.getIssue(idOrKey, fields));
    } catch (error) {
      if (error instanceof JiraNotFoundError || error instanceof JiraAuthError) throw notReadable(idOrKey);
      throw error;
    }
    const project = text(record(record(issue.fields).project).key);
    if (!project || !connector.projects.has(project)) throw notReadable(idOrKey);
    return issue;
  }

  private async withRetries<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        const permanent = error instanceof JiraNotFoundError || error instanceof JiraAuthError;
        if (permanent) throw error;
        if (attempt >= JIRA_ATTEMPTS) {
          throw new JiraReadFailure(RunFailureCode.JiraError, 'Jira kept failing while the PRD was being read');
        }
        const wait =
          error instanceof JiraRateLimitError && error.retryAfterMs !== null ? error.retryAfterMs : 1_000 * attempt;
        await this.sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
      }
    }
  }

  private async connector(workspaceId: string): Promise<Connector> {
    const row = await this.prisma.deliveryConnector.findFirst({
      where: { workspaceId, provider: 'jira', status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    if (!row?.baseUrl || !row.credentialsEncrypted || !isEncryptionAvailable()) {
      throw new JiraReadFailure(RunFailureCode.ConnectorInactive, 'The workspace has no active Jira connector');
    }
    let email = '';
    let apiToken = '';
    let siteUrl: string;
    try {
      const credentials = record(JSON.parse(decrypt(row.credentialsEncrypted)));
      email = text(credentials.email) ?? '';
      apiToken = text(credentials.apiToken) ?? '';
      siteUrl = normalizeJiraBaseUrl(row.baseUrl);
    } catch {
      throw new JiraReadFailure(RunFailureCode.ConnectorInactive, 'The Jira connector’s credentials are unusable');
    }
    if (!email || !apiToken) {
      throw new JiraReadFailure(RunFailureCode.ConnectorInactive, 'The Jira connector’s credentials are unusable');
    }
    const projects = record(row.config).projects;
    return {
      id: row.id,
      siteUrl,
      projects: new Set(
        (Array.isArray(projects) ? projects : []).filter(
          (key): key is string => typeof key === 'string' && PROJECT_KEY_RE.test(key),
        ),
      ),
      client: this.clientFactory({ baseUrl: siteUrl, email, apiToken }),
    };
  }
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
