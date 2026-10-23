import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ResultStatus,
  type DeliveryReport,
  defaultRetryDelay,
  type RetryDelay,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import type { GithubClient } from '../../libs/github/github-client.js';
import { connectorClient, defaultGithubFactory, transientGithub } from './github-connector-client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { GITHUB_CLIENT_FACTORY, type GithubClientFactory } from '../delivery/github-importer.service.js';
import { strictPullWithHeadSchema } from '../../libs/github/github-pull.js';
import { CloudAgentRunImplementService, type RunResult, runRepositories } from './cloud-agent-run-implement.service.js';
import type { RunAssumption } from './cloud-agent-run-scope.service.js';
import { assemblePullRequest } from './pull-request-body.js';
import { CLOUD_AGENT_RUNS_RETRY_DELAY, withRetries } from './retry.js';
import { runPageUrl } from './run-links.js';
import { RunEventCode, RunFailureCode, RunPhase, ServerEventType, SpecStatus, TurnOutcome } from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { type JiraCommentOutcome, jiraOutcomeOf } from './jira-outcome.js';
import { failRun } from './run-transitions.js';

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

export interface DeliveryVerification {
  verified: RecordedPullRequest[];
  failure: string | null;
  missing: string[];
}

export function recordedPullRequests(run: Pick<CloudAgentRun, 'pullRequests'>): RecordedPullRequest[] {
  return (Array.isArray(run.pullRequests) ? run.pullRequests : []) as unknown as RecordedPullRequest[];
}

/** The message is server-written, never runner text. */
class Unconfirmed extends Error {}

/** Pull request titles and bodies are assembled here so agent text is sanitised in one place. */
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
    this.githubFactory = githubFactory ?? defaultGithubFactory;
  }

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

  /** Runs before the completion transaction because it makes network calls. Null for non-delivery turns. */
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
    const bases = new Map(runRepositories(run).map((repository) => [repository.key, repository.baseBranch ?? null]));
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
          const { number } = report.pullRequest;
          verified.push(
            await this.verifyOne(run, report.key, number, !recorded.has(report.key), bases.get(report.key) ?? null),
          );
        } else {
          await this.confirmUnchanged(run, report.key, bases.get(report.key) ?? null);
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
    return { owner, name, gitOrigin, client: connectorClient(this.githubFactory, connector) };
  }

  /**
   * Everything recorded comes from GitHub's answer, never from the report. A
   * pull request this run opened must still be a draft.
   */
  private async verifyOne(
    run: CloudAgentRun,
    key: string,
    number: number,
    openedByThisRun: boolean,
    base: string | null,
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
      pull.base.ref !== (base ?? pull.base.repo.default_branch) ||
      pull.head.repo?.full_name.toLowerCase() !== fullName ||
      pull.head.ref !== run.branch
    ) {
      throw new Unconfirmed(
        `Pull request #${number} reported for ${key} is not from this run's branch ${run.branch} to ${base ?? 'the default branch'} of ${owner}/${name}.`,
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

  /** A repository reported unchanged must show no commits on the run branch ahead of its base (or default) branch. */
  private async confirmUnchanged(run: CloudAgentRun, key: string, recordedBase: string | null): Promise<void> {
    const { owner, name, client } = await this.repository(run, key);
    const base = recordedBase ?? (await this.defaultBranch(client, owner, name));
    const { status } = await withRetries(
      () => client.compareCommits(owner, name, base, run.branch),
      transientGithub,
      this.retryDelay,
    );
    if (status !== 'identical' && status !== 'behind') {
      throw new Unconfirmed(`${key} was reported unchanged, but ${run.branch} has commits ahead of ${base}.`);
    }
  }

  private async defaultBranch(client: GithubClient, owner: string, name: string): Promise<string> {
    const repository = (await withRetries(
      () => client.getRepositoryMetadata(owner, name),
      transientGithub,
      this.retryDelay,
    )) as { default_branch?: unknown } | null;
    const branch = repository?.default_branch;
    if (typeof branch !== 'string' || !branch) {
      throw new Unconfirmed(`GitHub did not report the default branch of ${owner}/${name}.`);
    }
    return branch;
  }

  /** Also called for a stopped turn, so pull requests opened before a cancel stay on the run. */
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

  /** On success the done comment is handed to the run sweep. */
  async settle(
    tx: Tx,
    run: CloudAgentRun,
    verification: DeliveryVerification | null,
    at: Date,
  ): Promise<TurnOutcome | RunFailureCode> {
    const failure =
      verification?.failure ??
      (verification?.missing.length ? `No pull request was reported for ${verification.missing.join(', ')}.` : null);
    if (!verification || failure) {
      await failRun(tx, run, RunFailureCode.DeliveryFailed, failure, at);
      return RunFailureCode.DeliveryFailed;
    }
    // The pull requests stay open for review; the unmet criteria are agent text, so they stay on the run page.
    const result = run.result as unknown as RunResult | null;
    if (result?.status && result.status !== ResultStatus.Complete) {
      await failRun(tx, run, RunFailureCode.IncompleteResult, (result.unmetCriteria ?? []).join('; '), at);
      return RunFailureCode.IncompleteResult;
    }
    const done: JiraCommentOutcome = { state: 'pending', attempts: 0, nextAttemptAt: at.toISOString() };
    await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { jiraOutcome: { ...jiraOutcomeOf(run), done } as unknown as Prisma.InputJsonObject },
    });
    return TurnOutcome.Delivered;
  }
}
