/**
 * Workspace import: a whole product knowledge base becomes the intent content
 * of an empty workspace in one transaction.
 *
 * The overlay import (`intent-import.service.ts`) carries the local file format,
 * which has no features, no node relations, no delivery status and a 500-item
 * ceiling. A knowledge base kept anywhere else (a Markdown tree, another tool)
 * needs all four, so this import takes its own document,
 * `CloudIntentWorkspaceDocumentV1`, and writes:
 *
 * - the tree (domains, features), the dimension registry and node relations;
 * - items with their sources, at authority `accepted`, `candidate`,
 *   `superseded` or `rejected`, each with the NULL-`from` arrival transition an import
 *   records (it never fabricates a review nobody made);
 * - delivery status as release evidence: one `baseline` event for the items in
 *   production and one `plan` event per planned item, exactly the events
 *   `intent_release` would have written into an empty ledger.
 *
 * Everything is validated before the transaction opens, against the document
 * itself (the workspace is empty, so the document is the whole registry), and
 * every refusal names its path inside `document`. Nothing is partial: a refused
 * document writes nothing, and a retried key replays the stored result.
 */
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ContextConditionsSchema,
  IntentDimensionSchema,
  IntentKind,
  TreeConditionsSchema,
  INTENT_ID_PREFIX_BY_KIND,
  checkVariantOverlap,
  validateAgainstRegistry,
  validateIntentPayload,
  type ContextCondition,
  type IntentDimension,
  type RuleVariant,
} from '@coredoc/core';
import { z } from 'zod';
import {
  IntentAuditEntityKind,
  IntentAuthoritySourceKind,
  IntentItemAuthority,
  IntentItemKind,
  IntentNodeKind,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  INTENT_CONTRACT_LIMITS,
  IntentErrorCode,
  IntentItemBodySchema,
  IntentNodeLayoutSchema,
  IntentNodeRefSchema,
  IntentSourceSchema,
  canonicalRevision,
  idempotencyKey,
  slugId,
  text,
  type IntentErrorDetail,
  type IntentNodeRefInput,
} from './contract/index.js';
import {
  IntentAuditOperation,
  IntentOperation,
  createIntentRowsChunked,
  hashIntentRequest,
  runIntentMutation,
  type IntentActor,
  type IntentAuditRecord,
  type IntentTransaction,
} from './intent-idempotency.js';
import { assertWorkspaceIntentEmpty, readIntentContentCounts } from './intent-import.preconditions.js';
import { foldIntentReleases, ReleaseActorKind, type ReleaseEvent } from './intent-release.fold.js';
import { releaseContentHash } from './intent-release.service.js';
import { intentStateError } from './intent-state-errors.js';
import {
  INTENT_FEATURE_MAX_DEPTH,
  canonicalRelationEndpoints,
  layoutData,
  relationEntityId,
  treeConditionsData,
} from './intent-tree.service.js';

export const CLOUD_INTENT_WORKSPACE_FORMAT_VERSION = 1;

export const INTENT_WORKSPACE_IMPORT_LIMITS = {
  items: 5_000,
  domains: 500,
  features: 2_000,
  relations: 5_000,
  /** Refusals reported in one answer. */
  details: 20,
} as const;

const PLAN_REASON = 'Planned in the imported knowledge base';
const BASELINE_REASON = 'In production when the knowledge base was imported';

const NodeSchema = {
  id: slugId(),
  title: text(INTENT_CONTRACT_LIMITS.title),
  statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
  appliesWhen: TreeConditionsSchema.optional(),
  layout: IntentNodeLayoutSchema.optional(),
  /** An archived node stays readable and hidden from browse defaults, as after `domain.archive`. */
  archived: z.boolean().optional(),
};

const ItemSchema = z
  .object({
    id: slugId(),
    kind: z.enum(IntentKind),
    /** Optional beside `featureId` (the feature names its domain); a value must agree. */
    domainId: slugId().optional(),
    featureId: slugId().optional(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    statement: text(INTENT_CONTRACT_LIMITS.statement),
    payload: z.record(z.string(), z.unknown()).optional(),
    appliesWhen: ContextConditionsSchema.optional(),
    rationale: text(INTENT_CONTRACT_LIMITS.text).optional(),
    body: IntentItemBodySchema.optional(),
    authority: z.enum(['accepted', 'candidate', 'superseded', 'rejected']),
    /** On a superseded item: the accepted item of the same kind that replaced it. */
    supersededById: slugId().optional(),
    /** The item this one replaces or proposes to replace. */
    proposedSuccessorOfId: slugId().optional(),
    sources: z.array(IntentSourceSchema).min(1).max(INTENT_CONTRACT_LIMITS.sourcesPerItem),
  })
  .strict();

export const CloudIntentWorkspaceDocumentSchema = z
  .object({
    formatVersion: z.literal(CLOUD_INTENT_WORKSPACE_FORMAT_VERSION),
    /** Where the content came from; recorded on every arrival transition. */
    source: z.object({ ref: text(INTENT_CONTRACT_LIMITS.ref), revision: canonicalRevision }).strict(),
    domains: z.array(z.object(NodeSchema).strict()).max(INTENT_WORKSPACE_IMPORT_LIMITS.domains),
    features: z
      .array(z.object({ ...NodeSchema, domainId: slugId(), parentFeatureId: slugId().optional() }).strict())
      .max(INTENT_WORKSPACE_IMPORT_LIMITS.features),
    dimensions: z.array(IntentDimensionSchema).optional(),
    relations: z
      .array(
        z
          .object({
            from: IntentNodeRefSchema,
            to: IntentNodeRefSchema,
            why: text(INTENT_CONTRACT_LIMITS.relationWhy),
          })
          .strict(),
      )
      .max(INTENT_WORKSPACE_IMPORT_LIMITS.relations)
      .optional(),
    items: z.array(ItemSchema).max(INTENT_WORKSPACE_IMPORT_LIMITS.items),
    releases: z
      .object({
        baseline: z
          .object({ deliveredRef: text(256), itemIds: z.array(slugId()).min(1) })
          .strict()
          .optional(),
        plans: z
          .array(z.object({ itemId: slugId(), reason: text(INTENT_CONTRACT_LIMITS.text).optional() }).strict())
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CloudIntentWorkspaceDocumentV1 = z.infer<typeof CloudIntentWorkspaceDocumentSchema>;
type DocumentItem = CloudIntentWorkspaceDocumentV1['items'][number];

export const ImportIntentWorkspaceSchema = z
  .object({ idempotencyKey, document: z.record(z.string(), z.unknown()) })
  .strict();

export type ImportIntentWorkspaceInput = z.infer<typeof ImportIntentWorkspaceSchema>;

export interface CloudIntentWorkspaceImportResultV1 {
  formatVersion: number;
  workspaceId: string;
  source: { ref: string; revision: string };
  counts: {
    domains: number;
    features: number;
    dimensions: number;
    relations: number;
    items: Record<'accepted' | 'candidate' | 'superseded' | 'rejected', number>;
    sources: number;
    baselineItems: number;
    plans: number;
  };
  /** The release ledger head after import: 0 when no release evidence was written. */
  releaseHeadSeq: number;
}

/** Collects refusals with document paths; throws once with all of them (bounded). */
class Refusals {
  readonly details: IntentErrorDetail[] = [];

  add(code: IntentErrorCode, message: string, path: (string | number)[]): void {
    this.details.push({ code, message, path: ['document', ...path.map(String)] });
  }

  throwIfAny(): void {
    if (this.details.length === 0) return;
    const shown = this.details.slice(0, INTENT_WORKSPACE_IMPORT_LIMITS.details);
    const first = shown[0] as IntentErrorDetail;
    const more = this.details.length - shown.length;
    throw intentStateError(
      first.code,
      more > 0 ? `${first.message} (and ${this.details.length - 1} more refusals)` : first.message,
      first.path,
      undefined,
      shown,
    );
  }
}

/**
 * Every rule a reviewed write would enforce, checked against the document.
 * Pure, so the whole matrix is testable without a database.
 */
export function validateWorkspaceDocument(raw: Record<string, unknown>): CloudIntentWorkspaceDocumentV1 {
  const parsed = CloudIntentWorkspaceDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const refusals = new Refusals();
    for (const issue of parsed.error.issues) {
      refusals.add(IntentErrorCode.ImportOverlayInvalid, issue.message, issue.path as (string | number)[]);
    }
    refusals.throwIfAny();
  }
  const document = (parsed as { data: CloudIntentWorkspaceDocumentV1 }).data;
  const refusals = new Refusals();

  const domainIds = uniqueIds(document.domains, ['domains'], 'domain', refusals);
  const featureById = new Map(document.features.map((feature) => [feature.id, feature]));
  uniqueIds(document.features, ['features'], 'feature', refusals);
  const dimensions = (document.dimensions ?? []) as IntentDimension[];
  uniqueIds(dimensions, ['dimensions'], 'dimension', refusals);
  const itemById = new Map<string, DocumentItem>();
  uniqueIds(document.items, ['items'], 'item', refusals);
  for (const item of document.items) itemById.set(item.id, item);

  const registryRefusals = (issues: ReturnType<typeof validateAgainstRegistry>, path: (string | number)[]) => {
    for (const issue of issues) {
      refusals.add(
        issue.code === 'dimension_value_not_found'
          ? IntentErrorCode.DimensionValueNotFound
          : IntentErrorCode.DimensionNotFound,
        issue.value
          ? `dimension '${issue.dimension}' declares no value '${issue.value}'`
          : `dimension '${issue.dimension}' is not declared in the document`,
        [...path, ...issue.path],
      );
    }
  };

  document.domains.forEach((domain, index) =>
    registryRefusals(validateAgainstRegistry(domain.appliesWhen as ContextCondition[], undefined, dimensions), [
      'domains',
      index,
    ]),
  );
  document.features.forEach((feature, index) => {
    if (!domainIds.has(feature.domainId)) {
      refusals.add(
        IntentErrorCode.DomainNotFound,
        `feature '${feature.id}' names undeclared domain '${feature.domainId}'`,
        ['features', index, 'domainId'],
      );
    }
    registryRefusals(validateAgainstRegistry(feature.appliesWhen as ContextCondition[], undefined, dimensions), [
      'features',
      index,
    ]);
    if (feature.parentFeatureId === undefined) return;
    const parent = featureById.get(feature.parentFeatureId);
    if (!parent) {
      refusals.add(
        IntentErrorCode.FeatureNotFound,
        `feature '${feature.id}' names undeclared parent feature '${feature.parentFeatureId}'`,
        ['features', index, 'parentFeatureId'],
      );
    } else if (parent.domainId !== feature.domainId) {
      refusals.add(
        IntentErrorCode.FeatureDomainMismatch,
        `parent feature '${parent.id}' is in domain '${parent.domainId}', not '${feature.domainId}'`,
        ['features', index, 'parentFeatureId'],
      );
    } else if (featureDepth(feature.id, featureById) === null) {
      refusals.add(
        IntentErrorCode.FeatureParentCycle,
        `feature '${feature.id}' is its own ancestor, or nests deeper than ${INTENT_FEATURE_MAX_DEPTH} levels`,
        ['features', index, 'parentFeatureId'],
      );
    }
  });

  document.items.forEach((item, index) => {
    const at = ['items', index];
    const prefix = INTENT_ID_PREFIX_BY_KIND[item.kind];
    if (!item.id.startsWith(`${prefix}-`)) {
      refusals.add(IntentErrorCode.SchemaViolation, `a ${item.kind} id starts with '${prefix}-'`, [...at, 'id']);
    }

    if (item.featureId !== undefined) {
      const feature = featureById.get(item.featureId);
      if (!feature) {
        refusals.add(IntentErrorCode.FeatureNotFound, `item names undeclared feature '${item.featureId}'`, [
          ...at,
          'featureId',
        ]);
      } else if (item.domainId !== undefined && item.domainId !== feature.domainId) {
        refusals.add(
          IntentErrorCode.FeatureDomainMismatch,
          `feature '${feature.id}' is in domain '${feature.domainId}', not '${item.domainId}'`,
          [...at, 'domainId'],
        );
      }
    } else if (item.domainId !== undefined && !domainIds.has(item.domainId)) {
      refusals.add(IntentErrorCode.DomainNotFound, `item names undeclared domain '${item.domainId}'`, [
        ...at,
        'domainId',
      ]);
    }

    if (item.payload !== undefined) {
      for (const error of validateIntentPayload(item.kind, item.payload)) {
        refusals.add(IntentErrorCode.SchemaViolation, error.message, [...at, 'payload', ...error.path]);
      }
    }
    const variants = (item.payload as { variants?: RuleVariant[] } | undefined)?.variants;
    // Variant paths come back as `variants.N…`; they live inside the payload.
    registryRefusals(
      validateAgainstRegistry(item.appliesWhen as ContextCondition[], variants, dimensions).map((issue) =>
        issue.path[0] === 'variants' ? { ...issue, path: ['payload', ...issue.path] } : issue,
      ),
      at,
    );
    const [overlap] = checkVariantOverlap(variants);
    if (overlap) {
      refusals.add(IntentErrorCode.VariantOverlap, `variants ${overlap.otherIndex} and ${overlap.index} overlap`, [
        ...at,
        'payload',
        'variants',
        overlap.index,
      ]);
    }
    (item.appliesWhen ?? []).forEach((clause, clauseIndex) => {
      if ('item' in clause && !itemById.has(clause.item)) {
        refusals.add(IntentErrorCode.ItemNotFound, `condition names item '${clause.item}', not in the document`, [
          ...at,
          'appliesWhen',
          clauseIndex,
        ]);
      }
    });

    const sourceKeys = new Set<string>();
    item.sources.forEach((source, sourceIndex) => {
      const key = `${source.ref}\0${source.localId}`;
      if (sourceKeys.has(key)) {
        refusals.add(IntentErrorCode.SchemaViolation, 'the same source is listed twice', [
          ...at,
          'sources',
          sourceIndex,
        ]);
      }
      sourceKeys.add(key);
    });

    validateSupersession(item, at, itemById, refusals);
  });
  assertNoConditionCycle(document.items, refusals);

  validateLayouts(document, itemById, refusals);
  validateRelations(document, domainIds, featureById, refusals);
  validateReleases(document, itemById, refusals);

  refusals.throwIfAny();
  return document;
}

/** How many ancestors a feature has in the document; `null` on a cycle or past the depth bound. */
function featureDepth(id: string, byId: ReadonlyMap<string, { parentFeatureId?: string | undefined }>): number | null {
  let depth = 0;
  let parent = byId.get(id)?.parentFeatureId;
  while (parent !== undefined) {
    if (parent === id || depth >= INTENT_FEATURE_MAX_DEPTH) return null;
    depth += 1;
    parent = byId.get(parent)?.parentFeatureId;
  }
  return depth;
}

function uniqueIds<T extends { id: string }>(
  rows: readonly T[],
  path: string[],
  label: string,
  refusals: Refusals,
): Set<string> {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (seen.has(row.id))
      refusals.add(IntentErrorCode.SchemaViolation, `${label} id '${row.id}' appears twice`, [...path, index, 'id']);
    seen.add(row.id);
  });
  return seen;
}

/**
 * Replacement pointers as review leaves them. A superseded item names the item
 * that replaced it, which is accepted — or itself superseded later, so chains
 * X → S → T keep every link. `proposedSuccessorOfId` names a predecessor of the
 * same kind: an accepted one for a waiting candidate, a superseded one for an
 * item that replaced it, and any one for a rejected proposal.
 */
function validateSupersession(
  item: DocumentItem,
  at: (string | number)[],
  itemById: ReadonlyMap<string, DocumentItem>,
  refusals: Refusals,
): void {
  if (item.authority === 'superseded') {
    const successor = item.supersededById ? itemById.get(item.supersededById) : undefined;
    if (!item.supersededById) {
      refusals.add(IntentErrorCode.SchemaViolation, 'a superseded item names its supersededById', [
        ...at,
        'supersededById',
      ]);
    } else if (
      !successor ||
      (successor.authority !== 'accepted' && successor.authority !== 'superseded') ||
      successor.kind !== item.kind
    ) {
      refusals.add(
        IntentErrorCode.SchemaViolation,
        `supersededById '${item.supersededById}' must be an accepted or superseded ${item.kind} in the document`,
        [...at, 'supersededById'],
      );
    } else if (successor.proposedSuccessorOfId !== item.id) {
      refusals.add(
        IntentErrorCode.SchemaViolation,
        `the successor '${successor.id}' must name '${item.id}' in proposedSuccessorOfId`,
        [...at, 'supersededById'],
      );
    }
  } else if (item.supersededById !== undefined) {
    refusals.add(IntentErrorCode.SchemaViolation, 'only a superseded item carries supersededById', [
      ...at,
      'supersededById',
    ]);
  }

  if (item.proposedSuccessorOfId === undefined) return;
  const predecessor = itemById.get(item.proposedSuccessorOfId);
  const expected: readonly DocumentItem['authority'][] =
    item.authority === 'candidate'
      ? ['accepted']
      : item.authority === 'rejected'
        ? ['accepted', 'superseded', 'rejected', 'candidate']
        : ['superseded'];
  if (
    item.proposedSuccessorOfId === item.id ||
    !predecessor ||
    predecessor.kind !== item.kind ||
    !expected.includes(predecessor.authority)
  ) {
    refusals.add(
      IntentErrorCode.SchemaViolation,
      `proposedSuccessorOfId '${item.proposedSuccessorOfId}' must be a ${expected.join(' or ')} ${item.kind} in the document`,
      [...at, 'proposedSuccessorOfId'],
    );
  }
}

/** `{item}` clauses form a graph; a cycle would make applicability undefined. */
function assertNoConditionCycle(items: readonly DocumentItem[], refusals: Refusals): void {
  const edges = new Map<string, string[]>();
  for (const item of items) {
    edges.set(
      item.id,
      (item.appliesWhen ?? []).flatMap((clause) => ('item' in clause ? [clause.item] : [])),
    );
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'visiting') return true;
    state.set(id, 'visiting');
    const cyclic = (edges.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  items.forEach((item, index) => {
    if (state.has(item.id)) return;
    if (visit(item.id)) {
      refusals.add(IntentErrorCode.SchemaViolation, `item conditions form a cycle through '${item.id}'`, [
        'items',
        index,
        'appliesWhen',
      ]);
    }
  });
}

/** Every item slot names an item attached to that node, and no item is placed twice. */
function validateLayouts(
  document: CloudIntentWorkspaceDocumentV1,
  itemById: ReadonlyMap<string, DocumentItem>,
  refusals: Refusals,
): void {
  const placed = new Set<string>();
  const check = (kind: 'domain' | 'feature', id: string, layout: unknown[] | undefined, path: (string | number)[]) => {
    (layout ?? []).forEach((block, index) => {
      if (!('item' in (block as object))) return;
      const itemId = (block as { item: string }).item;
      const item = itemById.get(itemId);
      const attached =
        kind === 'feature' ? item?.featureId === id : item?.featureId === undefined && item?.domainId === id;
      if (!attached) {
        refusals.add(
          IntentErrorCode.ItemNotFound,
          `layout places '${itemId}', which is not an item of ${kind} '${id}'`,
          [...path, 'layout', index, 'item'],
        );
      } else if (placed.has(itemId)) {
        refusals.add(IntentErrorCode.SchemaViolation, `layout places '${itemId}' twice`, [
          ...path,
          'layout',
          index,
          'item',
        ]);
      }
      placed.add(itemId);
    });
  };
  document.domains.forEach((domain, index) => check('domain', domain.id, domain.layout, ['domains', index]));
  document.features.forEach((feature, index) => check('feature', feature.id, feature.layout, ['features', index]));
}

function validateRelations(
  document: CloudIntentWorkspaceDocumentV1,
  domainIds: ReadonlySet<string>,
  featureById: ReadonlyMap<string, unknown>,
  refusals: Refusals,
): void {
  const seen = new Set<string>();
  (document.relations ?? []).forEach((relation, index) => {
    for (const end of ['from', 'to'] as const) {
      const node = relation[end];
      const exists = node.kind === 'domain' ? domainIds.has(node.id) : featureById.has(node.id);
      if (!exists) {
        refusals.add(
          node.kind === 'domain' ? IntentErrorCode.DomainNotFound : IntentErrorCode.FeatureNotFound,
          `relation names undeclared ${node.kind} '${node.id}'`,
          ['relations', index, end, 'id'],
        );
      }
    }
    if (relation.from.kind === relation.to.kind && relation.from.id === relation.to.id) {
      refusals.add(IntentErrorCode.NodeRelationSelf, 'A relation must join two different nodes', [
        'relations',
        index,
        'to',
      ]);
      return;
    }
    const [from, to] = canonicalRelationEndpoints(relation.from, relation.to);
    const key = `${from.kind}:${from.id}|${to.kind}:${to.id}`;
    if (seen.has(key)) {
      refusals.add(IntentErrorCode.SchemaViolation, 'the same two nodes are related twice', ['relations', index]);
    }
    seen.add(key);
  });
}

function validateReleases(
  document: CloudIntentWorkspaceDocumentV1,
  itemById: ReadonlyMap<string, DocumentItem>,
  refusals: Refusals,
): void {
  const baseline = new Set<string>();
  document.releases?.baseline?.itemIds.forEach((id, index) => {
    const item = itemById.get(id);
    if (baseline.has(id))
      refusals.add(IntentErrorCode.ReleaseConflictingItems, `'${id}' is listed twice`, [
        'releases',
        'baseline',
        'itemIds',
        index,
      ]);
    baseline.add(id);
    if (!item || (item.authority !== 'accepted' && item.authority !== 'superseded')) {
      refusals.add(
        IntentErrorCode.ReleaseItemNotReleasable,
        `'${id}' must be an accepted or superseded item in the document`,
        ['releases', 'baseline', 'itemIds', index],
      );
    }
  });
  const planned = new Set<string>();
  document.releases?.plans?.forEach((plan, index) => {
    const item = itemById.get(plan.itemId);
    if (!item || item.authority !== 'accepted' || baseline.has(plan.itemId) || planned.has(plan.itemId)) {
      refusals.add(
        IntentErrorCode.PlanNotPlannable,
        `'${plan.itemId}' must be an accepted item that is neither in the baseline nor planned twice`,
        ['releases', 'plans', index, 'itemId'],
      );
    }
    planned.add(plan.itemId);
  });
}

/** A bounded idempotency key for one derived release event of this import. */
function derivedKey(importKey: string, suffix: string): string {
  return `ws-import-${createHash('sha256').update(`${importKey}\0${suffix}`).digest('hex').slice(0, 40)}`;
}

@Injectable()
export class IntentWorkspaceImportService {
  constructor(private readonly prisma: PrismaService) {}

  async import(
    workspaceId: string,
    actor: IntentActor,
    input: ImportIntentWorkspaceInput,
  ): Promise<CloudIntentWorkspaceImportResultV1> {
    const document = validateWorkspaceDocument(input.document);
    return runIntentMutation<CloudIntentWorkspaceImportResultV1>(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.WorkspaceImport,
        idempotencyKey: input.idempotencyKey,
        request: { document: input.document },
        // Same budget and isolation as the overlay import, for the same reason:
        // the emptiness check is a read a later write depends on.
        transaction: {
          timeout: 120_000,
          maxWait: 15_000,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      },
      async (tx) => this.apply(tx, workspaceId, actor, input.idempotencyKey, document),
    );
  }

  private async apply(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    importKey: string,
    document: CloudIntentWorkspaceDocumentV1,
  ): Promise<{ response: CloudIntentWorkspaceImportResultV1; audits: IntentAuditRecord[] }> {
    assertWorkspaceIntentEmpty(await readIntentContentCounts(tx, workspaceId));
    const audits: IntentAuditRecord[] = [];
    await this.writeTree(tx, workspaceId, actor, document, audits);
    const relationCount = await this.writeRelations(tx, workspaceId, actor, document, audits);
    const sourceCount = await this.writeItems(tx, workspaceId, actor, document, audits);
    const releaseHeadSeq = await this.writeReleases(tx, workspaceId, actor, importKey, document);

    const items = { accepted: 0, candidate: 0, superseded: 0, rejected: 0 };
    for (const item of document.items) items[item.authority] += 1;
    return {
      response: {
        formatVersion: CLOUD_INTENT_WORKSPACE_FORMAT_VERSION,
        workspaceId,
        source: document.source,
        counts: {
          domains: document.domains.length,
          features: document.features.length,
          dimensions: document.dimensions?.length ?? 0,
          relations: relationCount,
          items,
          sources: sourceCount,
          baselineItems: document.releases?.baseline?.itemIds.length ?? 0,
          plans: document.releases?.plans?.length ?? 0,
        },
        releaseHeadSeq,
      },
      audits,
    };
  }

  /** Dimensions, domains and features, with their audit rows. */
  private async writeTree(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    document: CloudIntentWorkspaceDocumentV1,
    audits: IntentAuditRecord[],
  ): Promise<void> {
    const created = { createdBy: actor.id };
    await createIntentRowsChunked(
      tx.intentDimension,
      (document.dimensions ?? []).map((dimension) => ({
        workspaceId,
        id: dimension.id,
        title: dimension.title,
        values: dimension.values as unknown as Prisma.InputJsonValue,
        multi: dimension.multi,
        ...created,
        updatedBy: actor.id,
      })),
    );
    await createIntentRowsChunked(
      tx.intentDomain,
      document.domains.map((domain) => ({
        workspaceId,
        id: domain.id,
        title: domain.title,
        statement: domain.statement ?? '',
        ...treeConditionsData(domain.appliesWhen),
        ...layoutData(domain.layout),
        ...(domain.archived ? { archived: true } : {}),
        ...created,
        updatedBy: actor.id,
      })),
    );
    // Parents first: rows are inserted in chunks and the parent key is checked per row.
    const featureById = new Map(document.features.map((feature) => [feature.id, feature]));
    const byDepth = [...document.features].sort(
      (a, b) => (featureDepth(a.id, featureById) ?? 0) - (featureDepth(b.id, featureById) ?? 0),
    );
    await createIntentRowsChunked(
      tx.intentFeature,
      byDepth.map((feature) => ({
        workspaceId,
        id: feature.id,
        domainId: feature.domainId,
        ...(feature.parentFeatureId ? { parentFeatureId: feature.parentFeatureId } : {}),
        title: feature.title,
        statement: feature.statement ?? '',
        ...treeConditionsData(feature.appliesWhen),
        ...layoutData(feature.layout),
        ...(feature.archived ? { archived: true } : {}),
        ...created,
        updatedBy: actor.id,
      })),
    );
    for (const dimension of document.dimensions ?? []) {
      audits.push({
        entityKind: IntentAuditEntityKind.dimension,
        entityId: dimension.id,
        operation: IntentAuditOperation.Create,
        after: { title: dimension.title },
      });
    }
    for (const domain of document.domains) {
      audits.push({
        entityKind: IntentAuditEntityKind.domain,
        entityId: domain.id,
        operation: IntentAuditOperation.Create,
        after: { title: domain.title },
      });
    }
    for (const feature of document.features) {
      audits.push({
        entityKind: IntentAuditEntityKind.feature,
        entityId: feature.id,
        operation: IntentAuditOperation.Create,
        after: { domainId: feature.domainId, title: feature.title },
      });
    }
  }

  /** Node relations, stored once per unordered pair. Returns how many were written. */
  private async writeRelations(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    document: CloudIntentWorkspaceDocumentV1,
    audits: IntentAuditRecord[],
  ): Promise<number> {
    const created = { createdBy: actor.id };
    const relations = (document.relations ?? []).map((relation) => {
      const [from, to] = canonicalRelationEndpoints(relation.from, relation.to);
      return { from, to, why: relation.why };
    });
    await createIntentRowsChunked(
      tx.intentNodeRelation,
      relations.map((relation) => ({
        workspaceId,
        fromKind: relation.from.kind as IntentNodeKind,
        fromId: relation.from.id,
        toKind: relation.to.kind as IntentNodeKind,
        toId: relation.to.id,
        why: relation.why,
        ...created,
      })),
    );
    for (const relation of relations) {
      audits.push({
        entityKind: IntentAuditEntityKind.node_relation,
        entityId: relationEntityId(relation.from, relation.to),
        operation: IntentAuditOperation.Create,
        after: { why: relation.why },
      });
    }
    return relations.length;
  }

  /** Items, their replacement pointers, sources and arrival transitions. Returns the source count. */
  private async writeItems(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    document: CloudIntentWorkspaceDocumentV1,
    audits: IntentAuditRecord[],
  ): Promise<number> {
    const created = { createdBy: actor.id };
    const featureDomain = new Map(document.features.map((feature) => [feature.id, feature.domainId]));
    const itemRows: Prisma.IntentItemCreateManyInput[] = document.items.map((item) => ({
      workspaceId,
      id: item.id,
      kind: item.kind as IntentItemKind,
      domainId: item.featureId ? (featureDomain.get(item.featureId) as string) : (item.domainId ?? null),
      featureId: item.featureId ?? null,
      title: item.title,
      statement: item.statement,
      payload: item.payload === undefined ? Prisma.DbNull : (item.payload as Prisma.InputJsonValue),
      appliesWhen: item.appliesWhen === undefined ? Prisma.DbNull : (item.appliesWhen as Prisma.InputJsonValue),
      rationale: item.rationale ?? null,
      body: item.body === undefined ? Prisma.DbNull : (item.body as Prisma.InputJsonValue),
      authority: item.authority as IntentItemAuthority,
      // Pointers are written after every row exists: both are self-referencing FKs.
      ...created,
      updatedBy: actor.id,
    }));
    await createIntentRowsChunked(tx.intentItem, itemRows);
    for (const item of document.items) {
      if (item.proposedSuccessorOfId === undefined && item.supersededById === undefined) continue;
      await tx.intentItem.update({
        where: { workspaceId_id: { workspaceId, id: item.id } },
        data: {
          proposedSuccessorOfId: item.proposedSuccessorOfId ?? null,
          supersededById: item.supersededById ?? null,
        },
      });
    }

    const sourceCount = await createIntentRowsChunked(
      tx.intentItemSource,
      document.items.flatMap((item) =>
        item.sources.map((source) => ({
          workspaceId,
          itemId: item.id,
          kind: source.kind,
          ref: source.ref,
          localId: source.localId,
          revision: source.revision ?? null,
          locator: source.locator ?? null,
          title: source.title ?? null,
          url: source.url ?? null,
        })),
      ),
    );
    await createIntentRowsChunked(
      tx.intentAuthorityTransition,
      document.items.map((item) => ({
        workspaceId,
        itemId: item.id,
        fromAuthority: null,
        toAuthority: item.authority as IntentItemAuthority,
        actorId: actor.id,
        actorRole: actor.role,
        reason: `Imported from ${document.source.ref}.`,
        sourceKind: IntentAuthoritySourceKind.import,
        sourceRef: document.source.ref,
        sourceLocalId: item.id,
        sourceRevision: document.source.revision,
      })),
    );
    for (const item of document.items) {
      audits.push({
        entityKind: IntentAuditEntityKind.item,
        entityId: item.id,
        operation: IntentAuditOperation.Create,
        after: { kind: item.kind, authority: item.authority, featureId: item.featureId ?? null },
      });
    }
    return sourceCount;
  }

  /**
   * The events `intent_release` would write into an empty ledger: a baseline
   * (seq 1) when the document names one, then one plan per planned item. The
   * event `data` has exactly the shape a maintainer record produces, so the
   * fold, previews and history read them like any other evidence.
   */
  private async writeReleases(
    tx: IntentTransaction,
    workspaceId: string,
    actor: IntentActor,
    importKey: string,
    document: CloudIntentWorkspaceDocumentV1,
  ): Promise<number> {
    const events: ReleaseEvent[] = [];
    const recordedAt = new Date();
    const itemById = new Map(document.items.map((item) => [item.id, item]));
    const rows: Prisma.IntentReleaseEventCreateManyInput[] = [];
    // Only a delivery event moves the current release; replaying the ledger on every
    // plan made a large import quadratic in its plans.
    let currentRelease: ReturnType<typeof foldIntentReleases>['currentRelease'] = null;

    const push = (
      kind: ReleaseEvent['kind'],
      data: ReleaseEvent['data'],
      reason: string,
      key: string,
      request: unknown,
    ) => {
      const seq = events.length + 1;
      const event: ReleaseEvent = { seq, kind, data, recordedBy: actor.id, recordedAt: recordedAt.toISOString() };
      events.push(event);
      if (kind !== 'plan') currentRelease = foldIntentReleases(events).currentRelease;
      rows.push({
        workspaceId,
        seq,
        kind,
        idempotencyKey: key,
        requestHash: hashIntentRequest(IntentOperation.ReleaseEvent, request),
        recordedBy: actor.id,
        recordedAt,
        reason,
        deliveredRef: data.deliveredRef ?? null,
        data: data as Prisma.InputJsonValue,
        response: {
          event: { ...event, reason },
          headSeq: seq,
          currentReleaseSeq: currentRelease?.seq ?? null,
          currentRelease,
        } as unknown as Prisma.InputJsonValue,
      });
    };

    const baseline = document.releases?.baseline;
    if (baseline) {
      const included = [...baseline.itemIds].sort();
      const contentHashes = Object.fromEntries(
        included.map((id) => {
          const item = itemById.get(id) as DocumentItem;
          return [
            id,
            releaseContentHash({
              kind: item.kind,
              title: item.title,
              statement: item.statement,
              rationale: item.rationale ?? null,
              payload: item.payload ?? null,
              appliesWhen: item.appliesWhen,
              body: item.body,
            }),
          ];
        }),
      );
      const data = {
        deliveredRef: baseline.deliveredRef,
        included,
        retired: [],
        ancestors: [],
        contentHashes,
        actorKind: ReleaseActorKind.Maintainer,
      };
      push('baseline', data, BASELINE_REASON, derivedKey(importKey, 'baseline'), { kind: 'baseline', ...data });
    }
    for (const plan of document.releases?.plans ?? []) {
      const data = { itemId: plan.itemId, actorKind: ReleaseActorKind.Maintainer };
      push('plan', data, plan.reason ?? PLAN_REASON, derivedKey(importKey, `plan:${plan.itemId}`), {
        kind: 'plan',
        ...data,
      });
    }
    await createIntentRowsChunked(tx.intentReleaseEvent, rows);
    return events.length;
  }
}
