/**
 * The item browse INDEX (spec §7, `list` mode).
 *
 * Ids, titles, kinds, attachment, authority, version — the shape a knowledge-
 * base list view and a paging client need. It is deliberately NOT the agent
 * context read (issue 07): no selectors, no derived applicability, no evidence,
 * no payloads. Keeping the two apart is what stops the cheap list from
 * accidentally acquiring the expensive read's cost.
 *
 * Every entry carries its `version`, because that is the token a reviewer or an
 * updating proposal has to hand back (spec §5).
 */
import { DecisionStatus, IntentAuthority } from '@coredoc/core';
import { readReleaseSnapshot } from './intent-release.service.js';
import {
  IntentAuditOperation,
  IntentOperation,
  runIntentMutation,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
} from './intent-idempotency.js';
import { IntentAuditEntityKind, Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode, type UpdateIntentSourceInput, type ListIntentItemsQuery } from './contract/index.js';
import { intentNotFound } from './intent-state-errors.js';
import { listConditionsOf } from './intent-context.service.js';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentCursorScope, decodeIntentCursor, paginate } from './intent-cursor.js';

/**
 * An OPEN QUESTION: a live (candidate or accepted) decision whose choice is
 * still open. The tree badges and the browse filter share this one definition.
 * A badge counts candidates and accepted alike; the list it narrows to also
 * follows the browse authority filter, so it can show fewer.
 */
export const OPEN_QUESTION_WHERE = {
  kind: 'decision',
  authority: { in: ['candidate', 'accepted'] },
  payload: { path: ['choiceStatus'], equals: DecisionStatus.Open },
} satisfies Prisma.IntentItemWhereInput;

/** A comment thread still open: a root comment (replies carry no status) whose status is `open`. */
export const OPEN_COMMENT_THREAD_WHERE = {
  parentId: null,
  status: 'open',
} satisfies Prisma.IntentCommentWhereInput;

@Injectable()
export class IntentItemService {
  constructor(private readonly prisma: PrismaService) {}

  async listItems(workspaceId: string, query: ListIntentItemsQuery, limit: number) {
    if (query.production === 'true' || query.effectivity)
      return this.prisma.$transaction((tx) => this.readItems(tx, workspaceId, query, limit), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    return this.readItems(this.prisma, workspaceId, query, limit);
  }

  private async readItems(
    reader: Pick<IntentTransaction, 'intentItem' | 'intentReleaseEvent'>,
    workspaceId: string,
    query: ListIntentItemsQuery,
    limit: number,
  ) {
    const state =
      query.production === 'true' || query.effectivity ? await readReleaseSnapshot(reader, workspaceId) : null;
    const knownIds = state
      ? [
          ...new Set(
            state.events.flatMap(({ data }) => [
              ...(data.included ?? []),
              ...(data.retired ?? []),
              ...(data.ancestors ?? []),
              ...(data.itemId ? [data.itemId] : []),
            ]),
          ),
        ].filter((id) => state.effectivity(id) !== 'unknown')
      : [];
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.Items, 1);
    const search = query.search?.replace(/[\\%_]/g, '\\$&');
    const rows = await reader.intentItem.findMany({
      where: {
        workspaceId,
        AND: [
          ...(query.authorities
            ? [
                {
                  OR: [
                    { authority: { in: query.authorities } },
                    ...(state && query.authorities.includes(IntentAuthority.Accepted)
                      ? [{ authority: 'superseded' as const, id: { in: state.effectiveIds } }]
                      : []),
                  ],
                },
              ]
            : []),
          ...(query.effectivity && state
            ? [
                {
                  id:
                    query.effectivity === 'unknown'
                      ? { notIn: knownIds }
                      : { in: knownIds.filter((id) => state.effectivity(id) === query.effectivity) },
                },
              ]
            : []),
          ...(query.sourceRef || query.sourceKind
            ? [
                {
                  sources: {
                    some: {
                      ...(query.sourceRef ? { ref: query.sourceRef } : {}),
                      ...(query.sourceKind ? { kind: query.sourceKind } : {}),
                    },
                  },
                },
              ]
            : []),
          ...(query.kinds ? [{ kind: { in: query.kinds } }] : []),
          ...(query.openQuestions === 'true' ? [OPEN_QUESTION_WHERE] : []),
          ...(query.openComments === 'true' ? [{ comments: { some: OPEN_COMMENT_THREAD_WHERE } }] : []),
          ...(query.scopeFeatureId ? [{ OR: [{ featureId: query.scopeFeatureId }, { featureId: null }] }] : []),
          ...(search
            ? [
                {
                  OR: ['title', 'id', 'statement'].map((field) => ({
                    [field]: { contains: search, mode: Prisma.QueryMode.insensitive },
                  })),
                },
              ]
            : []),
        ],
        ...(query.authority ? { authority: query.authority } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.domainId ? { domainId: query.domainId } : {}),
        ...(query.featureId ? { featureId: query.featureId } : {}),
        ...(cursor ? { id: { gt: cursor[0] as string } } : {}),
      },
      select: {
        id: true,
        kind: true,
        title: true,
        authority: true,
        version: true,
        domainId: true,
        featureId: true,
        proposedSuccessorOfId: true,
        supersededById: true,
        updatedAt: true,
        // Read for the row's condition summary only; the index stays payload-free.
        payload: true,
        appliesWhen: true,
        domain: { select: { appliesWhen: true } },
        feature: { select: { appliesWhen: true } },
        _count: { select: { comments: { where: OPEN_COMMENT_THREAD_WHERE } } },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const { page, nextCursor } = paginate(rows, limit, IntentCursorScope.Items, (row) => [row.id]);
    return {
      items: page.map((row) => {
        const conditions = listConditionsOf(row);
        return {
          ...(state ? { effectivity: state.effectivity(row.id) } : {}),
          id: row.id,
          kind: row.kind,
          title: row.title,
          authority: row.authority,
          version: row.version,
          domainId: row.domainId,
          featureId: row.featureId,
          proposedSuccessorOfId: row.proposedSuccessorOfId,
          supersededById: row.supersededById,
          updatedAt: row.updatedAt.toISOString(),
          openCommentCount: row._count.comments,
          ...(conditions ? { conditions } : {}),
        };
      }),
      nextCursor,
      ...(state ? { currentRelease: state.currentRelease, headSeq: state.headSeq } : {}),
    };
  }
  async listSources(workspaceId: string, search?: string) {
    const text = search?.replace(/[\\%_]/g, '\\$&');
    const rows = await this.prisma.intentItemSource.groupBy({
      where: {
        workspaceId,
        ...(text
          ? {
              OR: [
                { ref: { contains: text, mode: Prisma.QueryMode.insensitive } },
                { title: { contains: text, mode: Prisma.QueryMode.insensitive } },
              ],
            }
          : {}),
      },
      by: ['kind', 'ref'],
      orderBy: [{ kind: 'asc' }, { ref: 'asc' }],
      _min: { title: true, url: true },
      take: 51,
    });
    return {
      sources: rows
        .slice(0, 50)
        .map((row) => ({ kind: row.kind, ref: row.ref, title: row._min.title, url: row._min.url })),
      truncated: rows.length > 50,
    };
  }

  /** Set title/url on every provenance row citing `ref`; one audit row per citation touched. */
  async updateSource(workspaceId: string, actor: IntentActor, input: UpdateIntentSourceInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.SourceUpdate,
        idempotencyKey: input.idempotencyKey,
        request: input,
        // Scales with how many items cite the document, like an import does.
        transaction: { timeout: 30_000, maxWait: 5_000 },
      },
      async (tx) => {
        const before = await tx.intentItemSource.findMany({
          where: { workspaceId, ref: input.ref },
          select: { id: true, itemId: true, localId: true, title: true, url: true },
          orderBy: { id: 'asc' },
        });
        if (before.length === 0) {
          throw intentNotFound(IntentErrorCode.SourceNotFound, `No intent item cites source '${input.ref}'`, ['ref']);
        }
        const data = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
        };
        // By id, not by ref: a citation proposed concurrently is not changed without its audit row.
        await tx.intentItemSource.updateMany({ where: { id: { in: before.map((row) => row.id) } }, data });
        return {
          response: { ref: input.ref, ...data, items: [...new Set(before.map((row) => row.itemId))] },
          audits: before.map(
            (row) =>
              ({
                entityKind: IntentAuditEntityKind.item_source,
                entityId: row.itemId,
                operation: IntentAuditOperation.Update,
                before: { ref: input.ref, localId: row.localId, title: row.title, url: row.url },
                after: { ref: input.ref, localId: row.localId, title: row.title, url: row.url, ...data },
              }) satisfies IntentAuditRecord,
          ),
        };
      },
    );
  }
}
