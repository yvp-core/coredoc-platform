/**
 * Anchor add / refresh / remove / preview on ACCEPTED items (spec §4.6, §7).
 *
 * An anchor is a code touchpoint plus the drift baseline observed when it was
 * captured. Everything graph-owned about it comes from
 * {@link IntentAnchorTargetService}; this service owns only the row lifecycle,
 * the accepted-only rule, and the audit trail.
 *
 * ORDER OF WORK, and why it is this order:
 *
 * 1. The REPLAY PEEK (`findSpentIntentRequest` against the client). A committed key returns its stored
 *    response here, before any graph work: anchor resolution refuses rather than
 *    degrades, so a replay that reached the graph would fail with
 *    `anchor_node_missing` the moment the node was gone — turning "retry returns
 *    the stored result" into "retry is a 404".
 * 2. Cheap state checks against the client (item exists, item is accepted) —
 *    fail fast, before leasing a graph snapshot for a request that cannot land.
 * 3. Graph resolution, OUTSIDE the transaction. A snapshot lease is the slow,
 *    network-bound half; holding one open across a PostgreSQL transaction would
 *    hold row locks for its duration.
 * 4. `runIntentMutation`: replay check, the item row LOCK, the authoritative
 *    re-check of the item's authority, the row write, the audit row, the ledger
 *    row — one transaction.
 *
 * The item check therefore runs twice on a write. That is deliberate: the first
 * is an optimisation and the second is the one that is actually sound, because
 * only it is serialized with the write — and it is only serialized because the
 * in-transaction check takes `SELECT … FOR UPDATE` on the item row FIRST. Without
 * that lock a concurrent supersede can commit between the re-check and the anchor
 * upsert, landing an anchor on an item that is no longer accepted.
 *
 * REMOVE DOES NOT TOUCH THE GRAPH. Deleting an anchor is cleanup, and the most
 * likely reason to want it is that the node is gone — a remove that first
 * demanded a resolvable node would refuse exactly when it is needed most.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { IntentAuditEntityKind, IntentItemAuthority } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IntentErrorCode,
  type AddIntentAnchorInput,
  type RefreshIntentAnchorInput,
  type RemoveIntentAnchorInput,
} from './contract/index.js';
import { IntentAnchorTargetService, type ResolvedAnchorTarget } from './intent-anchor-target.js';
import type { PreviewIntentAnchorQuery } from './intent-anchor.operations.js';
import {
  IntentAuditOperation,
  IntentOperation,
  findSpentIntentRequest,
  hashIntentRequest,
  runIntentMutation,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
} from './intent-idempotency.js';
import { intentNotFound, intentStateError } from './intent-state-errors.js';

/** The anchor as the API reports it. */
export interface IntentAnchorView extends ResolvedAnchorTarget {
  itemId: string;
  rationale: string | null;
  createdBy: string;
  createdAt: string;
  source: 'manual' | 'ci';
  disabledAt: string | null;
  disabledBy: string | null;
}

export interface PreviewIntentAnchorResult {
  /** What a write would store, resolved through the identical path. */
  target: ResolvedAnchorTarget;
  /** The snapshot the facts were read from (§6.3 provenance). */
  graphVersionId: string | null;
  /** Stored identity, including source/removal state. A disabled row requires explicit add to restore, never refresh. */
  existing: IntentAnchorView | null;
  /** True when a write would create a row rather than refresh one. */
  wouldCreate: boolean;
  /** True when the stored baseline differs from what the snapshot says now. */
  drifted: boolean;
}

/** The reader shape both a transaction and the client satisfy. */
type ItemReader = Pick<IntentTransaction, 'intentItem'>;

@Injectable()
export class IntentAnchorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: IntentAnchorTargetService,
  ) {}

  /* ------------------------------------------------------------- preview --- */

  async preview(workspaceId: string, query: PreviewIntentAnchorQuery): Promise<PreviewIntentAnchorResult> {
    await assertAcceptedItem(this.prisma, workspaceId, query.itemId, ['itemId']);
    const resolution = await this.targets.resolve(this.prisma, workspaceId, [
      { repoKey: query.repoKey, nodeId: query.nodeId, path: [] },
    ]);
    const target = firstTarget(resolution.targets);

    const existing = await this.prisma.intentAnchor.findUnique({
      where: anchorIdentity(workspaceId, query.itemId, query.repoKey, query.nodeId),
    });

    return {
      target,
      graphVersionId: resolution.graphVersionId,
      existing: existing ? viewOf(existing) : null,
      wouldCreate: existing === null,
      drifted: existing !== null && existing.capturedVersionedId !== target.capturedVersionedId,
    };
  }

  /* ----------------------------------------------------------------- add --- */

  async add(
    workspaceId: string,
    actor: IntentActor,
    input: AddIntentAnchorInput,
  ): Promise<{ anchor: IntentAnchorView; created: boolean; graphVersionId: string | null }> {
    const replay = await findSpentIntentRequest(
      this.prisma,
      workspaceId,
      input.idempotencyKey,
      IntentOperation.AnchorAdd,
      hashIntentRequest(IntentOperation.AnchorAdd, input),
    );
    if (replay) return replay.response as { anchor: IntentAnchorView; created: boolean; graphVersionId: string | null };

    await assertAcceptedItem(this.prisma, workspaceId, input.itemId, ['itemId']);
    const resolution = await this.targets.resolve(this.prisma, workspaceId, [
      { repoKey: input.repoKey, nodeId: input.nodeId, path: [] },
    ]);
    const target = firstTarget(resolution.targets);

    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.AnchorAdd,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await lockAcceptedItem(tx, workspaceId, input.itemId, ['itemId']);
        const existing = await tx.intentAnchor.findUnique({
          where: anchorIdentity(workspaceId, input.itemId, input.repoKey, input.nodeId),
        });

        // Add on an existing identity re-captures the baseline rather than
        // failing: the identity is `(item, repo, node)`, and "anchor this again"
        // means the same thing as "refresh it" for everything but the rationale,
        // which an add is allowed to restate.
        const anchor = existing
          ? await tx.intentAnchor.update({
              where: { id: existing.id },
              data: {
                disabledAt: null,
                disabledBy: null,
                nodeType: target.nodeType,
                capturedVersionedId: target.capturedVersionedId,
                ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
              },
            })
          : await tx.intentAnchor.create({
              data: {
                workspaceId,
                itemId: input.itemId,
                repoKey: target.repoKey,
                nodeId: target.nodeId,
                nodeType: target.nodeType,
                capturedVersionedId: target.capturedVersionedId,
                rationale: input.rationale ?? null,
                createdBy: actor.id,
              },
            });

        return {
          response: {
            anchor: viewOf(anchor),
            created: existing === null,
            graphVersionId: resolution.graphVersionId,
          },
          audits: [
            auditOf(anchor.id, existing ? IntentAuditOperation.Update : IntentAuditOperation.Create, anchor, existing),
          ],
        };
      },
    );
  }

  /* ------------------------------------------------------------- refresh --- */

  async refresh(
    workspaceId: string,
    actor: IntentActor,
    input: RefreshIntentAnchorInput,
  ): Promise<{
    anchor: IntentAnchorView;
    changed: boolean;
    previousCapturedVersionedId: string;
    graphVersionId: string | null;
  }> {
    const replay = await findSpentIntentRequest(
      this.prisma,
      workspaceId,
      input.idempotencyKey,
      IntentOperation.AnchorRefresh,
      hashIntentRequest(IntentOperation.AnchorRefresh, input),
    );
    if (replay) {
      return replay.response as {
        anchor: IntentAnchorView;
        changed: boolean;
        previousCapturedVersionedId: string;
        graphVersionId: string | null;
      };
    }

    await assertAcceptedItem(this.prisma, workspaceId, input.itemId, ['itemId']);
    const resolution = await this.targets.resolve(this.prisma, workspaceId, [
      { repoKey: input.repoKey, nodeId: input.nodeId, path: [] },
    ]);
    const target = firstTarget(resolution.targets);

    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.AnchorRefresh,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await lockAcceptedItem(tx, workspaceId, input.itemId, ['itemId']);
        const existing = await requireAnchor(tx, workspaceId, input.itemId, input.repoKey, input.nodeId);
        if (existing.disabledAt)
          throw intentNotFound(
            IntentErrorCode.AnchorNotFound,
            'This anchor was removed; add it explicitly to restore it.',
            ['nodeId'],
          );
        const anchor = await tx.intentAnchor.update({
          where: { id: existing.id },
          data: { nodeType: target.nodeType, capturedVersionedId: target.capturedVersionedId },
        });

        return {
          response: {
            anchor: viewOf(anchor),
            changed: existing.capturedVersionedId !== anchor.capturedVersionedId,
            previousCapturedVersionedId: existing.capturedVersionedId,
            graphVersionId: resolution.graphVersionId,
          },
          audits: [auditOf(anchor.id, IntentAuditOperation.Update, anchor, existing)],
        };
      },
    );
  }

  /* -------------------------------------------------------------- remove --- */

  async remove(
    workspaceId: string,
    actor: IntentActor,
    input: RemoveIntentAnchorInput,
  ): Promise<{ removed: true; anchor: IntentAnchorView }> {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.AnchorRemove,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await lockAcceptedItem(tx, workspaceId, input.itemId, ['itemId']);
        const existing = await requireAnchor(tx, workspaceId, input.itemId, input.repoKey, input.nodeId);
        if (existing.source === 'ci') {
          await tx.intentAnchor.update({
            where: { id: existing.id },
            data: {
              disabledAt: existing.disabledAt ?? new Date(),
              disabledBy: existing.disabledBy ?? actor.id,
            },
          });
        } else await tx.intentAnchor.delete({ where: { id: existing.id } });

        return {
          response: { removed: true as const, anchor: viewOf(existing) },
          audits: [auditOf(existing.id, IntentAuditOperation.Delete, null, existing)],
        };
      },
    );
  }
}

/* ------------------------------------------------------------------ rows --- */

/** The stored row, narrowed to what this module reads back. */
interface AnchorRow {
  id: bigint;
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  createdBy: string;
  createdAt: Date;
  source?: string;
  disabledAt?: Date | null;
  disabledBy?: string | null;
}

function anchorIdentity(workspaceId: string, itemId: string, repoKey: string, nodeId: string) {
  return { workspaceId_itemId_repoKey_nodeId: { workspaceId, itemId, repoKey, nodeId } };
}

function viewOf(anchor: AnchorRow): IntentAnchorView {
  return {
    itemId: anchor.itemId,
    repoKey: anchor.repoKey,
    nodeId: anchor.nodeId,
    nodeType: anchor.nodeType,
    capturedVersionedId: anchor.capturedVersionedId,
    rationale: anchor.rationale,
    createdBy: anchor.createdBy,
    createdAt: anchor.createdAt.toISOString(),
    source: anchor.source === 'ci' ? 'ci' : 'manual',
    disabledAt: anchor.disabledAt?.toISOString() ?? null,
    disabledBy: anchor.disabledBy ?? null,
  };
}

/** Bounded projections — identity and the drift baseline, never a row dump. */
function projectionOf(anchor: AnchorRow): Record<string, unknown> {
  return {
    itemId: anchor.itemId,
    repoKey: anchor.repoKey,
    nodeId: anchor.nodeId,
    nodeType: anchor.nodeType,
    capturedVersionedId: anchor.capturedVersionedId,
  };
}

function auditOf(
  id: bigint,
  operation: IntentAuditOperation,
  after: AnchorRow | null,
  before: AnchorRow | null,
): IntentAuditRecord {
  return {
    entityKind: IntentAuditEntityKind.anchor,
    entityId: id.toString(),
    operation,
    ...(before ? { before: projectionOf(before) } : {}),
    ...(after ? { after: projectionOf(after) } : {}),
  };
}

async function requireAnchor(
  tx: IntentTransaction,
  workspaceId: string,
  itemId: string,
  repoKey: string,
  nodeId: string,
): Promise<AnchorRow> {
  const existing = await tx.intentAnchor.findUnique({ where: anchorIdentity(workspaceId, itemId, repoKey, nodeId) });
  if (existing) return existing;
  throw intentStateError(
    IntentErrorCode.AnchorNotFound,
    `This item carries no anchor on that node in repository '${repoKey}'.`,
    ['nodeId'],
    HttpStatus.NOT_FOUND,
  );
}

/**
 * The IN-TRANSACTION check: take the item's row lock, THEN read its authority.
 *
 * `SELECT … FOR UPDATE` is what makes the accepted-only rule hold under
 * concurrency. Review's supersede updates this same row, so it must either wait
 * for this transaction or already have committed — either way the authority read
 * below is the one that is still true when the anchor is written. Without the
 * lock the two transactions interleave happily and an anchor lands on an item
 * that was superseded a moment earlier.
 *
 * A missing row locks nothing and reports `item_not_found`, which is the same
 * answer the read-only check gives.
 */
async function lockAcceptedItem(tx: IntentTransaction, workspaceId: string, itemId: string, path: string[]) {
  await tx.$queryRaw`
    SELECT 1 FROM intent_items
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${itemId}
    FOR UPDATE
  `;
  await assertAcceptedItem(tx, workspaceId, itemId, path);
}

/**
 * Anchors are edited on ACCEPTED items only (spec §7).
 *
 * A candidate's anchors arrive through propose as suggestions and are settled by
 * the review that accepts it; editing them directly would be an authority change
 * dressed up as a touchpoint edit.
 *
 * Sound only when the caller has already serialized itself against a concurrent
 * authority change — inside a transaction that means {@link lockAcceptedItem};
 * against the client it is the cheap pre-check the file header describes.
 */
async function assertAcceptedItem(reader: ItemReader, workspaceId: string, itemId: string, path: string[]) {
  const item = await reader.intentItem.findUnique({
    where: { workspaceId_id: { workspaceId, id: itemId } },
    select: { id: true, authority: true },
  });
  if (!item) {
    throw intentNotFound(
      IntentErrorCode.ItemNotFound,
      `Intent item '${itemId}' does not exist in this workspace`,
      path,
    );
  }
  if (item.authority !== IntentItemAuthority.accepted) {
    throw intentStateError(
      IntentErrorCode.ItemNotAccepted,
      `Anchors are edited on accepted items only; item '${itemId}' is ${item.authority}.`,
      path,
    );
  }
}

function firstTarget(targets: readonly ResolvedAnchorTarget[]): ResolvedAnchorTarget {
  const target = targets[0];
  // Unreachable: one request in, one target or a throw out. Loud rather than
  // silently anchoring nothing.
  if (!target) throw new Error('Anchor resolution returned no target for a single-target request');
  return target;
}
