import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DeliveryReport, TurnAssignment } from '@coredoc/core/agent-runner';
import { decrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import { GithubApiError, GithubClient, GithubRateLimitError } from '../../libs/github/github-client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { GITHUB_CLIENT_FACTORY, type GithubClientFactory } from '../delivery/github-importer.service.js';
import { strictPullWithHeadSchema } from '../../libs/github/github-pull.js';
import { CloudAgentRunImplementService, type RunResult, runRepositories } from './cloud-agent-run-implement.service.js';
import type { RunAssumption } from './cloud-agent-run-scope.service.js';
import { assemblePullRequest } from './pull-request-body.js';
import { CLOUD_AGENT_RUNS_RETRY_DELAY, defaultRetryDelay, type RetryDelay, withRetries } from './retry.js';
import { runPageUrl } from './run-links.js';
import { RunEventCode, RunFailureCode, RunPhase, ServerEventType, SpecStatus, TurnOutcome } from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { failRun } from './run-transitions.js';

/** A pull request the server read back and confirmed is the run branch's, as stored on the run. */
export interface RecordedPullRequest {
  repository: string;
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  /** Derived by the server: no pull request was recorded for the repository before this one. */
  created: boolean;
  verifiedAt: string;
}

/** What the server made of a delivery turn's reports. */
export interface DeliveryVerification {
  verified: RecordedPullRequest[];
  /** Why delivery failed; null when every report checked out. */
  failure: string | null;
  /** Touched repositories with no report at all. */
  missing: string[];
}

/** One Jira comment's progress on the run (done or failure). */
export interface JiraCommentOutcome {
  state: 'pending' | 'posted' | 'not_posted' | 'skipped';
  attempts: number;
  nextAttemptAt: string | null;
  commentId?: string | null;
  reason?: string | null;
}

export interface RunJiraOutcome {
  done?: JiraCommentOutcome;
  failure?: JiraCommentOutcome;
  transition?: { outcome: string; reason?: string | null };
}

export function recordedPullRequests(run: Pick<CloudAgentRun, 'pullRequests'>): RecordedPullRequest[] {
  return (Array.isArray(run.pullRequests) ? run.pullRequests : []) as unknown as RecordedPullRequest[];
}

export function jiraOutcomeOf(run: Pick<CloudAgentRun, 'jiraOutcome'>): RunJiraOutcome {
  const value = run.jiraOutcome;
  return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as RunJiraOutcome;
}

/** A report the server could not confirm; the reason is server-written. */
class Unconfirmed extends Error {}

function transientGithub(error: unknown): { retryAfterMs: number | null } | false {
  if (error instanceof GithubRateLimitError) return { retryAfterMs: null };
  if (error instanceof GithubApiError)
    return error.status >= 500 || error.status === 408 ? { retryAfterMs: null } : false;
  // fetch rejects with a TypeError on network failures and a TimeoutError on its timeout.
  if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
    return { retryAfterMs: null };
  }
  return false;
}

/**
 * Delivery on the server: the delivery turn's assignment (each pull
 * request's title and body, assembled here so agent text is sanitised in
 * one place), verification of what the runner reports with the strict pull
 * read, and recording the verified pull requests on the run.
 */
@Injectable()
export class CloudAgentRunDeliveryService {
  private readonly githubFactory: GithubClientFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: GithubRepositoryResolver,
    private readonly implement: CloudAgentRunImplementService,
    @Optional() @Inject(GITHUB_CLIENT_FACTORY) githubFactory?: GithubClientFactory,
    @Optional() @Inject(CLOUD_AGENT_RUNS_RETRY_DELAY) private readonly retryDelay: RetryDelay = defaultRetryDelay,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {
    this.githubFactory = githubFactory ?? ((token, baseUrl) => new GithubClient({ token, baseUrl }));
  }

  /** The touched repositories in merge order, each with its pull request's title and body. */
  async assignment(run: CloudAgentRun): Promise<Pick<TurnAssignment, 'repositories' | 'delivery'>> {
    const stored = new Map(runRepositories(run).map((repository) => [repository.key, repository]));
    const repositories = (await this.implement.repositoriesFor(run, RunPhase.Implement)).filter(
      (repository) => stored.get(repository.key)?.touched,
    );
    const spec = await this.prisma.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId: run.workspaceId, runId: run.id, status: SpecStatus.Accepted },
      orderBy: { version: 'desc' },
      select: { title: true },
    });
    const result = run.result as unknown as RunResult | null;
    const assumptions = ((Array.isArray(run.assumptions) ? run.assumptions : []) as unknown as RunAssumption[]).map(
      (assumption) => assumption.text,
    );
    const runUrl = await runPageUrl(this.prisma, run.workspaceId, run.id);
    const previousRunUrl = run.previousRunId ? await runPageUrl(this.prisma, run.workspaceId, run.previousRunId) : null;
    const mergeOrder = repositories.map((repository) => repository.key);
    return {
      repositories,
      delivery: {
        pullRequests: repositories.map((repository) => {
          const own = stored.get(repository.key)!;
          return {
            key: repository.key,
            ...assemblePullRequest({
              issueKey: run.issueKey,
              specTitle: spec?.title ?? run.issueKey,
              repository: repository.key,
              summary: result?.repositories.find((entry) => entry.key === repository.key)?.summary ?? null,
              mergeOrder,
              assumptions,
              withheldPaths: own.withheldPaths ?? [],
              binaryPaths: own.binaryPaths ?? [],
              notBuiltOrTested: own.notBuiltOrTested,
              runUrl,
              previousRunUrl,
            }),
          };
        }),
      },
    };
  }

  /**
   * Reads every reported pull request back through the GitHub connector
   * with the strict pull read, and keeps it only if its base and head
   * repositories are both that repository and its head branch is the run
   * branch. Null for turns other than delivery. Runs before the completion
   * transaction: it makes network calls.
   */
  async verify(workspaceId: string, turnId: string, reports: DeliveryReport[]): Promise<DeliveryVerification | null> {
    const turn = await this.prisma.cloudAgentRunTurn.findFirst({
      where: { id: turnId, workspaceId },
      select: { kind: true, runId: true },
    });
    if (turn?.kind !== RunPhase.Delivery) return null;
    const run = await this.prisma.cloudAgentRun.findFirstOrThrow({ where: { id: turn.runId, workspaceId } });
    const touched = new Set(
      runRepositories(run)
        .filter((repository) => repository.touched)
        .map((repository) => repository.key),
    );
    const recorded = new Set(recordedPullRequests(run).map((pull) => pull.repository));
    const seen = new Set<string>();
    const verified: RecordedPullRequest[] = [];
    const failures: string[] = [];
    for (const report of reports) {
      if (!touched.has(report.key) || seen.has(report.key)) {
        failures.push(`The runner reported ${report.key}, which this run does not deliver or reported twice.`);
        continue;
      }
      seen.add(report.key);
      try {
        if (report.pullRequest) {
          verified.push(await this.verifyOne(run, report.key, report.pullRequest.number, !recorded.has(report.key)));
        } else {
          await this.confirmUnchanged(run, report.key);
        }
      } catch (error) {
        failures.push(
          error instanceof Unconfirmed
            ? error.message
            : report.pullRequest
              ? `GitHub could not confirm pull request #${report.pullRequest.number} in ${report.key}.`
              : `GitHub could not confirm that ${report.key} has no changes to deliver.`,
        );
      }
    }
    return {
      verified,
      failure: failures.length ? failures.join(' ') : null,
      missing: [...touched].filter((key) => !seen.has(key)),
    };
  }

  private async repository(run: CloudAgentRun, key: string) {
    let resolved: Awaited<ReturnType<GithubRepositoryResolver['resolve']>>;
    try {
      resolved = await this.resolver.resolve(run.workspaceId, key);
    } catch (error) {
      throw new Unconfirmed(`${key} no longer resolves to a GitHub repository (${(error as Error).message}).`);
    }
    const { owner, name, connector, gitOrigin } = resolved;
    const client = this.githubFactory(decrypt(connector.credentialsEncrypted!), connector.baseUrl ?? undefined);
    return { owner, name, gitOrigin, client };
  }

  /**
   * Everything recorded comes from GitHub's answer, never from the report:
   * the pull request must target the repository's default branch from the
   * run branch in the same repository, and one this run opened (no pull
   * request recorded for the repository before) must still be a draft.
   */
  private async verifyOne(
    run: CloudAgentRun,
    key: string,
    number: number,
    openedByThisRun: boolean,
  ): Promise<RecordedPullRequest> {
    const { owner, name, gitOrigin, client } = await this.repository(run, key);
    const raw = await withRetries(() => client.getPullMetadata(owner, name, number), transientGithub, this.retryDelay);
    const parsed = strictPullWithHeadSchema.safeParse(raw);
    const fullName = `${owner}/${name}`.toLowerCase();
    const pull = parsed.success ? parsed.data : null;
    if (
      !pull ||
      pull.number !== number ||
      pull.base.repo.full_name.toLowerCase() !== fullName ||
      pull.base.ref !== pull.base.repo.default_branch ||
      pull.head.repo?.full_name.toLowerCase() !== fullName ||
      pull.head.ref !== run.branch
    ) {
      throw new Unconfirmed(
        `Pull request #${number} reported for ${key} is not from this run's branch ${run.branch} to the default branch of ${owner}/${name}.`,
      );
    }
    const state = pull.merged ? 'merged' : pull.state;
    if (openedByThisRun && state === 'open' && !pull.draft) {
      throw new Unconfirmed(`Pull request #${number} in ${key} is not a draft, as one this run opens must be.`);
    }
    return {
      repository: key,
      number: pull.number,
      url: `${gitOrigin}/${owner}/${name}/pull/${pull.number}`,
      state,
      draft: pull.draft,
      created: openedByThisRun,
      verifiedAt: this.now().toISOString(),
    };
  }

  /** A repository reported unchanged must show no commits on the run branch ahead of its default branch. */
  private async confirmUnchanged(run: CloudAgentRun, key: string): Promise<void> {
    const { owner, name, client } = await this.repository(run, key);
    const repository = (await withRetries(
      () => client.getRepositoryMetadata(owner, name),
      transientGithub,
      this.retryDelay,
    )) as { default_branch?: unknown } | null;
    const defaultBranch = repository?.default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) {
      throw new Unconfirmed(`GitHub did not report the default branch of ${owner}/${name}.`);
    }
    const { status } = await withRetries(
      () => client.compareCommits(owner, name, defaultBranch, run.branch),
      transientGithub,
      this.retryDelay,
    );
    if (status !== 'identical' && status !== 'behind') {
      throw new Unconfirmed(`${key} was reported unchanged, but ${run.branch} has commits ahead of ${defaultBranch}.`);
    }
  }

  /**
   * Records verified pull requests on the run, one per repository in merge
   * order. Also on a stopped turn: pull requests opened before a cancel are
   * kept on the cancelled run.
   */
  async record(
    tx: Tx,
    run: CloudAgentRun,
    turnId: string,
    verification: DeliveryVerification | null,
    at: Date,
  ): Promise<CloudAgentRun> {
    if (!verification?.verified.length) return run;
    const byRepository = new Map(recordedPullRequests(run).map((pull) => [pull.repository, pull]));
    for (const pull of verification.verified) byRepository.set(pull.repository, pull);
    const order = new Map(runRepositories(run).map((repository) => [repository.key, repository.mergeOrder]));
    const pullRequests = [...byRepository.values()].sort(
      (a, b) => (order.get(a.repository) ?? 0) - (order.get(b.repository) ?? 0),
    );
    await appendRunEvents(
      tx,
      { workspaceId: run.workspaceId, runId: run.id, turnId },
      verification.verified.map((pull) => ({
        type: ServerEventType.RunEvent,
        payload: {
          code: RunEventCode.PullRequestOpened,
          text: `${pull.created ? 'Opened' : 'Reused'} pull request #${pull.number} in ${pull.repository}`,
          repository: pull.repository,
          number: pull.number,
          url: pull.url,
        },
      })),
      at,
    );
    return tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { pullRequests: pullRequests as unknown as Prisma.InputJsonArray },
    });
  }

  /**
   * A live delivery turn that ended normally: every touched repository has
   * a verified pull request or was unchanged, and the done comment is handed
   * to the run sweep; otherwise the run fails with `delivery_failed`.
   */
  async settle(tx: Tx, run: CloudAgentRun, verification: DeliveryVerification | null, at: Date): Promise<string> {
    const failure =
      verification?.failure ??
      (verification?.missing.length ? `No pull request was reported for ${verification.missing.join(', ')}.` : null);
    if (!verification || failure) {
      await failRun(tx, run, RunFailureCode.DeliveryFailed, failure, at);
      return RunFailureCode.DeliveryFailed;
    }
    const done: JiraCommentOutcome = { state: 'pending', attempts: 0, nextAttemptAt: at.toISOString() };
    await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { jiraOutcome: { ...jiraOutcomeOf(run), done } as unknown as Prisma.InputJsonObject },
    });
    return TurnOutcome.Delivered;
  }
}
