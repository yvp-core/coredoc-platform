import { createHash } from 'node:crypto';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EmbeddingsOutput, ParsedRepo } from '@coredoc/core/types';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import { buildGraphFile } from '@coredoc/db/file-builder';
import { openGraphFile } from '@coredoc/db/graph-file';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { R2StorageService } from '../../database/r2-storage.service.js';
import { GraphSnapshotBuildService } from './graph-snapshot-artifact.service.js';
import { createGraphSnapshotIdentity } from './graph-snapshot-manifest.js';
import type { GraphSnapshotManifestV1 } from '../../libs/pipeline/graph-snapshot.types.js';

const roots: string[] = [];
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_CANARY = 'REAL_BUILD_SOURCE_CANARY_2a8eb0c9dcb44ae98cafbb3f16ee359d';
const EMBEDDING_INPUT_CANARY = 'REAL_EMBEDDING_INPUT_CANARY_53b4f17d11994a4c91e90b3144933878';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsedFixture(): ParsedRepo {
  const repoId = 'repo-a';
  const fileId = `${repoId}:file:src/index.ts`;
  const functionId = `${repoId}:function:src/index.ts:handler`;
  return {
    id: repoId,
    name: 'api',
    path: '/private/build/source',
    type: 'backend',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: 'phase3-integration-v1',
    parserId: 'phase3-integration',
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@v1`,
        path: 'src/index.ts',
        extension: '.ts',
        language: 'typescript',
        contentHash: 'content-v1',
        loc: 3,
      },
    ],
    functions: [
      {
        id: functionId,
        versionedId: `${functionId}@v1`,
        name: 'handler',
        kind: 'function',
        fileId,
        isAsync: false,
        isGenerator: false,
        isExported: true,
        parameters: [],
        location: { filePath: 'src/index.ts', startLine: 1, endLine: 3 },
        sourceCode: `export function handler() { return '${SOURCE_CANARY}'; }`,
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

describe('GraphSnapshotBuildService real Ladybug integration', () => {
  it('publishes a long HTTP route without mistaking it for a filesystem source path', async () => {
    const root = join(tmpdir(), `coredoc-phase3-http-route-${process.pid}-${Date.now()}`);
    roots.push(root);
    const routePath = '/api/v1/customers/:customerId/orders/:orderId/fulfillment-preferences';
    const parsed = parsedFixture();
    const entrypointId = `repo-a:entrypoint:src/index.ts:GET:${routePath}`;
    parsed.entrypoints = [
      {
        id: entrypointId,
        versionedId: `${entrypointId}@v1`,
        type: 'http',
        handlerId: 'repo-a:function:src/index.ts:handler',
        location: { filePath: 'src/index.ts', startLine: 1, endLine: 3 },
        details: {
          type: 'http',
          method: 'GET',
          path: routePath,
          fullPath: routePath,
          pathParams: ['customerId', 'orderId'],
        },
      },
    ];
    parsed.stats.totalEntrypoints = 1;
    const embeddings: EmbeddingsOutput = {
      repoId: parsed.id,
      repoName: parsed.name,
      generatedAt: '2026-08-11T00:00:00.000Z',
      provider: 'ollama',
      model: 'test-embedding',
      dimensions: 2,
      inputStrategy: 'source',
      functions: [
        {
          functionId: 'repo-a:function:src/index.ts:handler',
          versionedId: 'repo-a:function:src/index.ts:handler@v1',
          name: 'handler',
          filePath: 'src/index.ts',
          inputChecksum: 'function-input-v1',
          inputText: EMBEDDING_INPUT_CANARY,
          embedding: [0.25, 0.75],
          generatedAt: '2026-08-11T00:00:00.000Z',
        },
      ],
      endpoints: [
        {
          endpointId: entrypointId,
          versionedId: `${entrypointId}@v1`,
          type: 'http',
          path: routePath,
          handlerId: 'repo-a:function:src/index.ts:handler',
          inputChecksum: 'endpoint-input-v1',
          inputText: `GET route ${EMBEDDING_INPUT_CANARY}`,
          embedding: [0.5, 0.5],
          generatedAt: '2026-08-11T00:00:00.000Z',
        },
      ],
      stats: {
        totalFunctions: 1,
        totalEndpoints: 1,
        functionsEmbedded: 1,
        endpointsEmbedded: 1,
        functionsSkipped: 0,
        endpointsSkipped: 0,
        failed: 0,
        processingTimeMs: 1,
      },
    };
    const parsedBytes = Buffer.from(JSON.stringify(parsed));
    const embeddingsBytes = Buffer.from(JSON.stringify(embeddings));
    const parsedSha = createHash('sha256').update(parsedBytes).digest('hex');
    const embeddingsSha = createHash('sha256').update(embeddingsBytes).digest('hex');
    const parsedKey = `${WORKSPACE_ID}/api/results/parsed/${parsedSha.slice(0, 16)}.json`;
    const embeddingsVersion = `emb_${embeddingsSha.slice(0, 16)}`;
    const embeddingsKey = `${WORKSPACE_ID}/api/results/embeddings/${embeddingsVersion}.json`;
    const manifest: GraphSnapshotManifestV1 = {
      manifestVersion: 1,
      workspaceId: WORKSPACE_ID,
      parentVersionId: null,
      ...GRAPH_FILE_FORMAT_COMPATIBILITY,
      sourcePolicy: 'strip',
      repositories: [
        {
          repoKey: 'repo-a',
          repoName: 'api',
          repoType: 'backend',
          httpPrefix: null,
          commitSha: null,
          parsed: {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            kind: 'parsed',
            version: parsedSha.slice(0, 16),
            r2Key: parsedKey,
            sha256: parsedSha,
            sizeBytes: String(parsedBytes.length),
          },
          summary: null,
          embeddings: {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            kind: 'embeddings',
            version: embeddingsVersion,
            r2Key: embeddingsKey,
            sha256: embeddingsSha,
            sizeBytes: String(embeddingsBytes.length),
          },
        },
      ],
      mapper: null,
    };
    const identity = createGraphSnapshotIdentity(manifest);
    const publishedPath = join(root, 'published.ladybug');
    let published: Buffer | null = null;
    const r2 = {
      headObject: vi.fn().mockResolvedValue(null),
      downloadStream: vi.fn(async (key: string) => {
        const body = key === parsedKey ? parsedBytes : key === embeddingsKey ? embeddingsBytes : null;
        if (!body) return null;
        return (async function* () {
          yield body;
        })();
      }),
      putFileIfAbsent: vi.fn(async (_key: string, path: string) => {
        published = await readFile(path);
        await copyFile(path, publishedPath);
        return 'created' as const;
      }),
    };
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, join(root, 'builds'));

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({ resolution: { resolved: 0, total: 0 } });
    expect(result.repositoryCounts['repo-a']).toMatchObject({ nodeCount: 4 });
    expect(published).not.toBeNull();
    for (const canary of [parsed.path, SOURCE_CANARY, EMBEDDING_INPUT_CANARY]) {
      expect(published!.includes(Buffer.from(canary))).toBe(false);
    }

    const graph = await openGraphFile({
      path: publishedPath,
      budgets: { maxDbSizeBytes: 1024 ** 3, bufferPoolBytes: 128 * 1024 ** 2, queryTimeoutMs: 5_000 },
    });
    try {
      await expect(graph.repository.containsNodeText([routePath], ['repo-a'])).resolves.toBe(true);
    } finally {
      await graph.close();
    }
  }, 30_000);

  it('builds, resolves, reopens, scans, and conditionally publishes a real Ladybug artifact', async () => {
    const root = join(tmpdir(), `coredoc-phase3-artifact-${process.pid}-${Date.now()}`);
    roots.push(root);
    const parsedBytes = Buffer.from(JSON.stringify(parsedFixture()));
    const parsedSha = createHash('sha256').update(parsedBytes).digest('hex');
    const parsedKey = `${WORKSPACE_ID}/api/results/parsed/${parsedSha.slice(0, 16)}.json`;
    const manifest: GraphSnapshotManifestV1 = {
      manifestVersion: 1,
      workspaceId: WORKSPACE_ID,
      parentVersionId: null,
      ...GRAPH_FILE_FORMAT_COMPATIBILITY,
      sourcePolicy: 'strip',
      repositories: [
        {
          repoKey: 'repo-a',
          repoName: 'api',
          repoType: 'backend',
          httpPrefix: null,
          commitSha: null,
          parsed: {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            kind: 'parsed',
            version: parsedSha.slice(0, 16),
            r2Key: parsedKey,
            sha256: parsedSha,
            sizeBytes: String(parsedBytes.length),
          },
          summary: null,
          embeddings: null,
        },
      ],
      mapper: null,
    };
    const identity = createGraphSnapshotIdentity(manifest);
    let published: Buffer | null = null;
    const r2 = {
      headObject: vi.fn().mockResolvedValue(null),
      downloadStream: vi.fn(async (key: string) =>
        key === parsedKey
          ? (async function* () {
              yield parsedBytes;
            })()
          : null,
      ),
      putFileIfAbsent: vi.fn(async (_key: string, path: string) => {
        published = await readFile(path);
        return 'created' as const;
      }),
    };
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, root);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({ resolution: { resolved: 0, total: 0 } });
    expect(result.repositoryCounts['repo-a']).toMatchObject({ nodeCount: 3 });
    expect(published).not.toBeNull();
    expect(published!.includes(Buffer.from(SOURCE_CANARY))).toBe(false);
    expect(createHash('sha256').update(published!).digest('hex')).toBe(result.sha256);
  }, 30_000);

  it('recovers after local conditional PUT before pointer publication using persisted metadata and full bytes', async () => {
    const root = join(tmpdir(), `coredoc-phase3-local-recovery-${process.pid}-${Date.now()}`);
    roots.push(root);
    const parsedBytes = Buffer.from(JSON.stringify(parsedFixture()));
    const parsedSha = createHash('sha256').update(parsedBytes).digest('hex');
    const parsedKey = `${WORKSPACE_ID}/api/results/parsed/${parsedSha.slice(0, 16)}.json`;
    const manifest: GraphSnapshotManifestV1 = {
      manifestVersion: 1,
      workspaceId: WORKSPACE_ID,
      parentVersionId: null,
      ...GRAPH_FILE_FORMAT_COMPATIBILITY,
      sourcePolicy: 'strip',
      repositories: [
        {
          repoKey: 'repo-a',
          repoName: 'api',
          repoType: 'backend',
          httpPrefix: null,
          commitSha: null,
          parsed: {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            kind: 'parsed',
            version: parsedSha.slice(0, 16),
            r2Key: parsedKey,
            sha256: parsedSha,
            sizeBytes: String(parsedBytes.length),
          },
          summary: null,
          embeddings: null,
        },
      ],
      mapper: null,
    };
    const identity = createGraphSnapshotIdentity(manifest);
    const previousEndpoint = process.env.R2_ENDPOINT;
    delete process.env.R2_ENDPOINT;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const firstStorage = new R2StorageService();
      await firstStorage.upload(parsedKey, parsedBytes, 'application/json');
      const first = await new GraphSnapshotBuildService(firstStorage, join(root, 'first-builds')).materialize(
        identity.manifest,
        identity.versionId,
      );

      // Simulate a process crash after the immutable object was created but
      // before the control-plane pointer transaction.
      const freshStorage = new R2StorageService();
      const recovered = await new GraphSnapshotBuildService(freshStorage, join(root, 'retry-builds')).materialize(
        identity.manifest,
        identity.versionId,
      );

      expect(recovered).toMatchObject({
        r2Key: first.r2Key,
        sha256: first.sha256,
        sizeBytes: first.sizeBytes,
      });
      expect(await freshStorage.headObject(first.r2Key)).toMatchObject({
        contentLength: first.sizeBytes,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: {
          sha256: first.sha256,
          sizebytes: String(first.sizeBytes),
          versionid: identity.versionId,
          workspaceid: WORKSPACE_ID,
        },
      });
      expect(await freshStorage.list(`${WORKSPACE_ID}/graphs/`)).toEqual([first.r2Key]);
    } finally {
      cwd.mockRestore();
      if (previousEndpoint === undefined) delete process.env.R2_ENDPOINT;
      else process.env.R2_ENDPOINT = previousEndpoint;
    }
  }, 30_000);

  it('rejects a real recovered Ladybug object whose unresolved call retains stale resolvedTargetId state', async () => {
    const root = join(tmpdir(), `coredoc-phase3-stale-resolution-${process.pid}-${Date.now()}`);
    roots.push(root);
    const parsed = parsedFixture();
    parsed.externalCalls = [
      {
        id: 'repo-a:external-call:src/index.ts:missing',
        versionedId: 'repo-a:external-call:src/index.ts:missing@v1',
        callerId: 'repo-a:function:src/index.ts:handler',
        serviceName: 'missing-service',
        method: 'fetchMissing',
        targetDescriptor: {
          protocol: 'http',
          targetService: 'missing-service',
          http: { method: 'GET', pathTemplate: '/missing' },
        },
        resolvedTargetId: 'repo-a:entrypoint:src/index.ts:stale',
        location: { filePath: 'src/index.ts', startLine: 2, endLine: 2 },
      },
    ];
    const parsedBytes = Buffer.from(JSON.stringify(parsed));
    const parsedSha = createHash('sha256').update(parsedBytes).digest('hex');
    const parsedKey = `${WORKSPACE_ID}/api/results/parsed/${parsedSha.slice(0, 16)}.json`;
    const manifest: GraphSnapshotManifestV1 = {
      manifestVersion: 1,
      workspaceId: WORKSPACE_ID,
      parentVersionId: null,
      ...GRAPH_FILE_FORMAT_COMPATIBILITY,
      sourcePolicy: 'strip',
      repositories: [
        {
          repoKey: 'repo-a',
          repoName: 'api',
          repoType: 'backend',
          httpPrefix: null,
          commitSha: null,
          parsed: {
            workspaceId: WORKSPACE_ID,
            repoKey: 'repo-a',
            repoName: 'api',
            kind: 'parsed',
            version: parsedSha.slice(0, 16),
            r2Key: parsedKey,
            sha256: parsedSha,
            sizeBytes: String(parsedBytes.length),
          },
          summary: null,
          embeddings: null,
        },
      ],
      mapper: null,
    };
    const identity = createGraphSnapshotIdentity(manifest);
    const graphPath = join(root, 'stale.ladybug');
    await buildGraphFile({
      outputPath: graphPath,
      workDir: join(root, 'stale-work'),
      components: (async function* () {
        yield { parsedRepo: parsed, summaryOutput: null, embeddingsOutput: null };
      })(),
    });
    const graphBytes = await readFile(graphPath);
    const graphSha = createHash('sha256').update(graphBytes).digest('hex');
    const graphKey = `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`;
    const r2 = {
      headObject: vi.fn(async (key: string) =>
        key === graphKey
          ? {
              contentLength: graphBytes.length,
              contentType: 'application/vnd.coredoc.ladybug',
              etag: null,
              lastModified: null,
              metadata: {
                sha256: graphSha,
                sizebytes: String(graphBytes.length),
                versionid: identity.versionId,
                workspaceid: WORKSPACE_ID,
                engine: GRAPH_FILE_FORMAT_COMPATIBILITY.engine,
                engineversion: GRAPH_FILE_FORMAT_COMPATIBILITY.engineVersion,
                schemaversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.graphSchemaVersion),
                builderversion: GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
                storageformatversion: String(GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion),
              },
            }
          : null,
      ),
      downloadStream: vi.fn(async (key: string) =>
        key === graphKey || key === parsedKey
          ? (async function* () {
              yield key === graphKey ? graphBytes : parsedBytes;
            })()
          : null,
      ),
      putFileIfAbsent: vi.fn(),
    };
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, join(root, 'recovery-builds'));

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  }, 30_000);
});
