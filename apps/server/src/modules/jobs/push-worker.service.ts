import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  miscConfigFromEnv,
  WORKERS_CONFIG,
  type WorkersConfig,
  workersConfigFromEnv,
} from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type PushJob } from '../../generated/prisma/client.js';
import { JobProcessor } from './job-processor.service.js';
import {
  PushJobPhase,
  type JobProgress,
  type ProgressUnit,
  type PushExecutionContext,
} from '../../libs/pipeline/push-execution.types.js';
import { GraphWriteLeaseTimeoutError, RepositoryLeaseBusyError } from '../lease/push-lease.service.js';
import { classifyJobError, serializeTerminalJobError, type ClassifiedJobError } from '../job-queue/job-errors.js';
import { LicenseService } from '../license/license.service.js';

export const BACKOFF_MS = [30_000, 120_000, 600_000];
const ERROR_MSG_MAX = 4096;
const DEFAULT_POLL_MS = 2000;
const HEARTBEAT_MS = 15_000;
const PROGRESS_FLUSH_MS = 5_000;
const STALE_HEARTBEAT_MS = 120_000;
const INTERNAL_STACK_MAX = 4096;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_DIAGNOSTIC_CODE = /^[A-Z0-9_]{1,64}$/;
/**
 * Requeue delay for lease-contention ("busy") requeues. Sized against the
 * claim cap (maxAttempts * 3 = 9 claims by default): 9 claims at this spacing
 * out-wait a full-length (<5 min SLA) holder with margin before the cap
 * flips the job to failed.
 */
const BUSY_RETRY_MS = 60_000;
/**
 * The claim loop polls every couple of seconds, so the "not claiming, license
 * expired" line is rate-limited to one per hour — the same cadence as
 * LicenseService's own re-verification.
 */
const LICENSE_SKIP_LOG_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_WAIT_MS = miscConfigFromEnv().environment === 'development' ? 10_000 : 30_000;

class WorkerShutdownError extends Error {
  constructor() {
    super('Push worker is shutting down');
    this.name = 'WorkerShutdownError';
  }
}

class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease for job ${jobId} was lost`);
    this.name = 'JobLeaseLostError';
  }
}

/**
 * Parse a positive-integer env var with a defensive NaN/non-numeric fallback.
 * Without this, a misconfigured env (e.g. PUSH_WORKER_CONCURRENCY=auto)
 * silently disables the worker: parseInt yields NaN, the loop bound `i < NaN`
 * runs zero iterations, and the worker logs "started" while never polling.
 */
function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  logger: Logger,
  varName: string,
  min = 1,
): number {
  if (raw === undefined || raw === '') return Math.max(min, fallback);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    logger.warn(`${varName}="${raw}" is not a positive integer (min=${min}); falling back to ${fallback}`);
    return Math.max(min, fallback);
  }
  return n;
}

function internalErrorDiagnostic(error: unknown): { label: string; stack: string | undefined } {
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const rawName = candidate?.name;
  const name = typeof rawName === 'string' && SAFE_ERROR_NAME.test(rawName) ? rawName : 'UnknownError';
  const rawCode = candidate?.code;
  const code = typeof rawCode === 'string' && SAFE_DIAGNOSTIC_CODE.test(rawCode) ? rawCode : null;
  const rawStack = candidate?.stack;
  const stack =
    typeof rawStack === 'string'
      ? rawStack
          .split('\n')
          .filter((line) => /^\s+at\s+/.test(line))
          .join('\n')
          .slice(0, INTERNAL_STACK_MAX) || undefined
      : undefined;
  return { label: code ? `${name}, code=${code}` : name, stack };
}

interface ActiveExecution {
  controller: AbortController;
  progress: JobProgress | null;
  phaseStartedAt: number;
  phaseTimings: Record<string, number>;
  lastPersistedAt: number;
  persistInFlight: Promise<void> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  heartbeatInFlight: boolean;
  /** Last heartbeat that CONFIRMED ownership — anchors the transient-failure budget. */
  lastHeartbeatSuccessAt: number;
  batchCount: number;
}

@Injectable()
export class PushWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushWorkerService.name);
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly active = new Map<string, ActiveExecution>();
  private lastLicenseSkipLogMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: JobProcessor,
    // Optional: no license file (hosted, dev) means no enforcement, which is
    // also what an injector without LicenseCoreModule expresses.
    @Optional() private readonly license?: LicenseService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = workersConfigFromEnv(),
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.workers.pushWorkerEnabled === 'false') {
      this.logger.log('PushWorker disabled via PUSH_WORKER_ENABLED=false');
      return;
    }
    await this.recoverStaleRunningJobs();
    const concurrency = parsePositiveIntEnv(
      this.workers.pushWorkerConcurrency,
      1,
      this.logger,
      'PUSH_WORKER_CONCURRENCY',
    );
    this.running = true;
    for (let i = 0; i < concurrency; i++) this.loops.push(this.runLoop(i));
    this.logger.log(`PushWorker started (concurrency=${concurrency})`);
  }

  async recoverStaleRunningJobs(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH stale AS (
        SELECT job.id, job.lease_token, job.attempts, job.max_attempts,
          (
            SELECT COUNT(*)::int FROM push_job_attempts prior
            WHERE prior.job_id = job.id
              AND prior.status IN ('failed', 'retry_scheduled', 'lease_lost')
          ) AS failed_attempts
        FROM push_jobs job
        WHERE job.status = 'running'
          AND COALESCE(job.heartbeat_at, job.started_at, job.queued_at) < NOW() - INTERVAL '2 minutes'
        FOR UPDATE SKIP LOCKED
      ), abandoned AS (
        UPDATE push_job_attempts attempt
        SET status = 'lease_lost', finished_at = NOW(),
            last_error = 'Worker heartbeat expired before finalization'
        FROM stale
        WHERE attempt.job_id = stale.id
          AND attempt.lease_token IS NOT DISTINCT FROM stale.lease_token
          AND attempt.status = 'running'
        RETURNING attempt.job_id
      )
      UPDATE push_jobs job
      SET status = CASE
            WHEN stale.failed_attempts + 1 >= stale.max_attempts
              OR stale.attempts >= stale.max_attempts * 3 THEN 'failed'::"PushJobStatus"
            ELSE 'pending'::"PushJobStatus"
          END,
          next_run_at = CASE
            WHEN stale.failed_attempts + 1 >= stale.max_attempts
              OR stale.attempts >= stale.max_attempts * 3 THEN job.next_run_at
            ELSE NOW()
          END,
          finished_at = CASE
            WHEN stale.failed_attempts + 1 >= stale.max_attempts
              OR stale.attempts >= stale.max_attempts * 3 THEN NOW()
            ELSE NULL
          END,
          result = CASE
            WHEN stale.failed_attempts + 1 >= stale.max_attempts
              OR stale.attempts >= stale.max_attempts * 3
            THEN jsonb_build_object(
              'error', jsonb_build_object(
                'code', 'job_stale_recovery_exhausted',
                'jobId', job.id,
                'message', 'Stale recovery exhausted the job retry budget',
                'statusCode', 503
              )
            )
            ELSE job.result
          END,
          last_error = 'Worker heartbeat expired before finalization',
          lease_token = NULL,
          heartbeat_at = NULL
      FROM stale
      WHERE job.id = stale.id
        AND job.status = 'running'
        -- IS NOT DISTINCT FROM: rows claimed by pre-lease code carry
        -- lease_token NULL, and NULL = NULL would silently skip them —
        -- leaving the job 'running' forever while the partial unique index
        -- blocks every future push for the repo.
        AND job.lease_token IS NOT DISTINCT FROM stale.lease_token
      RETURNING job.id
    `;
    if (rows.length > 0) this.logger.warn(`Recovered ${rows.length} job(s) with expired heartbeats`);
    return rows.length;
  }

  /**
   * Drain in `onModuleDestroy` — the FIRST termination phase — so the worker
   * stops touching Prisma before PrismaService closes the pg pool in
   * `onApplicationShutdown` (the LAST phase). A later-phase stop would leave
   * in-flight polls calling a closed pool ("Cannot use a pool after calling
   * end on the pool"). Active executions abort at the next batch boundary and
   * requeue as `interrupted` (no failure budget consumed).
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    for (const execution of this.active.values()) execution.controller.abort(new WorkerShutdownError());
    await Promise.race([Promise.all(this.loops), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
    this.logger.log('PushWorker stopped');
  }

  private async runLoop(index: number): Promise<void> {
    const pollMs = parsePositiveIntEnv(
      this.workers.pushWorkerPollIntervalMs,
      DEFAULT_POLL_MS,
      this.logger,
      'PUSH_WORKER_POLL_INTERVAL_MS',
      100,
    );
    while (this.running) {
      try {
        if (!(await this.processOnce())) await this.sleep(pollMs);
      } catch (err) {
        this.logger.error(`Loop ${index} error: ${(err as Error).message}`);
        await this.sleep(pollMs);
      }
    }
  }

  /**
   * While the license is expired past grace, the claim NARROWS to `renormalize`
   * instead of stopping: `push`, `resolve` and `connector_sync` all bring new
   * product data into the deployment and stay refused, but `renormalize` only
   * re-derives rows already imported — and `DeliverySyncCron.backfillStale-
   * Normalizations` deliberately keeps enqueuing it while expired, because the
   * raw payloads it re-derives from are hard-deleted on a retention deadline
   * that does not pause. Refusing to claim those jobs too would turn "writes
   * are paused" into permanent data loss for every row whose payload ages out
   * before renewal. The two sites are one policy — keep them in step.
   *
   * The boundary is the CLAIM, not the execution: a job already claimed runs to
   * completion (killing it mid-write would corrupt state to enforce a
   * commercial term), and refused jobs simply stay `pending` — the queue drains
   * by itself once the license is renewed, with no requeue machinery.
   */
  private licenseRestrictsClaimToRenormalize(): boolean {
    if (!this.license?.isExpired()) return false;
    const nowMs = Date.now();
    if (nowMs - this.lastLicenseSkipLogMs >= LICENSE_SKIP_LOG_INTERVAL_MS) {
      this.lastLicenseSkipLogMs = nowMs;
      this.logger.warn(
        'PushWorker is claiming renormalize jobs only — the Coredoc license has expired past its grace window. Pushes, resolves and connector syncs stay pending and resume when it is renewed.',
      );
    }
    return true;
  }

  /** Claim and attempt creation are one data-modifying PostgreSQL CTE. */
  async claimNextJob(): Promise<PushJob | null> {
    // Applied INSIDE the claim query (not as a claim-then-release): a released
    // claim would already have burnt an attempt and flipped the row's status.
    const renormalizeOnly = this.licenseRestrictsClaimToRenormalize();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH next AS (
        SELECT candidate.id FROM push_jobs candidate
        WHERE candidate.status = 'pending'
          AND candidate.next_run_at <= NOW()
          AND candidate.attempts < candidate.max_attempts * 3
          AND (NOT ${renormalizeOnly}::boolean OR candidate.type = 'renormalize')
          AND (
            candidate.type <> 'resolve'
            OR NOT EXISTS (
              SELECT 1 FROM push_jobs active_push
              WHERE active_push.workspace_id = candidate.workspace_id
                AND active_push.type = 'push'
                AND active_push.status IN ('pending', 'running')
            )
          )
        ORDER BY candidate.next_run_at ASC, candidate.queued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE push_jobs job
        SET status = 'running',
            started_at = NOW(),
            finished_at = NULL,
            attempts = job.attempts + 1,
            lease_token = gen_random_uuid(),
            heartbeat_at = NOW(),
            phase = NULL,
            progress = NULL,
            last_error = NULL,
            payload = CASE
              WHEN job.type IN ('push', 'resolve') AND NOT (job.payload ? 'executionToken')
                THEN jsonb_set(job.payload, '{executionToken}', to_jsonb(gen_random_uuid()::text))
              ELSE job.payload
            END
        WHERE job.id IN (SELECT id FROM next)
        RETURNING job.id, job.attempts, job.lease_token
      ), attempt AS (
        INSERT INTO push_job_attempts
          (id, job_id, attempt_number, lease_token, status, started_at, heartbeat_at)
        SELECT gen_random_uuid()::text, claimed.id, claimed.attempts,
               claimed.lease_token, 'running', NOW(), NOW()
        FROM claimed
        RETURNING job_id
      )
      SELECT claimed.id FROM claimed JOIN attempt ON attempt.job_id = claimed.id
    `;
    const id = rows[0]?.id;
    return id ? this.prisma.pushJob.findUniqueOrThrow({ where: { id } }) : null;
  }

  async processOnce(): Promise<boolean> {
    const job = await this.claimNextJob();
    if (!job) return false;
    if (!job.leaseToken) throw new Error(`Claimed job ${job.id} has no lease token`);

    const execution = this.createExecution();
    this.active.set(job.id, execution);
    execution.heartbeat = setInterval(() => void this.heartbeat(job, execution), HEARTBEAT_MS);

    try {
      const context: PushExecutionContext = {
        jobId: job.id,
        executionToken: this.executionToken(job),
        leaseOwnerToken: job.leaseToken,
        signal: execution.controller.signal,
        abort: (reason) => execution.controller.abort(reason),
        report: (phase, completed = null, total = null, unit: ProgressUnit | null = null) => {
          this.reportProgress(job, execution, phase, completed, total, unit);
        },
      };
      const result = await this.processor.process(job, context);
      await this.flushProgress(job, execution, true);
      const updated = await this.finalizeJob(
        job,
        { status: 'succeeded', result: result as never, finishedAt: new Date(), lastError: null },
        'succeeded',
        execution,
      );
      if (!updated) this.logger.warn(`Job ${job.id} lost its lease — result discarded`);
      return true;
    } catch (err) {
      const classification = this.truncateClassification(classifyJobError(err));
      const interrupted =
        err instanceof WorkerShutdownError || execution.controller.signal.reason instanceof WorkerShutdownError;
      const leaseLost =
        err instanceof JobLeaseLostError || execution.controller.signal.reason instanceof JobLeaseLostError;
      // Lease contention is "resource busy", not a failure: a queued job racing
      // a long ?sync=true push (which the one-active-push index cannot see)
      // must wait the holder out, not burn its failure budget in 2.5 minutes.
      // The claim cap still bounds total busy-waiting.
      const busy = err instanceof RepositoryLeaseBusyError || err instanceof GraphWriteLeaseTimeoutError;
      if (classification.code === 'job_internal_error' && !interrupted && !leaseLost && !busy) {
        const diagnostic = internalErrorDiagnostic(err);
        this.logger.error(`Job ${job.id} failed (${diagnostic.label})`, diagnostic.stack);
      }
      const safeMessage = classification.message;
      const permanent = !busy && !classification.retryable;
      const failedAttempts = await this.countFailedAttempts(job.id);
      const atFailureLimit = failedAttempts + (interrupted || busy ? 0 : 1) >= job.maxAttempts;
      const atClaimLimit = job.attempts >= job.maxAttempts * 3;

      if ((interrupted || busy) && !atClaimLimit) {
        // Busy waits BUSY_RETRY_MS so ~9 claims cover a full-length holder;
        // shutdown-interrupted jobs requeue immediately for the next worker.
        const nextRunAt = busy ? new Date(Date.now() + BUSY_RETRY_MS) : new Date();
        await this.finalizeJob(job, { status: 'pending', nextRunAt, lastError: safeMessage }, 'interrupted', execution);
      } else if (permanent || atFailureLimit || atClaimLimit) {
        const terminalClassification: ClassifiedJobError = atClaimLimit
          ? {
              code: 'job_claim_budget_exhausted',
              message: `Claim budget exhausted after ${job.attempts} claims`,
              retryable: false,
              statusCode: 503,
            }
          : classification;
        await this.finalizeJob(
          job,
          {
            status: 'failed',
            lastError: terminalClassification.message,
            result: serializeTerminalJobError(job.id, terminalClassification) as never,
            finishedAt: new Date(),
          },
          leaseLost ? 'lease_lost' : 'failed',
          execution,
        );
      } else {
        const nextRunAt = new Date(Date.now() + BACKOFF_MS[Math.min(failedAttempts, BACKOFF_MS.length - 1)]!);
        await this.finalizeJob(
          job,
          { status: 'pending', lastError: safeMessage, nextRunAt },
          leaseLost ? 'lease_lost' : 'retry_scheduled',
          execution,
        );
      }
      return true;
    } finally {
      if (execution.heartbeat) clearInterval(execution.heartbeat);
      this.active.delete(job.id);
    }
  }

  private createExecution(): ActiveExecution {
    return {
      controller: new AbortController(),
      progress: null,
      phaseStartedAt: Date.now(),
      phaseTimings: {},
      lastPersistedAt: 0,
      persistInFlight: null,
      heartbeat: null,
      heartbeatInFlight: false,
      lastHeartbeatSuccessAt: Date.now(),
      batchCount: 0,
    };
  }

  private executionToken(job: PushJob): string {
    if (job.type !== 'push' && job.type !== 'resolve') {
      // Delivery jobs do not mutate the graph and predate durable graph tokens.
      // The claim lease still gives their shared execution context a stable,
      // non-empty correlation value without rewriting legacy payloads.
      return job.leaseToken!;
    }
    const payload = job.payload as { executionToken?: unknown };
    if (typeof payload.executionToken !== 'string') {
      throw new Error(`Graph-changing job ${job.id} has no execution token after claim`);
    }
    return payload.executionToken;
  }

  private truncateClassification(error: ClassifiedJobError): ClassifiedJobError {
    if (error.message.length <= ERROR_MSG_MAX) return error;
    return { ...error, message: error.message.slice(0, ERROR_MSG_MAX) };
  }

  private reportProgress(
    job: PushJob,
    execution: ActiveExecution,
    phase: PushJobPhase,
    completed: number | null,
    total: number | null,
    unit: ProgressUnit | null,
  ): void {
    const phaseChanged = execution.progress?.phase !== phase;
    if (phaseChanged && execution.progress) {
      execution.phaseTimings[execution.progress.phase] =
        (execution.phaseTimings[execution.progress.phase] ?? 0) + (Date.now() - execution.phaseStartedAt);
      execution.phaseStartedAt = Date.now();
    }
    if (!phaseChanged) execution.batchCount += 1;
    execution.progress = { phase, completed, total, unit, updatedAt: new Date().toISOString() };
    const due = Date.now() - execution.lastPersistedAt >= PROGRESS_FLUSH_MS;
    if (phaseChanged || due) {
      void this.flushProgress(job, execution, phaseChanged).catch((err) => {
        this.logger.warn(`Failed to persist progress for job ${job.id}: ${(err as Error).message}`);
      });
    }
  }

  private async flushProgress(job: PushJob, execution: ActiveExecution, force: boolean): Promise<void> {
    if (!execution.progress || (execution.controller.signal.aborted && !force)) return;
    if (execution.persistInFlight) {
      if (force) await execution.persistInFlight;
      else return;
    }
    const progress = execution.progress;
    execution.lastPersistedAt = Date.now();
    const work = Promise.all([
      this.prisma.pushJob.updateMany({
        where: { id: job.id, status: 'running', leaseToken: job.leaseToken },
        data: { phase: progress.phase, progress: progress as never },
      }),
      this.prisma.pushJobAttempt.updateMany({
        where: { jobId: job.id, leaseToken: job.leaseToken!, status: 'running' },
        data: { phase: progress.phase, progress: progress as never },
      }),
    ]).then(() => undefined);
    execution.persistInFlight = work;
    try {
      await work;
    } finally {
      if (execution.persistInFlight === work) execution.persistInFlight = null;
    }
  }

  private async heartbeat(job: PushJob, execution: ActiveExecution): Promise<void> {
    if (execution.controller.signal.aborted || execution.heartbeatInFlight) return;
    execution.heartbeatInFlight = true;
    try {
      const now = new Date();
      const [updated] = await Promise.all([
        this.prisma.pushJob.updateMany({
          where: { id: job.id, status: 'running', leaseToken: job.leaseToken },
          data: { heartbeatAt: now },
        }),
        this.prisma.pushJobAttempt.updateMany({
          where: { jobId: job.id, leaseToken: job.leaseToken!, status: 'running' },
          data: { heartbeatAt: now },
        }),
        this.flushProgress(job, execution, false),
      ]);
      // 0 rows = the lease is CONFIRMED gone (stale recovery reclaimed it) —
      // abort immediately, another worker may already own the job.
      if (updated.count !== 1) execution.controller.abort(new JobLeaseLostError(job.id));
      else execution.lastHeartbeatSuccessAt = Date.now();
    } catch (err) {
      // The heartbeat QUERY failed — ownership is unknown, and the DB-side
      // staleness threshold leaves ~105s of margin after one missed beat.
      // Tolerate transient control-plane errors until half the threshold is
      // burned; aborting a multi-minute Turso transaction on a single
      // Postgres blip couples push availability to control-plane p999.
      if (Date.now() - execution.lastHeartbeatSuccessAt > STALE_HEARTBEAT_MS / 2) {
        execution.controller.abort(new JobLeaseLostError(job.id));
      } else {
        this.logger.warn(`Heartbeat for job ${job.id} failed transiently: ${(err as Error).message}`);
      }
    } finally {
      execution.heartbeatInFlight = false;
    }
  }

  private async countFailedAttempts(jobId: string): Promise<number> {
    return this.prisma.pushJobAttempt.count({
      where: { jobId, status: { in: ['failed', 'retry_scheduled', 'lease_lost'] } },
    });
  }

  /**
   * Token-scoped optimistic concurrency: both updates match on the CLAIMED
   * lease token, so a worker whose job was reclaimed (new token) or recovered
   * (token cleared) matches 0 rows and cannot finalize a re-claimed attempt —
   * its result is discarded, never written over another worker's.
   */
  private async finalizeJob(
    job: PushJob,
    data: Prisma.PushJobUpdateManyMutationInput,
    attemptStatus: 'succeeded' | 'retry_scheduled' | 'failed' | 'lease_lost' | 'interrupted',
    execution: ActiveExecution,
  ): Promise<boolean> {
    if (execution.progress) {
      execution.phaseTimings[execution.progress.phase] =
        (execution.phaseTimings[execution.progress.phase] ?? 0) + (Date.now() - execution.phaseStartedAt);
    }
    const finishedAt = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.pushJob.updateMany({
        where: { id: job.id, status: 'running', leaseToken: job.leaseToken },
        data: { ...data, leaseToken: null, heartbeatAt: null },
      }),
      this.prisma.pushJobAttempt.updateMany({
        where: { jobId: job.id, leaseToken: job.leaseToken!, status: 'running' },
        data: {
          status: attemptStatus,
          finishedAt,
          lastError: attemptStatus === 'succeeded' ? null : ((data.lastError as string | null) ?? null),
          phase: execution.progress?.phase,
          progress: (execution.progress ?? undefined) as never,
          phaseTimings: execution.phaseTimings as never,
        },
      }),
    ]);
    this.logger.log(
      JSON.stringify({
        jobId: job.id,
        attempt: job.attempts,
        workspaceId: job.workspaceId,
        repoName: job.repoName,
        phase: execution.progress?.phase,
        durationMs: Date.now() - job.startedAt!.getTime(),
        batchCount: execution.batchCount,
        status: attemptStatus,
      }),
    );
    return updated.count === 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { STALE_HEARTBEAT_MS };
