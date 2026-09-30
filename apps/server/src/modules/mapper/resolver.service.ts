/**
 * ResolverService
 *
 * Re-resolves cross-repo edges (RESOLVES_TO) for a project using the unified
 * `linkWorkspace` linker from `@coredoc/core`. Mirrors the CLI behavior in
 * `packages/cli/src/push/unified.ts`:
 *
 *  - Rebuilds exact repository inputs through the pinned resolver kernel.
 *  - Passes the workspace-scoped mapper override (or EMPTY_MAPPER fallback).
 *  - Persists the kernel's result through the same idempotent bridge as CLI.
 *
 * Both triggers — push delta apply and mapper PUT — call resolveWorkspace().
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LinkResult, ParsedRepoLike } from '@coredoc/core';
import type { AppliedGraphSnapshot, IGraphRepository } from '@coredoc/db';
import { MapperService } from './mapper.service.js';
import { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { GraphBackend, resolveGraphBackend } from '../../database/graph-backend.js';
import { PushLeaseService } from '../lease/push-lease.service.js';
import { computePinnedResolution, persistPinnedResolution, type PinnedResolutionMetrics } from './resolver-kernel.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import { compareCodeUnits } from '@coredoc/core/utils';

export interface ResolutionMetrics {
  resolved: number;
  total: number;
  rate: number;
  legacyEdges: number;
  mapperSha: string | null;
}

export interface ResolutionExecutionOptions {
  ownerToken?: string;
  signal?: AbortSignal;
  onWait?: () => void;
  onLeaseLost?: (reason: Error) => void;
}

interface AppliedResolutionInput {
  repoKey: string;
  repoName: string;
  snapshot: AppliedGraphSnapshot | null;
}

interface ControlPlaneRepoInput {
  id: string;
  repoKey: string;
  repoName: string;
  httpPrefix: string | null;
}

interface WorkspaceResolutionInput {
  id: string;
  slug: string;
  graphBackend: GraphBackend;
}

function workspaceResolutionInput(
  workspace: { id: string; slug: string; graphBackend: string } | null,
): WorkspaceResolutionInput | null {
  if (!workspace) return null;
  let graphBackend: GraphBackend;
  try {
    graphBackend = resolveGraphBackend(workspace);
  } catch {
    // Used inside the lease-held re-check: an unreadable backend means "the
    // inputs are no longer the ones we computed on", not a 409 thrown from the
    // critical section. The comparator already treats null as a mismatch.
    return null;
  }
  return { id: workspace.id, slug: workspace.slug, graphBackend };
}

type MapperDescriptor = Awaited<ReturnType<MapperService['loadOrDefault']>>['descriptor'];

function sameMapperDescriptor(left: MapperDescriptor, right: MapperDescriptor): boolean {
  if (!left || !right) return left === right;
  return left.r2Key === right.r2Key && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes;
}

function sameAppliedSnapshot(left: AppliedGraphSnapshot | null, right: AppliedGraphSnapshot | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.parsedVersion === right.parsedVersion &&
    left.summaryVersion === right.summaryVersion &&
    left.embeddingsVersion === right.embeddingsVersion &&
    left.commitSha === right.commitSha
  );
}

function sameAppliedInputs(left: readonly AppliedResolutionInput[], right: readonly AppliedResolutionInput[]): boolean {
  if (left.length !== right.length) return false;
  const rightByRepo = new Map(right.map((entry) => [entry.repoKey, entry]));
  return left.every((entry) => {
    const current = rightByRepo.get(entry.repoKey);
    return Boolean(
      current && current.repoName === entry.repoName && sameAppliedSnapshot(entry.snapshot, current.snapshot),
    );
  });
}

function snapshotRepoTopology(repos: readonly ControlPlaneRepoInput[]): ControlPlaneRepoInput[] {
  return repos
    .map(({ id, repoKey, repoName, httpPrefix }) => ({ id, repoKey, repoName, httpPrefix }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function sameRepoTopology(left: readonly ControlPlaneRepoInput[], right: readonly ControlPlaneRepoInput[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const current = right[index];
      return (
        current !== undefined &&
        current.id === entry.id &&
        current.repoKey === entry.repoKey &&
        current.repoName === entry.repoName &&
        current.httpPrefix === entry.httpPrefix
      );
    })
  );
}

function sameWorkspaceInput(left: WorkspaceResolutionInput, right: WorkspaceResolutionInput | null): boolean {
  return right !== null && left.id === right.id && left.slug === right.slug && left.graphBackend === right.graphBackend;
}

@Injectable()
export class ResolverService {
  /**
   * In-process serialization per workspace. Without this, two concurrent
   * resolver runs (push+push for different repos in the same workspace, or
   * push+mapper PUT) interleave `read input → delete RESOLVES_TO → write
   * edges` and the older snapshot can win the final write.
   *
   * `running` is the run that is currently executing. `queued` is the at-most-
   * one run that has been scheduled to start after `running` completes; new
   * arrivals coalesce onto it instead of stacking a fresh pass per caller. One
   * queued run is sufficient because every run produces a fresh workspace-wide
   * snapshot — N callers that arrived during one run all see the same next
   * snapshot, which is correct.
   *
   * The distributed graph-write lease extends delete/write serialization
   * across replicas. These maps still coalesce bursts in one process so only
   * one follow-up computation is queued for a burst of callers.
   */
  private readonly running = new Map<string, Promise<ResolutionMetrics>>();
  private readonly queued = new Map<string, Promise<ResolutionMetrics>>();

  constructor(
    private readonly mapperService: MapperService,
    private readonly workspaceDbPool: WorkspaceDbPoolService,
    private readonly controlPlane: ControlPlaneService,
    private readonly pushLeases: PushLeaseService,
  ) {}

  async resolveWorkspace(workspaceId: string, execution?: ResolutionExecutionOptions): Promise<ResolutionMetrics> {
    const current = this.running.get(workspaceId);
    if (!current) {
      // No run in flight — start one and publish it synchronously so sibling
      // callers arriving in the same microtask see it.
      const next = this.resolveWorkspaceInner(workspaceId, execution).finally(() => {
        // Hand off to the queued run (if any) — it becomes the new `running`
        // when its first inner step executes.
        if (this.running.get(workspaceId) === next) this.running.delete(workspaceId);
      });
      this.running.set(workspaceId, next);
      return next;
    }
    // A run is in flight. Reuse the queued run if one already exists so a
    // burst of N callers collapses to one extra pass total.
    const alreadyQueued = this.queued.get(workspaceId);
    if (alreadyQueued) return alreadyQueued;
    const queuedRun = current
      .catch(() => undefined)
      .then(() => {
        // Promote queued → running before the inner work starts so the next
        // arrival opens a fresh queued slot.
        this.queued.delete(workspaceId);
        const promoted = this.resolveWorkspaceInner(workspaceId, execution).finally(() => {
          if (this.running.get(workspaceId) === promoted) this.running.delete(workspaceId);
        });
        this.running.set(workspaceId, promoted);
        return promoted;
      });
    this.queued.set(workspaceId, queuedRun);
    return queuedRun;
  }

  private async resolveWorkspaceInner(
    workspaceId: string,
    execution?: ResolutionExecutionOptions,
  ): Promise<ResolutionMetrics> {
    const repos = await this.controlPlane.listRepos(workspaceId);
    if (repos.length === 0) {
      return { resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null };
    }

    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    if (resolveGraphBackend(workspace) !== GraphBackend.Turso) {
      throw new GraphSnapshotError('graph_backend_conflict', `Workspace ${workspaceId} is not on Turso`);
    }

    // Lease the workspace repository for the full resolve so the pool's
    // idle-eviction sweep can't close the driver mid-statement (the bug
    // that produced SERVER_ERROR 404 / TRANSACTION_CLOSED in production
    // on 2026-05-24). Release in finally so a throw between Turso calls
    // can't leak a lease.
    const repository = await this.workspaceDbPool.acquire(workspaceId, workspace.slug);
    if (!repository) throw new NotFoundException(`Workspace database not available for ${workspaceId}`);

    try {
      const {
        mapper,
        sha256: mapperSha,
        descriptor: mapperDescriptor,
      } = await this.mapperService.loadOrDefault(workspaceId);
      execution?.signal?.throwIfAborted();
      const workspaceBeforeCompute = workspaceResolutionInput(workspace)!;
      const repoTopologyBeforeCompute = snapshotRepoTopology(repos);
      const pinnedRepos = repos.map((repo) => ({
        repoKey: repo.repoKey,
        repoName: repo.repoName,
        httpPrefix: repo.httpPrefix,
      }));
      const graphRepos = await repository.listAllRepositories(pinnedRepos.map(({ repoName }) => repoName));
      execution?.signal?.throwIfAborted();
      const presentRepoNames = new Set(graphRepos.map(({ name }) => name));
      // Live Turso historically resolves the repositories that have actually
      // been pushed. A newly connected control-plane row is not a graph
      // identity yet, so do not make ordinary live resolution fail.
      const resolvableRepos = pinnedRepos.filter(({ repoName }) => presentRepoNames.has(repoName));
      const appliedBeforeCompute = await this.readAppliedInputs(repository, pinnedRepos);
      const computation = await computePinnedResolution(
        repository,
        resolvableRepos,
        mapper,
        execution?.signal,
        graphRepos,
      );

      // Reads and link computation intentionally happen before the distributed
      // graph-write lease. Only the delete/write persistence phase competes
      // with pushes, so different-repo pushes do not queue behind minutes of
      // resolver I/O and CPU work.
      const metrics = await this.persistLinkResultWithLease(
        workspaceId,
        repository,
        computation.repos,
        computation.result,
        execution,
        async () => {
          const [currentRepos, currentWorkspace, currentMapper, appliedAfterLease] = await Promise.all([
            this.controlPlane.listRepos(workspaceId),
            this.controlPlane.getWorkspaceById(workspaceId),
            this.mapperService.loadOrDefault(workspaceId),
            this.readAppliedInputs(repository, pinnedRepos),
          ]);
          if (
            !sameWorkspaceInput(workspaceBeforeCompute, workspaceResolutionInput(currentWorkspace)) ||
            !sameRepoTopology(repoTopologyBeforeCompute, snapshotRepoTopology(currentRepos)) ||
            !sameMapperDescriptor(mapperDescriptor, currentMapper.descriptor) ||
            !sameAppliedInputs(appliedBeforeCompute, appliedAfterLease)
          ) {
            throw new GraphSnapshotError(
              'graph_resolution_inputs_changed',
              'Workspace graph or mapper inputs changed while resolution was being computed',
            );
          }
        },
      );

      return {
        ...metrics,
        mapperSha,
      };
    } finally {
      this.workspaceDbPool.release(workspaceId, repository);
    }
  }

  private async persistLinkResultWithLease(
    workspaceId: string,
    repository: IGraphRepository,
    parsedRepos: readonly ParsedRepoLike[],
    linkResult: LinkResult,
    execution?: ResolutionExecutionOptions,
    beforePersist?: () => Promise<void>,
  ): Promise<PinnedResolutionMetrics> {
    const lease = await this.pushLeases.acquireGraphWrite(
      workspaceId,
      execution?.ownerToken ?? randomUUID(),
      execution?.signal,
      execution?.onWait,
    );
    let renewal: ReturnType<typeof setInterval> | null = null;
    let leaseFailure: Error | null = null;
    try {
      renewal = this.pushLeases.startRenewal(
        () => this.pushLeases.renewGraphWrite(workspaceId, lease),
        (reason) => {
          leaseFailure = reason;
          execution?.onLeaseLost?.(reason);
        },
      );
      await beforePersist?.();
      execution?.signal?.throwIfAborted();
      if (leaseFailure) throw leaseFailure;
      const metrics = await persistPinnedResolution(repository, parsedRepos, linkResult, execution?.signal);
      execution?.signal?.throwIfAborted();
      if (leaseFailure) throw leaseFailure;
      return metrics;
    } finally {
      if (renewal) clearInterval(renewal);
      await this.pushLeases.releaseGraphWrite(workspaceId, lease).catch(() => undefined);
    }
  }

  private async readAppliedInputs(
    repository: IGraphRepository,
    repos: readonly { repoKey: string; repoName: string }[],
  ): Promise<AppliedResolutionInput[]> {
    return Promise.all(
      repos.map(async ({ repoKey, repoName }) => ({
        repoKey,
        repoName,
        snapshot: await repository.getAppliedGraphSnapshot(repoKey),
      })),
    );
  }
}
