/**
 * MapperService
 *
 * Owns the lifecycle of the workspace's mapper.json artifact:
 *  - upload  → R2 + upsert MapperArtifact row (one per workspace)
 *  - load    → fetch row + content, returning EMPTY_MAPPER if absent
 *  - delete  → cascade via workspace deletion (handled by Prisma)
 *
 * The cloud workspace IS the resolution boundary; the CLI's local `projectId`
 * is not propagated to the server. CLI uses `projectId` only to locate the
 * right local `mapper.json` file before push.
 *
 * Does NOT run the resolver — that's ResolverService.
 */

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { MapperStorageService, type MapperUploadResult } from './mapper-storage.service.js';
import { validateMapper, type Mapper } from '@coredoc/core';
import { GraphSnapshotError } from '../../libs/pipeline/graph-snapshot.errors.js';

type MapperArtifactReader = {
  mapperArtifact: Pick<Prisma.TransactionClient['mapperArtifact'], 'findUnique'>;
};

/**
 * Sentinel "no mapper uploaded yet" value. The resolver only reads
 * services / sdkMappings / pathRewriteRules / unresolvableServices, so a
 * stub `project` value is sufficient for greenfield workspaces. Frozen to
 * prevent accidental mutation by callers.
 */
export const EMPTY_MAPPER: Mapper = Object.freeze({
  $schemaVersion: 1 as const,
  project: '__empty__',
  services: [],
  sdkMappings: [],
  pathRewriteRules: [],
  unresolvableServices: [],
}) as Mapper;

export interface UploadMapperResult {
  sha256: string;
  r2Key: string;
  sizeBytes: number;
  duplicate: boolean;
  artifactId: string;
}

export interface LoadMapperResult {
  mapper: Mapper;
  sha256: string | null; // null when EMPTY_MAPPER is returned
  descriptor: { r2Key: string; sha256: string; sizeBytes: string } | null;
}

@Injectable()
export class MapperService {
  private readonly logger = new Logger(MapperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MapperStorageService,
  ) {}

  private async shouldRetainGraphArtifacts(workspaceId: string): Promise<boolean> {
    try {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { retainGraphArtifacts: true },
      });
      return workspace?.retainGraphArtifacts ?? false;
    } catch (error) {
      // Deletion is irreversible. If policy cannot be read, retain the orphan
      // rather than risk removing an input pinned by an in-flight graph job.
      this.logger.warn(`Could not read artifact retention policy for ${workspaceId}; retaining mapper blobs`, error);
      return true;
    }
  }

  async uploadMapper(workspaceId: string, content: string, uploadedBy: string): Promise<UploadMapperResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');

    const existing = await this.prisma.mapperArtifact.findUnique({
      where: { workspaceId },
    });

    if (existing && existing.sha256 === sha256) {
      // Only take the duplicate fast path if the R2 blob is actually present.
      // Otherwise fall through to a fresh upload — content-addressed keys make
      // re-uploading the same content idempotent (overwrites the same key with
      // the same bytes) and repairs the missing object so subsequent reads
      // through `loadOrDefault` stop throwing.
      const blobPresent = await this.storage.objectExists(existing.r2Key).catch((err) => {
        this.logger.warn(`objectExists check failed for ${existing.r2Key}; will re-upload defensively`, err);
        return false;
      });
      if (blobPresent) {
        this.logger.log(`Mapper unchanged for ${workspaceId} (sha=${sha256.slice(0, 8)})`);
        return {
          sha256: existing.sha256,
          r2Key: existing.r2Key,
          sizeBytes: existing.sizeBytes,
          duplicate: true,
          artifactId: existing.id,
        };
      }
      this.logger.warn(
        `MapperArtifact row exists for ${workspaceId} but R2 object ${existing.r2Key} is missing — re-uploading to repair`,
      );
    }

    let uploaded: MapperUploadResult;
    try {
      uploaded = await this.storage.uploadJson(workspaceId, content);
    } catch (err) {
      this.logger.error(`R2 upload failed for ${workspaceId}`, err);
      throw new InternalServerErrorException('Failed to upload mapper to R2');
    }

    let metadata: unknown = null;
    try {
      const parsed = JSON.parse(content);
      metadata = {
        servicesCount: Array.isArray(parsed?.services) ? parsed.services.length : 0,
        sdkMappingsCount: Array.isArray(parsed?.sdkMappings) ? parsed.sdkMappings.length : 0,
      };
    } catch {
      // content already validated upstream; ignore metadata extraction failure
    }

    let artifact: { id: string };
    try {
      artifact = await this.prisma.mapperArtifact.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          r2Key: uploaded.r2Key,
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256,
          uploadedBy,
          metadata: metadata as never,
        },
        update: {
          r2Key: uploaded.r2Key,
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256,
          uploadedBy,
          metadata: metadata as never,
          uploadedAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.error(`Postgres upsert failed for mapper ${uploaded.r2Key}`, err);
      if (!(await this.shouldRetainGraphArtifacts(workspaceId))) {
        try {
          await this.storage.deleteObject(uploaded.r2Key);
        } catch (cleanupErr) {
          this.logger.error(`R2 cleanup also failed for ${uploaded.r2Key}`, cleanupErr);
        }
      }
      throw new InternalServerErrorException('Failed to persist mapper artifact metadata');
    }

    // Never-piloted Turso workspaces keep their legacy best-effort cleanup.
    // Once retention is enabled, the previous blob may be pinned by a graph
    // version or job even though this mutable pointer has moved forward.
    if (existing && existing.r2Key !== uploaded.r2Key && !(await this.shouldRetainGraphArtifacts(workspaceId))) {
      try {
        await this.storage.deleteObject(existing.r2Key);
      } catch (cleanupErr) {
        this.logger.warn(`Failed to GC previous mapper blob ${existing.r2Key} for ${workspaceId}`, cleanupErr);
      }
    }

    return {
      sha256: uploaded.sha256,
      r2Key: uploaded.r2Key,
      sizeBytes: uploaded.sizeBytes,
      duplicate: false,
      artifactId: artifact.id,
    };
  }

  async loadOrDefault(workspaceId: string, reader: MapperArtifactReader = this.prisma): Promise<LoadMapperResult> {
    const artifact = await reader.mapperArtifact.findUnique({
      where: { workspaceId },
    });

    // No artifact: greenfield workspace. EMPTY_MAPPER lets the resolver still
    // pick up descriptor-based matches without forcing a mapper upload.
    if (!artifact) {
      return { mapper: EMPTY_MAPPER, sha256: null, descriptor: null };
    }

    let canonicalKey: string;
    try {
      canonicalKey = this.storage.buildKey(workspaceId, artifact.sha256);
    } catch (error) {
      this.logger.error(`Mapper descriptor identity is invalid for workspace ${workspaceId}`, error);
      throw new GraphSnapshotError('artifact_identity_conflict', 'Current mapper descriptor is invalid', {
        cause: error,
      });
    }
    if (canonicalKey !== artifact.r2Key) {
      this.logger.error(`Mapper descriptor key is non-canonical for workspace ${workspaceId}: ${artifact.r2Key}`);
      throw new GraphSnapshotError('artifact_tenant_mismatch', 'Current mapper descriptor is not workspace-scoped');
    }

    // Artifact present but content broken: invariant failure, NOT a greenfield
    // case. Falling back to EMPTY_MAPPER here would silently rewrite workspace
    // edges using only descriptor fallback, erasing mapper-derived resolution
    // and masking the storage problem. Throw so the push response surfaces
    // `resolution.error` and the operator notices.
    const content = await this.storage.downloadJson(artifact.r2Key);
    if (!content) {
      this.logger.error(`Mapper object ${artifact.r2Key} is missing for workspace ${workspaceId}`);
      throw new GraphSnapshotError(
        'artifact_identity_conflict',
        "Current mapper object is missing; re-upload it with 'coredoc mapper push'",
      );
    }
    const contentSize = Buffer.byteLength(content);
    const contentSha = createHash('sha256').update(content).digest('hex');
    if (contentSize !== Number(artifact.sizeBytes) || contentSha !== artifact.sha256) {
      this.logger.error(`Mapper object ${artifact.r2Key} differs from its descriptor for workspace ${workspaceId}`);
      throw new GraphSnapshotError(
        'artifact_integrity_error',
        'Current mapper bytes do not match their immutable descriptor',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      this.logger.error(`Mapper object ${artifact.r2Key} is not valid JSON for workspace ${workspaceId}`, err);
      throw new GraphSnapshotError('artifact_integrity_error', 'Current mapper is not valid JSON', { cause: err });
    }
    const validation = validateMapper(parsed);
    if (!validation.ok) {
      this.logger.error(
        `Mapper object ${artifact.r2Key} failed schema validation for workspace ${workspaceId}: ${JSON.stringify(validation.errors)}`,
      );
      throw new GraphSnapshotError('artifact_integrity_error', 'Current mapper failed schema validation');
    }
    return {
      mapper: validation.mapper,
      sha256: artifact.sha256,
      descriptor: { r2Key: artifact.r2Key, sha256: artifact.sha256, sizeBytes: String(artifact.sizeBytes) },
    };
  }

  async getMetadata(workspaceId: string) {
    return this.prisma.mapperArtifact.findUnique({
      where: { workspaceId },
    });
  }

  async getRawContent(workspaceId: string): Promise<{ content: string; sha256: string } | null> {
    const artifact = await this.prisma.mapperArtifact.findUnique({
      where: { workspaceId },
    });
    if (!artifact) return null;
    const content = await this.storage.downloadJson(artifact.r2Key);
    if (!content) return null;
    return { content, sha256: artifact.sha256 };
  }
}
