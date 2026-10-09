import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AgentRunSettings } from '../../generated/prisma/client.js';
import { AGENT_RUNNER_TOKEN_PERMISSIONS } from '../../auth/token-permissions.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import type { UpdateSettingsInput } from './cloud-agent-runs.contract.js';
import { CloudAgentRunErrorCode, cloudAgentRunError, RunnerRefusal } from './run-states.js';
import { CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock } from './run-store.js';

const ADMIN_ROLES = new Set(['admin', 'owner']);

/** Settings a workspace has before an admin ever saves them (the table's column defaults). */
function defaultSettings(workspaceId: string): AgentRunSettings {
  return {
    workspaceId,
    enabled: false,
    runOwnerId: null,
    triggerLabel: 'coredoc-agent',
    doneStatusId: null,
    doneStatusName: null,
    questionsPolicy: 'pause',
    scopeAcceptancePolicy: 'required',
    maxSpendUsd: 25,
    maxTurnDurationSeconds: 3 * 3600,
    maxActiveSeconds: 24 * 3600,
    waitingLimitSeconds: 7 * 86_400,
    maxStartedRuns: 2,
    maxRepositories: 5,
    model: null,
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
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async get(workspaceId: string): Promise<AgentRunSettings> {
    return (await this.prisma.agentRunSettings.findUnique({ where: { workspaceId } })) ?? defaultSettings(workspaceId);
  }

  /**
   * Switching on needs agent runs to be available, and records the caller as
   * run owner; so does an explicit takeover. Saving anything else never
   * changes the owner.
   */
  async update(workspaceId: string, actorId: string, input: UpdateSettingsInput) {
    const { enabled, takeOverOwnership, doneStatus, ...values } = input;
    const before = await this.get(workspaceId);
    if (enabled === true && !before.enabled) {
      const availability = await this.availability.check(workspaceId, before);
      if (!availability.available) {
        throw cloudAgentRunError(
          CloudAgentRunErrorCode.AgentRunsUnavailable,
          `Agent runs cannot be switched on: ${availability.reasons.map((reason) => reason.message).join(' ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.agentRunSettings.findUnique({ where: { workspaceId } });
      const switchingOn = enabled === true && !current?.enabled;
      const runOwnerId = switchingOn || takeOverOwnership ? actorId : (current?.runOwnerId ?? null);
      const data = {
        ...values,
        ...(enabled === undefined ? {} : { enabled }),
        ...(doneStatus === undefined
          ? {}
          : { doneStatusId: doneStatus?.id ?? null, doneStatusName: doneStatus?.name ?? null }),
        runOwnerId,
        updatedBy: actorId,
        updatedAt: this.now(),
      };
      await tx.agentRunSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    });
    return this.view(workspaceId);
  }

  /**
   * The settings page: values, availability and trigger readiness with
   * reasons, the run owner with its validity, every runner token with its last
   * report, and the repositories with their keys and eligibility.
   */
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
          select: { userId: true, email: true, role: true, pending: true },
        })
      ).map((member) => [member.userId, member]),
    );
    const owner = settings.runOwnerId ? members.get(settings.runOwnerId) : undefined;

    return {
      enabled: settings.enabled,
      runOwner: settings.runOwnerId
        ? {
            userId: settings.runOwnerId,
            email: owner?.email ?? null,
            // Jira-triggered runs need a current, non-pending member to act as.
            valid: Boolean(owner && !owner.pending),
          }
        : null,
      triggerLabel: settings.triggerLabel,
      doneStatus: settings.doneStatusId ? { id: settings.doneStatusId, name: settings.doneStatusName } : null,
      questionsPolicy: settings.questionsPolicy,
      scopeAcceptancePolicy: settings.scopeAcceptancePolicy,
      maxSpendUsd: settings.maxSpendUsd,
      maxTurnDurationSeconds: settings.maxTurnDurationSeconds,
      maxActiveSeconds: settings.maxActiveSeconds,
      waitingLimitSeconds: settings.waitingLimitSeconds,
      maxStartedRuns: settings.maxStartedRuns,
      maxRepositories: settings.maxRepositories,
      model: settings.model,
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
              ? seen.lastAction === 'startup_check'
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
