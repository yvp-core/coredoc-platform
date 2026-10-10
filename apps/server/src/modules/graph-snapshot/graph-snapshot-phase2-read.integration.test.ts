import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeType } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { R2StorageService } from '../../database/r2-storage.service.js';
import {
  WorkspaceFileCacheService,
  type WorkspaceGraphFileDescriptor,
} from '../../database/workspace-file-cache.service.js';
import { GraphSnapshotBuildService } from './graph-snapshot-artifact.service.js';
import { GraphSnapshotControlPlaneService } from './graph-snapshot-control-plane.service.js';
import { createGraphSnapshotIdentity } from './graph-snapshot-manifest.js';
import type { GraphSnapshotManifestV1 } from '../../libs/pipeline/graph-snapshot.types.js';

const roots: string[] = [];
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = 'repo-a';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsedFixture(symbolName: string): ParsedRepo {
  const fileId = `${REPO_ID}:file:src/snapshot.ts`;
  const functionId = `${REPO_ID}:function:src/snapshot.ts:${symbolName}`;
  return {
    id: REPO_ID,
    name: 'snapshot-repo',
    path: 'snapshot-repo',
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'phase3-phase2-roundtrip-v1',
    parserId: 'phase3-phase2-roundtrip',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@${symbolName}`,
        path: 'src/snapshot.ts',
        extension: '.ts',
        language: 'typescript',
        contentHash: `content-${symbolName}`,
        loc: 3,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@${symbolName}`,
        name: symbolName,
        kind: 'function',
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location: { filePath: 'src/snapshot.ts', startLine: 1, endLine: 3 },
        sourceCode: `export function ${symbolName}() { return true; }`,
      },
    ],
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
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  } as ParsedRepo;
}

async function publishSnapshot(
  storage: R2StorageService,
  builder: GraphSnapshotBuildService,
  symbolName: string,
  parentVersionId: string | null,
): Promise<WorkspaceGraphFileDescriptor> {
  const parsedBytes = Buffer.from(JSON.stringify(parsedFixture(symbolName)));
  const parsedSha256 = createHash('sha256').update(parsedBytes).digest('hex');
  const parsedVersion = parsedSha256.slice(0, 16);
  const parsedKey = `${WORKSPACE_ID}/snapshot-repo/results/parsed/${parsedVersion}.json`;
  await storage.upload(parsedKey, parsedBytes, 'application/json');

  const manifest: GraphSnapshotManifestV1 = {
    manifestVersion: 1,
    workspaceId: WORKSPACE_ID,
    parentVersionId,
    ...GRAPH_FILE_FORMAT_COMPATIBILITY,
    sourcePolicy: 'strip',
    repositories: [
      {
        repoKey: REPO_ID,
        repoName: 'snapshot-repo',
        repoType: 'backend',
        httpPrefix: null,
        commitSha: null,
        parsed: {
          workspaceId: WORKSPACE_ID,
          repoKey: REPO_ID,
          repoName: 'snapshot-repo',
          kind: 'parsed',
          version: parsedVersion,
          r2Key: parsedKey,
          sha256: parsedSha256,
          sizeBytes: String(parsedBytes.byteLength),
        },
        summary: null,
        embeddings: null,
      },
    ],
    mapper: null,
  };
  const identity = createGraphSnapshotIdentity(manifest);
  const artifact = await builder.materialize(identity.manifest, identity.versionId);
  let storedVersion:
    | (WorkspaceGraphFileDescriptor & {
        manifest: GraphSnapshotManifestV1;
        parentVersionId: string | null;
      })
    | null = null;
  const transaction = {
    intentHandoff: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    pushJob: {
      findFirst: vi.fn().mockResolvedValue({
        id: `resolve-${symbolName}`,
        workspaceId: WORKSPACE_ID,
        type: 'resolve',
        status: 'running',
        leaseToken: 'lease-1',
        repoName: null,
        payload: { executionToken: 'execution-1' },
      }),
    },
    workspaceGraphVersion: {
      createMany: vi.fn().mockImplementation(async ({ data }) => {
        storedVersion = data[0];
        return { count: 1 };
      }),
      findUnique: vi.fn().mockImplementation(async () => storedVersion),
    },
    workspace: { findUnique: vi.fn() },
  };
  (transaction as { $queryRaw?: unknown }).$queryRaw = vi.fn().mockResolvedValue([{ now: new Date() }]);
  const prisma = {
    $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
  } as unknown as PrismaService;
  const controlPlane = new GraphSnapshotControlPlaneService(prisma);
  await controlPlane.publishCandidate({
    workspaceId: WORKSPACE_ID,
    jobId: `resolve-${symbolName}`,
    executionToken: 'execution-1',
    leaseToken: 'lease-1',
    manifest: identity.manifest,
    versionId: identity.versionId,
    artifact,
  });
  if (!storedVersion) throw new Error('Real publish path did not persist a graph version descriptor');
  return storedVersion;
}

function createCache(storage: R2StorageService, cacheDir: string): WorkspaceFileCacheService {
  return new WorkspaceFileCacheService(storage, {
    cacheDir,
    maxOpenHandles: 2,
    maxTotalBufferPoolBytes: 128 * 1024 * 1024,
    maxCacheBytes: 64 * 1024 * 1024,
    downloadTimeoutMs: 5_000,
    budgets: {
      maxDbSizeBytes: 64 * 1024 * 1024,
      bufferPoolBytes: 64 * 1024 * 1024,
      queryTimeoutMs: 5_000,
    },
  });
}

async function readSelectedSymbol(
  cache: WorkspaceFileCacheService,
  descriptor: WorkspaceGraphFileDescriptor,
  symbolName: string,
): Promise<string[]> {
  const lease = await cache.acquire(descriptor);
  try {
    const rows = await lease.repository.findCode({ pattern: symbolName, types: [NodeType.Function], limit: 5 }, [
      REPO_ID,
    ]);
    return rows.map((row) => row.name);
  } finally {
    await cache.release(lease);
  }
}

describe('Phase 3 graph snapshot to Phase 2 read path integration', () => {
  it('opens a freshly published artifact and reopens its immutable parent after selection rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coredoc-phase3-phase2-read-'));
    roots.push(root);
    const previousEndpoint = process.env.R2_ENDPOINT;
    delete process.env.R2_ENDPOINT;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    let cache: WorkspaceFileCacheService | null = null;
    try {
      const storage = new R2StorageService();
      const builder = new GraphSnapshotBuildService(storage, join(root, 'builds'));
      cache = createCache(storage, join(root, 'cache'));

      const parent = await publishSnapshot(storage, builder, 'SnapshotParent', null);
      let selected = parent;
      expect(await readSelectedSymbol(cache, selected, 'SnapshotParent')).toEqual(['SnapshotParent']);

      const child = await publishSnapshot(storage, builder, 'SnapshotChild', parent.versionId);
      selected = child;
      expect(await readSelectedSymbol(cache, selected, 'SnapshotChild')).toEqual(['SnapshotChild']);
      expect(await storage.headObject(selected.r2Key)).toMatchObject({
        contentLength: Number(selected.sizeBytes),
        metadata: {
          sha256: selected.sha256,
          storageformatversion: String(selected.storageFormatVersion),
          versionid: selected.versionId,
          workspaceid: selected.workspaceId,
        },
      });

      selected = parent;
      expect(await readSelectedSymbol(cache, selected, 'SnapshotParent')).toEqual(['SnapshotParent']);
      expect(await readSelectedSymbol(cache, selected, 'SnapshotChild')).toEqual([]);
      expect(await storage.list(`${WORKSPACE_ID}/graphs/`)).toEqual([parent.r2Key, child.r2Key].sort());
    } finally {
      await cache?.onModuleDestroy();
      cwd.mockRestore();
      if (previousEndpoint === undefined) delete process.env.R2_ENDPOINT;
      else process.env.R2_ENDPOINT = previousEndpoint;
    }
  }, 30_000);
});
