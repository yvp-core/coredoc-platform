import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliBundleService } from './cli-bundle.service.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const RELEASES_API = 'https://api.github.com/repos/yvp-core/coredoc-platform/releases?per_page=50';
const DOWNLOAD = 'https://github.com/yvp-core/coredoc-platform/releases/download';

function release(tag: string, overrides: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false, assets: [{ name: 'cli-bundle.json' }], ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('CliBundleService', () => {
  let service: CliBundleService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let releases: unknown[];
  let descriptors: Record<string, unknown>;

  beforeEach(() => {
    releases = [
      release('v1.6.0'), // Desktop release: not a CLI bundle
      release('server-v1.1.0', { assets: [] }), // no bundle attached
      release('server-v1.0.0'),
      release('server-v0.9.0'),
    ];
    descriptors = {
      'server-v1.0.0': { version: 'v1.0.0', sha256: SHA_A, runtimeSha256: SHA_B },
      'server-v0.9.0': { version: 'v0.9.0', sha256: SHA_B },
    };
    fetchMock = vi.fn(async (url: string) => {
      if (url === RELEASES_API) return json(releases);
      const match = url.match(/\/releases\/download\/([^/]+)\/cli-bundle\.json$/);
      if (match && descriptors[match[1]]) return json(descriptors[match[1]]);
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    service = new CliBundleService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves "latest" to the newest server release that carries a bundle', async () => {
    await expect(service.getBundleUrl('latest')).resolves.toEqual({
      url: `${DOWNLOAD}/server-v1.0.0/coredoc-cli.mjs`,
      runtimeModulesUrl: `${DOWNLOAD}/server-v1.0.0/runtime-modules.tar.gz`,
      version: 'v1.0.0',
      sha256: SHA_A,
      runtimeSha256: SHA_B,
    });
  });

  it('resolves a pinned version to its server-v release without the releases API', async () => {
    const result = await service.getBundleUrl('v0.9.0');

    expect(result.url).toBe(`${DOWNLOAD}/server-v0.9.0/coredoc-cli.mjs`);
    expect(result.version).toBe('v0.9.0');
    expect(result).not.toHaveProperty('runtimeSha256');
    expect(fetchMock).not.toHaveBeenCalledWith(RELEASES_API, expect.anything());
  });

  it('skips draft and pre-release server releases for "latest"', async () => {
    releases = [release('server-v2.0.0', { draft: true }), release('server-v1.9.0', { prerelease: true }), ...releases];

    await expect(service.getBundleUrl('latest')).resolves.toMatchObject({ version: 'v1.0.0' });
  });

  it('throws NotFound for a version that was never published', async () => {
    await expect(service.getBundleUrl('v99.0.0')).rejects.toThrow('CLI bundle version v99.0.0 not found');
  });

  it('throws NotFound when no server release carries a bundle', async () => {
    releases = [release('v1.6.0')];

    await expect(service.getBundleUrl('latest')).rejects.toThrow('No published CLI bundle release');
  });

  it('rejects a malformed descriptor', async () => {
    descriptors['server-v1.0.0'] = { version: 'v1.0.0', sha256: 'not-a-sha' };

    await expect(service.getBundleUrl('v1.0.0')).rejects.toThrow('CLI bundle descriptor is invalid');
  });

  it('caches the latest tag and immutable descriptors', async () => {
    await service.getBundleUrl('latest');
    await service.getBundleUrl('latest');
    await service.getBundleUrl('v1.0.0');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the cached latest tag when GitHub is unavailable', async () => {
    vi.useFakeTimers();
    try {
      await service.getBundleUrl('latest');
      vi.advanceTimersByTime(11 * 60_000);
      fetchMock.mockImplementationOnce(async () => new Response('', { status: 503 }));

      await expect(service.getBundleUrl('latest')).resolves.toMatchObject({ version: 'v1.0.0' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unavailability when GitHub fails with nothing cached', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 503 }));

    await expect(service.getBundleUrl('latest')).rejects.toThrow('CLI bundle releases are unavailable');
  });
});
