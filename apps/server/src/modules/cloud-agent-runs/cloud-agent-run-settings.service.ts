import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { CONNECTORS_CONFIG, type ConnectorsConfig, configFromEnv } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AgentRunSettings } from '../../generated/prisma/client.js';
import { agentGoogleFor } from '../../libs/google/agent-google.js';
import { AGENT_RUNNER_TOKEN_PERMISSIONS } from '../../auth/token-permissions.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';
import type { UpdateSettingsInput } from './cloud-agent-runs.contract.js';
import { canActAsRunOwner } from './run-checks.js';
import { QuestionsPolicy, RunnerRefusal, RunnerSeenAction, ScopeAcceptancePolicy } from './run-states.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock } from './run-store.js';

const ADMIN_ROLES = new Set(['admin', 'owner']);

/** Settings a workspace has before an admin ever saves them (the table's column defaults). */
function defaultSettings(workspaceId: string): AgentRunSettings {
  return {
    workspaceId,
    enabled: false,
    runOwnerId: null,
    triggerLabel: 'coredoc-agent',
    startedStatus: null,
    doneStatus: null,
    failedStatus: null,
    cancelledStatus: null,
    scopeQuestionsPolicy: QuestionsPolicy.Pause,
    implementQuestionsPolicy: QuestionsPolicy.Pause,
    scopeAcceptancePolicy: ScopeAcceptancePolicy.Required,
    maxSpendUsd: 25,
    maxTurnDurationSeconds: 3 * 3600,
    maxActiveSeconds: 24 * 3600,
    waitingLimitSeconds: 7 * 86_400,
    maxStartedRuns: 2,
    maxRepositories: 5,
    model: null,
    workflowAccess: {},
    updatedBy: null,
    updatedAt: new Date(0),
  };
}

@Injectable()
export class CloudAgentRunSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: CloudAgentRunAvailability,
    private readonly repositories: GithubRepositoryResolver,
    private readonly jira: CloudAgentRunJiraConnector,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
    @Optional()
    @Inject(CONNECTORS_CONFIG)
    private readonly connectors: ConnectorsConfig = configFromEnv().connectors,
  ) {}

  async get(workspaceId: string): Promise<AgentRunSettings> {
    return (await this.prisma.agentRunSettings.findUnique({ where: { workspaceId } })) ?? defaultSettings(workspaceId);
  }

  /**
   * `enabled` is not settable here: an operator switches agent runs on for a
   * workspace in the database. Only an explicit takeover changes the run owner.
   */
  async update(workspaceId: string, actorId: string, input: UpdateSettingsInput) {
    const { takeOverOwnership, ...values } = input;
    await this.refuseUnknownMembers(workspaceId, values.workflowAccess);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.agentRunSettings.findUnique({ where: { workspaceId } });
      const data = {
        ...values,
        runOwnerId: takeOverOwnership ? actorId : (current?.runOwnerId ?? null),
        updatedBy: actorId,
        updatedAt: this.now(),
      };
      await tx.agentRunSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    });
    return this.view(workspaceId);
  }

  private async refuseUnknownMembers(workspaceId: string, access: UpdateSettingsInput['workflowAccess']) {
    const named = [...new Set(Object.values(access ?? {}).flatMap((rule) => ('members' in rule ? rule.members : [])))];
    if (named.length === 0) return;
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: named }, pending: false },
      select: { userId: true },
    });
    const known = new Set(members.map((member) => member.userId));
    const unknown = named.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new BadRequestException(`workflowAccess names users who are not workspace members: ${unknown.join(', ')}`);
    }
  }

  /** From the connector's Delivery analytics status map. */
  async jiraStatuses(workspaceId: string): Promise<{ statuses: string[] }> {
    const state = await this.jira.state(workspaceId);
    if (state.status === 'missing') return { statuses: [] };
    const rows = await this.prisma.deliveryStatusMap.findMany({
      where: { workspaceId, connectorId: state.connector.id },
      select: { statusRaw: true },
    });
    const statuses = [...new Set(rows.map((row) => row.statusRaw))];
    return { statuses: statuses.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) };
  }

  async view(workspaceId: string) {
    const settings = await this.get(workspaceId);
    const [availability, repositories] = await Promise.all([
      this.availability.check(workspaceId, settings),
      this.repositories.eligibility(workspaceId),
    ]);
    const tokens = await this.prisma.serviceToken.findMany({
      where: { workspaceId, owningTurnId: null, permissions: { equals: [...AGENT_RUNNER_TOKEN_PERMISSIONS] } },
      orderBy: { createdAt: 'asc' },
      include: { runnerSeen: true },
    });
    const memberIds = [...new Set([settings.runOwnerId, ...tokens.map((token) => token.createdBy)])].filter(
      (id): id is string => Boolean(id),
    );
    const members = new Map(
      (
        await this.prisma.workspaceMember.findMany({
          where: { workspaceId, userId: { in: memberIds } },
          select: {
            userId: true,
            email: true,
            pending: true,
            bindings: { where: { resourceType: 'workspace' }, select: { role: true } },
          },
        })
      ).map(({ bindings, ...member }) => [member.userId, { ...member, role: bindings[0]?.role ?? '' }]),
    );
    const owner = settings.runOwnerId ? members.get(settings.runOwnerId) : undefined;
    const google = agentGoogleFor(this.connectors, workspaceId);

    return {
      enabled: settings.enabled,
      runOwner: settings.runOwnerId
        ? {
            userId: settings.runOwnerId,
            email: owner?.email ?? null,
            // Jira-triggered runs need a current, non-pending member to act as.
            valid: canActAsRunOwner(owner),
          }
        : null,
      triggerLabel: settings.triggerLabel,
      startedStatus: settings.startedStatus,
      doneStatus: settings.doneStatus,
      failedStatus: settings.failedStatus,
      cancelledStatus: settings.cancelledStatus,
      scopeQuestionsPolicy: settings.scopeQuestionsPolicy,
      implementQuestionsPolicy: settings.implementQuestionsPolicy,
      scopeAcceptancePolicy: settings.scopeAcceptancePolicy,
      maxSpendUsd: settings.maxSpendUsd,
      maxTurnDurationSeconds: settings.maxTurnDurationSeconds,
      maxActiveSeconds: settings.maxActiveSeconds,
      waitingLimitSeconds: settings.waitingLimitSeconds,
      maxStartedRuns: settings.maxStartedRuns,
      maxRepositories: settings.maxRepositories,
      model: settings.model,
      workflowAccess: settings.workflowAccess,
      google: { configured: google !== null, sharedDriveId: google?.sharedDriveId ?? null },
      availability: { available: availability.available, reasons: availability.reasons },
      trigger: availability.trigger,
      repositories: repositories
        .map(({ repo, resolution }) => ({
          key: repo.intentRepoKey,
          name: repo.repoName,
          eligible: resolution.status === 'resolved',
          reason: resolution.status === 'resolved' ? null : resolution.reason,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      runnerTokens: tokens.map((token) => {
        const creator = members.get(token.createdBy);
        const seen = token.runnerSeen;
        const refusal =
          !creator || !ADMIN_ROLES.has(creator.role)
            ? RunnerRefusal.CreatorNotAdmin
            : seen?.refusedReason
              ? seen.lastAction === RunnerSeenAction.StartupCheck
                ? RunnerRefusal.StartupCheckFailed
                : RunnerRefusal.RunnerIncompatible
              : null;
        return {
          id: token.id,
          name: token.name,
          tokenPrefix: token.tokenPrefix,
          createdBy: token.createdBy,
          createdByEmail: creator?.email ?? null,
          createdAt: token.createdAt.toISOString(),
          lastSeenAt: seen?.lastSeenAt.toISOString() ?? null,
          lastAction: seen?.lastAction ?? null,
          protocolVersion: seen?.protocolVersion ?? null,
          versions: seen?.versions ?? null,
          refusal,
          refusalDetail: seen?.refusedReason ?? null,
        };
      }),
    };
  }
}
