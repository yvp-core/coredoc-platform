import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { AgentRunSettings } from '../../generated/prisma/client.js';
import { AGENT_RUNNER_TOKEN_PERMISSIONS } from '../../auth/token-permissions.js';
import type { UpdateSettingsInput } from './cloud-agent-runs.contract.js';
import { RunnerRefusal } from './run-states.js';
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
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async get(workspaceId: string): Promise<AgentRunSettings> {
    return (await this.prisma.agentRunSettings.findUnique({ where: { workspaceId } })) ?? defaultSettings(workspaceId);
  }

  /**
   * Switching on records the caller as run owner; so does an explicit takeover.
   * Saving anything else never changes the owner.
   */
  async update(workspaceId: string, actorId: string, input: UpdateSettingsInput) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.agentRunSettings.findUnique({ where: { workspaceId } });
      const switchingOn = input.enabled === true && !current?.enabled;
      const runOwnerId = switchingOn || input.takeOverOwnership ? actorId : (current?.runOwnerId ?? null);
      const data = {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        runOwnerId,
        updatedBy: actorId,
        updatedAt: this.now(),
      };
      await tx.agentRunSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    });
    return this.view(workspaceId);
  }

  /** The settings page: values, the run owner with its validity, and every runner token with its last report. */
  async view(workspaceId: string) {
    const settings = await this.get(workspaceId);
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
      runnerTokens: tokens.map((token) => {
        const creator = members.get(token.createdBy);
        const seen = token.runnerSeen;
        const refusal =
          !creator || !ADMIN_ROLES.has(creator.role)
            ? RunnerRefusal.CreatorNotAdmin
            : seen?.refusedReason
              ? RunnerRefusal.RunnerIncompatible
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
