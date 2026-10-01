import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

// release.yml attaches coredoc-cli.mjs, runtime-modules.tar.gz and
// cli-bundle.json to each `server-v<semver>` GitHub Release. `/releases/latest`
// belongs to Desktop, so "latest" is resolved by listing releases.
const RELEASES_REPO = 'yvp-core/coredoc-platform';
const RELEASE_TAG_PREFIX = 'server-v';
const DESCRIPTOR_ASSET = 'cli-bundle.json';
// The unauthenticated GitHub API allows 60 requests/hour per IP.
const LATEST_CACHE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface BundleUrlResult {
  url: string;
  runtimeModulesUrl: string;
  version: string;
  sha256: string;
  runtimeSha256?: string;
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+(-[\w.]+)?$/),
  sha256: sha256Hex,
  runtimeSha256: sha256Hex.optional(),
});
type BundleDescriptor = z.infer<typeof descriptorSchema>;

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string() })),
  }),
);

@Injectable()
export class CliBundleService {
  private readonly logger = new Logger(CliBundleService.name);
  private latest: { tag: string; fetchedAt: number } | null = null;
  // Release assets are immutable per tag, so a descriptor never expires.
  private readonly descriptors = new Map<string, BundleDescriptor>();

  async getBundleUrl(requestedVersion: string): Promise<BundleUrlResult> {
    const tag =
      requestedVersion === 'latest' ? await this.latestTag() : `${RELEASE_TAG_PREFIX}${requestedVersion.slice(1)}`;
    const descriptor = await this.descriptor(tag, requestedVersion);
    const base = `https://github.com/${RELEASES_REPO}/releases/download/${tag}`;

    this.logger.log(`Serving CLI bundle ${descriptor.version} (sha256: ${descriptor.sha256.slice(0, 8)}...)`);

    return {
      url: `${base}/coredoc-cli.mjs`,
      runtimeModulesUrl: `${base}/runtime-modules.tar.gz`,
      version: descriptor.version,
      sha256: descriptor.sha256,
      ...(descriptor.runtimeSha256 && { runtimeSha256: descriptor.runtimeSha256 }),
    };
  }

  private async latestTag(): Promise<string> {
    if (this.latest && Date.now() - this.latest.fetchedAt < LATEST_CACHE_TTL_MS) {
      return this.latest.tag;
    }

    let releases: z.infer<typeof releasesSchema>;
    try {
      const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=50`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'coredoc-server' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);
      releases = releasesSchema.parse(await response.json());
    } catch (error) {
      // A stale answer beats an outage: the previous latest is still a valid release.
      if (this.latest) {
        this.logger.warn(`Using cached latest CLI bundle: ${error instanceof Error ? error.message : String(error)}`);
        return this.latest.tag;
      }
      throw new ServiceUnavailableException('CLI bundle releases are unavailable');
    }

    const release = releases.find(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        r.tag_name.startsWith(RELEASE_TAG_PREFIX) &&
        r.assets.some((asset) => asset.name === DESCRIPTOR_ASSET),
    );
    if (!release) {
      throw new NotFoundException('No published CLI bundle release');
    }
    this.latest = { tag: release.tag_name, fetchedAt: Date.now() };
    return release.tag_name;
  }

  private async descriptor(tag: string, requestedVersion: string): Promise<BundleDescriptor> {
    const cached = this.descriptors.get(tag);
    if (cached) return cached;

    let response: Response;
    try {
      response = await fetch(`https://github.com/${RELEASES_REPO}/releases/download/${tag}/${DESCRIPTOR_ASSET}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('CLI bundle releases are unavailable');
    }
    if (response.status === 404) {
      throw new NotFoundException(`CLI bundle version ${requestedVersion} not found`);
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`CLI bundle descriptor request failed (${response.status})`);
    }

    const parsed = descriptorSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ServiceUnavailableException('CLI bundle descriptor is invalid');
    }
    this.descriptors.set(tag, parsed.data);
    return parsed.data;
  }
}
