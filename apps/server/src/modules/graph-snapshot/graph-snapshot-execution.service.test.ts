import { describe, expect, it, vi } from 'vitest';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import type { PushJob } from '../../generated/prisma/client.js';
import type { PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import type { PushLeaseService } from '../lease/push-lease.service.js';
import { GraphSnapshotBuildService } from './graph-snapshot-artifact.service.js';
import { GraphSnapshotControlPlaneService } from './graph-snapshot-control-plane.service.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import { GraphSnapshotExecutionService } from './graph-snapshot-execution.service.js';
import type { GraphSnapshotManifestV1 } from '../../libs/pipeline/graph-snapshot.types.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = 'a'.repeat(64);
const TARGET_REPO_IDENTITY = { id: 'repo-row-a', repoKey: 'repo-a', repoName: 'api' } as const;
const ACTIVE_ARTIFACT_KEY = `${WORKSPACE_ID}/graphs/${VERSION_ID}.ladybug`;
const MANIFEST: GraphSnapshotManifestV1 = {
  manifestVersion: 1,
  workspaceId: WORKSPACE_ID,
  parentVersionId: null,
  engine: 'ladybug',
  engineVersion: '0.19.1',
  graphSchemaVersion: 1,
  builderVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
  storageFormatVersion: 1,
  sourcePolicy: 'strip',
  repositories: [
    {
      repoKey: 'repo-a',
      repoName: 'api',
      repoType: 'service',
      httpPrefix: '/api',
      commitSha: 'commit-a',
      parsed: {
        workspaceId: WORKSPACE_ID,
        repoKey: 'repo-a',
        repoName: 'api',
        kind: 'parsed',
        version: '1'.repeat(16),
        r2Key: `${WORKSPACE_ID}/api/results/parsed/${'1'.repeat(16)}.json`,
        sha256: '1'.repeat(64),
        sizeBytes: '100',
      },
      summary: null,
      embeddings: null,
    },
  ],
  mapper: null,
};

function execution(): PushExecutionContext {
  return {
    jobId: 'job-1',
    executionToken: 'token-1',
    leaseOwnerToken: 'lease-1',
    signal: new AbortController().signal,
    report: vi.fn(),
  };
}

function job(overrides: Partial<PushJob> = {}): PushJob {
  return {
    id: 'job-1',
    workspaceId: WORKSPACE_ID,
    repoName: 'api',
    type: 'push',
    payload: { parsedVersion: '1'.repeat(16), commitSha: 'commit-a', executionToken: 'token-1' },
    queuedByUserId: 'user-1',
    ...overrides,
  } as PushJob;
}

function dependencies() {
  const control = {
    assembleCandidate: vi.fn().mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: false,
      activeArtifact: null,
      targetRepoIdentities: [TARGET_REPO_IDENTITY],
    }),
    publishCandidate: vi.fn().mockResolvedValue({
      versionId: VERSION_ID,
      parentVersionId: null,
      idempotent: false,
    }),
  };
  const artifacts = {
    materialize: vi.fn().mockResolvedValue({
      r2Key: `${WORKSPACE_ID}/graphs/${VERSION_ID}.ladybug`,
      sha256: 'f'.repeat(64),
      sizeBytes: 500,
      repositoryCounts: { 'repo-a': { nodeCount: 20, edgeCount: 10 } },
      resolution: { resolved: 2, total: 2, rate: 1, legacyEdges: 0 },
    }),
  };
  const lease = { ownerToken: 'graph-owner', generation: 1n };
  const leases = {
    acquireGraphWrite: vi.fn().mockResolvedValue(lease),
    renewGraphWrite: vi.fn().mockResolvedValue(true),
    releaseGraphWrite: vi.fn().mockResolvedValue(undefined),
    // Unref'd so the timer never holds the test runner open; the service only
    // needs a handle it can clear.
    startRenewal: vi.fn(() => setInterval(() => undefined, 60_000).unref()),
  };
  return {
    control,
    artifacts,
    leases,
    lease,
    service: new GraphSnapshotExecutionService(
      control as unknown as GraphSnapshotControlPlaneService,
      artifacts as unknown as GraphSnapshotBuildService,
      leases as unknown as PushLeaseService,
    ),
  };
}

describe('GraphSnapshotExecutionService', () => {
  it('assembles before materialization, then publishes the verified artifact and target metadata', async () => {
    const { service, control, artifacts } = dependencies();
    const context = execution();

    const result = await service.executePush(job(), context);

    expect(control.assembleCandidate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      executionToken: 'token-1',
      leaseToken: 'lease-1',
      targets: [
        {
          repoName: 'api',
          parsedVersion: '1111111111111111',
          summaryVersion: undefined,
          embeddingsVersion: undefined,
          commitSha: 'commit-a',
        },
      ],
    });
    expect(artifacts.materialize).toHaveBeenCalledWith(MANIFEST, VERSION_ID, context.signal);
    expect(control.publishCandidate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      executionToken: 'token-1',
      leaseToken: 'lease-1',
      manifest: MANIFEST,
      versionId: VERSION_ID,
      artifact: {
        r2Key: `${WORKSPACE_ID}/graphs/${VERSION_ID}.ladybug`,
        sha256: 'f'.repeat(64),
        sizeBytes: 500,
      },
      targetRepos: [
        {
          ...TARGET_REPO_IDENTITY,
          lastPushedByUserId: 'user-1',
          nodeCount: 20,
          edgeCount: 10,
        },
      ],
    });
    expect(control.assembleCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      artifacts.materialize.mock.invocationCallOrder[0],
    );
    expect(artifacts.materialize.mock.invocationCallOrder[0]).toBeLessThan(
      control.publishCandidate.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      repoName: 'api',
      version: '1111111111111111',
      graphVersionId: VERSION_ID,
      totalNodeCount: 20,
      totalEdgeCount: 10,
      resolution: { resolved: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('r2Key');
  });

  it('maps metadata exclusions to explicit null selections and ignores deferResolution for snapshots', async () => {
    const { service, control } = dependencies();
    await service.executePush(
      job({
        payload: {
          executionToken: 'token-1',
          parsedVersion: '1'.repeat(16),
          excludeSummaries: true,
          excludeEmbeddings: true,
          deferResolution: true,
        },
      }),
      execution(),
    );
    expect(control.assembleCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [expect.objectContaining({ summaryVersion: null, embeddingsVersion: null })],
      }),
    );
  });

  it('resolve uses the attempt mapper and exposes only its SHA through resolution metrics', async () => {
    const { service, control } = dependencies();
    const context = execution();
    const liveMapperManifest = {
      ...MANIFEST,
      mapper: {
        r2Key: `${WORKSPACE_ID}/mapper/${'3'.repeat(64)}.json`,
        sha256: '3'.repeat(64),
        sizeBytes: '43',
      },
    } satisfies GraphSnapshotManifestV1;
    control.assembleCandidate.mockResolvedValueOnce({
      manifest: liveMapperManifest,
      versionId: VERSION_ID,
      targetRepoIdentities: [],
    });
    const result = await service.executeResolve(
      job({
        repoName: null,
        type: 'resolve',
        payload: {
          executionToken: 'token-1',
          mapper: {
            r2Key: `${WORKSPACE_ID}/mapper/${'2'.repeat(64)}.json`,
            sha256: '2'.repeat(64),
            sizeBytes: 42,
          },
        },
      }),
      context,
    );

    expect(control.assembleCandidate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      executionToken: 'token-1',
      leaseToken: 'lease-1',
      targets: [],
    });
    expect(control.publishCandidate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: 'job-1',
      executionToken: 'token-1',
      leaseToken: 'lease-1',
      manifest: liveMapperManifest,
      versionId: VERSION_ID,
      artifact: {
        r2Key: `${WORKSPACE_ID}/graphs/${VERSION_ID}.ladybug`,
        sha256: 'f'.repeat(64),
        sizeBytes: 500,
      },
      targetRepos: [],
    });
    expect(result).toMatchObject({
      versionId: VERSION_ID,
      resolution: { resolved: 2, mapperSha: liveMapperManifest.mapper.sha256 },
    });
    expect(JSON.stringify(result)).not.toContain('r2Key');
    expect(JSON.stringify(result)).not.toContain(liveMapperManifest.mapper.r2Key);
  });

  it('publishes a resolve batch as one candidate and reports every repository', async () => {
    const { service, control, artifacts } = dependencies();
    const billing = { id: 'repo-row-b', repoKey: 'repo-b', repoName: 'billing', nodeCount: null, edgeCount: null };
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: false,
      activeArtifact: null,
      targetRepoIdentities: [{ ...TARGET_REPO_IDENTITY, nodeCount: null, edgeCount: null }, billing],
    });
    artifacts.materialize.mockResolvedValue({
      r2Key: ACTIVE_ARTIFACT_KEY,
      sha256: 'f'.repeat(64),
      sizeBytes: 500,
      repositoryCounts: {
        'repo-a': { nodeCount: 20, edgeCount: 10 },
        'repo-b': { nodeCount: 5, edgeCount: 2 },
      },
      resolution: { resolved: 2, total: 2, rate: 1, legacyEdges: 0 },
    });

    const result = await service.executeResolve(
      job({
        type: 'resolve',
        repoName: null,
        payload: {
          executionToken: 'token-1',
          targets: [
            { repoName: 'api', parsedVersion: '1'.repeat(16) },
            { repoName: 'billing', parsedVersion: '2'.repeat(16), commitSha: 'commit-b' },
          ],
        },
      }),
      execution(),
    );

    // One assembly, one build, one publication for the whole batch.
    expect(control.assembleCandidate).toHaveBeenCalledTimes(1);
    expect(artifacts.materialize).toHaveBeenCalledTimes(1);
    expect(control.publishCandidate).toHaveBeenCalledTimes(1);
    expect(control.assembleCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({ repoName: 'api' }),
          expect.objectContaining({ repoName: 'billing', commitSha: 'commit-b' }),
        ],
      }),
    );
    expect(control.publishCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRepos: [
          expect.objectContaining({ repoName: 'api', nodeCount: 20, edgeCount: 10 }),
          expect.objectContaining({ repoName: 'billing', nodeCount: 5, edgeCount: 2 }),
        ],
      }),
    );
    expect(result.repositories).toEqual([
      { repoName: 'api', nodeCount: 20, edgeCount: 10 },
      { repoName: 'billing', nodeCount: 5, edgeCount: 2 },
    ]);
  });

  it('fails a resolve batch whose build omitted a targeted repository', async () => {
    const { service, control, artifacts } = dependencies();
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: false,
      activeArtifact: null,
      targetRepoIdentities: [
        { ...TARGET_REPO_IDENTITY, nodeCount: null, edgeCount: null },
        { id: 'repo-row-b', repoKey: 'repo-b', repoName: 'billing', nodeCount: null, edgeCount: null },
      ],
    });
    artifacts.materialize.mockResolvedValue({
      r2Key: ACTIVE_ARTIFACT_KEY,
      sha256: 'f'.repeat(64),
      sizeBytes: 500,
      repositoryCounts: { 'repo-a': { nodeCount: 20, edgeCount: 10 } },
      resolution: null,
    });

    await expect(
      service.executeResolve(
        job({
          type: 'resolve',
          repoName: null,
          payload: {
            executionToken: 'token-1',
            targets: [
              { repoName: 'api', parsedVersion: '1'.repeat(16) },
              { repoName: 'billing', parsedVersion: '2'.repeat(16) },
            ],
          },
        }),
        execution(),
      ),
    ).rejects.toMatchObject({ code: 'graph_build_failed' });
    expect(control.publishCandidate).not.toHaveBeenCalled();
  });

  it('holds the workspace graph-write lease across assembly and publication, and releases it', async () => {
    const { service, control, leases, lease } = dependencies();
    const context = execution();

    await service.executePush(job(), context);

    expect(leases.acquireGraphWrite).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.any(String),
      context.signal,
      expect.any(Function),
    );
    expect(leases.acquireGraphWrite.mock.invocationCallOrder[0]!).toBeLessThan(
      control.assembleCandidate.mock.invocationCallOrder[0]!,
    );
    expect(leases.releaseGraphWrite).toHaveBeenCalledWith(WORKSPACE_ID, lease);
    expect(leases.releaseGraphWrite.mock.invocationCallOrder[0]!).toBeGreaterThan(
      control.publishCandidate.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses to publish once the execution signal has aborted (lost lease fence)', async () => {
    const { service, control, artifacts } = dependencies();
    const controller = new AbortController();
    const context = { ...execution(), signal: controller.signal, abort: (reason: Error) => controller.abort(reason) };
    artifacts.materialize.mockImplementation(async () => {
      // Renewal loss arrives mid-build; the fence must stop the publish.
      controller.abort(new Error('Distributed push lease was lost'));
      return {
        r2Key: ACTIVE_ARTIFACT_KEY,
        sha256: 'f'.repeat(64),
        sizeBytes: 500,
        repositoryCounts: { 'repo-a': { nodeCount: 20, edgeCount: 10 } },
        resolution: null,
      };
    });

    await expect(service.executePush(job(), context)).rejects.toThrow('Distributed push lease was lost');
    expect(control.publishCandidate).not.toHaveBeenCalled();
  });

  it('releases the graph-write lease when the attempt fails', async () => {
    const { service, control, leases, lease } = dependencies();
    control.assembleCandidate.mockRejectedValue(new GraphSnapshotError('graph_parent_conflict', 'stale parent'));

    await expect(service.executePush(job(), execution())).rejects.toMatchObject({ code: 'graph_parent_conflict' });

    expect(leases.releaseGraphWrite).toHaveBeenCalledWith(WORKSPACE_ID, lease);
  });

  it('publishes an unchanged candidate without materializing the active artifact', async () => {
    const { service, control, artifacts } = dependencies();
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: true,
      activeArtifact: { r2Key: ACTIVE_ARTIFACT_KEY, sha256: 'b'.repeat(64), sizeBytes: '4096' },
      targetRepoIdentities: [{ ...TARGET_REPO_IDENTITY, nodeCount: 20, edgeCount: 10 }],
    });
    control.publishCandidate.mockResolvedValue({ versionId: VERSION_ID, parentVersionId: null, idempotent: true });

    const result = await service.executePush(job(), execution());

    expect(artifacts.materialize).not.toHaveBeenCalled();
    expect(control.publishCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: { r2Key: ACTIVE_ARTIFACT_KEY, sha256: 'b'.repeat(64), sizeBytes: 4096 },
        targetRepos: [expect.objectContaining({ nodeCount: 20, edgeCount: 10 })],
      }),
    );
    expect(result).toMatchObject({
      idempotent: true,
      totalNodeCount: 20,
      totalEdgeCount: 10,
      artifact: { sha256: 'b'.repeat(64), sizeBytes: 4096 },
      resolution: null,
    });
  });

  it('resolves an unchanged candidate without materializing the active artifact', async () => {
    const { service, control, artifacts } = dependencies();
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: true,
      activeArtifact: { r2Key: ACTIVE_ARTIFACT_KEY, sha256: 'b'.repeat(64), sizeBytes: '4096' },
      targetRepoIdentities: [],
    });
    control.publishCandidate.mockResolvedValue({ versionId: VERSION_ID, parentVersionId: null, idempotent: true });

    const result = await service.executeResolve(job({ type: 'resolve', repoName: null }), execution());

    expect(artifacts.materialize).not.toHaveBeenCalled();
    expect(result).toMatchObject({ versionId: VERSION_ID, idempotent: true, resolution: null });
  });

  it('rebuilds an unchanged candidate whose target repository has no persisted counts', async () => {
    const { service, control, artifacts } = dependencies();
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: true,
      activeArtifact: { r2Key: ACTIVE_ARTIFACT_KEY, sha256: 'b'.repeat(64), sizeBytes: '4096' },
      targetRepoIdentities: [{ ...TARGET_REPO_IDENTITY, nodeCount: null, edgeCount: null }],
    });

    const result = await service.executePush(job(), execution());

    // Counts only ever come from a build, so the shortcut must not answer with
    // a guess — it falls back to the ordinary path.
    expect(artifacts.materialize).toHaveBeenCalledWith(MANIFEST, VERSION_ID, expect.anything());
    expect(result).toMatchObject({ totalNodeCount: 20, totalEdgeCount: 10 });
  });

  it('rebuilds an unchanged candidate whose active artifact identity is unusable', async () => {
    const { service, control, artifacts } = dependencies();
    control.assembleCandidate.mockResolvedValue({
      manifest: MANIFEST,
      versionId: VERSION_ID,
      matchesActiveVersion: true,
      activeArtifact: null,
      targetRepoIdentities: [{ ...TARGET_REPO_IDENTITY, nodeCount: 20, edgeCount: 10 }],
    });

    await service.executePush(job(), execution());

    expect(artifacts.materialize).toHaveBeenCalledWith(MANIFEST, VERSION_ID, expect.anything());
  });
});
