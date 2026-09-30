/**
 * Composed batch-publication test against a REAL PostgreSQL control plane.
 *
 * Gate: set GRAPH_SNAPSHOT_E2E_DATABASE_URL to a migrated, disposable database
 * (`prisma migrate deploy` must have run against it). Storage uses the local
 * filesystem fallback — no R2 credentials required.
 *
 * This exists because the S4 mapper regression slipped between individually
 * green mocked suites: the seams (queue ⇄ control plane ⇄ build ⇄ publish)
 * are exactly what mocks cannot cover. It proves, end to end on live rows:
 * fresh file-snapshot workspace + deferred mapper + N repo uploads → exactly
 * one build and one stored graph object whose manifest carries every repo and
 * the mapper; per-repo metadata rows updated; a retry is idempotent (no second
 * object); and a batch whose pin went stale behind an interleaved publish is
 * rejected instead of rolling the repository back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mapper } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import { PrismaService } from '../../database/prisma.service.js';
import { R2StorageService } from '../../database/r2-storage.service.js';
import { PushLeaseService } from '../lease/push-lease.service.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import type { PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import type { PushJob } from '../../generated/prisma/client.js';
import { GraphSnapshotBuildService } from './graph-snapshot-artifact.service.js';
import { GraphSnapshotControlPlaneService } from './graph-snapshot-control-plane.service.js';
import { GraphSnapshotExecutionService } from './graph-snapshot-execution.service.js';

const DATABASE_URL = process.env.GRAPH_SNAPSHOT_E2E_DATABASE_URL;

function minimalParsedRepo(id: string, name: string): ParsedRepo {
  return {
    id,
    name,
    path: '',
    parsedAt: '2026-08-13T00:00:00.000Z',
    parserVersion: '1',
    parserId: 'e2e',
    packages: [],
    files: [
      {
        id: `${id}:file:src/app.ts`,
        path: 'src/app.ts',
        language: 'typescript',
        loc: 3,
        exports: [],
      },
    ],
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: { totalFiles: 1, totalFunctions: 0, totalClasses: 0, totalEntrypoints: 0, parseTimeMs: 0 },
  } as unknown as ParsedRepo;
}

const EMPTY_TEST_MAPPER: Mapper = {
  $schemaVersion: 1,
  project: 'e2e',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
} as Mapper;

describe.skipIf(!DATABASE_URL)('graph snapshot batch publication (live PostgreSQL)', () => {
  let prisma: PrismaService;
  let storage: R2StorageService;
  let controlPlane: GraphSnapshotControlPlaneService;
  let execution: GraphSnapshotExecutionService;
  let workspaceId: string;
  let buildRoot: string;
  const hexVersion = () => createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16);
  const parsedVersions: Record<string, string> = {};

  let previousR2Endpoint: string | undefined;
  let previousBucket: string | undefined;
  let previousDatabaseUrl: string | undefined;
  let localStorageDir: string;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DATABASE_URL;
    buildRoot = mkdtempSync(join(tmpdir(), 'graph-batch-e2e-'));
    // Storage isolation: R2StorageService writes to <cwd>/.r2-local/<bucket>
    // only when R2_ENDPOINT is unset — force local mode (fail-fast against any
    // real bucket) and claim a unique throwaway bucket dir for this run.
    previousR2Endpoint = process.env.R2_ENDPOINT;
    previousBucket = process.env.R2_BUCKET;
    delete process.env.R2_ENDPOINT;
    process.env.R2_BUCKET = `graph-batch-e2e-${randomUUID().slice(0, 8)}`;
    localStorageDir = join(process.cwd(), '.r2-local', process.env.R2_BUCKET);
    prisma = new PrismaService();
    await prisma.$connect();
    storage = new R2StorageService();
    controlPlane = new GraphSnapshotControlPlaneService(prisma);
    execution = new GraphSnapshotExecutionService(
      controlPlane,
      new GraphSnapshotBuildService(storage, buildRoot),
      new PushLeaseService(prisma),
    );

    const workspace = await prisma.workspace.create({
      data: { name: 'graph-batch-e2e', slug: `graph-batch-e2e-${randomUUID().slice(0, 8)}` },
    });
    workspaceId = workspace.id;
    await prisma.$executeRaw`
      UPDATE workspaces SET graph_backend = 'file_snapshot', retain_graph_artifacts = true WHERE id = ${workspaceId}::uuid
    `;

    for (const repoName of ['repo-alpha', 'repo-beta']) {
      const parsedRepo = minimalParsedRepo(`e2e${repoName.slice(-5)}`, repoName);
      const body = Buffer.from(JSON.stringify(parsedRepo));
      const version = hexVersion();
      parsedVersions[repoName] = version;
      const r2Key = `${workspaceId}/${repoName}/results/parsed/${version}.json`;
      await storage.upload(r2Key, body, 'application/json');
      await prisma.workspaceRepo.create({
        data: { workspaceId, repoKey: parsedRepo.id, repoName, repoType: 'service' },
      });
      await controlPlane.registerArtifact({
        workspaceId,
        repoName,
        kind: 'parsed',
        version,
        r2Key,
        sha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: body.length,
      });
    }

    // Deferred mapper: the row + object exist, but no resolve ran for it.
    const mapperBody = Buffer.from(JSON.stringify(EMPTY_TEST_MAPPER));
    const mapperKey = `${workspaceId}/mapper/mapper.json`;
    await storage.upload(mapperKey, mapperBody, 'application/json');
    await prisma.mapperArtifact.create({
      data: {
        workspaceId,
        r2Key: mapperKey,
        sha256: createHash('sha256').update(mapperBody).digest('hex'),
        sizeBytes: mapperBody.length,
        uploadedBy: 'e2e',
      },
    });
  }, 120_000);

  afterAll(async () => {
    // Each step independently guarded: one failed cleanup must not leave the
    // rest (env restore, storage removal) undone.
    try {
      if (workspaceId) await prisma?.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      await prisma?.$disconnect().catch(() => undefined);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousR2Endpoint !== undefined) process.env.R2_ENDPOINT = previousR2Endpoint;
      if (previousBucket === undefined) delete process.env.R2_BUCKET;
      else process.env.R2_BUCKET = previousBucket;
      if (localStorageDir) rmSync(localStorageDir, { recursive: true, force: true });
      if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
    }
  });

  async function runResolveJob(
    targets: Array<Record<string, unknown>>,
    queuedAt?: Date,
  ): Promise<{ job: PushJob; result: unknown }> {
    const executionToken = randomUUID();
    const leaseToken = randomUUID();
    const job = await prisma.pushJob.create({
      data: {
        workspaceId,
        repoName: null,
        type: 'resolve',
        status: 'running',
        leaseToken,
        payload: { executionToken, targets } as never,
        queuedByUserId: 'e2e',
        ...(queuedAt ? { queuedAt } : {}),
      },
    });
    const context: PushExecutionContext = {
      jobId: job.id,
      executionToken,
      leaseOwnerToken: leaseToken,
      signal: new AbortController().signal,
      report: () => undefined,
    };
    const result = await execution.executeResolve(job, context);
    return { job, result };
  }

  it('publishes a deferred-mapper batch as exactly one graph object, is idempotent on retry, and rejects a stale pin', async () => {
    const targets = Object.entries(parsedVersions).map(([repoName, parsedVersion]) => ({ repoName, parsedVersion }));

    const first = (await runResolveJob(targets)).result as {
      versionId: string;
      idempotent: boolean;
      repositories: Array<{ repoName: string; nodeCount: number; edgeCount: number }>;
      resolution: unknown;
    };
    expect(first.idempotent).toBe(false);
    expect(first.repositories.map(({ repoName }) => repoName).sort()).toEqual(['repo-alpha', 'repo-beta']);
    expect(first.repositories.every(({ nodeCount }) => nodeCount > 0)).toBe(true);

    // Exactly one build → exactly one stored graph object.
    const graphObjects = await storage.list(`${workspaceId}/graphs/`);
    expect(graphObjects).toHaveLength(1);

    // The active manifest carries every repo and the deferred mapper.
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(workspace.activeGraphVersionId).toBe(first.versionId);
    const version = await prisma.workspaceGraphVersion.findUniqueOrThrow({
      where: { workspaceId_versionId: { workspaceId, versionId: first.versionId } },
    });
    const manifest = version.manifest as { repositories: Array<{ repoName: string }>; mapper: unknown };
    expect(manifest.repositories.map(({ repoName }) => repoName).sort()).toEqual(['repo-alpha', 'repo-beta']);
    expect(manifest.mapper).not.toBeNull();

    // Metadata/count rows updated for every batch repository.
    const repos = await prisma.workspaceRepo.findMany({ where: { workspaceId } });
    for (const repo of repos) {
      expect(repo.lastParsedVersion).toBe(parsedVersions[repo.repoName]);
      expect(repo.lastPushedAt).not.toBeNull();
      expect(repo.nodeCount ?? 0).toBeGreaterThan(0);
    }

    // Retry of the same batch: idempotent, and still exactly one object.
    const retry = (await runResolveJob(targets)).result as { versionId: string; idempotent: boolean };
    expect(retry.versionId).toBe(first.versionId);
    expect(retry.idempotent).toBe(true);
    expect(await storage.list(`${workspaceId}/graphs/`)).toHaveLength(1);

    // Concurrent-newer-sync protection, with a REAL interleaved publication:
    // B1 publishes a newer repo-alpha through the actual resolve path, then a
    // batch still pinning the old version must be rejected, not roll back.
    const newerVersion = hexVersion();
    const newerRepo = minimalParsedRepo('e2ealpha', 'repo-alpha');
    const newerBody = Buffer.from(JSON.stringify({ ...newerRepo, parsedAt: '2026-08-13T01:00:00.000Z' }));
    const newerKey = `${workspaceId}/repo-alpha/results/parsed/${newerVersion}.json`;
    await storage.upload(newerKey, newerBody, 'application/json');
    await controlPlane.registerArtifact({
      workspaceId,
      repoName: 'repo-alpha',
      kind: 'parsed',
      version: newerVersion,
      r2Key: newerKey,
      sha256: createHash('sha256').update(newerBody).digest('hex'),
      sizeBytes: newerBody.length,
    });
    // B1: real publication of the newer selection.
    const b1 = (await runResolveJob([{ repoName: 'repo-alpha', parsedVersion: newerVersion }])).result as {
      idempotent: boolean;
    };
    expect(b1.idempotent).toBe(false);

    // B2 with the old pin, enqueued BEFORE B1's publication (backdated
    // queuedAt models the real interleave: B2 entered the queue while B1 was
    // still building): rejected, never rolled back.
    await expect(
      runResolveJob(
        [{ repoName: 'repo-alpha', parsedVersion: parsedVersions['repo-alpha'] }],
        new Date(Date.now() - 60_000),
      ),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });
    const after = await prisma.workspaceRepo.findFirstOrThrow({ where: { workspaceId, repoName: 'repo-alpha' } });
    expect(after.lastParsedVersion).toBe(newerVersion);

    // A commit-only divergence is staleness too: same artifact versions but a
    // different commitSha than the active manifest records (docs-only commits
    // produce identical artifacts) — a backdated batch must not rewind the SHA.
    await expect(
      runResolveJob(
        [{ repoName: 'repo-alpha', parsedVersion: newerVersion, commitSha: 'deadbeefdeadbeef' }],
        new Date(Date.now() - 60_000),
      ),
    ).rejects.toMatchObject({ code: 'artifact_identity_conflict' });

    // Enqueue-time acceptance: while a targeted resolve is RUNNING, a newer
    // batch is refused synchronously (409) instead of 202-then-permanent-fail.
    const queue = new PushQueueService(prisma);
    const running = await prisma.pushJob.create({
      data: {
        workspaceId,
        repoName: null,
        type: 'resolve',
        status: 'running',
        leaseToken: randomUUID(),
        payload: {
          executionToken: randomUUID(),
          targets: [{ repoName: 'repo-alpha', parsedVersion: newerVersion }],
        } as never,
        queuedByUserId: 'e2e',
      },
    });
    await expect(
      queue.enqueueResolve({
        workspaceId,
        userId: 'e2e',
        targets: [{ repoName: 'repo-alpha', parsedVersion: hexVersion() }],
      }),
    ).rejects.toThrow(/currently running/);
    await prisma.pushJob.update({ where: { id: running.id }, data: { status: 'failed' } });
  }, 300_000);
});
