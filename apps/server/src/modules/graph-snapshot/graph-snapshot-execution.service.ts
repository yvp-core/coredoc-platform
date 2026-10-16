import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PushJob } from '../../generated/prisma/client.js';
import type { PushPayload, ResolvePayload } from '../../libs/pipeline/job-payload.types.js';
import { PushLeaseService } from '../lease/push-lease.service.js';
import { ProgressUnit, PushJobPhase, type PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import { GraphSnapshotBuildService, type MaterializedGraphSnapshot } from './graph-snapshot-artifact.service.js';
import {
  GraphSnapshotControlPlaneService,
  type GraphSnapshotCandidate,
} from './graph-snapshot-control-plane.service.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';

function requireExecutionLease(job: PushJob, execution: PushExecutionContext): string {
  if (
    execution.jobId !== job.id ||
    execution.executionToken.length === 0 ||
    !execution.leaseOwnerToken ||
    execution.leaseOwnerToken.length === 0
  ) {
    throw new GraphSnapshotError('file_snapshot_requires_worker', 'File snapshots require a durable worker context');
  }
  return execution.leaseOwnerToken;
}

@Injectable()
export class GraphSnapshotExecutionService {
  private readonly logger = new Logger(GraphSnapshotExecutionService.name);

  constructor(
    private readonly controlPlane: GraphSnapshotControlPlaneService,
    private readonly artifacts: GraphSnapshotBuildService,
    private readonly pushLeases: PushLeaseService,
  ) {}

  async executePush(job: PushJob, execution: PushExecutionContext) {
    const leaseToken = requireExecutionLease(job, execution);
    if (!job.repoName) throw new BadRequestException(`Push job ${job.id} is missing repoName`);
    const payload = job.payload as unknown as PushPayload;
    if (!payload.parsedVersion) throw new BadRequestException(`Push job ${job.id} missing parsedVersion`);
    // Bound outside the closure: narrowing on a mutable property does not
    // survive into a callback.
    const repoName = job.repoName;
    const parsedVersion = payload.parsedVersion;

    return this.withGraphWriteLease(job, execution, async () => {
      execution.report(PushJobPhase.FinalizingManifest, 0, 3, ProgressUnit.Steps);
      const candidate = await this.controlPlane.assembleCandidate({
        workspaceId: job.workspaceId,
        jobId: job.id,
        executionToken: execution.executionToken,
        leaseToken,
        targets: [
          {
            repoName,
            parsedVersion,
            summaryVersion: payload.excludeSummaries ? null : payload.summaryVersion,
            embeddingsVersion: payload.excludeEmbeddings ? null : payload.embeddingsVersion,
            commitSha: payload.commitSha ?? null,
          },
        ],
      });

      // Resolved before materialization: a target the manifest cannot name is a
      // conflict regardless of what a build would produce, and discovering it
      // after a full workspace build wastes the build.
      const targets = candidate.manifest.repositories.filter((repository) => repository.repoName === repoName);
      if (targets.length !== 1) {
        throw new GraphSnapshotError('artifact_identity_conflict', 'Candidate target repository identity is ambiguous');
      }
      const target = targets[0]!;
      const targetRepoIdentity = candidate.targetRepoIdentities[0];
      if (
        candidate.targetRepoIdentities.length !== 1 ||
        !targetRepoIdentity ||
        targetRepoIdentity.repoKey !== target.repoKey ||
        targetRepoIdentity.repoName !== target.repoName
      ) {
        throw new GraphSnapshotError('artifact_identity_conflict', 'Candidate target repository row is missing');
      }

      execution.report(PushJobPhase.LoadingArtifacts, 1, 3, ProgressUnit.Steps);
      const materialized =
        this.publishedArtifact(candidate) ??
        (await this.artifacts.materialize(candidate.manifest, candidate.versionId, execution.signal));

      const counts = materialized.repositoryCounts[target.repoKey];
      if (!counts) throw new GraphSnapshotError('graph_build_failed', 'Built graph omitted target repository counts');

      // Fence: a renewal loss aborts the execution signal, but nothing between
      // materialize and here would otherwise observe it — without this check a
      // stale writer whose lease was stolen publishes concurrently with the
      // new owner and the lease's one-writer promise silently degrades to
      // CAS-and-retry.
      execution.signal?.throwIfAborted();
      execution.report(PushJobPhase.UpdatingControlPlane, 2, 3, ProgressUnit.Steps);
      const published = await this.controlPlane.publishCandidate({
        workspaceId: job.workspaceId,
        jobId: job.id,
        executionToken: execution.executionToken,
        leaseToken,
        manifest: candidate.manifest,
        versionId: candidate.versionId,
        artifact: {
          r2Key: materialized.r2Key,
          sha256: materialized.sha256,
          sizeBytes: materialized.sizeBytes,
        },
        targetRepos: [
          {
            id: targetRepoIdentity.id,
            repoKey: target.repoKey,
            repoName: target.repoName,
            lastPushedByUserId: job.queuedByUserId ?? 'system',
            nodeCount: counts.nodeCount,
            edgeCount: counts.edgeCount,
          },
        ],
      });
      execution.report(PushJobPhase.Completed, 3, 3, ProgressUnit.Steps);

      return {
        repoName,
        mode: 'full' as const,
        nodesAdded: counts.nodeCount,
        nodesUpdated: 0,
        nodesDeleted: 0,
        edgesDeleted: 0,
        edgesInserted: counts.edgeCount,
        unchanged: 0,
        version: target.parsed.version,
        totalNodeCount: counts.nodeCount,
        totalEdgeCount: counts.edgeCount,
        graphVersionId: published.versionId,
        parentGraphVersionId: published.parentVersionId,
        idempotent: published.idempotent,
        artifact: {
          sha256: materialized.sha256,
          sizeBytes: materialized.sizeBytes,
        },
        resolution: materialized.resolution
          ? { ...materialized.resolution, mapperSha: candidate.manifest.mapper?.sha256 ?? null }
          : null,
      };
    });
  }

  async executeResolve(job: PushJob, execution: PushExecutionContext) {
    const leaseToken = requireExecutionLease(job, execution);
    const payload = (job.payload ?? {}) as unknown as ResolvePayload;
    const targets = payload.targets ?? [];

    return this.withGraphWriteLease(job, execution, async () => {
      execution.report(PushJobPhase.FinalizingManifest, 0, 3, ProgressUnit.Steps);
      const candidate = await this.controlPlane.assembleCandidate({
        workspaceId: job.workspaceId,
        jobId: job.id,
        executionToken: execution.executionToken,
        leaseToken,
        targets: targets.map((target) => ({
          repoName: target.repoName,
          parsedVersion: target.parsedVersion,
          summaryVersion: target.summaryVersion,
          embeddingsVersion: target.embeddingsVersion,
          commitSha: target.commitSha ?? null,
        })),
      });

      execution.report(PushJobPhase.LoadingArtifacts, 1, 3, ProgressUnit.Steps);
      const materialized =
        this.publishedArtifact(candidate) ??
        (await this.artifacts.materialize(candidate.manifest, candidate.versionId, execution.signal));

      const repositories = candidate.targetRepoIdentities.map((identity) => {
        const counts = materialized.repositoryCounts[identity.repoKey];
        if (!counts) {
          throw new GraphSnapshotError('graph_build_failed', 'Built graph omitted a batch repository’s counts');
        }
        return { identity, counts };
      });

      // Same fence as the push path: never publish on a lost lease.
      execution.signal?.throwIfAborted();
      execution.report(PushJobPhase.UpdatingControlPlane, 2, 3, ProgressUnit.Steps);
      const published = await this.controlPlane.publishCandidate({
        workspaceId: job.workspaceId,
        jobId: job.id,
        executionToken: execution.executionToken,
        leaseToken,
        manifest: candidate.manifest,
        versionId: candidate.versionId,
        artifact: {
          r2Key: materialized.r2Key,
          sha256: materialized.sha256,
          sizeBytes: materialized.sizeBytes,
        },
        targetRepos: repositories.map(({ identity, counts }) => ({
          id: identity.id,
          repoKey: identity.repoKey,
          repoName: identity.repoName,
          lastPushedByUserId: job.queuedByUserId ?? 'system',
          nodeCount: counts.nodeCount,
          edgeCount: counts.edgeCount,
        })),
      });
      execution.report(PushJobPhase.Completed, 3, 3, ProgressUnit.Steps);
      return {
        versionId: published.versionId,
        parentVersionId: published.parentVersionId,
        idempotent: published.idempotent,
        artifact: {
          sha256: materialized.sha256,
          sizeBytes: materialized.sizeBytes,
        },
        // Per-repository outcome for the batch, so a client that replaced N
        // pushes with one resolve can still report each repository.
        repositories: repositories.map(({ identity, counts }) => ({
          repoName: identity.repoName,
          nodeCount: counts.nodeCount,
          edgeCount: counts.edgeCount,
        })),
        resolution: materialized.resolution
          ? { ...materialized.resolution, mapperSha: candidate.manifest.mapper?.sha256 ?? null }
          : null,
      };
    });
  }

  /**
   * The candidate is the version already published and active, so the artifact
   * it names already exists with the identity the control plane recorded.
   * Materializing it again would re-download every pinned component and the
   * whole graph object only to rediscover that nothing changed.
   *
   * Returns `null` whenever that shortcut cannot be justified, which sends the
   * caller down the ordinary build path. Nothing here is a correctness
   * boundary: publication still asserts the artifact against its immutable
   * row, and the CAS still decides the outcome.
   */
  private publishedArtifact(candidate: GraphSnapshotCandidate): MaterializedGraphSnapshot | null {
    if (!candidate.matchesActiveVersion || !candidate.activeArtifact) return null;
    const sizeBytes = Number(candidate.activeArtifact.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;

    const repositoryCounts: Record<string, { nodeCount: number; edgeCount: number }> = {};
    for (const identity of candidate.targetRepoIdentities) {
      // Counts are only ever produced by a build. A repository row that has
      // none cannot be reported from the control plane, so let the build
      // produce them rather than answer the caller with a guess.
      const { nodeCount, edgeCount } = identity;
      if (nodeCount === null || edgeCount === null) return null;
      repositoryCounts[identity.repoKey] = { nodeCount, edgeCount };
    }

    return {
      r2Key: candidate.activeArtifact.r2Key,
      sha256: candidate.activeArtifact.sha256,
      sizeBytes,
      // Nothing was resolved: this composition's resolution was computed and
      // asserted when it was first published.
      resolution: null,
      repositoryCounts,
    };
  }

  /**
   * Serializes graph writes across a workspace, the same way the Turso path
   * does. Without it, concurrent pushes for different repositories each
   * assemble a candidate from the same parent and each run a full workspace
   * build, of which all but one lose the publication CAS — every loser having
   * paid for a complete build and left behind an uploaded graph object that no
   * manifest references. CAS plus retry already converge; the lease is what
   * bounds the waste.
   */
  private async withGraphWriteLease<T>(
    job: PushJob,
    execution: PushExecutionContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const ownerToken = randomUUID();
    const lease = await this.pushLeases.acquireGraphWrite(job.workspaceId, ownerToken, execution.signal, () =>
      execution.report(PushJobPhase.WaitingForGraphWrite),
    );
    const renewal = this.pushLeases.startRenewal(
      () => this.pushLeases.renewGraphWrite(job.workspaceId, lease),
      (reason) => {
        // Logged as well as propagated: without an `abort` hook the lost lease
        // would otherwise be invisible while the build kept running.
        this.logger.error(`Graph-write lease lost for workspace ${job.workspaceId}: ${reason.message}`);
        execution.abort?.(reason);
      },
    );
    try {
      return await operation();
    } finally {
      clearInterval(renewal);
      // A failed release is not a failed push: the lease carries a TTL and the
      // next contender takes it once that expires.
      await this.pushLeases.releaseGraphWrite(job.workspaceId, lease).catch((error: unknown) => {
        this.logger.warn(
          `Failed to release the graph-write lease for workspace ${job.workspaceId}: ${(error as Error)?.message}`,
        );
      });
    }
  }
}
