import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CodeChangeState, DeliveryProvider, Prisma } from '../../generated/prisma/client.js';
import type { NormalizedCodeChange } from './github-normalizer.js';
import { asRecord as record, toDate } from '../../libs/coerce.js';

const CONCURRENT_WRITE_RETRY_LIMIT = 1;

type AppliedDisposition = 'created' | 'updated' | 'stale' | 'duplicate';

interface PersistGithubCodeChangeInput {
  workspaceId: string;
  connectorId: string;
  repoExternalId: string;
  externalId: string;
  sourceUpdatedAt: string | undefined;
  workspaceRepoId: string | null;
  norm: NormalizedCodeChange;
  /** Reapply equal-freshness data only when an older normalizer version is being upgraded. */
  refreshEqual?: boolean;
}

function toEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function isConcurrentWrite(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === 'P2034';
}

/**
 * Pure norm-to-Prisma mapping shared by live import and raw replay so both paths
 * persist identical CodeChange facts.
 */
export function codeChangeFieldsFromNorm(
  norm: NormalizedCodeChange,
  sourceUpdatedAt: string | undefined,
  workspaceRepoId: string | null,
) {
  return {
    workspaceRepoId,
    number: norm.number ?? null,
    title: norm.title ?? null,
    sourceBranch: norm.sourceBranch ?? null,
    targetBranch: norm.targetBranch ?? null,
    state: norm.state as CodeChangeState,
    isDraft: norm.isDraft,
    createdAtSource: toDate(norm.createdAtSource),
    readyForReviewAt: toDate(norm.readyForReviewAt),
    firstReviewAt: toDate(norm.firstReviewAt),
    approvedAt: toDate(norm.approvedAt),
    mergedAt: toDate(norm.mergedAt),
    closedAt: toDate(norm.closedAt),
    lastCommitAt: toDate(norm.lastCommitAt),
    commitsCount: norm.commitsCount ?? null,
    additions: norm.additions ?? null,
    deletions: norm.deletions ?? null,
    changedFiles: norm.changedFiles ?? null,
    changedPaths: norm.changedPaths,
    reviewRounds: norm.reviewRounds,
    reviewComments: norm.reviewComments,
    aiAssisted: norm.aiAssisted ?? null,
    // externalUrl/reviewCount/commentCount are detail-only normalizer fields (see
    // github-normalizer.ts). `?? null` preserves the LIST-shaped absence as a genuine
    // NULL column rather than a fabricated 0/"" — a real zero from the detail payload
    // survives untouched because `0 ?? null` is `0`.
    externalUrl: norm.externalUrl ?? null,
    reviewCount: norm.reviewCount ?? null,
    commentCount: norm.commentCount ?? null,
    attrs: {
      ...norm.attrs,
      sourceUpdatedAt,
    } as unknown as Prisma.InputJsonValue,
  };
}

/**
 * The UPDATE payload: the same fields, minus the detail-only trio when this pass never
 * saw the single-PR GET body (`norm.detailShaped === false`).
 *
 * Unlike additions/deletions there is no files/commits sub-resource to derive these from,
 * so a LIST-shaped write would NULL an already-established externalUrl/reviewCount/
 * commentCount outright — total loss until some future pass happens to fetch the detail
 * again (GithubClient.getPull degrades to `{}` on a transient error or a 404). Omitting
 * the keys leaves the established values untouched; CREATE still writes their nulls,
 * because there is nothing to preserve on a first observation.
 *
 * The decision reads the normalizer's own detail-presence signal rather than inferring it
 * from three nulls: a detail body that genuinely carries zero comments and zero reviews is
 * an observation, and must be allowed to overwrite.
 */
export function codeChangeUpdateFieldsFromNorm(
  norm: NormalizedCodeChange,
  sourceUpdatedAt: string | undefined,
  workspaceRepoId: string | null,
) {
  const fields = codeChangeFieldsFromNorm(norm, sourceUpdatedAt, workspaceRepoId);
  if (norm.detailShaped) return fields;
  const { externalUrl: _externalUrl, reviewCount: _reviewCount, commentCount: _commentCount, ...rest } = fields;
  return rest;
}

/**
 * The single freshness-guarded CodeChange writer for GitHub live import and replay.
 * SERIALIZABLE plus one bounded retry makes the freshness decision and write atomic:
 * a replay that loses to a newer live observation re-reads that winner and becomes a
 * stale no-op instead of restoring older provider facts.
 */
@Injectable()
export class GithubCodeChangePersistenceService {
  constructor(private readonly prisma: PrismaService) {}

  async persist(input: PersistGithubCodeChangeInput): Promise<{ id: string; applied: AppliedDisposition }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => this.persistInTransaction(tx, input), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isConcurrentWrite(error) || attempt >= CONCURRENT_WRITE_RETRY_LIMIT) throw error;
      }
    }
  }

  private async persistInTransaction(
    tx: Prisma.TransactionClient,
    input: PersistGithubCodeChangeInput,
  ): Promise<{ id: string; applied: AppliedDisposition }> {
    const identity = {
      workspaceId: input.workspaceId,
      provider: DeliveryProvider.github,
      repoExternalId: input.repoExternalId,
      externalId: input.externalId,
    };
    const established = await tx.codeChange.findUnique({
      where: { workspaceId_provider_repoExternalId_externalId: identity },
      select: { id: true, attrs: true },
    });
    if (!established) {
      const created = await tx.codeChange.create({
        data: {
          ...identity,
          connectorId: input.connectorId,
          ...codeChangeFieldsFromNorm(input.norm, input.sourceUpdatedAt, input.workspaceRepoId),
        },
        select: { id: true },
      });
      return { id: created.id, applied: 'created' };
    }

    const incomingFreshness = toEpoch(input.sourceUpdatedAt);
    const establishedFreshness = toEpoch(record(established.attrs).sourceUpdatedAt);
    if (establishedFreshness !== null && (incomingFreshness === null || incomingFreshness < establishedFreshness)) {
      return { id: established.id, applied: 'stale' };
    }
    if (incomingFreshness === establishedFreshness && input.refreshEqual !== true) {
      return { id: established.id, applied: 'duplicate' };
    }

    const data = codeChangeUpdateFieldsFromNorm(input.norm, input.sourceUpdatedAt, input.workspaceRepoId);
    const updated = await tx.codeChange.update({
      where: { id: established.id },
      // Detail-only fields are a conditional patch here — see codeChangeUpdateFieldsFromNorm.
      data: {
        ...data,
        attrs: record(data.attrs) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { id: updated.id, applied: 'updated' };
  }
}
