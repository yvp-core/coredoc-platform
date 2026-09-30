import { describe, expect, it, vi } from 'vitest';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import type { PrismaService } from '../../database/prisma.service.js';
import { canonicalizeJson, createGraphSnapshotIdentity, graphSnapshotR2Key } from './graph-snapshot-manifest.js';
import type {
  GraphSnapshotManifestV1,
  GraphSnapshotRepositoryManifest,
  WorkspaceRepoArtifactDescriptor,
  WorkspaceRepoArtifactKind,
} from './graph-snapshot.types.js';
import { GraphSnapshotControlPlaneService } from './graph-snapshot-control-plane.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = 'job-1';
const TOKEN = 'token-1';
const LEASE_TOKEN = 'lease-1';
const ACTIVE_ARTIFACT_SHA = 'a'.repeat(64);

function publishTarget(
  overrides: Partial<{
    id: string;
    repoKey: string;
    repoName: string;
    lastPushedByUserId: string;
    nodeCount: number;
    edgeCount: number;
  }> = {},
) {
  return {
    id: 'repo-row-a',
    repoKey: 'repo-a',
    repoName: 'api',
    lastPushedByUserId: 'user-1',
    nodeCount: 1,
    edgeCount: 2,
    ...overrides,
  };
}

function artifact(
  repoKey: string,
  repoName: string,
  kind: WorkspaceRepoArtifactKind,
  seed: string,
): WorkspaceRepoArtifactDescriptor {
  const directory = kind === 'parsed' ? 'parsed' : kind === 'summary' ? 'summaries' : 'embeddings';
  const version = kind === 'parsed' ? seed.repeat(16) : `${kind === 'summary' ? 'sum' : 'emb'}_${seed.repeat(16)}`;
  return {
    workspaceId: WORKSPACE_ID,
    repoKey,
    repoName,
    kind,
    version,
    r2Key: `${WORKSPACE_ID}/${repoName}/results/${directory}/${version}.json`,
    sha256: seed.repeat(64),
    sizeBytes: '42',
  };
}

function repository(repoKey: string, repoName: string, seed: string): GraphSnapshotRepositoryManifest {
  return {
    repoKey,
    repoName,
    repoType: 'service',
    httpPrefix: `/${repoName}`,
    commitSha: null,
    parsed: artifact(repoKey, repoName, 'parsed', seed),
    summary: artifact(repoKey, repoName, 'summary', seed),
    embeddings: artifact(repoKey, repoName, 'embeddings', seed),
  };
}

function manifest(parentVersionId: string | null = null): GraphSnapshotManifestV1 {
  return {
    manifestVersion: 1,
    workspaceId: WORKSPACE_ID,
    parentVersionId,
    ...GRAPH_FILE_FORMAT_COMPATIBILITY,
    sourcePolicy: 'strip',
    repositories: [repository('repo-a', 'api', 'a'), repository('repo-b', 'billing', 'b')],
    mapper: null,
  };
}

function persistedArtifact(value: WorkspaceRepoArtifactDescriptor) {
  return { ...value, sizeBytes: BigInt(value.sizeBytes), createdAt: new Date('2026-08-11T00:00:00Z') };
}

function sqlText(call: unknown[]): string {
  return Array.from(call[0] as TemplateStringsArray).join('?');
}

function transactionPrisma(transaction: Record<string, unknown>) {
  // Publication reads the DB clock (`SELECT NOW()`) so lastPushedAt shares a
  // clock source with pushJob.queuedAt; give every mocked transaction one.
  if (!('$queryRaw' in transaction)) {
    (transaction as { $queryRaw?: unknown }).$queryRaw = vi.fn().mockResolvedValue([{ now: new Date() }]);
  }
  return {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
  } as unknown as PrismaService & { $transaction: ReturnType<typeof vi.fn> };
}

function appliedRepoRows(value: GraphSnapshotManifestV1 = manifest()) {
  return value.repositories.map((repo) => ({
    id: `repo-row-${repo.repoKey}`,
    workspaceId: WORKSPACE_ID,
    repoKey: repo.repoKey,
    repoName: repo.repoName,
    repoType: repo.repoType,
    httpPrefix: repo.httpPrefix,
    lastParsedVersion: repo.parsed.version,
    lastSummaryVersion: repo.summary?.version ?? null,
    lastEmbedVersion: repo.embeddings?.version ?? null,
    lastParseHash: repo.parsed.version,
    lastPushedAt: new Date('2026-08-11T00:00:00Z'),
    nodeCount: 12,
    edgeCount: 7,
  }));
}

function staleCompatibilityManifest(): GraphSnapshotManifestV1 {
  return {
    ...manifest(),
    engineVersion: '0.12.0',
    graphSchemaVersion: 9,
    builderVersion: 'phase2-v1',
    storageFormatVersion: 2,
  };
}

function candidateNoOpHarness(parent: GraphSnapshotManifestV1, jobType: 'push' | 'resolve') {
  const parentIdentity = createGraphSnapshotIdentity(parent);
  const artifactRead = vi.fn(() => {
    throw new Error('a content no-op must not reread component descriptors');
  });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    pushJob: {
      findFirst: vi.fn().mockImplementation(async () => ({
        id: JOB_ID,
        workspaceId: WORKSPACE_ID,
        type: jobType,
        status: 'running',
        leaseToken: LEASE_TOKEN,
        repoName: jobType === 'push' ? 'api' : null,
        payload: { executionToken: TOKEN },
      })),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        id: WORKSPACE_ID,
        graphBackend: 'file_snapshot',
        activeGraphVersionId: parentIdentity.versionId,
      }),
    },
    intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    workspaceRepo: { findMany: vi.fn().mockResolvedValue(appliedRepoRows(parent)) },
    workspaceGraphVersion: {
      findUnique: vi.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        versionId: parentIdentity.versionId,
        manifest: parentIdentity.manifest,
        r2Key: graphSnapshotR2Key(WORKSPACE_ID, parentIdentity.versionId),
        sha256: ACTIVE_ARTIFACT_SHA,
        sizeBytes: 4096n,
      }),
    },
    workspaceRepoArtifact: { findUnique: artifactRead },
    mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return {
    artifactRead,
    graphVersionRead: tx.workspaceGraphVersion.findUnique,
    parentIdentity,
    service: new GraphSnapshotControlPlaneService(transactionPrisma(tx)),
  };
}

function artifactRegistryReader(values: readonly WorkspaceRepoArtifactDescriptor[]) {
  return vi.fn().mockImplementation(async ({ where }) => {
    const identity = where.workspaceId_repoKey_kind_version;
    const found = values.find(
      (entry) =>
        entry.workspaceId === identity.workspaceId &&
        entry.repoKey === identity.repoKey &&
        entry.kind === identity.kind &&
        entry.version === identity.version,
    );
    return found ? persistedArtifact(found) : null;
  });
}

describe('GraphSnapshotControlPlaneService artifact registry', () => {
  it('rejects zero or ambiguous exact repo-name matches before inserting a selectable descriptor', async () => {
    for (const matches of [
      [],
      [
        { workspaceId: WORKSPACE_ID, repoKey: 'a', repoName: 'api' },
        { workspaceId: WORKSPACE_ID, repoKey: 'b', repoName: 'api' },
      ],
    ]) {
      const createMany = vi.fn();
      const prisma = {
        intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        workspaceRepo: { findMany: vi.fn().mockResolvedValue(matches) },
        workspaceRepoArtifact: { createMany, findUnique: vi.fn() },
      } as unknown as PrismaService;
      const service = new GraphSnapshotControlPlaneService(prisma);

      await expect(
        service.registerArtifact({
          workspaceId: WORKSPACE_ID,
          repoName: 'api',
          kind: 'parsed',
          version: 'a'.repeat(16),
          r2Key: `${WORKSPACE_ID}/api/results/parsed/${'a'.repeat(16)}.json`,
          sha256: 'a'.repeat(64),
          sizeBytes: 42,
        }),
      ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
      expect(createMany).not.toHaveBeenCalled();
    }
  });

  it('uses insert-on-conflict-do-nothing, compound reload, and exact immutable verification', async () => {
    const expected = artifact('repo-a', 'api', 'parsed', 'a');
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn().mockResolvedValue(persistedArtifact(expected));
    const prisma = {
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([{ workspaceId: WORKSPACE_ID, repoKey: 'repo-a', repoName: 'api' }]),
      },
      workspaceRepoArtifact: { createMany, findUnique },
    } as unknown as PrismaService;
    const service = new GraphSnapshotControlPlaneService(prisma);

    await expect(
      service.registerArtifact({
        workspaceId: WORKSPACE_ID,
        repoName: 'api',
        kind: 'parsed',
        version: expected.version,
        r2Key: expected.r2Key,
        sha256: expected.sha256,
        sizeBytes: 42,
      }),
    ).resolves.toEqual(expected);

    expect(createMany).toHaveBeenCalledWith({
      data: [{ ...expected, sizeBytes: 42n }],
      skipDuplicates: true,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_repoKey_kind_version: {
          workspaceId: WORKSPACE_ID,
          repoKey: 'repo-a',
          kind: 'parsed',
          version: expected.version,
        },
      },
    });

    findUnique.mockResolvedValueOnce({ ...persistedArtifact(expected), sha256: 'b'.repeat(64) });
    await expect(
      service.registerArtifact({
        workspaceId: WORKSPACE_ID,
        repoName: 'api',
        kind: 'parsed',
        version: expected.version,
        r2Key: expected.r2Key,
        sha256: expected.sha256,
        sizeBytes: 42,
      }),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
  });
});

describe('GraphSnapshotControlPlaneService attempt assembly', () => {
  it('keeps the payload target fixed while refreshing the live parent and mapper without persisting a pin', async () => {
    const target = repository('repo-a', 'api', 'd');
    const firstParent = manifest();
    const secondParent = {
      ...manifest(),
      repositories: [repository('repo-a', 'api', 'a'), repository('repo-b', 'billing', 'c')],
    } satisfies GraphSnapshotManifestV1;
    const parents = [createGraphSnapshotIdentity(firstParent), createGraphSnapshotIdentity(secondParent)];
    const mappers = [
      {
        r2Key: `${WORKSPACE_ID}/mappers/mapper-a.json`,
        sha256: 'e'.repeat(64),
        sizeBytes: 21n,
      },
      {
        r2Key: `${WORKSPACE_ID}/mappers/mapper-b.json`,
        sha256: 'f'.repeat(64),
        sizeBytes: 22n,
      },
    ];
    let attempt = 0;
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockImplementation(async () => ({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parents[attempt]!.versionId,
        })),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...appliedRepoRows(firstParent)[0],
            lastParsedVersion: '9'.repeat(16),
            lastSummaryVersion: `sum_${'9'.repeat(16)}`,
            lastEmbedVersion: `emb_${'9'.repeat(16)}`,
          },
          appliedRepoRows(firstParent)[1],
        ]),
      },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockImplementation(async () => ({
          workspaceId: WORKSPACE_ID,
          versionId: parents[attempt]!.versionId,
          manifest: parents[attempt]!.manifest,
        })),
      },
      workspaceRepoArtifact: {
        findUnique: artifactRegistryReader(
          [target.parsed, target.summary, target.embeddings].filter(
            (value): value is WorkspaceRepoArtifactDescriptor => value !== null,
          ),
        ),
      },
      mapperArtifact: {
        findUnique: vi.fn().mockImplementation(async () => mappers[attempt]),
      },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));
    const input = {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [
        {
          repoName: 'api',
          parsedVersion: target.parsed.version,
          summaryVersion: target.summary?.version,
          embeddingsVersion: target.embeddings?.version,
        },
      ],
    };

    const first = await service.assembleCandidate(input);
    attempt = 1;
    const second = await service.assembleCandidate(input);

    expect(first.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-a')?.parsed.version).toBe(
      target.parsed.version,
    );
    expect(second.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-a')?.parsed.version).toBe(
      target.parsed.version,
    );
    expect(second.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-a')?.summary?.version).toBe(
      target.summary?.version,
    );
    expect(second.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-a')?.embeddings?.version).toBe(
      target.embeddings?.version,
    );
    expect(first.manifest.mapper?.sha256).toBe(mappers[0]!.sha256);
    expect(second.manifest.mapper?.sha256).toBe(mappers[1]!.sha256);
    expect(second.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-b')?.parsed.version).toBe(
      secondParent.repositories[1]!.parsed.version,
    );
    expect(second.versionId).not.toBe(first.versionId);
  });
});

describe('GraphSnapshotControlPlaneService attempt candidates', () => {
  it('derives a live-compatible child for a repository content no-op on a stale parent', async () => {
    const parent = staleCompatibilityManifest();
    const { artifactRead, parentIdentity, service } = candidateNoOpHarness(parent, 'push');
    const target = parent.repositories.find(({ repoKey }) => repoKey === 'repo-a')!;

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [
        {
          repoName: target.repoName,
          parsedVersion: target.parsed.version,
          summaryVersion: target.summary?.version ?? null,
          embeddingsVersion: target.embeddings?.version ?? null,
          commitSha: target.commitSha,
        },
      ],
    });

    expect(candidate.manifest).toMatchObject(GRAPH_FILE_FORMAT_COMPATIBILITY);
    expect(candidate.manifest.parentVersionId).toBe(parentIdentity.versionId);
    expect(candidate.versionId).not.toBe(parentIdentity.versionId);
    expect(candidate.manifest.repositories).toEqual(parentIdentity.manifest.repositories);
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('derives a live-compatible child for a mapper-only no-op on a stale parent', async () => {
    const parent = staleCompatibilityManifest();
    const { artifactRead, parentIdentity, service } = candidateNoOpHarness(parent, 'resolve');

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
    });

    expect(candidate.manifest).toMatchObject(GRAPH_FILE_FORMAT_COMPATIBILITY);
    expect(candidate.manifest.parentVersionId).toBe(parentIdentity.versionId);
    expect(candidate.versionId).not.toBe(parentIdentity.versionId);
    expect(candidate.manifest.repositories).toEqual(parentIdentity.manifest.repositories);
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('keeps a current compatible repository content no-op idempotent', async () => {
    const parent = manifest();
    const { artifactRead, parentIdentity, service } = candidateNoOpHarness(parent, 'push');
    const target = parent.repositories.find(({ repoKey }) => repoKey === 'repo-a')!;

    await expect(
      service.assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        targets: [
          {
            repoName: target.repoName,
            parsedVersion: target.parsed.version,
            summaryVersion: target.summary?.version ?? null,
            embeddingsVersion: target.embeddings?.version ?? null,
            commitSha: target.commitSha,
          },
        ],
      }),
    ).resolves.toEqual({
      manifest: parentIdentity.manifest,
      versionId: parentIdentity.versionId,
      matchesActiveVersion: true,
      activeArtifact: {
        r2Key: graphSnapshotR2Key(WORKSPACE_ID, parentIdentity.versionId),
        sha256: ACTIVE_ARTIFACT_SHA,
        sizeBytes: '4096',
      },
      targetRepoIdentities: [
        {
          id: 'repo-row-repo-a',
          repoKey: 'repo-a',
          repoName: 'api',
          nodeCount: 12,
          edgeCount: 7,
        },
      ],
    });
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('withholds the active artifact when its stored key is not canonical', async () => {
    const parent = manifest();
    const { parentIdentity, service, graphVersionRead } = candidateNoOpHarness(parent, 'resolve');
    graphVersionRead.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      versionId: parentIdentity.versionId,
      manifest: parentIdentity.manifest,
      r2Key: `workspaces/${WORKSPACE_ID}/graph/some-other-object.ladybug`,
      sha256: ACTIVE_ARTIFACT_SHA,
      sizeBytes: 4096n,
    });

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
    });

    // Still an unchanged composition — but with no usable artifact identity the
    // caller must rebuild rather than trust the row.
    expect(candidate.versionId).toBe(parentIdentity.versionId);
    expect(candidate.matchesActiveVersion).toBe(true);
    expect(candidate.activeArtifact).toBeNull();
  });

  it('assembles all selected first-publish repos without a control-plane write', async () => {
    const repoA = {
      workspaceId: WORKSPACE_ID,
      repoKey: 'repo-a',
      repoName: 'api',
      repoType: 'service',
      httpPrefix: '/api',
      lastParsedVersion: 'a'.repeat(16),
      lastSummaryVersion: `sum_${'a'.repeat(16)}`,
      lastEmbedVersion: `emb_${'a'.repeat(16)}`,
    };
    const repoB = {
      workspaceId: WORKSPACE_ID,
      repoKey: 'repo-b',
      repoName: 'billing',
      repoType: 'service',
      httpPrefix: '/billing',
      lastParsedVersion: 'b'.repeat(16),
      lastSummaryVersion: `sum_${'b'.repeat(16)}`,
      lastEmbedVersion: `emb_${'b'.repeat(16)}`,
    };
    const artifacts = [
      artifact('repo-a', 'api', 'parsed', 'a'),
      artifact('repo-a', 'api', 'summary', 'a'),
      artifact('repo-a', 'api', 'embeddings', 'a'),
      artifact('repo-b', 'billing', 'parsed', 'b'),
      artifact('repo-b', 'billing', 'summary', 'b'),
      artifact('repo-b', 'billing', 'embeddings', 'b'),
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: null,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { findMany: vi.fn().mockResolvedValue([repoB, repoA]) },
      workspaceRepoArtifact: {
        findUnique: vi.fn().mockImplementation(async ({ where }) => {
          const key = where.workspaceId_repoKey_kind_version;
          const found = artifacts.find(
            (entry) => entry.repoKey === key.repoKey && entry.kind === key.kind && entry.version === key.version,
          );
          return found ? persistedArtifact(found) : null;
        }),
      },
      workspaceGraphVersion: { findUnique: vi.fn() },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = transactionPrisma(tx);
    const service = new GraphSnapshotControlPlaneService(prisma);

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: 'api', parsedVersion: 'a'.repeat(16), commitSha: 'deadbeef' }],
    });

    expect(candidate.manifest.repositories.map(({ repoKey }) => repoKey)).toEqual(['repo-a', 'repo-b']);
    expect(candidate.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-a')?.commitSha).toBe('deadbeef');
    expect(candidate.versionId).toBe(createGraphSnapshotIdentity(candidate.manifest).versionId);
  });

  it('drops disconnected repos and excludes a connected repo that has never selected an artifact', async () => {
    const parent = createGraphSnapshotIdentity(manifest());
    const replacement = artifact('repo-a', 'api', 'parsed', 'd');
    const uploadedOnly = artifact('repo-c', 'new-repo', 'parsed', 'c');
    const artifactRead = artifactRegistryReader([replacement, uploadedOnly]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...appliedRepoRows(parent.manifest)[0],
            lastParsedVersion: replacement.version,
          },
          {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-c',
            repoName: 'new-repo',
            repoType: 'service',
            httpPrefix: null,
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
            lastParseHash: null,
            lastPushedAt: null,
          },
        ]),
      },
      workspaceRepoArtifact: { findUnique: artifactRead },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));
    const warn = vi
      .spyOn(
        (
          service as unknown as {
            logger: { warn(message: string): void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: 'api', parsedVersion: replacement.version }],
    });

    expect(candidate.manifest.repositories.map(({ repoKey }) => repoKey)).toEqual(['repo-a']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipping never-pushed repository new-repo/i));
    expect(
      artifactRead.mock.calls.some(
        ([input]) => input.where.workspaceId_repoKey_kind_version.repoKey === uploadedOnly.repoKey,
      ),
    ).toBe(false);
  });

  it.each([
    ['lastPushedAt', { lastParseHash: null, lastPushedAt: new Date('2026-08-10T00:00:00Z') }],
    ['lastParseHash', { lastParseHash: 'legacy-parse-hash', lastPushedAt: null }],
  ])('rejects a legacy applied sibling identified by %s when selections were never backfilled', async (_label, marker) => {
    const target = repository('repo-a', 'api', 'a');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: target.repoName,
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: null,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'repo-row-a',
            workspaceId: WORKSPACE_ID,
            repoKey: target.repoKey,
            repoName: target.repoName,
            repoType: target.repoType,
            httpPrefix: target.httpPrefix,
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
            lastParseHash: null,
            lastPushedAt: null,
          },
          {
            id: 'repo-row-legacy',
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-legacy',
            repoName: 'legacy',
            repoType: 'service',
            httpPrefix: '/legacy',
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
            ...marker,
          },
        ]),
      },
      workspaceGraphVersion: { findUnique: vi.fn() },
      workspaceRepoArtifact: { findUnique: artifactRegistryReader([target.parsed]) },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        targets: [{ repoName: target.repoName, parsedVersion: target.parsed.version }],
      }),
    ).rejects.toMatchObject({
      code: 'artifact_identity_conflict',
      message: expect.stringMatching(/legacy.*re-push|backfill/i),
    });
  });

  it('excludes a reconnected parent repo whose replacement row has never selected an artifact', async () => {
    const parent = createGraphSnapshotIdentity(manifest());
    const target = parent.manifest.repositories[1]!;
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: target.repoName,
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...appliedRepoRows(parent.manifest)[0],
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
            lastParseHash: null,
            lastPushedAt: null,
          },
          appliedRepoRows(parent.manifest)[1],
        ]),
      },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      workspaceRepoArtifact: {
        findUnique: vi.fn(() => {
          throw new Error('parent descriptors must not be reread');
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: target.repoName, parsedVersion: target.parsed.version }],
    });

    expect(candidate.manifest.repositories).toEqual([target]);
  });

  it('adds a newly connected pushed target while preserving parent siblings', async () => {
    const parentManifest = {
      ...manifest(),
      repositories: [repository('repo-a', 'api', 'a')],
    } satisfies GraphSnapshotManifestV1;
    const parent = createGraphSnapshotIdentity(parentManifest);
    const newTarget = repository('repo-c', 'catalogue', 'c');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'catalogue',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          appliedRepoRows(parent.manifest)[0],
          {
            workspaceId: WORKSPACE_ID,
            repoKey: newTarget.repoKey,
            repoName: newTarget.repoName,
            repoType: newTarget.repoType,
            httpPrefix: newTarget.httpPrefix,
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
          },
        ]),
      },
      workspaceRepoArtifact: {
        findUnique: artifactRegistryReader(
          [newTarget.parsed, newTarget.summary, newTarget.embeddings].filter(
            (value): value is WorkspaceRepoArtifactDescriptor => value !== null,
          ),
        ),
      },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [
        {
          repoName: newTarget.repoName,
          parsedVersion: newTarget.parsed.version,
          summaryVersion: newTarget.summary?.version,
          embeddingsVersion: newTarget.embeddings?.version,
          commitSha: newTarget.commitSha,
        },
      ],
    });

    expect(candidate.manifest.repositories).toEqual([parent.manifest.repositories[0], newTarget]);
    expect(candidate.manifest.parentVersionId).toBe(parent.versionId);
  });

  it('treats a reconnected target with the same repo key and a new name as a fresh repository', async () => {
    const parent = createGraphSnapshotIdentity(manifest());
    const renamedParsed = artifact('repo-a', 'renamed-api', 'parsed', 'd');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'renamed-api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'repo-row-renamed',
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'renamed-api',
            repoType: 'service',
            httpPrefix: '/renamed-api',
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
          },
          { id: 'repo-row-b', ...appliedRepoRows(parent.manifest)[1] },
        ]),
      },
      workspaceRepoArtifact: { findUnique: artifactRegistryReader([renamedParsed]) },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: 'renamed-api', parsedVersion: renamedParsed.version }],
    });

    expect(candidate.manifest.repositories).toEqual([
      {
        repoKey: 'repo-a',
        repoName: 'renamed-api',
        repoType: 'service',
        httpPrefix: '/renamed-api',
        commitSha: null,
        parsed: renamedParsed,
        summary: null,
        embeddings: null,
      },
      parent.manifest.repositories[1],
    ]);
  });

  it('treats a same-name reconnected target as fresh instead of inheriting old descriptors', async () => {
    const parent = createGraphSnapshotIdentity(manifest());
    const freshParsed = artifact('repo-a', 'api', 'parsed', 'd');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'repo-row-reconnected',
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            repoType: 'service',
            httpPrefix: '/api-v2',
            lastParsedVersion: null,
            lastSummaryVersion: null,
            lastEmbedVersion: null,
            lastParseHash: null,
            lastPushedAt: null,
          },
          appliedRepoRows(parent.manifest)[1],
        ]),
      },
      workspaceRepoArtifact: { findUnique: artifactRegistryReader([freshParsed]) },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: 'api', parsedVersion: freshParsed.version }],
    });

    expect(candidate.manifest.repositories[0]).toEqual({
      repoKey: 'repo-a',
      repoName: 'api',
      repoType: 'service',
      httpPrefix: '/api-v2',
      commitSha: null,
      parsed: freshParsed,
      summary: null,
      embeddings: null,
    });
  });

  it('fails typed when a connected sibling has selections without a matching descriptor', async () => {
    const parentManifest = {
      ...manifest(),
      repositories: [repository('repo-a', 'api', 'a')],
    } satisfies GraphSnapshotManifestV1;
    const parent = createGraphSnapshotIdentity(parentManifest);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parent.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          appliedRepoRows(parent.manifest)[0],
          {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-c',
            repoName: 'new-repo',
            repoType: 'service',
            httpPrefix: null,
            lastParsedVersion: 'c'.repeat(16),
            lastSummaryVersion: null,
            lastEmbedVersion: null,
          },
        ]),
      },
      workspaceRepoArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parent.versionId,
          manifest: parent.manifest,
        }),
      },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const error = await service
      .assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        targets: [{ repoName: 'api', parsedVersion: parent.manifest.repositories[0]!.parsed.version }],
      })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ code: 'artifact_identity_conflict' });
    expect(error).not.toHaveProperty('missingGraphArtifactRegistry');
  });

  it('fences a reclaimed attempt before reading live candidate context', async () => {
    const liveRead = vi.fn(() => {
      throw new Error('a stale attempt must stop before reading live state');
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: 'new-owner-lease',
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: { findUnique: liveRead },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { findMany: liveRead },
      workspaceRepoArtifact: { findUnique: liveRead },
      workspaceGraphVersion: { findUnique: liveRead },
      mapperArtifact: { findUnique: liveRead },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: 'stale-owner-lease',
        targets: [{ repoName: 'api', parsedVersion: 'f'.repeat(16) }],
      }),
    ).rejects.toMatchObject({ code: 'graph_job_in_progress' });
    expect(liveRead).not.toHaveBeenCalled();
  });

  it('preserves every parent sibling byte while replacing only the target', async () => {
    const parentIdentity = createGraphSnapshotIdentity(manifest());
    const replacement = artifact('repo-a', 'api', 'parsed', 'd');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parentIdentity.versionId,
        }),
      },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parentIdentity.versionId,
          manifest: parentIdentity.manifest,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue([
          {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            repoType: 'service',
            httpPrefix: '/api-v2',
            lastParsedVersion: replacement.version,
            lastSummaryVersion: `sum_${'a'.repeat(16)}`,
            lastEmbedVersion: `emb_${'a'.repeat(16)}`,
          },
          {
            ...appliedRepoRows(parentIdentity.manifest)[1],
            repoType: 'changed-live-value',
            httpPrefix: '/changed-live-value',
          },
        ]),
      },
      workspaceRepoArtifact: { findUnique: vi.fn().mockResolvedValue(persistedArtifact(replacement)) },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    const candidate = await service.assembleCandidate({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      executionToken: TOKEN,
      leaseToken: LEASE_TOKEN,
      targets: [{ repoName: 'api', parsedVersion: replacement.version, commitSha: 'new-commit' }],
    });

    const parentSibling = parentIdentity.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-b');
    const candidateSibling = candidate.manifest.repositories.find(({ repoKey }) => repoKey === 'repo-b');
    expect(canonicalizeJson(candidateSibling)).toBe(canonicalizeJson(parentSibling));
    expect(candidate.manifest.parentVersionId).toBe(parentIdentity.versionId);
  });

  it('reuses the active version when an explicit resolve has identical mapper and repo inputs', async () => {
    const parentIdentity = createGraphSnapshotIdentity(manifest());
    const artifactRead = vi.fn(() => {
      throw new Error('an unchanged resolve must not reread component descriptors');
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'resolve',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: null,
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parentIdentity.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: {
        findMany: vi.fn().mockResolvedValue(appliedRepoRows(parentIdentity.manifest)),
      },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parentIdentity.versionId,
          manifest: parentIdentity.manifest,
        }),
      },
      workspaceRepoArtifact: { findUnique: artifactRead },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
      }),
    ).resolves.toEqual({
      manifest: parentIdentity.manifest,
      versionId: parentIdentity.versionId,
      matchesActiveVersion: true,
      activeArtifact: null,
      targetRepoIdentities: [],
    });
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('reuses an identical active version when database collation returns a different repository order', async () => {
    const parentManifest = {
      ...manifest(),
      repositories: [repository('A', 'upper', 'a'), repository('_', 'underscore', 'b')],
    } satisfies GraphSnapshotManifestV1;
    const parentIdentity = createGraphSnapshotIdentity(parentManifest);
    const artifactRead = vi.fn(() => {
      throw new Error('an unchanged resolve must not reread component descriptors');
    });
    const rows = appliedRepoRows(parentIdentity.manifest);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'resolve',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: null,
          payload: { executionToken: TOKEN },
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          graphBackend: 'file_snapshot',
          activeGraphVersionId: parentIdentity.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { findMany: vi.fn().mockResolvedValue([...rows].reverse()) },
      workspaceGraphVersion: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: parentIdentity.versionId,
          manifest: parentIdentity.manifest,
        }),
      },
      workspaceRepoArtifact: { findUnique: artifactRead },
      mapperArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.assembleCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
      }),
    ).resolves.toEqual({
      manifest: parentIdentity.manifest,
      versionId: parentIdentity.versionId,
      matchesActiveVersion: true,
      activeArtifact: null,
      targetRepoIdentities: [],
    });
    expect(artifactRead).not.toHaveBeenCalled();
  });
});

describe('GraphSnapshotControlPlaneService publish', () => {
  it('refuses to publish metadata onto a reconnected repository row', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: {
        createMany,
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: identity.versionId,
          engine: identity.manifest.engine,
          r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99n,
          storageFormatVersion: identity.manifest.storageFormatVersion,
          manifest: identity.manifest,
          parentVersionId: identity.manifest.parentVersionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
        targetRepos: [
          {
            id: 'repo-row-old',
            repoKey: 'repo-a',
            repoName: 'api',
            lastPushedByUserId: 'user-1',
            nodeCount: 1,
            edgeCount: 2,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'repo-row-old',
        workspaceId: WORKSPACE_ID,
        repoKey: 'repo-a',
        repoName: 'api',
      },
      data: expect.any(Object),
    });
    expect(tx.$executeRaw.mock.calls.map(sqlText).join('\n')).not.toContain('UPDATE workspaces');
  });

  it('rejects an in-flight manifest/version mismatch before inserting or moving the pointer', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const createMany = vi.fn();
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: { createMany, findUnique: vi.fn() },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));
    const corruptedVersionId = 'f'.repeat(64);

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: corruptedVersionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${corruptedVersionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
      }),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
    expect(createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      'non-canonical key',
      { r2Key: `${WORKSPACE_ID}/graphs/${'e'.repeat(64)}.ladybug`, sha256: 'd'.repeat(64), sizeBytes: 99 },
      'graph_object_identity_conflict',
    ],
    [
      'non-canonical digest',
      {
        r2Key: `${WORKSPACE_ID}/graphs/${createGraphSnapshotIdentity(manifest()).versionId}.ladybug`,
        sha256: 'D'.repeat(64),
        sizeBytes: 99,
      },
      'artifact_identity_conflict',
    ],
    [
      'non-positive size',
      {
        r2Key: `${WORKSPACE_ID}/graphs/${createGraphSnapshotIdentity(manifest()).versionId}.ladybug`,
        sha256: 'd'.repeat(64),
        sizeBytes: 0,
      },
      'artifact_identity_conflict',
    ],
  ])('rejects %s before inserting a graph version', async (_label, artifactInput, expectedCode) => {
    const identity = createGraphSnapshotIdentity(manifest());
    const createMany = vi.fn();
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: { createMany },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: artifactInput,
        targetRepos: [publishTarget()],
      }),
    ).rejects.toMatchObject({ code: expectedCode });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects a conflicting immutable version row before moving the pointer', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const artifactInput = {
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: 'd'.repeat(64),
      sizeBytes: 99n,
    };
    const raw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: raw,
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'resolve',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: null,
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: identity.versionId,
          engine: identity.manifest.engine,
          r2Key: artifactInput.r2Key,
          sha256: 'e'.repeat(64),
          sizeBytes: artifactInput.sizeBytes,
          storageFormatVersion: identity.manifest.storageFormatVersion,
          manifest: identity.manifest,
          parentVersionId: identity.manifest.parentVersionId,
        }),
      },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: artifactInput,
      }),
    ).rejects.toMatchObject({ code: 'graph_object_identity_conflict' });
    expect(raw.mock.calls.map(sqlText).join('\n')).not.toContain('UPDATE workspaces');
  });

  it('maps a direct control-plane transaction timeout to the typed retryable pointer error', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue({
        code: 'P2028',
        message: 'Transaction already closed: transaction timed out',
      }),
    } as unknown as PrismaService;
    const service = new GraphSnapshotControlPlaneService(prisma);

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: manifest(),
        versionId: createGraphSnapshotIdentity(manifest()).versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${createGraphSnapshotIdentity(manifest()).versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
      }),
    ).rejects.toMatchObject({
      code: 'graph_pointer_timeout',
      retryable: true,
      statusCode: 504,
    });
  });

  it('rejects a push whose locked job target does not match the manifest metadata target', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: { createMany, findUnique: vi.fn() },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
        targetRepos: [publishTarget({ id: 'repo-row-b', repoKey: 'repo-b', repoName: 'billing' })],
      }),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['backend flip', { graphBackend: 'turso', activeGraphVersionId: 'candidate' }, 'graph_backend_conflict'],
    ['different child', { graphBackend: 'file_snapshot', activeGraphVersionId: 'other' }, 'graph_parent_conflict'],
  ])('rolls back publish metadata on %s', async (_label, workspaceState, expectedCode) => {
    const identity = createGraphSnapshotIdentity(manifest());
    const artifactPin = {
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: 'd'.repeat(64),
      sizeBytes: 99n,
    };
    const raw = vi.fn().mockImplementation(async (parts: TemplateStringsArray) => {
      const sql = Array.from(parts).join('?');
      return sql.includes('UPDATE workspaces') ? 0 : 1;
    });
    const tx = {
      $executeRaw: raw,
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          versionId: identity.versionId,
          engine: 'ladybug',
          r2Key: artifactPin.r2Key,
          sha256: artifactPin.sha256,
          sizeBytes: artifactPin.sizeBytes,
          storageFormatVersion: 1,
          manifest: identity.manifest,
          parentVersionId: null,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      workspace: { findUnique: vi.fn().mockResolvedValue(workspaceState) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: artifactPin,
        targetRepos: [publishTarget()],
      }),
    ).rejects.toMatchObject({ code: expectedCode });
    expect(tx.workspaceGraphVersion.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(raw.mock.calls.map(sqlText).join('\n')).toContain('pg_advisory_xact_lock');
    expect(raw.mock.calls.map(sqlText).join('\n')).toContain('IS NOT DISTINCT FROM');
  });

  it('allows exactly one of two children pinned to the same parent to win the pointer CAS', async () => {
    const parentVersionId = 'c'.repeat(64);
    const firstManifest = manifest(parentVersionId);
    firstManifest.repositories[0]!.commitSha = 'first-child';
    const secondManifest = manifest(parentVersionId);
    secondManifest.repositories[0]!.commitSha = 'second-child';
    const first = createGraphSnapshotIdentity(firstManifest);
    const second = createGraphSnapshotIdentity(secondManifest);
    let activeVersionId = parentVersionId;
    const versions = new Map<string, Record<string, unknown>>();
    const jobs = new Map([
      [
        'job-first',
        {
          id: 'job-first',
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        },
      ],
      [
        'job-second',
        {
          id: 'job-second',
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        },
      ],
    ]);
    const transaction = {
      $executeRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        if (!Array.from(parts).join('?').includes('UPDATE workspaces')) return 1;
        const [newVersionId, workspaceId, expectedParentVersionId] = values;
        if (workspaceId !== WORKSPACE_ID || activeVersionId !== expectedParentVersionId) return 0;
        activeVersionId = String(newVersionId);
        return 1;
      }),
      pushJob: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null),
      },
      workspaceGraphVersion: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          const row = data[0]!;
          const versionId = String(row.versionId);
          if (versions.has(versionId)) return { count: 0 };
          versions.set(versionId, row);
          return { count: 1 };
        }),
        findUnique: vi.fn(
          async ({ where }: { where: { workspaceId_versionId: { versionId: string } } }) =>
            versions.get(where.workspaceId_versionId.versionId) ?? null,
        ),
      },
      workspace: {
        findUnique: vi.fn(async () => ({ graphBackend: 'file_snapshot', activeGraphVersionId: activeVersionId })),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(transaction));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: 'job-first',
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: first.manifest,
        versionId: first.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${first.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
        targetRepos: [publishTarget()],
      }),
    ).resolves.toEqual({ versionId: first.versionId, parentVersionId, idempotent: false });
    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: 'job-second',
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: second.manifest,
        versionId: second.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${second.versionId}.ladybug`,
          sha256: 'e'.repeat(64),
          sizeBytes: 100,
        },
        targetRepos: [publishTarget()],
      }),
    ).rejects.toMatchObject({
      code: 'graph_parent_conflict',
    });
    expect(activeVersionId).toBe(first.versionId);
  });

  it('accepts a replay only when file_snapshot still points at the same candidate', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const artifactPin = {
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: 'd'.repeat(64),
      sizeBytes: 99n,
    };
    const tx = {
      $executeRaw: vi
        .fn()
        .mockImplementation(async (parts: TemplateStringsArray) =>
          Array.from(parts).join('?').includes('UPDATE workspaces') ? 0 : 1,
        ),
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: identity.versionId,
          engine: 'ladybug',
          r2Key: artifactPin.r2Key,
          sha256: artifactPin.sha256,
          sizeBytes: artifactPin.sizeBytes,
          storageFormatVersion: 1,
          manifest: identity.manifest,
          parentVersionId: null,
        }),
      },
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          graphBackend: 'file_snapshot',
          activeGraphVersionId: identity.versionId,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: artifactPin,
        targetRepos: [publishTarget()],
      }),
    ).resolves.toEqual({ versionId: identity.versionId, parentVersionId: null, idempotent: true });
  });

  it('publishes with one short CAS transaction and updates only the exact target repo metadata', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const artifactPin = {
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: 'd'.repeat(64),
      sizeBytes: 99n,
    };
    const raw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: raw,
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          versionId: identity.versionId,
          engine: 'ladybug',
          r2Key: artifactPin.r2Key,
          sha256: artifactPin.sha256,
          sizeBytes: artifactPin.sizeBytes,
          storageFormatVersion: 1,
          manifest: identity.manifest,
          parentVersionId: null,
        }),
      },
      intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceRepo: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      workspace: { findUnique: vi.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new GraphSnapshotControlPlaneService(prisma);

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: artifactPin,
        targetRepos: [publishTarget({ nodeCount: 12, edgeCount: 34 })],
      }),
    ).resolves.toEqual({ versionId: identity.versionId, parentVersionId: null, idempotent: false });

    expect(tx.workspaceRepo.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'repo-row-a',
        workspaceId: WORKSPACE_ID,
        repoKey: 'repo-a',
        repoName: 'api',
      },
      data: expect.objectContaining({
        lastParsedVersion: 'a'.repeat(16),
        lastSummaryVersion: `sum_${'a'.repeat(16)}`,
        lastEmbedVersion: `emb_${'a'.repeat(16)}`,
        lastPushedByUserId: 'user-1',
        nodeCount: 12,
        edgeCount: 34,
      }),
    });
    expect(tx.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 5_000, timeout: 10_000 });
    const statements = raw.mock.calls.map(sqlText).join('\n');
    expect(statements).toContain('statement_timeout');
    expect(statements).toContain('pg_advisory_xact_lock');
    expect(statements).toContain('IS NOT DISTINCT FROM');
    expect(statements).toContain('retain_graph_artifacts = true');
  });

  it('refuses a terminal-job replay so rollback cannot be undone after acknowledgement', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const raw = vi.fn().mockResolvedValue(1);
    const createMany = vi.fn();
    const tx = {
      $executeRaw: raw,
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'succeeded',
          leaseToken: LEASE_TOKEN,
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: { createMany },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: LEASE_TOKEN,
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
        targetRepos: [publishTarget()],
      }),
    ).rejects.toMatchObject({ code: 'graph_parent_conflict' });
    expect(createMany).not.toHaveBeenCalled();
    expect(raw.mock.calls.map(sqlText).join('\n')).not.toContain('UPDATE workspaces');
  });

  it('fences a reclaimed attempt before it can create a version or move the pointer', async () => {
    const identity = createGraphSnapshotIdentity(manifest());
    const createMany = vi.fn();
    const raw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: raw,
      pushJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: JOB_ID,
          workspaceId: WORKSPACE_ID,
          type: 'push',
          status: 'running',
          leaseToken: 'new-owner-lease',
          repoName: 'api',
          payload: { executionToken: TOKEN },
        }),
      },
      workspaceGraphVersion: { createMany },
    };
    const service = new GraphSnapshotControlPlaneService(transactionPrisma(tx));

    await expect(
      service.publishCandidate({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        executionToken: TOKEN,
        leaseToken: 'stale-owner-lease',
        manifest: identity.manifest,
        versionId: identity.versionId,
        artifact: {
          r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 99,
        },
        targetRepos: [publishTarget()],
      }),
    ).rejects.toMatchObject({ code: 'graph_job_in_progress' });
    expect(createMany).not.toHaveBeenCalled();
    expect(raw.mock.calls.map(sqlText).join('\n')).not.toContain('UPDATE workspaces');
  });
});
