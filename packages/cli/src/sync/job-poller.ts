/**
 * Poll a set of job ids until every one is in a terminal state, or until the
 * optional timeout elapses. Pure-ish: HTTP calls flow through the injected
 * `getJob` so tests don't need a server.
 *
 * A `getJob` returning `null` is treated as a permanent "missing" state after
 * `missingTolerance` consecutive observations (default 1 — definitive
 * immediately). Without this, a deleted/rolled-back job would keep `pending`
 * non-empty forever, hanging CI when `timeoutMs` is also unset.
 */

import type { JobResponse, JobStatus } from './workspace-api.js';

export interface PollOptions {
  getJob: (workspaceId: string, jobId: string) => Promise<JobResponse | null>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** How many consecutive null observations before we declare a job 'missing'. Default 1. */
  missingTolerance?: number;
  /** Called once per poll cycle with a snapshot. UI hook for `--wait`. */
  onTick?: (snapshot: Map<string, JobResponse | null>) => void;
}

export interface PollResult {
  terminal: JobResponse[];
  failedJobIds: string[];
  /** Job ids the server consistently returned null for (deleted, rolled back, never visible). */
  missingJobIds: string[];
  timedOut: boolean;
}

const TERMINAL_STATES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed']);

export async function pollJobs(workspaceId: string, jobIds: string[], options: PollOptions): Promise<PollResult> {
  const pollInterval = options.pollIntervalMs ?? 5000;
  const missingTolerance = Math.max(1, options.missingTolerance ?? 1);
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : null;
  const snapshot = new Map<string, JobResponse | null>();
  const pending = new Set(jobIds);
  const missingHits = new Map<string, number>();
  const missing = new Set<string>();

  while (pending.size > 0) {
    for (const jobId of Array.from(pending)) {
      const job = await options.getJob(workspaceId, jobId);
      snapshot.set(jobId, job);
      if (job && TERMINAL_STATES.has(job.status)) {
        pending.delete(jobId);
        missingHits.delete(jobId);
        continue;
      }
      if (job === null) {
        const hits = (missingHits.get(jobId) ?? 0) + 1;
        missingHits.set(jobId, hits);
        if (hits >= missingTolerance) {
          pending.delete(jobId);
          missing.add(jobId);
        }
      } else {
        // Job exists but isn't terminal — reset the missing counter so a transient
        // 404 followed by 200s doesn't accumulate.
        missingHits.delete(jobId);
      }
    }
    options.onTick?.(snapshot);
    if (pending.size === 0) break;
    if (deadline !== null && Date.now() >= deadline) {
      return {
        terminal: collectTerminal(snapshot),
        failedJobIds: collectFailed(snapshot),
        missingJobIds: Array.from(missing),
        timedOut: true,
      };
    }
    await sleep(pollInterval);
  }

  return {
    terminal: collectTerminal(snapshot),
    failedJobIds: collectFailed(snapshot),
    missingJobIds: Array.from(missing),
    timedOut: false,
  };
}

function collectTerminal(snapshot: Map<string, JobResponse | null>): JobResponse[] {
  const out: JobResponse[] = [];
  for (const job of snapshot.values()) {
    if (job && TERMINAL_STATES.has(job.status)) out.push(job);
  }
  return out;
}

function collectFailed(snapshot: Map<string, JobResponse | null>): string[] {
  const out: string[] = [];
  for (const [id, job] of snapshot.entries()) {
    if (job?.status === 'failed') out.push(id);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
