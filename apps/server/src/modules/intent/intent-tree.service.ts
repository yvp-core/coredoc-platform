/**
 * The Domain → Feature tree and its seeds (spec §4.1–§4.3, §5 tree CRUD row).
 *
 * Three rules run through every mutation here:
 *
 * 1. EXPLICIT ACTIONS, never upsert. `create` fails on an existing id, `update`
 *    fails on a missing one, and `archive` takes the target state as a boolean
 *    so un-archiving is the same call. An upsert would make "I meant to edit
 *    the ordering domain" silently create a second one.
 * 2. IDS ARE IMMUTABLE. An update names the node and carries only mutable
 *    fields; there is no rename, because every item, seed, and hand-off quotes
 *    these slugs.
 * 3. DELETE IS REFUSED WHILE ANYTHING HANGS OFF THE NODE, with the blockers
 *    named. Reviewed intent never disappears as a side effect of a tree edit —
 *    archive it, or empty it first.
 *
 * Every mutation runs through `runIntentMutation`, so its audit row and its
 * idempotency-ledger row commit in the same transaction as the change itself.
 */
import { isDeepStrictEqual } from 'node:util';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  IntentAuditEntityKind,
  IntentNodeKind,
  Prisma,
  type IntentDimension as IntentDimensionRow,
  type IntentDomain as IntentDomainRow,
  type IntentFeature as IntentFeatureRow,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  INTENT_LIMITS,
  RegistryIssueCode,
  validateAgainstRegistry,
  type ContextCondition,
  type IntentDimension,
  type IntentDimensionValue,
} from '@coredoc/core';
import type {
  ArchiveIntentDimensionInput,
  ArchiveIntentDomainInput,
  ArchiveIntentFeatureInput,
  CreateIntentDimensionInput,
  CreateIntentDomainInput,
  CreateIntentFeatureInput,
  DeleteIntentDimensionInput,
  DeleteIntentFeatureSeedInput,
  DeleteIntentNodeRelationInput,
  IntentNodeRefInput,
  PutIntentNodeRelationInput,
  ListIntentDimensionsQuery,
  PutIntentFeatureSeedInput,
  UpdateIntentDimensionInput,
  UpdateIntentDomainInput,
  UpdateIntentFeatureInput,
} from './contract/index.js';
import { INTENT_TREE_FEATURES_PER_DOMAIN, IntentCursorScope, decodeIntentCursor, paginate } from './intent-cursor.js';
import { OPEN_COMMENT_THREAD_WHERE, OPEN_QUESTION_WHERE } from './intent-item.service.js';
import {
  IntentAuditOperation,
  IntentOperation,
  runIntentMutation,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
} from './intent-idempotency.js';
import { INTENT_SEED_NODE_ID_KINDS, nodeIdKindOf } from './intent-node-types.js';
import { assertWorkspaceIntentRepoKeys } from './intent-repo-keys.js';
import { intentNotFound, intentStateError } from './intent-state-errors.js';
import {
  INTENT_CONTRACT_LIMITS,
  IntentErrorCode,
  type DeleteIntentDomainInput,
  type DeleteIntentFeatureInput,
  type ListIntentFeatureSeedsQuery,
  type ListIntentFeaturesQuery,
  type ListIntentTreeQuery,
} from './contract/index.js';

/** How deep features may nest under one another. */
export const INTENT_FEATURE_MAX_DEPTH = 8;

/** The empty statement a node carries until someone writes one; the column is NOT NULL. */
const EMPTY_STATEMENT = '';

export interface IntentTreeDomainView {
  id: string;
  title: string;
  statement: string;
  /** Absent when the node carries no conditions (pre-inheritance bytes). */
  appliesWhen?: ContextCondition[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentTreeFeatureView extends IntentTreeDomainView {
  domainId: string;
  /** The feature this one sits under, in the same domain; `null` at the top level. */
  parentFeatureId: string | null;
}

/** A tree node's item counts; see {@link readIntentNodeCounts}. */
export interface IntentNodeCounts {
  itemCount: number;
  pendingCount: number;
  openQuestionCount: number;
  /** Open comment threads on the node itself and on its live items. */
  openCommentCount: number;
}

export interface IntentTreeDimensionView {
  id: string;
  title: string;
  values: IntentDimensionValue[];
  multi: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The intent tree's counts, shared by the tree read and the product root's
 * document. `itemCount` is the live items (candidate or accepted; rejected
 * and superseded are history) attached DIRECTLY to a node: an item
 * attached to a feature counts for that feature only, not for its domain or
 * its parent feature, and the product root counts the items attached to no
 * node. `pendingCount` is the candidates among them, waiting for review, and
 * `openQuestionCount` the decisions among them whose choice is still open
 * ({@link OPEN_QUESTION_WHERE}). `openCommentCount` is the open comment
 * threads on the items attached to the node, whatever their authority, plus,
 * for a feature, on the feature itself.
 * A domain's `subtree*` counts add every one of its features, archived ones
 * and those past the per-domain page cap included.
 */
export async function readIntentNodeCounts(
  prisma: Pick<PrismaService, 'intentItem' | 'intentComment' | 'intentFeature'>,
  workspaceId: string,
  where: Prisma.IntentItemWhereInput,
) {
  // Two grouped reads, not one per node: `payload` is JSONB, which groupBy
  // cannot key on, so the open questions are their own filtered grouping.
  const [rows, openRows, commentRows] = await Promise.all([
    prisma.intentItem.groupBy({
      by: ['domainId', 'featureId', 'authority'],
      where: { workspaceId, authority: { in: ['candidate', 'accepted'] }, ...where },
      _count: { _all: true },
    }),
    prisma.intentItem.groupBy({
      by: ['domainId', 'featureId'],
      where: { workspaceId, AND: [OPEN_QUESTION_WHERE, where] },
      _count: { _all: true },
    }),
    // Open threads are few, so all of them are grouped by target and placed on their nodes below.
    prisma.intentComment.groupBy({
      by: ['itemId', 'featureId'],
      where: { workspaceId, ...OPEN_COMMENT_THREAD_WHERE },
      _count: { _all: true },
    }),
  ]);
  const threadsOnItem = new Map(commentRows.flatMap((row) => (row.itemId ? [[row.itemId, row._count._all]] : [])));
  const threadsOnFeature = new Map(
    commentRows.flatMap((row) => (row.featureId ? [[row.featureId, row._count._all]] : [])),
  );
  const [commentedItems, commentedFeatures] = await Promise.all([
    threadsOnItem.size === 0
      ? []
      : prisma.intentItem.findMany({
          // Any authority: an open thread on a rejected or superseded item still needs an answer.
          where: { workspaceId, AND: [{ id: { in: [...threadsOnItem.keys()] } }, where] },
          select: { id: true, domainId: true, featureId: true },
        }),
    threadsOnFeature.size === 0
      ? []
      : prisma.intentFeature.findMany({
          where: { workspaceId, id: { in: [...threadsOnFeature.keys()] } },
          select: { id: true, domainId: true },
        }),
  ]);
  const empty = (): IntentNodeCounts => ({
    itemCount: 0,
    pendingCount: 0,
    openQuestionCount: 0,
    openCommentCount: 0,
  });
  const byNode = new Map<string, IntentNodeCounts>();
  const bySubtree = new Map<string, IntentNodeCounts>();
  const add = (map: Map<string, IntentNodeCounts>, key: string, field: keyof IntentNodeCounts, count: number) => {
    const node = map.get(key) ?? empty();
    node[field] += count;
    map.set(key, node);
  };
  const keyOf = (domainId: string | null, featureId: string | null) => `${domainId ?? ''}/${featureId ?? ''}`;
  const tally = (
    row: { domainId: string | null; featureId: string | null },
    field: keyof IntentNodeCounts,
    count: number,
  ) => {
    add(byNode, keyOf(row.domainId, row.featureId), field, count);
    if (row.domainId !== null) add(bySubtree, row.domainId, field, count);
  };
  for (const row of rows) {
    tally(row, 'itemCount', row._count._all);
    if (row.authority === 'candidate') tally(row, 'pendingCount', row._count._all);
  }
  for (const row of openRows) tally(row, 'openQuestionCount', row._count._all);
  for (const item of commentedItems) tally(item, 'openCommentCount', threadsOnItem.get(item.id) ?? 0);
  for (const feature of commentedFeatures)
    tally(
      { domainId: feature.domainId, featureId: feature.id },
      'openCommentCount',
      threadsOnFeature.get(feature.id) ?? 0,
    );
  return {
    /** Every counted item in `where`, whatever it is attached to. */
    total: (): IntentNodeCounts => {
      const sum = empty();
      for (const node of byNode.values())
        for (const field of Object.keys(sum) as (keyof IntentNodeCounts)[]) sum[field] += node[field];
      return sum;
    },
    of: (domainId: string | null, featureId: string | null): IntentNodeCounts =>
      byNode.get(keyOf(domainId, featureId)) ?? empty(),
    subtreeOf: (domainId: string) => {
      const subtree = bySubtree.get(domainId) ?? empty();
      return {
        subtreeItemCount: subtree.itemCount,
        subtreePendingCount: subtree.pendingCount,
        subtreeOpenQuestionCount: subtree.openQuestionCount,
        subtreeOpenCommentCount: subtree.openCommentCount,
      };
    },
  };
}

@Injectable()
export class IntentTreeService {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------- reads --- */

  /**
   * One page of domains with their features inline.
   *
   * Features are bounded per domain and report `featuresTruncated` rather than
   * silently shrinking (spec §6.1); a domain with more is paged through
   * {@link listFeatures}.
   */
  async getTree(workspaceId: string, query: ListIntentTreeQuery, limit: number) {
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.TreeDomains, 1);
    const includeArchived = query.includeArchived === 'true';

    const rows = await this.prisma.intentDomain.findMany({
      where: {
        workspaceId,
        ...(includeArchived ? {} : { archived: false }),
        ...(cursor ? { id: { gt: cursor[0] as string } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      // The per-domain bound is pushed INTO the query. Read as a flat findMany
      // over the page's domains it had no `take` at all, so one domain with
      // thousands of features loaded all of them into memory to then slice away
      // all but `INTENT_TREE_FEATURES_PER_DOMAIN` — the bound was enforced on the
      // answer, not on the read. One row past the cap is what still makes
      // `featuresTruncated` observable.
      include: {
        features: {
          where: includeArchived ? {} : { archived: false },
          orderBy: { id: 'asc' },
          take: INTENT_TREE_FEATURES_PER_DOMAIN + 1,
        },
      },
    });
    const { page, nextCursor } = paginate(rows, limit, IntentCursorScope.TreeDomains, (row) => [row.id]);
    const counts = await readIntentNodeCounts(this.prisma, workspaceId, {
      OR: [{ domainId: { in: page.map((domain) => domain.id) } }, { domainId: null }],
    });

    return {
      root: counts.of(null, null),
      domains: page.map((domain) => ({
        ...domainView(domain),
        ...counts.of(domain.id, null),
        ...counts.subtreeOf(domain.id),
        features: domain.features
          .slice(0, INTENT_TREE_FEATURES_PER_DOMAIN)
          .map((feature) => ({ ...featureView(feature), ...counts.of(domain.id, feature.id) })),
        featuresTruncated: domain.features.length > INTENT_TREE_FEATURES_PER_DOMAIN,
      })),
      nextCursor,
    };
  }

  /**
   * Does this workspace hold ANY intent content — a domain or an item?
   *
   * One `EXISTS`/`EXISTS` query, not a tree page plus an item page. The MCP
   * tools ask this before EVERY mutation to tell an empty answer from an
   * unconfigured workspace, and answering it by materialising a page of domains
   * with their features (and a page of items) made the cheapest question on the
   * surface cost the most.
   *
   * ARCHIVED CONTENT COUNTS: archiving is a visibility state, so a workspace
   * that archived its only domain is configured and empty, not unconfigured.
   */
  async hasIntentContent(workspaceId: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT (
        EXISTS (SELECT 1 FROM intent_domains WHERE workspace_id = ${workspaceId}::uuid)
        OR EXISTS (SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid)
        OR EXISTS (SELECT 1 FROM intent_items WHERE workspace_id = ${workspaceId}::uuid)
      ) AS present
    `;
    return row?.present === true;
  }

  async listFeatures(workspaceId: string, query: ListIntentFeaturesQuery, limit: number) {
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.Features, 1);
    const rows = await this.prisma.intentFeature.findMany({
      where: {
        workspaceId,
        ...(query.domainId ? { domainId: query.domainId } : {}),
        ...(query.includeArchived === 'true' ? {} : { archived: false }),
        ...(cursor ? { id: { gt: cursor[0] as string } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const { page, nextCursor } = paginate(rows, limit, IntentCursorScope.Features, (row) => [row.id]);
    const counts = await readIntentNodeCounts(this.prisma, workspaceId, {
      featureId: { in: page.map((feature) => feature.id) },
    });
    return {
      features: page.map((feature) => ({ ...featureView(feature), ...counts.of(feature.domainId, feature.id) })),
      nextCursor,
    };
  }

  async listSeeds(workspaceId: string, featureId: string, query: ListIntentFeatureSeedsQuery, limit: number) {
    await readFeature(this.prisma, workspaceId, featureId, ['featureId']);
    const cursor = decodeIntentCursor(query.cursor, IntentCursorScope.FeatureSeeds, 1);
    const rows = await this.prisma.intentFeatureSeed.findMany({
      where: { workspaceId, featureId, ...(cursor ? { id: { gt: BigInt(cursor[0] as string) } } : {}) },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const { page, nextCursor } = paginate(rows, limit, IntentCursorScope.FeatureSeeds, (row) => [row.id.toString()]);
    return {
      seeds: page.map((seed) => ({
        repoKey: seed.repoKey,
        nodeId: seed.nodeId,
        note: seed.note,
        createdBy: seed.createdBy,
        createdAt: seed.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  /* ---------------------------------------------- domains, features, dimensions --- */

  createDomain(workspaceId: string, actor: IntentActor, input: CreateIntentDomainInput) {
    return this.create(DOMAIN, workspaceId, actor, input);
  }

  updateDomain(workspaceId: string, actor: IntentActor, input: UpdateIntentDomainInput) {
    return this.update(DOMAIN, workspaceId, actor, input);
  }

  archiveDomain(workspaceId: string, actor: IntentActor, input: ArchiveIntentDomainInput) {
    return this.archive(DOMAIN, workspaceId, actor, input);
  }

  /** Refused while the domain still holds features or attached items. */
  deleteDomain(workspaceId: string, actor: IntentActor, input: DeleteIntentDomainInput) {
    return this.remove(DOMAIN, workspaceId, actor, input);
  }

  createFeature(workspaceId: string, actor: IntentActor, input: CreateIntentFeatureInput) {
    return this.create(FEATURE, workspaceId, actor, input);
  }

  updateFeature(workspaceId: string, actor: IntentActor, input: UpdateIntentFeatureInput) {
    return this.update(FEATURE, workspaceId, actor, input);
  }

  archiveFeature(workspaceId: string, actor: IntentActor, input: ArchiveIntentFeatureInput) {
    return this.archive(FEATURE, workspaceId, actor, input);
  }

  /**
   * Refused while sub-features or items are attached. Seeds are NOT blockers:
   * they are part of the feature's own definition and cascade with it
   * (`onDelete: Cascade`); the cascaded count is recorded in the audit row.
   */
  deleteFeature(workspaceId: string, actor: IntentActor, input: DeleteIntentFeatureInput) {
    return this.remove(FEATURE, workspaceId, actor, input);
  }

  /**
   * The whole registry, unpaged: it is bounded by `INTENT_LIMITS.dimensions` in
   * the same way the domain registry is, and every context read needs all of it.
   */
  async listDimensions(workspaceId: string, query: ListIntentDimensionsQuery) {
    const rows = await this.prisma.intentDimension.findMany({
      where: { workspaceId, ...(query.includeArchived === 'true' ? {} : { archived: false }) },
      orderBy: { id: 'asc' },
    });
    return { dimensions: rows.map(dimensionView) };
  }

  createDimension(workspaceId: string, actor: IntentActor, input: CreateIntentDimensionInput) {
    return this.create(DIMENSION, workspaceId, actor, input);
  }

  updateDimension(workspaceId: string, actor: IntentActor, input: UpdateIntentDimensionInput) {
    return this.update(DIMENSION, workspaceId, actor, input);
  }

  /** Un-archiving is always allowed; archiving is refused while items reference the dimension (BR-7). */
  archiveDimension(workspaceId: string, actor: IntentActor, input: ArchiveIntentDimensionInput) {
    return this.archive(DIMENSION, workspaceId, actor, input);
  }

  deleteDimension(workspaceId: string, actor: IntentActor, input: DeleteIntentDimensionInput) {
    return this.remove(DIMENSION, workspaceId, actor, input);
  }

  private create<K extends string, Row extends TreeNodeRow, View, C extends TreeNodeInput, U extends TreeNodeInput>(
    kind: TreeNodeKind<K, Row, View, C, U>,
    workspaceId: string,
    actor: IntentActor,
    input: C,
  ) {
    return runIntentMutation(
      this.prisma,
      { workspaceId, actor, operation: kind.operations.create, idempotencyKey: input.idempotencyKey, request: input },
      async (tx) => {
        await kind.beforeCreate(tx, workspaceId, input);
        if (await kind.exists(tx, workspaceId, input.id)) {
          throw intentStateError(
            IntentErrorCode.TreeNodeExists,
            `${kind.label} '${input.id}' already exists in this workspace. Ids are immutable; update it instead of re-creating it.`,
            ['id'],
          );
        }
        const created = await kind.insert(tx, workspaceId, actor.id, input);
        return {
          response: {
            ...nodeResponse(kind, created),
            ...(await kind.impact(tx, workspaceId, null, created)),
          },
          audits: [
            {
              entityKind: kind.entityKind,
              entityId: created.id,
              operation: IntentAuditOperation.Create,
              after: kind.createdAudit(created),
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  private update<K extends string, Row extends TreeNodeRow, View, C extends TreeNodeInput, U extends TreeNodeInput>(
    kind: TreeNodeKind<K, Row, View, C, U>,
    workspaceId: string,
    actor: IntentActor,
    input: U,
  ) {
    return runIntentMutation(
      this.prisma,
      { workspaceId, actor, operation: kind.operations.update, idempotencyKey: input.idempotencyKey, request: input },
      async (tx) => {
        const before = await kind.read(tx, workspaceId, input.id, ['id']);
        await kind.beforeUpdate(tx, workspaceId, input, before);
        const updated = await kind.update(tx, workspaceId, actor.id, input);
        return {
          response: {
            ...nodeResponse(kind, updated),
            ...(await kind.impact(tx, workspaceId, before, updated)),
          },
          audits: [
            {
              entityKind: kind.entityKind,
              entityId: updated.id,
              operation: IntentAuditOperation.Update,
              before: kind.updateAudit(before, input),
              after: kind.updateAudit(updated, input),
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  private archive<K extends string, Row extends TreeNodeRow, View, C extends TreeNodeInput, U extends TreeNodeInput>(
    kind: TreeNodeKind<K, Row, View, C, U>,
    workspaceId: string,
    actor: IntentActor,
    input: TreeNodeInput & { archived: boolean },
  ) {
    return runIntentMutation(
      this.prisma,
      { workspaceId, actor, operation: kind.operations.archive, idempotencyKey: input.idempotencyKey, request: input },
      async (tx) => {
        const before = await kind.read(tx, workspaceId, input.id, ['id']);
        if (input.archived) await kind.beforeArchive(tx, workspaceId, input.id);
        const updated = await kind.setArchived(tx, workspaceId, actor.id, input.id, input.archived);
        return {
          response: nodeResponse(kind, updated),
          audits: [
            {
              entityKind: kind.entityKind,
              entityId: updated.id,
              operation: input.archived ? IntentAuditOperation.Archive : IntentAuditOperation.Unarchive,
              before: { archived: before.archived },
              after: { archived: updated.archived },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /**
   * The blockers are found and named INSIDE the transaction that deletes, so the
   * message a maintainer reads is the state the delete actually saw.
   */
  private remove<K extends string, Row extends TreeNodeRow, View, C extends TreeNodeInput, U extends TreeNodeInput>(
    kind: TreeNodeKind<K, Row, View, C, U>,
    workspaceId: string,
    actor: IntentActor,
    input: TreeNodeInput,
  ) {
    return runIntentMutation(
      this.prisma,
      { workspaceId, actor, operation: kind.operations.delete, idempotencyKey: input.idempotencyKey, request: input },
      async (tx) => {
        const before = await kind.read(tx, workspaceId, input.id, ['id']);
        await kind.assertDeletable(tx, workspaceId, input.id);
        const counts = await kind.delete(tx, workspaceId, input.id);
        const hasCounts = Object.keys(counts).length > 0;
        return {
          response: { deleted: { kind: kind.key, id: input.id, ...counts } },
          audits: [
            {
              entityKind: kind.entityKind,
              entityId: input.id,
              operation: IntentAuditOperation.Delete,
              before: kind.deletedAudit(before),
              ...(hasCounts ? { after: counts } : {}),
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /* -------------------------------------------------------------- seeds --- */

  /**
   * Declare a seed, or re-note an existing one. Identity is
   * `(featureId, repoKey, nodeId)`, so `put` is the same call for both.
   */
  async putSeed(workspaceId: string, actor: IntentActor, input: PutIntentFeatureSeedInput) {
    return runIntentMutation(
      this.prisma,
      { workspaceId, actor, operation: IntentOperation.SeedPut, idempotencyKey: input.idempotencyKey, request: input },
      async (tx) => {
        await readFeature(tx, workspaceId, input.featureId, ['featureId']);
        assertSeedNodeId(input.nodeId);
        await assertWorkspaceIntentRepoKeys(tx, workspaceId, [input.repoKey], ['repoKey']);

        const existing = await tx.intentFeatureSeed.findUnique({
          where: {
            workspaceId_featureId_repoKey_nodeId: {
              workspaceId,
              featureId: input.featureId,
              repoKey: input.repoKey,
              nodeId: input.nodeId,
            },
          },
        });
        const seed = existing
          ? await tx.intentFeatureSeed.update({ where: { id: existing.id }, data: { note: input.note ?? null } })
          : await tx.intentFeatureSeed.create({
              data: {
                workspaceId,
                featureId: input.featureId,
                repoKey: input.repoKey,
                nodeId: input.nodeId,
                note: input.note ?? null,
                createdBy: actor.id,
              },
            });

        return {
          response: {
            seed: {
              featureId: seed.featureId,
              repoKey: seed.repoKey,
              nodeId: seed.nodeId,
              note: seed.note,
              createdAt: seed.createdAt.toISOString(),
            },
            created: existing === null,
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature_seed,
              entityId: seed.id.toString(),
              operation: existing ? IntentAuditOperation.Update : IntentAuditOperation.Create,
              ...(existing ? { before: { note: existing.note } } : {}),
              after: { featureId: seed.featureId, repoKey: seed.repoKey, nodeId: seed.nodeId, note: seed.note },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async deleteSeed(workspaceId: string, actor: IntentActor, input: DeleteIntentFeatureSeedInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.SeedDelete,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const existing = await tx.intentFeatureSeed.findUnique({
          where: {
            workspaceId_featureId_repoKey_nodeId: {
              workspaceId,
              featureId: input.featureId,
              repoKey: input.repoKey,
              nodeId: input.nodeId,
            },
          },
        });
        if (!existing) {
          throw intentNotFound(
            IntentErrorCode.SeedNotFound,
            `Feature '${input.featureId}' has no seed for node '${input.nodeId}' in repo '${input.repoKey}'`,
            ['nodeId'],
          );
        }
        await tx.intentFeatureSeed.delete({ where: { id: existing.id } });
        return {
          response: { deleted: { kind: 'feature_seed', featureId: input.featureId, nodeId: input.nodeId } },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature_seed,
              entityId: existing.id.toString(),
              operation: IntentAuditOperation.Delete,
              before: { featureId: existing.featureId, repoKey: existing.repoKey, nodeId: existing.nodeId },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /* ----------------------------------------------------- node relations --- */

  /**
   * Declare a relation between two nodes, or re-word its reason. The pair is
   * unordered: `from`/`to` are stored in canonical order, so naming the same
   * two nodes the other way round addresses the same relation.
   */
  async putRelation(workspaceId: string, actor: IntentActor, input: PutIntentNodeRelationInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.RelationPut,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const [from, to] = canonicalRelationEndpoints(input.from, input.to);
        await readNode(tx, workspaceId, input.from, ['from']);
        await readNode(tx, workspaceId, input.to, ['to']);

        const identity = relationIdentity(workspaceId, from, to);
        const existing = await tx.intentNodeRelation.findUnique({ where: identity });
        const relation = existing
          ? await tx.intentNodeRelation.update({ where: { id: existing.id }, data: { why: input.why } })
          : await tx.intentNodeRelation.create({
              data: {
                workspaceId,
                fromKind: from.kind,
                fromId: from.id,
                toKind: to.kind,
                toId: to.id,
                why: input.why,
                createdBy: actor.id,
              },
            });

        return {
          response: { relation: relationView(relation), created: existing === null },
          audits: [
            {
              entityKind: IntentAuditEntityKind.node_relation,
              entityId: relationEntityId(from, to),
              operation: existing ? IntentAuditOperation.Update : IntentAuditOperation.Create,
              ...(existing ? { before: { why: existing.why } } : {}),
              after: { why: relation.why },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async deleteRelation(workspaceId: string, actor: IntentActor, input: DeleteIntentNodeRelationInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.RelationDelete,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const [from, to] = canonicalRelationEndpoints(input.from, input.to);
        const existing = await tx.intentNodeRelation.findUnique({ where: relationIdentity(workspaceId, from, to) });
        if (!existing) {
          throw intentNotFound(
            IntentErrorCode.NodeRelationNotFound,
            `No relation joins ${input.from.kind} '${input.from.id}' and ${input.to.kind} '${input.to.id}'`,
            ['to'],
          );
        }
        await tx.intentNodeRelation.delete({ where: { id: existing.id } });
        return {
          response: { deleted: { kind: 'node_relation', from, to } },
          audits: [
            {
              entityKind: IntentAuditEntityKind.node_relation,
              entityId: relationEntityId(from, to),
              operation: IntentAuditOperation.Delete,
              before: { why: existing.why },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }
}

/* ------------------------------------------------------- node kinds --- */

type TreeNodeRow = { id: string; title: string; archived: boolean };
type TreeNodeInput = { id: string; idempotencyKey: string };

/**
 * What differs between domains, features and dimensions; the create, update,
 * archive and delete flows around it are shared. Every hook runs inside the
 * mutation's transaction, in the order the flow names.
 */
interface TreeNodeKind<
  K extends string,
  Row extends TreeNodeRow,
  View,
  C extends TreeNodeInput,
  U extends TreeNodeInput,
> {
  /** The response key and the `deleted.kind`. */
  key: K;
  /** How errors name the node. */
  label: string;
  entityKind: IntentAuditRecord['entityKind'];
  operations: { create: IntentOperation; update: IntentOperation; archive: IntentOperation; delete: IntentOperation };
  view(row: Row): View;
  /** Reads the row or throws the kind's not-found error. */
  read(tx: IntentTransaction, workspaceId: string, id: string, path: string[]): Promise<Row>;
  exists(tx: IntentTransaction, workspaceId: string, id: string): Promise<boolean>;
  /** Runs before the duplicate-id check. */
  beforeCreate(tx: IntentTransaction, workspaceId: string, input: C): Promise<void>;
  insert(tx: IntentTransaction, workspaceId: string, actorId: string, input: C): Promise<Row>;
  createdAudit(row: Row): Record<string, unknown>;
  /** Runs after the row is read, before it is written. */
  beforeUpdate(tx: IntentTransaction, workspaceId: string, input: U, before: Row): Promise<void>;
  update(tx: IntentTransaction, workspaceId: string, actorId: string, input: U): Promise<Row>;
  /** Applied to both sides of an update. */
  updateAudit(row: Row, input: U): Record<string, unknown>;
  /** Extra response fields for a create or update. */
  impact(
    tx: IntentTransaction,
    workspaceId: string,
    before: Row | null,
    after: Row,
  ): Promise<{ affectedAcceptedItems?: number }>;
  /** Runs before archiving (never before un-archiving). */
  beforeArchive(tx: IntentTransaction, workspaceId: string, id: string): Promise<void>;
  setArchived(tx: IntentTransaction, workspaceId: string, actorId: string, id: string, archived: boolean): Promise<Row>;
  assertDeletable(tx: IntentTransaction, workspaceId: string, id: string): Promise<void>;
  /** Deletes the row; the counts are reported in the response and as the audit's `after`. */
  delete(tx: IntentTransaction, workspaceId: string, id: string): Promise<Record<string, number>>;
  deletedAudit(row: Row): Record<string, unknown>;
}

const noCheck = (): Promise<void> => Promise.resolve();
const noImpact = async () => ({});

function nodeResponse<K extends string, Row extends TreeNodeRow, View>(
  kind: { key: K; view(row: Row): View },
  row: Row,
): Record<K, View> {
  return { [kind.key]: kind.view(row) } as Record<K, View>;
}

const nodeKey = (workspaceId: string, id: string) => ({ workspaceId_id: { workspaceId, id } });

const DOMAIN: TreeNodeKind<
  'domain',
  IntentDomainRow,
  IntentTreeDomainView,
  CreateIntentDomainInput,
  UpdateIntentDomainInput
> = {
  key: 'domain',
  label: 'Domain',
  entityKind: IntentAuditEntityKind.domain,
  operations: {
    create: IntentOperation.DomainCreate,
    update: IntentOperation.DomainUpdate,
    archive: IntentOperation.DomainArchive,
    delete: IntentOperation.DomainDelete,
  },
  view: domainView,
  read: readDomain,
  exists: async (tx, workspaceId, id) =>
    (await tx.intentDomain.findUnique({ where: nodeKey(workspaceId, id), select: { id: true } })) !== null,
  beforeCreate: (tx, workspaceId, input) => validateTreeConditions(tx, workspaceId, input.appliesWhen),
  insert: (tx, workspaceId, actorId, input) =>
    tx.intentDomain.create({
      data: {
        workspaceId,
        id: input.id,
        title: input.title,
        statement: input.statement ?? EMPTY_STATEMENT,
        ...treeConditionsData(input.appliesWhen),
        ...layoutData(input.layout),
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),
  createdAudit: (row) => ({ title: row.title, archived: row.archived, ...auditedConditions(row) }),
  beforeUpdate: (tx, workspaceId, input) => validateTreeConditions(tx, workspaceId, input.appliesWhen),
  update: (tx, workspaceId, actorId, input) =>
    tx.intentDomain.update({
      where: nodeKey(workspaceId, input.id),
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.statement !== undefined ? { statement: input.statement } : {}),
        ...treeConditionsData(input.appliesWhen),
        ...layoutData(input.layout),
        updatedBy: actorId,
      },
    }),
  updateAudit: (row, input) => ({
    title: row.title,
    ...(input.appliesWhen !== undefined ? auditedConditions(row) : {}),
  }),
  impact: (tx, workspaceId, before, after) => conditionImpact(tx, workspaceId, { domainId: after.id }, before, after),
  beforeArchive: noCheck,
  setArchived: (tx, workspaceId, actorId, id, archived) =>
    tx.intentDomain.update({ where: nodeKey(workspaceId, id), data: { archived, updatedBy: actorId } }),
  assertDeletable: (tx, workspaceId, id) =>
    assertNodeEmpty(tx, workspaceId, 'Domain', id, { features: { domainId: id }, items: { domainId: id } }),
  delete: async (tx, workspaceId, id) => ({
    removedRelationCount: await deleteTreeNode(tx, workspaceId, { kind: 'domain', id }, 'Domain', () =>
      tx.intentDomain.delete({ where: nodeKey(workspaceId, id) }),
    ),
  }),
  deletedAudit: (row) => ({ title: row.title, archived: row.archived }),
};

const FEATURE: TreeNodeKind<
  'feature',
  IntentFeatureRow,
  IntentTreeFeatureView,
  CreateIntentFeatureInput,
  UpdateIntentFeatureInput
> = {
  key: 'feature',
  label: 'Feature',
  entityKind: IntentAuditEntityKind.feature,
  operations: {
    create: IntentOperation.FeatureCreate,
    update: IntentOperation.FeatureUpdate,
    archive: IntentOperation.FeatureArchive,
    delete: IntentOperation.FeatureDelete,
  },
  view: featureView,
  read: readFeature,
  exists: async (tx, workspaceId, id) =>
    (await tx.intentFeature.findUnique({ where: nodeKey(workspaceId, id), select: { id: true } })) !== null,
  beforeCreate: async (tx, workspaceId, input) => {
    await readDomain(tx, workspaceId, input.domainId, ['domainId']);
    if (input.parentFeatureId !== undefined)
      await assertParent(tx, workspaceId, input.id, input.domainId, input.parentFeatureId);
    await validateTreeConditions(tx, workspaceId, input.appliesWhen);
  },
  insert: (tx, workspaceId, actorId, input) =>
    tx.intentFeature.create({
      data: {
        workspaceId,
        id: input.id,
        domainId: input.domainId,
        ...(input.parentFeatureId !== undefined ? { parentFeatureId: input.parentFeatureId } : {}),
        title: input.title,
        statement: input.statement ?? EMPTY_STATEMENT,
        ...treeConditionsData(input.appliesWhen),
        ...layoutData(input.layout),
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),
  createdAudit: (row) => ({
    domainId: row.domainId,
    ...(row.parentFeatureId ? { parentFeatureId: row.parentFeatureId } : {}),
    title: row.title,
    archived: row.archived,
    ...auditedConditions(row),
  }),
  beforeUpdate: async (tx, workspaceId, input, before) => {
    if (input.parentFeatureId) await assertParent(tx, workspaceId, input.id, before.domainId, input.parentFeatureId);
    await validateTreeConditions(tx, workspaceId, input.appliesWhen);
  },
  update: (tx, workspaceId, actorId, input) =>
    tx.intentFeature.update({
      where: nodeKey(workspaceId, input.id),
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.parentFeatureId !== undefined ? { parentFeatureId: input.parentFeatureId } : {}),
        ...(input.statement !== undefined ? { statement: input.statement } : {}),
        ...treeConditionsData(input.appliesWhen),
        ...layoutData(input.layout),
        updatedBy: actorId,
      },
    }),
  updateAudit: (row, input) => ({
    title: row.title,
    ...(input.parentFeatureId !== undefined ? { parentFeatureId: row.parentFeatureId } : {}),
    ...(input.appliesWhen !== undefined ? auditedConditions(row) : {}),
  }),
  impact: (tx, workspaceId, before, after) => conditionImpact(tx, workspaceId, { featureId: after.id }, before, after),
  beforeArchive: noCheck,
  setArchived: (tx, workspaceId, actorId, id, archived) =>
    tx.intentFeature.update({ where: nodeKey(workspaceId, id), data: { archived, updatedBy: actorId } }),
  assertDeletable: (tx, workspaceId, id) =>
    assertNodeEmpty(tx, workspaceId, 'Feature', id, { features: { parentFeatureId: id }, items: { featureId: id } }),
  delete: async (tx, workspaceId, id) => {
    const cascadedSeedCount = await tx.intentFeatureSeed.count({ where: { workspaceId, featureId: id } });
    const removedRelationCount = await deleteTreeNode(tx, workspaceId, { kind: 'feature', id }, 'Feature', () =>
      tx.intentFeature.delete({ where: nodeKey(workspaceId, id) }),
    );
    return { cascadedSeedCount, removedRelationCount };
  },
  deletedAudit: (row) => ({ domainId: row.domainId, title: row.title, archived: row.archived }),
};

const DIMENSION: TreeNodeKind<
  'dimension',
  IntentDimensionRow,
  IntentTreeDimensionView,
  CreateIntentDimensionInput,
  UpdateIntentDimensionInput
> = {
  key: 'dimension',
  label: 'Dimension',
  entityKind: IntentAuditEntityKind.dimension,
  operations: {
    create: IntentOperation.DimensionCreate,
    update: IntentOperation.DimensionUpdate,
    archive: IntentOperation.DimensionArchive,
    delete: IntentOperation.DimensionDelete,
  },
  view: dimensionView,
  read: readDimension,
  exists: async (tx, workspaceId, id) =>
    (await tx.intentDimension.findUnique({ where: nodeKey(workspaceId, id), select: { id: true } })) !== null,
  // Serializes creates per workspace so two at `limit - 1` cannot both pass the count.
  beforeCreate: async (tx, workspaceId) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':intent-dimensions', 0))`;
  },
  insert: async (tx, workspaceId, actorId, input) => {
    // Archived dimensions count: un-archiving must not overflow the registry.
    if ((await tx.intentDimension.count({ where: { workspaceId } })) >= INTENT_LIMITS.dimensions) {
      throw intentStateError(
        IntentErrorCode.SchemaViolation,
        `This workspace already declares ${INTENT_LIMITS.dimensions} dimensions (archived included), the most it may hold. Delete an unused one first.`,
        ['id'],
      );
    }
    return tx.intentDimension.create({
      data: {
        workspaceId,
        id: input.id,
        title: input.title,
        values: input.values,
        multi: input.multi ?? false,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
  },
  createdAudit: (row) => ({ title: row.title, values: valueIds(row.values), multi: row.multi }),
  beforeUpdate: async (tx, workspaceId, input, before) => {
    if (input.values !== undefined) {
      const kept = new Set(input.values.map((value) => value.id));
      const dropped = valueIds(before.values).filter((id) => !kept.has(id));
      if (dropped.length > 0) await assertDimensionUnused(tx, workspaceId, input.id, dropped, ['values']);
    }
    // Flipping `multi` changes how every stored clause and variant on it reads.
    if (input.multi !== undefined && input.multi !== before.multi) {
      await assertDimensionUnused(tx, workspaceId, input.id, null, ['multi']);
    }
  },
  update: (tx, workspaceId, actorId, input) =>
    tx.intentDimension.update({
      where: nodeKey(workspaceId, input.id),
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.values !== undefined ? { values: input.values } : {}),
        ...(input.multi !== undefined ? { multi: input.multi } : {}),
        updatedBy: actorId,
      },
    }),
  updateAudit: (row) => ({ title: row.title, values: valueIds(row.values), multi: row.multi }),
  impact: noImpact,
  beforeArchive: (tx, workspaceId, id) => assertDimensionUnused(tx, workspaceId, id, null, ['id']),
  setArchived: (tx, workspaceId, actorId, id, archived) =>
    tx.intentDimension.update({ where: nodeKey(workspaceId, id), data: { archived, updatedBy: actorId } }),
  assertDeletable: (tx, workspaceId, id) => assertDimensionUnused(tx, workspaceId, id, null, ['id']),
  delete: async (tx, workspaceId, id) => {
    await tx.intentDimension.delete({ where: nodeKey(workspaceId, id) });
    return {};
  },
  deletedAudit: (row) => ({ title: row.title, values: valueIds(row.values), archived: row.archived }),
};

/* ------------------------------------------------------------ readers --- */

function readNode(
  reader: Pick<IntentTransaction, 'intentDomain' | 'intentFeature'>,
  workspaceId: string,
  node: IntentNodeRefInput,
  path: string[],
) {
  return node.kind === 'domain'
    ? readDomain(reader, workspaceId, node.id, [...path, 'id'])
    : readFeature(reader, workspaceId, node.id, [...path, 'id']);
}

async function readDomain(
  reader: Pick<IntentTransaction, 'intentDomain'>,
  workspaceId: string,
  id: string,
  path: string[],
): Promise<IntentDomainRow> {
  const domain = await reader.intentDomain.findUnique({ where: nodeKey(workspaceId, id) });
  if (!domain) {
    throw intentNotFound(IntentErrorCode.DomainNotFound, `Domain '${id}' does not exist in this workspace`, path);
  }
  return domain;
}

async function readFeature(
  reader: Pick<IntentTransaction, 'intentFeature'>,
  workspaceId: string,
  id: string,
  path: string[],
): Promise<IntentFeatureRow> {
  const feature = await reader.intentFeature.findUnique({ where: nodeKey(workspaceId, id) });
  if (!feature) {
    throw intentNotFound(IntentErrorCode.FeatureNotFound, `Feature '${id}' does not exist in this workspace`, path);
  }
  return feature;
}

/**
 * Every dimension mutation reads its row through here, under FOR UPDATE, so
 * the snapshot it diffs (dropped values, `multi`) and `assertDimensionUnused`'s
 * scan both see the state it writes over. BR-7 race: propose and tree writes
 * take FOR SHARE on the same row, so a concurrent reference either commits
 * first and is seen by the scan, or waits and then sees the change.
 */
async function readDimension(
  tx: Pick<IntentTransaction, 'intentDimension' | '$queryRaw'>,
  workspaceId: string,
  id: string,
  path: string[],
): Promise<IntentDimensionRow> {
  await tx.$queryRaw`SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid AND id = ${id} FOR UPDATE`;
  const dimension = await tx.intentDimension.findUnique({ where: nodeKey(workspaceId, id) });
  if (!dimension) {
    throw intentNotFound(IntentErrorCode.DimensionNotFound, `Dimension '${id}' does not exist in this workspace`, path);
  }
  return dimension;
}

/**
 * The parent must exist in the same domain, must not be the feature itself or
 * below it, and the move must keep every feature within
 * {@link INTENT_FEATURE_MAX_DEPTH} ancestors — the moved feature's own subtree
 * included. A workspace lock serialises re-parenting, so two concurrent moves
 * cannot each pass the cycle check and close a loop together.
 */
async function assertParent(
  tx: IntentTransaction,
  workspaceId: string,
  featureId: string,
  domainId: string,
  parentId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':intent-feature-tree', 0))`;
  const parent = await readFeature(tx, workspaceId, parentId, ['parentFeatureId']);
  if (parent.domainId !== domainId) {
    throw intentStateError(
      IntentErrorCode.FeatureDomainMismatch,
      `Feature '${parentId}' is in domain '${parent.domainId}'; a feature can only sit under a feature of its own domain '${domainId}'.`,
      ['parentFeatureId'],
    );
  }
  const tooDeep = () =>
    intentStateError(
      IntentErrorCode.FeatureParentCycle,
      `Features nest at most ${INTENT_FEATURE_MAX_DEPTH} levels below the top; this move would go deeper.`,
      ['parentFeatureId'],
    );

  // Ancestors the moved feature would have: the parent and everything above it.
  let ancestors = 0;
  let cursor: string | null = parent.id;
  while (cursor !== null) {
    if (cursor === featureId) {
      throw intentStateError(
        IntentErrorCode.FeatureParentCycle,
        `Feature '${featureId}' cannot sit under '${parentId}': that is the feature itself or one of its own sub-features.`,
        ['parentFeatureId'],
      );
    }
    ancestors += 1;
    if (ancestors > INTENT_FEATURE_MAX_DEPTH) throw tooDeep();
    const row: { parentFeatureId: string | null } | null = await tx.intentFeature.findUnique({
      where: nodeKey(workspaceId, cursor),
      select: { parentFeatureId: true },
    });
    cursor = row?.parentFeatureId ?? null;
  }

  // Its deepest descendant moves down with it.
  let level = [featureId];
  for (let height = 1; level.length > 0; height += 1) {
    const children = await tx.intentFeature.findMany({
      where: { workspaceId, parentFeatureId: { in: level } },
      select: { id: true },
    });
    if (children.length === 0) break;
    if (ancestors + height > INTENT_FEATURE_MAX_DEPTH) throw tooDeep();
    level = children.map((child) => child.id);
  }
}

export interface IntentNodeRelationView {
  from: IntentNodeRefInput;
  to: IntentNodeRefInput;
  why: string;
  createdAt: string;
}

/**
 * The stored order of an unordered pair: by `kind:id`, the same comparison the
 * `intent_node_relations_canonical_check` constraint makes. A self-link is
 * refused here, before the constraint would turn it into a 500.
 */
export function canonicalRelationEndpoints(
  a: IntentNodeRefInput,
  b: IntentNodeRefInput,
): [IntentNodeRefInput, IntentNodeRefInput] {
  const keyA = `${a.kind}:${a.id}`;
  const keyB = `${b.kind}:${b.id}`;
  if (keyA === keyB) {
    throw intentStateError(IntentErrorCode.NodeRelationSelf, 'A relation must join two different nodes', ['to']);
  }
  return keyA < keyB ? [a, b] : [b, a];
}

function relationIdentity(workspaceId: string, from: IntentNodeRefInput, to: IntentNodeRefInput) {
  return {
    workspaceId_fromKind_fromId_toKind_toId: {
      workspaceId,
      fromKind: from.kind as IntentNodeKind,
      fromId: from.id,
      toKind: to.kind as IntentNodeKind,
      toId: to.id,
    },
  };
}

/** The audit entity id of a node relation; the workspace import writes the same one. */
export function relationEntityId(from: IntentNodeRefInput, to: IntentNodeRefInput): string {
  return `${from.kind}:${from.id}|${to.kind}:${to.id}`;
}

export function relationView(row: {
  fromKind: IntentNodeKind;
  fromId: string;
  toKind: IntentNodeKind;
  toId: string;
  why: string;
  createdAt: Date;
}): IntentNodeRelationView {
  return {
    from: { kind: row.fromKind, id: row.fromId },
    to: { kind: row.toKind, id: row.toId },
    why: row.why,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Delete every relation touching a node, inside the transaction that deletes the node. */
async function deleteNodeRelations(
  tx: Pick<IntentTransaction, 'intentNodeRelation'>,
  workspaceId: string,
  node: IntentNodeRefInput,
): Promise<number> {
  const kind = node.kind as IntentNodeKind;
  const { count } = await tx.intentNodeRelation.deleteMany({
    where: {
      workspaceId,
      OR: [
        { fromKind: kind, fromId: node.id },
        { toKind: kind, toId: node.id },
      ],
    },
  });
  return count;
}

function domainView(row: {
  id: string;
  title: string;
  statement: string;
  appliesWhen: Prisma.JsonValue;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}): IntentTreeDomainView {
  const appliesWhen = treeConditionsOf(row.appliesWhen);
  return {
    id: row.id,
    title: row.title,
    statement: row.statement,
    ...(appliesWhen ? { appliesWhen } : {}),
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function featureView(row: {
  id: string;
  domainId: string;
  parentFeatureId: string | null;
  title: string;
  statement: string;
  appliesWhen: Prisma.JsonValue;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}): IntentTreeFeatureView {
  return { ...domainView(row), domainId: row.domainId, parentFeatureId: row.parentFeatureId };
}

function dimensionView(row: {
  id: string;
  title: string;
  values: Prisma.JsonValue;
  multi: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}): IntentTreeDimensionView {
  return {
    id: row.id,
    title: row.title,
    // Written only through `IntentDimensionSchema`, so the stored shape is the contract's.
    values: row.values as unknown as IntentDimensionValue[],
    multi: row.multi,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Stored tree `applies_when`: NULL (or, defensively, an empty list) is an unconditioned node. */
export function treeConditionsOf(value: unknown): ContextCondition[] | undefined {
  return Array.isArray(value) && value.length > 0 ? (value as unknown as ContextCondition[]) : undefined;
}

/** Absent keeps the stored layout; `[]` clears it to NULL. */
export function layoutData(layout: unknown[] | undefined) {
  if (layout === undefined) return {};
  return { layout: layout.length > 0 ? (layout as Prisma.InputJsonValue) : Prisma.DbNull };
}

/** `[]` clears to NULL, so a cleared node reads exactly like one never conditioned. */
export function treeConditionsData(conditions: readonly unknown[] | undefined) {
  if (conditions === undefined) return {};
  return { appliesWhen: conditions.length > 0 ? (conditions as Prisma.InputJsonValue) : Prisma.DbNull };
}

/**
 * A tree-condition change reports how many accepted items it re-scopes (a
 * domain's count includes the items in its features); absent when the node's
 * conditions did not change.
 */
async function conditionImpact(
  tx: IntentTransaction,
  workspaceId: string,
  node: { domainId: string } | { featureId: string },
  before: { appliesWhen: Prisma.JsonValue } | null,
  after: { appliesWhen: Prisma.JsonValue },
): Promise<{ affectedAcceptedItems?: number }> {
  if (isDeepStrictEqual(treeConditionsOf(before?.appliesWhen), treeConditionsOf(after.appliesWhen))) return {};
  return {
    affectedAcceptedItems: await tx.intentItem.count({ where: { workspaceId, authority: 'accepted', ...node } }),
  };
}

function auditedConditions(row: { appliesWhen: Prisma.JsonValue }) {
  return { appliesWhen: treeConditionsOf(row.appliesWhen) ?? null };
}

/**
 * UC-1: tree conditions name declared, non-archived dimensions and values, with
 * the same typed errors as item conditions. FOR SHARE on the referenced rows
 * pairs with `readDimension`'s FOR UPDATE, as propose does (BR-4 race).
 */
async function validateTreeConditions(
  tx: IntentTransaction,
  workspaceId: string,
  conditions: ContextCondition[] | undefined,
): Promise<void> {
  if (!conditions || conditions.length === 0) return;
  const referenced = [
    ...new Set(conditions.flatMap((clause) => ('dimension' in clause ? [clause.dimension] : []))),
  ].sort();
  await tx.$queryRaw`SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid AND id IN (${Prisma.join(referenced)}) ORDER BY id FOR SHARE`;
  const dimensions: IntentDimension[] = (
    await tx.intentDimension.findMany({ where: { workspaceId, id: { in: referenced } } })
  ).map((row) => ({
    id: row.id,
    title: row.title,
    values: row.values as unknown as IntentDimensionValue[],
    multi: row.multi,
    archived: row.archived,
  }));
  const [issue] = validateAgainstRegistry(conditions, undefined, dimensions);
  if (!issue) return;
  const path = issue.path.map(String);
  throw issue.code === RegistryIssueCode.DimensionValueNotFound
    ? intentNotFound(
        IntentErrorCode.DimensionValueNotFound,
        `Dimension '${issue.dimension}' declares no value '${issue.value}'`,
        path,
      )
    : intentNotFound(
        IntentErrorCode.DimensionNotFound,
        `Dimension '${issue.dimension}' is not declared in this workspace, or is archived`,
        path,
      );
}

function valueIds(values: Prisma.JsonValue): string[] {
  return (values as unknown as IntentDimensionValue[]).map((value) => value.id);
}

/** A dimension clause in `column` (a JSONB clause list) names `dimension`, or one of `values` when given. */
function clauseReferences(column: Prisma.Sql, dimension: string, values: string[] | null): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) c
    WHERE c->>'dimension' = ${dimension}::text
      AND (
        ${values}::text[] IS NULL
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(c->'in', c->'notIn', '[]'::jsonb)) v
          WHERE v = ANY(${values}::text[])
        )
      )
  )`;
}

/**
 * BR-7 / BR-4: refuse while a candidate or accepted item references the
 * dimension (`values === null`) or one of `values`, in its `applies_when`
 * clauses or in a business rule's `payload.variants[].when`, or while a domain
 * or feature `applies_when` does. Rejected and superseded items are history,
 * not live references, so they never block; archived tree nodes still pass
 * their conditions to their items, so they do.
 *
 * The check runs inside the mutating transaction, after `readDimension` took the
 * row's FOR UPDATE lock, so the named blockers are the state the refusal saw.
 */
async function assertDimensionUnused(
  tx: Pick<IntentTransaction, '$queryRaw'>,
  workspaceId: string,
  dimension: string,
  values: string[] | null,
  path: string[],
): Promise<void> {
  const limit = INTENT_CONTRACT_LIMITS.dimensionInUseItems;
  const items = await tx.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM intent_items i
    WHERE i.workspace_id = ${workspaceId}::uuid
      AND i.authority IN ('candidate', 'accepted')
      AND (
        ${clauseReferences(Prisma.sql`i.applies_when`, dimension, values)}
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(i.payload->'variants') = 'array' THEN i.payload->'variants' ELSE '[]'::jsonb END
          ) r
          WHERE (r->'when'->${dimension}::text) IS NOT NULL
            AND (
              ${values}::text[] IS NULL
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(r->'when'->${dimension}::text) = 'array'
                    THEN r->'when'->${dimension}::text
                    ELSE jsonb_build_array(r->'when'->${dimension}::text) END
                ) v
                WHERE v = ANY(${values}::text[])
              )
            )
        )
      )
    ORDER BY i.id
    LIMIT ${limit + 1}::int
  `;
  const nodes = await tx.$queryRaw<{ kind: string; id: string }[]>`
    SELECT kind, id FROM (
      SELECT 'domain' AS kind, d.id FROM intent_domains d
      WHERE d.workspace_id = ${workspaceId}::uuid AND ${clauseReferences(Prisma.sql`d.applies_when`, dimension, values)}
      UNION ALL
      SELECT 'feature' AS kind, f.id FROM intent_features f
      WHERE f.workspace_id = ${workspaceId}::uuid AND ${clauseReferences(Prisma.sql`f.applies_when`, dimension, values)}
    ) n
    ORDER BY kind, id
    LIMIT ${limit + 1}::int
  `;
  const blockers = [...nodes.map((row) => `${row.kind} ${row.id}`), ...items.map((row) => `item ${row.id}`)];
  if (blockers.length === 0) return;

  const shown = blockers.slice(0, limit);
  const more = blockers.length > limit ? ' and more' : '';
  const target =
    values === null ? `Dimension '${dimension}'` : `Value(s) ${values.join(', ')} of dimension '${dimension}'`;
  throw intentStateError(
    IntentErrorCode.DimensionInUse,
    `${target} ${values === null ? 'is' : 'are'} still referenced by ${shown.join(', ')}${more}. Change those first.`,
    path,
    HttpStatus.BAD_REQUEST,
    shown.map((blocker) => ({
      code: IntentErrorCode.DimensionInUse,
      message: `referenced by ${blocker}`,
      path,
    })),
  );
}

/**
 * Delete is refused while anything hangs off the node, naming the first
 * blockers. The database refuses independently (the child FKs are `NoAction`,
 * see {@link withForeignKeyRefusal}); this pre-check is for a usable message.
 */
async function assertNodeEmpty(
  tx: IntentTransaction,
  workspaceId: string,
  label: string,
  id: string,
  occupants: { features: Prisma.IntentFeatureWhereInput; items: Prisma.IntentItemWhereInput },
): Promise<void> {
  const [features, items] = await Promise.all([
    tx.intentFeature.findMany({
      where: { workspaceId, ...occupants.features },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 20,
    }),
    tx.intentItem.findMany({
      where: { workspaceId, ...occupants.items },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 20,
    }),
  ]);
  const blockers = [...features.map((row) => `feature ${row.id}`), ...items.map((row) => `item ${row.id}`)];
  if (blockers.length === 0) return;
  throw intentStateError(
    IntentErrorCode.TreeNodeNotEmpty,
    `${label} '${id}' still holds ${blockers.join(', ')}. Archive it, or move its contents first — reviewed intent is never deleted as a side effect.`,
    ['id'],
  );
}

/** Drop the node's relations, then the node; answers how many relations went with it. */
async function deleteTreeNode(
  tx: IntentTransaction,
  workspaceId: string,
  node: IntentNodeRefInput,
  label: string,
  remove: () => Promise<unknown>,
): Promise<number> {
  const removedRelationCount = await deleteNodeRelations(tx, workspaceId, node);
  await withForeignKeyRefusal(label, node.id, remove);
  return removedRelationCount;
}

/**
 * The same refusal, reconstructed from PostgreSQL's own answer.
 *
 * The pre-check above races a concurrent insert; the `NoAction` child foreign
 * keys are what actually makes the deletion impossible. Without this mapping a
 * lost race would surface as an opaque 500.
 */
async function withForeignKeyRefusal<T>(kind: string, id: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      throw intentStateError(
        IntentErrorCode.TreeNodeNotEmpty,
        `${kind} '${id}' gained a feature or an item while it was being deleted. Re-read it and try again.`,
        ['id'],
      );
    }
    throw error;
  }
}

/**
 * A seed's node type comes from the node id itself (`{repoHash}:{type}:…`) —
 * the request carries no `nodeType` and the table has no column for one. An id
 * of an unseedable kind is refused with the covered kinds enumerated, the same
 * fail-fast the anchor contract applies (spec §4.6).
 */
function assertSeedNodeId(nodeId: string): void {
  const kind = nodeIdKindOf(nodeId);
  if (kind !== null && (INTENT_SEED_NODE_ID_KINDS as string[]).includes(kind)) return;
  throw intentStateError(
    IntentErrorCode.UnsupportedSeedNodeType,
    `A feature seed must name a stable node id of a seedable kind (${INTENT_SEED_NODE_ID_KINDS.join(', ')})`,
    ['nodeId'],
  );
}
