import { Injectable, Logger } from '@nestjs/common';
import { GRAPH_FILE_FORMAT_COMPATIBILITY } from '@coredoc/db';
import type { Prisma as PrismaTypes } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { GraphBackend, resolveGraphBackend } from '../../database/graph-backend.js';
import { GraphSnapshotError, isGraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import {
  assertWorkspaceScopedR2Key,
  canonicalizeJson,
  createGraphSnapshotIdentity,
  graphSnapshotR2Key,
  hasCurrentGraphSnapshotCompatibility,
} from './graph-snapshot-manifest.js';
import type {
  GraphSnapshotManifestV1,
  GraphSnapshotMapperDescriptor,
  GraphSnapshotRepositoryManifest,
  WorkspaceRepoArtifactDescriptor,
  WorkspaceRepoArtifactKind,
} from '../../libs/pipeline/graph-snapshot.types.js';

const CONTROL_TRANSACTION_MAX_WAIT_MS = 5_000;
const CONTROL_TRANSACTION_TIMEOUT_MS = 10_000;
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const VERSION_PATTERNS: Readonly<Record<WorkspaceRepoArtifactKind, RegExp>> = {
  parsed: /^[0-9a-f]{16}$/,
  summary: /^sum_[0-9a-f]{16}$/,
  embeddings: /^emb_[0-9a-f]{16}$/,
};

type Transaction = PrismaTypes.TransactionClient;

interface GraphJobRow {
  id: string;
  workspaceId: string;
  type: string;
  status: string;
  leaseToken: string | null;
  repoName: string | null;
  queuedAt: Date | null;
  payload: unknown;
}

interface CandidateRepoRow {
  id: string;
  workspaceId: string;
  repoKey: string;
  repoName: string;
  repoType: string | null;
  httpPrefix: string | null;
  lastParsedVersion: string | null;
  lastSummaryVersion: string | null;
  lastEmbedVersion: string | null;
  lastParseHash: string | null;
  lastPushedAt: Date | null;
  nodeCount: number | null;
  edgeCount: number | null;
}

export interface RegisterWorkspaceRepoArtifactInput {
  workspaceId: string;
  repoName: string;
  kind: WorkspaceRepoArtifactKind;
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: string | number | bigint;
}

export interface GraphSnapshotCandidateTarget {
  repoName: string;
  parsedVersion: string;
  /** `undefined` preserves the parent selection; `null` explicitly excludes it. */
  summaryVersion?: string | null;
  /** `undefined` preserves the parent selection; `null` explicitly excludes it. */
  embeddingsVersion?: string | null;
  commitSha?: string | null;
}

export interface AssembleGraphSnapshotCandidateInput {
  workspaceId: string;
  jobId: string;
  executionToken: string;
  leaseToken: string;
  /**
   * Repositories whose pinned selection this candidate replaces. A `push` job
   * carries exactly its own repository; a `resolve` job carries none (a pure
   * re-resolve) or the whole batch a client just uploaded, which is what turns
   * an N-repository sync into one build and one published object.
   */
  targets?: GraphSnapshotCandidateTarget[];
}

export interface GraphSnapshotCandidate {
  manifest: GraphSnapshotManifestV1;
  versionId: string;
  /**
   * The candidate resolves to the workspace's already-active version — nothing
   * about this push changes what the graph contains. Lets the caller skip
   * materialization, which would otherwise re-download every pinned component
   * and the whole graph object only to rediscover that they are unchanged.
   */
  matchesActiveVersion: boolean;
  /** Stored artifact identity of the active version; set only when it matches. */
  activeArtifact: GraphArtifactIdentity | null;
  /** One entry per replaced repository, in candidate target order. */
  targetRepoIdentities: Array<{
    id: string;
    repoKey: string;
    repoName: string;
    nodeCount: number | null;
    edgeCount: number | null;
  }>;
}

interface GraphArtifactIdentity {
  r2Key: string;
  sha256: string;
  sizeBytes: string;
}

/** Identity half of a candidate — all publication and its assertions need. */
type PublishedCandidateIdentity = Pick<GraphSnapshotCandidate, 'manifest' | 'versionId'>;

export interface PublishGraphSnapshotCandidateInput {
  workspaceId: string;
  jobId: string;
  executionToken: string;
  leaseToken: string;
  manifest: unknown;
  versionId: string;
  artifact: {
    r2Key: string;
    sha256: string;
    sizeBytes: string | number | bigint;
  };
  /** Repository rows this publication re-pins; empty for a pure re-resolve. */
  targetRepos?: Array<{
    id: string;
    repoKey: string;
    repoName: string;
    lastPushedByUserId: string;
    nodeCount: number;
    edgeCount: number;
  }>;
}

export interface PublishGraphSnapshotCandidateResult {
  versionId: string;
  parentVersionId: string | null;
  idempotent: boolean;
}

function identityConflict(message: string): never {
  throw new GraphSnapshotError('artifact_identity_conflict', message);
}

function compareCanonicalString(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareRepositoryIdentity(
  left: Pick<GraphSnapshotRepositoryManifest, 'repoKey' | 'repoName'>,
  right: Pick<GraphSnapshotRepositoryManifest, 'repoKey' | 'repoName'>,
): number {
  return compareCanonicalString(left.repoKey, right.repoKey) || compareCanonicalString(left.repoName, right.repoName);
}

function objectConflict(message: string): never {
  throw new GraphSnapshotError('graph_object_identity_conflict', message);
}

function positiveBigInt(value: string | number | bigint, label: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('unsafe');
    parsed = BigInt(value);
  } catch {
    identityConflict(`${label} must be a positive integer`);
  }
  if (parsed <= 0n || parsed.toString() !== String(value)) {
    identityConflict(`${label} must be a positive canonical integer`);
  }
  return parsed;
}

function assertDigest(value: string, label: string): void {
  if (!LOWER_SHA256.test(value)) identityConflict(`${label} must be a lowercase SHA-256`);
}

function assertVersion(kind: WorkspaceRepoArtifactKind, version: string): void {
  if (!VERSION_PATTERNS[kind].test(version)) identityConflict(`Invalid ${kind} artifact version`);
}

function artifactFromRow(row: {
  workspaceId: string;
  repoKey: string;
  repoName: string;
  kind: WorkspaceRepoArtifactKind;
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: bigint;
}): WorkspaceRepoArtifactDescriptor {
  return {
    workspaceId: row.workspaceId,
    repoKey: row.repoKey,
    repoName: row.repoName,
    kind: row.kind,
    version: row.version,
    r2Key: row.r2Key,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes.toString(),
  };
}

function sameArtifact(left: WorkspaceRepoArtifactDescriptor, right: WorkspaceRepoArtifactDescriptor): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repoKey === right.repoKey &&
    left.repoName === right.repoName &&
    left.kind === right.kind &&
    left.version === right.version &&
    left.r2Key === right.r2Key &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

function executionTokenOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { executionToken?: unknown }).executionToken;
  return typeof value === 'string' ? value : null;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (candidate.code === '57014' || candidate.code === 'P2028') return true;
  if (
    typeof candidate.message === 'string' &&
    /statement timeout|transaction.*timed out|transaction.*closed/i.test(candidate.message)
  ) {
    return true;
  }
  return candidate.cause !== undefined && isTimeoutError(candidate.cause);
}

function assertMapperDescriptor(
  workspaceId: string,
  value: { r2Key: string; sha256: string; sizeBytes: string | number | bigint },
): GraphSnapshotMapperDescriptor {
  assertWorkspaceScopedR2Key(workspaceId, value.r2Key);
  assertDigest(value.sha256, 'mapper.sha256');
  const sizeBytes = positiveBigInt(value.sizeBytes, 'mapper.sizeBytes').toString();
  return { r2Key: value.r2Key, sha256: value.sha256, sizeBytes };
}

@Injectable()
export class GraphSnapshotControlPlaneService {
  private readonly logger = new Logger(GraphSnapshotControlPlaneService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveArtifactRepository(workspaceId: string, repoName: string) {
    const matches = await this.prisma.workspaceRepo.findMany({
      where: { workspaceId, repoName },
      select: { workspaceId: true, repoKey: true, repoName: true },
      take: 2,
    });
    if (matches.length !== 1) {
      identityConflict(
        matches.length === 0
          ? `Repository ${repoName} is not connected to workspace ${workspaceId}`
          : `Repository name ${repoName} is ambiguous in workspace ${workspaceId}`,
      );
    }
    return matches[0];
  }

  async registerArtifact(input: RegisterWorkspaceRepoArtifactInput): Promise<WorkspaceRepoArtifactDescriptor> {
    assertVersion(input.kind, input.version);
    assertDigest(input.sha256, 'artifact.sha256');
    assertWorkspaceScopedR2Key(input.workspaceId, input.r2Key);
    const sizeBytes = positiveBigInt(input.sizeBytes, 'artifact.sizeBytes');
    const repo = await this.resolveArtifactRepository(input.workspaceId, input.repoName);
    const descriptor: WorkspaceRepoArtifactDescriptor = {
      workspaceId: input.workspaceId,
      repoKey: repo.repoKey,
      repoName: repo.repoName,
      kind: input.kind,
      version: input.version,
      r2Key: input.r2Key,
      sha256: input.sha256,
      sizeBytes: sizeBytes.toString(),
    };

    await this.prisma.workspaceRepoArtifact.createMany({
      data: [{ ...descriptor, sizeBytes }],
      skipDuplicates: true,
    });
    const stored = await this.prisma.workspaceRepoArtifact.findUnique({
      where: {
        workspaceId_repoKey_kind_version: {
          workspaceId: input.workspaceId,
          repoKey: repo.repoKey,
          kind: input.kind,
          version: input.version,
        },
      },
    });
    if (!stored || !sameArtifact(descriptor, artifactFromRow(stored))) {
      identityConflict(
        `Artifact identity ${repo.repoKey}/${input.kind}/${input.version} conflicts with its registry row`,
      );
    }
    return descriptor;
  }

  async assembleCandidate(input: AssembleGraphSnapshotCandidateInput): Promise<GraphSnapshotCandidate> {
    return this.withControlTransaction(async (transaction) => {
      const job = await this.loadGraphJob(transaction, input.workspaceId, input.jobId, input.executionToken);
      this.assertRunningGraphJob(job);
      this.assertCurrentLease(job, input.leaseToken);
      const targets = this.assertCandidateTargets(job, input);

      const workspace = await transaction.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { id: true, graphBackend: true, activeGraphVersionId: true },
      });
      if (!workspace) identityConflict(`Workspace ${input.workspaceId} does not exist`);
      if (resolveGraphBackend(workspace) !== GraphBackend.FileSnapshot) {
        throw new GraphSnapshotError('graph_backend_conflict', `Workspace ${input.workspaceId} is not file_snapshot`);
      }

      const repos = (await transaction.workspaceRepo.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ repoKey: 'asc' }, { repoName: 'asc' }],
      })) as CandidateRepoRow[];
      const targetRepoByKey = new Map<string, { repo: CandidateRepoRow; target: GraphSnapshotCandidateTarget }>();
      for (const target of targets) {
        const repo = this.exactRepoByName(repos, target.repoName);
        if (targetRepoByKey.has(repo.repoKey)) {
          identityConflict(`Repository ${target.repoName} appears more than once in the candidate targets`);
        }
        targetRepoByKey.set(repo.repoKey, { repo, target });
      }
      const targetRepoIdentities = [...targetRepoByKey.values()].map(({ repo }) => ({
        id: repo.id,
        repoKey: repo.repoKey,
        repoName: repo.repoName,
        nodeCount: repo.nodeCount,
        edgeCount: repo.edgeCount,
      }));
      const active = workspace.activeGraphVersionId
        ? await this.loadParentManifest(transaction, input.workspaceId, workspace.activeGraphVersionId)
        : null;
      const parent = active?.manifest ?? null;
      const parentByRepoKey = new Map(parent?.repositories.map((repository) => [repository.repoKey, repository]));
      const repositories: GraphSnapshotRepositoryManifest[] = [];
      for (const repo of repos) {
        const parentRepository = parentByRepoKey.get(repo.repoKey);
        const targeted = targetRepoByKey.get(repo.repoKey);
        if (targeted) {
          // Stale-pin guard: the worker deliberately drains every push before
          // a resolve, so a queued batch can run AFTER a later push published
          // a newer selection for the same repository — replaying the batch's
          // pin would silently roll that repository back. A pin is stale when
          // the row was re-published after this job was enqueued AND the
          // batch's EFFECTIVE selection differs from what is now pinned.
          // Effective per slot: `undefined` preserves the pinned value (never
          // stale by that slot); `null` and concrete values are explicit pins
          // and each must still match. commitSha is compared against the
          // parent manifest — it is manifest identity, not a row column, and
          // identical artifacts across commits would otherwise let an old
          // batch quietly rewind the recorded commit. A fully matching
          // selection is the batch's own retry and stays valid. Deliberately
          // conservative: content-addressed versions have no order, so a
          // genuinely newer batch that raced an interleaved push is also
          // rejected — one client re-sync versus a silent rollback.
          const slotDiffers = (pinned: string | null, requested: string | null | undefined): boolean =>
            requested !== undefined && (pinned ?? null) !== requested;
          if (
            repo.lastPushedAt !== null &&
            job.queuedAt !== null &&
            repo.lastPushedAt > job.queuedAt &&
            (repo.lastParsedVersion !== targeted.target.parsedVersion ||
              slotDiffers(repo.lastSummaryVersion, targeted.target.summaryVersion) ||
              slotDiffers(repo.lastEmbedVersion, targeted.target.embeddingsVersion) ||
              (parentRepository !== undefined &&
                (parentRepository.commitSha ?? null) !== (targeted.target.commitSha ?? null)))
          ) {
            identityConflict(
              `Repository ${targeted.target.repoName} was re-published after this batch was enqueued; re-sync to publish a fresh selection`,
            );
          }
          const hasLiveSelection = this.hasSelectedRepository(repo, true);
          repositories.push(
            parentRepository?.repoName === repo.repoName && hasLiveSelection
              ? await this.replacementRepository(transaction, repo, targeted.target, parentRepository)
              : await this.firstPublishRepository(transaction, repo, targeted.repo, targeted.target),
          );
          continue;
        }
        if (!this.hasSelectedRepository(repo)) continue;
        if (parentRepository?.repoName === repo.repoName) {
          repositories.push(parentRepository);
          continue;
        }
        const connected = await this.selectedRepository(transaction, repo);
        if (connected) repositories.push(connected);
      }
      repositories.sort(compareRepositoryIdentity);
      if (repositories.length === 0) {
        identityConflict(`Workspace ${input.workspaceId} has no selected repository artifacts to publish`);
      }

      const mapper = await this.currentMapper(transaction, input.workspaceId);
      if (
        parent &&
        hasCurrentGraphSnapshotCompatibility(parent) &&
        canonicalizeJson(parent.repositories) === canonicalizeJson(repositories) &&
        canonicalizeJson(parent.mapper) === canonicalizeJson(mapper)
      ) {
        const identity = createGraphSnapshotIdentity(parent);
        return {
          manifest: identity.manifest,
          versionId: identity.versionId,
          // `parent` is loaded from `activeGraphVersionId` and its identity is
          // verified there, so an unchanged composition IS the active version.
          matchesActiveVersion: true,
          activeArtifact: active?.artifact ?? null,
          targetRepoIdentities,
        };
      }

      const identity = createGraphSnapshotIdentity({
        manifestVersion: 1,
        workspaceId: input.workspaceId,
        parentVersionId: parent ? createGraphSnapshotIdentity(parent).versionId : null,
        ...GRAPH_FILE_FORMAT_COMPATIBILITY,
        sourcePolicy: 'strip',
        repositories,
        mapper,
      });
      return {
        manifest: identity.manifest,
        versionId: identity.versionId,
        matchesActiveVersion: false,
        activeArtifact: null,
        targetRepoIdentities,
      };
    });
  }

  async publishCandidate(input: PublishGraphSnapshotCandidateInput): Promise<PublishGraphSnapshotCandidateResult> {
    return this.withControlTransaction(async (transaction) => {
      await this.lockWorkspace(transaction, input.workspaceId);
      await this.lockJob(transaction, input.workspaceId, input.jobId);
      const job = await this.loadGraphJob(transaction, input.workspaceId, input.jobId, input.executionToken);
      this.assertRunningGraphJob(job);
      this.assertCurrentLease(job, input.leaseToken);

      const identity = createGraphSnapshotIdentity(input.manifest);
      if (identity.manifest.workspaceId !== input.workspaceId || identity.versionId !== input.versionId) {
        identityConflict('Candidate manifest does not match its workspace or version identity');
      }
      assertDigest(input.artifact.sha256, 'graph artifact sha256');
      const artifact: GraphArtifactIdentity = {
        r2Key: input.artifact.r2Key,
        sha256: input.artifact.sha256,
        sizeBytes: positiveBigInt(input.artifact.sizeBytes, 'graph artifact sizeBytes').toString(),
      };
      if (artifact.r2Key !== graphSnapshotR2Key(input.workspaceId, identity.versionId)) {
        objectConflict('Graph artifact key is not canonical for the candidate');
      }
      const candidate: PublishedCandidateIdentity = {
        manifest: identity.manifest,
        versionId: identity.versionId,
      };
      this.assertPublishJobBinding(job, candidate, input.targetRepos);

      await transaction.workspaceGraphVersion.createMany({
        data: [
          {
            workspaceId: input.workspaceId,
            versionId: candidate.versionId,
            engine: candidate.manifest.engine,
            r2Key: artifact.r2Key,
            sha256: artifact.sha256,
            sizeBytes: BigInt(artifact.sizeBytes),
            storageFormatVersion: candidate.manifest.storageFormatVersion,
            manifest: candidate.manifest as unknown as PrismaTypes.InputJsonValue,
            parentVersionId: candidate.manifest.parentVersionId,
          },
        ],
        skipDuplicates: true,
      });
      const storedVersion = await transaction.workspaceGraphVersion.findUnique({
        where: {
          workspaceId_versionId: { workspaceId: input.workspaceId, versionId: candidate.versionId },
        },
      });
      this.assertStoredVersion(candidate, artifact, storedVersion);

      // DB clock, same source as pushJob.queuedAt's default — the stale-pin
      // guard compares the two, and pod/DB skew would otherwise let a rollback
      // slip through or reject a valid batch.
      const [{ now: pushedAt }] = await transaction.$queryRaw<[{ now: Date }]>`SELECT NOW() as now`;
      for (const targetRepo of input.targetRepos ?? []) {
        const selected = candidate.manifest.repositories.find(({ repoKey }) => repoKey === targetRepo.repoKey);
        if (!selected) {
          identityConflict(`Target repo ${targetRepo.repoKey} is absent from the candidate manifest`);
        }
        const updated = await transaction.workspaceRepo.updateMany({
          where: {
            id: targetRepo.id,
            workspaceId: input.workspaceId,
            repoKey: targetRepo.repoKey,
            repoName: targetRepo.repoName,
          },
          data: {
            lastParsedVersion: selected.parsed.version,
            lastSummaryVersion: selected.summary?.version ?? null,
            lastEmbedVersion: selected.embeddings?.version ?? null,
            lastParseHash: selected.parsed.version,
            lastPushedAt: pushedAt,
            lastPushedByUserId: targetRepo.lastPushedByUserId,
            nodeCount: targetRepo.nodeCount,
            edgeCount: targetRepo.edgeCount,
          },
        });
        if (updated.count !== 1) {
          identityConflict(`Repository ${targetRepo.repoName} was reconnected before snapshot publication`);
        }
      }

      const changed = await transaction.$executeRaw`
        UPDATE workspaces
           SET active_graph_version_id = ${candidate.versionId},
               retain_graph_artifacts = true
         WHERE id = ${input.workspaceId}
           AND graph_backend = 'file_snapshot'
           AND active_graph_version_id IS NOT DISTINCT FROM ${candidate.manifest.parentVersionId}
      `;
      if (Number(changed) === 1) {
        await transaction.intentHandoff.updateMany({
          where: { workspaceId: input.workspaceId, mappingState: { in: ['pending', 'needs_attention'] } },
          data: { nextAttemptAt: new Date() },
        });
        return {
          versionId: candidate.versionId,
          parentVersionId: candidate.manifest.parentVersionId,
          idempotent: false,
        };
      }

      const workspace = await transaction.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { graphBackend: true, activeGraphVersionId: true },
      });
      if (!workspace || resolveGraphBackend(workspace) !== GraphBackend.FileSnapshot) {
        throw new GraphSnapshotError('graph_backend_conflict', `Workspace ${input.workspaceId} changed graph backend`);
      }
      if (workspace.activeGraphVersionId === candidate.versionId) {
        return {
          versionId: candidate.versionId,
          parentVersionId: candidate.manifest.parentVersionId,
          idempotent: true,
        };
      }
      throw new GraphSnapshotError(
        'graph_parent_conflict',
        `Workspace ${input.workspaceId} active graph changed before this candidate was published`,
      );
    });
  }

  private async withControlTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          return operation(transaction);
        },
        { maxWait: CONTROL_TRANSACTION_MAX_WAIT_MS, timeout: CONTROL_TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      if (isGraphSnapshotError(error)) throw error;
      if (isTimeoutError(error)) {
        throw new GraphSnapshotError('graph_pointer_timeout', 'Graph control-plane transaction timed out', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async lockWorkspace(transaction: Transaction, workspaceId: string): Promise<void> {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))
    `;
  }

  private async lockJob(transaction: Transaction, workspaceId: string, jobId: string): Promise<void> {
    await transaction.$executeRaw`
      SELECT id FROM push_jobs
      WHERE id = ${jobId} AND workspace_id = ${workspaceId}
      FOR UPDATE
    `;
  }

  private async loadGraphJob(
    reader: Pick<Transaction, 'pushJob'>,
    workspaceId: string,
    jobId: string,
    executionToken: string,
  ): Promise<GraphJobRow> {
    const job = (await reader.pushJob.findFirst({
      where: { id: jobId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        status: true,
        leaseToken: true,
        repoName: true,
        queuedAt: true,
        payload: true,
      },
    })) as GraphJobRow | null;
    if (!job) identityConflict(`Graph job ${jobId} does not belong to workspace ${workspaceId}`);
    if (executionTokenOf(job.payload) !== executionToken) {
      identityConflict(`Graph job ${jobId} execution token does not match`);
    }
    return job;
  }

  private assertRunningGraphJob(job: GraphJobRow): void {
    if (job.status !== 'running') {
      throw new GraphSnapshotError('graph_parent_conflict', `Graph job ${job.id} is no longer running`);
    }
  }

  private assertCurrentLease(job: GraphJobRow, leaseToken: string): void {
    if (leaseToken.length === 0 || job.leaseToken !== leaseToken) {
      throw new GraphSnapshotError('graph_job_in_progress', `Graph job ${job.id} is owned by another attempt`);
    }
  }

  private assertPublishJobBinding(
    job: GraphJobRow,
    candidate: PublishedCandidateIdentity,
    targetRepos: PublishGraphSnapshotCandidateInput['targetRepos'],
  ): void {
    const repos = targetRepos ?? [];
    if (job.type === 'resolve') {
      // A resolve publishes whatever batch it was given, but every entry still
      // has to name a repository the candidate actually pins.
      for (const targetRepo of repos) {
        const matches = candidate.manifest.repositories.filter(({ repoName }) => repoName === targetRepo.repoName);
        if (matches.length !== 1 || matches[0]!.repoKey !== targetRepo.repoKey) {
          identityConflict(`Resolve job ${job.id} target ${targetRepo.repoName} does not match its candidate manifest`);
        }
      }
      if (new Set(repos.map(({ repoKey }) => repoKey)).size !== repos.length) {
        identityConflict(`Resolve job ${job.id} publishes the same repository twice`);
      }
      return;
    }
    if (job.type !== 'push' || !job.repoName || repos.length !== 1) {
      identityConflict(`Push job ${job.id} requires exact repository metadata`);
    }
    const targetRepo = repos[0]!;
    const matches = candidate.manifest.repositories.filter(({ repoName }) => repoName === job.repoName);
    if (matches.length !== 1 || matches[0]!.repoKey !== targetRepo.repoKey || targetRepo.repoName !== job.repoName) {
      identityConflict(`Push job ${job.id} target does not match its candidate manifest`);
    }
  }

  /**
   * A `push` job owns exactly one repository and its target must be that
   * repository. A `resolve` job carries the batch: zero targets is the pure
   * re-resolve it has always been, and N targets replace N pinned selections in
   * a single candidate.
   */
  private assertCandidateTargets(
    job: GraphJobRow,
    input: AssembleGraphSnapshotCandidateInput,
  ): readonly GraphSnapshotCandidateTarget[] {
    const targets = input.targets ?? [];
    if (job.type === 'push') {
      if (targets.length !== 1) {
        identityConflict(`Push job ${input.jobId} requires exactly one candidate target`);
      }
      if (job.repoName !== targets[0]!.repoName) {
        identityConflict(`Job ${input.jobId} repository does not match its candidate target`);
      }
      return targets;
    }
    if (job.type !== 'resolve') {
      identityConflict(`Job ${input.jobId} type does not match its graph candidate input`);
    }
    return targets;
  }

  private exactRepoByName(repos: readonly CandidateRepoRow[], repoName: string): CandidateRepoRow {
    const matches = repos.filter((repo) => repo.repoName === repoName);
    if (matches.length !== 1) {
      identityConflict(
        matches.length === 0 ? `Repository ${repoName} is not connected` : `Repository name ${repoName} is ambiguous`,
      );
    }
    return matches[0];
  }

  private async loadParentManifest(transaction: Transaction, workspaceId: string, versionId: string) {
    const row = await transaction.workspaceGraphVersion.findUnique({
      where: { workspaceId_versionId: { workspaceId, versionId } },
      select: { workspaceId: true, versionId: true, manifest: true, r2Key: true, sha256: true, sizeBytes: true },
    });
    if (!row) identityConflict(`Active graph version ${versionId} is missing in workspace ${workspaceId}`);
    const identity = createGraphSnapshotIdentity(row.manifest);
    if (identity.versionId !== versionId || identity.manifest.workspaceId !== workspaceId) {
      identityConflict(`Active graph version ${versionId} has invalid immutable identity`);
    }
    // Artifact identity is offered, never enforced here: it exists so an
    // unchanged candidate can skip re-materializing an object that is already
    // published. A row that cannot supply a well-formed one simply withholds
    // it, and the caller rebuilds exactly as it does today — publication is
    // where artifact identity is asserted.
    const canonicalKey = row.r2Key === graphSnapshotR2Key(workspaceId, versionId);
    const usableSize = row.sizeBytes > 0n;
    return {
      manifest: identity.manifest,
      artifact:
        canonicalKey && usableSize && LOWER_SHA256.test(row.sha256)
          ? { r2Key: row.r2Key, sha256: row.sha256, sizeBytes: row.sizeBytes.toString() }
          : null,
    };
  }

  private async loadArtifact(
    transaction: Transaction,
    repo: Pick<CandidateRepoRow, 'workspaceId' | 'repoKey' | 'repoName'>,
    kind: WorkspaceRepoArtifactKind,
    version: string,
  ): Promise<WorkspaceRepoArtifactDescriptor> {
    assertVersion(kind, version);
    const row = await transaction.workspaceRepoArtifact.findUnique({
      where: {
        workspaceId_repoKey_kind_version: {
          workspaceId: repo.workspaceId,
          repoKey: repo.repoKey,
          kind,
          version,
        },
      },
    });
    if (!row) identityConflict('Exact artifact registry is incomplete for this workspace');
    const descriptor = artifactFromRow(row);
    if (
      descriptor.workspaceId !== repo.workspaceId ||
      descriptor.repoKey !== repo.repoKey ||
      descriptor.repoName !== repo.repoName ||
      descriptor.kind !== kind ||
      descriptor.version !== version
    ) {
      identityConflict(`Artifact ${repo.repoKey}/${kind}/${version} has a mismatched registry identity`);
    }
    assertWorkspaceScopedR2Key(repo.workspaceId, descriptor.r2Key);
    assertDigest(descriptor.sha256, `${kind} artifact sha256`);
    positiveBigInt(descriptor.sizeBytes, `${kind} artifact sizeBytes`);
    return descriptor;
  }

  private async firstPublishRepository(
    transaction: Transaction,
    repo: CandidateRepoRow,
    targetRepo: CandidateRepoRow | null,
    target: GraphSnapshotCandidateTarget | undefined,
  ): Promise<GraphSnapshotRepositoryManifest> {
    const selectedTarget = targetRepo?.repoKey === repo.repoKey ? target : undefined;
    const parsedVersion = selectedTarget?.parsedVersion ?? repo.lastParsedVersion;
    if (!parsedVersion) identityConflict(`Repository ${repo.repoKey} has no selected parsed artifact`);
    const summaryVersion = selectedTarget
      ? selectedTarget.summaryVersion === undefined
        ? repo.lastSummaryVersion
        : selectedTarget.summaryVersion
      : repo.lastSummaryVersion;
    const embeddingsVersion = selectedTarget
      ? selectedTarget.embeddingsVersion === undefined
        ? repo.lastEmbedVersion
        : selectedTarget.embeddingsVersion
      : repo.lastEmbedVersion;
    return {
      repoKey: repo.repoKey,
      repoName: repo.repoName,
      repoType: repo.repoType,
      httpPrefix: repo.httpPrefix,
      commitSha: selectedTarget?.commitSha ?? null,
      parsed: await this.loadArtifact(transaction, repo, 'parsed', parsedVersion),
      summary: summaryVersion ? await this.loadArtifact(transaction, repo, 'summary', summaryVersion) : null,
      embeddings: embeddingsVersion
        ? await this.loadArtifact(transaction, repo, 'embeddings', embeddingsVersion)
        : null,
    };
  }

  private async selectedRepository(
    transaction: Transaction,
    repo: CandidateRepoRow,
  ): Promise<GraphSnapshotRepositoryManifest | null> {
    if (!this.hasSelectedRepository(repo)) return null;
    return {
      repoKey: repo.repoKey,
      repoName: repo.repoName,
      repoType: repo.repoType,
      httpPrefix: repo.httpPrefix,
      commitSha: null,
      parsed: await this.loadArtifact(transaction, repo, 'parsed', repo.lastParsedVersion),
      summary: repo.lastSummaryVersion
        ? await this.loadArtifact(transaction, repo, 'summary', repo.lastSummaryVersion)
        : null,
      embeddings: repo.lastEmbedVersion
        ? await this.loadArtifact(transaction, repo, 'embeddings', repo.lastEmbedVersion)
        : null,
    };
  }

  private hasSelectedRepository(
    repo: CandidateRepoRow,
    allowLegacyTargetWithoutSelection = false,
  ): repo is CandidateRepoRow & { lastParsedVersion: string } {
    const hasAnySelection =
      repo.lastParsedVersion !== null || repo.lastSummaryVersion !== null || repo.lastEmbedVersion !== null;
    if (!hasAnySelection) {
      if (!allowLegacyTargetWithoutSelection && (repo.lastPushedAt != null || repo.lastParseHash != null)) {
        identityConflict(
          `Legacy repository ${repo.repoName} has no snapshot selections; return to Turso and re-push it or backfill it before cutover`,
        );
      }
      if (!allowLegacyTargetWithoutSelection) {
        this.logger.warn(
          `Skipping never-pushed repository ${repo.repoName} in workspace ${repo.workspaceId} while assembling a graph snapshot`,
        );
      }
      return false;
    }
    if (!repo.lastParsedVersion) {
      identityConflict(`Repository ${repo.repoKey} has selected artifacts without a parsed artifact`);
    }
    return true;
  }

  private async replacementRepository(
    transaction: Transaction,
    repo: CandidateRepoRow,
    target: GraphSnapshotCandidateTarget,
    parent: GraphSnapshotRepositoryManifest,
  ): Promise<GraphSnapshotRepositoryManifest> {
    const selectedSummary =
      target.summaryVersion === undefined
        ? parent.summary
        : target.summaryVersion === null
          ? null
          : parent.summary?.version === target.summaryVersion
            ? parent.summary
            : await this.loadArtifact(transaction, repo, 'summary', target.summaryVersion);
    const selectedEmbeddings =
      target.embeddingsVersion === undefined
        ? parent.embeddings
        : target.embeddingsVersion === null
          ? null
          : parent.embeddings?.version === target.embeddingsVersion
            ? parent.embeddings
            : await this.loadArtifact(transaction, repo, 'embeddings', target.embeddingsVersion);
    return {
      repoKey: repo.repoKey,
      repoName: repo.repoName,
      repoType: repo.repoType,
      httpPrefix: repo.httpPrefix,
      commitSha: target.commitSha ?? null,
      parsed:
        parent.parsed.version === target.parsedVersion
          ? parent.parsed
          : await this.loadArtifact(transaction, repo, 'parsed', target.parsedVersion),
      summary: selectedSummary,
      embeddings: selectedEmbeddings,
    };
  }

  private async currentMapper(
    transaction: Transaction,
    workspaceId: string,
  ): Promise<GraphSnapshotMapperDescriptor | null> {
    const row = await transaction.mapperArtifact.findUnique({
      where: { workspaceId },
      select: { r2Key: true, sha256: true, sizeBytes: true },
    });
    if (!row) return null;
    return assertMapperDescriptor(workspaceId, {
      r2Key: row.r2Key,
      sha256: row.sha256,
      sizeBytes: String(row.sizeBytes),
    });
  }

  private assertStoredVersion(
    candidate: PublishedCandidateIdentity,
    artifact: GraphArtifactIdentity,
    stored: {
      workspaceId: string;
      versionId: string;
      engine: string;
      r2Key: string;
      sha256: string;
      sizeBytes: bigint;
      storageFormatVersion: number;
      manifest: unknown;
      parentVersionId: string | null;
    } | null,
  ): void {
    if (!stored) objectConflict(`Graph version ${candidate.versionId} did not persist`);
    const storedManifest = createGraphSnapshotIdentity(stored.manifest);
    if (
      stored.workspaceId !== candidate.manifest.workspaceId ||
      stored.versionId !== candidate.versionId ||
      stored.engine !== candidate.manifest.engine ||
      stored.r2Key !== artifact.r2Key ||
      stored.sha256 !== artifact.sha256 ||
      stored.sizeBytes.toString() !== artifact.sizeBytes ||
      stored.storageFormatVersion !== candidate.manifest.storageFormatVersion ||
      stored.parentVersionId !== candidate.manifest.parentVersionId ||
      storedManifest.versionId !== candidate.versionId ||
      storedManifest.canonicalJson !== canonicalizeJson(candidate.manifest)
    ) {
      objectConflict(`Graph version ${candidate.versionId} conflicts with its immutable row`);
    }
  }
}
