/**
 * Parsers Service
 *
 * Manages parser artifact storage via Cloudflare R2 (S3-compatible)
 * with metadata tracked in the PostgreSQL control plane (ParserArtifact table).
 *
 * Upload flow:  tar.gz buffer → R2 + upsert ParserArtifact row
 * Download flow: lookup ParserArtifact → fetch from R2
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { R2StorageService } from '../../database/r2-storage.service.js';

// `repoName` comes from the URL with no DTO/pipe, and flows into the R2 object
// key (and the local-fallback filesystem path). Reject anything outside this
// charset so it can't carry `/` or `..` traversal segments. Mirrors the
// validators in result-storage.service.ts / mapper-storage.service.ts.
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SAFE_WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// =============================================================================
// Types
// =============================================================================

export interface ParserInfo {
  repoName: string;
  sha256: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  metadata: unknown;
}

export interface ParserMetaResponse {
  repoName: string;
  version: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class ParsersService {
  private readonly logger = new Logger(ParsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  /**
   * Build the R2 object key for a parser tarball. Validates both path segments
   * so user-supplied values can't escape the key namespace (or, in local
   * fallback, the filesystem store) via `/` or `..`.
   */
  private getObjectKey(workspaceId: string, repoName: string): string {
    if (!SAFE_WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new BadRequestException(`Invalid workspaceId: must match ${SAFE_WORKSPACE_ID_PATTERN}`);
    }
    if (!SAFE_NAME_PATTERN.test(repoName)) {
      throw new BadRequestException(`Invalid repoName: must match ${SAFE_NAME_PATTERN}`);
    }
    return `${workspaceId}/${repoName}/parser.tar.gz`;
  }

  /**
   * List all parsers for a workspace.
   */
  async listParsers(workspaceId: string): Promise<ParserInfo[]> {
    const artifacts = await this.prisma.parserArtifact.findMany({
      where: { workspaceId },
      orderBy: { repoName: 'asc' },
    });

    return artifacts.map((a) => ({
      repoName: a.repoName,
      sha256: a.sha256,
      sizeBytes: a.sizeBytes,
      uploadedBy: a.uploadedBy,
      uploadedAt: a.uploadedAt.toISOString(),
      metadata: a.metadata,
    }));
  }

  /**
   * Upload a parser tarball to R2 and record metadata.
   */
  async uploadParser(
    workspaceId: string,
    repoName: string,
    data: Buffer,
    uploadedBy: string,
  ): Promise<{ uploaded: true; key: string; version: string }> {
    const key = this.getObjectKey(workspaceId, repoName);
    const sha256 = createHash('sha256').update(data).digest('hex');

    this.logger.log(`Uploading parser for workspace ${workspaceId}, repo ${repoName} (${data.length} bytes)`);

    // Upload to R2
    await this.r2.upload(key, data, 'application/gzip');

    // Upsert metadata in control plane
    await this.prisma.parserArtifact.upsert({
      where: { workspaceId_repoName: { workspaceId, repoName } },
      create: {
        workspaceId,
        repoName,
        r2Key: key,
        sizeBytes: data.length,
        sha256,
        uploadedBy,
      },
      update: {
        r2Key: key,
        sizeBytes: data.length,
        sha256,
        uploadedBy,
        uploadedAt: new Date(),
      },
    });

    return { uploaded: true, key, version: sha256.slice(0, 16) };
  }

  /**
   * Download a parser tarball from R2.
   * Throws NotFoundException if no parser has been uploaded for this repo.
   */
  async downloadParser(workspaceId: string, repoName: string): Promise<Buffer> {
    const artifact = await this.prisma.parserArtifact.findUnique({
      where: { workspaceId_repoName: { workspaceId, repoName } },
    });

    if (!artifact) {
      throw new NotFoundException(
        `Parser not found for repo "${repoName}". Upload one first: coredoc parser push -r ${repoName}`,
      );
    }

    const data = await this.r2.download(artifact.r2Key);
    if (!data) {
      throw new NotFoundException(`Parser file missing in storage for repo "${repoName}"`);
    }

    return data;
  }

  /**
   * Get parser metadata without downloading the tarball.
   * Returns null if no parser has been uploaded.
   */
  async getParserMeta(workspaceId: string, repoName: string): Promise<ParserMetaResponse | null> {
    const artifact = await this.prisma.parserArtifact.findUnique({
      where: { workspaceId_repoName: { workspaceId, repoName } },
    });

    if (!artifact) return null;

    return {
      repoName: artifact.repoName,
      version: artifact.sha256.slice(0, 16),
      sizeBytes: artifact.sizeBytes,
      uploadedBy: artifact.uploadedBy,
      uploadedAt: artifact.uploadedAt.toISOString(),
    };
  }

  /**
   * Delete a parser from R2 and the control plane.
   */
  async deleteParser(workspaceId: string, repoName: string): Promise<void> {
    const artifact = await this.prisma.parserArtifact.findUnique({
      where: { workspaceId_repoName: { workspaceId, repoName } },
    });

    if (!artifact) return;

    await this.r2.delete(artifact.r2Key);
    await this.prisma.parserArtifact.delete({
      where: { id: artifact.id },
    });
  }
}
