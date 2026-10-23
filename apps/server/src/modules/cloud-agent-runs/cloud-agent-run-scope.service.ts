import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { ProposeScope } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, CloudAgentRunSpecVersion, Prisma } from '../../generated/prisma/client.js';
import { GithubApiError } from '../../libs/github/github-client.js';
import type { resolveGithubRepository } from '../../libs/github/github-repository.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { GITHUB_CLIENT_FACTORY, type GithubClientFactory } from '../delivery/github-importer.service.js';
import { connectorClient, defaultGithubFactory, transientGithub } from './github-connector-client.js';
import { withRetries } from './retry.js';
import {
  cloudAgentRunError,
  CloudAgentRunErrorCode,
  isTerminalRunStatus,
  RunEventCode,
  RunPhase,
  RunStatus,
  RunTrigger,
  ScopeAcceptancePolicy,
  ServerEventType,
  SpecStatus,
} from './run-states.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { lockRun, queueTurn, setRunStatus } from './run-transitions.js';

/** In bytes; the contract caps characters. */
const MAX_SPEC_MARKDOWN_BYTES = 256 * 1024;

export interface SpecRepository {
  key: string;
  reason: string;
  changes: string;
  mergeOrder: number;
  eligible: boolean;
  ineligibleReason: string | null;
  /** Absent for the default branch. */
  baseBranch?: string;
}

export interface SpecContent {
  repositories: SpecRepository[];
  risks: string[];
  intentReferences: string[];
  assumptions: string[];
  droppedSeeds: Array<{ key: string; reason: string }>;
  candidates: Array<{ question: string; blocks: string }>;
}

export interface RunAssumption {
  phase: RunPhase;
  text: string;
}

export interface RunRepository {
  key: string;
  reason: string;
  mergeOrder: number;
  origin: 'label' | 'manual' | 'proposal' | 'request';
  eligible: boolean;
  branchCreated: boolean;
  touched: boolean;
  lastPushedHead: string | null;
  notBuiltOrTested: string | null;
  /** The branch the run branch starts from and its pull request targets; absent for the default branch. */
  baseBranch?: string | null;
  withheldPaths?: string[];
  binaryPaths?: string[];
}

type ResolvedRepository = Extract<ReturnType<typeof resolveGithubRepository>, { status: 'resolved' }>;

export interface EligibleRepositories {
  eligibility: Map<string, string | null>;
  resolved: Map<string, ResolvedRepository>;
}

@Injectable()
export class CloudAgentRunScopeService {
  private readonly githubFactory: GithubClientFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repositories: GithubRepositoryResolver,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
    @Optional() @Inject(GITHUB_CLIENT_FACTORY) githubFactory?: GithubClientFactory,
  ) {
    this.githubFactory = githubFactory ?? defaultGithubFactory;
  }

  /** One read: which repositories may be used, and how each eligible one resolves on GitHub. */
  async eligibleRepositories(workspaceId: string): Promise<EligibleRepositories> {
    const eligibility = new Map<string, string | null>();
    const resolved = new Map<string, ResolvedRepository>();
    for (const { repo, resolution } of await this.repositories.eligibility(workspaceId)) {
      if (!repo.intentRepoKey) continue;
      eligibility.set(repo.intentRepoKey, resolution.status === 'resolved' ? null : resolution.reason);
      if (resolution.status === 'resolved') resolved.set(repo.intentRepoKey, resolution);
    }
    return { eligibility, resolved };
  }

  /** Each named base must be a valid branch name that exists in its repository; unknown repositories are `validate`'s. */
  async baseBranchErrors(proposal: ProposeScope, resolved: Map<string, ResolvedRepository>): Promise<string[]> {
    const checks = proposal.repositories.map(async ({ key, baseBranch }): Promise<string | null> => {
      const repository = resolved.get(key);
      if (!baseBranch || !repository) return null;
      // GitHub's 404 refuses any other bad name, and the runner checks every name with git before using it.
      if (baseBranch.startsWith('-')) return `${key}: "${baseBranch}" is not a valid branch name.`;
      const client = connectorClient(this.githubFactory, repository.connector);
      try {
        await withRetries(
          () => client.getBranch(repository.owner, repository.name, baseBranch),
          transientGithub,
          // Inside the agent's propose_scope call: short waits, like the Jira reads inside a claim.
          (attempt, retryAfterMs) => Math.min(retryAfterMs ?? 1_000 * attempt, 5_000),
        );
        return null;
      } catch (error) {
        return error instanceof GithubApiError && error.status === 404
          ? `${key}: the base branch "${baseBranch}" does not exist.`
          : `${key}: GitHub could not confirm the base branch "${baseBranch}"; propose again.`;
      }
    });
    return (await Promise.all(checks)).filter((error) => error !== null);
  }

  async eligibility(workspaceId: string): Promise<Map<string, string | null>> {
    return (await this.eligibleRepositories(workspaceId)).eligibility;
  }

  validate(
    proposal: ProposeScope,
    context: { eligibility: Map<string, string | null>; seeds: string[]; maxRepositories: number; branch: string },
  ): string[] {
    const errors: string[] = [];
    const keys = proposal.repositories.map((repository) => repository.key);
    if (keys.length === 0) errors.push('Propose at least one repository.');
    const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
    if (duplicates.length) errors.push(`List each repository once: ${duplicates.join(', ')}.`);
    if (new Set(keys).size > context.maxRepositories) {
      errors.push(
        `This run allows at most ${context.maxRepositories} repositories; the proposal has ${new Set(keys).size}.`,
      );
    }
    for (const key of new Set(keys)) {
      if (!context.eligibility.has(key)) {
        errors.push(
          `Repository "${key}" is not a repository key of this workspace. Use the durable keys the Coredoc MCP reports.`,
        );
      } else if (context.eligibility.get(key)) {
        errors.push(`Repository "${key}" is not eligible for agent runs (${context.eligibility.get(key)}).`);
      }
    }
    const dropped = new Set(proposal.droppedSeeds.map((seed) => seed.key));
    for (const seed of context.seeds) {
      if (!keys.includes(seed) && !dropped.has(seed)) {
        errors.push(`Seed repository "${seed}" must be included or listed in droppedSeeds with a reason.`);
      }
    }
    if (
      proposal.mergeOrder.length &&
      (proposal.mergeOrder.length !== new Set(keys).size || !proposal.mergeOrder.every((key) => keys.includes(key)))
    ) {
      errors.push('mergeOrder must list every proposed repository exactly once.');
    }
    for (const repository of proposal.repositories) {
      if (repository.baseBranch === context.branch) {
        errors.push(`${repository.key}: the base branch cannot be this run's own branch ${context.branch}.`);
      }
    }
    if (Buffer.byteLength(proposal.specMarkdown, 'utf8') > MAX_SPEC_MARKDOWN_BYTES) {
      errors.push('The spec markdown is larger than 256 KiB; shorten it.');
    }
    return errors;
  }

  /** Replaces an earlier draft of the same turn. */
  async saveDraft(tx: Tx, run: CloudAgentRun, turnId: string, proposal: ProposeScope, at: Date): Promise<number> {
    const order = proposal.mergeOrder.length ? proposal.mergeOrder : proposal.repositories.map((r) => r.key);
    const content: SpecContent = {
      repositories: proposal.repositories.map((repository) => ({
        ...repository,
        mergeOrder: order.indexOf(repository.key),
        eligible: true,
        ineligibleReason: null,
      })),
      risks: proposal.risks,
      intentReferences: proposal.intentReferences,
      assumptions: proposal.assumptions,
      droppedSeeds: proposal.droppedSeeds,
      candidates: proposal.candidates,
    };
    content.repositories.sort((a, b) => a.mergeOrder - b.mergeOrder);
    const data = {
      title: proposal.title,
      summary: proposal.summary,
      markdown: proposal.specMarkdown,
      content: content as unknown as Prisma.InputJsonObject,
      proposedAt: at,
    };
    const draft = await tx.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId: run.workspaceId, runId: run.id, turnId, status: SpecStatus.Draft },
    });
    if (draft) {
      await tx.cloudAgentRunSpecVersion.update({ where: { id: draft.id }, data });
      return draft.version;
    }
    const last = await tx.cloudAgentRunSpecVersion.aggregate({
      where: { workspaceId: run.workspaceId, runId: run.id },
      _max: { version: true },
    });
    const version = (last._max.version ?? 0) + 1;
    await tx.cloudAgentRunSpecVersion.create({
      data: { workspaceId: run.workspaceId, runId: run.id, turnId, version, status: SpecStatus.Draft, ...data },
    });
    return version;
  }

  /** Automatic acceptance applies only when every repository is still eligible and no PRD candidate is open. */
  async publishDraft(
    tx: Tx,
    run: CloudAgentRun,
    turnId: string,
    eligibility: Map<string, string | null>,
    at: Date,
  ): Promise<boolean> {
    const draft = await tx.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId: run.workspaceId, runId: run.id, turnId, status: SpecStatus.Draft },
    });
    if (!draft) return false;
    const content = draft.content as unknown as SpecContent;
    content.repositories = content.repositories.map((repository) => {
      const reason = eligibility.has(repository.key) ? eligibility.get(repository.key)! : 'repository_not_found';
      return { ...repository, eligible: reason === null, ineligibleReason: reason };
    });
    await tx.cloudAgentRunSpecVersion.updateMany({
      where: { workspaceId: run.workspaceId, runId: run.id, status: SpecStatus.Proposed },
      data: { status: SpecStatus.Superseded },
    });
    const published = await tx.cloudAgentRunSpecVersion.update({
      where: { id: draft.id },
      data: { status: SpecStatus.Proposed, content: content as unknown as Prisma.InputJsonObject },
    });
    const proposedEvent = {
      type: ServerEventType.RunEvent,
      payload: {
        code: RunEventCode.ScopeProposed,
        text: `Scope version ${draft.version} proposed`,
        version: draft.version,
      },
    };
    // The run keeps the latest proposal's assumptions; implement-phase ones come from submit_result.
    const kept = ((Array.isArray(run.assumptions) ? run.assumptions : []) as unknown as RunAssumption[]).filter(
      (assumption) => assumption.phase !== RunPhase.Scope,
    );
    const assumptions = [...kept, ...content.assumptions.map((text) => ({ phase: RunPhase.Scope, text }))];
    await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { assumptions: assumptions as unknown as Prisma.InputJsonArray },
    });
    const automatic =
      run.scopeAcceptancePolicy === ScopeAcceptancePolicy.Automatic &&
      content.repositories.every((repository) => repository.eligible) &&
      content.candidates.length === 0;
    if (automatic) {
      await this.accept(tx, run, published, null, at, [proposedEvent]);
    } else {
      await setRunStatus(tx, run, RunStatus.AwaitingScopeAcceptance, at, { outcomeLessCount: 0 }, [proposedEvent]);
    }
    return true;
  }

  async acceptLatest(workspaceId: string, runId: string, version: number, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      const { run, spec } = await this.reviewable(tx, workspaceId, runId, version);
      await this.accept(tx, run, spec, actorId, this.now());
    });
  }

  async requestChanges(workspaceId: string, runId: string, version: number, actorId: string, text: string) {
    await this.prisma.$transaction(async (tx) => {
      const { run, spec } = await this.reviewable(tx, workspaceId, runId, version);
      const at = this.now();
      await tx.cloudAgentRunSpecVersion.update({
        where: { id: spec.id },
        data: { status: SpecStatus.ChangesRequested, reviewedBy: actorId, reviewedAt: at, reviewText: text },
      });
      const updated = await setRunStatus(tx, run, RunStatus.Scoping, at, { phase: RunPhase.Scope }, [
        {
          type: ServerEventType.RunEvent,
          payload: {
            code: RunEventCode.ChangesRequested,
            text: `Changes requested on scope version ${version}`,
            version,
          },
        },
      ]);
      await queueTurn(
        tx,
        updated,
        RunPhase.Scope,
        `A reviewer requested changes to scope version ${version}:\n\n${text}\n\nRevise the specification and the scope, then call propose_scope again.`,
        at,
      );
    });
  }

  /** Drafts stay hidden. */
  async versions(workspaceId: string, runId: string) {
    const rows = await this.prisma.cloudAgentRunSpecVersion.findMany({
      where: { workspaceId, runId, status: { not: SpecStatus.Draft } },
      orderBy: { version: 'asc' },
    });
    return rows.map(projectSpec);
  }

  async latest(workspaceId: string, runId: string) {
    const row = await this.prisma.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId, runId, status: { not: SpecStatus.Draft } },
      orderBy: { version: 'desc' },
    });
    return row ? projectSpec(row) : null;
  }

  private async reviewable(tx: Tx, workspaceId: string, runId: string, version: number) {
    const run = await lockRun(tx, workspaceId, runId);
    if (!run) {
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
    }
    if (isTerminalRunStatus(run.status)) {
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunTerminal, 'The run has already ended');
    }
    const latest = await tx.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId, runId, status: SpecStatus.Proposed },
      orderBy: { version: 'desc' },
    });
    if (!latest || latest.version !== version) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.SpecVersionStale,
        `Scope version ${version} is not the latest proposed version; reload the run to review the current one`,
      );
    }
    if (run.status !== RunStatus.AwaitingScopeAcceptance) {
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunStateConflict, 'The run is not waiting for scope acceptance');
    }
    return { run, spec: latest };
  }

  /** `reviewer` is null for automatic acceptance. */
  private async accept(
    tx: Tx,
    run: CloudAgentRun,
    spec: CloudAgentRunSpecVersion,
    reviewer: string | null,
    at: Date,
    events: Array<{ type: string; payload: Record<string, unknown> }> = [],
  ) {
    await tx.cloudAgentRunSpecVersion.update({
      where: { id: spec.id },
      data: { status: SpecStatus.Accepted, reviewedBy: reviewer, reviewedAt: at, autoAccepted: reviewer === null },
    });
    const content = spec.content as unknown as SpecContent;
    const seedOrigin = run.trigger === RunTrigger.JiraLabel ? 'label' : 'manual';
    const repositories: RunRepository[] = content.repositories.map((repository) => ({
      key: repository.key,
      reason: repository.reason,
      mergeOrder: repository.mergeOrder,
      origin: run.seeds.includes(repository.key) ? seedOrigin : 'proposal',
      eligible: repository.eligible,
      branchCreated: false,
      touched: false,
      lastPushedHead: null,
      notBuiltOrTested: null,
      baseBranch: repository.baseBranch ?? null,
    }));
    const updated = await setRunStatus(
      tx,
      run,
      RunStatus.Implementing,
      at,
      {
        phase: RunPhase.Implement,
        outcomeLessCount: 0,
        repositories: repositories as unknown as Prisma.InputJsonArray,
        droppedSeeds: content.droppedSeeds as unknown as Prisma.InputJsonArray,
      },
      [
        ...events,
        {
          type: ServerEventType.RunEvent,
          payload: {
            code: RunEventCode.ScopeAccepted,
            text: reviewer
              ? `Scope version ${spec.version} accepted`
              : `Scope version ${spec.version} accepted automatically`,
            version: spec.version,
          },
        },
      ],
    );
    await queueTurn(tx, updated, RunPhase.Implement, null, at);
  }
}

export function projectSpec(row: CloudAgentRunSpecVersion) {
  const content = row.content as unknown as SpecContent;
  return {
    version: row.version,
    status: row.status,
    title: row.title,
    summary: row.summary,
    markdown: row.markdown,
    repositories: content.repositories,
    risks: content.risks,
    intentReferences: content.intentReferences,
    assumptions: content.assumptions,
    droppedSeeds: content.droppedSeeds,
    candidates: content.candidates,
    proposedAt: row.proposedAt.toISOString(),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewText: row.reviewText,
    autoAccepted: row.autoAccepted,
  };
}
