import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, CloudAgentRunTurn } from '../../generated/prisma/client.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import type { StartRunInput } from './cloud-agent-runs.contract.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  RunPhase,
  RunStatus,
  RunTrigger,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
  TurnState,
} from './run-states.js';
import {
  appendRunEvents,
  CLOUD_AGENT_RUNS_CLOCK,
  type Clock,
  lockCloudAgentRunCreation,
  systemClock,
} from './run-store.js';

const PENDING_TURN_STATES = [TurnState.Queued, TurnState.Claimed];

/** Run branch: `coredoc/<KEY>` for an issue's first run, `coredoc/<KEY>-<n>` for later ones. */
function runBranch(issueKey: string, ordinal: number): string {
  return ordinal === 1 ? `coredoc/${issueKey}` : `coredoc/${issueKey}-${ordinal}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

type RunWithTurn = CloudAgentRun & { turns: CloudAgentRunTurn[] };

@Injectable()
export class CloudAgentRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CloudAgentRunSettingsService,
    private readonly issues: CloudAgentRunIssueResolver,
    private readonly scope: CloudAgentRunScopeService,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /**
   * Manual start: a `queued` run acting as the member who started it, promoted
   * at once to `scoping` with its first scope turn queued for a runner.
   */
  async start(workspaceId: string, actorId: string, input: StartRunInput) {
    const settings = await this.settings.get(workspaceId);
    if (!settings.enabled) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.AgentRunsDisabled,
        'Agent runs are not enabled for this workspace',
        HttpStatus.BAD_REQUEST,
      );
    }
    const issue = await this.issues.resolve(workspaceId, input.issueKey);

    let runId: string;
    try {
      runId = await this.prisma.$transaction(
        async (tx) => {
          await lockCloudAgentRunCreation(tx, workspaceId);
          const open = await tx.cloudAgentRun.findFirst({
            where: { workspaceId, jiraIssueId: issue.issueId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
            select: { id: true },
          });
          if (open) throw activeRunExists(issue.issueKey);

          const ordinal = (await tx.cloudAgentRun.count({ where: { workspaceId, jiraIssueId: issue.issueId } })) + 1;
          const at = this.now();
          const run = await tx.cloudAgentRun.create({
            data: {
              workspaceId,
              jiraIssueId: issue.issueId,
              issueKey: issue.issueKey,
              jiraConnectorId: issue.jiraConnectorId,
              trigger: RunTrigger.Manual,
              startedBy: actorId,
              runOwnerId: actorId,
              status: RunStatus.Queued,
              phase: RunPhase.Scope,
              questionsPolicy: input.questionsPolicy ?? settings.questionsPolicy,
              scopeAcceptancePolicy: input.scopeAcceptancePolicy ?? settings.scopeAcceptancePolicy,
              model: settings.model,
              runOrdinal: ordinal,
              branch: runBranch(issue.issueKey, ordinal),
              scopeSessionId: randomUUID(),
              implementSessionId: randomUUID(),
              maxSpendUsd: settings.maxSpendUsd,
              maxActiveSeconds: settings.maxActiveSeconds,
              waitingLimitSeconds: settings.waitingLimitSeconds,
              maxTurnDurationSeconds: settings.maxTurnDurationSeconds,
              maxRepositories: settings.maxRepositories,
              createdAt: at,
            },
          });

          // Promotion. The concurrency limit and oldest-first promotion of
          // waiting runs arrive with the trigger cron (ticket 09).
          await tx.cloudAgentRun.update({
            where: { id: run.id },
            data: { status: RunStatus.Scoping, startedAt: at, activeSince: at },
          });
          await tx.cloudAgentRunTurn.create({
            data: { workspaceId, runId: run.id, ordinal: 1, kind: RunPhase.Scope, createdAt: at },
          });
          await appendRunEvents(
            tx,
            { workspaceId, runId: run.id },
            [
              { type: ServerEventType.StatusChanged, payload: { from: null, to: RunStatus.Queued } },
              { type: ServerEventType.StatusChanged, payload: { from: RunStatus.Queued, to: RunStatus.Scoping } },
            ],
            at,
          );
          return run.id;
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      // The partial unique index backs the locked check up.
      if (isUniqueViolation(error)) throw activeRunExists(issue.issueKey);
      throw error;
    }
    return this.detail(workspaceId, runId);
  }

  async list(workspaceId: string, limit: number, offset: number) {
    const rows = await this.prisma.cloudAgentRun.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: offset,
      include: { turns: { where: { state: { in: PENDING_TURN_STATES } }, take: 1 } },
    });
    const page = rows.slice(0, limit);
    const owners = await this.memberEmails(
      workspaceId,
      page.map((run) => run.runOwnerId),
    );
    return {
      runs: page.map((run) => this.project(run, owners)),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  async detail(workspaceId: string, runId: string) {
    const run = await this.prisma.cloudAgentRun.findFirst({
      where: { id: runId, workspaceId },
      include: { turns: { where: { state: { in: PENDING_TURN_STATES } }, take: 1 } },
    });
    if (!run) throw runNotFound();
    return {
      ...this.project(run, await this.memberEmails(workspaceId, [run.runOwnerId])),
      seeds: run.seeds,
      repositories: run.repositories,
      droppedSeeds: run.droppedSeeds,
      latestSpec: await this.scope.latest(workspaceId, run.id),
    };
  }

  /** Every published spec version of a run, oldest first. */
  async specs(workspaceId: string, runId: string) {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId }, select: { id: true } });
    if (!run) throw runNotFound();
    return { versions: await this.scope.versions(workspaceId, runId) };
  }

  async acceptScope(workspaceId: string, runId: string, version: number, actorId: string) {
    await this.scope.acceptLatest(workspaceId, runId, version, actorId);
    return this.detail(workspaceId, runId);
  }

  async requestScopeChanges(workspaceId: string, runId: string, version: number, actorId: string, text: string) {
    await this.scope.requestChanges(workspaceId, runId, version, actorId, text);
    return this.detail(workspaceId, runId);
  }

  /** Timeline page: events after a sequence number, oldest first. */
  async events(workspaceId: string, runId: string, after: number, limit: number) {
    const run = await this.prisma.cloudAgentRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true, lastEventSeq: true },
    });
    if (!run) throw runNotFound();
    const events = await this.prisma.cloudAgentRunEvent.findMany({
      where: { runId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit,
      select: { seq: true, type: true, payload: true, truncated: true, createdAt: true },
    });
    return {
      events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
      lastSeq: run.lastEventSeq,
    };
  }

  private async memberEmails(workspaceId: string, userIds: string[]): Promise<Map<string, string>> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: [...new Set(userIds)] } },
      select: { userId: true, email: true },
    });
    return new Map(members.map((member) => [member.userId, member.email]));
  }

  private project(run: RunWithTurn, emails: Map<string, string>) {
    const turn = run.turns[0];
    return {
      id: run.id,
      issueKey: run.issueKey,
      status: run.status,
      phase: run.phase,
      trigger: run.trigger,
      startedBy: run.startedBy,
      runOwner: { userId: run.runOwnerId, email: emails.get(run.runOwnerId) ?? null },
      questionsPolicy: run.questionsPolicy,
      scopeAcceptancePolicy: run.scopeAcceptancePolicy,
      model: run.model,
      branch: run.branch,
      failureCode: run.failureCode,
      failureReason: run.failureReason,
      spend: { usd: run.spendUsd, maxUsd: run.maxSpendUsd, unknownTurns: run.unknownSpendTurns },
      currentTurn: turn
        ? {
            id: turn.id,
            kind: turn.kind,
            state: turn.state,
            ordinal: turn.ordinal,
            attempt: turn.attempts,
            queuedAt: turn.createdAt.toISOString(),
            claimedAt: turn.claimedAt?.toISOString() ?? null,
          }
        : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }
}

function activeRunExists(issueKey: string) {
  return cloudAgentRunError(CloudAgentRunErrorCode.ActiveRunExists, `${issueKey} already has an active agent run`);
}

function runNotFound() {
  return cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
}
