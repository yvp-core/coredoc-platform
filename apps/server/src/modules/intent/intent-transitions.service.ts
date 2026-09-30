/**
 * The decision history (spec §4.7: "Transitions are readable through the API:
 * they are the decision history, not just an ops log").
 *
 * Two reads, both newest-first, both keyset-paged:
 *  - one item's transitions, for the item view;
 *  - the workspace's recent transitions, for the KB history view.
 *
 * There is no derivation and no join here — a transition row is already the
 * whole statement of what happened, by whom, and under whose authority. What
 * this file does add is the BigInt boundary: `id` is a `BIGSERIAL` and leaves as
 * a decimal string, because JSON has no integer wide enough to promise it back.
 *
 * The two query schemas live here rather than in `intent-module-operations.ts`
 * for the same reason that file gives for not living in `contract/`: they are
 * the transport shape of these two reads and nothing else consumes them.
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { IntentCursorScope, decodeIntentCursor, paginate } from './intent-cursor.js';
import { intentNotFound } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

export const ListIntentTransitionsQuerySchema = z
  .object({ cursor: z.string().optional(), limit: z.string().optional() })
  .strict();

export type ListIntentTransitionsQuery = z.infer<typeof ListIntentTransitionsQuerySchema>;

/** One history row as a caller reads it. */
export interface IntentTransitionView {
  id: string;
  itemId: string;
  from: string | null;
  to: string;
  actorId: string;
  actorRole: string;
  reason: string;
  authorizingSource: { kind: string; ref: string; localId: string | null; revision: string | null };
  workItem: Prisma.JsonValue | null;
  createdAt: string;
}

interface TransitionRow {
  id: bigint;
  itemId: string;
  fromAuthority: string | null;
  toAuthority: string;
  actorId: string;
  actorRole: string;
  reason: string;
  sourceKind: string;
  sourceRef: string;
  sourceLocalId: string | null;
  sourceRevision: string | null;
  workItem: Prisma.JsonValue | null;
  createdAt: Date;
}

const RECENCY_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

@Injectable()
export class IntentTransitionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** One item's history. A missing item is a 404, not an empty page. */
  async listItemTransitions(workspaceId: string, itemId: string, query: ListIntentTransitionsQuery, limit: number) {
    const item = await this.prisma.intentItem.findUnique({
      where: { workspaceId_id: { workspaceId, id: itemId } },
      select: { id: true },
    });
    if (!item) {
      throw intentNotFound(IntentErrorCode.ItemNotFound, `Intent item '${itemId}' does not exist in this workspace`, [
        'itemId',
      ]);
    }
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.ItemTransitions, 2);
    const rows = await this.prisma.intentAuthorityTransition.findMany({
      where: { workspaceId, itemId, ...olderThan(cursor) },
      orderBy: [...RECENCY_ORDER],
      take: limit + 1,
    });
    return page(rows, limit, IntentCursorScope.ItemTransitions);
  }

  /** The workspace's recent decisions, across every item. */
  async listWorkspaceTransitions(workspaceId: string, query: ListIntentTransitionsQuery, limit: number) {
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.WorkspaceTransitions, 2);
    const rows = await this.prisma.intentAuthorityTransition.findMany({
      where: { workspaceId, ...olderThan(cursor) },
      orderBy: [...RECENCY_ORDER],
      take: limit + 1,
    });
    return page(rows, limit, IntentCursorScope.WorkspaceTransitions);
  }
}

/**
 * Keyset predicate for a `(createdAt, id)` descending page: strictly older, or
 * the same instant and a smaller id. Two rows written in one transaction share
 * `createdAt` to the microsecond, so the id tiebreak is what keeps a review
 * batch's own transitions from repeating or vanishing across a page boundary.
 */
function olderThan(cursor: string[] | null) {
  if (cursor === null) return {};
  const createdAt = new Date(cursor[0] as string);
  const id = BigInt(cursor[1] as string);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

function page(rows: TransitionRow[], limit: number, scope: IntentCursorScope) {
  const paged = paginate(rows, limit, scope, (row) => [row.createdAt.toISOString(), row.id.toString()]);
  return { transitions: paged.page.map(view), nextCursor: paged.nextCursor };
}

function view(row: TransitionRow): IntentTransitionView {
  return {
    id: row.id.toString(),
    itemId: row.itemId,
    from: row.fromAuthority,
    to: row.toAuthority,
    actorId: row.actorId,
    actorRole: row.actorRole,
    reason: row.reason,
    authorizingSource: {
      kind: row.sourceKind,
      ref: row.sourceRef,
      localId: row.sourceLocalId,
      revision: row.sourceRevision,
    },
    workItem: row.workItem,
    createdAt: row.createdAt.toISOString(),
  };
}
