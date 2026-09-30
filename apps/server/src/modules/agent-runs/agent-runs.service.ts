import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { DesktopAgentRun } from '../../generated/prisma/client.js';
import type { CreateAgentRunInput } from './agent-runs.contract.js';

/** Server-derived attribution — the authenticated principal, never the payload. */
export interface AgentRunIdentity {
  userId: string | undefined;
  userEmail: string | undefined;
}

export interface AgentRunTotals {
  runs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  toolCalls: number;
  interventions: number;
}

export interface WorkspaceAgentRuns {
  totals: AgentRunTotals;
  runs: DesktopAgentRun[];
}

@Injectable()
export class AgentRunsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent ingest: upsert on the `(workspaceId, runId)` unique key so a
   * client retry of the same run never double-counts. Identity is passed in by
   * the controller (server-derived); the DTO carries only economics.
   */
  async record(workspaceId: string, dto: CreateAgentRunInput, identity: AgentRunIdentity): Promise<void> {
    const data = {
      kind: dto.kind,
      userId: identity.userId ?? null,
      userEmail: identity.userEmail ?? null,
      tokensIn: dto.tokensIn,
      tokensOut: dto.tokensOut,
      costUsd: dto.costUsd,
      turns: dto.turns,
      toolCalls: dto.toolCalls,
      interventions: dto.interventions,
      outcome: dto.outcome,
      durationMs: dto.durationMs,
      appVersion: dto.appVersion ?? null,
      surface: dto.surface ?? null,
    };
    await this.prisma.desktopAgentRun.upsert({
      where: { workspaceId_runId: { workspaceId, runId: dto.runId } },
      create: { workspaceId, runId: dto.runId, ...data },
      update: data,
    });
  }

  /**
   * One aggregate (workspace totals) + the last 50 runs newest-first. No
   * time-bucketing until a dashboard needs it (YAGNI).
   */
  async getWorkspaceAgentRuns(workspaceId: string): Promise<WorkspaceAgentRuns> {
    const [agg, runs] = await Promise.all([
      this.prisma.desktopAgentRun.aggregate({
        where: { workspaceId },
        _count: { _all: true },
        _sum: {
          costUsd: true,
          tokensIn: true,
          tokensOut: true,
          turns: true,
          toolCalls: true,
          interventions: true,
        },
      }),
      this.prisma.desktopAgentRun.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      totals: {
        runs: agg._count._all,
        costUsd: agg._sum.costUsd ?? 0,
        tokensIn: agg._sum.tokensIn ?? 0,
        tokensOut: agg._sum.tokensOut ?? 0,
        turns: agg._sum.turns ?? 0,
        toolCalls: agg._sum.toolCalls ?? 0,
        interventions: agg._sum.interventions ?? 0,
      },
      runs,
    };
  }
}
