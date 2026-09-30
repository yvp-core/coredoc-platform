import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeType } from '@coredoc/core';
import type { ParsedRepo } from '@coredoc/core/types';
import { GRAPH_FILE_FORMAT_COMPATIBILITY, type IGraphReadRepository } from '@coredoc/db';
import { buildGraphFile } from '@coredoc/db/file-builder';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneService } from './control-plane.service.js';
import type { R2StorageService } from './r2-storage.service.js';
import { WorkspaceFileCacheService, type WorkspaceGraphFileDescriptor } from './workspace-file-cache.service.js';
import type { WorkspaceDbPoolService } from './workspace-db-pool.service.js';
import { WorkspaceMcpContextService } from '../mcp/workspace-mcp-context.service.js';

const roots: string[] = [];
const WORKSPACE_ID = 'workspace-1';
const REPO_ID = '0123456789ab';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsedFixture(symbolName: string): ParsedRepo {
  const fileId = `${REPO_ID}:file:src/snapshot.ts`;
  const functionId = `${REPO_ID}:function:src/snapshot.ts:${symbolName}`;
  const location = { filePath: 'src/snapshot.ts', startLine: 1, endLine: 3 };
  return {
    id: REPO_ID,
    name: 'snapshot-repo',
    path: '/fixture/snapshot-repo',
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'phase2-integration-v1',
    parserId: 'phase2-integration',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: location.filePath,
        extension: '.ts',
        language: 'typescript',
        contentHash: `content-${symbolName}`,
        loc: 3,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@v1`,
        name: symbolName,
        kind: 'function',
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location,
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
  };
}

async function buildArtifact(root: string, versionId: string, symbolName: string) {
  const artifactPath = join(root, `${versionId}.graph`);
  async function* components() {
    yield { parsedRepo: parsedFixture(symbolName) };
  }
  await buildGraphFile({
    outputPath: artifactPath,
    workDir: join(root, `${versionId}-work`),
    components: components(),
  });
  const bytes = readFileSync(artifactPath);
  const descriptor: WorkspaceGraphFileDescriptor = {
    workspaceId: WORKSPACE_ID,
    versionId,
    engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
    r2Key: `${WORKSPACE_ID}/${versionId}.graph`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: BigInt(bytes.byteLength),
    storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
  };
  return { bytes, descriptor };
}

function streamingStorage(objects: Map<string, Buffer>) {
  const downloadStream = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return (async function* () {
      const split = Math.max(1, Math.floor(bytes.byteLength / 3));
      for (let offset = 0; offset < bytes.byteLength; offset += split) {
        yield bytes.subarray(offset, Math.min(offset + split, bytes.byteLength));
      }
    })();
  });
  const storage = {
    headObject: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        contentLength: bytes.byteLength,
        contentType: 'application/vnd.coredoc.ladybug',
        etag: null,
        lastModified: null,
        metadata: {
          engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
          engineversion: GRAPH_FILE_FORMAT_COMPATIBILITY.engineVersion,
          schemaversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.graphSchemaVersion),
          builderversion: GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
          storageformatversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion),
        },
      };
    }),
    downloadStream,
    download: vi.fn(async () => {
      throw new Error('buffering download must not be used');
    }),
  } as unknown as R2StorageService;
  return { storage, downloadStream };
}

function cache(storage: R2StorageService, cacheDir: string) {
  return new WorkspaceFileCacheService(storage, {
    cacheDir,
    maxOpenHandles: 2,
    maxTotalBufferPoolBytes: 128 * 1024 * 1024,
    maxCacheBytes: 64 * 1024 * 1024,
    downloadTimeoutMs: 5_000,
    storageFormatVersion: GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion,
    budgets: {
      maxDbSizeBytes: 64 * 1024 * 1024,
      bufferPoolBytes: 64 * 1024 * 1024,
      queryTimeoutMs: 5_000,
    },
  });
}

async function symbolNames(repository: IGraphReadRepository, symbolName: string) {
  const rows = await repository.findCode({ pattern: symbolName, types: [NodeType.Function], limit: 5 }, [REPO_ID]);
  return rows.map((row) => row.name);
}

describe('workspace file read path integration', () => {
  let coherenceRoot = '';
  let coherenceV1: Awaited<ReturnType<typeof buildArtifact>>;
  let coherenceV2: Awaited<ReturnType<typeof buildArtifact>>;

  beforeAll(async () => {
    coherenceRoot = mkdtempSync(join(tmpdir(), 'coredoc-coherence-'));
    coherenceV1 = await buildArtifact(join(coherenceRoot, 'artifacts'), 'v1', 'SnapshotV1');
    coherenceV2 = await buildArtifact(join(coherenceRoot, 'artifacts'), 'v2', 'SnapshotV2');
  });

  afterAll(() => {
    if (coherenceRoot) rmSync(coherenceRoot, { recursive: true, force: true });
  });

  it('performs one cold stream and reuses the verified built artifact after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-read-path-'));
    roots.push(root);
    const built = await buildArtifact(join(root, 'artifacts'), 'v1', 'ColdWarmNeedle');
    const objects = new Map([[built.descriptor.r2Key, built.bytes]]);
    const { storage, downloadStream } = streamingStorage(objects);
    const cacheDir = join(root, 'cache');
    const firstCache = cache(storage, cacheDir);

    const firstLease = await firstCache.acquire(built.descriptor);
    expect(await symbolNames(firstLease.repository, 'ColdWarmNeedle')).toEqual(['ColdWarmNeedle']);
    await firstCache.release(firstLease);
    const warmLease = await firstCache.acquire(built.descriptor);
    expect(warmLease).not.toBe(firstLease);
    expect(warmLease.repository).toBe(firstLease.repository);
    expect(await symbolNames(warmLease.repository, 'ColdWarmNeedle')).toEqual(['ColdWarmNeedle']);
    await firstCache.release(warmLease);
    expect(downloadStream).toHaveBeenCalledTimes(1);
    await firstCache.onModuleDestroy();
    expect(downloadStream).toHaveBeenCalledTimes(1);

    downloadStream.mockClear();
    const secondCache = cache(storage, cacheDir);
    const secondLease = await secondCache.acquire(built.descriptor);
    expect(await symbolNames(secondLease.repository, 'ColdWarmNeedle')).toEqual(['ColdWarmNeedle']);
    await secondCache.release(secondLease);
    await secondCache.onModuleDestroy();
    expect(downloadStream).not.toHaveBeenCalled();
  });

  it('pins an in-flight request across a two-replica pointer flip and rollback', async () => {
    const root = coherenceRoot;
    const v1 = coherenceV1;
    const v2 = coherenceV2;
    const { storage } = streamingStorage(
      new Map([
        [v1.descriptor.r2Key, v1.bytes],
        [v2.descriptor.r2Key, v2.bytes],
      ]),
    );
    const replicaACache = cache(storage, join(root, 'replica-a'));
    const replicaBCache = cache(storage, join(root, 'replica-b'));
    let activeVersionId = 'v1';
    const descriptors = new Map([
      ['v1', v1.descriptor],
      ['v2', v2.descriptor],
    ]);
    const controlPlane = {
      getWorkspaceById: vi.fn(async () => ({
        id: WORKSPACE_ID,
        slug: 'snapshot-workspace',
        graphBackend: 'file_snapshot',
        activeGraphVersionId: activeVersionId,
      })),
      getWorkspaceGraphVersion: vi.fn(async (_workspaceId: string, versionId: string) => descriptors.get(versionId)),
      listRepos: vi.fn(async () => [{ repoName: 'snapshot-repo', repoKey: REPO_ID }]),
    } as unknown as ControlPlaneService;
    const pool = { getRepository: vi.fn() } as unknown as WorkspaceDbPoolService;
    const replicaA = new WorkspaceMcpContextService(pool, controlPlane, replicaACache);
    const replicaB = new WorkspaceMcpContextService(pool, controlPlane, replicaBCache);

    for (const replica of [replicaA, replicaB]) {
      await replica.withContextByWorkspaceId(WORKSPACE_ID, async ({ repository, versionId }) => {
        expect(versionId).toBe('v1');
        expect(await symbolNames(repository, 'SnapshotV1')).toEqual(['SnapshotV1']);
      });
    }

    let enterA!: () => void;
    let continueA!: () => void;
    const enteredA = new Promise<void>((resolve) => {
      enterA = resolve;
    });
    const gateA = new Promise<void>((resolve) => {
      continueA = resolve;
    });

    const inFlightA = replicaA.withContext(
      { workspaceId: WORKSPACE_ID } as unknown as Request,
      async ({ repository, versionId }) => {
        enterA();
        await gateA;
        return { versionId, names: await symbolNames(repository, 'SnapshotV1') };
      },
    );
    await enteredA;
    activeVersionId = 'v2';
    const [freshA, freshB] = await Promise.all(
      [replicaA, replicaB].map((replica) =>
        replica.withContextByWorkspaceId(WORKSPACE_ID, async ({ repository, versionId }) => ({
          versionId,
          names: await symbolNames(repository, 'SnapshotV2'),
        })),
      ),
    );
    continueA();
    const pinnedA = await inFlightA;

    expect(pinnedA).toEqual({ versionId: 'v1', names: ['SnapshotV1'] });
    expect(freshA).toEqual({ versionId: 'v2', names: ['SnapshotV2'] });
    expect(freshB).toEqual({ versionId: 'v2', names: ['SnapshotV2'] });
    for (const replicaDir of ['replica-a', 'replica-b']) {
      const workspaceDir = join(root, replicaDir, WORKSPACE_ID);
      expect(existsSync(join(workspaceDir, 'v1.graph'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'v2.graph'))).toBe(true);
    }

    activeVersionId = 'v1';
    const rolledBack = await Promise.all(
      [replicaA, replicaB].map((replica) =>
        replica.withContextByWorkspaceId(WORKSPACE_ID, async ({ repository, versionId }) => ({
          versionId,
          names: await symbolNames(repository, 'SnapshotV1'),
        })),
      ),
    );
    expect(rolledBack).toEqual([
      { versionId: 'v1', names: ['SnapshotV1'] },
      { versionId: 'v1', names: ['SnapshotV1'] },
    ]);
    expect(controlPlane.getWorkspaceById).toHaveBeenCalledTimes(7);
    expect(pool.getRepository).not.toHaveBeenCalled();

    await Promise.all([replicaACache.onModuleDestroy(), replicaBCache.onModuleDestroy()]);
  });
});
