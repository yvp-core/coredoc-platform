/**
 * MapperStorageService
 *
 * R2 ops for the workspace mapper.json blob. One mapper per workspace — the
 * server treats the cloud workspace as the resolution boundary; CLI-side
 * project IDs are not propagated.
 *
 * Keys are content-addressed: `${workspaceId}/mapper/${sha256}.json`. New
 * uploads write a NEW blob; the Postgres MapperArtifact row is the atomic
 * pointer that flips from old → new. Rolling back a failed upsert therefore
 * deletes only the freshly-written blob — the previous mapper stays intact
 * at its own key. Eliminates both the "rollback destroys existing mapper"
 * failure mode and the concurrent-upload race where two writers clobber the
 * same key.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { R2StorageService } from '../../database/r2-storage.service.js';

const SAFE_WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface MapperUploadResult {
  r2Key: string;
  sha256: string;
  sizeBytes: number;
}

@Injectable()
export class MapperStorageService {
  private readonly logger = new Logger(MapperStorageService.name);

  constructor(private readonly r2: R2StorageService) {}

  buildKey(workspaceId: string, sha256: string): string {
    if (!SAFE_WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new BadRequestException(`Invalid workspaceId: must match ${SAFE_WORKSPACE_ID_PATTERN}`);
    }
    if (!SHA256_PATTERN.test(sha256)) {
      throw new BadRequestException('Invalid sha256: must be a 64-char hex string');
    }
    return `${workspaceId}/mapper/${sha256}.json`;
  }

  async uploadJson(workspaceId: string, content: string): Promise<MapperUploadResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const r2Key = this.buildKey(workspaceId, sha256);
    const sizeBytes = Buffer.byteLength(content);
    await this.r2.upload(r2Key, Buffer.from(content), 'application/json');
    this.logger.log(`Uploaded mapper for ${workspaceId} (${sizeBytes} bytes, sha=${sha256.slice(0, 8)})`);
    return { r2Key, sha256, sizeBytes };
  }

  async downloadJson(r2Key: string): Promise<string | null> {
    const buf = await this.r2.download(r2Key);
    if (!buf) return null;
    return buf.toString('utf-8');
  }

  async objectExists(r2Key: string): Promise<boolean> {
    return this.r2.exists(r2Key);
  }

  async deleteObject(r2Key: string): Promise<void> {
    await this.r2.delete(r2Key);
  }
}
