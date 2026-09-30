import type {
  PushJob,
  PushJobAttempt,
  PushJobAttemptStatus,
  PushJobStatus,
  PushJobType,
} from '../../../generated/prisma/client.js';
import type { JobProgress } from '../../../libs/pipeline/push-execution.types.js';

export interface JobAttemptResponse {
  id: string;
  attemptNumber: number;
  status: PushJobAttemptStatus;
  phase: string | null;
  progress: JobProgress | null;
  startedAt: Date;
  heartbeatAt: Date;
  finishedAt: Date | null;
  lastError: string | null;
  phaseTimings: unknown;
}

/**
 * Public response shape for GET /workspaces/:id/jobs/:jobId and the list
 * endpoint. Documented in `docs/superpowers/specs/2026-05-23-async-push-queue-design.md`
 * §6.3 / §6.4. Deliberately omits:
 *   - `payload`         — for legacy-path pushes this is the full ParsedRepo
 *                          (megabytes) and EmbeddingsOutput vectors; over-disclosure
 *                          to workspace members on every status poll.
 *   - `queuedByUserId`  — internal actor identifier not documented in the contract.
 */
export interface JobResponse {
  id: string;
  workspaceId: string;
  repoName: string | null;
  type: PushJobType;
  status: PushJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: unknown;
  heartbeatAt: Date | null;
  phase: string | null;
  progress: JobProgress | null;
  attemptHistory?: JobAttemptResponse[];
}

const PRIVATE_RESULT_KEYS = new Set(['r2Key']);

export function publicJobResult(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => publicJobResult(entry, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PRIVATE_RESULT_KEYS.has(key)) output[key] = publicJobResult(entry, seen);
  }
  seen.delete(value);
  return output;
}

export function toJobResponse(row: PushJob & { attemptHistory?: PushJobAttempt[] }): JobResponse {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repoName: row.repoName,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    result: publicJobResult(row.result),
    heartbeatAt: row.heartbeatAt,
    phase: row.phase,
    progress: row.progress as unknown as JobProgress | null,
    ...(row.attemptHistory
      ? {
          attemptHistory: row.attemptHistory.map((attempt) => ({
            id: attempt.id,
            attemptNumber: attempt.attemptNumber,
            status: attempt.status,
            phase: attempt.phase,
            progress: attempt.progress as unknown as JobProgress | null,
            startedAt: attempt.startedAt,
            heartbeatAt: attempt.heartbeatAt,
            finishedAt: attempt.finishedAt,
            lastError: attempt.lastError,
            phaseTimings: attempt.phaseTimings,
          })),
        }
      : {}),
  };
}
