/**
 * The export projection (spec §9): every committed intent row of one workspace,
 * in a stable order, under a content hash.
 *
 * A read, so no idempotency key and no ledger row. It is also the only intent
 * read that is deliberately NOT paginated: an export is a backup, and a backup
 * split across cursors is not one. Unboundedness is instead handled by failing
 * fast — each table is read one row past {@link MAX_EXPORT_ROWS_PER_COLLECTION}
 * and a workspace over that ceiling is refused by name rather than silently
 * truncated into a document that would look complete.
 *
 * ONE TRANSACTION, ONE SNAPSHOT. The reads are batched into a single
 * `$transaction`, so they all observe the same committed state. Read
 * independently they could not: a propose committing between the `items` read
 * and the `sources` read produces a document whose sources reference an item it
 * does not contain — an inconsistent backup, taken at the moment (teardown, §9)
 * when it is the only copy that will exist. A batch `$transaction` runs the
 * queries in one PostgreSQL transaction; the ceiling checks stay outside it,
 * because they only inspect row counts already in hand. REPEATABLE READ, not the
 * Read Committed default: under Read Committed each statement takes
 * its own snapshot, which is the very interleaving this batching exists to rule out.
 *
 * Ordering and hashing live in `intent-export.operations.ts` with the format
 * they belong to; this file's job is only to read the rows in that order.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  CLOUD_INTENT_EXPORT_FORMAT_VERSION,
  hashExportContent,
  type CloudIntentExportAnchor,
  type CloudIntentExportContent,
  type CloudIntentExportDimension,
  type CloudIntentExportDomain,
  type CloudIntentExportFeature,
  type CloudIntentExportItem,
  type CloudIntentExportSeed,
  type CloudIntentExportSource,
  type CloudIntentExportTransition,
  type CloudIntentExportV1,
} from './intent-export.operations.js';
import { intentStateError } from './intent-state-errors.js';
import { treeConditionsOf } from './intent-tree.service.js';
import { IntentErrorCode } from './contract/index.js';
import { readWorkspaceDocument } from './intent-workspace-export.js';
import type { CloudIntentWorkspaceDocumentV1 } from './intent-workspace-import.js';

/**
 * Per-collection row ceiling. Well above any reviewed knowledge base — the
 * import path alone is capped at 500 items by the overlay format — and low
 * enough that one export stays a document rather than a memory event.
 */
export const MAX_EXPORT_ROWS_PER_COLLECTION = 50_000;

const iso = (value: Date): string => value.toISOString();

@Injectable()
export class IntentExportService {
  constructor(private readonly prisma: PrismaService) {}

  async export(workspaceId: string): Promise<CloudIntentExportV1> {
    const content = await this.readContent(workspaceId);
    return {
      formatVersion: CLOUD_INTENT_EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      contentHash: hashExportContent(content),
      content,
    };
  }

  /** The content as the workspace-import document; see `intent-workspace-export.ts`. */
  async exportWorkspace(workspaceId: string): Promise<CloudIntentWorkspaceDocumentV1> {
    return readWorkspaceDocument(this.prisma, workspaceId);
  }

  private async readContent(workspaceId: string): Promise<CloudIntentExportContent> {
    const take = MAX_EXPORT_ROWS_PER_COLLECTION + 1;

    const [domains, features, seeds, items, sources, anchors, transitions, dimensions] = await this.prisma.$transaction(
      [
        this.prisma.intentDomain.findMany({ where: { workspaceId }, orderBy: { id: 'asc' }, take }),
        this.prisma.intentFeature.findMany({ where: { workspaceId }, orderBy: { id: 'asc' }, take }),
        this.prisma.intentFeatureSeed.findMany({
          where: { workspaceId },
          orderBy: [{ featureId: 'asc' }, { repoKey: 'asc' }, { nodeId: 'asc' }],
          take,
        }),
        this.prisma.intentItem.findMany({ where: { workspaceId }, orderBy: { id: 'asc' }, take }),
        this.prisma.intentItemSource.findMany({
          where: { workspaceId },
          orderBy: [{ itemId: 'asc' }, { kind: 'asc' }, { ref: 'asc' }, { localId: 'asc' }],
          take,
        }),
        this.prisma.intentAnchor.findMany({
          where: { workspaceId },
          orderBy: [{ itemId: 'asc' }, { repoKey: 'asc' }, { nodeId: 'asc' }],
          take,
        }),
        // The surrogate `id` is the tiebreak only — append-only, so it orders two
        // transitions written in one transaction — and is dropped from the output.
        this.prisma.intentAuthorityTransition.findMany({
          where: { workspaceId },
          orderBy: [{ itemId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take,
        }),
        this.prisma.intentDimension.findMany({ where: { workspaceId }, orderBy: { id: 'asc' }, take }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    this.assertWithinCeiling(domains.length, 'domains');
    this.assertWithinCeiling(features.length, 'features');
    this.assertWithinCeiling(seeds.length, 'seeds');
    this.assertWithinCeiling(items.length, 'items');
    this.assertWithinCeiling(sources.length, 'sources');
    this.assertWithinCeiling(anchors.length, 'anchors');
    this.assertWithinCeiling(transitions.length, 'transitions');
    this.assertWithinCeiling(dimensions.length, 'dimensions');

    return {
      workspaceId,
      tree: {
        domains: domains.map(
          (row): CloudIntentExportDomain => ({
            id: row.id,
            title: row.title,
            statement: row.statement,
            appliesWhen: treeConditionsOf(row.appliesWhen),
            layout: row.layout ?? undefined,
            archived: row.archived,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          }),
        ),
        features: features.map(
          (row): CloudIntentExportFeature => ({
            id: row.id,
            domainId: row.domainId,
            ...(row.parentFeatureId ? { parentFeatureId: row.parentFeatureId } : {}),
            title: row.title,
            statement: row.statement,
            appliesWhen: treeConditionsOf(row.appliesWhen),
            layout: row.layout ?? undefined,
            archived: row.archived,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          }),
        ),
        seeds: seeds.map(
          (row): CloudIntentExportSeed => ({
            featureId: row.featureId,
            repoKey: row.repoKey,
            nodeId: row.nodeId,
            note: row.note,
            createdAt: iso(row.createdAt),
          }),
        ),
      },
      // `undefined` when empty, which the canonical bytes omit (BR-8).
      dimensions: dimensions.length
        ? dimensions.map(
            (row): CloudIntentExportDimension => ({
              id: row.id,
              title: row.title,
              values: row.values,
              multi: row.multi,
              archived: row.archived,
              createdAt: iso(row.createdAt),
              updatedAt: iso(row.updatedAt),
            }),
          )
        : undefined,
      items: items.map(
        (row): CloudIntentExportItem => ({
          id: row.id,
          kind: row.kind,
          domainId: row.domainId,
          featureId: row.featureId,
          title: row.title,
          statement: row.statement,
          payload: row.payload ?? null,
          appliesWhen: Array.isArray(row.appliesWhen) && row.appliesWhen.length ? row.appliesWhen : undefined,
          rationale: row.rationale,
          body: row.body ?? undefined,
          authority: row.authority,
          proposedSuccessorOfId: row.proposedSuccessorOfId,
          supersededById: row.supersededById,
          version: row.version,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        }),
      ),
      sources: sources.map(
        (row): CloudIntentExportSource => ({
          itemId: row.itemId,
          kind: row.kind,
          ref: row.ref,
          localId: row.localId,
          revision: row.revision,
          locator: row.locator,
          title: row.title,
          url: row.url,
        }),
      ),
      anchors: anchors.map(
        (row): CloudIntentExportAnchor => ({
          source: row.source,
          disabledAt: row.disabledAt ? iso(row.disabledAt) : null,
          disabledBy: row.disabledBy,
          itemId: row.itemId,
          repoKey: row.repoKey,
          nodeId: row.nodeId,
          nodeType: row.nodeType,
          capturedVersionedId: row.capturedVersionedId,
          rationale: row.rationale,
          createdAt: iso(row.createdAt),
        }),
      ),
      transitions: transitions.map(
        (row): CloudIntentExportTransition => ({
          itemId: row.itemId,
          fromAuthority: row.fromAuthority,
          toAuthority: row.toAuthority,
          actorId: row.actorId,
          actorRole: row.actorRole,
          reason: row.reason,
          sourceKind: row.sourceKind,
          sourceRef: row.sourceRef,
          sourceLocalId: row.sourceLocalId,
          sourceRevision: row.sourceRevision,
          workItem: row.workItem ?? null,
          createdAt: iso(row.createdAt),
        }),
      ),
    };
  }

  private assertWithinCeiling(read: number, collection: string): void {
    if (read <= MAX_EXPORT_ROWS_PER_COLLECTION) return;
    throw intentStateError(
      IntentErrorCode.ExportTooLarge,
      `This workspace holds more than ${MAX_EXPORT_ROWS_PER_COLLECTION} intent ${collection}, ` +
        'which one export document does not carry.',
      [collection],
    );
  }
}
