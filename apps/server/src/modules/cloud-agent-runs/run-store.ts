/**
 * Transaction-level building blocks shared by the run and turn services:
 * the creation lock, timeline appends and the injected clock.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { redactPayload } from './redact-secrets.js';

/** Injected `() => Date`, so lease expiry and time limits are testable without real time. */
export const CLOUD_AGENT_RUNS_CLOCK = Symbol('CLOUD_AGENT_RUNS_CLOCK');
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export type Tx = Prisma.TransactionClient;

/**
 * Serialises run creation (and, later, promotion) per workspace across every
 * API and worker process. Its own key namespace: the bare workspace-id key is
 * the shared repository and graph lock.
 */
export async function lockCloudAgentRunCreation(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':cloud-agent-runs', 0))`;
}

/** Payloads above this are stored as a truncated preview with the `truncated` flag. */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

export interface NewRunEvent {
  type: string;
  payload: Record<string, unknown>;
  /** A larger cap for this event; withheld workflow diffs get 64 KiB. */
  maxPayloadBytes?: number;
}

function boundedPayload(
  payload: Record<string, unknown>,
  cap = MAX_EVENT_PAYLOAD_BYTES,
): { payload: Prisma.InputJsonObject; truncated: boolean } {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') <= cap) {
    return { payload: payload as Prisma.InputJsonObject, truncated: false };
  }
  // Keep a readable prefix; the cut is by characters, then trimmed until it fits.
  let preview = json.slice(0, cap - 256);
  while (Buffer.byteLength(preview, 'utf8') > cap - 256) preview = preview.slice(0, -256);
  return { payload: { preview }, truncated: true };
}

/**
 * Append events to a run's timeline with the next sequence numbers, redacted
 * and size-capped. The
 * counter lives on the run row, so concurrent appends to one run serialise on
 * that row and sequences never collide.
 */
export async function appendRunEvents(
  tx: Tx,
  run: { workspaceId: string; runId: string; turnId?: string | null },
  events: readonly NewRunEvent[],
  at: Date,
): Promise<number[]> {
  if (events.length === 0) return [];
  const updated = await tx.cloudAgentRun.update({
    where: { id: run.runId },
    data: { lastEventSeq: { increment: events.length } },
    select: { lastEventSeq: true },
  });
  const first = updated.lastEventSeq - events.length + 1;
  const seqs = events.map((_, index) => first + index);
  await tx.cloudAgentRunEvent.createMany({
    data: events.map((event, index) => ({
      workspaceId: run.workspaceId,
      runId: run.runId,
      turnId: run.turnId ?? null,
      seq: seqs[index]!,
      type: event.type,
      // Redacted before the cap, so a cut never splits a secret past its pattern.
      ...boundedPayload(redactPayload(event.payload), event.maxPayloadBytes),
      createdAt: at,
    })),
  });
  return seqs;
}
