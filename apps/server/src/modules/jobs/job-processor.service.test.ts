import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { JobProcessor } from './job-processor.service.js';
import type { PushService } from '../push/push.service.js';
import type { ResolverService } from '../mapper/resolver.service.js';
import type { DeliveryService } from '../delivery/delivery.service.js';
import type { RenormalizeService } from '../delivery/renormalize.service.js';
import type { GraphSnapshotExecutionService } from '../graph-snapshot/graph-snapshot-execution.service.js';
import type { PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job_1',
    workspaceId: 'ws_1',
    repoName: 'gateway',
    type: 'push',
    payload: { parsedVersion: 'v1', commitSha: 'sha_a' },
    queuedByUserId: 'user_1',
    ...overrides,
  } as Parameters<JobProcessor['process']>[0];
}

describe('JobProcessor', () => {
  let pushService: { pushByVersion: ReturnType<typeof vi.fn>; getWorkspaceGraphBackend: ReturnType<typeof vi.fn> };
  let resolverService: { resolveWorkspace: ReturnType<typeof vi.fn> };
  let delivery: { runConnectorSync: ReturnType<typeof vi.fn>; isDeliveryEnabled: ReturnType<typeof vi.fn> };
  let renormalize: { renormalizeWorkspace: ReturnType<typeof vi.fn> };
  let graphSnapshots: { executePush: ReturnType<typeof vi.fn>; executeResolve: ReturnType<typeof vi.fn> };
  let processor: JobProcessor;

  beforeEach(() => {
    pushService = {
      getWorkspaceGraphBackend: vi.fn(async () => 'turso'),
      pushByVersion: vi.fn(async () => ({ repoName: 'gateway', mode: 'incremental', totalNodeCount: 10 })),
    };
    resolverService = {
      resolveWorkspace: vi.fn(async () => ({ resolved: 10, total: 20, rate: 0.5, legacyEdges: 1, mapperSha: null })),
    };
    delivery = {
      runConnectorSync: vi.fn(async () => ({ repos: 1, prs: 3 })),
      // Delivery enabled by default; individual skip tests flip it to false.
      isDeliveryEnabled: vi.fn(async () => true),
    };
    renormalize = {
      renormalizeWorkspace: vi.fn(async () => ({ scanned: 4, renormalized: 3, skipped: 1 })),
    };
    graphSnapshots = {
      executePush: vi.fn(async () => ({ repoName: 'gateway', graphVersionId: 'a'.repeat(64) })),
      executeResolve: vi.fn(async () => ({ versionId: 'a'.repeat(64) })),
    };
    processor = new JobProcessor(
      pushService as unknown as PushService,
      resolverService as unknown as ResolverService,
      delivery as unknown as DeliveryService,
      renormalize as unknown as RenormalizeService,
      graphSnapshots as unknown as GraphSnapshotExecutionService,
    );
  });

  function execution(): PushExecutionContext {
    return {
      jobId: 'job_1',
      executionToken: 'token_1',
      leaseOwnerToken: 'lease_1',
      signal: new AbortController().signal,
      report: vi.fn(),
    };
  }

  it('type=push + parsedVersion (no defer in payload) → calls pushByVersion with deferResolution=false', async () => {
    await processor.process(makeJob());
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      'sha_a',
      'user_1',
      undefined,
      undefined,
      false,
      false,
      { excludeSummaries: false, excludeEmbeddings: false },
    );
  });

  it('type=push + parsedVersion with deferResolution=true in payload → forwards true', async () => {
    await processor.process(makeJob({ payload: { parsedVersion: 'v1', commitSha: 'sha_a', deferResolution: true } }));
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      'sha_a',
      'user_1',
      undefined,
      undefined,
      true,
      false,
      { excludeSummaries: false, excludeEmbeddings: false },
    );
  });

  it('type=push + parsedVersion with embeddingsVersion → forwards embeddingsVersion', async () => {
    await processor.process(
      makeJob({ payload: { parsedVersion: 'v1', commitSha: 'sha_a', embeddingsVersion: 'emb_v1' } }),
    );
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      'sha_a',
      'user_1',
      undefined,
      'emb_v1',
      false,
      false,
      { excludeSummaries: false, excludeEmbeddings: false },
    );
  });

  it('type=push with metadata exclusions → forwards them to pushByVersion', async () => {
    await processor.process(
      makeJob({ payload: { parsedVersion: 'v1', excludeSummaries: true, excludeEmbeddings: true } }),
    );
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      null,
      'user_1',
      undefined,
      undefined,
      false,
      false,
      { excludeSummaries: true, excludeEmbeddings: true },
    );
  });

  it('type=resolve → calls resolveWorkspace', async () => {
    await processor.process(makeJob({ type: 'resolve', repoName: null, payload: {} }));
    expect(resolverService.resolveWorkspace).toHaveBeenCalledWith('ws_1');
  });

  it('file_snapshot push dispatches the durable pinned builder and never calls the live Turso push path', async () => {
    pushService.getWorkspaceGraphBackend.mockResolvedValueOnce('file_snapshot');
    const queued = makeJob({ payload: { parsedVersion: 'v1', executionToken: 'token_1' } });
    const context = execution();

    await processor.process(queued, context);

    expect(graphSnapshots.executePush).toHaveBeenCalledWith(queued, context);
    expect(pushService.pushByVersion).not.toHaveBeenCalled();
  });

  it('file_snapshot resolve dispatches a snapshot rebuild and never calls the live resolver', async () => {
    pushService.getWorkspaceGraphBackend.mockResolvedValueOnce('file_snapshot');
    const queued = makeJob({ type: 'resolve', repoName: null, payload: { executionToken: 'token_1' } });
    const context = execution();

    await processor.process(queued, context);

    expect(graphSnapshots.executeResolve).toHaveBeenCalledWith(queued, context);
    expect(resolverService.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('file_snapshot graph changes fail closed without the durable worker context', async () => {
    pushService.getWorkspaceGraphBackend.mockResolvedValueOnce('file_snapshot');
    await expect(processor.process(makeJob())).rejects.toMatchObject({ code: 'file_snapshot_requires_worker' });
    expect(graphSnapshots.executePush).not.toHaveBeenCalled();
  });

  it('type=connector_sync → dispatches through DeliveryService.runConnectorSync with payload connectorId', async () => {
    const result = await processor.process(
      makeJob({ type: 'connector_sync', repoName: 'conn-1', payload: { connectorId: 'conn-1' } }),
    );
    expect(delivery.runConnectorSync).toHaveBeenCalledWith('conn-1');
    expect(result).toEqual({ repos: 1, prs: 3 });
  });

  it('type=renormalize → dispatches to RenormalizeService.renormalizeWorkspace with workspaceId + payload', async () => {
    const result = await processor.process(
      makeJob({ type: 'renormalize', repoName: 'renormalize', payload: { connectorId: 'conn-1' } }),
    );
    expect(renormalize.renormalizeWorkspace).toHaveBeenCalledWith('ws_1', { connectorId: 'conn-1' });
    // the job result is the renormalize result
    expect(result).toEqual({ scanned: 4, renormalized: 3, skipped: 1 });
  });

  // ── delivery flag gating: a queued job racing a mid-flight disable succeeds as skipped ──

  it('type=connector_sync + delivery disabled → skips without importing and returns {skipped}', async () => {
    delivery.isDeliveryEnabled.mockResolvedValueOnce(false);
    const result = await processor.process(
      makeJob({ type: 'connector_sync', repoName: 'conn-1', payload: { connectorId: 'conn-1' } }),
    );
    expect(result).toEqual({ skipped: 'delivery_disabled' });
    expect(delivery.isDeliveryEnabled).toHaveBeenCalledWith('ws_1');
    expect(delivery.runConnectorSync).not.toHaveBeenCalled();
  });

  it('type=renormalize + delivery disabled → skips without replaying and returns {skipped}', async () => {
    delivery.isDeliveryEnabled.mockResolvedValueOnce(false);
    const result = await processor.process(makeJob({ type: 'renormalize', repoName: 'renormalize', payload: {} }));
    expect(result).toEqual({ skipped: 'delivery_disabled' });
    expect(renormalize.renormalizeWorkspace).not.toHaveBeenCalled();
  });

  it('type=connector_sync missing connectorId → throws BadRequestException', async () => {
    await expect(
      processor.process(makeJob({ type: 'connector_sync', repoName: null, payload: {} })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(delivery.runConnectorSync).not.toHaveBeenCalled();
  });

  it('uses "system" for queuedByUserId when null', async () => {
    await processor.process(makeJob({ queuedByUserId: null }));
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      'sha_a',
      'system',
      undefined,
      undefined,
      false,
      false,
      { excludeSummaries: false, excludeEmbeddings: false },
    );
  });

  it('type=push with rebuild=true in payload → forwards the rebuild flag', async () => {
    // The explicit path for a parse the diff engine refuses to apply on its
    // own; without forwarding it the queued push silently diffs anyway.
    await processor.process(makeJob({ payload: { parsedVersion: 'v1', commitSha: 'sha_a', rebuild: true } }));
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      'sha_a',
      'user_1',
      undefined,
      undefined,
      false,
      true,
      { excludeSummaries: false, excludeEmbeddings: false },
    );
  });
});
