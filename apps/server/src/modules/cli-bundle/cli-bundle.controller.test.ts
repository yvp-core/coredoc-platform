import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliBundleController } from './cli-bundle.controller.js';

function createMockService() {
  return {
    getBundleUrl: vi.fn(),
  };
}

describe('CliBundleController', () => {
  let controller: CliBundleController;
  let service: ReturnType<typeof createMockService>;

  beforeEach(() => {
    service = createMockService();
    controller = new CliBundleController(service as any);
  });

  it('returns bundle URL for default version (latest)', async () => {
    service.getBundleUrl.mockResolvedValue({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url-rt',
      version: 'v1.0.0',
      sha256: 'abc123',
    });

    const result = await controller.getBundle(undefined);

    expect(service.getBundleUrl).toHaveBeenCalledWith('latest');
    expect(result).toEqual({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url-rt',
      version: 'v1.0.0',
      sha256: 'abc123',
    });
  });

  it('passes explicit version to service', async () => {
    service.getBundleUrl.mockResolvedValue({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url-rt',
      version: 'v0.9.0',
      sha256: 'def456',
    });

    const result = await controller.getBundle('v0.9.0');

    expect(service.getBundleUrl).toHaveBeenCalledWith('v0.9.0');
    expect(result).toEqual({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url-rt',
      version: 'v0.9.0',
      sha256: 'def456',
    });
  });

  it('accepts main-sha version format', async () => {
    service.getBundleUrl.mockResolvedValue({
      url: 'https://presigned-url',
      runtimeModulesUrl: 'https://presigned-url-rt',
      version: 'main-b144af7',
      sha256: 'ghi789',
    });

    const result = await controller.getBundle('main-b144af7');

    expect(service.getBundleUrl).toHaveBeenCalledWith('main-b144af7');
    expect(result.version).toBe('main-b144af7');
  });

  it('rejects invalid version format', async () => {
    await expect(controller.getBundle('../../etc/passwd')).rejects.toThrow('Invalid version format');
    await expect(controller.getBundle('drop table')).rejects.toThrow('Invalid version format');
  });
});
