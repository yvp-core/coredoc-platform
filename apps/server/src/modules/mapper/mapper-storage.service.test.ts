import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MapperStorageService } from './mapper-storage.service.js';
import type { R2StorageService } from '../../database/r2-storage.service.js';

function createMockR2() {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
  } as unknown as R2StorageService & {
    upload: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
  };
}

describe('MapperStorageService', () => {
  let r2: ReturnType<typeof createMockR2>;
  let svc: MapperStorageService;

  beforeEach(() => {
    r2 = createMockR2();
    svc = new MapperStorageService(r2 as unknown as R2StorageService);
  });

  it('builds content-addressed R2 key as ${workspaceId}/mapper/${sha256}.json', () => {
    const wsId = '11111111-1111-1111-1111-111111111111';
    const sha = 'a'.repeat(64);
    expect(svc.buildKey(wsId, sha)).toBe(`${wsId}/mapper/${sha}.json`);
  });

  it('uploads JSON content and returns sha + content-addressed key + size', async () => {
    const wsId = '11111111-1111-1111-1111-111111111111';
    const content =
      '{"$schemaVersion":1,"project":"demo","services":[],"sdkMappings":[],"pathRewriteRules":[],"unresolvableServices":[]}';
    const expectedSha = createHash('sha256').update(content).digest('hex');
    const result = await svc.uploadJson(wsId, content);
    expect(result.r2Key).toBe(`${wsId}/mapper/${expectedSha}.json`);
    expect(result.sha256).toBe(expectedSha);
    expect(result.sizeBytes).toBe(Buffer.byteLength(content));
    expect(r2.upload).toHaveBeenCalledWith(result.r2Key, Buffer.from(content), 'application/json');
  });

  it('downloads JSON content by r2Key', async () => {
    r2.download.mockResolvedValue(Buffer.from('{"$schemaVersion":1,"project":"demo","services":[]}'));
    const content = await svc.downloadJson('ws-1/mapper/abc.json');
    expect(content).toBe('{"$schemaVersion":1,"project":"demo","services":[]}');
  });

  it('returns null for missing object', async () => {
    r2.download.mockResolvedValue(null);
    const content = await svc.downloadJson('ws-1/mapper/abc.json');
    expect(content).toBeNull();
  });

  it('rejects invalid workspaceId', () => {
    expect(() => svc.buildKey('not safe!', 'a'.repeat(64))).toThrow();
  });

  it('rejects invalid sha256', () => {
    expect(() => svc.buildKey('ws-1', 'not-a-sha')).toThrow();
  });
});
