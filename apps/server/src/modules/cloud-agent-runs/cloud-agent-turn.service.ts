import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  type ClaimRequest,
  type CompleteTurnRequest,
  type CompleteTurnResponse,
  type EventBatch,
  type EventBatchResponse,
  type HeartbeatResponse,
  type RunnerVersions,
  SUPPORTED_RUNNER_PROTOCOL_VERSIONS,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  isTerminalRunStatus,
  RunPhase,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
  TurnOutcome,
  TurnState,
} from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';

/** A claim's lease; the runner heartbeats every 20 s, so this tolerates several missed beats. */
export const LEASE_MS = 2 * 60_000;

/** The calling runner: its token and the workspace that token belongs to. */
export interface RunnerPrincipal {
  workspaceId: string;
  tokenId: string;
}

interface ClaimedRow {
  id: string;
  run_id: string;
  kind: string;
  ordinal: number;
  attempts: number;
  input_text: string | null;
  lease_token: string;
  lease_expires_at: Date;
}

interface FencedTurn {
  id: string;
  run_id: string;
  workspace_id: string;
  state: string;
  lease_token: string | null;
  lease_expires_at: Date | null;
  run_status: string;
}

/**
 * Where a lease-fenced request stands:
 * - `live`: the lease is this runner's and current;
 * - `stopped`: the turn was abandoned because the run became terminal — the
 *   runner records the turn's own facts and stops;
 * - `completed`: the turn already completed (a repeated completion is a no-op).
 */
type FenceResult = { turn: FencedTurn; standing: 'live' | 'stopped' | 'completed' };

@Injectable()
export class CloudAgentTurnService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /** Oldest queued turn of a non-terminal run in the runner's workspace, or null. */
  async claim(runner: RunnerPrincipal, request: ClaimRequest): Promise<TurnAssignment | null> {
    if (!SUPPORTED_RUNNER_PROTOCOL_VERSIONS.includes(request.protocolVersion)) {
      const reason = `Protocol version ${request.protocolVersion} is not supported; this server supports ${SUPPORTED_RUNNER_PROTOCOL_VERSIONS.join(', ')}`;
      await this.recordSeen(runner, 'claim', request.protocolVersion, request.versions, reason);
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunnerIncompatible, reason);
    }

    const at = this.now();
    const assignment = await this.prisma.$transaction(async (tx) => {
      // One statement: a skip-locked pick plus the lease, so two runners never
      // claim the same turn and neither waits on the other's row.
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        WITH next AS (
          SELECT t.id
          FROM cloud_agent_run_turns t
          JOIN cloud_agent_runs r ON r.id = t.run_id
          WHERE t.workspace_id = ${runner.workspaceId}::uuid
            AND t.state = ${TurnState.Queued}
            AND r.status <> ALL(${[...TERMINAL_RUN_STATUSES]}::text[])
          ORDER BY t.created_at, t.id
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED
        )
        UPDATE cloud_agent_run_turns t
        SET state = ${TurnState.Claimed},
            attempts = t.attempts + 1,
            lease_token = gen_random_uuid(),
            lease_expires_at = ${new Date(at.getTime() + LEASE_MS)},
            claimed_by_token_id = ${runner.tokenId}::uuid,
            claimed_at = ${at},
            runner_versions = ${JSON.stringify(request.versions)}::jsonb
        FROM next
        WHERE t.id = next.id
        RETURNING t.id, t.run_id, t.kind, t.ordinal, t.attempts, t.input_text, t.lease_token::text AS lease_token,
                  t.lease_expires_at`;
      const claimed = rows[0];
      if (!claimed) return null;

      const run = await tx.cloudAgentRun.findUniqueOrThrow({ where: { id: claimed.run_id } });
      await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: run.id, turnId: claimed.id },
        [
          {
            type: ServerEventType.TurnStarted,
            payload: { kind: claimed.kind, attempt: claimed.attempts, versions: request.versions },
          },
        ],
        at,
      );
      return {
        turn: {
          id: claimed.id,
          kind: claimed.kind as TurnAssignment['turn']['kind'],
          ordinal: claimed.ordinal,
          attempt: claimed.attempts,
          inputText: claimed.input_text,
        },
        lease: { token: claimed.lease_token, expiresAt: claimed.lease_expires_at.toISOString() },
        run: {
          id: run.id,
          issueKey: run.issueKey,
          questionsPolicy: run.questionsPolicy as TurnAssignment['run']['questionsPolicy'],
          scopeAcceptancePolicy: run.scopeAcceptancePolicy as TurnAssignment['run']['scopeAcceptancePolicy'],
          model: run.model,
          sessionId: run.phase === RunPhase.Implement ? run.implementSessionId : run.scopeSessionId,
          remainingSpendUsd: Math.max(0, run.maxSpendUsd - run.spendUsd),
          maxTurnDurationSeconds: run.maxTurnDurationSeconds,
        },
      } satisfies TurnAssignment;
    });

    await this.recordSeen(runner, 'claim', request.protocolVersion, request.versions, null);
    return assignment;
  }

  async heartbeat(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    versions: RunnerVersions,
  ): Promise<HeartbeatResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing !== 'live') {
        return { stop: true, leaseExpiresAt: (turn.lease_expires_at ?? this.now()).toISOString() };
      }
      const expiresAt = new Date(this.now().getTime() + LEASE_MS);
      await tx.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { leaseExpiresAt: expiresAt } });
      return { stop: false, leaseExpiresAt: expiresAt.toISOString() };
    });
    if (!result.stop) await this.recordSeen(runner, 'heartbeat', null, versions, null);
    return result;
  }

  async recordEvents(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    batch: EventBatch,
  ): Promise<EventBatchResponse> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') throw leaseLost();
      // Events are the turn's own facts, so a stopped turn still records them.
      const seqs = await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: turn.run_id, turnId: turn.id },
        batch.events.map(({ type, ...payload }) => ({ type, payload })),
        this.now(),
      );
      return { seqs, stop: standing === 'stopped' };
    });
  }

  /**
   * The completion transaction. With no run-control calls recorded yet, a
   * completed turn records its spend and ends without an outcome; the nudge
   * rule and the next status arrive with the phases that produce outcomes.
   */
  async complete(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    request: CompleteTurnRequest,
  ): Promise<CompleteTurnResponse> {
    await this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') return;

      const at = this.now();
      const spend = request.spend;
      await tx.cloudAgentRunTurn.update({
        where: { id: turn.id },
        data: {
          // A stopped (abandoned) turn keeps its state; it only gains its facts.
          ...(standing === 'live' ? { state: TurnState.Completed } : {}),
          outcome: TurnOutcome.NoOutcome,
          spendUsd: spend?.costUsd ?? null,
          runnerVersions: request.versions as Prisma.InputJsonObject,
          completedAt: at,
        },
      });
      await tx.cloudAgentRun.update({
        where: { id: turn.run_id },
        data: {
          ...(spend
            ? { spendUsd: { increment: spend.costUsd }, agentTurns: { increment: spend.sdkTurns ?? 0 } }
            : { unknownSpendTurns: { increment: 1 } }),
          lastTurnEndedAt: at,
        },
      });
      await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: turn.run_id, turnId: turn.id },
        [
          {
            type: ServerEventType.TurnEnded,
            payload: { outcome: TurnOutcome.NoOutcome, spendUsd: spend?.costUsd ?? null },
          },
        ],
        at,
      );
    });
    return { completed: true };
  }

  /**
   * Every runner request about a turn is checked against the turn row locked
   * for update: unknown turn, another lease, an expired lease or a re-queued
   * turn all get `LEASE_LOST`.
   */
  private async fence(tx: Tx, runner: RunnerPrincipal, turnId: string, leaseToken: string): Promise<FenceResult> {
    const rows = await tx.$queryRaw<FencedTurn[]>`
      SELECT t.id, t.run_id, t.workspace_id, t.state, t.lease_token::text AS lease_token, t.lease_expires_at,
             r.status AS run_status
      FROM cloud_agent_run_turns t
      JOIN cloud_agent_runs r ON r.id = t.run_id
      WHERE t.id = ${turnId}::uuid AND t.workspace_id = ${runner.workspaceId}::uuid
      FOR UPDATE OF t`;
    const turn = rows[0];
    if (!turn || turn.lease_token !== leaseToken) throw leaseLost();
    if (turn.state === TurnState.Completed) return { turn, standing: 'completed' };
    if (turn.state === TurnState.Abandoned || isTerminalRunStatus(turn.run_status)) {
      return { turn, standing: 'stopped' };
    }
    if (turn.state !== TurnState.Claimed || !turn.lease_expires_at || turn.lease_expires_at <= this.now()) {
      throw leaseLost();
    }
    return { turn, standing: 'live' };
  }

  /**
   * Settings show each runner token's last successful claim or heartbeat with
   * its versions, or why it was refused.
   */
  private async recordSeen(
    runner: RunnerPrincipal,
    action: 'claim' | 'heartbeat',
    protocolVersion: number | null,
    versions: RunnerVersions,
    refusedReason: string | null,
  ): Promise<void> {
    const at = this.now();
    const data = {
      lastSeenAt: at,
      lastAction: action,
      versions: versions as Prisma.InputJsonObject,
      refusedReason,
      ...(protocolVersion === null ? {} : { protocolVersion }),
    };
    await this.prisma.agentRunnerSeen.upsert({
      where: { serviceTokenId: runner.tokenId },
      create: {
        serviceTokenId: runner.tokenId,
        workspaceId: runner.workspaceId,
        protocolVersion: protocolVersion ?? 0,
        ...data,
      },
      update: data,
    });
  }
}

function leaseLost() {
  return cloudAgentRunError(
    CloudAgentRunErrorCode.LeaseLost,
    'The lease on this turn is no longer yours; stop the turn',
    HttpStatus.CONFLICT,
  );
}
