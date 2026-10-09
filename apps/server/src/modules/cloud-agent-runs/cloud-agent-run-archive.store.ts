import { Injectable } from '@nestjs/common';
import { R2StorageService } from '../../database/r2-storage.service.js';

/**
 * Where agent session state archives live. A port so the module's suites run
 * against memory; production writes object storage, create-only, under a new
 * key per upload.
 */
export interface CloudAgentRunArchiveStore {
  /** Create-only: a key is never overwritten. */
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Streams an archive without buffering it; aborting the signal stops the read. */
  getStream(key: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

export const CLOUD_AGENT_RUN_ARCHIVE_STORE = Symbol('CLOUD_AGENT_RUN_ARCHIVE_STORE');

@Injectable()
export class ObjectStorageArchiveStore implements CloudAgentRunArchiveStore {
  constructor(private readonly storage: R2StorageService) {}

  async put(key: string, body: Buffer): Promise<void> {
    const result = await this.storage.putBufferIfAbsent(key, body, { contentType: 'application/gzip' });
    // Keys carry a fresh uuid, so an existing object means a key collision, never a retry.
    if (result === 'already_exists') throw new Error(`State archive ${key} already exists`);
  }

  get(key: string): Promise<Buffer | null> {
    return this.storage.download(key);
  }

  getStream(key: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null> {
    return this.storage.downloadStream(key, { signal });
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }
}

export function stateArchiveKey(workspaceId: string, runId: string, turnId: string, nonce: string): string {
  return `${workspaceId}/agent-runs/${runId}/state/${turnId}-${nonce}.tar.gz`;
}
