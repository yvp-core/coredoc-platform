/**
 * Comment threads on features and items. A thread is a root comment, which
 * carries the `open`/`resolved` status, and its replies, which carry none.
 */
import { Injectable } from '@nestjs/common';
import {
  IntentAuditEntityKind,
  IntentCommentStatus,
  type Prisma,
  type IntentComment as IntentCommentRow,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IntentErrorCode,
  type CreateIntentCommentInput,
  type ListIntentCommentsQuery,
  type SetIntentCommentStatusInput,
} from './contract/index.js';
import { IntentCursorScope, decodeIntentCursor, paginate } from './intent-cursor.js';
import {
  IntentAuditOperation,
  IntentOperation,
  runIntentMutation,
  type IntentActor,
  type IntentTransaction,
} from './intent-idempotency.js';
import { intentNotFound, intentStateError } from './intent-state-errors.js';

/** A thread still open: a root comment (replies carry no status) whose status is `open`. */
export const OPEN_COMMENT_THREAD_WHERE = {
  parentId: null,
  status: IntentCommentStatus.open,
} satisfies Prisma.IntentCommentWhereInput;

type CommentTarget = { kind: 'feature' | 'item'; id: string };

export interface IntentCommentView {
  id: string;
  target: CommentTarget;
  parentId: string | null;
  body: string;
  /** `null` on a reply: the thread's status lives on its root. */
  status: IntentCommentStatus | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IntentCommentThreadView extends IntentCommentView {
  replies: IntentCommentView[];
}

@Injectable()
export class IntentCommentService {
  constructor(private readonly prisma: PrismaService) {}

  async listThreads(workspaceId: string, query: ListIntentCommentsQuery, limit: number) {
    const target: CommentTarget = query.featureId
      ? { kind: 'feature', id: query.featureId }
      : { kind: 'item', id: query.itemId as string };
    await assertTargetExists(this.prisma, workspaceId, target, [target.kind === 'feature' ? 'featureId' : 'itemId']);

    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.Comments, 2);
    const after = cursor ? { createdAt: new Date(cursor[0] as string), id: cursor[1] as string } : null;
    const roots = await this.prisma.intentComment.findMany({
      where: {
        workspaceId,
        ...targetWhere(target),
        parentId: null,
        ...(query.status ? { status: query.status } : {}),
        ...(after
          ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const { page, nextCursor } = paginate(roots, limit, IntentCursorScope.Comments, (row) => [
      row.createdAt.toISOString(),
      row.id,
    ]);

    const replies = page.length
      ? await this.prisma.intentComment.findMany({
          where: { workspaceId, parentId: { in: page.map((root) => root.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const repliesByRoot = new Map<string, IntentCommentRow[]>();
    for (const reply of replies) {
      const thread = repliesByRoot.get(reply.parentId as string) ?? [];
      thread.push(reply);
      repliesByRoot.set(reply.parentId as string, thread);
    }
    return {
      threads: page.map(
        (root): IntentCommentThreadView => ({
          ...commentView(root),
          replies: (repliesByRoot.get(root.id) ?? []).map(commentView),
        }),
      ),
      nextCursor,
    };
  }

  async create(workspaceId: string, actor: IntentActor, input: CreateIntentCommentInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.CommentCreate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        let target: CommentTarget;
        if (input.parentId) {
          const parent = await readComment(tx, workspaceId, input.parentId, ['parentId']);
          if (parent.parentId !== null) {
            throw intentStateError(
              IntentErrorCode.CommentReplyToReply,
              'Reply to the thread’s first comment; threads are one level deep',
              ['parentId'],
            );
          }
          target = targetOf(parent);
        } else {
          target = input.target as CommentTarget;
          await assertTargetExists(tx, workspaceId, target, ['target', 'id']);
        }

        const comment = await tx.intentComment.create({
          data: {
            workspaceId,
            ...targetWhere(target),
            parentId: input.parentId ?? null,
            body: input.body,
            status: input.parentId ? null : IntentCommentStatus.open,
            createdBy: actor.id,
          },
        });
        return {
          response: { comment: commentView(comment) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.comment,
              entityId: comment.id,
              operation: IntentAuditOperation.Create,
              after: { target, parentId: comment.parentId, status: comment.status },
            },
          ],
        };
      },
    );
  }

  async setStatus(workspaceId: string, actor: IntentActor, input: SetIntentCommentStatusInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.CommentStatus,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const existing = await readComment(tx, workspaceId, input.id, ['id']);
        if (existing.parentId !== null) {
          throw intentStateError(
            IntentErrorCode.CommentStatusOnReply,
            'Only the thread’s first comment carries a status',
            ['id'],
          );
        }
        const resolved = input.status === IntentCommentStatus.resolved;
        const comment = await tx.intentComment.update({
          where: { id: existing.id },
          data: {
            status: input.status,
            resolvedBy: resolved ? actor.id : null,
            resolvedAt: resolved ? new Date() : null,
          },
        });
        return {
          response: { comment: commentView(comment) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.comment,
              entityId: comment.id,
              operation: IntentAuditOperation.Update,
              before: { status: existing.status },
              after: { status: comment.status },
            },
          ],
        };
      },
    );
  }
}

function targetWhere(target: CommentTarget) {
  return target.kind === 'feature' ? { featureId: target.id } : { itemId: target.id };
}

function targetOf(row: IntentCommentRow): CommentTarget {
  return row.featureId !== null ? { kind: 'feature', id: row.featureId } : { kind: 'item', id: row.itemId as string };
}

function commentView(row: IntentCommentRow): IntentCommentView {
  return {
    id: row.id,
    target: targetOf(row),
    parentId: row.parentId,
    body: row.body,
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readComment(
  tx: Pick<IntentTransaction, 'intentComment'>,
  workspaceId: string,
  id: string,
  path: string[],
): Promise<IntentCommentRow> {
  const comment = await tx.intentComment.findFirst({ where: { id, workspaceId } });
  if (!comment) {
    throw intentNotFound(IntentErrorCode.CommentNotFound, `Comment '${id}' does not exist in this workspace`, path);
  }
  return comment;
}

async function assertTargetExists(
  reader: Pick<IntentTransaction, 'intentFeature' | 'intentItem'>,
  workspaceId: string,
  target: CommentTarget,
  path: string[],
): Promise<void> {
  const key = { workspaceId_id: { workspaceId, id: target.id } };
  if (target.kind === 'feature') {
    if (await reader.intentFeature.findUnique({ where: key, select: { id: true } })) return;
    throw intentNotFound(
      IntentErrorCode.FeatureNotFound,
      `Feature '${target.id}' does not exist in this workspace`,
      path,
    );
  }
  if (await reader.intentItem.findUnique({ where: key, select: { id: true } })) return;
  throw intentNotFound(IntentErrorCode.ItemNotFound, `Item '${target.id}' does not exist in this workspace`, path);
}
