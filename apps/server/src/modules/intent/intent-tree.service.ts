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
import { IntentAuditEntityKind, IntentNodeKind, Prisma } from '../../generated/prisma/client.js';
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

export interface IntentTreeDimensionView {
  id: string;
  title: string;
  values: IntentDimensionValue[];
  multi: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
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

    return {
      domains: page.map((domain) => ({
        ...domainView(domain),
        features: domain.features.slice(0, INTENT_TREE_FEATURES_PER_DOMAIN).map(featureView),
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
    return { features: page.map(featureView), nextCursor };
  }

  async listSeeds(workspaceId: string, featureId: string, query: ListIntentFeatureSeedsQuery, limit: number) {
    await this.readFeature(this.prisma, workspaceId, featureId, ['featureId']);
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

  /* ------------------------------------------------------------ domains --- */

  async createDomain(workspaceId: string, actor: IntentActor, input: CreateIntentDomainInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DomainCreate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await validateTreeConditions(tx, workspaceId, input.appliesWhen);
        const existing = await tx.intentDomain.findUnique({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          select: { id: true },
        });
        if (existing) {
          throw intentStateError(
            IntentErrorCode.TreeNodeExists,
            `Domain '${input.id}' already exists in this workspace. Ids are immutable; update it instead of re-creating it.`,
            ['id'],
          );
        }

        const created = await tx.intentDomain.create({
          data: {
            workspaceId,
            id: input.id,
            title: input.title,
            statement: input.statement ?? EMPTY_STATEMENT,
            ...treeConditionsData(input.appliesWhen),
            ...layoutData(input.layout),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        return {
          response: {
            domain: domainView(created),
            ...(await conditionImpact(tx, workspaceId, { domainId: created.id }, null, created)),
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.domain,
              entityId: created.id,
              operation: IntentAuditOperation.Create,
              after: { title: created.title, archived: created.archived, ...auditedConditions(created) },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async updateDomain(workspaceId: string, actor: IntentActor, input: UpdateIntentDomainInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DomainUpdate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDomain(tx, workspaceId, input.id, ['id']);
        await validateTreeConditions(tx, workspaceId, input.appliesWhen);
        const updated = await tx.intentDomain.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.statement !== undefined ? { statement: input.statement } : {}),
            ...treeConditionsData(input.appliesWhen),
            ...layoutData(input.layout),
            updatedBy: actor.id,
          },
        });
        return {
          response: {
            domain: domainView(updated),
            ...(await conditionImpact(tx, workspaceId, { domainId: updated.id }, before, updated)),
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.domain,
              entityId: updated.id,
              operation: IntentAuditOperation.Update,
              before: { title: before.title, ...(input.appliesWhen !== undefined ? auditedConditions(before) : {}) },
              after: { title: updated.title, ...(input.appliesWhen !== undefined ? auditedConditions(updated) : {}) },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async archiveDomain(workspaceId: string, actor: IntentActor, input: ArchiveIntentDomainInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DomainArchive,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDomain(tx, workspaceId, input.id, ['id']);
        const updated = await tx.intentDomain.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: { archived: input.archived, updatedBy: actor.id },
        });
        return {
          response: { domain: domainView(updated) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.domain,
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
   * Delete a domain, refusing while it still holds features or attached items.
   *
   * The blockers are counted and named INSIDE the transaction that deletes, so
   * the message a maintainer reads is the state the delete actually saw. The
   * database says the same thing independently (the child FKs are `NoAction`),
   * and that refusal is mapped too — the pre-check is for a usable message, not
   * for correctness.
   */
  async deleteDomain(workspaceId: string, actor: IntentActor, input: DeleteIntentDomainInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DomainDelete,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDomain(tx, workspaceId, input.id, ['id']);
        const features = await tx.intentFeature.findMany({
          where: { workspaceId, domainId: input.id },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 20,
        });
        const items = await tx.intentItem.findMany({
          where: { workspaceId, domainId: input.id },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 20,
        });
        assertEmpty('Domain', input.id, [
          ...features.map((row) => `feature ${row.id}`),
          ...items.map((row) => `item ${row.id}`),
        ]);

        const relationCount = await deleteNodeRelations(tx, workspaceId, { kind: 'domain', id: input.id });
        await withForeignKeyRefusal('Domain', input.id, () =>
          tx.intentDomain.delete({ where: { workspaceId_id: { workspaceId, id: input.id } } }),
        );
        return {
          response: { deleted: { kind: 'domain', id: input.id, removedRelationCount: relationCount } },
          audits: [
            {
              entityKind: IntentAuditEntityKind.domain,
              entityId: input.id,
              operation: IntentAuditOperation.Delete,
              before: { title: before.title, archived: before.archived },
              after: { removedRelationCount: relationCount },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /* ----------------------------------------------------------- features --- */

  async createFeature(workspaceId: string, actor: IntentActor, input: CreateIntentFeatureInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.FeatureCreate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        await this.readDomain(tx, workspaceId, input.domainId, ['domainId']);
        if (input.parentFeatureId !== undefined)
          await this.assertParent(tx, workspaceId, input.id, input.domainId, input.parentFeatureId);
        await validateTreeConditions(tx, workspaceId, input.appliesWhen);
        const existing = await tx.intentFeature.findUnique({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          select: { id: true },
        });
        if (existing) {
          throw intentStateError(
            IntentErrorCode.TreeNodeExists,
            `Feature '${input.id}' already exists in this workspace. Ids are immutable; update it instead of re-creating it.`,
            ['id'],
          );
        }

        const created = await tx.intentFeature.create({
          data: {
            workspaceId,
            id: input.id,
            domainId: input.domainId,
            ...(input.parentFeatureId !== undefined ? { parentFeatureId: input.parentFeatureId } : {}),
            title: input.title,
            statement: input.statement ?? EMPTY_STATEMENT,
            ...treeConditionsData(input.appliesWhen),
            ...layoutData(input.layout),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        return {
          response: {
            feature: featureView(created),
            ...(await conditionImpact(tx, workspaceId, { featureId: created.id }, null, created)),
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature,
              entityId: created.id,
              operation: IntentAuditOperation.Create,
              after: {
                domainId: created.domainId,
                ...(created.parentFeatureId ? { parentFeatureId: created.parentFeatureId } : {}),
                title: created.title,
                archived: created.archived,
                ...auditedConditions(created),
              },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async updateFeature(workspaceId: string, actor: IntentActor, input: UpdateIntentFeatureInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.FeatureUpdate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readFeature(tx, workspaceId, input.id, ['id']);
        if (input.parentFeatureId)
          await this.assertParent(tx, workspaceId, input.id, before.domainId, input.parentFeatureId);
        await validateTreeConditions(tx, workspaceId, input.appliesWhen);
        const updated = await tx.intentFeature.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.parentFeatureId !== undefined ? { parentFeatureId: input.parentFeatureId } : {}),
            ...(input.statement !== undefined ? { statement: input.statement } : {}),
            ...treeConditionsData(input.appliesWhen),
            ...layoutData(input.layout),
            updatedBy: actor.id,
          },
        });
        return {
          response: {
            feature: featureView(updated),
            ...(await conditionImpact(tx, workspaceId, { featureId: updated.id }, before, updated)),
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature,
              entityId: updated.id,
              operation: IntentAuditOperation.Update,
              before: {
                title: before.title,
                ...(input.parentFeatureId !== undefined ? { parentFeatureId: before.parentFeatureId } : {}),
                ...(input.appliesWhen !== undefined ? auditedConditions(before) : {}),
              },
              after: {
                title: updated.title,
                ...(input.parentFeatureId !== undefined ? { parentFeatureId: updated.parentFeatureId } : {}),
                ...(input.appliesWhen !== undefined ? auditedConditions(updated) : {}),
              },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async archiveFeature(workspaceId: string, actor: IntentActor, input: ArchiveIntentFeatureInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.FeatureArchive,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readFeature(tx, workspaceId, input.id, ['id']);
        const updated = await tx.intentFeature.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: { archived: input.archived, updatedBy: actor.id },
        });
        return {
          response: { feature: featureView(updated) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature,
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
   * Delete a feature, refusing while items are still attached to it.
   *
   * Seeds are NOT blockers: they are part of the feature's own definition and
   * cascade with it (`intent_feature_seeds` → feature is `onDelete: Cascade`),
   * whereas an item is reviewed content that must never vanish as a side
   * effect. The count of cascaded seeds is recorded in the audit row.
   */
  async deleteFeature(workspaceId: string, actor: IntentActor, input: DeleteIntentFeatureInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.FeatureDelete,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readFeature(tx, workspaceId, input.id, ['id']);
        const [children, items] = await Promise.all([
          tx.intentFeature.findMany({
            where: { workspaceId, parentFeatureId: input.id },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 20,
          }),
          tx.intentItem.findMany({
            where: { workspaceId, featureId: input.id },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 20,
          }),
        ]);
        assertEmpty('Feature', input.id, [
          ...children.map((row) => `feature ${row.id}`),
          ...items.map((row) => `item ${row.id}`),
        ]);

        const seedCount = await tx.intentFeatureSeed.count({ where: { workspaceId, featureId: input.id } });
        const relationCount = await deleteNodeRelations(tx, workspaceId, { kind: 'feature', id: input.id });
        await withForeignKeyRefusal('Feature', input.id, () =>
          tx.intentFeature.delete({ where: { workspaceId_id: { workspaceId, id: input.id } } }),
        );
        return {
          response: {
            deleted: {
              kind: 'feature',
              id: input.id,
              cascadedSeedCount: seedCount,
              removedRelationCount: relationCount,
            },
          },
          audits: [
            {
              entityKind: IntentAuditEntityKind.feature,
              entityId: input.id,
              operation: IntentAuditOperation.Delete,
              before: { domainId: before.domainId, title: before.title, archived: before.archived },
              after: { cascadedSeedCount: seedCount, removedRelationCount: relationCount },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /* --------------------------------------------------------- dimensions --- */

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

  async createDimension(workspaceId: string, actor: IntentActor, input: CreateIntentDimensionInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DimensionCreate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        // Serializes creates per workspace so two at `limit - 1` cannot both pass the count.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':intent-dimensions', 0))`;
        const existing = await tx.intentDimension.findUnique({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          select: { id: true },
        });
        if (existing) {
          throw intentStateError(
            IntentErrorCode.TreeNodeExists,
            `Dimension '${input.id}' already exists in this workspace. Ids are immutable; update it instead of re-creating it.`,
            ['id'],
          );
        }
        // Archived dimensions count: un-archiving must not overflow the registry.
        if ((await tx.intentDimension.count({ where: { workspaceId } })) >= INTENT_LIMITS.dimensions) {
          throw intentStateError(
            IntentErrorCode.SchemaViolation,
            `This workspace already declares ${INTENT_LIMITS.dimensions} dimensions (archived included), the most it may hold. Delete an unused one first.`,
            ['id'],
          );
        }
        const created = await tx.intentDimension.create({
          data: {
            workspaceId,
            id: input.id,
            title: input.title,
            values: input.values,
            multi: input.multi ?? false,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        return {
          response: { dimension: dimensionView(created) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.dimension,
              entityId: created.id,
              operation: IntentAuditOperation.Create,
              after: { title: created.title, values: valueIds(created.values), multi: created.multi },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  async updateDimension(workspaceId: string, actor: IntentActor, input: UpdateIntentDimensionInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DimensionUpdate,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDimension(tx, workspaceId, input.id, ['id']);
        if (input.values !== undefined) {
          const kept = new Set(input.values.map((value) => value.id));
          const dropped = valueIds(before.values).filter((id) => !kept.has(id));
          if (dropped.length > 0) {
            await assertDimensionUnused(tx, workspaceId, input.id, dropped, ['values']);
          }
        }
        // Flipping `multi` changes how every stored clause and variant on it reads.
        if (input.multi !== undefined && input.multi !== before.multi) {
          await assertDimensionUnused(tx, workspaceId, input.id, null, ['multi']);
        }
        const updated = await tx.intentDimension.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.values !== undefined ? { values: input.values } : {}),
            ...(input.multi !== undefined ? { multi: input.multi } : {}),
            updatedBy: actor.id,
          },
        });
        return {
          response: { dimension: dimensionView(updated) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.dimension,
              entityId: updated.id,
              operation: IntentAuditOperation.Update,
              before: { title: before.title, values: valueIds(before.values), multi: before.multi },
              after: { title: updated.title, values: valueIds(updated.values), multi: updated.multi },
            } satisfies IntentAuditRecord,
          ],
        };
      },
    );
  }

  /** Un-archiving is always allowed; archiving is refused while items reference the dimension (BR-7). */
  async archiveDimension(workspaceId: string, actor: IntentActor, input: ArchiveIntentDimensionInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DimensionArchive,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDimension(tx, workspaceId, input.id, ['id']);
        if (input.archived) await assertDimensionUnused(tx, workspaceId, input.id, null, ['id']);
        const updated = await tx.intentDimension.update({
          where: { workspaceId_id: { workspaceId, id: input.id } },
          data: { archived: input.archived, updatedBy: actor.id },
        });
        return {
          response: { dimension: dimensionView(updated) },
          audits: [
            {
              entityKind: IntentAuditEntityKind.dimension,
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

  async deleteDimension(workspaceId: string, actor: IntentActor, input: DeleteIntentDimensionInput) {
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.DimensionDelete,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const before = await this.readDimension(tx, workspaceId, input.id, ['id']);
        await assertDimensionUnused(tx, workspaceId, input.id, null, ['id']);
        await tx.intentDimension.delete({ where: { workspaceId_id: { workspaceId, id: input.id } } });
        return {
          response: { deleted: { kind: 'dimension', id: input.id } },
          audits: [
            {
              entityKind: IntentAuditEntityKind.dimension,
              entityId: input.id,
              operation: IntentAuditOperation.Delete,
              before: { title: before.title, values: valueIds(before.values), archived: before.archived },
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
        await this.readFeature(tx, workspaceId, input.featureId, ['featureId']);
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
        await this.readNode(tx, workspaceId, input.from, ['from']);
        await this.readNode(tx, workspaceId, input.to, ['to']);

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

  /* ------------------------------------------------------------ helpers --- */

  private async readNode(
    reader: Pick<IntentTransaction, 'intentDomain' | 'intentFeature'>,
    workspaceId: string,
    node: IntentNodeRefInput,
    path: string[],
  ) {
    return node.kind === 'domain'
      ? this.readDomain(reader, workspaceId, node.id, [...path, 'id'])
      : this.readFeature(reader, workspaceId, node.id, [...path, 'id']);
  }

  private async readDomain(
    reader: Pick<IntentTransaction, 'intentDomain'>,
    workspaceId: string,
    id: string,
    path: string[],
  ) {
    const domain = await reader.intentDomain.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
    if (!domain) {
      throw intentNotFound(IntentErrorCode.DomainNotFound, `Domain '${id}' does not exist in this workspace`, path);
    }
    return domain;
  }

  /**
   * Every dimension mutation reads its row through here, under FOR UPDATE, so
   * the snapshot it diffs (dropped values, `multi`) and `assertDimensionUnused`'s
   * scan both see the state it writes over. BR-7 race: propose and tree writes
   * take FOR SHARE on the same row, so a concurrent reference either commits
   * first and is seen by the scan, or waits and then sees the change.
   */
  private async readDimension(
    tx: Pick<IntentTransaction, 'intentDimension' | '$queryRaw'>,
    workspaceId: string,
    id: string,
    path: string[],
  ) {
    await tx.$queryRaw`SELECT 1 FROM intent_dimensions WHERE workspace_id = ${workspaceId}::uuid AND id = ${id} FOR UPDATE`;
    const dimension = await tx.intentDimension.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
    if (!dimension) {
      throw intentNotFound(
        IntentErrorCode.DimensionNotFound,
        `Dimension '${id}' does not exist in this workspace`,
        path,
      );
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
  private async assertParent(
    tx: IntentTransaction,
    workspaceId: string,
    featureId: string,
    domainId: string,
    parentId: string,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}::text || ':intent-feature-tree', 0))`;
    const parent = await this.readFeature(tx, workspaceId, parentId, ['parentFeatureId']);
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
        where: { workspaceId_id: { workspaceId, id: cursor } },
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

  private async readFeature(
    reader: Pick<IntentTransaction, 'intentFeature'>,
    workspaceId: string,
    id: string,
    path: string[],
  ) {
    const feature = await reader.intentFeature.findUnique({ where: { workspaceId_id: { workspaceId, id } } });
    if (!feature) {
      throw intentNotFound(IntentErrorCode.FeatureNotFound, `Feature '${id}' does not exist in this workspace`, path);
    }
    return feature;
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
export function treeConditionsOf(value: Prisma.JsonValue | undefined): ContextCondition[] | undefined {
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

/** The structured "still occupied" refusal, naming what has to go first. */
function assertEmpty(kind: string, id: string, blockers: string[]): void {
  if (blockers.length === 0) return;
  throw intentStateError(
    IntentErrorCode.TreeNodeNotEmpty,
    `${kind} '${id}' still holds ${blockers.join(', ')}. Archive it, or move its contents first — reviewed intent is never deleted as a side effect.`,
    ['id'],
  );
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
