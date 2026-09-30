import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopReleaseError, latestMacDownloadUrl } from './desktop-release.js';

const manifest = `version: 1.1.0
files:
- url: Coredoc-1.1.0-arm64.dmg
- url: Coredoc-1.1.0.dmg
`;

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('latestMacDownloadUrl', () => {
  const originalReleasesUrl = process.env.DESKTOP_RELEASES_URL;

  beforeEach(() => {
    delete process.env.DESKTOP_RELEASES_URL;
  });

  afterEach(() => {
    if (originalReleasesUrl === undefined) delete process.env.DESKTOP_RELEASES_URL;
    else process.env.DESKTOP_RELEASES_URL = originalReleasesUrl;
  });

  it.each([
    ['arm64', 'Coredoc-1.1.0-arm64.dmg'],
    ['x64', 'Coredoc-1.1.0.dmg'],
  ] as const)('resolves the latest %s DMG from the public updater manifest', async (architecture, filename) => {
    const request = vi.fn().mockResolvedValue(response(manifest));

    await expect(latestMacDownloadUrl(architecture, request)).resolves.toBe(
      `https://coredoc-desktop-releases.yevhen-popenko.workers.dev/${filename}`,
    );
    expect(request).toHaveBeenCalledWith(
      'https://coredoc-desktop-releases.yevhen-popenko.workers.dev/latest-mac.yml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects external or path-based asset names from the manifest', async () => {
    const unsafeManifest = `files:\n- url: https://attacker.example/Coredoc-arm64.dmg\n- url: ../Coredoc.dmg\n`;

    await expect(latestMacDownloadUrl('arm64', vi.fn().mockResolvedValue(response(unsafeManifest)))).rejects.toThrow(
      DesktopReleaseError,
    );
  });

  it('rejects a failed manifest request', async () => {
    await expect(latestMacDownloadUrl('x64', vi.fn().mockResolvedValue(response('', 503)))).rejects.toThrow(
      'manifest request failed (503)',
    );
  });

  it('uses a configured mirror and trims trailing slashes', async () => {
    process.env.DESKTOP_RELEASES_URL = 'https://mirror.example.test/releases///';
    const request = vi.fn().mockResolvedValue(response(manifest));

    await expect(latestMacDownloadUrl('arm64', request)).resolves.toBe(
      'https://mirror.example.test/releases/Coredoc-1.1.0-arm64.dmg',
    );
    expect(request).toHaveBeenCalledWith(
      'https://mirror.example.test/releases/latest-mac.yml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects a non-HTTP release mirror', async () => {
    process.env.DESKTOP_RELEASES_URL = 'file:///tmp/releases';
    await expect(latestMacDownloadUrl('arm64', vi.fn())).rejects.toThrow('must use HTTP or HTTPS');
  });
});
