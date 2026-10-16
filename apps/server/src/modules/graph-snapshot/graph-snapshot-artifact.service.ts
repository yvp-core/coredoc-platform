import { Injectable, Logger } from '@nestjs/common';
import { configFromEnv } from '../../config/app-config.js';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { EdgeType, NodeType, validateMapper, type LinkEdge, type Mapper } from '@coredoc/core';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';
import {
  ByteMultiPatternMatcher,
  stripEmbeddingInputText,
  stripSourceCode,
  transformParsedRepo,
  type IGraphFileValidationRepository,
  type StoredGraphValidationEdge,
  type StoredGraphValidationNode,
} from '@coredoc/db';
import { buildGraphFile, type GraphFileBuildResult } from '@coredoc/db/file-builder';
import { openGraphFile } from '@coredoc/db/graph-file';
import {
  R2StorageService,
  StorageConditionalWriteError,
  type StorageObjectHead,
} from '../../database/r2-storage.service.js';
import {
  computePinnedResolution,
  resolvePinnedCandidate,
  type PinnedResolutionMetrics,
} from '../mapper/resolver-kernel.js';
import { GraphSnapshotError, type GraphSnapshotErrorCode } from '../../libs/pipeline/graph-snapshot.errors.js';
import {
  assertWorkspaceScopedR2Key,
  createGraphSnapshotIdentity,
  graphSnapshotR2Key,
  hasCurrentGraphSnapshotCompatibility,
} from './graph-snapshot-manifest.js';
import type {
  GraphSnapshotManifestV1,
  GraphSnapshotMapperDescriptor,
  WorkspaceRepoArtifactDescriptor,
} from '../../libs/pipeline/graph-snapshot.types.js';

type GraphContentFailureCode = 'artifact_integrity_error' | 'graph_build_failed' | 'graph_object_identity_conflict';

const DEFAULT_STORAGE_TIMEOUT_MS = 60_000;
const DEFAULT_COMPONENT_MAX_BYTES = 512 * 1024 * 1024;
export const GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;
// Budget accepted artifacts at 1 MiB/s, but never let a progressing or opaque
// storage operation run forever.
const MIN_STORAGE_TRANSFER_BYTES_PER_SECOND = 1024 * 1024;
const MAX_STORAGE_OPERATION_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const MIN_STORAGE_IDLE_WINDOWS = 4;
// Ladybug requires maxDbSizeBytes to be a power of two. Keep the immutable
// single-PUT protocol capped independently at 5 GiB, then reopen under the
// smallest valid engine budget that can contain every accepted artifact.
const LADYBUG_VALIDATION_MAX_DB_BYTES = 8 * 1024 * 1024 * 1024;
// Validation is a build-time FULL-SCAN workload (every node+edge, FTS canary
// probe, resolution recompute) — not an MCP point-read. A reader-sized pool
// starves it once the workspace grows: at ~35 repos / ~160 MB the old 128 MiB
// cap died with "Buffer manager exception: unable to allocate memory" (found
// live 2026-08-12). Match the build-side pool: the same process just built the
// file under this ceiling, and Ladybug allocates the pool on demand, so small
// workspaces pay nothing extra. Must stay a power of two.
const READ_VALIDATION_BUFFER_BYTES = 1024 * 1024 * 1024;
const MAX_PHYSICAL_SCAN_PATTERN_COUNT = 20_000;
const MAX_PHYSICAL_SCAN_PATTERN_BYTES = 1024 * 1024;
const MAX_PHYSICAL_SCAN_PATTERN_LENGTH = 1024;
const EMPTY_MAPPER: Mapper = Object.freeze({
  $schemaVersion: 1 as const,
  project: '__empty__',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
}) as Mapper;

export interface MaterializedGraphSnapshot {
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  resolution: PinnedResolutionMetrics | null;
  repositoryCounts: Readonly<Record<string, { nodeCount: number; edgeCount: number }>>;
}

interface StreamDigest {
  sha256: string;
  sizeBytes: number;
}

interface StorageOperationOptions {
  expectedBytes?: number;
  trackProgress?: boolean;
}

export function graphSnapshotArtifactSizeWithinLimit(sizeBytes: number): boolean {
  return Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES;
}

function storageHardTimeoutMs(idleTimeoutMs: number, expectedBytes?: number): number {
  if (expectedBytes === undefined) return idleTimeoutMs;
  const transferMs = Math.ceil((expectedBytes / MIN_STORAGE_TRANSFER_BYTES_PER_SECOND) * 1_000);
  return Math.min(
    MAX_STORAGE_OPERATION_TIMEOUT_MS,
    Math.max(idleTimeoutMs * MIN_STORAGE_IDLE_WINDOWS, idleTimeoutMs + transferMs),
  );
}

function expectedSize(descriptor: { sizeBytes: string }): number {
  const size = Number(descriptor.sizeBytes);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new GraphSnapshotError('artifact_identity_conflict', 'Artifact size is outside the supported range');
  }
  return size;
}

function storageMetadata(head: StorageObjectHead, key: string): string | null {
  const value = head.metadata[key] ?? head.metadata[key.toLowerCase()];
  return value ?? null;
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason ?? new Error('Operation aborted'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (listener) signal.removeEventListener('abort', listener);
    },
  };
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  const abort = abortPromise(signal);
  try {
    return await Promise.race([iterator.next(), abort.promise]);
  } finally {
    abort.cleanup();
  }
}

async function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

function closeIteratorBestEffort<T>(iterator: AsyncIterator<T>): void {
  try {
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // The operation is already failing; iterator cleanup must never defeat the
    // hard storage deadline or delay private-directory removal.
  }
}

async function streamToFile(
  source: AsyncIterable<Uint8Array>,
  path: string,
  signal: AbortSignal,
  maximumBytes: number,
  oversizeCode: GraphSnapshotErrorCode = 'graph_artifact_too_large',
  onProgress: () => void = () => undefined,
): Promise<StreamDigest> {
  const output = createWriteStream(path, { flags: 'wx', signal });
  let outputError: unknown;
  const outputAbort = new AbortController();
  const outputCompletion = finished(output).catch((error: unknown) => {
    outputError = error;
    outputAbort.abort(error);
    throw error;
  });
  void outputCompletion.catch(() => undefined);
  const readSignal = AbortSignal.any([signal, outputAbort.signal]);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, readSignal);
      if (next.done) break;
      signal.throwIfAborted();
      const chunk = Buffer.from(next.value);
      sizeBytes += chunk.length;
      if (sizeBytes > maximumBytes) {
        throw new GraphSnapshotError(oversizeCode, 'Graph artifact exceeds the single-PUT limit');
      }
      hash.update(chunk);
      await writeChunk(output, chunk);
      if (chunk.length > 0) onProgress();
    }
    output.end();
    await outputCompletion;
    signal.throwIfAborted();
    return { sha256: hash.digest('hex'), sizeBytes };
  } catch (error) {
    output.destroy();
    closeIteratorBestEffort(iterator);
    await outputCompletion.catch(() => undefined);
    if (outputError === error && !signal.aborted) {
      throw new GraphSnapshotError('graph_storage_timeout', 'Failed to stage a graph storage object locally', {
        cause: error,
      });
    }
    throw error;
  }
}

async function streamToBuffer(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maximumBytes: number,
  onProgress: () => void,
): Promise<{ body: Buffer; digest: StreamDigest }> {
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) break;
      signal.throwIfAborted();
      const chunk = Buffer.from(next.value);
      sizeBytes += chunk.length;
      if (sizeBytes > maximumBytes) {
        throw new GraphSnapshotError('artifact_integrity_error', 'Component exceeds the configured size limit');
      }
      hash.update(chunk);
      chunks.push(chunk);
      if (chunk.length > 0) onProgress();
    }
  } catch (error) {
    closeIteratorBestEffort(iterator);
    throw error;
  }
  return { body: Buffer.concat(chunks), digest: { sha256: hash.digest('hex'), sizeBytes } };
}

async function hashFile(path: string, maximumBytes: number, signal?: AbortSignal): Promise<StreamDigest> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    sizeBytes += chunk.length;
    if (sizeBytes > maximumBytes) {
      throw new GraphSnapshotError('graph_artifact_too_large', 'Graph artifact exceeds the single-PUT limit');
    }
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

class SensitiveCanarySet extends Set<string> {
  private byteLength = 0;

  override add(value: string): this {
    if (this.has(value)) return this;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (
      bytes === 0 ||
      bytes > MAX_PHYSICAL_SCAN_PATTERN_LENGTH ||
      this.size >= MAX_PHYSICAL_SCAN_PATTERN_COUNT ||
      this.byteLength + bytes > MAX_PHYSICAL_SCAN_PATTERN_BYTES
    ) {
      throw new GraphSnapshotError('artifact_integrity_error', 'Sensitive physical scan patterns exceed safe limits');
    }
    this.byteLength += bytes;
    return super.add(value);
  }
}

/**
 * Property keys whose string value is a REPO-RELATIVE path. Every one is checked before a
 * snapshot is published, so an absolute or traversing path never rides into R2: `filePath`
 * (every node), and `templateFile` (the markup file a component renders — an Android layout
 * XML, a Vue SFC template, an Angular `templateUrl`). `path` is checked separately because
 * route/entrypoint addresses are legitimately absolute (`/users/:id`).
 */
const REPO_RELATIVE_PATH_KEYS = new Set(['filePath', 'templateFile']);

function collectSensitiveCanaries(value: unknown, canaries: Set<string>, key = ''): void {
  if (typeof value === 'string') {
    const unsafeFilesystemPath = REPO_RELATIVE_PATH_KEYS.has(key) && unsafeRepositoryPath(value);
    const sensitiveText = key === 'sourceCode' || key === 'inputText' || unsafeFilesystemPath;
    if (sensitiveText) {
      if (unsafeFilesystemPath && value.length >= 12) canaries.add(value);
      for (const token of value.match(/[A-Za-z][A-Za-z0-9_:-]*[0-9a-f]{16,}/g) ?? []) canaries.add(token);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectSensitiveCanaries(entry, canaries, key);
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveCanaries(child, canaries, childKey);
  }
}

function unsafeRepositoryPath(value: string, allowRouteAbsolute = false): boolean {
  if (value.length === 0 || value.includes('\0')) return true;
  let normalized = value.replaceAll('\\', '/');
  for (let pass = 0; pass < 3; pass += 1) {
    if (normalized.includes('\0')) return true;
    if (
      !allowRouteAbsolute &&
      (normalized.startsWith('/') || normalized.startsWith('~/') || /^(?:[A-Za-z]:\/|file:\/)/i.test(normalized))
    ) {
      return true;
    }
    if (normalized.split('/').some((segment) => segment === '..')) return true;
    try {
      const decoded = decodeURIComponent(normalized).replaceAll('\\', '/');
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      // intentional: malformed percent-encoding cannot be decoded further, so
      // stop unwrapping and judge the last readable form. The traversal checks
      // above already ran on it — breaking never returns "safe" unchecked.
      break;
    }
  }
  return false;
}

function assertSafeGraphProperties(
  value: unknown,
  failureCode: GraphContentFailureCode,
  allowRouteAbsolutePath = false,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeGraphProperties(entry, failureCode);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sourceCode' || key === 'inputText') {
      throw new GraphSnapshotError(failureCode, 'Graph properties violate the source policy');
    }
    if (typeof child === 'string' && REPO_RELATIVE_PATH_KEYS.has(key) && unsafeRepositoryPath(child)) {
      throw new GraphSnapshotError(failureCode, 'Graph properties contain an unsafe source file path');
    }
    if (typeof child === 'string' && key === 'path' && unsafeRepositoryPath(child, allowRouteAbsolutePath)) {
      throw new GraphSnapshotError(failureCode, 'Graph properties contain an unsafe path');
    }
    assertSafeGraphProperties(child, failureCode);
  }
}

function assertStoredNodeStructure(
  node: StoredGraphValidationNode,
  repositories: ReadonlyMap<string, string>,
  failureCode: GraphContentFailureCode,
): void {
  assertSafeGraphProperties(
    node.properties,
    failureCode,
    node.type === NodeType.Route || node.type === NodeType.Entrypoint,
  );
  // Loose nullish check: repository nodes (and routes without a location)
  // carry `filePath: undefined`, not null — a strict `!== null` feeds
  // undefined into the guard and crashes every build.
  if (node.filePath != null && unsafeRepositoryPath(node.filePath)) {
    throw new GraphSnapshotError(failureCode, 'Graph node contains an unsafe source file path');
  }

  if (node.type === NodeType.Repository) {
    if (node.repoId !== null || repositories.get(node.id) !== node.name) {
      throw new GraphSnapshotError(failureCode, 'Graph repository node is outside the manifest identity set');
    }
    return;
  }
  if (!node.repoId || !repositories.has(node.repoId) || !node.id.startsWith(`${node.repoId}:`)) {
    throw new GraphSnapshotError(failureCode, 'Graph node is outside the manifest repository set');
  }
}

function assertTransformedComponent(
  transformed: ReturnType<typeof transformParsedRepo>,
  repoKey: string,
  repoName: string,
): void {
  const repositories = new Map([[repoKey, repoName]]);
  for (const node of transformed.nodes) {
    assertStoredNodeStructure(
      {
        id: node.id,
        type: node.type,
        name: node.name,
        properties: node.properties,
        repoId: node.repoId ?? null,
        filePath: node.filePath ?? null,
      },
      repositories,
      'artifact_integrity_error',
    );
  }
  for (const edge of transformed.edges) {
    assertSafeGraphProperties(edge.properties, 'artifact_integrity_error');
  }
}

async function assertStoredGraphStructure(
  repository: IGraphFileValidationRepository,
  manifest: GraphSnapshotManifestV1,
  failureCode: 'graph_build_failed' | 'graph_object_identity_conflict',
): Promise<{
  resolvesToEdges: StoredGraphValidationEdge[];
  resolvedTargetIds: ReadonlyMap<string, string | null>;
}> {
  const repositories = new Map(manifest.repositories.map(({ repoKey, repoName }) => [repoKey, repoName]));
  const seenRepositoryIds = new Set<string>();
  const resolvedTargetIds = new Map<string, string | null>();
  for await (const node of repository.scanStoredNodes()) {
    assertStoredNodeStructure(node, repositories, failureCode);
    if (node.type === NodeType.Repository) seenRepositoryIds.add(node.id);
    const hasResolvedTargetId = Object.hasOwn(node.properties, 'resolvedTargetId');
    if (node.type !== NodeType.ExternalCall && hasResolvedTargetId) {
      throw new GraphSnapshotError(failureCode, 'Only external-call nodes may carry resolvedTargetId');
    }
    if (node.type === NodeType.ExternalCall) {
      const targetId = node.properties.resolvedTargetId;
      if (hasResolvedTargetId && (typeof targetId !== 'string' || targetId.length === 0)) {
        throw new GraphSnapshotError(failureCode, 'External-call resolvedTargetId is malformed');
      }
      resolvedTargetIds.set(node.id, typeof targetId === 'string' ? targetId : null);
    }
  }
  if (seenRepositoryIds.size !== repositories.size) {
    throw new GraphSnapshotError(failureCode, 'Graph repository nodes differ from the manifest');
  }
  const resolvesToEdges: StoredGraphValidationEdge[] = [];
  for await (const edge of repository.scanStoredEdges()) {
    assertSafeGraphProperties(edge.properties, failureCode);
    if (edge.type === EdgeType.ResolvesTo) resolvesToEdges.push(edge);
  }
  return { resolvesToEdges, resolvedTargetIds };
}

function compareStoredResolutionEdge(
  left: Pick<StoredGraphValidationEdge, 'id' | 'sourceId' | 'targetId'>,
  right: Pick<StoredGraphValidationEdge, 'id' | 'sourceId' | 'targetId'>,
): number {
  const compare = (leftValue: string, rightValue: string): number =>
    leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  return compare(left.id, right.id) || compare(left.sourceId, right.sourceId) || compare(left.targetId, right.targetId);
}

/** Deterministic serializer for edge equality: sorted keys, finite floats allowed. */
function stableEdgeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableEdgeJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableEdgeJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Edge comparison encountered a non-finite number');
  }
  return JSON.stringify(value) ?? 'null';
}

function assertPersistedResolution(
  expectedProtocolEdges: readonly LinkEdge[],
  expectedPackageImportEdges: readonly (LinkEdge & { createdBy: 'cross-repo-linker' })[],
  stored: Awaited<ReturnType<typeof assertStoredGraphStructure>>,
  failureCode: 'graph_build_failed' | 'graph_object_identity_conflict',
): void {
  const expectedProtocol = expectedProtocolEdges.map(
    (edge): StoredGraphValidationEdge => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: EdgeType.ResolvesTo,
      confidence: edge.confidence,
      createdBy: 'ai',
      properties: edge.properties,
    }),
  );
  const expected = [
    ...expectedProtocol,
    ...expectedPackageImportEdges.map(
      (edge): StoredGraphValidationEdge => ({
        id: edge.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        type: EdgeType.ResolvesTo,
        confidence: edge.confidence,
        createdBy: 'ai',
        properties: { ...edge.properties, createdBy: edge.createdBy },
      }),
    ),
  ].sort(compareStoredResolutionEdge);
  const actual = [...stored.resolvesToEdges].sort(compareStoredResolutionEdge);
  let exactEdges = false;
  try {
    // NOT the manifest canonicalizer: that one deliberately rejects non-integer
    // numbers (manifest identity forbids floats), while resolution edges carry
    // float confidences — it would throw on every non-empty resolution and turn
    // a valid object into a permanent identity conflict.
    exactEdges = stableEdgeJson(actual) === stableEdgeJson(expected);
  } catch {
    // Malformed persisted JSON-like values are an identity conflict, never a
    // reason to accept an unverifiable canonical object.
  }
  if (!exactEdges) {
    throw new GraphSnapshotError(failureCode, 'Persisted RESOLVES_TO edges differ from pinned resolution');
  }

  const expectedTargets = new Map<string, string>();
  for (const edge of expectedProtocol) {
    if (expectedTargets.has(edge.sourceId)) {
      throw new GraphSnapshotError(failureCode, 'Pinned resolution has multiple targets for one external call');
    }
    expectedTargets.set(edge.sourceId, edge.targetId);
  }
  for (const [sourceId, actualTargetId] of stored.resolvedTargetIds) {
    if ((expectedTargets.get(sourceId) ?? null) !== actualTargetId) {
      throw new GraphSnapshotError(failureCode, 'Persisted resolvedTargetId differs from pinned resolution');
    }
  }
  if ([...expectedTargets.keys()].some((sourceId) => !stored.resolvedTargetIds.has(sourceId))) {
    throw new GraphSnapshotError(failureCode, 'Pinned resolution refers to a missing external-call node');
  }
}

async function assertFileExcludes(path: string, canaries: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
  if (canaries.size === 0) return;
  const matcher = new ByteMultiPatternMatcher([...canaries].map((value) => Buffer.from(value, 'utf8')));
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    if (matcher.push(chunk)) {
      throw new GraphSnapshotError('graph_build_failed', 'Built graph failed the source-stripping scan');
    }
  }
}

@Injectable()
export class GraphSnapshotBuildService {
  private readonly logger = new Logger(GraphSnapshotBuildService.name);
  private readonly componentMaxBytes = DEFAULT_COMPONENT_MAX_BYTES;
  private readonly buildRoot: string;

  constructor(
    private readonly r2: R2StorageService,
    buildRoot?: string,
    /** Idle storage-transfer window; only tests shorten it. */
    private readonly storageTimeoutMs = DEFAULT_STORAGE_TIMEOUT_MS,
  ) {
    this.buildRoot =
      buildRoot ?? configFromEnv().storage.graphSnapshot.buildRoot ?? join(tmpdir(), 'coredoc-graph-snapshot-builds');
  }

  async materialize(
    manifestInput: unknown,
    expectedVersionId: string,
    workerSignal?: AbortSignal,
  ): Promise<MaterializedGraphSnapshot> {
    const identity = createGraphSnapshotIdentity(manifestInput);
    if (identity.versionId !== expectedVersionId || !hasCurrentGraphSnapshotCompatibility(identity.manifest)) {
      throw new GraphSnapshotError('artifact_identity_conflict', 'Candidate manifest identity is incompatible');
    }
    const graphKey = graphSnapshotR2Key(identity.manifest.workspaceId, identity.versionId);

    // Canonicalization validates every repository/mapper key before this first
    // object-store request, including traversal-shaped in-prefix keys.
    for (const repository of identity.manifest.repositories) {
      assertWorkspaceScopedR2Key(identity.manifest.workspaceId, repository.parsed.r2Key);
      if (repository.summary) assertWorkspaceScopedR2Key(identity.manifest.workspaceId, repository.summary.r2Key);
      if (repository.embeddings) {
        assertWorkspaceScopedR2Key(identity.manifest.workspaceId, repository.embeddings.r2Key);
      }
    }
    if (identity.manifest.mapper) {
      assertWorkspaceScopedR2Key(identity.manifest.workspaceId, identity.manifest.mapper.r2Key);
    }

    await mkdir(this.buildRoot, { recursive: true });
    const privateDir = await mkdtemp(join(this.buildRoot, `${identity.manifest.workspaceId}-`));
    try {
      const existing = await this.storageOperation(workerSignal, (signal) => this.r2.headObject(graphKey, { signal }));
      if (existing) {
        const canaries = new SensitiveCanarySet();
        const repositoryCounts = await this.repositoryCounts(identity.manifest, workerSignal, canaries);
        const recovered = await this.verifyExistingObject(
          identity.manifest,
          identity.versionId,
          graphKey,
          existing,
          join(privateDir, 'recovered.ladybug'),
          workerSignal,
          canaries,
        );
        recovered.repositoryCounts = repositoryCounts;
        return recovered;
      }

      const mapper = await this.loadMapper(identity.manifest.workspaceId, identity.manifest.mapper, workerSignal);
      const canaries = new SensitiveCanarySet();
      const repositoryCounts: Record<string, { nodeCount: number; edgeCount: number }> = {};
      let resolution: PinnedResolutionMetrics | null = null;
      const artifactPath = join(privateDir, 'graph.ladybug');
      let buildResult: GraphFileBuildResult;
      try {
        buildResult = await buildGraphFile({
          outputPath: artifactPath,
          workDir: join(privateDir, 'work'),
          components: this.components(identity.manifest, canaries, workerSignal),
          onComponentTransformed: this.componentInspector(identity.manifest, repositoryCounts),
          signal: workerSignal,
          beforeFinalize: async (repository, signal) => {
            resolution = await resolvePinnedCandidate(
              repository,
              identity.manifest.repositories.map(({ repoKey, repoName, httpPrefix }) => ({
                repoKey,
                repoName,
                httpPrefix,
              })),
              mapper,
              signal,
            );
          },
        });
      } catch (error) {
        if (error instanceof GraphSnapshotError || workerSignal?.aborted) throw error;
        // The public job result deliberately carries only the safe wrapper
        // message; without this log line the real build failure is invisible
        // everywhere. Message + stack only — never component payloads.
        this.logger.error(
          `Graph snapshot build failed for version ${expectedVersionId}: ${(error as Error)?.message}`,
          (error as Error)?.stack,
        );
        throw new GraphSnapshotError('graph_build_failed', 'Failed to build the pinned graph candidate', {
          cause: error,
        });
      }

      await assertFileExcludes(artifactPath, canaries, workerSignal);
      const digest = await hashFile(artifactPath, GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES, workerSignal);
      if (digest.sizeBytes !== buildResult.fileSizeBytes) {
        throw new GraphSnapshotError('graph_build_failed', 'Builder-reported size differs from the finalized file');
      }
      await this.validateGraphFile(artifactPath, identity.manifest, 'graph_build_failed', canaries, workerSignal);

      const localArtifact: MaterializedGraphSnapshot = {
        r2Key: graphKey,
        sha256: digest.sha256,
        sizeBytes: digest.sizeBytes,
        resolution,
        repositoryCounts,
      };
      try {
        const outcome = await this.storageOperation(
          workerSignal,
          (signal) =>
            this.r2.putFileIfAbsent(graphKey, artifactPath, {
              contentLength: digest.sizeBytes,
              contentType: 'application/vnd.coredoc.ladybug',
              metadata: {
                sha256: digest.sha256,
                sizebytes: String(digest.sizeBytes),
                versionid: identity.versionId,
                workspaceid: identity.manifest.workspaceId,
                engine: identity.manifest.engine,
                engineversion: identity.manifest.engineVersion,
                schemaversion: String(identity.manifest.graphSchemaVersion),
                builderversion: identity.manifest.builderVersion,
                storageformatversion: String(identity.manifest.storageFormatVersion),
              },
              signal,
            }),
          { expectedBytes: digest.sizeBytes },
        );
        if (outcome === 'created') return localArtifact;
      } catch (error) {
        const ambiguousTimeout = error instanceof GraphSnapshotError && error.code === 'graph_storage_timeout';
        if (!(error instanceof StorageConditionalWriteError) && !ambiguousTimeout) throw error;
      }

      const recoveredHead = await this.storageOperation(workerSignal, (signal) =>
        this.r2.headObject(graphKey, { signal }),
      );
      if (!recoveredHead) {
        throw new GraphSnapshotError('graph_storage_timeout', 'Conditional graph publication did not converge');
      }
      const recovered = await this.verifyExistingObject(
        identity.manifest,
        identity.versionId,
        graphKey,
        recoveredHead,
        join(privateDir, 'canonical.ladybug'),
        workerSignal,
        canaries,
      );
      return {
        ...recovered,
        repositoryCounts: localArtifact.repositoryCounts,
      };
    } finally {
      await rm(privateDir, { recursive: true, force: true });
    }
  }

  private async *components(
    manifest: GraphSnapshotManifestV1,
    canaries: Set<string>,
    signal?: AbortSignal,
  ): AsyncGenerator<{
    parsedRepo: ParsedRepo;
    summaryOutput: SummaryOutput | null;
    embeddingsOutput: EmbeddingsOutput | null;
  }> {
    for (const repository of manifest.repositories) {
      signal?.throwIfAborted();
      const parsedRepo = await this.readVerifiedJson<ParsedRepo>(repository.parsed, signal);
      if (parsedRepo.id !== repository.repoKey || parsedRepo.name !== repository.repoName) {
        throw new GraphSnapshotError('artifact_identity_conflict', 'Parsed artifact repository identity differs');
      }
      const summaryOutput = repository.summary
        ? await this.readVerifiedJson<SummaryOutput>(repository.summary, signal)
        : null;
      if (
        summaryOutput &&
        (summaryOutput.repoId !== repository.repoKey || summaryOutput.repoName !== repository.repoName)
      ) {
        throw new GraphSnapshotError('artifact_identity_conflict', 'Summary artifact repository identity differs');
      }
      const embeddingsOutput = repository.embeddings
        ? await this.readVerifiedJson<EmbeddingsOutput>(repository.embeddings, signal)
        : null;
      if (
        embeddingsOutput &&
        (embeddingsOutput.repoId !== repository.repoKey || embeddingsOutput.repoName !== repository.repoName)
      ) {
        throw new GraphSnapshotError('artifact_identity_conflict', 'Embeddings artifact repository identity differs');
      }

      // Collect bounded high-entropy source canaries, the repository root, and
      // unsafe filesystem fields before the cloud-blind builder strips them.
      // Route paths are graph data; structural validation below distinguishes
      // them from filesystem paths and rejects forbidden fields of any length.
      // `path` is the repo's local filesystem root; the CLI redacts it before
      // upload, so server-side artifacts legitimately arrive without it.
      if (
        typeof parsedRepo.path === 'string' &&
        unsafeRepositoryPath(parsedRepo.path) &&
        parsedRepo.path.length >= 12
      ) {
        canaries.add(parsedRepo.path);
      }
      collectSensitiveCanaries(parsedRepo, canaries);
      if (embeddingsOutput) collectSensitiveCanaries(embeddingsOutput, canaries);
      yield { parsedRepo, summaryOutput, embeddingsOutput };
    }
  }

  /**
   * Structural validation and counting for the transformed component the
   * builder is about to write. Handed to `buildGraphFile` so the objects
   * validated here are the objects that land in the file — transforming a
   * second, independently derived copy would both double the cost and hide
   * any divergence between what was checked and what was written.
   */
  private componentInspector(
    manifest: GraphSnapshotManifestV1,
    repositoryCounts: Record<string, { nodeCount: number; edgeCount: number }>,
  ): (transformed: ReturnType<typeof transformParsedRepo>) => void {
    const repoNames = new Map(manifest.repositories.map(({ repoKey, repoName }) => [repoKey, repoName]));
    return (transformed) => {
      const repoName = repoNames.get(transformed.repositoryId);
      if (repoName === undefined) {
        throw new GraphSnapshotError(
          'artifact_integrity_error',
          'Transformed component is outside the manifest repository set',
        );
      }
      if (transformed.duplicateNodeIds.length > 0) {
        this.logger.warn(
          `Deduplicated repeated node ids in ${repoName} while assembling a graph snapshot: ` +
            transformed.duplicateNodeIds.slice(0, 5).join(', '),
        );
      }
      assertTransformedComponent(transformed, transformed.repositoryId, repoName);
      repositoryCounts[transformed.repositoryId] = {
        nodeCount: transformed.nodes.length,
        edgeCount: transformed.edges.length,
      };
    };
  }

  /**
   * Recovery path only (the graph object already exists, so no builder runs).
   * This is the one place that must strip and transform on its own; the build
   * path gets the same inspection through `onComponentTransformed`.
   */
  private async repositoryCounts(
    manifest: GraphSnapshotManifestV1,
    workerSignal?: AbortSignal,
    canaries = new SensitiveCanarySet(),
  ): Promise<Readonly<Record<string, { nodeCount: number; edgeCount: number }>>> {
    const counts: Record<string, { nodeCount: number; edgeCount: number }> = {};
    const inspect = this.componentInspector(manifest, counts);
    for await (const component of this.components(manifest, canaries, workerSignal)) {
      const strippedParsed = stripSourceCode(component.parsedRepo).parsed;
      const strippedEmbeddings = component.embeddingsOutput
        ? stripEmbeddingInputText(component.embeddingsOutput).embeddings
        : null;
      inspect(transformParsedRepo(strippedParsed, component.summaryOutput, strippedEmbeddings));
    }
    return counts;
  }

  private async readVerifiedJson<T>(
    descriptor: WorkspaceRepoArtifactDescriptor,
    workerSignal?: AbortSignal,
  ): Promise<T> {
    const expected = expectedSize(descriptor);
    if (expected > this.componentMaxBytes) {
      throw new GraphSnapshotError('artifact_integrity_error', 'Component exceeds the configured size limit');
    }

    const streamed = await this.storageOperation(
      workerSignal,
      async (signal, progress) => {
        const stream = await this.r2.downloadStream(descriptor.r2Key, { signal });
        if (!stream) throw new GraphSnapshotError('artifact_identity_conflict', 'Pinned component object is missing');
        return streamToBuffer(stream, signal, Math.min(expected, this.componentMaxBytes), progress);
      },
      { expectedBytes: expected, trackProgress: true },
    );
    if (streamed.digest.sizeBytes !== expected || streamed.digest.sha256 !== descriptor.sha256) {
      throw new GraphSnapshotError('artifact_integrity_error', 'Pinned component bytes differ from the descriptor');
    }

    try {
      return JSON.parse(streamed.body.toString('utf8')) as T;
    } catch (error) {
      throw new GraphSnapshotError('artifact_integrity_error', 'Pinned component is not valid JSON', { cause: error });
    }
  }

  private async loadMapper(
    workspaceId: string,
    descriptor: GraphSnapshotMapperDescriptor | null,
    workerSignal?: AbortSignal,
  ): Promise<Mapper> {
    if (!descriptor) return EMPTY_MAPPER;
    const artifact: WorkspaceRepoArtifactDescriptor = {
      workspaceId,
      repoKey: '__mapper__',
      repoName: '__mapper__',
      kind: 'parsed',
      version: descriptor.sha256.slice(0, 16),
      ...descriptor,
    };
    const parsed = await this.readVerifiedJson<unknown>(artifact, workerSignal);
    const validation = validateMapper(parsed);
    if (!validation.ok) {
      throw new GraphSnapshotError('artifact_integrity_error', 'Pinned mapper failed schema validation');
    }
    return validation.mapper;
  }

  private async verifyExistingObject(
    manifest: GraphSnapshotManifestV1,
    versionId: string,
    graphKey: string,
    head: StorageObjectHead,
    localPath: string,
    workerSignal?: AbortSignal,
    canaries: ReadonlySet<string> = new Set(),
  ): Promise<MaterializedGraphSnapshot> {
    if (head.contentLength !== null && !graphSnapshotArtifactSizeWithinLimit(head.contentLength)) {
      throw new GraphSnapshotError('graph_object_identity_conflict', 'Existing graph object exceeds the size limit');
    }
    const digest = await this.storageOperation(
      workerSignal,
      async (signal, progress) => {
        const source = await this.r2.downloadStream(graphKey, { signal });
        if (!source)
          throw new GraphSnapshotError('graph_object_identity_conflict', 'Existing graph object disappeared');
        return streamToFile(
          source,
          localPath,
          signal,
          GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES,
          'graph_object_identity_conflict',
          progress,
        );
      },
      {
        expectedBytes: head.contentLength ?? GRAPH_SNAPSHOT_MAX_ARTIFACT_BYTES,
        trackProgress: true,
      },
    );

    const metadataExpected: Readonly<Record<string, string>> = {
      sha256: digest.sha256,
      sizebytes: String(digest.sizeBytes),
      versionid: versionId,
      workspaceid: manifest.workspaceId,
      engine: manifest.engine,
      engineversion: manifest.engineVersion,
      schemaversion: String(manifest.graphSchemaVersion),
      builderversion: manifest.builderVersion,
      storageformatversion: String(manifest.storageFormatVersion),
    };
    if (
      (head.contentLength !== null && head.contentLength !== digest.sizeBytes) ||
      Object.entries(metadataExpected).some(([key, value]) => storageMetadata(head, key) !== value)
    ) {
      throw new GraphSnapshotError('graph_object_identity_conflict', 'Existing graph object identity differs');
    }
    await assertFileExcludes(localPath, canaries, workerSignal).catch((error) => {
      if (error instanceof GraphSnapshotError && error.code === 'graph_build_failed') {
        throw new GraphSnapshotError('graph_object_identity_conflict', 'Existing graph violates source policy', {
          cause: error,
        });
      }
      throw error;
    });
    const resolution = await this.validateGraphFile(
      localPath,
      manifest,
      'graph_object_identity_conflict',
      canaries,
      workerSignal,
      true,
    );
    return {
      r2Key: graphKey,
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
      resolution,
      repositoryCounts: {},
    };
  }

  private async validateGraphFile(
    path: string,
    manifest: GraphSnapshotManifestV1,
    failureCode: 'graph_build_failed' | 'graph_object_identity_conflict',
    canaries: ReadonlySet<string>,
    workerSignal?: AbortSignal,
    deriveResolution = false,
  ): Promise<PinnedResolutionMetrics | null> {
    let close: (() => Promise<void>) | undefined;
    try {
      const handle = await openGraphFile({
        path,
        budgets: {
          maxDbSizeBytes: LADYBUG_VALIDATION_MAX_DB_BYTES,
          bufferPoolBytes: READ_VALIDATION_BUFFER_BYTES,
          queryTimeoutMs: 30_000,
        },
      });
      close = () => handle.close();
      const list = await handle.repository.listAllRepositories();
      const actual = list.map(({ hash, name }) => `${hash}\0${name}`).sort();
      const expected = manifest.repositories.map(({ repoKey, repoName }) => `${repoKey}\0${repoName}`).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new GraphSnapshotError(failureCode, 'Graph repository set differs from manifest');
      }
      const storedGraph = await assertStoredGraphStructure(handle.repository, manifest, failureCode);
      if (
        canaries.size > 0 &&
        (await handle.repository.containsNodeText(
          [...canaries],
          manifest.repositories.map(({ repoKey }) => repoKey),
        ))
      ) {
        throw new GraphSnapshotError(failureCode, 'Graph logical content violates the source policy');
      }
      if (!deriveResolution) return null;
      const mapper = await this.loadMapper(manifest.workspaceId, manifest.mapper, workerSignal);
      const computation = await computePinnedResolution(
        handle.repository,
        manifest.repositories.map(({ repoKey, repoName, httpPrefix }) => ({ repoKey, repoName, httpPrefix })),
        mapper,
        workerSignal,
      );
      assertPersistedResolution(
        computation.result.edges,
        computation.result.packageImportEdges ?? [],
        storedGraph,
        failureCode,
      );
      return {
        resolved: computation.result.metrics.resolved,
        total: computation.result.metrics.total,
        rate: computation.result.metrics.rate,
        legacyEdges: 0,
      };
    } catch (error) {
      if (error instanceof GraphSnapshotError) throw error;
      // Same rule as the build wrapper: the public result carries only the
      // safe message, so without this line the real validation failure is
      // invisible everywhere. Message + stack only.
      this.logger.error(`Graph object schema validation failed: ${(error as Error)?.message}`, (error as Error)?.stack);
      throw new GraphSnapshotError(failureCode, 'Graph object schema validation failed', {
        cause: error,
      });
    } finally {
      await close?.();
    }
  }

  private async storageOperation<T>(
    workerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal, progress: () => void) => Promise<T>,
    options: StorageOperationOptions = {},
  ): Promise<T> {
    workerSignal?.throwIfAborted();
    const deadline = new AbortController();
    let deadlineExpired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      if (deadline.signal.aborted) return;
      deadlineExpired = true;
      deadline.abort(Object.assign(new Error('Graph storage deadline exceeded'), { name: 'TimeoutError' }));
    };
    const hardTimer = setTimeout(expire, storageHardTimeoutMs(this.storageTimeoutMs, options.expectedBytes));
    const progress = () => {
      if (!options.trackProgress || deadline.signal.aborted) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(expire, this.storageTimeoutMs);
    };
    progress();
    const signal = workerSignal ? AbortSignal.any([workerSignal, deadline.signal]) : deadline.signal;
    const abort = abortPromise(signal);
    try {
      return await Promise.race([Promise.resolve().then(() => operation(signal, progress)), abort.promise]);
    } catch (error) {
      if (workerSignal?.aborted) throw workerSignal.reason;
      if (deadlineExpired) {
        throw new GraphSnapshotError('graph_storage_timeout', 'Graph storage operation exceeded its deadline', {
          cause: error,
        });
      }
      // A raw transport error (ECONNRESET mid-download, DNS blip) is NOT a
      // build failure: escaping unwrapped, it lands in materialize's blanket
      // graph_build_failed — retryable:false — and one socket reset
      // permanently fails the job. Conditional-write conflicts keep their
      // type: the caller's recovery path depends on recognizing them.
      if (!(error instanceof GraphSnapshotError) && !(error instanceof StorageConditionalWriteError)) {
        throw new GraphSnapshotError('graph_storage_unavailable', 'Graph storage operation failed', { cause: error });
      }
      throw error;
    } finally {
      abort.cleanup();
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }
}
