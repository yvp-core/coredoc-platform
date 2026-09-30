/**
 * Push Service
 *
 * Handles pushing parsed repo data to a workspace's Turso database.
 * Supports guarded full rebuilds and incremental push (version-reference based).
 * Implements advisory locking to serialize concurrent pushes to the same repo.
 */

import { Injectable, ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { WorkspaceDbPoolService } from '../../database/workspace-db-pool.service.js';
import {
  ResultStorageService,
  type UploadResultResponse,
  type UploadSummaryResponse,
  type UploadEmbeddingsResponse,
  type DownloadSummaryResult,
} from './result-storage.service.js';
import { DiffEngine } from './diff-engine.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';
import {
  ResolverService,
  type ResolutionExecutionOptions,
  type ResolutionMetrics,
} from '../mapper/resolver.service.js';
import type { ParsedRepo, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';
import {
  GraphApplyMode,
  containsSourceCode,
  embeddingsContainInputText,
  ensureGraphIndexes,
  getConfiguredBackend,
  normalizeMetadataForParsedRepo,
  type AppliedGraphSnapshot,
  type BatchProgress,
  type GraphApplyReceipt,
  type GraphSnapshotInput,
  type IGraphRepository,
  type NodeMetadataUpdate,
} from '@coredoc/db';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { PushLeaseService, type DistributedLease } from '../lease/push-lease.service.js';
import { ProgressUnit, PushJobPhase, type PushExecutionContext } from '../../libs/pipeline/push-execution.types.js';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import { GraphBackend, resolveGraphBackend } from '../../database/graph-backend.js';
import { GraphSnapshotControlPlaneService } from '../graph-snapshot/graph-snapshot-control-plane.service.js';

// =============================================================================
// Types
// =============================================================================

export interface IncrementalPushResult {
  repoName: string;
  mode: 'incremental' | 'full';
  nodesAdded: number;
  nodesUpdated: number;
  nodesDeleted: number;
  edgesDeleted: number;
  edgesInserted: number;
  unchanged: number;
  version: string;
  totalNodeCount: number;
  totalEdgeCount: number;
  /**
   * Cross-repo resolution metrics from the post-push resolver run. Either the
   * resolver's metrics or an `{ error }` object if resolution failed (the push
   * itself still succeeded — see PushService.pushByVersion for the trade-off).
   */
  resolution?: ResolutionMetrics | { error: string };
}

/**
 * Metadata has three states at the service boundary: an explicit version is
 * included, an explicit exclusion is skipped, and an omitted value preserves
 * the manifest-current artifact when the graph changes.
 */
export interface PushMetadataExclusions {
  excludeSummaries?: boolean;
  excludeEmbeddings?: boolean;
}

type AtomicChangeset = Parameters<NonNullable<IGraphRepository['applyChangeset']>>[0];

// =============================================================================
// Service
// =============================================================================

/**
 * libsql/Turso connection-level failure codes (per-workspace SQLite data
 * plane). When matched, the caller evicts the pooled connection so the next
 * operation gets a fresh client. Matched on LibsqlError.code, NOT message substrings: workspace DBs
 * are provisioned as libsql:// URLs, which the client serves over
 * Hrana-WebSocket — those failures surface as HRANA_* codes that no message
 * pattern for the HTTP transport would catch, silently bypassing the
 * ambiguous-commit reconciliation.
 */
const LIBSQL_CONNECTION_ERROR_CODES = new Set([
  'SERVER_ERROR',
  'TRANSACTION_CLOSED',
  'CLIENT_CLOSED',
  'HRANA_WEBSOCKET_ERROR',
  'HRANA_CLOSED_ERROR',
  'HRANA_PROTO_ERROR',
]);

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Raw undici failure (no LibsqlError wrapper) from the HTTP transport, and
  // errors re-wrapped by intermediate layers that preserve only the message
  // (LibsqlError prefixes its code into the message).
  const msg = err.message;
  if (msg === 'fetch failed' || msg.includes('TRANSACTION_CLOSED') || msg.includes('SERVER_ERROR')) {
    return true;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && LIBSQL_CONNECTION_ERROR_CODES.has(code)) return true;
  // Neo4j bolt failures (on-prem shared graph). A pooled connection dropped while
  // idle surfaces as ServiceUnavailable ("Connection was closed by server" /
  // "Failed to connect to server"); a lost routing/connection surfaces as
  // SessionExpired. Both are retriable and every graph write in the push path is
  // MERGE-idempotent, so reconnecting and re-running is safe.
  return code === 'ServiceUnavailable' || code === 'SessionExpired';
}

function assertMetadataIdentity(
  kind: 'Summary' | 'Embeddings',
  artifact: SummaryOutput | EmbeddingsOutput,
  parsedRepo: ParsedRepo,
): void {
  if (artifact.repoId === parsedRepo.id && artifact.repoName === parsedRepo.name) return;
  throw new BadRequestException(
    `${kind} artifact belongs to repo "${artifact.repoName}" (${artifact.repoId}), ` +
      `not "${parsedRepo.name}" (${parsedRepo.id}).`,
  );
}

function remoteRebuildCommand(workspaceId: string, repoName: string): string {
  return `coredoc push ${repoName} --remote --workspace-id ${workspaceId} --rebuild`;
}

function snapshotMatches(
  snapshot: AppliedGraphSnapshot | null,
  parsedVersion: string,
  summaryVersion: string | null,
  embeddingsVersion: string | null,
  commitSha: string | null,
): snapshot is AppliedGraphSnapshot {
  return (
    snapshot?.parsedVersion === parsedVersion &&
    snapshot.summaryVersion === summaryVersion &&
    snapshot.embeddingsVersion === embeddingsVersion &&
    snapshot.commitSha === commitSha
  );
}

/**
 * Identity comparison for reconciliation: "is the stored snapshot still the
 * exact write I observed before attempting mine?" Field-wise on the
 * identifying columns — whole-object JSON equality would flip on any
 * serialization/shape change across a deploy and misclassify a safe retry as
 * a conflict.
 */
function snapshotEquals(a: AppliedGraphSnapshot | null, b: AppliedGraphSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.parsedVersion === b.parsedVersion && a.executionToken === b.executionToken && a.appliedAt === b.appliedAt;
}

function resultFromSnapshot(repoName: string, snapshot: AppliedGraphSnapshot): IncrementalPushResult {
  return {
    repoName,
    mode: snapshot.mode === GraphApplyMode.Full ? 'full' : 'incremental',
    ...snapshot.receipt,
    // The per-file unchanged count is not persisted in the snapshot; 0 keeps
    // the public field in its documented non-negative domain on resume.
    unchanged: 0,
    version: snapshot.parsedVersion,
    totalNodeCount: snapshot.nodeCount,
    totalEdgeCount: snapshot.edgeCount,
  };
}

async function buildMetadataUpdates(
  parsedRepo: ParsedRepo,
  summaryOutput: SummaryOutput | null,
  embeddingsOutput: EmbeddingsOutput | null,
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<NodeMetadataUpdate[]> {
  if (!summaryOutput && !embeddingsOutput) return [];
  const { transformParsedRepo } = await import('@coredoc/db');
  const graph = transformParsedRepo(parsedRepo, summaryOutput, embeddingsOutput);
  const targetIds = new Set<string>();
  if (summaryOutput?.repositorySummary) targetIds.add(summaryOutput.repoId);
  for (const summary of summaryOutput?.summaries ?? []) targetIds.add(summary.functionId);
  for (const summary of summaryOutput?.packageSummaries ?? []) targetIds.add(summary.packageId);
  for (const embedding of embeddingsOutput?.functions ?? []) targetIds.add(embedding.functionId);
  for (const embedding of embeddingsOutput?.endpoints ?? []) targetIds.add(embedding.endpointId);

  return graph.nodes
    .filter((node) => targetIds.has(node.id) && !excludeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      ...(node.summary !== undefined ? { summary: node.summary } : {}),
      ...(node.embedding !== undefined ? { embedding: node.embedding } : {}),
      properties: node.properties,
    }));
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  /**
   * Advisory locks: Set of "workspaceId:repoName" keys currently being pushed.
   * TODO: Replace with a distributed lock (Redis or DB advisory lock) when running
   * multiple server instances, as this in-memory Set only protects within a single process.
   */
  private readonly activePushes = new Set<string>();

  /**
   * Memoized graph-index readiness. Ensured once per process before the first
   * Neo4j write (see ensureGraphIndexesOnce). null until first attempt; holds
   * the in-flight/resolved promise on success, reset to null on failure so a
   * later push retries.
   */
  private graphIndexesReady: Promise<void> | null = null;

  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly workspaceDbPool: WorkspaceDbPoolService,
    private readonly resultStorage: ResultStorageService,
    private readonly diffEngine: DiffEngine,
    private readonly metricsService: MetricsService,
    private readonly telemetryService: TelemetryService,
    private readonly resolverService: ResolverService,
    private readonly pushLeases: PushLeaseService,
    private readonly graphSnapshotControlPlane: GraphSnapshotControlPlaneService,
  ) {}

  async getWorkspaceGraphBackend(workspaceId: string): Promise<GraphBackend> {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace not found');
    return resolveGraphBackend(workspace);
  }

  /**
   * Upload a ParsedRepo to R2 versioned storage.
   * Content-addressed: same content = same version = no-op.
   */
  async uploadResult(workspaceId: string, repoName: string, parsedRepo: ParsedRepo): Promise<UploadResultResponse> {
    // Fail-closed by default: reject any push carrying source. On-prem operators
    // opt in via ALLOW_SOURCES_IN_GRAPH to store source server-side (they own the
    // infra); SaaS leaves it unset so source never lands here.
    if (!allowSourcesInGraph() && containsSourceCode(parsedRepo)) {
      throw new BadRequestException(
        `Parse result for repo "${repoName}" contains sourceCode fields and cannot be uploaded.`,
      );
    }
    await this.graphSnapshotControlPlane.resolveArtifactRepository(workspaceId, repoName);
    const uploaded = await this.resultStorage.uploadResult(workspaceId, repoName, parsedRepo);
    await this.graphSnapshotControlPlane.registerArtifact({
      workspaceId,
      repoName,
      kind: 'parsed',
      version: uploaded.version,
      r2Key: uploaded.r2Key,
      sha256: uploaded.sha256,
      sizeBytes: uploaded.sizeBytes,
    });
    return uploaded;
  }

  /**
   * Upload a SummaryOutput to R2 versioned storage.
   * Protected by advisory lock to prevent manifest race conditions.
   */
  async uploadSummary(
    workspaceId: string,
    repoName: string,
    summaryOutput: SummaryOutput,
  ): Promise<UploadSummaryResponse> {
    await this.graphSnapshotControlPlane.resolveArtifactRepository(workspaceId, repoName);
    const lockKey = `${workspaceId}:${repoName}`;

    if (this.activePushes.has(lockKey)) {
      throw new ConflictException(`Push already in progress for repo "${repoName}" in this workspace`);
    }
    this.activePushes.add(lockKey);
    const ownerToken = randomUUID();
    let lease: DistributedLease | null = null;
    let renewal: ReturnType<typeof setInterval> | null = null;
    let leaseError: Error | null = null;

    try {
      lease = await this.pushLeases.acquireRepository(workspaceId, repoName, ownerToken);
      renewal = this.pushLeases.startRenewal(
        () => this.pushLeases.renewRepository(workspaceId, repoName, lease!),
        (err) => {
          leaseError = err;
        },
      );
      const response = await this.resultStorage.uploadSummary(workspaceId, repoName, summaryOutput);
      if (leaseError) throw leaseError;
      await this.graphSnapshotControlPlane.registerArtifact({
        workspaceId,
        repoName,
        kind: 'summary',
        version: response.version,
        r2Key: response.r2Key,
        sha256: response.sha256,
        sizeBytes: response.sizeBytes,
      });
      return response;
    } finally {
      if (renewal) clearInterval(renewal);
      if (lease) await this.pushLeases.releaseRepository(workspaceId, repoName, lease).catch(() => {});
      this.activePushes.delete(lockKey);
    }
  }

  /**
   * Upload an EmbeddingsOutput to R2 versioned storage.
   * Protected by advisory lock to prevent manifest race conditions.
   */
  async uploadEmbeddings(
    workspaceId: string,
    repoName: string,
    embeddingsOutput: EmbeddingsOutput,
  ): Promise<UploadEmbeddingsResponse> {
    // Fail-closed by default: embeddings carry their `inputText`, which is raw
    // source when built with `-i source|both`. The client strips it before
    // upload; reject here as defense-in-depth so a stale/misbehaving client
    // can't persist source. On-prem operators opt in via ALLOW_SOURCES_IN_GRAPH.
    // Note: containsSourceCode does not catch this — the source rides in a value,
    // not under a `sourceCode` key.
    if (!allowSourcesInGraph() && embeddingsContainInputText(embeddingsOutput)) {
      throw new BadRequestException(`Embeddings for repo "${repoName}" contain raw inputText and cannot be uploaded.`);
    }
    await this.graphSnapshotControlPlane.resolveArtifactRepository(workspaceId, repoName);
    const lockKey = `${workspaceId}:${repoName}`;

    if (this.activePushes.has(lockKey)) {
      throw new ConflictException(`Push already in progress for repo "${repoName}" in this workspace`);
    }
    this.activePushes.add(lockKey);
    const ownerToken = randomUUID();
    let lease: DistributedLease | null = null;
    let renewal: ReturnType<typeof setInterval> | null = null;
    let leaseError: Error | null = null;

    try {
      lease = await this.pushLeases.acquireRepository(workspaceId, repoName, ownerToken);
      renewal = this.pushLeases.startRenewal(
        () => this.pushLeases.renewRepository(workspaceId, repoName, lease!),
        (err) => {
          leaseError = err;
        },
      );
      const response = await this.resultStorage.uploadEmbeddings(workspaceId, repoName, embeddingsOutput);
      if (leaseError) throw leaseError;
      await this.graphSnapshotControlPlane.registerArtifact({
        workspaceId,
        repoName,
        kind: 'embeddings',
        version: response.version,
        r2Key: response.r2Key,
        sha256: response.sha256,
        sizeBytes: response.sizeBytes,
      });
      return response;
    } finally {
      if (renewal) clearInterval(renewal);
      if (lease) await this.pushLeases.releaseRepository(workspaceId, repoName, lease).catch(() => {});
      this.activePushes.delete(lockKey);
    }
  }

  /**
   * Get the latest summary for a repo from R2 storage.
   */
  async getLatestSummary(workspaceId: string, repoName: string): Promise<DownloadSummaryResult | null> {
    return this.resultStorage.downloadLatestSummary(workspaceId, repoName);
  }

  /**
   * Get a presigned URL for the latest summary (avoids proxying data through server).
   * Returns null if R2 is not configured (local dev) or no summary exists.
   */
  async getLatestSummaryUrl(
    workspaceId: string,
    repoName: string,
  ): Promise<{ url: string; version: string; uploadedAt: string } | null> {
    return this.resultStorage.getLatestSummaryUrl(workspaceId, repoName);
  }

  /**
   * Push by version reference — the new incremental flow.
   *
   * 1. Read manifest to get previous version
   * 2. Download old + new ParsedRepo from R2
   * 3. Compute diff → apply changeset
   * 4. Refuse unsafe/missing baselines; replace only on verified first push or explicit rebuild
   * 5. Update manifest
   */
  async pushByVersion(
    workspaceId: string,
    repoName: string,
    parsedVersion: string,
    commitSha: string | null,
    userId: string,
    summaryVersion?: string,
    embeddingsVersion?: string,
    deferResolution = false,
    rebuild = false,
    metadataExclusions: PushMetadataExclusions = {},
    executionContext?: PushExecutionContext,
  ): Promise<IncrementalPushResult> {
    if (metadataExclusions.excludeSummaries && summaryVersion) {
      throw new BadRequestException('summaryVersion cannot be combined with excludeSummaries');
    }
    if (metadataExclusions.excludeEmbeddings && embeddingsVersion) {
      throw new BadRequestException('embeddingsVersion cannot be combined with excludeEmbeddings');
    }

    const lockKey = `${workspaceId}:${repoName}`;

    if (this.activePushes.has(lockKey)) {
      throw new ConflictException(`Push already in progress for repo "${repoName}" in this workspace`);
    }
    this.activePushes.add(lockKey);
    const executionToken = executionContext?.executionToken ?? randomUUID();
    const leaseOwnerToken = executionContext?.leaseOwnerToken ?? randomUUID();
    const leaseAbort = new AbortController();
    const abortFromCaller = () => leaseAbort.abort(executionContext?.signal?.reason);
    executionContext?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const report: PushExecutionContext['report'] = (phase, completed, total, unit) => {
      leaseAbort.signal.throwIfAborted();
      executionContext?.report(phase, completed, total, unit);
    };
    let repoLease: DistributedLease | null = null;
    let repoLeaseRenewal: ReturnType<typeof setInterval> | null = null;
    // Track acquisition so the finally block only releases what we leased.
    // Without this, an early throw (workspace not found, no DB) would call
    // release on a workspace we never acquired — currently a no-op, but
    // fragile to future refcount changes.
    let leasedWorkspaceId: string | null = null;

    try {
      repoLease = await this.pushLeases.acquireRepository(workspaceId, repoName, leaseOwnerToken);
      repoLeaseRenewal = this.pushLeases.startRenewal(
        () => this.pushLeases.renewRepository(workspaceId, repoName, repoLease!),
        (err) => leaseAbort.abort(err),
      );
      report(PushJobPhase.LoadingArtifacts);
      const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
      if (!workspace) throw new NotFoundException('Workspace not found');

      // The route uses the human-readable repo name for its R2 namespace, but
      // graph deletion must use the unique control-plane repoKey. Resolve that
      // binding before downloading or mutating anything and fail closed when a
      // legacy workspace has duplicate display names.
      const matchingRepos = (await this.controlPlane.listRepos(workspaceId)).filter(
        (repo) => repo.repoName === repoName,
      );
      if (matchingRepos.length === 0) {
        throw new NotFoundException(`Repo "${repoName}" is not connected to this workspace`);
      }
      if (matchingRepos.length > 1) {
        throw new ConflictException(
          `Repo name "${repoName}" is ambiguous in this workspace. Disconnect the duplicate entries and reconnect ` +
            `the intended repository before pushing.`,
        );
      }
      const repoIdentity = matchingRepos[0]!;
      if (resolveGraphBackend(workspace) === GraphBackend.FileSnapshot) {
        throw new GraphSnapshotError(
          'file_snapshot_requires_worker',
          'File-snapshot graph mutations require a durable worker job',
        );
      }
      const rebuildCommand = remoteRebuildCommand(workspaceId, repoName);

      const repository = await this.workspaceDbPool.acquire(workspaceId, workspace.slug);
      if (!repository) throw new NotFoundException('Workspace database not available');
      leasedWorkspaceId = workspaceId;

      // Create the graph id-indexes before any write (once per process). Without
      // :CodeNode(id), edge-insert endpoint MATCHes full-scan the graph and a
      // large push runs for hours; do it before the R2 download + diff so a
      // broken index setup fails fast rather than after minutes of work.
      await this.ensureGraphIndexesOnce();

      // Download new ParsedRepo from R2
      const parsedInput = await this.resultStorage.downloadResultForGraph(
        workspaceId,
        repoIdentity.repoKey,
        repoName,
        parsedVersion,
      );
      if (!parsedInput) {
        throw new NotFoundException(`Parse result version "${parsedVersion}" not found in R2`);
      }
      const newParsed = parsedInput.value;
      if (newParsed.name !== repoIdentity.repoName || newParsed.id !== repoIdentity.repoKey) {
        throw new BadRequestException(
          `Parse result version "${parsedVersion}" identifies repo "${newParsed.name}" (${newParsed.id}), but ` +
            `the connected route identity is "${repoIdentity.repoName}" (${repoIdentity.repoKey}). Disconnect and ` +
            `reconnect the repository before pushing if its key intentionally changed.`,
        );
      }

      // Defensive: R2 objects must never contain sourceCode. The controller pipe
      // enforces this on upload, but a pre-fix object or an alternate write path
      // could theoretically have left source code behind. Fail loud.
      if (!allowSourcesInGraph() && containsSourceCode(newParsed)) {
        throw new BadRequestException(
          `Parse result version "${parsedVersion}" contains sourceCode fields and cannot be processed.`,
        );
      }
      report(PushJobPhase.ValidatingArtifacts);

      // Resolve the metadata snapshot before any graph write. Summary and
      // embedding versions are optional on the push envelope, but replacing or
      // updating parsed nodes without the already-current metadata artifacts
      // would silently clear those fields. Explicit versions win; otherwise a
      // graph-changing push preserves the versions recorded in the manifest.
      // Same-version pushes without explicit metadata remain a no-op and avoid
      // downloading artifacts that are already present in the graph.
      const manifest = await this.resultStorage.getManifest(workspaceId, repoName);
      report(PushJobPhase.ReconcilingSnapshot);
      const storedSnapshot = await repository.getAppliedGraphSnapshot(repoIdentity.repoKey);
      // A new-code graph commit can legitimately put the atomic snapshot ahead
      // of the manifest when finalization fails. The inverse is possible only
      // across a rollback window: old code can advance the graph + manifest
      // without updating graph_meta. Compare durable timestamps as well as
      // retained history so a rollback spanning more than the five history
      // entries cannot make us diff from a stale snapshot and leave ghost
      // nodes behind.
      const manifestAdvancedFromSnapshot =
        storedSnapshot !== null &&
        manifest.currentParsed !== null &&
        storedSnapshot.parsedVersion !== manifest.currentParsed &&
        (manifest.history.some((entry) => entry.parsed === storedSnapshot.parsedVersion) ||
          (manifest.updatedAt !== null &&
            Number.isFinite(Date.parse(manifest.updatedAt)) &&
            Number.isFinite(Date.parse(storedSnapshot.appliedAt)) &&
            Date.parse(manifest.updatedAt) > Date.parse(storedSnapshot.appliedAt)));
      if (manifestAdvancedFromSnapshot) {
        this.logger.warn(
          `Graph snapshot for "${repoName}" (${storedSnapshot!.parsedVersion}) is behind the manifest ` +
            `(${manifest.currentParsed}) — likely a rollback window; using the manifest as diff baseline`,
        );
      }
      const snapshotBefore = manifestAdvancedFromSnapshot ? null : storedSnapshot;
      const previousVersion = snapshotBefore?.parsedVersion ?? manifest.currentParsed;
      const graphWillChange = rebuild || previousVersion !== parsedVersion;
      const effectiveSummaryVersion = metadataExclusions.excludeSummaries
        ? null
        : (summaryVersion ??
          (graphWillChange
            ? (manifest.currentSummary ?? snapshotBefore?.summaryVersion ?? null)
            : (snapshotBefore?.summaryVersion ?? null)));
      const effectiveEmbeddingsVersion = metadataExclusions.excludeEmbeddings
        ? null
        : (embeddingsVersion ??
          (graphWillChange
            ? (manifest.currentEmbeddings ?? snapshotBefore?.embeddingsVersion ?? null)
            : (snapshotBefore?.embeddingsVersion ?? null)));

      // Download the explicit or manifest-current summary before writing.
      let summaryOutput: SummaryOutput | null = null;
      if (effectiveSummaryVersion) {
        const summaryInput = await this.resultStorage.downloadSummaryForGraph(
          workspaceId,
          repoIdentity.repoKey,
          repoName,
          effectiveSummaryVersion,
        );
        summaryOutput = summaryInput?.value ?? null;
        if (summaryInput) {
          assertMetadataIdentity('Summary', summaryInput.value, newParsed);
          this.logger.log(`Loaded summary ${effectiveSummaryVersion} for merge during push`);
        } else {
          throw new NotFoundException(
            `Summary version "${effectiveSummaryVersion}"${summaryVersion ? '' : ' referenced by the manifest'} not found in R2`,
          );
        }
      }

      // Download the explicit or manifest-current embeddings before writing.
      let embeddingsOutput: EmbeddingsOutput | null = null;
      if (effectiveEmbeddingsVersion) {
        const embeddingsInput = await this.resultStorage.downloadEmbeddingsForGraph(
          workspaceId,
          repoIdentity.repoKey,
          repoName,
          effectiveEmbeddingsVersion,
        );
        embeddingsOutput = embeddingsInput?.value ?? null;
        if (embeddingsInput) {
          assertMetadataIdentity('Embeddings', embeddingsInput.value, newParsed);
          this.logger.log(`Loaded embeddings ${effectiveEmbeddingsVersion} for merge during push`);
        } else {
          throw new NotFoundException(
            `Embeddings version "${effectiveEmbeddingsVersion}"${
              embeddingsVersion ? '' : ' referenced by the manifest'
            } not found in R2`,
          );
        }
      }

      // Summary/embedding artifacts are incremental caches. A normal parse can
      // change only some versioned IDs while the manifest still points at the
      // previous metadata snapshot. Keep matching entries and treat the stale
      // ones as cache misses before every transform and incremental merge.
      const normalizedMetadata = normalizeMetadataForParsedRepo(newParsed, summaryOutput, embeddingsOutput);
      summaryOutput = normalizedMetadata.summaryOutput;
      embeddingsOutput = normalizedMetadata.embeddingsOutput;
      if (normalizedMetadata.dropped.total > 0) {
        const { summaries, functionEmbeddings, endpointEmbeddings } = normalizedMetadata.dropped;
        this.logger.warn(
          `Skipped ${normalizedMetadata.dropped.total} stale metadata entries for "${repoName}" ` +
            `(${summaries} summaries, ${functionEmbeddings} function embeddings, ` +
            `${endpointEmbeddings} endpoint embeddings)`,
        );
      }

      let result: IncrementalPushResult;
      let committedExecutionToken = executionToken;
      if (
        !rebuild &&
        snapshotMatches(snapshotBefore, parsedVersion, effectiveSummaryVersion, effectiveEmbeddingsVersion, commitSha)
      ) {
        this.logger.log(`Graph snapshot ${parsedVersion} already committed for "${repoName}"; resuming finalization`);
        result = resultFromSnapshot(repoName, snapshotBefore);
        committedExecutionToken = snapshotBefore.executionToken;
      } else if (rebuild) {
        // The caller has asserted this parse should replace the graph outright,
        // so skip the diff entirely — including the guards that exist to stop
        // an ACCIDENTAL wipe. That is the point of the flag: it is the answer
        // the degenerate-parse rejection tells the operator to reach for.
        this.logger.log(`Rebuild requested for "${repoName}" — replacing the graph without diffing`);
        result = await this.applyFull(
          repository,
          repoName,
          repoIdentity.repoKey,
          newParsed,
          parsedVersion,
          summaryOutput,
          embeddingsOutput,
          workspaceId,
          workspace.slug,
          commitSha,
          effectiveSummaryVersion,
          effectiveEmbeddingsVersion,
          executionToken,
          storedSnapshot,
          leaseAbort.signal,
          (reason) => leaseAbort.abort(reason),
          report,
        );
      } else if (previousVersion && previousVersion !== parsedVersion) {
        report(PushJobPhase.ComputingDiff);
        const previousInput = await this.resultStorage.downloadResultForGraph(
          workspaceId,
          repoIdentity.repoKey,
          repoName,
          previousVersion,
        );
        if (!previousInput) {
          throw new BadRequestException(
            `Previous parse artifact "${previousVersion}" for "${repoName}" is missing. ` +
              `Refusing to replace an existing graph without a baseline. Verify the current artifact, then run ` +
              `\`${rebuildCommand}\`.`,
          );
        }
        const oldParsed = previousInput.value;
        if (oldParsed.name !== repoIdentity.repoName || oldParsed.id !== repoIdentity.repoKey) {
          throw new BadRequestException(
            `Previous parse artifact "${previousVersion}" identifies repo "${oldParsed.name}" (${oldParsed.id}), ` +
              `not the connected route identity "${repoIdentity.repoName}" (${repoIdentity.repoKey}). Disconnect and ` +
              `reconnect the repository before pushing if its key intentionally changed.`,
          );
        }
        if (!previousInput.registered) {
          // A pre-Phase-3 baseline has no full digest to bind the diff to. A
          // full replacement preserves legacy Turso readability while making
          // the newly applied state depend only on exact current inputs.
          this.logger.warn(`Legacy baseline ${previousVersion} is unregistered; replacing "${repoName}" in full`);
          result = await this.applyFull(
            repository,
            repoName,
            repoIdentity.repoKey,
            newParsed,
            parsedVersion,
            summaryOutput,
            embeddingsOutput,
            workspaceId,
            workspace.slug,
            commitSha,
            effectiveSummaryVersion,
            effectiveEmbeddingsVersion,
            executionToken,
            storedSnapshot,
            leaseAbort.signal,
            (reason) => leaseAbort.abort(reason),
            report,
          );
        } else {
          result = await this.applyIncremental(
            repository,
            repoName,
            oldParsed,
            newParsed,
            parsedVersion,
            summaryOutput,
            embeddingsOutput,
            rebuildCommand,
            workspaceId,
            workspace.slug,
            commitSha,
            effectiveSummaryVersion,
            effectiveEmbeddingsVersion,
            executionToken,
            storedSnapshot,
            // Guarded on the BASELINE snapshot, which is null on a first push and during
            // the rollback window handled above — either way the full merge runs.
            snapshotBefore !== null &&
              snapshotBefore.summaryVersion === effectiveSummaryVersion &&
              snapshotBefore.embeddingsVersion === effectiveEmbeddingsVersion,
            leaseAbort.signal,
            (reason) => leaseAbort.abort(reason),
            report,
          );
        }
      } else if (previousVersion === parsedVersion) {
        // Same parsed version — metadata artifacts may have been generated later.
        this.logger.log(`Version ${parsedVersion} already pushed for "${repoName}", checking metadata artifacts`);
        const { transformParsedRepo: transform } = await import('@coredoc/db');
        const graph = transform(newParsed, summaryOutput, embeddingsOutput);
        const metadataUpdates = await buildMetadataUpdates(newParsed, summaryOutput, embeddingsOutput);
        const receipt = await this.applyGraphChanges(
          repository,
          workspaceId,
          workspace.slug,
          {
            repoId: repoIdentity.repoKey,
            nodesToAdd: [],
            nodesToUpdate: [],
            nodeIdsToDelete: [],
            edgeNodeIdsToWipe: [],
            edgeTypesToPreserve: [],
            edgesToInsert: [],
            nodeMetadataUpdates: metadataUpdates,
          },
          {
            parsedVersion,
            summaryVersion: effectiveSummaryVersion,
            embeddingsVersion: effectiveEmbeddingsVersion,
            commitSha,
            totalNodeCount: graph.nodes.length,
            totalEdgeCount: graph.edges.length,
            mode: GraphApplyMode.Metadata,
            executionToken,
          },
          storedSnapshot,
          leaseAbort.signal,
          (reason) => leaseAbort.abort(reason),
          report,
        );
        result = {
          repoName,
          mode: 'incremental',
          nodesAdded: 0,
          nodesUpdated: receipt.nodesUpdated,
          nodesDeleted: 0,
          edgesDeleted: 0,
          edgesInserted: 0,
          // Metadata-only pushes do not compute a file diff; keep the public
          // count in its non-negative domain instead of exposing a sentinel.
          unchanged: 0,
          version: parsedVersion,
          totalNodeCount: graph.nodes.length,
          totalEdgeCount: graph.edges.length,
        };
      } else {
        // A missing manifest only proves this is a first push when the graph has
        // no repository node. If the graph exists, replacing it would turn an R2
        // metadata loss into a destructive wipe with no diff baseline.
        const existingRepos = await repository.getRepositoryNames([repoIdentity.repoKey]);
        if (existingRepos.length > 0) {
          throw new BadRequestException(
            `No parsed pointer or recoverable graph snapshot exists for "${repoName}", but its graph is already present. ` +
              `Verify the current artifact, then run \`${rebuildCommand}\` to replace it explicitly.`,
          );
        }
        result = await this.applyFull(
          repository,
          repoName,
          repoIdentity.repoKey,
          newParsed,
          parsedVersion,
          summaryOutput,
          embeddingsOutput,
          workspaceId,
          workspace.slug,
          commitSha,
          effectiveSummaryVersion,
          effectiveEmbeddingsVersion,
          executionToken,
          storedSnapshot,
          leaseAbort.signal,
          (reason) => leaseAbort.abort(reason),
          report,
        );
      }

      // Persist the exact repository row observed before the graph write. This
      // guards disconnect/reconnect ABA without holding a PostgreSQL
      // transaction across Turso or R2 I/O.
      report(PushJobPhase.UpdatingControlPlane);
      const updated = await this.controlPlane.updateRepoPushMetadata(
        workspaceId,
        { id: repoIdentity.id, repoKey: repoIdentity.repoKey, repoName: repoIdentity.repoName },
        {
          lastParseHash: parsedVersion,
          lastPushedByUserId: userId,
          nodeCount: result.totalNodeCount,
          edgeCount: result.totalEdgeCount,
          lastParsedVersion: parsedVersion,
          lastSummaryVersion: effectiveSummaryVersion,
          lastEmbedVersion: effectiveEmbeddingsVersion,
        },
      );
      if (!updated) {
        throw new GraphSnapshotError(
          'artifact_identity_conflict',
          `Repository ${repoIdentity.repoName} was reconnected while its push was running`,
        );
      }

      report(PushJobPhase.FinalizingManifest);
      await this.resultStorage.updateManifest(workspaceId, repoName, parsedVersion, commitSha);

      if (!deferResolution) {
        report(PushJobPhase.Resolving);
        result.resolution = await this.runWorkspaceResolverSerialized(
          workspaceId,
          leaseAbort.signal,
          (reason) => leaseAbort.abort(reason),
          report,
        );
      }

      this.logger.log(
        `Pushed repo "${repoName}" (${result.mode}): +${result.nodesAdded} ~${result.nodesUpdated} -${result.nodesDeleted} nodes, ${result.edgesInserted} edges`,
      );

      // Record domain metrics (non-blocking — MetricsService swallows errors).
      // Pass summaryOutput so nodesWithSummaries reflects the summaries we
      // actually merged in this push, not just whatever was already in newParsed.
      const { getTransformStats, transformParsedRepo: transformForStats } = await import('@coredoc/db');
      const graph = transformForStats(newParsed, summaryOutput, embeddingsOutput);
      const stats = getTransformStats(graph);

      this.metricsService
        .recordPushMetrics({
          workspaceId,
          repoKey: newParsed.id,
          repoName,
          commitHash: commitSha,
          pushedByUserId: userId,
          pushMode: result.mode,
          totalNodes: result.totalNodeCount,
          totalEdges: result.totalEdgeCount,
          nodesByType: stats.nodesByType,
          edgesByType: stats.edgesByType,
          nodesAdded: result.nodesAdded ?? null,
          nodesUpdated: result.nodesUpdated ?? null,
          nodesDeleted: result.nodesDeleted ?? null,
          nodesWithSummaries: stats.nodesWithSummaries,
          nodesWithEmbeddings: stats.nodesWithEmbeddings,
          executionToken: committedExecutionToken,
        })
        .catch(() => {
          /* swallowed — metrics are best-effort */
        });

      // PostHog behavioral event (non-blocking)
      this.telemetryService.trackEvent(
        workspaceId,
        'repo_pushed',
        {
          repoName,
          mode: result.mode,
          nodesTotal: result.totalNodeCount,
          edgesTotal: result.totalEdgeCount,
          $insert_id: committedExecutionToken,
        },
        userId,
      );

      report(PushJobPhase.Completed, 1, 1, ProgressUnit.Steps);

      return result;
    } catch (err) {
      if (leasedWorkspaceId && isConnectionError(err)) {
        this.logger.warn(
          `Connection error during pushByVersion, evicting pooled connection for workspace ${workspaceId}`,
        );
        // Drop our lease BEFORE retiring the connection, otherwise the retired
        // driver waits on a release that the finally block (leasedWorkspaceId
        // nulled below) will never send.
        this.workspaceDbPool.release(workspaceId);
        await this.workspaceDbPool.closeConnection(workspaceId).catch(() => {});
        leasedWorkspaceId = null;
      }
      throw err;
    } finally {
      executionContext?.signal?.removeEventListener('abort', abortFromCaller);
      if (repoLeaseRenewal) clearInterval(repoLeaseRenewal);
      if (repoLease) await this.pushLeases.releaseRepository(workspaceId, repoName, repoLease).catch(() => {});
      this.activePushes.delete(lockKey);
      if (leasedWorkspaceId) this.workspaceDbPool.release(leasedWorkspaceId);
    }
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  /**
   * Ensure the Neo4j id-indexes (especially :CodeNode(id)) exist and are ONLINE
   * before the first write, once per process.
   *
   * The CLI does this in unified.ts before every push; the server worker never
   * did, so on the shared cloud graph the :CodeNode(id) index was absent and
   * every edge insert's endpoint MATCH became a full label scan — O(N) per edge,
   * turning a ~2-minute push into ~2 hours and OOM-restarting the pods. Idempotent
   * (CREATE INDEX IF NOT EXISTS) and ensureGraphIndexes awaits ONLINE, so the
   * first push actually uses the index. No-op on the SQLite backend.
   *
   * Fails loud: a missing index is catastrophic for performance, not a benign
   * warning, so a creation failure rejects the push (and resets memoization so
   * the next attempt retries) rather than silently degrading to full scans.
   */
  private ensureGraphIndexesOnce(): Promise<void> {
    if (getConfiguredBackend() !== 'neo4j') return Promise.resolve();
    if (!this.graphIndexesReady) {
      this.graphIndexesReady = ensureGraphIndexes().catch((err) => {
        this.graphIndexesReady = null;
        this.logger.error(
          `Failed to ensure Neo4j graph indexes — pushes would be catastrophically slow without them: ${
            (err as Error).message
          }`,
        );
        throw err;
      });
    }
    return this.graphIndexesReady;
  }

  private async applyGraphChanges(
    repository: IGraphRepository,
    workspaceId: string,
    workspaceSlug: string,
    changeset: AtomicChangeset,
    snapshotInput: GraphSnapshotInput,
    snapshotBefore: AppliedGraphSnapshot | null,
    signal: AbortSignal,
    abortExecution: (reason: Error) => void,
    report: PushExecutionContext['report'],
  ): Promise<GraphApplyReceipt> {
    if (typeof repository.applyChangeset !== 'function') {
      throw new BadRequestException('Configured graph backend cannot apply atomic graph changes.');
    }

    let currentRepository = repository;
    const graphLeaseOwnerToken = randomUUID();
    for (let attempt = 1; attempt <= 3; attempt++) {
      signal.throwIfAborted();
      let graphLease: DistributedLease | null = null;
      let renewal: ReturnType<typeof setInterval> | null = null;
      try {
        graphLease = await this.pushLeases.acquireGraphWrite(workspaceId, graphLeaseOwnerToken, signal, () =>
          report(PushJobPhase.WaitingForGraphWrite),
        );
        renewal = this.pushLeases.startRenewal(
          () => this.pushLeases.renewGraphWrite(workspaceId, graphLease!),
          abortExecution,
        );
        return await currentRepository.applyChangeset!(changeset, {
          snapshot: snapshotInput,
          signal,
          onBatch: (progress) => {
            // Unthrottled diagnostic trail: one line per completed transport
            // flush, bypassing the worker's throttled report() path.
            this.logger.log(
              `Graph apply ${changeset.repoId} batch ${progress.kind}: ${progress.completed}/${progress.total} (attempt ${attempt})`,
            );
            this.reportGraphBatch(progress, report);
          },
          // Phase-level timing trail. Deletes emit no onBatch progress, so
          // without this a connection death mid-apply leaves minutes of
          // unattributable silence in the log.
          onPhase: (phase, elapsedMs) =>
            this.logger.log(`Graph apply ${changeset.repoId} phase ${phase}: ${elapsedMs}ms (attempt ${attempt})`),
        });
      } catch (err) {
        if (!isConnectionError(err) || attempt >= 3) throw err;
        this.logger.warn(
          `Ambiguous graph commit for ${changeset.repoId} (attempt ${attempt}/3); reconnecting before deciding whether to retry — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );

        // Release OUR lease on the broken connection (attributed via the
        // repository object — the map entry may already point elsewhere), then
        // retire it. closeConnection defers the actual driver.close() until
        // concurrent holders (readers, resolver) drain their leases.
        this.workspaceDbPool.release(workspaceId, currentRepository);
        await this.workspaceDbPool.closeConnection(workspaceId).catch(() => {});
        const fresh = await this.workspaceDbPool.acquire(workspaceId, workspaceSlug);
        if (!fresh) throw new NotFoundException('Workspace database not available during graph reconciliation');
        currentRepository = fresh;

        const observed = await currentRepository.getAppliedGraphSnapshot(changeset.repoId);
        if (
          snapshotMatches(
            observed,
            snapshotInput.parsedVersion,
            snapshotInput.summaryVersion,
            snapshotInput.embeddingsVersion,
            snapshotInput.commitSha,
          )
        ) {
          if (observed.executionToken !== snapshotInput.executionToken) {
            // Token stays out of the client-visible message — it is a payload
            // field the jobs API deliberately redacts.
            this.logger.warn(
              `Reconciliation for ${changeset.repoId}: version committed by execution ${observed.executionToken}, not ours`,
            );
            throw new ConflictException(
              'Graph reconciliation found the requested version committed by a different execution',
            );
          }
          return observed.receipt;
        }
        if (!snapshotEquals(observed, snapshotBefore)) {
          throw new ConflictException('Graph changed during commit reconciliation; refusing to overwrite newer state');
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      } finally {
        if (renewal) clearInterval(renewal);
        if (graphLease) await this.pushLeases.releaseGraphWrite(workspaceId, graphLease).catch(() => {});
      }
    }
    throw new Error('Graph retry budget exhausted');
  }

  private reportGraphBatch(progress: BatchProgress, report: PushExecutionContext['report']): void {
    if (progress.kind === 'nodes') {
      report(PushJobPhase.WritingNodes, progress.completed, progress.total, ProgressUnit.Nodes);
    } else if (progress.kind === 'edges') {
      report(PushJobPhase.WritingEdges, progress.completed, progress.total, ProgressUnit.Edges);
    } else {
      report(PushJobPhase.WritingMetadata, progress.completed, progress.total, ProgressUnit.Updates);
    }
  }

  private async applyIncremental(
    repository: IGraphRepository,
    repoName: string,
    oldParsed: ParsedRepo,
    newParsed: ParsedRepo,
    version: string,
    summaryOutput: SummaryOutput | null,
    embeddingsOutput: EmbeddingsOutput | null,
    rebuildCommand: string,
    workspaceId: string,
    workspaceSlug: string,
    commitSha: string | null,
    summaryVersion: string | null,
    embeddingsVersion: string | null,
    executionToken: string,
    snapshotBefore: AppliedGraphSnapshot | null,
    /**
     * The stored graph already carries this exact summary/embeddings pair, so merging
     * metadata into UNTOUCHED nodes would rewrite thousands of rows to the values they
     * already hold. Computed by the caller from the baseline snapshot — deliberately
     * NOT derived from `snapshotBefore` here, which is the raw stored snapshot kept for
     * concurrency reconciliation and stays populated during a rollback window the
     * caller has explicitly decided not to trust as a baseline.
     */
    metadataAlreadyApplied: boolean,
    signal: AbortSignal,
    abortExecution: (reason: Error) => void,
    report: PushExecutionContext['report'],
  ): Promise<IncrementalPushResult> {
    const changeset = await this.diffEngine.computeChangeset(
      oldParsed,
      newParsed,
      summaryOutput,
      embeddingsOutput,
      rebuildCommand,
    );

    if (typeof repository.applyChangeset !== 'function') {
      throw new BadRequestException(
        `Configured graph backend cannot apply atomic incremental changes for "${repoName}". ` +
          `Refusing an implicit replacement; run \`${rebuildCommand}\` to replace the graph explicitly.`,
      );
    }

    const structuralIds = new Set([
      ...changeset.nodesToAdd.map((node) => node.id),
      ...changeset.nodesToUpdate.map((node) => node.id),
    ]);
    // Nodes added or changed by this push carry their metadata inline through the
    // changeset; this merge only ever covered the untouched remainder. When the stored
    // snapshot already records these exact artifact versions, that remainder is already
    // correct — the snapshot is written in the SAME transaction as the metadata it
    // describes, so it cannot claim a version whose rows never landed.
    const nodeMetadataUpdates = metadataAlreadyApplied
      ? []
      : await buildMetadataUpdates(newParsed, summaryOutput, embeddingsOutput, structuralIds);
    if (metadataAlreadyApplied) {
      this.logger.log(
        `Metadata unchanged for "${repoName}" (summary=${summaryVersion ?? 'none'}, ` +
          `embeddings=${embeddingsVersion ?? 'none'}) — skipping the node metadata merge`,
      );
    }
    const dbResult = await this.applyGraphChanges(
      repository,
      workspaceId,
      workspaceSlug,
      { ...changeset, repoId: newParsed.id, nodeMetadataUpdates },
      {
        parsedVersion: version,
        summaryVersion,
        embeddingsVersion,
        commitSha,
        totalNodeCount: changeset.totalNodeCount,
        totalEdgeCount: changeset.totalEdgeCount,
        mode: GraphApplyMode.Incremental,
        executionToken,
      },
      snapshotBefore,
      signal,
      abortExecution,
      report,
    );

    return {
      repoName,
      mode: 'incremental',
      nodesAdded: dbResult.nodesAdded,
      nodesUpdated: dbResult.nodesUpdated,
      nodesDeleted: dbResult.nodesDeleted,
      edgesDeleted: dbResult.edgesDeleted,
      edgesInserted: dbResult.edgesInserted,
      unchanged: changeset.stats.filesUnchanged,
      version,
      totalNodeCount: changeset.totalNodeCount,
      totalEdgeCount: changeset.totalEdgeCount,
    };
  }

  private async applyFull(
    repository: IGraphRepository,
    repoName: string,
    repoKey: string,
    parsedRepo: ParsedRepo,
    version: string,
    summaryOutput: SummaryOutput | null = null,
    embeddingsOutput: EmbeddingsOutput | null = null,
    workspaceId: string,
    workspaceSlug: string,
    commitSha: string | null,
    summaryVersion: string | null,
    embeddingsVersion: string | null,
    executionToken: string,
    snapshotBefore: AppliedGraphSnapshot | null,
    signal: AbortSignal,
    abortExecution: (reason: Error) => void,
    report: PushExecutionContext['report'],
  ): Promise<IncrementalPushResult> {
    const { transformParsedRepo } = await import('@coredoc/db');
    const result = transformParsedRepo(parsedRepo, summaryOutput, embeddingsOutput);

    if (typeof repository.applyChangeset !== 'function') {
      throw new BadRequestException(
        `Configured graph backend cannot apply an atomic rebuild for "${repoName}". Refusing a non-atomic replacement.`,
      );
    }

    // The unique route repoKey, not artifact-controlled id/name lookup, scopes
    // the delete. Both supported backends execute this repository removal and
    // the replacement inserts in one transaction.
    const dbResult = await this.applyGraphChanges(
      repository,
      workspaceId,
      workspaceSlug,
      {
        repoId: repoKey,
        repoIdsToDelete: [repoKey],
        nodesToAdd: result.nodes,
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgeTypesToPreserve: [],
        edgesToInsert: result.edges,
      },
      {
        parsedVersion: version,
        summaryVersion,
        embeddingsVersion,
        commitSha,
        totalNodeCount: result.nodes.length,
        totalEdgeCount: result.edges.length,
        mode: GraphApplyMode.Full,
        executionToken,
      },
      snapshotBefore,
      signal,
      abortExecution,
      report,
    );

    // Cross-repo resolution runs once at the pushByVersion level via
    // `runWorkspaceResolver`, which wipes RESOLVES_TO for the workspace and
    // re-runs both the mapper engine and the descriptor resolver (covering
    // the no-mapper case too). Running the legacy single-repo resolver here
    // would only produce edges that get deleted seconds later.

    return {
      repoName,
      mode: 'full',
      nodesAdded: dbResult.nodesAdded,
      nodesUpdated: dbResult.nodesUpdated,
      nodesDeleted: dbResult.nodesDeleted,
      edgesDeleted: dbResult.edgesDeleted,
      edgesInserted: dbResult.edgesInserted,
      unchanged: 0,
      version,
      totalNodeCount: result.nodes.length,
      totalEdgeCount: result.edges.length,
    };
  }

  /**
   * Re-resolve cross-repo edges (RESOLVES_TO) for the workspace after a push.
   * Project-wide because a new entrypoint in this repo can re-resolve stale
   * calls in sibling repos, and a new external_call here may resolve to
   * existing entrypoints.
   *
   * Resolver errors do NOT roll back the push — the graph without fresh
   * RESOLVES_TO is strictly better than a failed push. Returned as
   * `{ error }` so callers can surface it on the push response.
   */
  private async runWorkspaceResolver(
    workspaceId: string,
    execution?: ResolutionExecutionOptions,
  ): Promise<ResolutionMetrics | { error: string }> {
    try {
      const metrics = execution
        ? await this.resolverService.resolveWorkspace(workspaceId, execution)
        : await this.resolverService.resolveWorkspace(workspaceId);
      this.logger.log(
        `Resolved cross-repo for workspace ${workspaceId}: ${metrics.resolved}/${metrics.total} (${metrics.legacyEdges} via descriptor resolver)`,
      );
      return metrics;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`resolveWorkspace failed for ${workspaceId}: ${message}`);
      return { error: message };
    }
  }

  private async runWorkspaceResolverSerialized(
    workspaceId: string,
    signal: AbortSignal,
    abortExecution: (reason: Error) => void,
    report: PushExecutionContext['report'],
  ): Promise<ResolutionMetrics | { error: string }> {
    return this.runWorkspaceResolver(workspaceId, {
      ownerToken: randomUUID(),
      signal,
      onWait: () => report(PushJobPhase.WaitingForGraphWrite),
      onLeaseLost: abortExecution,
    });
  }
}
