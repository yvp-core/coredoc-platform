import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { R2StorageService } from '../../database/r2-storage.service.js';

interface BundleManifest {
  latest: string;
  versions: Array<{ version: string; sha256: string; runtimeSha256?: string; uploadedAt: string }>;
}

export interface BundleUrlResult {
  url: string;
  runtimeModulesUrl: string;
  version: string;
  sha256: string;
  runtimeSha256?: string;
}

const MANIFEST_CACHE_TTL_MS = 60_000;

@Injectable()
export class CliBundleService {
  private readonly logger = new Logger(CliBundleService.name);
  private cachedManifest: { data: BundleManifest; fetchedAt: number } | null = null;

  constructor(private readonly r2: R2StorageService) {}

  private async getManifest(): Promise<BundleManifest> {
    if (this.cachedManifest && Date.now() - this.cachedManifest.fetchedAt < MANIFEST_CACHE_TTL_MS) {
      return this.cachedManifest.data;
    }

    const manifestBuf = await this.r2.download('cli-bundles/manifest.json');
    if (!manifestBuf) {
      throw new NotFoundException('CLI bundle manifest not found');
    }

    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(manifestBuf.toString());
    } catch {
      throw new InternalServerErrorException('CLI bundle manifest is corrupted');
    }
    if (!manifest.latest || !Array.isArray(manifest.versions)) {
      throw new InternalServerErrorException('CLI bundle manifest has invalid structure');
    }
    this.cachedManifest = { data: manifest, fetchedAt: Date.now() };
    return manifest;
  }

  async getBundleUrl(requestedVersion: string): Promise<BundleUrlResult> {
    const manifest = await this.getManifest();

    const version = requestedVersion === 'latest' ? manifest.latest : requestedVersion;

    const entry = manifest.versions.find((v) => v.version === version);
    if (!entry) {
      throw new NotFoundException(`CLI bundle version ${version} not found`);
    }

    const bundleKey = `cli-bundles/${version}/coredoc-cli.mjs`;
    const runtimeKey = `cli-bundles/${version}/runtime-modules.tar.gz`;

    const PRESIGNED_URL_TTL_SECONDS = 300;
    const [url, runtimeModulesUrl] = await Promise.all([
      this.r2.getPresignedDownloadUrl(bundleKey, PRESIGNED_URL_TTL_SECONDS),
      this.r2.getPresignedDownloadUrl(runtimeKey, PRESIGNED_URL_TTL_SECONDS),
    ]);

    if (!url || !runtimeModulesUrl) {
      throw new InternalServerErrorException('Presigned URL generation failed — R2 may not be configured');
    }

    this.logger.log(`Serving CLI bundle ${version} (sha256: ${entry.sha256.slice(0, 8)}...)`);

    return {
      url,
      runtimeModulesUrl,
      version,
      sha256: entry.sha256,
      ...(entry.runtimeSha256 && { runtimeSha256: entry.runtimeSha256 }),
    };
  }
}
