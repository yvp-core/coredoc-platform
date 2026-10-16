import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, configFromEnv } from '../../config/app-config.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type PushJobStatus } from '../../generated/prisma/client.js';
import type { PushPayload, ResolvePayload, ResolveTargetPayload } from '../../libs/pipeline/job-payload.types.js';
import { JobFailedException, JobStillRunningException } from './job-errors.js';

const LIST_LIMIT_MAX = 200;
export const FILE_SNAPSHOT_SYNC_TIMEOUT_MS = 270_000;
const CLI_SYNC_ABORT_MS = 300_000;
const TERMINAL_POLL_INTERVAL_MS = 250;

export interface WaitForTerminalOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function assertTerminalTimeoutMs(timeoutMs: number, source: string): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > FILE_SNAPSHOT_SYNC_TIMEOUT_MS ||
    timeoutMs >= CLI_SYNC_ABORT_MS
  ) {
    throw new Error(
      `${source} must be a positive integer no greater than ${FILE_SNAPSHOT_SYNC_TIMEOUT_MS}ms, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function configuredFileSnapshotSyncTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return FILE_SNAPSHOT_SYNC_TIMEOUT_MS;
  const normalized = raw.trim();
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  return assertTerminalTimeoutMs(parsed, 'FILE_SNAPSHOT_SYNC_TIMEOUT_MS');
}

function withinDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  timeoutError: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  if (milliseconds <= 0) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(timeoutError())), milliseconds);
    const abort = () => finish(() => reject(signal?.reason ?? new Error('Job wait aborted')));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isSamePushPayload(left: PushPayload, right: PushPayload): boolean {
  return (
    (left.parsedVersion ?? null) === (right.parsedVersion ?? null) &&
    (left.summaryVersion ?? null) === (right.summaryVersion ?? null) &&
    (left.embeddingsVersion ?? null) === (right.embeddingsVersion ?? null) &&
    (left.excludeSummaries ?? false) === (right.excludeSummaries ?? false) &&
    (left.excludeEmbeddings ?? false) === (right.excludeEmbeddings ?? false) &&
    (left.commitSha ?? null) === (right.commitSha ?? null) &&
    (left.deferResolution ?? false) === (right.deferResolution ?? false) &&
    (left.rebuild ?? false) === (right.rebuild ?? false)
  );
}

function isSameResolveTargets(left: readonly ResolveTargetPayload[], right: readonly ResolveTargetPayload[]): boolean {
  if (left.length !== right.length) return false;
  // Tri-state per metadata slot: `undefined` (preserve the pinned selection)
  // and `null` (explicitly exclude) are DIFFERENT requests — collapsing them
  // would let an exclude request reuse a preserve job and publish the wrong
  // graph while reporting success.
  const slot = (value: string | null | undefined) => (value === undefined ? 'u' : value === null ? 'n' : `v:${value}`);
  const key = (target: ResolveTargetPayload) =>
    [
      target.repoName,
      target.parsedVersion,
      slot(target.summaryVersion),
      slot(target.embeddingsVersion),
      slot(target.commitSha),
    ].join('\u0000');
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

@Injectable()
export class PushQueueService {
  private readonly defaultTerminalTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(STORAGE_CONFIG) storage: StorageConfig = configFromEnv().storage,
  ) {
    this.defaultTerminalTimeoutMs = configuredFileSnapshotSyncTimeoutMs(storage.fileSnapshotSyncTimeoutMs);
  }

  async enqueuePush(input: { workspaceId: string; repoName: string; payload: PushPayload; userId: string }) {
    const existing = await this.prisma.pushJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        repoName: input.repoName,
        type: 'push',
        status: { in: ['pending', 'running'] },
      },
    });
    if (existing) {
      const existingPayload = existing.payload as unknown as PushPayload;
      if (isSamePushPayload(existingPayload, input.payload)) return existing;
      throw new ConflictException(
        `A different push is already pending or running for repo "${input.repoName}". Wait for it to finish, then retry.`,
      );
    }

    const payload = { ...input.payload, executionToken: input.payload.executionToken ?? randomUUID() };
    try {
      return await this.prisma.pushJob.create({
        data: {
          workspaceId: input.workspaceId,
          repoName: input.repoName,
          type: 'push',
          payload: payload as never,
          queuedByUserId: input.userId,
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      const winner = await this.prisma.pushJob.findFirst({
        where: {
          workspaceId: input.workspaceId,
          repoName: input.repoName,
          type: 'push',
          status: { in: ['pending', 'running'] },
        },
      });
      if (winner && isSamePushPayload(winner.payload as unknown as PushPayload, input.payload)) return winner;
      throw new ConflictException(
        `A different push is already pending or running for repo "${input.repoName}". Wait for it to finish, then retry.`,
      );
    }
  }

  async enqueueResolve(input: { workspaceId: string; userId: string; targets?: ResolveTargetPayload[] }) {
    const targets = input.targets ?? [];
    // A pending resolver is safe to reuse: the worker will hold it until every
    // push in this workspace is terminal. A running resolver is not reusable —
    // deferred pushes enqueued while it runs need a follow-up pass over their
    // final graph state.
    const existing = await this.prisma.pushJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        type: 'resolve',
        status: 'pending',
      },
    });
    // Overlap guard for targeted batches: a batch enqueued while a targeted
    // resolve is RUNNING, or while a push for one of its repositories is in
    // flight, would be accepted (202) and then permanently rejected by the
    // stale-pin guard after the earlier job publishes. Refuse synchronously
    // instead — the client retries with fresh versions. findFirst is not
    // atomic (no unique index for resolve), so the durable stale-pin guard in
    // assembleCandidate remains the backstop for the race window.
    if (targets.length > 0) {
      const runningResolve = await this.prisma.pushJob.findFirst({
        where: { workspaceId: input.workspaceId, type: 'resolve', status: 'running' },
      });
      if (runningResolve) {
        throw new ConflictException(
          'A resolve is currently running for this workspace. Wait for it to finish, then re-sync.',
        );
      }
      const overlappingPush = await this.prisma.pushJob.findFirst({
        where: {
          workspaceId: input.workspaceId,
          type: 'push',
          status: { in: ['pending', 'running'] },
          repoName: { in: targets.map(({ repoName }) => repoName) },
        },
      });
      if (overlappingPush) {
        throw new ConflictException(
          `A push for repo "${overlappingPush.repoName}" is already in flight. Wait for it to finish, then re-sync.`,
        );
      }
    }
    if (existing) {
      const existingTargets = (existing.payload as unknown as ResolvePayload)?.targets ?? [];
      // A targetless request only wants resolution recomputed over the current
      // composition; any pending resolve does that (a batch does it after
      // applying its targets), so it is always safe to hand back. The mapper
      // PUT path depends on this: it fires a targetless resolve after the
      // mapper is already persisted, and a 409 there would fail a PUT whose
      // data has already landed.
      if (targets.length === 0) return existing;
      // A targeted request must publish exactly its batch. Handing it a
      // pending resolve with different targets would silently drop the
      // repositories it asked to publish.
      if (isSameResolveTargets(existingTargets, targets)) return existing;
      throw new ConflictException(
        `A different resolve is already pending for this workspace. Wait for it to finish, then retry.`,
      );
    }

    const payload: ResolvePayload = {
      executionToken: randomUUID(),
      ...(targets.length > 0 ? { targets } : {}),
    };

    return this.prisma.pushJob.create({
      data: {
        workspaceId: input.workspaceId,
        repoName: null,
        type: 'resolve',
        payload: payload as never,
        queuedByUserId: input.userId,
      },
    });
  }

  async getJob(workspaceId: string, jobId: string) {
    return this.prisma.pushJob.findFirst({
      where: { id: jobId, workspaceId },
      include: { attemptHistory: { orderBy: { attemptNumber: 'asc' } } },
    });
  }

  async listJobs(workspaceId: string, status?: PushJobStatus, limit = 50) {
    const take = Math.min(Math.max(1, limit), LIST_LIMIT_MAX);
    return this.prisma.pushJob.findMany({
      where: { workspaceId, ...(status ? { status } : {}) },
      orderBy: { queuedAt: 'desc' },
      take,
    });
  }

  async waitForTerminal(workspaceId: string, jobId: string, options: WaitForTerminalOptions = {}) {
    const timeoutMs = assertTerminalTimeoutMs(
      options.timeoutMs ?? this.defaultTerminalTimeoutMs,
      'Job terminal timeout',
    );
    const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
      throw new Error(`Job terminal poll interval must be a non-negative integer, got ${pollIntervalMs}`);
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      options.signal?.throwIfAborted();
      const remainingMs = deadline - Date.now();
      const job = await withinDeadline(
        this.prisma.pushJob.findFirst({ where: { id: jobId, workspaceId } }),
        remainingMs,
        () => new JobStillRunningException(jobId),
        options.signal,
      );
      if (!job) throw new NotFoundException(`Job ${jobId} not found in workspace ${workspaceId}`);
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed') throw new JobFailedException(jobId, job.result);
      if (Date.now() >= deadline) throw new JobStillRunningException(jobId);
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
    }
  }
}
