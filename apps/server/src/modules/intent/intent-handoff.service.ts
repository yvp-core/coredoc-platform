import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type IntentHandoff } from '../../generated/prisma/client.js';
import {
  canonicalJson,
  IntentOperation,
  runIntentMutation,
  type IntentActor,
  type IntentTransaction,
} from './intent-idempotency.js';
import type { HandoffPayload, SaveIntentHandoff } from './intent-handoff.operations.js';
import type { IntentHandoffItemResult } from './intent-handoff-anchors.service.js';

export function handoffPayload(row: Pick<IntentHandoff, 'payload'>): HandoffPayload {
  return row.payload as unknown as HandoffPayload;
}
export function handoffResults(row: IntentHandoff): IntentHandoffItemResult[] {
  return row.results as unknown as IntentHandoffItemResult[];
}
export function handoffView(row: IntentHandoff) {
  return {
    id: row.id,
    repoKey: row.repoKey,
    version: row.version,
    headSha: row.headSha,
    prNumber: row.prNumber,
    ...handoffPayload(row),
    mapping: { state: row.mappingState, reason: row.mappingReason, results: row.results },
    delivery: { state: row.deliveryState, reason: row.deliveryReason },
    mergeCommit: row.mergeCommit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function lockHandoff(tx: IntentTransaction, workspaceId: string, id: string, version: number) {
  await tx.$queryRaw`SELECT id FROM intent_handoffs WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  const current = await tx.intentHandoff.findFirst({ where: { workspaceId, id } });
  if (!current || current.version !== version) throw new ConflictException('handoff_version_changed');
  return current;
}

@Injectable()
export class IntentHandoffService {
  constructor(private readonly prisma: PrismaService) {}

  async save(workspaceId: string, actor: IntentActor, input: SaveIntentHandoff) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.HandoffSave,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const repo = await tx.workspaceRepo.findFirst({ where: { workspaceId, intentRepoKey: input.repoKey } });
        if (!repo) throw new NotFoundException('handoff_repository_not_found');
        await tx.$queryRaw`SELECT id FROM intent_handoffs WHERE id = ${input.id}::uuid FOR UPDATE`;
        const old = await tx.intentHandoff.findUnique({ where: { id: input.id } });
        if (old && old.workspaceId !== workspaceId) throw new NotFoundException('handoff_not_found');
        if ((old?.version ?? 0) !== input.expectedVersion) throw new ConflictException('handoff_version_changed');
        if (old && (old.repoKey !== input.repoKey || (old.prNumber && old.prNumber !== input.prNumber)))
          throw new ConflictException('handoff_identity_immutable');
        if (old?.mappingState === 'superseded') throw new ConflictException('handoff_closed');
        if (input.prNumber) {
          const samePr = await tx.intentHandoff.findFirst({
            where: { workspaceId, repoKey: input.repoKey, prNumber: input.prNumber, id: { not: input.id } },
          });
          if (samePr) throw new ConflictException('pr_already_has_handoff');
        }
        const payload: HandoffPayload = {
          bindings: input.bindings,
          delivers: input.delivers,
          retires: input.retires,
          supersedesMappingIds: input.supersedesMappingIds,
        };
        if (old?.deliveryState === 'recorded') {
          const previous = handoffPayload(old);
          // Only the delivery declaration is frozen; a later push may move headSha and bindings.
          if (
            canonicalJson([previous.delivers, previous.retires]) !== canonicalJson([payload.delivers, payload.retires])
          )
            throw new ConflictException('recorded_delivery_immutable');
        }
        for (const id of input.supersedesMappingIds) {
          const predecessor = await tx.intentHandoff.findFirst({ where: { workspaceId, repoKey: input.repoKey, id } });
          if (!predecessor || (old && predecessor.createdAt >= old.createdAt))
            throw new ConflictException('invalid_mapping_predecessor');
          const done = new Set(
            handoffResults(predecessor)
              .filter((r) => r.outcome !== 'unresolved')
              .map((r) => r.itemId),
          );
          const pending = handoffPayload(predecessor).bindings.filter((b) => !done.has(b.itemId));
          if (!pending.length || pending.some((b) => !payload.bindings.some((next) => next.itemId === b.itemId)))
            throw new ConflictException('successor_must_cover_unresolved_items');
        }
        const results = old
          ? handoffResults(old).filter(
              (result) =>
                result.outcome !== 'unresolved' &&
                canonicalJson(handoffPayload(old).bindings.find((b) => b.itemId === result.itemId)) ===
                  canonicalJson(payload.bindings.find((b) => b.itemId === result.itemId)),
            )
          : [];
        // A missing-row SELECT cannot lock a future insert. Never upsert here:
        // the loser of a concurrent create must fail uniqueness, not update a
        // row whose tenant/version was never checked under the lock.
        const row = old
          ? await tx.intentHandoff.update({
              where: { id: input.id },
              data: {
                version: { increment: 1 },
                headSha: input.headSha,
                prNumber: input.prNumber,
                payload: payload as unknown as Prisma.InputJsonValue,
                updatedBy: actor.id,
                prObservedAt: null,
                mappingState: 'pending',
                mappingReason: null,
                results: results as unknown as Prisma.InputJsonValue,
                deliveryState: old?.deliveryState === 'recorded' ? 'recorded' : 'pending',
                deliveryReason: null,
                deliveryAttempts: 0,
                mappingAttempts: 0,
                nextAttemptAt: new Date(),
              },
            })
          : await tx.intentHandoff.create({
              data: {
                id: input.id,
                workspaceId,
                repoKey: input.repoKey,
                headSha: input.headSha,
                prNumber: input.prNumber,
                payload: payload as unknown as Prisma.InputJsonValue,
                createdBy: actor.id,
                updatedBy: actor.id,
              },
            });
        return { response: handoffView(row), audits: [] };
      },
    );
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.intentHandoff.findFirst({ where: { workspaceId, id } });
    if (!row) throw new NotFoundException('handoff_not_found');
    return handoffView(row);
  }

  async list(workspaceId: string, input: { repoKey?: string; before?: string; limit: number }) {
    if (
      input.before &&
      !(await this.prisma.intentHandoff.count({
        where: {
          id: input.before,
          workspaceId,
          ...(input.repoKey ? { repoKey: input.repoKey } : {}),
        },
      }))
    )
      throw new NotFoundException('handoff_cursor_not_found');
    const rows = await this.prisma.intentHandoff.findMany({
      where: {
        workspaceId,
        ...(input.repoKey ? { repoKey: input.repoKey } : {}),
      },
      ...(input.before ? { cursor: { id: input.before }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        repoKey: true,
        version: true,
        headSha: true,
        prNumber: true,
        mappingState: true,
        mappingReason: true,
        deliveryState: true,
        deliveryReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      operations: rows.slice(0, input.limit),
      truncated: rows.length > input.limit,
      nextBefore: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
    };
  }
}
