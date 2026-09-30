import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliBundleService } from './cli-bundle.service.js';

function createMockR2() {
  return {
    download: vi.fn(),
    getPresignedDownloadUrl: vi.fn(),
  };
}

describe('CliBundleService', () => {
  let service: CliBundleService;
  let r2: ReturnType<typeof createMockR2>;

  const manifest = {
    latest: 'v1.0.0',
    versions: [
      { version: 'v1.0.0', sha256: 'abc123', uploadedAt: '2026-03-31T12:00:00Z' },
      { version: 'v0.9.0', sha256: 'def456', uploadedAt: '2026-03-30T12:00:00Z' },
    ],
  };

  beforeEach(() => {
    r2 = createMockR2();
    service = new CliBundleService(r2 as any);
  });

  it('resolves "latest" to the concrete version from manifest', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    r2.getPresignedDownloadUrl.mockResolvedValue('https://presigned-url');

    const result = await service.getBundleUrl('latest');

    expect(r2.download).toHaveBeenCalledWith('cli-bundles/manifest.json');
    expect(r2.getPresignedDownloadUrl).toHaveBeenCalledWith('cli-bundles/v1.0.0/coredoc-cli.mjs', 300);
    expect(result).toEqual({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url',
      version: 'v1.0.0',
      sha256: 'abc123',
    });
  });

  it('resolves a specific version', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    r2.getPresignedDownloadUrl.mockResolvedValue('https://presigned-url');

    const result = await service.getBundleUrl('v0.9.0');

    expect(r2.getPresignedDownloadUrl).toHaveBeenCalledWith('cli-bundles/v0.9.0/coredoc-cli.mjs', 300);
    expect(result).toEqual({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url',
      version: 'v0.9.0',
      sha256: 'def456',
    });
  });

  it('throws when manifest is missing', async () => {
    r2.download.mockResolvedValue(null);

    await expect(service.getBundleUrl('latest')).rejects.toThrow('CLI bundle manifest not found');
  });

  it('throws when requested version is not in manifest', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));

    await expect(service.getBundleUrl('v99.0.0')).rejects.toThrow('CLI bundle version v99.0.0 not found');
  });

  it('throws when R2 returns null presigned URL (local dev)', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    r2.getPresignedDownloadUrl.mockResolvedValue(null);

    await expect(service.getBundleUrl('latest')).rejects.toThrow('Presigned URL generation failed');
  });

  it('includes runtimeSha256 when present in manifest entry', async () => {
    const manifestWithRuntime = {
      latest: 'v2.0.0',
      versions: [
        { version: 'v2.0.0', sha256: 'abc123', runtimeSha256: 'runtime789', uploadedAt: '2026-03-31T12:00:00Z' },
      ],
    };
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifestWithRuntime)));
    r2.getPresignedDownloadUrl.mockResolvedValue('https://presigned-url');

    const result = await service.getBundleUrl('latest');

    expect(result).toEqual({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url',
      version: 'v2.0.0',
      sha256: 'abc123',
      runtimeSha256: 'runtime789',
    });
  });

  it('omits runtimeSha256 when absent from manifest entry', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    r2.getPresignedDownloadUrl.mockResolvedValue('https://presigned-url');

    const result = await service.getBundleUrl('latest');

    expect(result).not.toHaveProperty('runtimeSha256');
  });

  it('caches manifest and reuses within TTL', async () => {
    r2.download.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    r2.getPresignedDownloadUrl.mockResolvedValue('https://presigned-url');

    await service.getBundleUrl('latest');
    await service.getBundleUrl('v0.9.0');

    expect(r2.download).toHaveBeenCalledTimes(1);
  });
});
