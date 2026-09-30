import { parse } from 'yaml';
import { z } from 'zod';
import { type AuthConfig, authConfigFromEnv } from '../../config/app-config.js';

// Public bucket holding the notarized desktop builds and the electron-builder
// updater manifest. Configurable so on-prem installs can point at their own
// mirror (or an egress-allowed host) instead of the hosted default — see
// docs/onprem/INSTALL.md §11.
const DEFAULT_DESKTOP_RELEASES_URL = 'https://coredoc-desktop-releases.yevhen-popenko.workers.dev';
const RELEASE_REQUEST_TIMEOUT_MS = 10_000;

export class DesktopReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopReleaseError';
  }
}

function desktopReleasesUrl(auth: AuthConfig = authConfigFromEnv()): string {
  const configured = (auth.desktopReleasesUrl?.trim() || DEFAULT_DESKTOP_RELEASES_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new DesktopReleaseError('Desktop release base URL is invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DesktopReleaseError('Desktop release base URL must use HTTP or HTTPS');
  }
  return configured;
}

const releaseManifestSchema = z.object({
  files: z.array(z.object({ url: z.string() })),
});

export type MacArchitecture = 'arm64' | 'x64';

function isSafeDmgName(filename: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/.test(filename);
}

/** Resolve the latest notarized DMG without exposing the private GitHub repo. */
export async function latestMacDownloadUrl(
  architecture: MacArchitecture,
  request: typeof fetch = fetch,
): Promise<string> {
  const baseUrl = desktopReleasesUrl();
  let response: Response;
  try {
    response = await request(`${baseUrl}/latest-mac.yml`, {
      signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DesktopReleaseError(
      `Desktop release manifest request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new DesktopReleaseError(`Desktop release manifest request failed (${response.status})`);
  }

  let files: Array<{ url: string }>;
  try {
    files = releaseManifestSchema.parse(parse(await response.text())).files;
  } catch {
    throw new DesktopReleaseError('Desktop release manifest is invalid');
  }

  const dmgNames = files.map((file) => file.url).filter(isSafeDmgName);
  const filename =
    architecture === 'arm64'
      ? dmgNames.find((name) => name.endsWith('-arm64.dmg'))
      : (dmgNames.find((name) => name.endsWith('-x64.dmg')) ?? dmgNames.find((name) => !name.endsWith('-arm64.dmg')));

  if (!filename) {
    throw new DesktopReleaseError(`Desktop release manifest has no ${architecture} DMG`);
  }

  return `${baseUrl}/${filename}`;
}
