/**
 * Workspace export: the workspace's intent content as a `CloudIntentWorkspaceDocumentV1`,
 * the document `POST intent/import/workspace` takes. Importing it into an empty
 * workspace and exporting again yields the same document, so a team can move a
 * knowledge base out, edit it elsewhere and bring it back, or roll back to a copy.
 *
 * It carries content, not history: the tree (archived flags included), the
 * dimension registry, node relations, every item (accepted, candidate, superseded,
 * rejected) with its sources and replacement pointers, and delivery state as one
 * baseline (what is in production now) plus the active plans. It does not carry
 * versions, timestamps, actors, authority transitions, code anchors, feature seeds
 * or the release history behind the current state; the `GET intent/export`
 * projection keeps those. One pointer is dropped on purpose: a waiting candidate
 * whose predecessor is no longer accepted (another proposal replaced it first)
 * can no longer replace it, so it travels as a plain candidate.
 *
 * The document is checked with the import's own validator before it is returned,
 * so an export that could not be imported back is refused with the import's
 * refusal paths instead of being handed out.
 */
import { createHash } from 'node:crypto';
import { canonicalIntentJson, type IntentDimension } from '@coredoc/core';
import type { PrismaService } from '../../database/prisma.service.js';
import { IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';
import { readReleaseSnapshot } from './intent-release.service.js';
import { treeConditionsOf } from './intent-tree.service.js';
import {
  CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
  INTENT_WORKSPACE_IMPORT_LIMITS,
  validateWorkspaceDocument,
  type CloudIntentWorkspaceDocumentV1,
} from './intent-workspace-import.js';

/** The `source.ref` of an exported document. Not workspace-specific, so a round trip compares equal. */
export const INTENT_WORKSPACE_EXPORT_REF = 'coredoc-workspace-export';

/** The baseline's `deliveredRef` when the workspace has delivery evidence but no named release. */
const EXPORT_DELIVERED_REF = 'coredoc-workspace-export';

type Document = CloudIntentWorkspaceDocumentV1;
type DocumentItem = Document['items'][number];

const nonEmpty = (value: Prisma.JsonValue | null): unknown[] | undefined =>
  Array.isArray(value) && value.length > 0 ? value : undefined;

export async function readWorkspaceDocument(prisma: PrismaService, workspaceId: string): Promise<Document> {
  const read = await prisma.$transaction(
    async (tx) => {
      const [domains, features, dimensions, relations, items, sources, planEvents] = await Promise.all([
        tx.intentDomain.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
        tx.intentFeature.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
        tx.intentDimension.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
        tx.intentNodeRelation.findMany({
          where: { workspaceId },
          orderBy: [{ fromKind: 'asc' }, { fromId: 'asc' }, { toKind: 'asc' }, { toId: 'asc' }],
        }),
        tx.intentItem.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
        tx.intentItemSource.findMany({
          where: { workspaceId },
          orderBy: [{ itemId: 'asc' }, { kind: 'asc' }, { ref: 'asc' }, { localId: 'asc' }],
        }),
        tx.intentReleaseEvent.findMany({
          where: { workspaceId, kind: 'plan' },
          orderBy: { seq: 'asc' },
          select: { reason: true, data: true },
        }),
      ]);
      return {
        domains,
        features,
        dimensions,
        relations,
        items,
        sources,
        planEvents,
        release: await readReleaseSnapshot(tx, workspaceId),
      };
    },
    // One snapshot for every read; a large knowledge base needs more than the 5s default.
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
  );

  // The document must be importable back, so the import's own ceilings bound it.
  for (const [collection, count] of [
    ['items', read.items.length],
    ['domains', read.domains.length],
    ['features', read.features.length],
    ['relations', read.relations.length],
  ] as const) {
    if (count > INTENT_WORKSPACE_IMPORT_LIMITS[collection]) {
      throw intentStateError(
        IntentErrorCode.ExportTooLarge,
        `This workspace holds ${count} intent ${collection}; a workspace document carries at most ${INTENT_WORKSPACE_IMPORT_LIMITS[collection]}.`,
        [collection],
      );
    }
  }

  const sourcesByItem = new Map<string, DocumentItem['sources']>();
  for (const row of read.sources) {
    const list = sourcesByItem.get(row.itemId) ?? [];
    list.push({
      kind: row.kind as DocumentItem['sources'][number]['kind'],
      ref: row.ref,
      localId: row.localId,
      ...(row.revision ? { revision: row.revision } : {}),
      ...(row.locator ? { locator: row.locator } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.url ? { url: row.url } : {}),
    });
    sourcesByItem.set(row.itemId, list);
  }

  const node = (row: {
    id: string;
    title: string;
    statement: string;
    appliesWhen: Prisma.JsonValue;
    layout: Prisma.JsonValue;
    archived: boolean;
  }) => ({
    id: row.id,
    title: row.title,
    ...(row.statement ? { statement: row.statement } : {}),
    ...(treeConditionsOf(row.appliesWhen) ? { appliesWhen: treeConditionsOf(row.appliesWhen) } : {}),
    ...(nonEmpty(row.layout) ? { layout: nonEmpty(row.layout) } : {}),
    ...(row.archived ? { archived: true } : {}),
  });

  const authorityOf = new Map(read.items.map((row) => [row.id, row.authority as string]));
  const items: DocumentItem[] = read.items.map((row) => ({
    id: row.id,
    kind: row.kind as DocumentItem['kind'],
    ...(row.featureId ? { featureId: row.featureId } : row.domainId ? { domainId: row.domainId } : {}),
    title: row.title,
    statement: row.statement,
    ...(row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? { payload: row.payload as Record<string, unknown> }
      : {}),
    ...(nonEmpty(row.appliesWhen) ? { appliesWhen: nonEmpty(row.appliesWhen) as DocumentItem['appliesWhen'] } : {}),
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(nonEmpty(row.body) ? { body: nonEmpty(row.body) as string[] } : {}),
    authority: row.authority as DocumentItem['authority'],
    ...(row.authority === IntentItemAuthority.superseded && row.supersededById
      ? { supersededById: row.supersededById }
      : {}),
    ...(row.proposedSuccessorOfId &&
    !(row.authority === IntentItemAuthority.candidate && authorityOf.get(row.proposedSuccessorOfId) !== 'accepted')
      ? { proposedSuccessorOfId: row.proposedSuccessorOfId }
      : {}),
    sources: sourcesByItem.get(row.id) ?? [],
  }));

  const inProduction = items
    .filter(
      (item) =>
        (item.authority === 'accepted' || item.authority === 'superseded') &&
        read.release.effectivity(item.id) === 'effective',
    )
    .map((item) => item.id);
  // The reason a plan was recorded with is part of the plan; the latest event per item wins.
  const planReason = new Map<string, string>();
  for (const event of read.planEvents) {
    const itemId = (event.data as { itemId?: string } | null)?.itemId;
    if (itemId) planReason.set(itemId, event.reason);
  }
  const inProductionIds = new Set(inProduction);
  const plans = items
    .filter(
      (item) =>
        item.authority === 'accepted' && read.release.planState(item.id) === 'active' && !inProductionIds.has(item.id),
    )
    .map((item) => ({ itemId: item.id, ...(planReason.has(item.id) ? { reason: planReason.get(item.id) } : {}) }));

  // Untyped until the import validator below parses it into a `Document`.
  const body = {
    domains: read.domains.map(node),
    features: read.features.map((row) => ({
      ...node(row),
      domainId: row.domainId,
      ...(row.parentFeatureId ? { parentFeatureId: row.parentFeatureId } : {}),
    })),
    ...(read.dimensions.length > 0
      ? {
          dimensions: read.dimensions.map(
            (row): IntentDimension => ({
              id: row.id,
              title: row.title,
              values: row.values as unknown as IntentDimension['values'],
              multi: row.multi,
            }),
          ),
        }
      : {}),
    ...(read.relations.length > 0
      ? {
          relations: read.relations.map((row) => ({
            from: { kind: row.fromKind, id: row.fromId },
            to: { kind: row.toKind, id: row.toId },
            why: row.why,
          })),
        }
      : {}),
    items,
    ...(inProduction.length > 0 || plans.length > 0
      ? {
          releases: {
            ...(inProduction.length > 0
              ? {
                  baseline: {
                    deliveredRef: read.release.currentRelease?.deliveredRef ?? EXPORT_DELIVERED_REF,
                    itemIds: inProduction,
                  },
                }
              : {}),
            ...(plans.length > 0 ? { plans } : {}),
          },
        }
      : {}),
  };

  const document = {
    formatVersion: CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
    // The revision is the content's own digest: two exports of the same content name the same revision.
    source: {
      ref: INTENT_WORKSPACE_EXPORT_REF,
      revision: createHash('sha256').update(canonicalIntentJson(body)).digest('hex'),
    },
    ...body,
  };
  return validateWorkspaceDocument(document as unknown as Record<string, unknown>);
}
