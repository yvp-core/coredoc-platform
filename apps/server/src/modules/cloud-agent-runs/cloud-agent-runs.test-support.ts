/**
 * Fakes at the cloud agent runs module's ports, shared by its Postgres
 * suites: an in-memory Jira and GitHub (behind the importers' client-factory
 * seams) and an in-memory state-archive store.
 */
import type { JiraClient, JiraComment, JiraTransition } from '../delivery/jira-client.js';
import { JiraNotFoundError, JiraRateLimitError } from '../delivery/jira-client.js';
import { GithubApiError, type GithubClient } from '../../libs/github/github-client.js';
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
  /** Jira status id; transitions change it. */
  statusId?: string;
}

/** The fake's one transition, to the done status, and that status' id. */
export const DONE_STATUS = { id: '10002', name: 'Done' };

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
  /** Comments by issue id, oldest first. */
  readonly comments = new Map<string, JiraComment[]>();
  transitions: JiraTransition[] = [
    { id: '21', name: 'Done (with screen)', hasScreen: true, to: DONE_STATUS },
    { id: '31', name: 'Done', hasScreen: false, to: DONE_STATUS },
  ];
  /** Transitions applied, as `<issue id>:<transition id>`. */
  readonly applied: string[] = [];
  /** The next transition fails with this, once. */
  transitionError: Error | null = null;
  /** Every comment fails with this, without being stored, until it is cleared. */
  commentError: Error | null = null;
  /** The next comment is stored, then the call throws: Jira accepted it and the caller crashed. */
  crashAfterNextComment = false;
  private commentSeq = 0;

  commentsOn(issueKey: string): JiraComment[] {
    return this.comments.get(this.issues.get(issueKey)!.id) ?? [];
  }

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
        status:
          issue.statusId === DONE_STATUS.id ? { ...DONE_STATUS } : { id: issue.statusId ?? '10000', name: 'To Do' },
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
      addComment: async (idOrKey: string, body: unknown) => {
        const issue = this.find(idOrKey);
        if (!issue) throw new JiraNotFoundError(`Jira API 404 for /issue/${idOrKey}/comment`);
        if (this.commentError) throw this.commentError;
        this.commentSeq += 1;
        const comment = { id: String(20_000 + this.commentSeq), body: structuredClone(body) };
        this.comments.set(issue.id, [...(this.comments.get(issue.id) ?? []), comment]);
        if (this.crashAfterNextComment) {
          this.crashAfterNextComment = false;
          throw new Error('the process died after Jira accepted the comment');
        }
        return { id: comment.id };
      },
      listComments: async (idOrKey: string) => {
        const issue = this.find(idOrKey);
        if (!issue) throw new JiraNotFoundError(`Jira API 404 for /issue/${idOrKey}/comment`);
        return [...(this.comments.get(issue.id) ?? [])];
      },
      listTransitions: async () => [...this.transitions],
      transitionIssue: async (idOrKey: string, transitionId: string) => {
        const issue = this.find(idOrKey);
        if (!issue) throw new JiraNotFoundError(`Jira API 404 for /issue/${idOrKey}/transitions`);
        if (this.transitionError) {
          const error = this.transitionError;
          this.transitionError = null;
          throw error;
        }
        const transition = this.transitions.find((candidate) => candidate.id === transitionId);
        if (!transition) throw new JiraNotFoundError(`Jira API 400 for /issue/${idOrKey}/transitions`);
        this.applied.push(`${issue.id}:${transitionId}`);
        issue.statusId = transition.to?.id;
      },
    };
    return fake as unknown as JiraClient;
  }
}

export interface FakePull {
  number: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  /** The head's repository, `owner/name`; a fork names another owner, a deleted fork is null. */
  headRepo: string | null;
  headRef: string;
  /** The branch it targets; the default branch unless set. */
  baseRef?: string;
}

/** A stateful GitHub for the server's strict reads, with scripted transient failures. */
export class FakeGithubPulls {
  readonly pulls = new Map<string, FakePull>();
  /** How a run branch compares with the default branch, by `owner/name`; `ahead` unless set. */
  readonly compare = new Map<string, string>();
  /** The next N reads answer 502. */
  transientFailures = 0;
  reads = 0;

  add(fullName: string, pull: FakePull): void {
    this.pulls.set(`${fullName}#${pull.number}`, pull);
  }

  client(): GithubClient {
    const fake = {
      getRepositoryMetadata: async (owner: string, name: string) => ({
        full_name: `${owner}/${name}`,
        default_branch: 'main',
      }),
      compareCommits: async (owner: string, name: string, base: string) => {
        if (base !== 'main') throw new GithubApiError(404, `/repos/${owner}/${name}/compare`);
        return { status: this.compare.get(`${owner}/${name}`) ?? 'ahead' };
      },
      getPullMetadata: async (owner: string, name: string, number: number) => {
        this.reads += 1;
        const path = `/repos/${owner}/${name}/pulls/${number}`;
        if (this.transientFailures > 0) {
          this.transientFailures -= 1;
          throw new GithubApiError(502, path);
        }
        const fullName = `${owner}/${name}`;
        const pull = this.pulls.get(`${fullName}#${number}`);
        if (!pull) throw new GithubApiError(404, path);
        return {
          number: pull.number,
          state: pull.state ?? 'open',
          merged: pull.merged ?? false,
          draft: pull.draft ?? true,
          head: {
            sha: 'c'.repeat(40),
            ref: pull.headRef,
            repo: pull.headRepo === null ? null : { full_name: pull.headRepo },
          },
          base: { ref: pull.baseRef ?? 'main', repo: { full_name: fullName, default_branch: 'main' } },
          merge_commit_sha: null,
          merged_at: null,
        };
      },
    };
    return fake as unknown as GithubClient;
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
