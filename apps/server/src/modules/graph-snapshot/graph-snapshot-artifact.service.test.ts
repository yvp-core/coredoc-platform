import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';
import {
  GRAPH_FILE_FORMAT_COMPATIBILITY,
  stripEmbeddingInputText,
  stripSourceCode,
  transformParsedRepo,
} from '@coredoc/db';
import type { R2StorageService } from '../../database/r2-storage.service.js';
import { StorageConditionalWriteError } from '../../database/r2-storage.service.js';
import {
  GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES,
  GraphSnapshotBuildService,
  graphSnapshotArtifactSizeWithinLimit,
} from './graph-snapshot-artifact.service.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import { createGraphSnapshotIdentity } from './graph-snapshot-manifest.js';
import type { GraphSnapshotManifestV1 } from '../../libs/pipeline/graph-snapshot.types.js';

const buildGraphFile = vi.hoisted(() => vi.fn());
const openGraphFile = vi.hoisted(() => vi.fn());
const resolvePinnedCandidate = vi.hoisted(() => vi.fn());
const computePinnedResolution = vi.hoisted(() => vi.fn());
const createWriteStream = vi.hoisted(() => vi.fn<typeof import('node:fs').createWriteStream>());

vi.mock('@coredoc/db/file-builder', () => ({ buildGraphFile }));
vi.mock('@coredoc/db/graph-file', () => ({ openGraphFile }));
vi.mock('../mapper/resolver-kernel.js', () => ({ computePinnedResolution, resolvePinnedCandidate }));
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  createWriteStream.mockImplementation(actual.createWriteStream);
  return { ...actual, createWriteStream };
});

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PARSED_VERSION = 'a'.repeat(16);
const GRAPH_BYTES = Buffer.from('valid-ladybug-file');

function parsedRepo(): ParsedRepo {
  return {
    id: 'repo-a',
    name: 'api',
    path: '/private/source',
    parsedAt: '2026-08-11T00:00:00.000Z',
    parserVersion: '1',
    parserId: 'parser',
    packages: [],
    files: [],
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
    stats: {
      totalFiles: 0,
      totalFunctions: 0,
      totalClasses: 0,
      totalEntrypoints: 0,
      parseTimeMs: 0,
    },
  } as ParsedRepo;
}

function descriptor(body: Buffer) {
  const sha256 = requireHash(body);
  return {
    workspaceId: WORKSPACE_ID,
    repoKey: 'repo-a',
    repoName: 'api',
    kind: 'parsed' as const,
    version: PARSED_VERSION,
    r2Key: `${WORKSPACE_ID}/api/results/parsed/${PARSED_VERSION}.json`,
    sha256,
    sizeBytes: String(body.length),
  };
}

function requireHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function manifest(parsedBody: Buffer): GraphSnapshotManifestV1 {
  return {
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
        commitSha: null,
        parsed: descriptor(parsedBody),
        summary: null,
        embeddings: null,
      },
    ],
    mapper: null,
  };
}

function chunks(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body.subarray(0, Math.ceil(body.length / 2));
      yield body.subarray(Math.ceil(body.length / 2));
    },
  };
}

function graphHead(
  identity: ReturnType<typeof createGraphSnapshotIdentity>,
  body = GRAPH_BYTES,
  metadata: Record<string, string> = {},
) {
  return {
    contentLength: body.length,
    contentType: 'application/vnd.coredoc.ladybug',
    etag: null,
    lastModified: null,
    metadata: {
      sha256: requireHash(body),
      sizebytes: String(body.length),
      versionid: identity.versionId,
      workspaceid: WORKSPACE_ID,
      engine: 'ladybug',
      engineversion: '0.19.1',
      schemaversion: '1',
      builderversion: GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion,
      storageformatversion: '1',
      ...metadata,
    },
  };
}

function r2Mock(parsedBody: Buffer) {
  return {
    headObject: vi.fn().mockResolvedValue(null),
    downloadStream: vi.fn(async (key: string) => {
      if (key.includes('/parsed/')) return chunks(parsedBody);
      return null;
    }),
    putFileIfAbsent: vi.fn().mockResolvedValue('created'),
  };
}

function serviceWithStorageTimeout(r2: ReturnType<typeof r2Mock>, buildRoot: string, timeoutMs = 20) {
  return new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot, timeoutMs);
}

/**
 * The production builder strips, transforms, and only then hands the
 * transformed component to `onComponentTransformed`. Mocks of the builder must
 * reproduce that, or every structural and source-policy check the caller
 * installs through the hook silently stops running under test.
 */
function transformComponentLikeBuilder(
  component: unknown,
  onComponentTransformed?: (transformed: ReturnType<typeof transformParsedRepo>) => void,
): void {
  if (!onComponentTransformed) return;
  const { parsedRepo, summaryOutput, embeddingsOutput } = component as {
    parsedRepo: ParsedRepo;
    summaryOutput: SummaryOutput | null;
    embeddingsOutput: EmbeddingsOutput | null;
  };
  const { parsed } = stripSourceCode(parsedRepo);
  const embeddings = embeddingsOutput ? stripEmbeddingInputText(embeddingsOutput).embeddings : null;
  onComponentTransformed(transformParsedRepo(parsed, summaryOutput, embeddings));
}

describe('GraphSnapshotBuildService', () => {
  let buildRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    buildRoot = await mkdtemp(join(tmpdir(), 'graph-snapshot-artifact-test-'));
    buildGraphFile.mockImplementation(async (input: { outputPath: string; components: AsyncIterable<unknown> }) => {
      for await (const component of input.components) {
        // Mirror the real builder: strip, transform, then hand the transformed
        // component to the caller's inspection hook. Draining the iterator
        // alone would silently skip every check the hook carries.
        transformComponentLikeBuilder(component, input.onComponentTransformed);
      }
      await writeFile(input.outputPath, GRAPH_BYTES);
      return {
        engine: 'ladybug',
        artifactPath: input.outputPath,
        fileSizeBytes: GRAPH_BYTES.length,
        nodeCount: 1,
        edgeCount: 0,
        droppedDanglingEdgeCount: 0,
        deduplicatedEdgeCount: 0,
      };
    });
    openGraphFile.mockResolvedValue({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield {
            id: 'repo-a',
            type: 'repository',
            name: 'api',
            properties: {},
            repoId: null,
            filePath: null,
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          // The default valid graph has no relationships.
        }),
      },
      close: vi.fn(),
    });
    resolvePinnedCandidate.mockResolvedValue({ resolved: 0, total: 0, rate: 0, legacyEdges: 0 });
    computePinnedResolution.mockResolvedValue({
      repos: [],
      result: {
        edges: [],
        unresolved: [],
        metrics: { resolved: 2, total: 3, rate: 2 / 3 },
      },
    });
  });

  afterEach(async () => {
    await rm(buildRoot, { recursive: true, force: true });
  });

  it('accepts CLI-redacted artifacts (no repo path) and stored nodes without filePath', async () => {
    // The real upload shape: the CLI redacts the local filesystem root before
    // upload, so `path` is absent server-side; and repository/route nodes carry
    // `filePath: undefined`, not null. Both crashed the build with a TypeError
    // inside unsafeRepositoryPath until guarded (found live on 2026-08-12).
    const redacted = parsedRepo() as Record<string, unknown>;
    delete redacted.path;
    const parsedBody = Buffer.from(JSON.stringify(redacted));
    openGraphFile.mockResolvedValue({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield {
            id: 'repo-a',
            type: 'repository',
            name: 'api',
            properties: {},
            repoId: null,
            filePath: undefined,
          };
        }),
        scanStoredEdges: vi.fn(async function* () {}),
      },
      close: vi.fn(),
    });
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result.sha256).toHaveLength(64);
  });

  it('accepts a repo-relative templateFile (the must-NOT twin of the rejected ones)', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    openGraphFile.mockResolvedValue({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: undefined };
          yield {
            id: 'repo-a:component:src/Home.kt:Home',
            type: 'component',
            name: 'Home',
            properties: { templateFile: 'src/res/layout/home.xml' },
            repoId: 'repo-a',
            filePath: 'src/Home.kt',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {}),
      },
      close: vi.fn(),
    });
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result.sha256).toHaveLength(64);
  });

  it('builds from verified pinned components and conditionally publishes', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: requireHash(GRAPH_BYTES),
      sizeBytes: GRAPH_BYTES.length,
    });
    expect(r2.putFileIfAbsent).toHaveBeenCalledWith(
      `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      expect.any(String),
      expect.objectContaining({
        contentLength: GRAPH_BYTES.length,
        contentType: 'application/vnd.coredoc.ladybug',
        metadata: expect.objectContaining({
          sha256: requireHash(GRAPH_BYTES),
          versionid: identity.versionId,
          workspaceid: WORKSPACE_ID,
        }),
      }),
    );
  });

  it('recovers a committed PUT after a pre-CAS crash without an overwrite', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    let objectExists = false;
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockImplementation(async (key: string) =>
      key.includes('/graphs/') && objectExists ? graphHead(identity) : null,
    );
    r2.downloadStream.mockImplementation(async (key: string) => {
      if (key.includes('/parsed/')) return chunks(parsedBody);
      if (key.includes('/graphs/') && objectExists) return chunks(GRAPH_BYTES);
      return null;
    });
    r2.putFileIfAbsent.mockImplementation(async () => {
      objectExists = true;
      return 'created' as const;
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const injectedCrash = new Error('injected crash after PUT and before pointer CAS');
    const firstAttempt = async () => {
      await service.materialize(identity.manifest, identity.versionId);
      throw injectedCrash;
    };

    await expect(firstAttempt()).rejects.toBe(injectedCrash);

    const retried = await service.materialize(identity.manifest, identity.versionId, new AbortController().signal);

    expect(retried).toMatchObject({
      r2Key: `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      sha256: requireHash(GRAPH_BYTES),
      sizeBytes: GRAPH_BYTES.length,
    });
    expect(r2.putFileIfAbsent).toHaveBeenCalledTimes(1);
    expect(buildGraphFile).toHaveBeenCalledTimes(1);
  });

  it('verifies an existing object whose resolution has float-confidence RESOLVES_TO edges', async () => {
    // Real resolutions carry float confidences (0.95); the manifest
    // canonicalizer rejects non-integer numbers, so reusing it here turned
    // every verified non-empty resolution into a permanent identity conflict
    // (found live on 2026-08-12). This pins the fixed comparison.
    const resolutionEdge = {
      id: 'repo-a:ec:call:RESOLVES_TO:repo-a:fn:handler',
      sourceId: 'repo-a:ec:call',
      targetId: 'repo-a:fn:handler',
      confidence: 0.95,
      properties: {},
    };
    computePinnedResolution.mockResolvedValue({
      repos: [],
      result: { edges: [resolutionEdge], unresolved: [], metrics: { resolved: 1, total: 1, rate: 1 } },
    });
    openGraphFile.mockResolvedValue({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
          yield {
            id: 'repo-a:fn:handler',
            type: 'function',
            name: 'handler',
            properties: {},
            repoId: 'repo-a',
            filePath: 'src/a.ts',
          };
          yield {
            id: 'repo-a:ec:call',
            type: 'external_call',
            name: 'call',
            properties: { resolvedTargetId: 'repo-a:fn:handler' },
            repoId: 'repo-a',
            filePath: 'src/a.ts',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          yield {
            id: resolutionEdge.id,
            sourceId: resolutionEdge.sourceId,
            targetId: resolutionEdge.targetId,
            type: 'RESOLVES_TO',
            confidence: 0.95,
            createdBy: 'ai',
            properties: {},
          };
        }),
      },
      close: vi.fn(),
    });
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockImplementation(async (key: string) => (key.includes('/graphs/') ? graphHead(identity) : null));
    r2.downloadStream.mockImplementation(async (key: string) => {
      if (key.includes('/parsed/')) return chunks(parsedBody);
      if (key.includes('/graphs/')) return chunks(GRAPH_BYTES);
      return null;
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result.sha256).toBe(requireHash(GRAPH_BYTES));
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'reuses', storedImportedName: 'BookingTypes', expectConflict: false },
    { label: 'rejects a property mismatch in', storedImportedName: 'WrongType', expectConflict: true },
  ])('$label an existing object with a package-import RESOLVES_TO edge', async ({
    storedImportedName,
    expectConflict,
  }) => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const providerParsedBody = Buffer.from(JSON.stringify({ ...parsedRepo(), id: 'repo-b', name: 'types' }));
    const snapshotManifest = manifest(parsedBody);
    const consumer = snapshotManifest.repositories[0]!;
    snapshotManifest.repositories.push({
      ...consumer,
      repoKey: 'repo-b',
      repoName: 'types',
      parsed: {
        ...consumer.parsed,
        repoKey: 'repo-b',
        repoName: 'types',
        r2Key: `${WORKSPACE_ID}/types/results/parsed/${PARSED_VERSION}.json`,
        sha256: requireHash(providerParsedBody),
        sizeBytes: String(providerParsedBody.length),
      },
    });
    const identity = createGraphSnapshotIdentity(snapshotManifest);
    const sourceId = 'repo-a:file:src/use-booking.ts';
    const targetId = 'repo-b:enum:src/enums.ts:BookingTypes';
    const packageEdge = {
      id: `resolve:package-import:repo-a:import:booking:BookingTypes:${targetId}`,
      sourceId,
      targetId,
      confidence: 1,
      createdBy: 'cross-repo-linker' as const,
      properties: {
        relation: 'package-import',
        usage: 'import',
        via: 'BookingKind',
        packageName: '@acme/types',
        moduleSpecifier: '@acme/types',
        importedName: 'BookingTypes',
        importedAlias: 'BookingKind',
        isTypeOnly: true,
        importKind: 'named' as const,
        sourceRepoId: 'repo-a',
        sourceRepoName: 'api',
        sourceFilePath: 'src/use-booking.ts',
        targetRepoId: 'repo-b',
        targetRepoName: 'types',
        targetPackageId: 'repo-b:package:types',
        targetFileId: 'repo-b:file:src/enums.ts',
        targetFilePath: 'src/enums.ts',
        targetKind: 'enum' as const,
        confidenceLevel: 'exact' as const,
      },
    };
    computePinnedResolution.mockResolvedValue({
      repos: [],
      result: {
        edges: [],
        packageImportEdges: [packageEdge],
        unresolved: [],
        metrics: { resolved: 0, total: 0, unresolvableExcluded: 0, rate: 0 },
      },
    });
    openGraphFile.mockResolvedValue({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([
          { hash: 'repo-a', name: 'api' },
          { hash: 'repo-b', name: 'types' },
        ]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
          yield { id: 'repo-b', type: 'repository', name: 'types', properties: {}, repoId: null, filePath: null };
          yield {
            id: sourceId,
            type: 'file',
            name: 'src/use-booking.ts',
            properties: {},
            repoId: 'repo-a',
            filePath: 'src/use-booking.ts',
          };
          yield {
            id: targetId,
            type: 'enum',
            name: 'BookingTypes',
            properties: {},
            repoId: 'repo-b',
            filePath: 'src/enums.ts',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          yield {
            id: packageEdge.id,
            sourceId,
            targetId,
            type: 'RESOLVES_TO',
            confidence: 1,
            createdBy: 'ai',
            properties: {
              ...packageEdge.properties,
              importedName: storedImportedName,
              createdBy: 'cross-repo-linker',
            },
          };
        }),
      },
      close: vi.fn(),
    });
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) => {
      if (key.includes('/graphs/')) return chunks(GRAPH_BYTES);
      if (key.includes('/types/')) return chunks(providerParsedBody);
      return chunks(parsedBody);
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const materialize = service.materialize(snapshotManifest, identity.versionId);
    if (expectConflict) {
      await expect(materialize).rejects.toMatchObject({ code: 'graph_object_identity_conflict' });
    } else {
      await expect(materialize).resolves.toMatchObject({ sha256: requireHash(GRAPH_BYTES) });
    }
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects an in-prefix traversal key before any storage request', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const unsafe = manifest(parsedBody);
    unsafe.repositories[0]!.parsed.r2Key = `${WORKSPACE_ID}/../other/parsed.json`;
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(unsafe, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'artifact_tenant_mismatch',
    });
    expect(r2.headObject).not.toHaveBeenCalled();
    expect(r2.downloadStream).not.toHaveBeenCalled();
  });

  it('rejects matching self-asserted metadata when existing object bytes are corrupted', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const corrupt = Buffer.from('corrupt-object');
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(corrupt) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(buildGraphFile).not.toHaveBeenCalled();
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('fully reconciles an ambiguous conditional PUT and returns the canonical existing object', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.putFileIfAbsent.mockRejectedValue(
      new StorageConditionalWriteError('ambiguous', 'request outcome unknown', new Error('timeout')),
    );
    r2.headObject.mockResolvedValueOnce(null).mockResolvedValueOnce(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result.sha256).toBe(requireHash(GRAPH_BYTES));
    expect(result.resolution).toEqual({ resolved: 2, total: 3, rate: 2 / 3, legacyEdges: 0 });
    expect(computePinnedResolution).toHaveBeenCalledWith(
      expect.anything(),
      [{ repoKey: 'repo-a', repoName: 'api', httpPrefix: '/api' }],
      expect.objectContaining({ project: '__empty__' }),
      undefined,
    );
    expect(r2.downloadStream).toHaveBeenCalledWith(
      `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('treats a timed-out conditional PUT as ambiguous and fully verifies the committed object', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    // Timeout scheduling itself is covered by the never-settling PUT test
    // below. Inject the typed boundary result here so this recovery assertion
    // is not coupled to a 20 ms wall-clock budget under a parallel repo suite.
    r2.putFileIfAbsent.mockRejectedValue(
      new GraphSnapshotError('graph_storage_timeout', 'Graph storage operation exceeded its deadline'),
    );
    r2.headObject.mockResolvedValueOnce(null).mockResolvedValueOnce(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({ sha256: requireHash(GRAPH_BYTES), sizeBytes: GRAPH_BYTES.length });
    expect(r2.headObject).toHaveBeenCalledTimes(2);
  });

  it('accepts a byte-different canonical conditional-PUT winner when no durable artifact was pinned', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const canonical = Buffer.from('different-valid-canonical-ladybug-file');
    const r2 = r2Mock(parsedBody);
    r2.putFileIfAbsent.mockResolvedValue('already_exists');
    r2.headObject.mockResolvedValueOnce(null).mockResolvedValueOnce(graphHead(identity, canonical));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(canonical) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({
      sha256: requireHash(canonical),
      sizeBytes: canonical.length,
    });
  });

  it.each([
    ['empty', {}],
    ['partial', { sha256: requireHash(GRAPH_BYTES), sizebytes: String(GRAPH_BYTES.length) }],
  ])('rejects %s immutable metadata on an existing graph', async (_label, metadata) => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue({ ...graphHead(identity), metadata });
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(buildGraphFile).not.toHaveBeenCalled();
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('hard-bounds a never-settling HEAD and removes its private tree', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockImplementation(() => new Promise<never>(() => undefined));
    const service = serviceWithStorageTimeout(r2, buildRoot);
    const startedAt = Date.now();

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_storage_timeout',
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await readdir(buildRoot)).toEqual([]);
  });

  it('hard-bounds a stalled object body even when iterator return never settles', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const next = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const returnIterator = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const stalledBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next, return: returnIterator }),
    };
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? stalledBody : chunks(parsedBody),
    );
    const service = serviceWithStorageTimeout(r2, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_storage_timeout',
    });

    await vi.waitFor(() => expect(returnIterator).toHaveBeenCalledTimes(1));
    expect(await readdir(buildRoot)).toEqual([]);
  });

  it('handles a destination stream error immediately while the object body is stalled', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const next = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/')
        ? { [Symbol.asyncIterator]: () => ({ next, return: returnIterator }) }
        : chunks(parsedBody),
    );
    const output = new PassThrough();
    createWriteStream.mockImplementationOnce(() => output as unknown as ReturnType<typeof createWriteStream>);
    const service = serviceWithStorageTimeout(r2, buildRoot, 250);
    const ioError = Object.assign(new Error('disk write failed'), { code: 'EIO' });

    const materialized = service.materialize(identity.manifest, identity.versionId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    const serviceErrorListenerCount = output.listenerCount('error');
    const safetyListener = vi.fn();
    if (serviceErrorListenerCount === 0) output.once('error', safetyListener);
    output.destroy(ioError);
    const thrown = await materialized;

    expect(serviceErrorListenerCount).toBe(1);
    expect(safetyListener).not.toHaveBeenCalled();
    expect(thrown).toMatchObject({ code: 'graph_storage_timeout', cause: ioError });
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(await readdir(buildRoot)).toEqual([]);
  });

  it('allows a recovering object body to keep making progress beyond the idle timeout', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) => {
      if (!key.includes('/graphs/')) return chunks(parsedBody);
      return (async function* () {
        const chunkSize = Math.ceil(GRAPH_BYTES.length / 3);
        for (let offset = 0; offset < GRAPH_BYTES.length; offset += chunkSize) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield GRAPH_BYTES.subarray(offset, offset + chunkSize);
        }
      })();
    });
    const service = serviceWithStorageTimeout(r2, buildRoot, 100);

    const result = await service.materialize(identity.manifest, identity.versionId);

    expect(result).toMatchObject({ sha256: requireHash(GRAPH_BYTES), sizeBytes: GRAPH_BYTES.length });
    expect(await readdir(buildRoot)).toEqual([]);
  });

  it('hard-bounds a never-settling PUT when no canonical object appears', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.putFileIfAbsent.mockImplementation(() => new Promise<never>(() => undefined));
    r2.headObject.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const service = serviceWithStorageTimeout(r2, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_storage_timeout',
    });

    expect(r2.headObject).toHaveBeenCalledTimes(2);
    expect(await readdir(buildRoot)).toEqual([]);
  });

  it('maps a locally built invalid graph to graph_build_failed', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    openGraphFile.mockRejectedValueOnce(new Error('invalid Ladybug file'));
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_build_failed',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('defines the exact inclusive 5-GiB publication boundary and rejects HEAD one byte over before graph GET', async () => {
    expect(graphSnapshotArtifactSizeWithinLimit(GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES)).toBe(true);
    expect(graphSnapshotArtifactSizeWithinLimit(GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES + 1)).toBe(false);
    expect(graphSnapshotArtifactSizeWithinLimit(0)).toBe(false);

    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue({
      ...graphHead(identity),
      contentLength: GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES + 1,
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.downloadStream).not.toHaveBeenCalledWith(
      `${WORKSPACE_ID}/graphs/${identity.versionId}.ladybug`,
      expect.anything(),
    );
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects a component whose streamed digest does not match its immutable descriptor', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(Buffer.from('{}'));
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'artifact_integrity_error',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('blocks publication when final bytes retain an input source canary even under the source env override', async () => {
    const sourceCanary = 'SOURCE_CANARY_5b7167859cab42e3b5513c4fd2432acf';
    const parsed = parsedRepo();
    parsed.functions = [
      {
        id: 'repo-a:function:src/a.ts:secret',
        versionedId: 'repo-a:function:src/a.ts:secret:v1',
        name: 'secret',
        location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        parameters: [],
        returnType: { raw: 'string' },
        isExported: true,
        isAsync: false,
        sourceCode: `return '${sourceCanary}'`,
      },
    ] as ParsedRepo['functions'];
    const parsedBody = Buffer.from(JSON.stringify(parsed));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    buildGraphFile.mockImplementationOnce(async (input: { outputPath: string; components: AsyncIterable<unknown> }) => {
      for await (const component of input.components) {
        // Consume the sensitive fixture through the real builder's contract.
        transformComponentLikeBuilder(component, input.onComponentTransformed);
      }
      const leaked = Buffer.from(`ladybug-prefix-${sourceCanary}-suffix`);
      await writeFile(input.outputPath, leaked);
      return {
        engine: 'ladybug',
        artifactPath: input.outputPath,
        fileSizeBytes: leaked.length,
        nodeCount: 1,
        edgeCount: 0,
        droppedDanglingEdgeCount: 0,
        deduplicatedEdgeCount: 0,
      };
    });
    const previous = process.env.ALLOW_SOURCES_IN_GRAPH;
    process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
    try {
      const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);
      await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
        code: 'graph_build_failed',
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
      else process.env.ALLOW_SOURCES_IN_GRAPH = previous;
    }
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects a fully hashed existing graph whose physical bytes retain a pinned source canary', async () => {
    const sourceCanary = 'RECOVERED_SOURCE_CANARY_4566249cfb90412f9e99e2f14ee0fe0f';
    const parsed = parsedRepo();
    parsed.functions = [
      {
        id: 'repo-a:function:src/a.ts:secret',
        versionedId: 'repo-a:function:src/a.ts:secret:v1',
        name: 'secret',
        location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        parameters: [],
        returnType: { raw: 'string' },
        isExported: true,
        isAsync: false,
        sourceCode: `return '${sourceCanary}'`,
      },
    ] as ParsedRepo['functions'];
    const parsedBody = Buffer.from(JSON.stringify(parsed));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const leaked = Buffer.from(`valid-prefix-${sourceCanary}-valid-suffix`);
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity, leaked));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(leaked) : chunks(parsedBody),
    );
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(openGraphFile).not.toHaveBeenCalled();
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects a physically clean existing graph whose logical node payload retains a pinned source canary', async () => {
    const sourceCanary = 'LOGICAL_SOURCE_CANARY_21eb336ef6c348b692ff3fd15cf933ab';
    const parsed = parsedRepo();
    parsed.functions = [
      {
        id: 'repo-a:function:src/a.ts:secret',
        versionedId: 'repo-a:function:src/a.ts:secret:v1',
        name: 'secret',
        location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 },
        parameters: [],
        returnType: { raw: 'string' },
        isExported: true,
        isAsync: false,
        sourceCode: `return '${sourceCanary}'`,
      },
    ] as ParsedRepo['functions'];
    const parsedBody = Buffer.from(JSON.stringify(parsed));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const containsNodeText = vi.fn().mockResolvedValue(true);
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText,
        scanStoredNodes: vi.fn(async function* () {
          yield {
            id: 'repo-a',
            type: 'repository',
            name: 'api',
            properties: {},
            repoId: null,
            filePath: null,
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          // This fixture has no relationships.
        }),
      },
      close: vi.fn(),
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(containsNodeText).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining(sourceCanary)]), [
      'repo-a',
    ]);
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('structurally rejects a recovered graph with a short sourceCode property', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield {
            id: 'repo-a:function:src/a.ts:secret',
            type: 'function',
            name: 'secret',
            properties: { sourceCode: 'x' },
            repoId: 'repo-a',
            filePath: 'src/a.ts',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          // The forbidden node is enough to invalidate this graph.
        }),
      },
      close: vi.fn(),
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'nested inputText',
      {
        id: 'repo-a:function:src/a.ts:secret',
        type: 'function',
        name: 'secret',
        properties: { documentation: { inputText: 'x' } },
        repoId: 'repo-a',
        filePath: 'src/a.ts',
      },
    ],
    [
      'absolute filePath',
      {
        id: 'repo-a:function:src/a.ts:secret',
        type: 'function',
        name: 'secret',
        properties: {},
        repoId: 'repo-a',
        filePath: '/private/source/a.ts',
      },
    ],
    [
      'traversal path property',
      {
        id: 'repo-a:file:src/a.ts',
        type: 'file',
        name: 'a.ts',
        properties: { path: 'src/../../private/a.ts' },
        repoId: 'repo-a',
        filePath: 'src/a.ts',
      },
    ],
    [
      'encoded traversal filePath',
      {
        id: 'repo-a:function:src/a.ts:secret',
        type: 'function',
        name: 'secret',
        properties: {},
        repoId: 'repo-a',
        filePath: 'src/%252e%252e/private/a.ts',
      },
    ],
    [
      'traversal templateFile',
      {
        id: 'repo-a:component:src/Home.kt:Home',
        type: 'component',
        name: 'Home',
        properties: { templateFile: 'res/../../private/layout.xml' },
        repoId: 'repo-a',
        filePath: 'src/Home.kt',
      },
    ],
    [
      'absolute templateFile',
      {
        id: 'repo-a:component:src/Home.kt:Home',
        type: 'component',
        name: 'Home',
        properties: { templateFile: '/private/source/res/layout.xml' },
        repoId: 'repo-a',
        filePath: 'src/Home.kt',
      },
    ],
    [
      'foreign repository ownership',
      {
        id: 'repo-b:function:src/a.ts:secret',
        type: 'function',
        name: 'secret',
        properties: {},
        repoId: 'repo-b',
        filePath: 'src/a.ts',
      },
    ],
  ])('rejects recovered graph nodes with %s', async (_label, offendingNode) => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
          yield offendingNode;
        }),
        scanStoredEdges: vi.fn(async function* () {
          // The offending node is enough to invalidate this graph.
        }),
      },
      close: vi.fn(),
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects recovery when computed resolution is absent from persisted RESOLVES_TO state', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const sourceId = 'repo-a:external-call:src/a.ts:call';
    const targetId = 'repo-a:entrypoint:src/a.ts:handler';
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
          yield {
            id: sourceId,
            type: 'external_call',
            name: 'client.call',
            properties: { resolvedTargetId: targetId },
            repoId: 'repo-a',
            filePath: 'src/a.ts',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          // Deliberately omits the computed resolution edge.
        }),
      },
      close: vi.fn(),
    });
    computePinnedResolution.mockResolvedValueOnce({
      repos: [],
      result: {
        edges: [
          {
            id: `resolve:${sourceId}:${targetId}`,
            sourceId,
            targetId,
            confidence: 1,
            properties: { via: 'http' },
          },
        ],
        unresolved: [],
        metrics: { resolved: 1, total: 1, rate: 1 },
      },
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects recovery when resolvedTargetId differs from an otherwise exact persisted resolution edge', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    const sourceId = 'repo-a:external-call:src/a.ts:call';
    const targetId = 'repo-a:entrypoint:src/a.ts:handler';
    const edge = {
      id: `resolve:${sourceId}:${targetId}`,
      sourceId,
      targetId,
      confidence: 1,
      properties: { via: 'http' },
    };
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
          yield {
            id: sourceId,
            type: 'external_call',
            name: 'client.call',
            properties: { resolvedTargetId: 'repo-a:entrypoint:src/a.ts:wrong' },
            repoId: 'repo-a',
            filePath: 'src/a.ts',
          };
        }),
        scanStoredEdges: vi.fn(async function* () {
          yield { ...edge, type: 'RESOLVES_TO', createdBy: 'ai' };
        }),
      },
      close: vi.fn(),
    });
    computePinnedResolution.mockResolvedValueOnce({
      repos: [],
      result: { edges: [edge], unresolved: [], metrics: { resolved: 1, total: 1, rate: 1 } },
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects an extra stale persisted RESOLVES_TO edge when pinned resolution is empty', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    r2.headObject.mockResolvedValue(graphHead(identity));
    r2.downloadStream.mockImplementation(async (key: string) =>
      key.includes('/graphs/') ? chunks(GRAPH_BYTES) : chunks(parsedBody),
    );
    openGraphFile.mockResolvedValueOnce({
      repository: {
        listAllRepositories: vi.fn().mockResolvedValue([{ hash: 'repo-a', name: 'api' }]),
        containsNodeText: vi.fn().mockResolvedValue(false),
        scanStoredNodes: vi.fn(async function* () {
          yield { id: 'repo-a', type: 'repository', name: 'api', properties: {}, repoId: null, filePath: null };
        }),
        scanStoredEdges: vi.fn(async function* () {
          yield {
            id: 'resolve:stale',
            sourceId: 'repo-a:external-call:src/a.ts:stale',
            targetId: 'repo-a:entrypoint:src/a.ts:stale',
            type: 'RESOLVES_TO',
            confidence: 1,
            createdBy: 'ai',
            properties: {},
          };
        }),
      },
      close: vi.fn(),
    });
    computePinnedResolution.mockResolvedValueOnce({
      repos: [],
      result: { edges: [], unresolved: [], metrics: { resolved: 0, total: 0, rate: 0 } },
    });
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'graph_object_identity_conflict',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects an unsafe author-controlled source path before graph publication', async () => {
    const parsed = parsedRepo();
    parsed.functions = [
      {
        id: 'repo-a:function:../private/secret.ts:secret',
        versionedId: 'repo-a:function:../private/secret.ts:secret:v1',
        name: 'secret',
        location: { filePath: '../private/secret.ts', startLine: 1, endLine: 1 },
        parameters: [],
        returnType: { raw: 'string' },
        isExported: true,
        isAsync: false,
      },
    ] as ParsedRepo['functions'];
    const parsedBody = Buffer.from(JSON.stringify(parsed));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await expect(service.materialize(identity.manifest, identity.versionId)).rejects.toMatchObject({
      code: 'artifact_integrity_error',
    });
    expect(r2.putFileIfAbsent).not.toHaveBeenCalled();
  });

  it('removes its private temporary tree after success', async () => {
    const parsedBody = Buffer.from(JSON.stringify(parsedRepo()));
    const identity = createGraphSnapshotIdentity(manifest(parsedBody));
    const r2 = r2Mock(parsedBody);
    const service = new GraphSnapshotBuildService(r2 as unknown as R2StorageService, buildRoot);

    await service.materialize(identity.manifest, identity.versionId);

    expect(await readFile(join(buildRoot, '.keep')).catch(() => null)).toBeNull();
    expect(await (await import('node:fs/promises')).readdir(buildRoot)).toEqual([]);
  });
});
