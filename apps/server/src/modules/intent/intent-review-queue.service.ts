/**
 * The review QUEUE read (spec §7, issue v1.1-01/v1.1-04): what is waiting for a
 * human decision, answered WITHOUT walking the item list.
 *
 * WHY IT IS NOT `IntentItemService.listItems`. The desktop review tab used to
 * learn the size of the queue by paging the whole candidate set to exhaustion —
 * one IPC round trip per page, with a client-side ceiling that had to be
 * reported when it tripped. The count and the first page are two different
 * questions, and only one of them is expensive; this service answers the cheap
 * one cheaply. Raising the walk's ceiling was the alternative and would have
 * made the tab slower on exactly the workspaces that need it most.
 *
 * TWO ANSWERS, ONE SOURCE.
 *  - {@link readIntentPendingReview} is the SUMMARY: one grouped aggregate over
 *    `intent_items`, riding the `(workspace_id, authority)` index. It is small
 *    enough to attach to every context read (§11), which is what gives an agent
 *    something to nudge the maintainer with.
 *  - {@link IntentReviewQueueService.readQueue} is the candidates-only page,
 *    cursor-paged like every other list here, with the `total` the desktop badge
 *    needs and the domain/feature/kind filters a reviewer works through.
 *
 * The summary is a free FUNCTION rather than a method so `IntentContextService`
 * can serve the same numbers from the same SQL without acquiring a second
 * constructor dependency — one implementation, two callers, no wiring change to
 * the read that every MCP session makes.
 *
 * IT IS NOT ALLOWED TO FAIL A READ, and nothing here catches to make that true:
 * the aggregate runs on the SAME control-plane connection that produced the rest
 * of the answer, so a failure it could swallow is one the read has already
 * failed on. Silently reporting `waiting: 0` for a database error would be a
 * fabricated fact about authority, which is the one thing this module never does.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  HINT_ITEM_SELECT,
  authoringHintsOf,
  readHintDimensions,
  readReferencedClauses,
} from './intent-authoring-hints.js';
import { IntentCursorScope, decodeIntentCursor, paginate } from './intent-cursor.js';
import type { ListIntentReviewQueueQuery } from './contract/index.js';

/**
 * Domain buckets reported inline. A workspace's domain registry is small by
 * design, but this summary rides on EVERY context read, so what it reports is
 * bounded rather than merely expected to be small: the widest buckets are named
 * and `byDomainTruncated` says the rest exist. `waiting` is always the exact
 * total — the bound narrows the breakdown, never the count.
 */
export const INTENT_PENDING_REVIEW_DOMAINS = 20;

/** One domain's share of the queue. `domainId: null` is the product root (§4.4). */
export interface IntentPendingReviewDomain {
  domainId: string | null;
  waiting: number;
  oldestWaitingAt: string;
}

/**
 * The waiting-candidate summary carried by the queue read and by every context
 * read (§7, §11).
 *
 * ZERO IS AN ANSWER, ABSENT IS NOT: a workspace with no candidates — including
 * one with no intent content at all — answers `waiting: 0`, an empty breakdown,
 * and a null `oldestWaitingAt`. The field is never omitted, so a client never
 * has to tell "nothing waiting" apart from "this server does not report it".
 */
export interface IntentPendingReviewSummary {
  waiting: number;
  /** ISO-8601 instant the oldest waiting candidate was proposed, or null when none waits. */
  oldestWaitingAt: string | null;
  /** True when at least one waiting candidate proposes to replace an accepted item (§5). */
  hasReplacementCandidate: boolean;
  byDomain: IntentPendingReviewDomain[];
  byDomainTruncated: boolean;
}

/** Row shape of the grouped aggregate. */
interface PendingReviewGroupRow {
  domainId: string | null;
  waiting: number;
  oldestWaitingAt: Date;
  replacements: number;
}

/**
 * The summary, in ONE grouped aggregate.
 *
 * `COUNT(*) FILTER (…)` carries the replacement question in the same pass, so
 * the whole summary is one round trip rather than a count plus an exists plus a
 * min. The authority literal is written into the SQL rather than parameterised
 * because a bound parameter arrives as `text` and would not compare against the
 * enum column — it is a constant of this query, never caller input.
 */
export async function readIntentPendingReview(
  prisma: PrismaService,
  workspaceId: string,
): Promise<IntentPendingReviewSummary> {
  const rows = await prisma.$queryRaw<PendingReviewGroupRow[]>`
    SELECT i.domain_id AS "domainId",
           COUNT(*)::int AS "waiting",
           MIN(i.created_at) AS "oldestWaitingAt",
           COUNT(*) FILTER (WHERE i.proposed_successor_of_id IS NOT NULL)::int AS "replacements"
    FROM intent_items i
    WHERE i.workspace_id = ${workspaceId}::uuid AND i.authority::text = 'candidate'
    GROUP BY i.domain_id
  `;

  let waiting = 0;
  let oldest: Date | null = null;
  let hasReplacementCandidate = false;
  for (const row of rows) {
    waiting += row.waiting;
    if (row.replacements > 0) hasReplacementCandidate = true;
    if (oldest === null || row.oldestWaitingAt < oldest) oldest = row.oldestWaitingAt;
  }

  // Widest bucket first: the breakdown exists to point a maintainer at where the
  // queue actually is, and a truncated tail must be the least interesting part.
  const byDomain = [...rows].sort(
    (left, right) => right.waiting - left.waiting || (left.domainId ?? '').localeCompare(right.domainId ?? ''),
  );
  return {
    waiting,
    oldestWaitingAt: oldest === null ? null : oldest.toISOString(),
    hasReplacementCandidate,
    byDomain: byDomain.slice(0, INTENT_PENDING_REVIEW_DOMAINS).map((row) => ({
      domainId: row.domainId,
      waiting: row.waiting,
      oldestWaitingAt: row.oldestWaitingAt.toISOString(),
    })),
    byDomainTruncated: byDomain.length > INTENT_PENDING_REVIEW_DOMAINS,
  };
}

@Injectable()
export class IntentReviewQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** The workspace summary on its own, for callers that want no page at all. */
  async summary(workspaceId: string): Promise<IntentPendingReviewSummary> {
    return readIntentPendingReview(this.prisma, workspaceId);
  }

  /**
   * One page of the queue, oldest first, plus the `total` for the filter and the
   * workspace summary.
   *
   * OLDEST FIRST is the queue's own order — a reviewer works the backlog down —
   * and `(createdAt, id)` is a keyset, so paging it is stable across concurrent
   * proposals. `total` counts what the FILTER matches; `summary` always
   * describes the whole workspace, because that is what a badge shows.
   *
   * A domain filter also reaches feature-attached candidates: attachment to a
   * feature carries that feature's domain on the row (§4.4), so "everything
   * waiting under `ordering`" is one predicate rather than a feature lookup.
   */
  async readQueue(workspaceId: string, query: ListIntentReviewQueueQuery, limit: number) {
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.ReviewQueue, 2);
    const where = {
      workspaceId,
      authority: 'candidate',
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.domainId ? { domainId: query.domainId } : {}),
      ...(query.featureId ? { featureId: query.featureId } : {}),
    } as const;

    const [summary, total, rows, dimensions] = await Promise.all([
      readIntentPendingReview(this.prisma, workspaceId),
      this.prisma.intentItem.count({ where }),
      this.prisma.intentItem.findMany({
        where: { ...where, ...newerThan(cursor) },
        select: {
          ...HINT_ITEM_SELECT,
          id: true,
          kind: true,
          title: true,
          authority: true,
          version: true,
          domainId: true,
          featureId: true,
          proposedSuccessorOfId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
      readHintDimensions(this.prisma, workspaceId),
    ]);

    const { page, nextCursor } = paginate(rows, limit, IntentCursorScope.ReviewQueue, (row) => [
      row.createdAt.toISOString(),
      row.id,
    ]);
    const referenced = await readReferencedClauses(this.prisma, workspaceId, page);
    return {
      summary,
      total,
      items: page.map((row) => {
        const hints = authoringHintsOf(row, dimensions, referenced);
        return {
          id: row.id,
          kind: row.kind,
          title: row.title,
          authority: row.authority,
          version: row.version,
          domainId: row.domainId,
          featureId: row.featureId,
          proposedSuccessorOfId: row.proposedSuccessorOfId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          ...(hints.length > 0 ? { hints } : {}),
        };
      }),
      nextCursor,
    };
  }
}

/**
 * Keyset predicate for a `(createdAt, id)` ASCENDING page — the mirror of the
 * transition reads' `olderThan`. Two candidates proposed in one batch share
 * `createdAt` to the microsecond, so the id tiebreak is what keeps one of them
 * from repeating or vanishing across a page boundary.
 */
function newerThan(cursor: string[] | null) {
  if (cursor === null) return {};
  const createdAt = new Date(cursor[0] as string);
  const id = cursor[1] as string;
  return { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }] };
}
