import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { R2StorageService, StorageConditionalWriteError } from '../../database/r2-storage.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ParsedRepo, SummaryOutput, EmbeddingsOutput } from '@coredoc/core/types';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';
import type { WorkspaceRepoArtifactKind } from '../../libs/pipeline/graph-snapshot.types.js';

const SAFE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SAFE_VERSION_PATTERN = /^(sum_|emb_)?[a-f0-9]{1,64}$/;
const SAFE_WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new BadRequestException(`Invalid ${label}: must match ${SAFE_NAME_PATTERN}`);
  }
}

function assertSafeVersion(value: string, label: string): void {
  if (!SAFE_VERSION_PATTERN.test(value)) {
    throw new BadRequestException(`Invalid ${label}: must be a hex string (optionally prefixed with sum_ or emb_)`);
  }
}

function assertSafeWorkspaceId(value: string): void {
  if (!SAFE_WORKSPACE_ID_PATTERN.test(value)) {
    throw new BadRequestException(`Invalid workspaceId: must match ${SAFE_WORKSPACE_ID_PATTERN}`);
  }
}

export interface Manifest {
  currentParsed: string | null;
  currentSummary: string | null;
  summaryUploadedAt: string | null;
  currentEmbeddings: string | null;
  embeddingsUploadedAt: string | null;
  commitSha: string | null;
  updatedAt: string | null;
  history: ManifestHistoryEntry[];
}

export interface ManifestHistoryEntry {
  parsed: string;
  commitSha: string | null;
  updatedAt: string;
}

export interface UploadResultResponse {
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
  duplicate: boolean;
}

export interface UploadSummaryResponse {
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
  duplicate: boolean;
}

export interface UploadEmbeddingsResponse {
  version: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
  duplicate: boolean;
}

export interface DownloadSummaryResult {
  version: string;
  summaryOutput: SummaryOutput;
  uploadedAt: string;
}

export interface GraphInputDownload<T> {
  value: T;
  /** False for readable legacy objects that cannot safely anchor an incremental diff. */
  registered: boolean;
}

@Injectable()
export class ResultStorageService {
  private readonly logger = new Logger(ResultStorageService.name);

  constructor(
    private readonly r2: R2StorageService,
    private readonly prisma: PrismaService,
  ) {}

  private async shouldRetainGraphArtifacts(workspaceId: string): Promise<boolean> {
    try {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { retainGraphArtifacts: true },
      });
      return workspace?.retainGraphArtifacts ?? false;
    } catch (error) {
      // Deletion is irreversible. If policy cannot be read, retaining an orphan
      // is safer than deleting an input pinned by an in-flight graph job.
      this.logger.warn(`Could not read artifact retention policy for ${workspaceId}; retaining parsed blobs`, error);
      return true;
    }
  }

  private async assertExistingContent(key: string, expected: Buffer): Promise<boolean> {
    // HEAD first: putImmutableContent stamps sha256+sizebytes on every object,
    // so a duplicate upload verifies against metadata without re-downloading
    // the artifact (a CI re-push of an unchanged 10MB parse was paying a full
    // GET here). Objects predating the metadata stamp fall back to the
    // byte-compare.
    const head = await this.r2.headObject(key);
    if (!head) return false;
    const storedSha = head.metadata.sha256 ?? head.metadata.SHA256 ?? null;
    if (storedSha) {
      const expectedSha = createHash('sha256').update(expected).digest('hex');
      if (storedSha !== expectedSha) {
        throw new GraphSnapshotError(
          'artifact_identity_conflict',
          'An existing truncated-version object has different immutable bytes',
        );
      }
      return true;
    }
    const existing = await this.r2.download(key);
    if (!existing) return false;
    if (!existing.equals(expected)) {
      throw new GraphSnapshotError(
        'artifact_identity_conflict',
        'An existing truncated-version object has different immutable bytes',
      );
    }
    return true;
  }

  private async putImmutableContent(
    key: string,
    expected: Buffer,
    sha256: string,
    contentType: string,
  ): Promise<boolean> {
    let outcome: 'created' | 'already_exists';
    try {
      outcome = await this.r2.putBufferIfAbsent(key, expected, {
        contentType,
        metadata: { sha256, sizebytes: String(expected.length) },
      });
    } catch (error: unknown) {
      if (!(error instanceof StorageConditionalWriteError) || error.outcome !== 'ambiguous') throw error;
      // A timed-out conditional PUT may have committed. Exact bytes prove a
      // safe duplicate; absence preserves the ambiguous error for worker retry.
      if (await this.assertExistingContent(key, expected)) return true;
      throw error;
    }

    if (outcome === 'created') return false;
    if (await this.assertExistingContent(key, expected)) return true;
    throw new GraphSnapshotError(
      'artifact_identity_conflict',
      'An existing truncated-version object disappeared during immutable verification',
    );
  }

  private async downloadGraphInput<T>(
    workspaceId: string,
    repoKey: string,
    repoName: string,
    kind: WorkspaceRepoArtifactKind,
    version: string,
    key: string,
  ): Promise<GraphInputDownload<T> | null> {
    const body = await this.r2.download(key);
    if (!body) return null;
    const descriptor = await this.prisma.workspaceRepoArtifact.findUnique({
      where: {
        workspaceId_repoKey_kind_version: { workspaceId, repoKey, kind, version },
      },
    });
    if (descriptor) {
      const actualSha256 = createHash('sha256').update(body).digest('hex');
      if (
        descriptor.workspaceId !== workspaceId ||
        descriptor.repoKey !== repoKey ||
        descriptor.repoName !== repoName ||
        descriptor.kind !== kind ||
        descriptor.version !== version ||
        descriptor.r2Key !== key ||
        descriptor.sha256 !== actualSha256 ||
        descriptor.sizeBytes !== BigInt(body.length)
      ) {
        throw new GraphSnapshotError(
          'artifact_integrity_error',
          `Registered ${kind} bytes do not match their immutable descriptor`,
        );
      }
    }
    try {
      return { value: JSON.parse(body.toString('utf8')) as T, registered: descriptor !== null };
    } catch (error) {
      throw new GraphSnapshotError('artifact_integrity_error', `Stored ${kind} input is not valid JSON`, {
        cause: error,
      });
    }
  }

  /**
   * Upload a ParsedRepo JSON to R2, returns version key.
   * Content-addressed: same content = same version = no-op.
   */
  async uploadResult(workspaceId: string, repoName: string, parsedRepo: ParsedRepo): Promise<UploadResultResponse> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const json = JSON.stringify(parsedRepo);
    const buf = Buffer.from(json, 'utf-8');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const version = sha256.slice(0, 16);
    const key = `${workspaceId}/${repoName}/results/parsed/${version}.json`;

    const duplicate = await this.putImmutableContent(key, buf, sha256, 'application/json');
    if (duplicate) {
      this.logger.log(`Result ${version} already exists for ${repoName}, skipping upload`);
      return {
        version,
        r2Key: key,
        sha256,
        sizeBytes: buf.length,
        uploadedAt: new Date().toISOString(),
        duplicate: true,
      };
    }

    this.logger.log(`Uploaded result ${version} for ${repoName} (${buf.length} bytes)`);

    return {
      version,
      r2Key: key,
      sha256,
      sizeBytes: buf.length,
      uploadedAt: new Date().toISOString(),
      duplicate: false,
    };
  }

  /**
   * Download a specific version of ParsedRepo from R2.
   */
  async downloadResult(workspaceId: string, repoName: string, version: string): Promise<ParsedRepo | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    const key = `${workspaceId}/${repoName}/results/parsed/${version}.json`;
    const buf = await this.r2.download(key);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf-8'));
  }

  async downloadResultForGraph(
    workspaceId: string,
    repoKey: string,
    repoName: string,
    version: string,
  ): Promise<GraphInputDownload<ParsedRepo> | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    return this.downloadGraphInput(
      workspaceId,
      repoKey,
      repoName,
      'parsed',
      version,
      `${workspaceId}/${repoName}/results/parsed/${version}.json`,
    );
  }

  /**
   * Read the manifest for a repo. Returns empty manifest if none exists.
   */
  async getManifest(workspaceId: string, repoName: string): Promise<Manifest> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const key = `${workspaceId}/${repoName}/results/manifest.json`;
    const buf = await this.r2.download(key);
    if (!buf) {
      return {
        currentParsed: null,
        currentSummary: null,
        summaryUploadedAt: null,
        currentEmbeddings: null,
        embeddingsUploadedAt: null,
        commitSha: null,
        updatedAt: null,
        history: [],
      };
    }
    const parsed = JSON.parse(buf.toString('utf-8'));
    // Ensure summary fields exist for manifests created before summary support
    if (!('currentSummary' in parsed)) {
      parsed.currentSummary = null;
    }
    if (!('summaryUploadedAt' in parsed)) {
      parsed.summaryUploadedAt = null;
    }
    // Ensure embeddings fields exist for manifests created before embeddings support
    if (!('currentEmbeddings' in parsed)) {
      parsed.currentEmbeddings = null;
    }
    if (!('embeddingsUploadedAt' in parsed)) {
      parsed.embeddingsUploadedAt = null;
    }
    return parsed;
  }

  /**
   * Update the manifest. Pushes current version to history, sets new current.
   * Written last after successful push (atomic swap).
   */
  async updateManifest(
    workspaceId: string,
    repoName: string,
    newVersion: string,
    commitSha: string | null,
    retainCount = 5,
  ): Promise<void> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const manifest = await this.getManifest(workspaceId, repoName);
    const now = new Date().toISOString();

    // Skip if already current (prevents same-version reruns from polluting history)
    if (manifest.currentParsed === newVersion) {
      manifest.commitSha = commitSha;
      manifest.updatedAt = now;
      const key = `${workspaceId}/${repoName}/results/manifest.json`;
      const buf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
      await this.r2.upload(key, buf, 'application/json');
      return;
    }

    // Push current to history (if exists)
    if (manifest.currentParsed) {
      manifest.history.unshift({
        parsed: manifest.currentParsed,
        commitSha: manifest.commitSha,
        updatedAt: manifest.updatedAt!,
      });
    }

    // Set new current
    manifest.currentParsed = newVersion;
    manifest.commitSha = commitSha;
    manifest.updatedAt = now;

    // Prune history beyond retainCount, but never prune the current version
    const pruned = manifest.history.splice(retainCount).filter((e) => e.parsed !== newVersion);

    // Write manifest
    const key = `${workspaceId}/${repoName}/results/manifest.json`;
    const buf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    await this.r2.upload(key, buf, 'application/json');

    if (pruned.length > 0 && (await this.shouldRetainGraphArtifacts(workspaceId))) return;

    // Never-piloted Turso workspaces retain the legacy bounded-storage behavior.
    for (const entry of pruned) {
      const oldKey = `${workspaceId}/${repoName}/results/parsed/${entry.parsed}.json`;
      try {
        await this.r2.delete(oldKey);
        this.logger.debug(`Pruned old result version ${entry.parsed}`);
      } catch {
        // Non-fatal: orphaned files are harmless
      }
    }
  }

  /**
   * Upload a SummaryOutput JSON to R2, returns version key.
   * Content-addressed: compares version against manifest to skip duplicates
   * without downloading from R2.
   */
  async uploadSummary(
    workspaceId: string,
    repoName: string,
    summaryOutput: SummaryOutput,
  ): Promise<UploadSummaryResponse> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const json = JSON.stringify(summaryOutput);
    const buf = Buffer.from(json, 'utf-8');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const version = `sum_${sha256.slice(0, 16)}`;
    const key = `${workspaceId}/${repoName}/results/summaries/${version}.json`;

    // Fast dedup: compare version string against manifest (no R2 download needed)
    const manifest = await this.getManifest(workspaceId, repoName);
    if (manifest.currentSummary === version) {
      if (await this.assertExistingContent(key, buf)) {
        this.logger.log(`Summary ${version} already current for ${repoName}, skipping upload`);
        return {
          version,
          r2Key: key,
          sha256,
          sizeBytes: buf.length,
          uploadedAt: manifest.summaryUploadedAt ?? new Date().toISOString(),
          duplicate: true,
        };
      }
    }

    const duplicate = await this.putImmutableContent(key, buf, sha256, 'application/json');
    if (!duplicate) this.logger.log(`Uploaded summary ${version} for ${repoName} (${buf.length} bytes)`);

    // Update manifest to point to current summary
    manifest.currentSummary = version;
    manifest.summaryUploadedAt = new Date().toISOString();
    const manifestKey = `${workspaceId}/${repoName}/results/manifest.json`;
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    await this.r2.upload(manifestKey, manifestBuf, 'application/json');

    return { version, r2Key: key, sha256, sizeBytes: buf.length, uploadedAt: manifest.summaryUploadedAt, duplicate };
  }

  /**
   * Download the latest SummaryOutput from R2 using the manifest pointer.
   * Returns null if no summary exists.
   */
  async downloadLatestSummary(workspaceId: string, repoName: string): Promise<DownloadSummaryResult | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const manifest = await this.getManifest(workspaceId, repoName);
    if (!manifest.currentSummary) return null;

    const version = manifest.currentSummary;
    const key = `${workspaceId}/${repoName}/results/summaries/${version}.json`;
    const buf = await this.r2.download(key);
    if (!buf) return null;

    const summaryOutput: SummaryOutput = JSON.parse(buf.toString('utf-8'));
    return {
      version,
      summaryOutput,
      uploadedAt: manifest.summaryUploadedAt ?? manifest.updatedAt ?? new Date().toISOString(),
    };
  }

  /**
   * Get a presigned URL for the latest summary, or null if not available.
   * Returns the download URL + version, or falls back to null when R2 is not configured (local dev).
   */
  async getLatestSummaryUrl(
    workspaceId: string,
    repoName: string,
  ): Promise<{ url: string; version: string; uploadedAt: string } | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const manifest = await this.getManifest(workspaceId, repoName);
    if (!manifest.currentSummary) return null;

    const version = manifest.currentSummary;
    const key = `${workspaceId}/${repoName}/results/summaries/${version}.json`;
    const url = await this.r2.getPresignedDownloadUrl(key);
    if (!url) return null; // local dev fallback — caller should use downloadLatestSummary instead

    return {
      url,
      version,
      uploadedAt: manifest.summaryUploadedAt ?? manifest.updatedAt ?? new Date().toISOString(),
    };
  }

  /**
   * Download a specific version of SummaryOutput from R2.
   */
  async downloadSummary(workspaceId: string, repoName: string, version: string): Promise<SummaryOutput | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    const key = `${workspaceId}/${repoName}/results/summaries/${version}.json`;
    const buf = await this.r2.download(key);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf-8'));
  }

  async downloadSummaryForGraph(
    workspaceId: string,
    repoKey: string,
    repoName: string,
    version: string,
  ): Promise<GraphInputDownload<SummaryOutput> | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    return this.downloadGraphInput(
      workspaceId,
      repoKey,
      repoName,
      'summary',
      version,
      `${workspaceId}/${repoName}/results/summaries/${version}.json`,
    );
  }

  /**
   * Upload an EmbeddingsOutput JSON to R2, returns version key.
   * Content-addressed: compares version against manifest to skip duplicates
   * without downloading from R2.
   */
  async uploadEmbeddings(
    workspaceId: string,
    repoName: string,
    embeddingsOutput: EmbeddingsOutput,
  ): Promise<UploadEmbeddingsResponse> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    const json = JSON.stringify(embeddingsOutput);
    const buf = Buffer.from(json, 'utf-8');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const version = `emb_${sha256.slice(0, 16)}`;
    const key = `${workspaceId}/${repoName}/results/embeddings/${version}.json`;

    // Fast dedup: compare version string against manifest (no R2 download needed)
    const manifest = await this.getManifest(workspaceId, repoName);
    if (manifest.currentEmbeddings === version) {
      if (await this.assertExistingContent(key, buf)) {
        this.logger.log(`Embeddings ${version} already current for ${repoName}, skipping upload`);
        return {
          version,
          r2Key: key,
          sha256,
          sizeBytes: buf.length,
          uploadedAt: manifest.embeddingsUploadedAt ?? new Date().toISOString(),
          duplicate: true,
        };
      }
    }

    const duplicate = await this.putImmutableContent(key, buf, sha256, 'application/json');
    if (!duplicate) this.logger.log(`Uploaded embeddings ${version} for ${repoName} (${buf.length} bytes)`);

    // Update manifest to point to current embeddings
    manifest.currentEmbeddings = version;
    manifest.embeddingsUploadedAt = new Date().toISOString();
    const manifestKey = `${workspaceId}/${repoName}/results/manifest.json`;
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    await this.r2.upload(manifestKey, manifestBuf, 'application/json');

    return { version, r2Key: key, sha256, sizeBytes: buf.length, uploadedAt: manifest.embeddingsUploadedAt, duplicate };
  }

  /**
   * Download a specific version of EmbeddingsOutput from R2.
   */
  async downloadEmbeddings(workspaceId: string, repoName: string, version: string): Promise<EmbeddingsOutput | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    const key = `${workspaceId}/${repoName}/results/embeddings/${version}.json`;
    const buf = await this.r2.download(key);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf-8'));
  }

  async downloadEmbeddingsForGraph(
    workspaceId: string,
    repoKey: string,
    repoName: string,
    version: string,
  ): Promise<GraphInputDownload<EmbeddingsOutput> | null> {
    assertSafeWorkspaceId(workspaceId);
    assertSafeName(repoName, 'repoName');
    assertSafeVersion(version, 'version');
    return this.downloadGraphInput(
      workspaceId,
      repoKey,
      repoName,
      'embeddings',
      version,
      `${workspaceId}/${repoName}/results/embeddings/${version}.json`,
    );
  }
}
