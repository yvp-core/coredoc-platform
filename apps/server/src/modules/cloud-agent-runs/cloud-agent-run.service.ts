import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AgentRunSettings, CloudAgentRun, CloudAgentRunTurn } from '../../generated/prisma/client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { normalizeJiraBaseUrl } from '../delivery/jira-client.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunQuestionService } from './cloud-agent-run-questions.service.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import { REPOSITORY_LABEL_PREFIX, resolveSeeds, seedKeysFromLabels } from './cloud-agent-run-seeds.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import type { StartRunInput } from './cloud-agent-runs.contract.js';
import {
  cloudAgentRunError,
  CloudAgentRunErrorCode,
  fromColumn,
  isTerminalRunStatus,
  QuestionsPolicy,
  QuestionState,
  RunFailureCode,
  RunTrigger,
  ScopeAcceptancePolicy,
  TERMINAL_RUN_STATUSES,
  TurnState,
} from './run-states.js';
import { createRun, type NewRun, promoteQueuedRuns } from './run-queue.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, lockCloudAgentRunCreation, systemClock, type Tx } from './run-store.js';
import { cancelRun, lockRun } from './run-transitions.js';

const PENDING_TURN_STATES = [TurnState.Queued, TurnState.Claimed];

/** Transactions under the creation lock wait for other creators, never for outside calls. */
const CREATION_TRANSACTION = { maxWait: 5_000, timeout: 10_000 };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

type RunWithTurn = CloudAgentRun & { turns: CloudAgentRunTurn[] };

export interface TriggeredIssue {
  id: string;
  key: string;
  labels: string[];
}

type SeedOutcome = { seeds: string[]; failure?: { code: RunFailureCode; reason: string } };

@Injectable()
export class CloudAgentRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CloudAgentRunSettingsService,
    private readonly issues: CloudAgentRunIssueResolver,
    private readonly scope: CloudAgentRunScopeService,
    private readonly availability: CloudAgentRunAvailability,
    private readonly repositories: GithubRepositoryResolver,
    private readonly questions: CloudAgentRunQuestionService,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async start(workspaceId: string, actorId: string, input: StartRunInput) {
    const settings = await this.startableSettings(workspaceId);
    const issue = await this.issues.resolve(workspaceId, input.issueKey);
    const seeds = await this.manualSeeds(workspaceId, input.repositoryKeys ?? [], settings.maxRepositories);

    const runId = await this.createLocked(workspaceId, issue.issueKey, async (tx) => {
      await this.refuseOpenRun(tx, workspaceId, issue.issueId, issue.issueKey);
      return this.createAndPromote(tx, workspaceId, settings, {
        jiraIssueId: issue.issueId,
        issueKey: issue.issueKey,
        jiraConnectorId: issue.jiraConnectorId,
        trigger: RunTrigger.Manual,
        startedBy: actorId,
        runOwnerId: actorId,
        questionsPolicy: input.questionsPolicy ?? fromColumn(QuestionsPolicy, settings.questionsPolicy),
        scopeAcceptancePolicy:
          input.scopeAcceptancePolicy ?? fromColumn(ScopeAcceptancePolicy, settings.scopeAcceptancePolicy),
        seeds,
      });
    });
    return this.detail(workspaceId, runId);
  }

  /** Policies and seeds come from the previous run; budgets and the model from current settings. */
  async rerun(workspaceId: string, actorId: string, previousRunId: string) {
    const settings = await this.startableSettings(workspaceId);
    const previous = await this.prisma.cloudAgentRun.findFirst({ where: { id: previousRunId, workspaceId } });
    if (!previous) throw runNotFound();

    const runId = await this.createLocked(workspaceId, previous.issueKey, async (tx) => {
      const current = await tx.cloudAgentRun.findUniqueOrThrow({
        where: { id: previous.id },
        select: { status: true },
      });
      if (!isTerminalRunStatus(current.status)) {
        throw cloudAgentRunError(
          CloudAgentRunErrorCode.RunNotTerminal,
          'Only a done, failed or cancelled run can be re-run',
        );
      }
      await this.refuseOpenRun(tx, workspaceId, previous.jiraIssueId, previous.issueKey);
      return this.createAndPromote(tx, workspaceId, settings, {
        jiraIssueId: previous.jiraIssueId,
        issueKey: previous.issueKey,
        jiraConnectorId: previous.jiraConnectorId,
        trigger: RunTrigger.Rerun,
        startedBy: actorId,
        runOwnerId: actorId,
        previousRunId: previous.id,
        questionsPolicy: fromColumn(QuestionsPolicy, previous.questionsPolicy),
        scopeAcceptancePolicy: fromColumn(ScopeAcceptancePolicy, previous.scopeAcceptancePolicy),
        seeds: previous.seeds,
      });
    });
    return this.detail(workspaceId, runId);
  }

  /**
   * Only when the issue never had a run in this workspace. Invalid seed labels
   * create the run `failed`, so the label never retries it.
   */
  async createFromJira(
    workspaceId: string,
    settings: AgentRunSettings & { runOwnerId: string },
    jiraConnectorId: string,
    issue: TriggeredIssue,
  ): Promise<boolean> {
    const outcome = await this.labelSeeds(workspaceId, seedKeysFromLabels(issue.labels), settings.maxRepositories);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCloudAgentRunCreation(tx, workspaceId);
        const existing = await tx.cloudAgentRun.findFirst({
          where: { workspaceId, jiraIssueId: issue.id },
          select: { id: true },
        });
        if (existing) return false;
        await this.createAndPromote(tx, workspaceId, settings, {
          jiraIssueId: issue.id,
          issueKey: issue.key,
          jiraConnectorId,
          trigger: RunTrigger.JiraLabel,
          startedBy: null,
          runOwnerId: settings.runOwnerId,
          questionsPolicy: fromColumn(QuestionsPolicy, settings.questionsPolicy),
          scopeAcceptancePolicy: fromColumn(ScopeAcceptancePolicy, settings.scopeAcceptancePolicy),
          ...outcome,
        });
        return true;
      }, CREATION_TRANSACTION);
    } catch (error) {
      // The partial unique index backs the locked check up.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** The caller has checked that runs may start. */
  async promote(workspaceId: string, settings: AgentRunSettings): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      await lockCloudAgentRunCreation(tx, workspaceId);
      return promoteQueuedRuns(tx, workspaceId, settings, this.now());
    }, CREATION_TRANSACTION);
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
    const questions = await this.questions.forRun(workspaceId, run.id);
    return {
      ...this.project(run, await this.memberEmails(workspaceId, [run.runOwnerId])),
      issueUrl: await this.issueUrl(run),
      seeds: run.seeds,
      repositories: run.repositories,
      droppedSeeds: run.droppedSeeds,
      assumptions: run.assumptions,
      result: run.result,
      pullRequests: run.pullRequests,
      jiraOutcome: run.jiraOutcome,
      latestSpec: await this.scope.latest(workspaceId, run.id),
      openQuestion: questions.find((question) => question.state === QuestionState.Open) ?? null,
      questions,
    };
  }

  private async issueUrl(run: CloudAgentRun): Promise<string | null> {
    const connector = await this.prisma.deliveryConnector.findFirst({
      where: {
        workspaceId: run.workspaceId,
        provider: 'jira',
        ...(run.jiraConnectorId ? { id: run.jiraConnectorId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { baseUrl: true },
    });
    if (!connector?.baseUrl) return null;
    try {
      return `${normalizeJiraBaseUrl(connector.baseUrl)}/browse/${encodeURIComponent(run.issueKey)}`;
    } catch {
      return null;
    }
  }

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

  async cancel(workspaceId: string, runId: string) {
    await this.prisma.$transaction(async (tx) => {
      const run = await lockRun(tx, workspaceId, runId);
      if (!run) throw runNotFound();
      if (isTerminalRunStatus(run.status)) {
        throw cloudAgentRunError(CloudAgentRunErrorCode.RunTerminal, 'This run has already ended');
      }
      await cancelRun(tx, run, this.now());
    });
    return this.detail(workspaceId, runId);
  }

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
      select: { seq: true, turnId: true, type: true, payload: true, truncated: true, createdAt: true },
    });
    return {
      events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
      lastSeq: run.lastEventSeq,
    };
  }

  private async startableSettings(workspaceId: string): Promise<AgentRunSettings> {
    const settings = await this.settings.get(workspaceId);
    if (!settings.enabled) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.AgentRunsDisabled,
        'Agent runs are not enabled for this workspace',
        HttpStatus.BAD_REQUEST,
      );
    }
    const availability = await this.availability.check(workspaceId, settings);
    if (!availability.available) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.AgentRunsUnavailable,
        `Agent runs cannot start: ${availability.reasons.map((reason) => reason.message).join(' ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return settings;
  }

  private async createLocked(workspaceId: string, issueKey: string, create: (tx: Tx) => Promise<string>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCloudAgentRunCreation(tx, workspaceId);
        return create(tx);
      }, CREATION_TRANSACTION);
    } catch (error) {
      // The partial unique index backs the locked check up.
      if (isUniqueViolation(error)) throw activeRunExists(issueKey);
      throw error;
    }
  }

  private async refuseOpenRun(tx: Tx, workspaceId: string, jiraIssueId: string, issueKey: string) {
    const open = await tx.cloudAgentRun.findFirst({
      where: { workspaceId, jiraIssueId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
      select: { id: true },
    });
    if (open) throw activeRunExists(issueKey);
  }

  private async createAndPromote(tx: Tx, workspaceId: string, settings: AgentRunSettings, input: NewRun) {
    const at = this.now();
    const run = await createRun(tx, workspaceId, settings, input, at);
    if (!input.failure) await promoteQueuedRuns(tx, workspaceId, settings, at);
    return run.id;
  }

  /** A manual start's repository keys: unknown, ambiguous or too many refuse; ineligible ones wait for scope review. */
  private async manualSeeds(workspaceId: string, keys: string[], cap: number): Promise<string[]> {
    if (keys.length === 0) return [];
    const resolution = resolveSeeds(keys, await this.repositories.eligibility(workspaceId), cap);
    if (resolution.status === 'too_many') {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.TooManyRepositories,
        `${resolution.count} repositories were named; a run allows ${cap}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (resolution.status !== 'ok') {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.UnknownRepository,
        resolution.status === 'unknown'
          ? `${resolution.key} names no workspace repository`
          : `${resolution.key} matches more than one workspace repository`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return resolution.seeds;
  }

  /** `coredoc-repo:` labels: an unknown, ambiguous or ineligible one, or too many, fail the run at creation. */
  private async labelSeeds(workspaceId: string, keys: string[], cap: number): Promise<SeedOutcome> {
    if (keys.length === 0) return { seeds: [] };
    const resolution = resolveSeeds(keys, await this.repositories.eligibility(workspaceId), cap);
    const label = (key: string) => `${REPOSITORY_LABEL_PREFIX}${key}`;
    const invalid = (reason: string): SeedOutcome => ({
      seeds: [],
      failure: { code: RunFailureCode.InvalidRepositoryLabel, reason },
    });
    switch (resolution.status) {
      case 'too_many':
        return {
          seeds: [],
          failure: {
            code: RunFailureCode.TooManyRepositories,
            reason: `${resolution.count} repository labels are set; a run allows ${cap}.`,
          },
        };
      case 'unknown':
        return invalid(`Label ${label(resolution.key)} names no workspace repository.`);
      case 'ambiguous':
        return invalid(`Label ${label(resolution.key)} matches more than one workspace repository.`);
      case 'ok': {
        const [ineligible] = resolution.ineligible;
        return ineligible
          ? invalid(`Label ${label(ineligible.key)} names a repository that is not eligible (${ineligible.reason}).`)
          : { seeds: resolution.seeds };
      }
    }
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
      previousRunId: run.previousRunId,
      runOwner: { userId: run.runOwnerId, email: emails.get(run.runOwnerId) ?? null },
      questionsPolicy: run.questionsPolicy,
      scopeAcceptancePolicy: run.scopeAcceptancePolicy,
      model: run.model,
      branch: run.branch,
      seeds: run.seeds,
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
