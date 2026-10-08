/**
 * State-advancing writes shared by the run and turn services. Each runs
 * inside the caller's transaction, after the caller locked the run row.
 */
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import {
  FAILURE_MESSAGES,
  isTerminalRunStatus,
  type RunFailureCode,
  RunStatus,
  ServerEventType,
  TurnState,
} from './run-states.js';
import { appendRunEvents, type NewRunEvent, type Tx } from './run-store.js';

const WAITING_STATUSES: readonly string[] = [RunStatus.AwaitingAnswer, RunStatus.AwaitingScopeAcceptance];

/**
 * Locks the run row for the rest of the transaction; every state-advancing
 * write starts here. Scoped by workspace: a run of another workspace is
 * neither locked nor returned.
 */
export async function lockRun(tx: Tx, workspaceId: string, runId: string): Promise<CloudAgentRun | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM cloud_agent_runs WHERE id = ${runId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
  if (!rows[0]) return null;
  return tx.cloudAgentRun.findFirstOrThrow({ where: { id: runId, workspaceId } });
}

/**
 * Move the run to `to`, keeping the active-time clock: time counts from
 * leaving `queued` and stops while the run waits for a person.
 */
export async function setRunStatus(
  tx: Tx,
  run: CloudAgentRun,
  to: string,
  at: Date,
  data: Record<string, unknown> = {},
  events: NewRunEvent[] = [],
): Promise<CloudAgentRun> {
  const wasActive = run.activeSince !== null;
  const nowActive = !WAITING_STATUSES.includes(to) && !isTerminalRunStatus(to) && to !== RunStatus.Queued;
  const elapsed = wasActive ? Math.max(0, Math.floor((at.getTime() - run.activeSince!.getTime()) / 1000)) : 0;
  const updated = await tx.cloudAgentRun.update({
    where: { id: run.id },
    data: {
      status: to,
      activeSeconds: run.activeSeconds + (wasActive && !nowActive ? elapsed : 0),
      activeSince: nowActive ? (wasActive ? run.activeSince : at) : null,
      waitingSince: WAITING_STATUSES.includes(to) ? at : null,
      ...(isTerminalRunStatus(to) ? { finishedAt: at } : {}),
      ...data,
    },
  });
  await appendRunEvents(
    tx,
    { workspaceId: run.workspaceId, runId: run.id },
    [...events, { type: ServerEventType.StatusChanged, payload: { from: run.status, to } }],
    at,
  );
  return updated;
}

/** Deletes the per-turn MCP tokens of these turns. */
export async function deleteTurnTokens(tx: Tx, turnIds: string[]): Promise<void> {
  if (turnIds.length) await tx.serviceToken.deleteMany({ where: { owningTurnId: { in: turnIds } } });
}

/**
 * Fail the run: record the code, abandon its queued or claimed turn and
 * delete that turn's MCP token, so nothing restarts it.
 */
export async function failRun(
  tx: Tx,
  run: CloudAgentRun,
  code: RunFailureCode,
  reason: string | null,
  at: Date,
): Promise<void> {
  if (isTerminalRunStatus(run.status)) return;
  const pending = await tx.cloudAgentRunTurn.findMany({
    where: { runId: run.id, state: { in: [TurnState.Queued, TurnState.Claimed] } },
    select: { id: true },
  });
  await tx.cloudAgentRunTurn.updateMany({
    where: { id: { in: pending.map((turn) => turn.id) } },
    data: { state: TurnState.Abandoned },
  });
  await deleteTurnTokens(
    tx,
    pending.map((turn) => turn.id),
  );
  await setRunStatus(tx, run, RunStatus.Failed, at, {
    failureCode: code,
    failureReason: (reason ?? FAILURE_MESSAGES[code]).slice(0, 2_000),
  });
}

/**
 * Queue the run's next turn unless one is already queued or claimed; a turn
 * still completing queues it from the stored decision instead.
 */
export async function queueTurn(
  tx: Tx,
  run: CloudAgentRun,
  kind: string,
  inputText: string | null,
  at: Date,
): Promise<boolean> {
  const pending = await tx.cloudAgentRunTurn.count({
    where: { runId: run.id, state: { in: [TurnState.Queued, TurnState.Claimed] } },
  });
  if (pending > 0) return false;
  const last = await tx.cloudAgentRunTurn.aggregate({ where: { runId: run.id }, _max: { ordinal: true } });
  await tx.cloudAgentRunTurn.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      ordinal: (last._max.ordinal ?? 0) + 1,
      kind,
      inputText,
      createdAt: at,
    },
  });
  return true;
}
