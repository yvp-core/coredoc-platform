/**
 * The run sweep's limit jobs: lost runners and the active-time budget. Each
 * item runs in its own transaction and re-checks its condition under the row
 * locks, so concurrent sweeps in several processes act on it once.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRunArchiveStore } from './cloud-agent-run-archive.store.js';
import {
  MAX_TURN_ATTEMPTS,
  QuestionState,
  RunFailureCode,
  RunStatus,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
  TurnOutcome,
  TurnState,
} from './run-states.js';
import { appendRunEvents, type Clock } from './run-store.js';
import { deleteTurnTokens, failRun, lockRun } from './run-transitions.js';

export interface SweepDeps {
  prisma: PrismaService;
  archives: CloudAgentRunArchiveStore;
  now: Clock;
  logger: Logger;
}

/** Rows handled per job and tick; the next tick takes the rest. */
const BATCH = 100;

/**
 * A claimed turn of a live run whose lease expired: its runner is gone. The
 * turn goes back to `queued` with a new lease token, so the lost runner's
 * requests get `LEASE_LOST`, and its MCP token and any archive it uploaded
 * are deleted. The third expiry (attempts are counted at claim) abandons the
 * turn and fails the run. A turn that parked a question is left to the
 * parked-turn job, which completes it as paused.
 */
export async function expireLeases(deps: SweepDeps): Promise<void> {
  const at = deps.now();
  const due = await deps.prisma.$queryRaw<Array<{ id: string; run_id: string; workspace_id: string }>>`
    SELECT t.id, t.run_id, t.workspace_id
    FROM cloud_agent_run_turns t
    JOIN cloud_agent_runs r ON r.id = t.run_id
    WHERE t.state = ${TurnState.Claimed}
      AND t.lease_expires_at <= ${at}
      AND r.status <> ALL(${[...TERMINAL_RUN_STATUSES]}::text[])
    ORDER BY t.lease_expires_at, t.id
    LIMIT ${BATCH}`;
  for (const turn of due) {
    try {
      const orphan = await expireLease(deps, turn.workspace_id, turn.run_id, turn.id);
      if (orphan) await deps.archives.delete(orphan).catch(() => undefined);
    } catch (error) {
      deps.logger.error(`Could not expire the lease of turn ${turn.id}: ${(error as Error).message}`);
    }
  }
}

/** Returns the lost attempt's archive key, deleted after the transaction commits. */
async function expireLease(deps: SweepDeps, workspaceId: string, runId: string, turnId: string) {
  const at = deps.now();
  return deps.prisma.$transaction(async (tx) => {
    // Lock order as in the runner API: the turn, then the run.
    const locked = await tx.$queryRaw<Array<{ state: string; lease_expires_at: Date | null }>>`
      SELECT state, lease_expires_at FROM cloud_agent_run_turns WHERE id = ${turnId}::uuid FOR UPDATE`;
    const turn = locked[0];
    if (!turn || turn.state !== TurnState.Claimed || !turn.lease_expires_at || turn.lease_expires_at > at) {
      return null;
    }
    const run = await lockRun(tx, workspaceId, runId);
    if (!run || (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return null;
    const parked = await tx.cloudAgentRunQuestion.count({
      where: {
        askedInTurnId: turnId,
        OR: [{ state: QuestionState.Open }, { state: QuestionState.Answered, resumeTurnId: null }],
      },
    });
    if (parked > 0) return null;

    const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turnId } });
    await deleteTurnTokens(tx, [turnId]);
    await appendRunEvents(
      tx,
      { workspaceId, runId, turnId },
      [{ type: ServerEventType.TurnEnded, payload: { outcome: TurnOutcome.RunnerLost, spendUsd: null } }],
      at,
    );
    if (row.attempts >= MAX_TURN_ATTEMPTS) {
      await failRun(tx, run, RunFailureCode.RunnerLost, null, at);
    } else {
      await tx.cloudAgentRunTurn.update({
        where: { id: turnId },
        data: { state: TurnState.Queued, leaseToken: randomUUID(), leaseExpiresAt: null },
      });
    }
    // The run never adopted the lost attempt's archive; the next attempt starts from the previous one.
    if (row.stateArchiveKey) {
      await tx.cloudAgentRunTurn.update({ where: { id: turnId }, data: { stateArchiveKey: null } });
    }
    return row.stateArchiveKey;
  });
}

const ACTIVE_STATUSES = [RunStatus.Scoping, RunStatus.Implementing, RunStatus.Delivering];

/**
 * A run whose active time reached its budget fails with
 * `wall_clock_exceeded`. Active time excludes waiting for a person and
 * includes waiting for a runner.
 */
export async function expireActiveTime(deps: SweepDeps): Promise<void> {
  const at = deps.now();
  const due = await deps.prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
    SELECT id, workspace_id
    FROM cloud_agent_runs
    WHERE status = ANY(${ACTIVE_STATUSES}::text[])
      AND active_since IS NOT NULL
      AND active_seconds + EXTRACT(EPOCH FROM (${at}::timestamptz - active_since)) >= max_active_seconds
    ORDER BY active_since, id
    LIMIT ${BATCH}`;
  for (const { id, workspace_id: workspaceId } of due) {
    try {
      await deps.prisma.$transaction(async (tx) => {
        const run = await lockRun(tx, workspaceId, id);
        if (!run || !run.activeSince || !(ACTIVE_STATUSES as readonly string[]).includes(run.status)) return;
        const active = run.activeSeconds + (at.getTime() - run.activeSince.getTime()) / 1000;
        if (active < run.maxActiveSeconds) return;
        await failRun(tx, run, RunFailureCode.WallClockExceeded, null, at);
      });
    } catch (error) {
      deps.logger.error(`Could not end run ${id} at its active-time limit: ${(error as Error).message}`);
    }
  }
}
