/**
 * Fakes at the cloud agent runs module's ports, shared by its Postgres
 * suites: an in-memory Jira (behind the importer's client-factory seam) and an
 * in-memory state-archive store.
 */
import type { JiraClient } from '../delivery/jira-client.js';
import { JiraNotFoundError, JiraRateLimitError } from '../delivery/jira-client.js';
import type { CloudAgentRunArchiveStore } from './cloud-agent-run-archive.store.js';

export interface FakeJiraIssue {
  id: string;
  key: string;
  summary: string;
  project: string;
  issueType?: string;
  /** Parent issue key (an epic for stories). */
  parent?: string;
  labels?: string[];
  description?: unknown;
}

export const paragraphDoc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A stateful Jira: issues by key, epic children by parent, scripted transient failures. */
export class FakeJira {
  readonly issues = new Map<string, FakeJiraIssue>();
  /** The next N reads fail with a rate limit, to exercise in-process retries. */
  rateLimitedReads = 0;
  reads = 0;

  add(issue: Omit<FakeJiraIssue, 'id'> & { id?: string }): FakeJiraIssue {
    const stored = { id: issue.id ?? String(10_000 + this.issues.size + 1), ...issue };
    this.issues.set(stored.key, stored);
    return stored;
  }

  private find(idOrKey: string): FakeJiraIssue | undefined {
    return this.issues.get(idOrKey) ?? [...this.issues.values()].find((issue) => issue.id === idOrKey);
  }

  private wire(issue: FakeJiraIssue) {
    const parent = issue.parent ? this.issues.get(issue.parent) : undefined;
    return {
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        description: issue.description ?? null,
        labels: issue.labels ?? [],
        status: { name: 'To Do' },
        issuetype: { name: issue.issueType ?? 'Story', hierarchyLevel: issue.issueType === 'Epic' ? 1 : 0 },
        project: { key: issue.project },
        parent: parent
          ? {
              id: parent.id,
              key: parent.key,
              fields: {
                issuetype: { name: parent.issueType ?? 'Story', hierarchyLevel: parent.issueType === 'Epic' ? 1 : 0 },
              },
            }
          : undefined,
      },
    };
  }

  client(): JiraClient {
    const fake = {
      getIssue: async (idOrKey: string) => {
        this.reads += 1;
        if (this.rateLimitedReads > 0) {
          this.rateLimitedReads -= 1;
          throw new JiraRateLimitError('Jira rate limit (429)', 0);
        }
        const issue = this.find(idOrKey);
        if (!issue) throw new JiraNotFoundError(`Jira API 404 for /issue/${idOrKey}`);
        return this.wire(issue);
      },
      searchIssues: async (jql: string) => {
        const parentKey = /^parent = ([A-Z][A-Z0-9_]*-\d+)/.exec(jql)?.[1];
        const items = [...this.issues.values()].filter((issue) => issue.parent === parentKey).map((i) => this.wire(i));
        return { items, nextPageToken: null };
      },
    };
    return fake as unknown as JiraClient;
  }
}

export class InMemoryArchiveStore implements CloudAgentRunArchiveStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    if (this.objects.has(key)) throw new Error(`archive ${key} already exists`);
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
