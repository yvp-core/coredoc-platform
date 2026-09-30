import { Injectable } from '@nestjs/common';
import {
  NodeType,
  resolveAnchorEnvelope,
  type AnchorEnvelope,
  type AnchorRecord,
  type GraphNode,
  type ResolvedMapping,
} from '@coredoc/core';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentAuditEntityKind } from '../../generated/prisma/client.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import type { HandoffSnapshot } from './intent-handoff.operations.js';
import { readWorkspaceIntentRepoIdentities, unknownRepoKeyError } from './intent-repo-keys.js';

import { IntentErrorCode } from './contract/index.js';
import { intentConflict } from './intent-state-errors.js';
import { IntentAuditOperation, type IntentActor, type IntentTransaction } from './intent-idempotency.js';

function conflict(reason: IntentErrorCode): never {
  throw intentConflict(reason, `Intent anchors unavailable: ${reason}. Nothing was written.`, []);
}

/**
 * The actor recorded on every CI anchor write — same identity the processor
 * uses for the handoff row itself. Defined here rather than imported from
 * `intent-handoff-processor.service.ts` (which already imports THIS service)
 * to avoid a circular module dependency for one constant.
 */
const HANDOFF_ACTOR: IntentActor = { id: 'system:intent-handoff', role: 'system' };

/** Bounded projection audited for an anchor row — identity and drift baseline, never a row dump. */
function anchorAuditProjection(anchor: {
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
}) {
  return {
    itemId: anchor.itemId,
    repoKey: anchor.repoKey,
    nodeId: anchor.nodeId,
    nodeType: anchor.nodeType,
    capturedVersionedId: anchor.capturedVersionedId,
  };
}
export interface IntentHandoffItemResult {
  itemId: string;
  outcome: 'mapped' | 'no_implementation' | 'unresolved' | 'manual_override';
  reason?: string;
  authorityVersion?: number;
  oldNodeIds?: string[];
  nodeIds?: string[];
  manualOverrides?: string[];
}

@Injectable()
export class IntentHandoffAnchorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: WorkspaceMcpContextService,
  ) {}

  async prepare(workspaceId: string, input: HandoffSnapshot, envelope: AnchorEnvelope) {
    const identities = await readWorkspaceIntentRepoIdentities(this.prisma, workspaceId);
    const repoHash = identities.graphKeyByDurableKey.get(input.repoKey);
    if (!repoHash) throw unknownRepoKeyError(identities, [input.repoKey], ['repoKey']);
    const anchors = await this.readReplacements(workspaceId, input.repoKey, envelope);
    const { resolution, scanLimitReached } = await this.resolveMapping(workspaceId, repoHash, input, envelope, anchors);
    return scanLimitReached
      ? envelope.bindings.map(
          (binding): ResolvedMapping => ({ itemId: binding.itemId, kind: 'unresolved', reason: 'target_unresolved' }),
        )
      : resolution.mappings;
  }

  /** Caller holds the handoff row; graph and item locks keep its result atomic with the anchors. */
  async applyPrepared(tx: IntentTransaction, workspaceId: string, input: HandoffSnapshot, mappings: ResolvedMapping[]) {
    await this.lockCurrentState(tx, workspaceId, input);
    const results: IntentHandoffItemResult[] = [];
    for (const mapping of [...mappings].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)))
      results.push(await this.applyItem(tx, workspaceId, input.repoKey, mapping));
    return results;
  }

  private async readReplacements(
    workspaceId: string,
    repoKey: string,
    envelope: AnchorEnvelope,
  ): Promise<AnchorRecord[]> {
    const replacementIds = [...new Set(envelope.bindings.flatMap((b) => b.replaceNodeIds))];
    const prior = replacementIds.length
      ? await this.prisma.intentAnchor.findMany({
          where: {
            workspaceId,
            repoKey,
            itemId: { in: envelope.bindings.map((b) => b.itemId) },
            nodeId: { in: replacementIds },
          },
        })
      : [];
    return prior.map((a) => ({
      itemId: a.itemId,
      repoKey: a.repoKey,
      nodeId: a.nodeId,
      nodeType: a.nodeType,
      capturedVersionedId: a.capturedVersionedId,
      source: a.source === 'ci' ? 'ci' : 'manual',
      // Only the ordinary file/symbol ID shapes have an unambiguous path segment.
      // Unknown paths prohibit drift instead of inventing provenance after deletion.
      filePath:
        a.nodeId.split(':').length === (a.nodeType === NodeType.File ? 3 : 4) ? (a.nodeId.split(':')[2] ?? '') : '',
      ...(a.disabledAt ? { disabledAt: a.disabledAt.toISOString(), disabledBy: a.disabledBy ?? undefined } : {}),
    }));
  }

  private async resolveMapping(
    workspaceId: string,
    repoHash: string,
    input: HandoffSnapshot,
    envelope: AnchorEnvelope,
    anchors: AnchorRecord[],
  ) {
    return this.context.withContextByWorkspaceId(workspaceId, async (ctx) => {
      let scanLimitReached = false;
      if (ctx.versionId !== input.graphVersionId) conflict(IntentErrorCode.BindingsSnapshotMismatch);
      const [overview] = await ctx.repository.getRepoOverview([repoHash]);
      if (overview?.gitCommitHash !== input.graphCommit) conflict(IntentErrorCode.BindingsSnapshotMismatch);
      const ids = new Set<string>();
      const namesByPath = new Map<string, Set<string>>();
      for (const binding of envelope.bindings) {
        for (const path of binding.files) ids.add(`${repoHash}:file:${path}`);
        for (const locator of binding.symbols) {
          const separator = locator.lastIndexOf('#');
          const path = locator.slice(0, separator);
          const name = locator.slice(separator + 1);
          const names = namesByPath.get(path) ?? new Set<string>();
          names.add(name);
          const dot = name.lastIndexOf('.');
          if (dot > 0) {
            names.add(name.slice(0, dot));
            names.add(name.slice(dot + 1));
          }
          namesByPath.set(path, names);
        }
      }
      // Fetch only files explicitly named by this bounded PR, never scan the KB/repo.
      for (const [path, names] of namesByPath) {
        const symbols = await ctx.repository.listSymbolsInFile(path, [repoHash]);
        if (symbols.length > 2000) {
          scanLimitReached = true;
          break;
        }
        for (const symbol of symbols) if (symbol.filePath === path && names.has(symbol.name)) ids.add(symbol.id);
      }
      if (ids.size > 2000) scanLimitReached = true;
      const nodes: GraphNode[] = [];
      for (const id of scanLimitReached ? [] : ids) {
        const found = await ctx.repository.getNodeWithProperties(id, [repoHash]);
        if (found) nodes.push({ ...found.node, properties: found.properties });
      }
      const resolution = resolveAnchorEnvelope(
        envelope,
        { repoKey: input.repoKey, repoHash, commit: input.graphCommit, graphVersionId: input.graphVersionId, nodes },
        anchors,
      );
      return { resolution, scanLimitReached };
    });
  }

  private async lockCurrentState(tx: IntentTransaction, workspaceId: string, input: HandoffSnapshot) {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
    const [lock] = await tx.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${workspaceId}, 0)) AS locked`;
    if (!lock?.locked) conflict(IntentErrorCode.AnchorsPublishBusy);
    await tx.$queryRaw`SELECT id FROM workspace_repos WHERE workspace_id = ${workspaceId}::uuid AND intent_repo_key = ${input.repoKey} FOR UPDATE`;
    const currentRepo = await tx.workspaceRepo.findFirstOrThrow({
      where: { workspaceId, intentRepoKey: input.repoKey },
    });
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { activeGraphVersionId: true },
    });
    if (workspace.activeGraphVersionId !== input.graphVersionId) conflict(IntentErrorCode.BindingsSnapshotMismatch);
    if (
      currentRepo.intentRepoKey !== input.repoKey ||
      (currentRepo.productionBranch && currentRepo.productionBranch !== input.branch)
    )
      conflict(IntentErrorCode.AnchorsRepoChanged);
  }

  private async applyItem(
    tx: IntentTransaction,
    workspaceId: string,
    repoKey: string,
    mapping: ResolvedMapping,
  ): Promise<IntentHandoffItemResult> {
    await tx.$queryRaw`SELECT id FROM intent_items WHERE workspace_id = ${workspaceId}::uuid AND id = ${mapping.itemId} FOR UPDATE`;
    const item = await tx.intentItem.findUnique({
      where: { workspaceId_id: { workspaceId, id: mapping.itemId } },
      select: { authority: true, version: true },
    });
    const identity = { itemId: mapping.itemId, authorityVersion: item?.version };
    if (!item || item.authority !== 'accepted')
      return {
        ...identity,
        outcome: 'unresolved',
        reason: item ? 'item_not_accepted' : 'item_not_found',
      };
    if (mapping.kind === 'unresolved') return { ...identity, outcome: 'unresolved', reason: mapping.reason };

    const nodeIds = [...new Set([...mapping.replaceNodeIds, ...mapping.targets.map((t) => t.nodeId)])];
    const existing = await tx.intentAnchor.findMany({
      where: { workspaceId, repoKey, itemId: mapping.itemId, nodeId: { in: nodeIds } },
    });
    const byNodeId = new Map(existing.map((anchor) => [anchor.nodeId, anchor]));
    if (mapping.replaceNodeIds.some((id) => byNodeId.get(id)?.source !== 'ci'))
      return {
        ...identity,
        outcome: 'unresolved',
        reason: 'replacement_not_ci_anchor',
      };
    const overrides = new Set(existing.filter((a) => a.source !== 'ci' || a.disabledAt).map((a) => a.nodeId));
    const targets = new Map(mapping.targets.map((target) => [target.nodeId, target]));
    const removedNodeIds = mapping.replaceNodeIds.filter(
      (id) => !targets.has(id) && byNodeId.get(id)?.source === 'ci' && !byNodeId.get(id)?.disabledAt,
    );
    await tx.intentAnchor.deleteMany({
      where: {
        workspaceId,
        repoKey,
        itemId: mapping.itemId,
        source: 'ci',
        disabledAt: null,
        nodeId: { in: removedNodeIds },
      },
    });
    // Audited like a manual anchor write (`intent-anchor.service.ts`'s
    // `auditOf`), in the SAME transaction as the row change — an anchor's
    // audit trail must not distinguish "a person wrote this" from "CI wrote
    // this", only WHO (the actor below is `system:intent-handoff`, never a
    // human identity) and WHAT changed.
    for (const nodeId of removedNodeIds) {
      const before = byNodeId.get(nodeId);
      if (!before) continue;
      await tx.intentAuditEvent.create({
        data: {
          workspaceId,
          entityKind: IntentAuditEntityKind.anchor,
          entityId: before.id.toString(),
          operation: IntentAuditOperation.Delete,
          actorId: HANDOFF_ACTOR.id,
          actorRole: HANDOFF_ACTOR.role,
          before: anchorAuditProjection(before),
        },
      });
    }
    for (const target of targets.values()) {
      if (overrides.has(target.nodeId)) continue;
      const old = byNodeId.get(target.nodeId);
      // A re-map that lands the anchor back on the same nodeType/versionedId
      // is a no-op: nothing changed, so neither the row nor its audit trail
      // should record a write.
      if (old && old.nodeType === target.nodeType && old.capturedVersionedId === target.capturedVersionedId) continue;
      const data = { nodeType: target.nodeType, capturedVersionedId: target.capturedVersionedId };
      const anchor = old
        ? await tx.intentAnchor.update({ where: { id: old.id }, data })
        : await tx.intentAnchor.create({
            data: {
              ...data,
              workspaceId,
              repoKey,
              itemId: mapping.itemId,
              nodeId: target.nodeId,
              source: 'ci',
              createdBy: 'system:intent-handoff',
            },
          });
      await tx.intentAuditEvent.create({
        data: {
          workspaceId,
          entityKind: IntentAuditEntityKind.anchor,
          entityId: anchor.id.toString(),
          operation: old ? IntentAuditOperation.Update : IntentAuditOperation.Create,
          actorId: HANDOFF_ACTOR.id,
          actorRole: HANDOFF_ACTOR.role,
          ...(old ? { before: anchorAuditProjection(old) } : {}),
          after: anchorAuditProjection(anchor),
        },
      });
    }
    return {
      ...identity,
      outcome: overrides.size ? 'manual_override' : mapping.kind,
      oldNodeIds: mapping.replaceNodeIds,
      nodeIds: [...targets.keys()].filter((id) => !overrides.has(id)),
      manualOverrides: [...overrides],
    };
  }
}
