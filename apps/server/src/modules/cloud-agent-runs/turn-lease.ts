import { HttpStatus } from '@nestjs/common';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  isTerminalRunStatus,
  type RunPhase,
  type RunStatus,
  TurnState,
} from './run-states.js';
import type { Tx } from './run-store.js';

/** The calling runner: its token and the workspace that token belongs to. */
export interface RunnerPrincipal {
  workspaceId: string;
  tokenId: string;
}

/** A runner request about one turn, fenced on the lease token it presents. */
export interface TurnLease {
  runner: RunnerPrincipal;
  turnId: string;
  token: string;
}

export interface FencedTurn {
  id: string;
  run_id: string;
  workspace_id: string;
  kind: RunPhase;
  state: TurnState;
  lease_token: string | null;
  lease_expires_at: Date | null;
  completed_at: Date | null;
  run_status: RunStatus;
}

/**
 * Where a lease-fenced request stands:
 * - `live`: the lease is this runner's and current;
 * - `stopped`: the turn was abandoned because the run became terminal — the
 *   runner records the turn's own facts and stops;
 * - `completed`: the turn already reported its completion, live or stopped (a
 *   repeated completion is a no-op).
 */
export type FenceResult = { turn: FencedTurn; standing: 'live' | 'stopped' | 'completed' };

/**
 * Every runner request about a turn is checked against the turn row locked
 * for update: unknown turn, another lease, an expired lease or a re-queued
 * turn all get `LEASE_LOST`.
 */
export async function fenceTurn(tx: Tx, { runner, turnId, token }: TurnLease, now: Date): Promise<FenceResult> {
  const rows = await tx.$queryRaw<FencedTurn[]>`
    SELECT t.id, t.run_id, t.workspace_id, t.kind, t.state, t.lease_token::text AS lease_token, t.lease_expires_at,
           t.completed_at, r.status AS run_status
    FROM cloud_agent_run_turns t
    JOIN cloud_agent_runs r ON r.id = t.run_id
    WHERE t.id = ${turnId}::uuid AND t.workspace_id = ${runner.workspaceId}::uuid
    FOR UPDATE OF t`;
  const turn = rows[0];
  if (!turn || turn.lease_token !== token) throw leaseLost();
  if (turn.state === TurnState.Completed || turn.completed_at) return { turn, standing: 'completed' };
  if (turn.state === TurnState.Abandoned || isTerminalRunStatus(turn.run_status)) {
    return { turn, standing: 'stopped' };
  }
  if (turn.state !== TurnState.Claimed || !turn.lease_expires_at || turn.lease_expires_at <= now) {
    throw leaseLost();
  }
  return { turn, standing: 'live' };
}

/** The fenced turn of a request that needs the live lease. */
export async function fenceLiveTurn(tx: Tx, lease: TurnLease, now: Date): Promise<FencedTurn> {
  const { turn, standing } = await fenceTurn(tx, lease, now);
  if (standing !== 'live') throw leaseLost();
  return turn;
}

export function leaseLost() {
  return cloudAgentRunError(
    CloudAgentRunErrorCode.LeaseLost,
    'The lease on this turn is no longer yours; stop the turn',
    HttpStatus.CONFLICT,
  );
}
