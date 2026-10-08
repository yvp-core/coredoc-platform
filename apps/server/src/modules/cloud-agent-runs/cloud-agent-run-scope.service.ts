import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { ProposeScope } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, CloudAgentRunSpecVersion, Prisma } from '../../generated/prisma/client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  isTerminalRunStatus,
  RunEventCode,
  RunPhase,
  RunStatus,
  RunTrigger,
  ServerEventType,
  SpecStatus,
} from './run-states.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { lockRun, queueTurn, setRunStatus } from './run-transitions.js';

/** Spec markdown cap, in bytes (the contract caps characters). */
const MAX_SPEC_MARKDOWN_BYTES = 256 * 1024;

export interface SpecRepository {
  key: string;
  reason: string;
  changes: string;
  mergeOrder: number;
  eligible: boolean;
  /** Why the shared resolver refused it, when it did. */
  ineligibleReason: string | null;
}

export interface SpecContent {
  repositories: SpecRepository[];
  risks: string[];
  intentReferences: string[];
  assumptions: string[];
  droppedSeeds: Array<{ key: string; reason: string }>;
  candidates: Array<{ question: string; blocks: string }>;
}

/** A run repository; implement, delivery and the run page read these. */
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
}

/**
 * The scope phase: `propose_scope` validation and drafts, publication at turn
 * completion, and a person's accept or change request.
 */
@Injectable()
export class CloudAgentRunScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repositories: GithubRepositoryResolver,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /** Eligibility of every durable repository key in the workspace, through the shared resolver. */
  async eligibility(workspaceId: string): Promise<Map<string, string | null>> {
    const rows = await this.repositories.eligibility(workspaceId);
    const byKey = new Map<string, string | null>();
    for (const { repo, resolution } of rows) {
      if (!repo.intentRepoKey) continue;
      byKey.set(repo.intentRepoKey, resolution.status === 'resolved' ? null : resolution.reason);
    }
    return byKey;
  }

  /** The rules a proposal must meet; each broken rule goes back to the agent to fix. */
  validate(
    proposal: ProposeScope,
    context: { eligibility: Map<string, string | null>; seeds: string[]; maxRepositories: number },
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
    if (Buffer.byteLength(proposal.specMarkdown, 'utf8') > MAX_SPEC_MARKDOWN_BYTES) {
      errors.push('The spec markdown is larger than 256 KiB; shorten it.');
    }
    return errors;
  }

  /** Stores the turn's proposal as its draft version, replacing an earlier draft of the same turn. */
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
      where: { runId: run.id, turnId, status: SpecStatus.Draft },
    });
    if (draft) {
      await tx.cloudAgentRunSpecVersion.update({ where: { id: draft.id }, data });
      return draft.version;
    }
    const last = await tx.cloudAgentRunSpecVersion.aggregate({ where: { runId: run.id }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    await tx.cloudAgentRunSpecVersion.create({
      data: { workspaceId: run.workspaceId, runId: run.id, turnId, version, status: SpecStatus.Draft, ...data },
    });
    return version;
  }

  /**
   * At scope-turn completion: publish the turn's draft. Automatic acceptance
   * applies only when every repository is still eligible and no candidate for
   * the PRD is open; otherwise a person reviews it. Returns false without a draft.
   */
  async publishDraft(
    tx: Tx,
    run: CloudAgentRun,
    turnId: string,
    eligibility: Map<string, string | null>,
    at: Date,
  ): Promise<boolean> {
    const draft = await tx.cloudAgentRunSpecVersion.findFirst({
      where: { runId: run.id, turnId, status: SpecStatus.Draft },
    });
    if (!draft) return false;
    const content = draft.content as unknown as SpecContent;
    content.repositories = content.repositories.map((repository) => {
      const reason = eligibility.has(repository.key) ? eligibility.get(repository.key)! : 'repository_not_found';
      return { ...repository, eligible: reason === null, ineligibleReason: reason };
    });
    await tx.cloudAgentRunSpecVersion.updateMany({
      where: { runId: run.id, status: SpecStatus.Proposed },
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
    const automatic =
      run.scopeAcceptancePolicy === 'automatic' &&
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

  /** Every published version, oldest first; drafts stay hidden. */
  async versions(workspaceId: string, runId: string) {
    const rows = await this.prisma.cloudAgentRunSpecVersion.findMany({
      where: { workspaceId, runId, status: { not: SpecStatus.Draft } },
      orderBy: { version: 'asc' },
    });
    return rows.map(projectSpec);
  }

  async latest(runId: string) {
    const row = await this.prisma.cloudAgentRunSpecVersion.findFirst({
      where: { runId, status: { not: SpecStatus.Draft } },
      orderBy: { version: 'desc' },
    });
    return row ? projectSpec(row) : null;
  }

  private async reviewable(tx: Tx, workspaceId: string, runId: string, version: number) {
    const run = await lockRun(tx, runId);
    if (!run || run.workspaceId !== workspaceId) {
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
    }
    if (isTerminalRunStatus(run.status)) {
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunTerminal, 'The run has already ended');
    }
    const latest = await tx.cloudAgentRunSpecVersion.findFirst({
      where: { runId, status: SpecStatus.Proposed },
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

  /** Accept a version (a person's, or the system's when `reviewer` is null) and queue the first implement turn. */
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
