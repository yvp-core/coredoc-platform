import { BadRequestException, Injectable } from '@nestjs/common';
import { PushService } from '../push/push.service.js';
import { ResolverService } from '../mapper/resolver.service.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { RenormalizeService } from '../delivery/renormalize.service.js';
import type { ConnectorSyncPayload, PushPayload, RenormalizePayload } from '../../libs/pipeline/job-payload.types.js';
import type { PushJob } from '../../generated/prisma/client.js';
import type { PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import { PushJobPhase } from '../../libs/pipeline/push-execution.types.js';
import { GraphSnapshotExecutionService } from '../graph-snapshot/graph-snapshot-execution.service.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import { GraphBackend } from '../../database/graph-backend.js';

@Injectable()
export class JobProcessor {
  constructor(
    private readonly pushService: PushService,
    private readonly resolverService: ResolverService,
    private readonly delivery: DeliveryService,
    private readonly renormalize: RenormalizeService,
    private readonly graphSnapshots: GraphSnapshotExecutionService,
  ) {}

  /**
   * Process a single job. Throws on failure (worker classifies + retries).
   * Returns the typed result for `PushJob.result`.
   *
   * Payload-shape errors throw `BadRequestException` so the worker's classifier
   * (push-worker.service.ts: `isPermanent`) marks them failed immediately
   * instead of burning the full retry budget (30s + 2m + 10m ≈ 12 min wasted
   * on a payload that will never succeed).
   */
  async process(job: PushJob, execution?: PushExecutionContext): Promise<unknown> {
    const userId = job.queuedByUserId ?? 'system';

    if (job.type === 'push') {
      if (!job.repoName) {
        throw new BadRequestException(`Push job ${job.id} is missing repoName`);
      }
      const payload = job.payload as unknown as PushPayload;
      // Per-payload defer flag. Default false → worker runs the inline resolver
      // for direct API callers that don't enqueue their own resolve job.
      // Batched callers (`coredoc sync`) set this to true and trigger one
      // resolve job at the end of the batch.
      const defer = payload.deferResolution ?? false;
      if (!payload.parsedVersion) {
        throw new BadRequestException(`Push job ${job.id} missing parsedVersion`);
      }
      const backend = await this.pushService.getWorkspaceGraphBackend(job.workspaceId);
      if (backend === GraphBackend.FileSnapshot) {
        if (!execution) {
          throw new GraphSnapshotError(
            'file_snapshot_requires_worker',
            'File-snapshot pushes require a durable worker context',
          );
        }
        return this.graphSnapshots.executePush(job, execution);
      }
      const push = this.pushService.pushByVersion(
        job.workspaceId,
        job.repoName,
        payload.parsedVersion,
        payload.commitSha ?? null,
        userId,
        payload.summaryVersion,
        payload.embeddingsVersion,
        defer,
        payload.rebuild ?? false,
        {
          excludeSummaries: payload.excludeSummaries ?? false,
          excludeEmbeddings: payload.excludeEmbeddings ?? false,
        },
        ...(execution ? [execution] : []),
      );
      return push;
    }

    if (job.type === 'resolve') {
      const backend = await this.pushService.getWorkspaceGraphBackend(job.workspaceId);
      if (backend === GraphBackend.FileSnapshot) {
        if (!execution) {
          throw new GraphSnapshotError(
            'file_snapshot_requires_worker',
            'File-snapshot resolution requires a durable worker context',
          );
        }
        return this.graphSnapshots.executeResolve(job, execution);
      }
      // Defensive twin of the controller guard: a targeted resolve reaching
      // the Turso path would run targetless and report success while
      // publishing none of its batch. Reachable if the workspace backend
      // changes between enqueue and claim.
      const resolveTargets = (job.payload as { targets?: unknown[] } | null)?.targets;
      if (Array.isArray(resolveTargets) && resolveTargets.length > 0) {
        throw new GraphSnapshotError(
          'graph_backend_conflict',
          `Resolve job ${job.id} carries batch targets but workspace ${job.workspaceId} is on Turso`,
        );
      }
      if (!execution) return this.resolverService.resolveWorkspace(job.workspaceId);
      execution.report(PushJobPhase.Resolving);
      return this.resolverService.resolveWorkspace(job.workspaceId, {
        ownerToken: execution.leaseOwnerToken ?? job.leaseToken!,
        signal: execution.signal,
        onWait: () => execution.report(PushJobPhase.WaitingForGraphWrite),
        onLeaseLost: (reason) => execution.abort?.(reason),
      });
    }

    if (job.type === 'connector_sync') {
      // Flag gate: a job queued before the workspace disabled delivery must SUCCEED as
      // skipped, never throw. Throwing would mark it failed and burn the full retry
      // budget on work that is now intentionally off. The same guard fronts all three
      // delivery job types below.
      if (!(await this.delivery.isDeliveryEnabled(job.workspaceId))) {
        return { skipped: 'delivery_disabled' };
      }
      const payload = job.payload as unknown as ConnectorSyncPayload;
      if (!payload.connectorId) {
        throw new BadRequestException(`connector_sync job ${job.id} missing connectorId`);
      }
      return this.delivery.runConnectorSync(payload.connectorId);
    }

    if (job.type === 'renormalize') {
      // Flag gate (see connector_sync): skip-as-success on a disabled workspace.
      if (!(await this.delivery.isDeliveryEnabled(job.workspaceId))) {
        return { skipped: 'delivery_disabled' };
      }
      const payload = job.payload as unknown as RenormalizePayload;
      return this.renormalize.renormalizeWorkspace(job.workspaceId, payload);
    }

    throw new BadRequestException(`Unknown job type: ${job.type}`);
  }
}
