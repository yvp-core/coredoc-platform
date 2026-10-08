import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AssignedRepository,
  MAX_WORKFLOW_DIFF_BYTES,
  type RepositoryReport,
  type SubmitResult,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import type { RunAssumption, RunRepository } from './cloud-agent-run-scope.service.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  RunEventCode,
  RunFailureCode,
  RunPhase,
  RunStatus,
  ServerEventType,
  SpecStatus,
  TurnOutcome,
} from './run-states.js';
import { appendRunEvents, type NewRunEvent, type Tx } from './run-store.js';
import { failRun, queueTurn, setRunStatus } from './run-transitions.js';

/** A run-level condition a claim re-checks; the run fails with the code instead of getting the turn. */
export class RunCheckFailure extends Error {
  constructor(
    readonly code: typeof RunFailureCode.RepositoryNotEligible,
    reason: string,
  ) {
    super(reason);
    this.name = 'RunCheckFailure';
  }
}

/** The adopted `submit_result` the run page and delivery read. */
export interface RunResult {
  summary: string;
  repositories: Array<{ key: string; summary: string }>;
  notes: string;
}

/** Room for the event's other fields around a withheld workflow diff. */
const WORKFLOW_EVENT_OVERHEAD_BYTES = 8 * 1024;

export function runRepositories(run: Pick<CloudAgentRun, 'repositories'>): RunRepository[] {
  return (Array.isArray(run.repositories) ? run.repositories : []) as unknown as RunRepository[];
}

/**
 * The implement phase on the server: what a claim hands the runner (clone
 * URLs, the run branch, the accepted spec), branch reservations, the stored
 * `submit_result`, and what the completion transaction records from the
 * end-of-turn push.
 */
@Injectable()
export class CloudAgentRunImplementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: GithubRepositoryResolver,
  ) {}

  /**
   * The repositories a turn may touch, through the shared resolver: the run's
   * repositories in implement turns (one that stopped resolving fails the
   * run), its seeds in scope turns (for the runner's bot permission check).
   */
  async repositoriesFor(run: CloudAgentRun, kind: string): Promise<AssignedRepository[]> {
    if (kind === RunPhase.Implement) {
      const repositories = [...runRepositories(run)].sort((a, b) => a.mergeOrder - b.mergeOrder);
      const assigned: AssignedRepository[] = [];
      for (const repository of repositories) {
        const resolved = await this.resolve(run.workspaceId, repository.key);
        if (typeof resolved === 'string') {
          throw new RunCheckFailure(
            RunFailureCode.RepositoryNotEligible,
            `Repository ${repository.key} can no longer be used (${resolved}).`,
          );
        }
        assigned.push({
          key: repository.key,
          reason: repository.reason,
          mergeOrder: repository.mergeOrder,
          ...resolved,
          branchCreated: repository.branchCreated,
          withheldPaths: repository.withheldPaths ?? [],
        });
      }
      return assigned;
    }
    if (kind !== RunPhase.Scope) return [];
    const seeds: AssignedRepository[] = [];
    for (const [index, key] of run.seeds.entries()) {
      // Seeds were validated at creation; one that stopped resolving is the proposal's problem.
      const resolved = await this.resolve(run.workspaceId, key);
      if (typeof resolved === 'string') continue;
      seeds.push({
        key,
        reason: 'Named up front',
        mergeOrder: index,
        ...resolved,
        branchCreated: false,
        withheldPaths: [],
      });
    }
    return seeds;
  }

  /** The accepted spec and its acceptance record, which the plugin's implement route takes as approval. */
  async acceptedSpec(run: CloudAgentRun): Promise<TurnAssignment['acceptedSpec']> {
    const spec = await this.prisma.cloudAgentRunSpecVersion.findFirst({
      where: { workspaceId: run.workspaceId, runId: run.id, status: SpecStatus.Accepted },
      orderBy: { version: 'desc' },
    });
    if (!spec) return null;
    const reviewer = spec.reviewedBy
      ? await this.prisma.workspaceMember.findFirst({
          where: { workspaceId: run.workspaceId, userId: spec.reviewedBy },
          select: { email: true },
        })
      : null;
    return {
      version: spec.version,
      markdown: spec.markdown,
      acceptedBy: spec.reviewedBy ? (reviewer?.email ?? spec.reviewedBy) : null,
      acceptedAt: (spec.reviewedAt ?? spec.proposedAt).toISOString(),
      digest: createHash('sha256').update(spec.markdown).digest('hex'),
    };
  }

  /** Rules a `submit_result` must meet; each goes back to the agent to fix. */
  validateResult(run: CloudAgentRun, result: SubmitResult): string[] {
    const keys = new Set(runRepositories(run).map((repository) => repository.key));
    const unknown = [
      ...result.repositories.map((repository) => repository.key),
      ...result.notBuiltOrTested.map((repository) => repository.key),
    ].filter((key) => !keys.has(key));
    return [...new Set(unknown)].map(
      (key) => `Repository "${key}" is not one of this run's repositories (${[...keys].join(', ')}).`,
    );
  }

  /** Stored on the turn; the completion transaction adopts it. A repeated call replaces it. */
  async saveResult(tx: Tx, turnId: string, result: SubmitResult): Promise<void> {
    await tx.cloudAgentRunTurn.update({
      where: { id: turnId },
      data: { result: result as unknown as Prisma.InputJsonObject },
    });
  }

  /** Records that this run creates the run branch in a repository, before the runner's first push there. */
  async reserveBranch(tx: Tx, run: CloudAgentRun, key: string): Promise<void> {
    const repositories = runRepositories(run);
    const repository = repositories.find((candidate) => candidate.key === key);
    if (!repository) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.UnknownRepository,
        `Repository ${key} is not one of this run's repositories`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (repository.branchCreated) return;
    repository.branchCreated = true;
    await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { repositories: repositories as unknown as Prisma.InputJsonArray },
    });
  }

  /** Runner reports are untrusted: only this run's repositories, and pushes only to branches it reserved. */
  validateReports(run: CloudAgentRun, reports: RepositoryReport[]): void {
    const byKey = new Map(runRepositories(run).map((repository) => [repository.key, repository]));
    const seen = new Set<string>();
    for (const report of reports) {
      const repository = byKey.get(report.key);
      let problem: string | null = null;
      if (!repository) problem = `Repository ${report.key} is not one of this run's repositories`;
      else if (seen.has(report.key)) problem = `Repository ${report.key} is reported twice`;
      else if (report.pushedHead && !repository.branchCreated) {
        problem = `Repository ${report.key} reports a push to a run branch this run never reserved`;
      }
      if (problem) throw cloudAgentRunError(CloudAgentRunErrorCode.InvalidReport, problem, HttpStatus.BAD_REQUEST);
      seen.add(report.key);
    }
  }

  /**
   * Records the end-of-turn push: a reported head on a reserved run branch
   * marks the repository touched. Withheld paths replace the previous turn's;
   * a withheld workflow diff goes on the timeline with its larger cap.
   */
  async recordReports(
    tx: Tx,
    run: CloudAgentRun,
    turnId: string,
    reports: RepositoryReport[],
    at: Date,
  ): Promise<CloudAgentRun> {
    if (reports.length === 0) return run;
    const repositories = runRepositories(run);
    const events: NewRunEvent[] = [];
    for (const report of reports) {
      const repository = repositories.find((candidate) => candidate.key === report.key)!;
      repository.withheldPaths = report.withheldPaths;
      repository.binaryPaths = report.binaryPaths;
      if (report.pushedHead && report.pushedHead !== repository.lastPushedHead) {
        repository.touched = true;
        repository.lastPushedHead = report.pushedHead;
        events.push({
          type: ServerEventType.RunEvent,
          payload: {
            code: RunEventCode.BranchPushed,
            text: `Pushed ${run.branch} in ${report.key}`,
            repository: report.key,
            branch: run.branch,
            head: report.pushedHead,
          },
        });
      }
      if (report.workflowDiff) {
        const { paths, note } = report.workflowDiff;
        const fits =
          report.workflowDiff.diff !== null && Buffer.byteLength(report.workflowDiff.diff) <= MAX_WORKFLOW_DIFF_BYTES;
        events.push({
          type: ServerEventType.RunEvent,
          payload: {
            code: RunEventCode.WorkflowDiffWithheld,
            text: `Workflow changes in ${report.key} were withheld from the push for a person to apply`,
            repository: report.key,
            paths,
            diff: fits ? report.workflowDiff.diff : null,
            note: fits ? note : (note ?? 'The diff is larger than 64 KiB, so only the paths are shown.'),
          },
          maxPayloadBytes: MAX_WORKFLOW_DIFF_BYTES + WORKFLOW_EVENT_OVERHEAD_BYTES,
        });
      }
    }
    await appendRunEvents(tx, { workspaceId: run.workspaceId, runId: run.id, turnId }, events, at);
    return tx.cloudAgentRun.update({
      where: { id: run.id },
      data: { repositories: repositories as unknown as Prisma.InputJsonArray },
    });
  }

  /**
   * An implement turn that recorded `submit_result`: the run adopts the
   * result and moves to delivery when a repository was touched, or fails
   * with `no_changes`. Null when the turn recorded no result.
   */
  async settleResult(tx: Tx, run: CloudAgentRun, turnId: string, at: Date): Promise<string | null> {
    const turn = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turnId }, select: { result: true } });
    if (!turn.result) return null;
    const result = turn.result as unknown as SubmitResult;
    const repositories = runRepositories(run).map((repository) => ({
      ...repository,
      notBuiltOrTested: result.notBuiltOrTested.find((entry) => entry.key === repository.key)?.reason ?? null,
    }));
    const assumptions = [
      ...((Array.isArray(run.assumptions) ? run.assumptions : []) as unknown as RunAssumption[]),
      ...result.assumptions.map((text) => ({ phase: RunPhase.Implement, text })),
    ];
    const adopted: RunResult = { summary: result.summary, repositories: result.repositories, notes: result.notes };
    const updated = await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: {
        result: adopted as unknown as Prisma.InputJsonObject,
        repositories: repositories as unknown as Prisma.InputJsonArray,
        assumptions: assumptions as unknown as Prisma.InputJsonArray,
        outcomeLessCount: 0,
      },
    });
    if (!repositories.some((repository) => repository.touched)) {
      await failRun(tx, updated, RunFailureCode.NoChanges, null, at);
      return RunFailureCode.NoChanges;
    }
    const delivering = await setRunStatus(tx, updated, RunStatus.Delivering, at, { phase: RunPhase.Delivery });
    await queueTurn(tx, delivering, RunPhase.Delivery, null, at);
    return TurnOutcome.ResultSubmitted;
  }

  /** A repository key through the shared resolver: its clone URL and API coordinates, or why it does not resolve. */
  async resolve(workspaceId: string, key: string): Promise<Pick<AssignedRepository, 'cloneUrl' | 'github'> | string> {
    try {
      const resolved = await this.resolver.resolve(workspaceId, key);
      return {
        cloneUrl: resolved.cloneUrl,
        github: { apiBaseUrl: resolved.apiBaseUrl, owner: resolved.owner, name: resolved.name },
      };
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
