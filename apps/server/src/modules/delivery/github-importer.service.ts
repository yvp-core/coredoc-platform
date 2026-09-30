import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, Prisma } from '../../generated/prisma/client.js';
import { decrypt, isEncryptionAvailable } from '../../database/encryption.js';
import {
  GithubAuthError,
  GithubClient,
  GithubRateLimitError,
  type GithubPr,
  normalizeGithubBaseUrl,
} from '../../libs/github/github-client.js';
import { GithubCanonicalProjectionService } from './github-canonical-projection.service.js';
import {
  GithubCodeChangePersistenceService,
  codeChangeFieldsFromNorm,
} from './github-code-change-persistence.service.js';
import { CODE_CHANGE_NORM_VERSION, normalizePullRequest } from './github-normalizer.js';
import { resolveWindowStart } from './ingest-window.js';
import { packRawPayload } from './raw-payload-codec.js';

type ClientFactory = (token: string, baseUrl?: string) => GithubClient;

/**
 * Optional DI token for a custom GithubClient factory. No provider registers it,
 * so Nest resolves the `@Optional()` param to undefined and the default factory
 * (real GithubClient) is used. A named token is required because a bare optional
 * `clientFactory?: ClientFactory` emits paramtype `Function`, which Nest treats as
 * an unresolvable token and refuses to construct the service at boot.
 */
export const GITHUB_CLIENT_FACTORY = Symbol('GITHUB_CLIENT_FACTORY');

/**
 * Parse an `owner/repo` pair from a GitHub git URL (https or ssh, with or without
 * `.git`). Mirrors source.service's regex so cross-repo matching stays consistent.
 */
export function parseGithubRepo(gitUrl: string): { owner: string; repo: string } | null {
  const match = gitUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** ISO string -> Date, or null for absent/unparseable input. */
function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Pure norm→Prisma-fields mapping shared by the live importer (`ingestPull`) and the
 * `renormalize` job so both write identical CodeChange columns. `sourceUpdatedAt` is
 * stamped into attrs so the importer's boundary skip can recognize an already-current
 * row; the caller supplies it (the PR's `updated_at`).
 */
export { codeChangeFieldsFromNorm };

interface RepoTarget {
  owner: string;
  repo: string;
  key: string; // `owner/repo`
}

export interface GithubSyncResult {
  repos: number;
  prs: number;
  /**
   * BR-1: targets whose pull requests were ingested while no workspace repo carries an
   * `intentRepoKey` for them — the same condition `GithubIntentReleaseService.apply`
   * refuses on. Empty means every ingested target was linked.
   */
  unlinkedRepos: { repo: string; prs: number }[];
}

@Injectable()
export class GithubImporterService {
  private readonly logger = new Logger(GithubImporterService.name);
  private readonly clientFactory: ClientFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeChanges: GithubCodeChangePersistenceService,
    private readonly canonicalProjection: GithubCanonicalProjectionService,
    @Optional() @Inject(GITHUB_CLIENT_FACTORY) clientFactory?: ClientFactory,
  ) {
    this.clientFactory = clientFactory ?? ((token, baseUrl) => new GithubClient({ token, baseUrl }));
  }

  /**
   * Pull a GitHub connector's repos up to date: for each target repo, fetch PRs
   * updated since the stored cursor, persist raw payloads + normalized code changes,
   * and advance the cursor. Per-repo failures are isolated (logged, other repos
   * continue); auth/rate-limit failures rethrow so the job queue backs off.
   */
  async syncConnector(connectorId: string): Promise<GithubSyncResult> {
    // A missing connector is permanent (e.g. deleted between enqueue and run) —
    // throw NotFoundException so the worker fails the job immediately rather than
    // burning retries. Prisma's own P2025 is not a NotFoundException, so we check
    // for null explicitly rather than relying on findUniqueOrThrow.
    const connector = await this.prisma.deliveryConnector.findUnique({
      where: { id: connectorId },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${connectorId} not found`);
    }

    if (connector.provider !== DeliveryProvider.github) {
      throw new BadRequestException(
        `Connector ${connectorId} is not a github connector (provider=${connector.provider})`,
      );
    }

    let baseUrl: string | undefined;
    try {
      baseUrl = connector.baseUrl === null ? undefined : normalizeGithubBaseUrl(connector.baseUrl);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid GitHub baseUrl');
    }
    const token = this.resolveToken(connector.credentialsEncrypted, connectorId);
    const client = this.clientFactory(token, baseUrl);

    // Load the workspace's repos once — used both to derive the repo list (when
    // config.repos is empty) and to resolve workspaceRepoId per repo.
    const workspaceRepos = await this.prisma.workspaceRepo.findMany({
      where: { workspaceId: connector.workspaceId },
    });
    const repoIdByKey = new Map<string, string>();
    // Keys whose WorkspaceRepo carries an intentRepoKey — a repo linked for delivery but
    // without that key still gets no intent event, so it counts as unlinked for BR-1.
    const intentLinkedKeys = new Set<string>();
    for (const wr of workspaceRepos) {
      const parsed = wr.gitUrl ? parseGithubRepo(wr.gitUrl) : null;
      if (parsed) {
        const key = `${parsed.owner}/${parsed.repo}`;
        // First matching WorkspaceRepo wins — deterministic under duplicates.
        if (!repoIdByKey.has(key)) {
          repoIdByKey.set(key, wr.id);
          if (wr.intentRepoKey) intentLinkedKeys.add(key);
        }
      }
    }

    const targets = this.resolveTargets(connector.config, repoIdByKey);
    if (targets.length === 0) return { repos: 0, prs: 0, unlinkedRepos: [] };

    // Ingest floor: the connector's absolute `config.since` when set, else the relative
    // lookback window (default 30 days). Applied only on a FIRST/backfill sync via
    // `cursor ?? windowStart` below — NEVER max(cursor, windowStart), which would push
    // `since` past unimported PRs in a quiet gap and silently drop them. Bound on
    // updated_at (the same field the cursor uses); the client's strict-`<` updated_at
    // cutoff already bounds the boundary, so no github-client change is needed.
    const windowStart = resolveWindowStart(connector.config);

    // Cursors accumulate in memory and are flushed after every repo so partial
    // progress survives a mid-sync failure.
    const cursors: Record<string, unknown> = { ...this.asRecord(connector.cursors) };
    const persist = () =>
      this.prisma.deliveryConnector.update({
        where: { id: connectorId },
        data: { cursors: { ...cursors } as Prisma.InputJsonValue, lastSyncAt: new Date() },
      });

    let reposSynced = 0;
    let prsSynced = 0;
    const unlinkedRepos: { repo: string; prs: number }[] = [];

    for (const target of targets) {
      const cursorKey = `pr:${target.owner}/${target.repo}`;
      const workspaceRepoId = repoIdByKey.get(target.key) ?? null;
      let prsFromTarget = 0;
      try {
        // Backfill floor: with no stored cursor, bound the fetch to the window; once a
        // cursor exists it wins outright (window inert). Never max() — see windowStart.
        const cursor = this.validSince(cursors[cursorKey], cursorKey);
        const since = cursor ?? windowStart;
        const newestFirst = await client.listPullsUpdatedSince(target.owner, target.repo, since);
        const ascending = [...newestFirst].reverse(); // oldest updated first

        for (const pr of ascending) {
          const advanced = await this.ingestPull(client, connector, target, workspaceRepoId, pr, since);
          if (advanced) {
            prsSynced += 1;
            prsFromTarget += 1;
            cursors[cursorKey] = advanced;
          }
        }
        reposSynced += 1;
      } catch (err) {
        // Auth and rate-limit failures are job-level: they abort the whole sync.
        // An auth failure (bad/expired PAT) is PERMANENT — rethrow as
        // BadRequestException so the worker fails the job immediately instead of
        // burning backoff attempts on a credential that cannot self-heal. The
        // GithubAuthError message is path+status only (no token), so it is safe to
        // surface. A rate-limit failure is TRANSIENT by design — rethrow as-is so
        // the queue backs off and retries. Everything else is per-repo: log and
        // continue with the next repo.
        if (err instanceof GithubAuthError) {
          throw new BadRequestException(`GitHub auth failed for connector ${connectorId}: ${err.message}`);
        }
        if (err instanceof GithubRateLimitError) {
          throw err;
        }
        this.logger.error(`github import: repo ${target.key} failed — ${(err as Error)?.message ?? err}`);
      } finally {
        // BR-1: report a target only when this sync actually ingested from it.
        if (prsFromTarget > 0 && !intentLinkedKeys.has(target.key)) {
          unlinkedRepos.push({ repo: target.key, prs: prsFromTarget });
        }
        // Runs on success, per-repo continue, AND the auth/rate-limit rethrow path
        // (before the exception propagates) — cursors are never lost.
        await persist();
      }
    }

    return { repos: reposSynced, prs: prsSynced, unlinkedRepos };
  }

  /**
   * Fetch a PR's sub-resources, store the raw payload, normalize, and upsert the
   * code change. Returns the PR's `updated_at` (cursor advance) on success, or
   * null when the PR is unindexable (no usable number).
   */
  private async ingestPull(
    client: GithubClient,
    connector: { id: string; workspaceId: string },
    target: RepoTarget,
    workspaceRepoId: string | null,
    pr: GithubPr,
    since: string | null,
  ): Promise<string | null> {
    const number = typeof pr.number === 'number' ? pr.number : Number(pr.number);
    if (!Number.isFinite(number)) {
      this.logger.warn(`github import: ${target.key} PR with no usable number — skipping`);
      return null;
    }
    const externalId = String(number);

    // Bounded-growth fix: listPullsUpdatedSince re-includes PRs whose updated_at
    // EQUALS the since-cursor (strict `<`), so every scheduled sync with no activity
    // refetches the boundary PR. Without this skip, deliveryRawPayload.create would
    // append one duplicate raw row per repo on every sync forever (no raw-retention
    // cron exists yet). Skip a boundary PR only when the stored row is already at this
    // exact source freshness. Same-second SIBLINGS never processed (row absent or an
    // older sourceUpdatedAt) still flow through — preserving the strict-< correctness
    // that motivated the boundary re-inclusion.
    const isBoundary =
      since !== null &&
      typeof pr.updated_at === 'string' &&
      new Date(pr.updated_at).getTime() === new Date(since).getTime();
    if (isBoundary) {
      const existing = await this.prisma.codeChange.findUnique({
        where: {
          workspaceId_provider_repoExternalId_externalId: {
            workspaceId: connector.workspaceId,
            provider: DeliveryProvider.github,
            repoExternalId: target.key,
            externalId,
          },
        },
      });
      if (existing && this.asRecord(existing.attrs).sourceUpdatedAt === pr.updated_at) {
        return null; // already current — no raw row, no upsert, no cursor change
      }
    }

    const [prDetail, reviews, files, commitList] = await Promise.all([
      // Single-PR GET: the ONLY source of the diff-stat fields (additions/deletions/
      // changed_files/commits/review_comments) — the PR list payload that drives this
      // sync omits them. Stored in the envelope so renormalize stays authoritative.
      client.getPull(target.owner, target.repo, number),
      client.listReviews(target.owner, target.repo, number),
      client.listFiles(target.owner, target.repo, number),
      client.listCommits(target.owner, target.repo, number),
    ]);

    // One raw row per PR. The full envelope carries `repo` (the owner/repo key) so the
    // renormalize job can resolve the code change without re-deriving it. Oversized
    // payloads keep only the PR plus repository/completeness identity so the row stays
    // bounded while still recording the fetch (renormalize excludes them because they
    // lack sub-resources).
    const commits = commitList.items;
    const full = { pr, prDetail, reviews, files, commits, commitsIncomplete: commitList.incomplete, repo: target.key };
    const { payload, truncated } = packRawPayload(full, {
      pr,
      repo: target.key,
      // The omitted sub-resources are definitionally incomplete. Keeping this
      // explicit prevents a future projector from treating the bounded fallback
      // as a complete empty commit list.
      commitsIncomplete: true,
    });
    const rawPayload = await this.prisma.deliveryRawPayload.create({
      data: {
        workspaceId: connector.workspaceId,
        connectorId: connector.id,
        resourceType: 'pull_request',
        externalId: String(number),
        payload: payload as unknown as Prisma.InputJsonValue,
        truncated,
        normVersion: CODE_CHANGE_NORM_VERSION,
      },
    });

    const norm = normalizePullRequest(
      pr as Record<string, unknown>,
      reviews,
      files,
      commits,
      prDetail,
      commitList.incomplete,
    );
    if (!norm) return null; // number vanished in normalization — nothing to index

    // Stamp source freshness so the boundary skip above can recognize an
    // already-current row on the next sync.
    const codeChange = await this.codeChanges.persist({
      workspaceId: connector.workspaceId,
      connectorId: connector.id,
      repoExternalId: target.key,
      externalId: norm.externalId,
      sourceUpdatedAt: typeof pr.updated_at === 'string' ? pr.updated_at : undefined,
      workspaceRepoId,
      norm,
    });

    await this.canonicalProjection.projectRawPayload({
      workspaceId: connector.workspaceId,
      rawPayloadId: rawPayload.id,
      codeChangeId: codeChange.id,
    });

    // Advance the cursor to this PR's updated_at after the successful upsert.
    const raw = typeof pr.updated_at === 'string' ? pr.updated_at : undefined;
    return toDate(raw) !== null ? (raw as string) : null;
  }

  /** Decrypt the PAT, or throw a permanent BadRequestException when unusable. */
  private resolveToken(credentialsEncrypted: string | null, connectorId: string): string {
    if (!isEncryptionAvailable() || credentialsEncrypted == null) {
      throw new BadRequestException(
        `Connector ${connectorId} has no usable credentials (encryption unavailable or column null)`,
      );
    }
    try {
      return decrypt(credentialsEncrypted);
    } catch (err) {
      throw new BadRequestException(
        `Connector ${connectorId} credentials could not be decrypted: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Repo list: `config.repos` (owner/repo strings) when non-empty, else derive
   * from the workspace's github WorkspaceRepos. Both paths are deduplicated by key.
   */
  private resolveTargets(config: unknown, repoIdByKey: Map<string, string>): RepoTarget[] {
    const cfg = this.asRecord(config);
    const configRepos = Array.isArray(cfg.repos)
      ? cfg.repos.filter((r): r is string => typeof r === 'string' && r.includes('/'))
      : [];

    const keys = configRepos.length > 0 ? configRepos : [...repoIdByKey.keys()];

    const seen = new Set<string>();
    const targets: RepoTarget[] = [];
    for (const key of keys) {
      const [owner, repo] = key.split('/');
      if (!owner || !repo) continue;
      const normalizedKey = `${owner}/${repo}`;
      if (seen.has(normalizedKey)) continue;
      seen.add(normalizedKey);
      targets.push({ owner, repo, key: normalizedKey });
    }
    return targets;
  }

  /**
   * Cursor-validity guard: a stored cursor is a valid since-value only if it is a
   * string parseable to a finite date. Anything else (corrupt/legacy) logs a
   * warning and yields null — a full, idempotent refetch.
   */
  private validSince(value: unknown, cursorKey: string): string | null {
    if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) {
      return value;
    }
    if (value !== undefined && value !== null) {
      this.logger.warn(`github import: ignoring corrupt cursor ${cursorKey}=${JSON.stringify(value)} — full refetch`);
    }
    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
