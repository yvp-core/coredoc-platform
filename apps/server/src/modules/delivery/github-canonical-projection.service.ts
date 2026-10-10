import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, type Prisma } from '../../generated/prisma/client.js';
import { GithubIntentReleaseService } from '../intent/github-intent-release.service.js';
import { normalizePullRequest, type NormalizedReworkReview } from './github-normalizer.js';
import { unpackRawPayload } from './raw-payload-codec.js';
import { asArray, asRecord, asString, isUniqueViolation } from '../../libs/coerce.js';

// v2: stamp DeliveryTask.title from the PR title as a fallback when the task has
// no title yet (GitHub is not the title authority — Jira re-stamps unconditionally
// and wins over time; see JiraCanonicalProjectionService.stampAuthorityTitle). The
// bump drives the existing renormalize backfill (delivery-sync.cron.ts), whose reach is
// narrower than "every previously-projected row":
//   - TRUNCATED raw rows are excluded by the backfill query outright (renormalize.service),
//     so they backfill neither the title nor the detail counts.
//   - Titles backfill from the PR list body, so any non-truncated row can supply one.
//   - The detail-only counts (externalUrl/reviewCount/commentCount) need `envelope.prDetail`;
//     legacy rows stored before it was captured normalize to an empty detail and keep their
//     NULLs until a provider re-fetch stores a detail-shaped payload.
// v3: persist review-driven rework signals (`norm.reworkReviews`) per linked task, so the
// renormalize backfill replays them for every non-truncated raw payload already stored.
export const GITHUB_CANONICAL_PROJECTION_VERSION = 3;

const UNIQUE_RACE_RETRY_LIMIT = 1;
const SHIP_SOURCE = 'github_pr_merged';
const SHIP_KEY_PREFIX = 'github-pr:';
const REWORK_KEY_PREFIX = 'github-review:';
/** Matches the `delivery_tasks.title` column width. */
const TASK_TITLE_CHARS = 512;

/**
 * Truncate to TASK_TITLE_CHARS *code points*, never mid-surrogate-pair.
 *
 * `String.slice` counts UTF-16 units, so a title with an emoji straddling the boundary
 * would be cut into a lone surrogate — invalid UTF-8 that Postgres rejects INSIDE the
 * projection transaction, turning a single emoji-titled PR into a watermark-gated
 * poison pill that replays forever. Postgres counts VARCHAR(512) in characters, so
 * code points are also the right unit for the cap. (jira-canonical-projection.service
 * keeps its own copy: the two projectors share no runtime module, and a three-line
 * helper is not worth coupling them.)
 */
function truncateTitle(value: string): string {
  // A trailing UNPAIRED high surrogate can arrive already split: the normalizer caps PR
  // titles in UTF-16 units (capped(pr.title, 512)) before they reach here. Dropping it is
  // the only repair — half a code point is not a character.
  const whole = /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
  const points = Array.from(whole);
  return points.length <= TASK_TITLE_CHARS ? whole : points.slice(0, TASK_TITLE_CHARS).join('');
}

interface ProjectionInput {
  workspaceId: string;
  rawPayloadId: bigint;
  codeChangeId: string;
}

interface AssociationCandidate {
  deliveryTaskId: string;
  source: 'issue_key' | 'run_id';
  sourceValue: string;
}

interface ProjectionCodeChange {
  id: string;
  workspaceRepoId: string | null;
  repoExternalId: string;
  externalId: string;
  mergedAt: Date | null;
}

function associationRank(source: string): number {
  if (source === 'external_ref') return 0;
  if (source === 'run_id') return 1;
  if (source === 'issue_key') return 2;
  return Number.MAX_SAFE_INTEGER;
}

function compareCandidates(left: AssociationCandidate, right: AssociationCandidate): number {
  return (
    associationRank(left.source) - associationRank(right.source) || left.sourceValue.localeCompare(right.sourceValue)
  );
}

function candidateIsStronger(
  candidate: AssociationCandidate,
  established: { associationSource: string; associationSourceValue: string },
): boolean {
  const candidateRank = associationRank(candidate.source);
  const establishedRank = associationRank(established.associationSource);
  return (
    candidateRank < establishedRank ||
    (candidateRank === establishedRank && candidate.sourceValue.localeCompare(established.associationSourceValue) < 0)
  );
}

/**
 * Length-prefixed digest of the identity parts, so no two different identities can produce the
 * same key by concatenation. The unique index is (workspace, source/kind, sourceKey), which is
 * why the delivery task id is part of the identity: the same PR linked to two tasks is two rows.
 */
function stableKey(prefix: string, parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    digest.update(String(bytes.byteLength));
    digest.update(':');
    digest.update(bytes);
    digest.update(';');
  }
  return `${prefix}${digest.digest('hex')}`;
}

function stableShipKey(
  workspaceId: string,
  repoExternalId: string,
  externalId: string,
  deliveryTaskId: string,
): string {
  return stableKey(SHIP_KEY_PREFIX, [workspaceId, 'github', repoExternalId, externalId, deliveryTaskId]);
}

function stableReworkKey(
  workspaceId: string,
  repoExternalId: string,
  externalId: string,
  reviewId: string,
  deliveryTaskId: string,
): string {
  return stableKey(REWORK_KEY_PREFIX, [workspaceId, 'github', repoExternalId, externalId, reviewId, deliveryTaskId]);
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function projectionConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'GITHUB_CANONICAL_PROJECTION_CONFLICT',
    message,
  });
}

@Injectable()
export class GithubCanonicalProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intentReleases: GithubIntentReleaseService,
  ) {}

  private async transactionWithConcurrentFirstWriteRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= UNIQUE_RACE_RETRY_LIMIT) throw error;
      }
    }
  }

  async projectRawPayload(
    input: ProjectionInput,
  ): Promise<{ associations: number; shipEvidence: number; reworkSignals: number }> {
    const result = await this.projectInTransaction(input);
    // AFTER the commit, deliberately: the release ledger takes the workspace row lock in
    // its own transaction, and the intent actors read the code-change row this projection
    // pass just established. Never throws — see GithubIntentReleaseService.
    await this.intentReleases.applyToCodeChange(input.workspaceId, input.codeChangeId);
    return result;
  }

  private async projectInTransaction(
    input: ProjectionInput,
  ): Promise<{ associations: number; shipEvidence: number; reworkSignals: number }> {
    return this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
      const raw = await tx.deliveryRawPayload.findFirst({
        where: {
          id: input.rawPayloadId,
          workspaceId: input.workspaceId,
          resourceType: 'pull_request',
        },
        select: {
          id: true,
          externalId: true,
          payload: true,
          truncated: true,
          fetchedAt: true,
        },
      });
      const codeChange = await tx.codeChange.findFirst({
        where: {
          id: input.codeChangeId,
          workspaceId: input.workspaceId,
          provider: DeliveryProvider.github,
        },
        select: {
          id: true,
          workspaceRepoId: true,
          repoExternalId: true,
          externalId: true,
          mergedAt: true,
        },
      });
      if (!raw || !codeChange) throw new NotFoundException('GitHub canonical projection target not found');
      if (raw.externalId !== codeChange.externalId) {
        projectionConflict('Raw pull request and code change identities do not match');
      }

      const envelope = asRecord(unpackRawPayload(raw.payload));
      const pr = asRecord(envelope.pr);
      const rawRepo = asString(envelope.repo) ?? asString(asRecord(asRecord(pr.base).repo).full_name);
      if (rawRepo !== codeChange.repoExternalId) {
        projectionConflict('Raw pull request and code change repositories do not match');
      }

      const norm = normalizePullRequest(
        pr,
        asArray(envelope.reviews),
        asArray(envelope.files),
        asArray(envelope.commits),
        asRecord(envelope.prDetail),
        // Truncated raw envelopes store `commitsIncomplete: true`; suppressing rework signals
        // there is the same rule `resolveCandidates` applies to run ids below.
        envelope.commitsIncomplete === true,
      );
      if (norm && norm.externalId !== codeChange.externalId) {
        projectionConflict('Normalized pull request and code change identities do not match');
      }

      const candidates =
        raw.truncated || !norm ? [] : await this.resolveCandidates(tx, input.workspaceId, codeChange, norm, envelope);
      const fallbackTitle = norm?.title;
      let associations = 0;
      for (const candidate of candidates) {
        if (await this.persistAssociation(tx, input.workspaceId, codeChange.id, candidate)) associations += 1;
        // Fallback title stamp: applies to every associated task, not just newly-created
        // associations, so a re-projection onto an already-associated but title-less task
        // (S8 backfill) still fills it in.
        await this.stampFallbackTitle(tx, input.workspaceId, candidate.deliveryTaskId, fallbackTitle);
      }

      const reworkReviews = norm?.reworkReviews ?? [];
      let shipEvidence = 0;
      let reworkSignals = 0;
      if (codeChange.mergedAt || reworkReviews.length > 0) {
        const linkedTasks = await tx.deliveryTaskCodeChange.findMany({
          where: { workspaceId: input.workspaceId, codeChangeId: codeChange.id },
          select: { deliveryTaskId: true },
          orderBy: { deliveryTaskId: 'asc' },
        });
        for (const { deliveryTaskId } of linkedTasks) {
          if (
            codeChange.mergedAt &&
            (await this.persistShipEvidence(tx, input.workspaceId, deliveryTaskId, codeChange, raw.fetchedAt))
          ) {
            shipEvidence += 1;
          }
        }
        reworkSignals = await this.persistReworkSignals(
          tx,
          input.workspaceId,
          linkedTasks.map((task) => task.deliveryTaskId),
          codeChange,
          reworkReviews,
          raw.fetchedAt,
        );
      }

      await tx.deliveryRawPayload.update({
        where: { id: raw.id },
        data: { canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION },
      });
      return { associations, shipEvidence, reworkSignals };
    });
  }

  private async resolveCandidates(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    codeChange: ProjectionCodeChange,
    norm: NonNullable<ReturnType<typeof normalizePullRequest>>,
    envelope: Record<string, unknown>,
  ): Promise<AssociationCandidate[]> {
    const byTask = new Map<string, AssociationCandidate>();
    const accept = (candidate: AssociationCandidate) => {
      const established = byTask.get(candidate.deliveryTaskId);
      if (!established || compareCandidates(candidate, established) < 0) {
        byTask.set(candidate.deliveryTaskId, candidate);
      }
    };

    const issueKeys = [...new Set(norm.attrs.issueKeys ?? [])].sort();
    for (const issueKey of issueKeys) {
      const refs = await tx.taskExternalRef.findMany({
        where: { workspaceId, externalKey: issueKey },
        select: { deliveryTaskId: true },
        orderBy: { id: 'asc' },
        take: 2,
      });
      if (refs.length === 1) {
        accept({ deliveryTaskId: refs[0].deliveryTaskId, source: 'issue_key', sourceValue: issueKey });
      }
    }

    if (envelope.commitsIncomplete === false && norm.attrs.runIdsPartial !== true && codeChange.workspaceRepoId) {
      const repository = await tx.workspaceRepo.findFirst({
        where: { workspaceId, id: codeChange.workspaceRepoId },
        select: { captureRepositoryKey: true },
      });
      if (repository?.captureRepositoryKey) {
        const runIds = [...new Set(norm.attrs.runIds ?? [])].sort();
        if (runIds.length > 0) {
          const runs = await tx.workflowRun.findMany({
            where: { workspaceId, runId: { in: runIds } },
            select: {
              runId: true,
              deliveryTaskId: true,
              repositoryKey: true,
              workItems: { select: { provider: true, externalId: true } },
            },
          });
          const matchingRuns = runs.filter((run) => run.repositoryKey === repository.captureRepositoryKey);
          const identities = new Map<string, { provider: string; externalId: string }>();
          for (const run of matchingRuns) {
            for (const item of run.workItems) {
              identities.set(`${item.provider}\u0000${item.externalId}`, item);
            }
          }
          const refs =
            identities.size === 0
              ? []
              : await tx.taskExternalRef.findMany({
                  where: { workspaceId, OR: [...identities.values()] },
                  select: { provider: true, externalId: true, deliveryTaskId: true },
                });
          const taskByIdentity = new Map(
            refs.map((ref) => [`${ref.provider}\u0000${ref.externalId}`, ref.deliveryTaskId] as const),
          );
          for (const run of matchingRuns) {
            if (run.deliveryTaskId) {
              accept({ deliveryTaskId: run.deliveryTaskId, source: 'run_id', sourceValue: run.runId });
            }
            for (const item of run.workItems) {
              const deliveryTaskId = taskByIdentity.get(`${item.provider}\u0000${item.externalId}`);
              if (deliveryTaskId) accept({ deliveryTaskId, source: 'run_id', sourceValue: run.runId });
            }
          }
        }
      }
    }

    return [...byTask.values()].sort(
      (left, right) => left.deliveryTaskId.localeCompare(right.deliveryTaskId) || compareCandidates(left, right),
    );
  }

  private async persistAssociation(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    codeChangeId: string,
    candidate: AssociationCandidate,
  ): Promise<boolean> {
    const where = {
      workspaceId_deliveryTaskId_codeChangeId: {
        workspaceId,
        deliveryTaskId: candidate.deliveryTaskId,
        codeChangeId,
      },
    };
    const established = await tx.deliveryTaskCodeChange.findUnique({
      where,
      select: { associationSource: true, associationSourceValue: true },
    });
    if (!established) {
      await tx.deliveryTaskCodeChange.create({
        data: {
          workspaceId,
          deliveryTaskId: candidate.deliveryTaskId,
          codeChangeId,
          associationSource: candidate.source,
          associationSourceValue: candidate.sourceValue,
        },
      });
      return true;
    }
    if (candidateIsStronger(candidate, established)) {
      await tx.deliveryTaskCodeChange.update({
        where,
        data: {
          associationSource: candidate.source,
          associationSourceValue: candidate.sourceValue,
        },
      });
    }
    return false;
  }

  /**
   * Fallback title stamp: GitHub is never the title authority, so this only fills a
   * task that has none yet — an `updateMany` guarded by `title: null` in the WHERE
   * clause makes the null-check and write atomic without a prior read, and a
   * concurrent Jira stamp (or an earlier GitHub stamp) simply loses the race and this
   * becomes a no-op. Absent/empty PR titles never overwrite with blank.
   */
  private async stampFallbackTitle(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    deliveryTaskId: string,
    prTitle: string | undefined,
  ): Promise<void> {
    if (!prTitle) return;
    const title = truncateTitle(prTitle.trim());
    // A whitespace-only PR title carries no name, and must not win the `title: null`
    // race against a later real one (the trim above is what makes this check bite).
    if (title.length === 0) return;
    await tx.deliveryTask.updateMany({
      where: { workspaceId, id: deliveryTaskId, title: null },
      data: { title },
    });
  }

  private async persistShipEvidence(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    deliveryTaskId: string,
    codeChange: ProjectionCodeChange,
    receivedAt: Date,
  ): Promise<boolean> {
    if (!codeChange.mergedAt) return false;
    const sourceKey = stableShipKey(workspaceId, codeChange.repoExternalId, codeChange.externalId, deliveryTaskId);
    const where = {
      workspaceId_source_sourceKey: {
        workspaceId,
        source: SHIP_SOURCE,
        sourceKey,
      },
    };
    const established = await tx.deliveryShipEvidence.findUnique({
      where,
      select: {
        deliveryTaskId: true,
        occurredAt: true,
        provider: true,
        repoExternalId: true,
        externalId: true,
      },
    });
    if (established) {
      if (
        established.deliveryTaskId !== deliveryTaskId ||
        !sameInstant(established.occurredAt, codeChange.mergedAt) ||
        established.provider !== 'github' ||
        established.repoExternalId !== codeChange.repoExternalId ||
        established.externalId !== codeChange.externalId
      ) {
        projectionConflict('GitHub merge replay contradicts established ship evidence');
      }
      return false;
    }

    await tx.deliveryShipEvidence.create({
      data: {
        workspaceId,
        deliveryTaskId,
        source: SHIP_SOURCE,
        sourceKey,
        occurredAt: codeChange.mergedAt,
        receivedAt,
        actorId: null,
        provider: 'github',
        repoExternalId: codeChange.repoExternalId,
        externalId: codeChange.externalId,
      },
    });
    return true;
  }

  /**
   * One rework signal per (linked task, review), keyed exactly like the ship evidence so a
   * re-ingest of the same raw payload is a no-op and a contradicting replay fails loudly
   * instead of silently rewriting an established fact.
   *
   * Batched deliberately: a PR linked to N tasks with M reviews is N*M signals, and the
   * per-signal findUnique+create it replaced issued two round trips for each of them INSIDE the
   * projection transaction. One `findMany` over the batch's source keys plus one
   * `createMany({ skipDuplicates: true })` costs two, and skipDuplicates is also what makes a
   * concurrent projector's row a no-op rather than a P2002 that aborts the transaction.
   *
   * `sourceRef` is NOT part of the contradiction check: it is a display link (the review's
   * html_url), and GitHub rewrites it whenever the repository is renamed. Treating that as a
   * contradiction would turn every renamed repo into a permanently failing replay, so a drift
   * refreshes the stored value instead. Identity (`deliveryTaskId`) and the fact's instant
   * (`occurredAt`) still contradict.
   */
  private async persistReworkSignals(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    deliveryTaskIds: string[],
    codeChange: ProjectionCodeChange,
    reviews: NormalizedReworkReview[],
    receivedAt: Date,
  ): Promise<number> {
    const rows = [];
    for (const deliveryTaskId of deliveryTaskIds) {
      for (const review of reviews) {
        const occurredAt = new Date(review.occurredAt);
        if (!Number.isFinite(occurredAt.getTime())) continue;
        rows.push({
          workspaceId,
          deliveryTaskId,
          kind: review.kind,
          sourceKey: stableReworkKey(
            workspaceId,
            codeChange.repoExternalId,
            codeChange.externalId,
            review.reviewId,
            deliveryTaskId,
          ),
          sourceRef: review.sourceRef,
          occurredAt,
          observedAt: receivedAt,
        });
      }
    }
    if (rows.length === 0) return 0;

    const established = await tx.deliveryReworkSignal.findMany({
      where: { workspaceId, sourceKey: { in: rows.map((row) => row.sourceKey) } },
      select: { id: true, kind: true, sourceKey: true, deliveryTaskId: true, sourceRef: true, occurredAt: true },
    });
    const byKey = new Map(established.map((row) => [`${row.kind}\u0000${row.sourceKey}`, row]));
    const missing: typeof rows = [];
    for (const row of rows) {
      const found = byKey.get(`${row.kind}\u0000${row.sourceKey}`);
      if (!found) {
        missing.push(row);
        continue;
      }
      if (found.deliveryTaskId !== row.deliveryTaskId || !sameInstant(found.occurredAt, row.occurredAt)) {
        projectionConflict('GitHub review replay contradicts established rework signal');
      }
      if (found.sourceRef !== row.sourceRef) {
        await tx.deliveryReworkSignal.update({ where: { id: found.id }, data: { sourceRef: row.sourceRef } });
      }
    }
    if (missing.length === 0) return 0;
    const { count } = await tx.deliveryReworkSignal.createMany({ data: missing, skipDuplicates: true });
    return count;
  }
}
