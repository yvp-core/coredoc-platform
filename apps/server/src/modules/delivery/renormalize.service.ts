import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  GITHUB_CANONICAL_PROJECTION_VERSION,
  GithubCanonicalProjectionService,
} from './github-canonical-projection.service.js';
import { GithubCodeChangePersistenceService } from './github-code-change-persistence.service.js';
import { CODE_CHANGE_NORM_VERSION, normalizePullRequest } from './github-normalizer.js';
import { parseGithubRepo } from './github-importer.service.js';
import { unpackRawPayload } from './raw-payload-codec.js';

/** Raw-payload scan batch size (id-cursor pagination). */
const BATCH_SIZE = 200;

// Tolerant coercion helpers — the stored raw payload is UNTRUSTED (it may be a legacy
// shape, or hand-edited), so every access degrades to a safe default rather than throwing.
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Loosely-typed raw-payload row shape (only the columns this job reads). */
type RawRow = {
  id: bigint;
  connectorId: string;
  payload: unknown;
  normVersion: number | null;
  canonicalProjectionVersion: number | null;
};

/**
 * Re-runs the pure normalizer and canonical projector over independently stale stored
 * GitHub PR payloads. Normalizer staleness upgrades CodeChange columns; projection
 * staleness rebuilds typed associations/evidence without rewriting an already-current
 * CodeChange. Each version advances only after its own work succeeds.
 *
 * Truncated rows are EXCLUDED by the query — they persist only the PR envelope (no
 * reviews/files/commits), so re-normalizing them would overwrite good columns
 * (reviewRounds, changedPaths, aiAssisted, lastCommitAt…) with empty-input defaults.
 *
 * That exclusion bounds what this job can backfill: a truncated row is never revisited
 * here at all, and a non-truncated LEGACY row (stored before `envelope.prDetail` was
 * captured) normalizes to an empty detail, so its externalUrl/reviewCount/commentCount
 * stay NULL. Both cases need a provider re-fetch that stores a detail-shaped payload;
 * only the fallback title, which comes from the PR list body, backfills for every
 * non-truncated row.
 */
@Injectable()
export class RenormalizeService {
  private readonly logger = new Logger(RenormalizeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeChanges: GithubCodeChangePersistenceService,
    private readonly canonicalProjection: GithubCanonicalProjectionService,
  ) {}

  async renormalizeWorkspace(
    workspaceId: string,
    opts?: { connectorId?: string },
  ): Promise<{ scanned: number; renormalized: number; skipped: number }> {
    // Resolve owner/repo → WorkspaceRepo.id once per run (same idiom as the importer).
    const workspaceRepos = await this.prisma.workspaceRepo.findMany({ where: { workspaceId } });
    const repoIdByKey = new Map<string, string>();
    for (const wr of workspaceRepos) {
      const parsed = wr.gitUrl ? parseGithubRepo(wr.gitUrl) : null;
      if (parsed) {
        const key = `${parsed.owner}/${parsed.repo}`;
        if (!repoIdByKey.has(key)) repoIdByKey.set(key, wr.id);
      }
    }

    let scanned = 0;
    let renormalized = 0;
    let skipped = 0;
    let cursor: bigint | undefined;

    for (;;) {
      const rows = (await this.prisma.deliveryRawPayload.findMany({
        where: {
          workspaceId,
          resourceType: 'pull_request',
          // Truncated rows lack sub-resources — renormalizing would wipe good columns.
          truncated: false,
          OR: [
            { normVersion: null },
            { normVersion: { lt: CODE_CHANGE_NORM_VERSION } },
            { canonicalProjectionVersion: null },
            { canonicalProjectionVersion: { lt: GITHUB_CANONICAL_PROJECTION_VERSION } },
          ],
          ...(opts?.connectorId ? { connectorId: opts.connectorId } : {}),
          ...(cursor !== undefined ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      })) as unknown as RawRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        scanned += 1;
        cursor = row.id;
        const upgraded = await this.renormalizeRow(workspaceId, row, repoIdByKey);
        if (upgraded) renormalized += 1;
        else skipped += 1;
      }

      if (rows.length < BATCH_SIZE) break;
    }

    this.logger.debug(
      `renormalize ws=${workspaceId}: scanned=${scanned} renormalized=${renormalized} skipped=${skipped}`,
    );
    return { scanned, renormalized, skipped };
  }

  /** Renormalize one raw row. Returns true on a successful upsert, false when skipped. */
  private async renormalizeRow(workspaceId: string, row: RawRow, repoIdByKey: Map<string, string>): Promise<boolean> {
    const envelope = obj(unpackRawPayload(row.payload));
    const pr = obj(envelope.pr);
    // Prefer the stored repo key; legacy rows fall back to pr.base.repo.full_name.
    const repo = str(envelope.repo) ?? str(obj(obj(obj(envelope.pr).base).repo).full_name);
    if (!repo || Object.keys(pr).length === 0) {
      this.logger.warn(`renormalize: raw ${row.id} missing repo or pr — skipping`);
      await this.stampProcessed(row.id);
      return false;
    }

    // Legacy rows (imported before prDetail was stored) lack envelope.prDetail → obj()
    // yields {} → the normalizer derives the diff-stat counts from files/commits. Rows
    // imported after that carry the authoritative single-PR GET body.
    const norm = normalizePullRequest(
      pr,
      arr(envelope.reviews),
      arr(envelope.files),
      arr(envelope.commits),
      obj(envelope.prDetail),
      // Legacy rows written before the flag existed carry no `commitsIncomplete`; they are
      // treated as complete, which is exactly what the pass that wrote them assumed.
      envelope.commitsIncomplete === true,
    );
    if (!norm) {
      await this.stampProcessed(row.id);
      return false;
    }

    const workspaceRepoId = repoIdByKey.get(repo) ?? null;
    const codeChange = await this.codeChanges.persist({
      workspaceId,
      connectorId: row.connectorId,
      repoExternalId: repo,
      externalId: norm.externalId,
      sourceUpdatedAt: str(pr.updated_at),
      workspaceRepoId,
      norm,
      refreshEqual: row.normVersion === null || row.normVersion < CODE_CHANGE_NORM_VERSION,
    });

    await this.canonicalProjection.projectRawPayload({
      workspaceId,
      rawPayloadId: row.id,
      codeChangeId: codeChange.id,
    });

    await this.prisma.deliveryRawPayload.update({
      where: { id: row.id },
      data: { normVersion: CODE_CHANGE_NORM_VERSION, processedAt: new Date() },
    });
    return true;
  }

  /** Stamp only `processedAt` (leaving normVersion behind) for a row we could not upgrade. */
  private async stampProcessed(id: bigint): Promise<void> {
    await this.prisma.deliveryRawPayload.update({
      where: { id },
      data: { processedAt: new Date() } as Prisma.DeliveryRawPayloadUpdateInput,
    });
  }
}
