/**
 * The agent CONTEXT read (spec §7): selectors over rows, bounded, with its
 * trust markers attached.
 *
 * This is the surface a session hands off from — ids plus versions plus graph
 * provenance — and the one a reviewer re-fetches before deciding, so three
 * properties are load-bearing and are asserted rather than assumed:
 *
 * 1. SEMANTIC PARITY with the local overlay read. Selector precedence, the
 *    present-but-empty rule, the enclosing-anchor rule, the conjunctive-then-
 *    disjunctive lexical fallback, authority ordering, and error-not-empty all
 *    come from `intent-context.select.ts`, which is a port of core's `query.ts`.
 * 2. EVERY ITEM CARRIES ITS `version`. It is the token a reviewer hands back
 *    (spec §5), so a version change between handoff and review is detectable.
 * 3. GRAPH UNAVAILABILITY DEGRADES, NEVER ERRORS (§6.3). Attachment-based
 *    answers keep working, anchor-derived ones go empty, and the response says
 *    so with `evidence.available: false` plus a remediation.
 *
 * It is deliberately a SIBLING of `IntentItemService`, not an extension of it:
 * that service is the cheap browse index over the whole workspace, while this
 * one takes selectors, may lease the graph, and returns payloads. Keeping them
 * apart is what stops the cheap list from acquiring the expensive read's cost.
 */
import { readReleaseSnapshot } from './intent-release.service.js';
import type { ReleaseSnapshot } from './intent-release.fold.js';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ConditionLevel,
  composeEffectiveConditions,
  ContextMatchState,
  INTENT_ANCHOR_WARNING,
  IntentKind,
  RegistryIssueCode,
  evaluateEffectiveConditions,
  resolveVariants,
  validateContext,
  type ContextCondition,
  type EffectiveConditionsEvaluation,
  type IntentAuthority,
  type IntentContext,
  type IntentDimension,
  type IntentDimensionValue,
  type RuleVariant,
  type VersionedAnchorNodeType,
} from '@coredoc/core';
import type { AnchorEvidence } from '@coredoc/db';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type IntentItemAuthority, type IntentItemKind } from '../../generated/prisma/client.js';
import {
  IntentDerivationLimit,
  type DerivableFeature,
  type DerivableIntentItem,
  type FeatureSeedRef,
  type IntentDerivationDegradation,
  type IntentNodeDerivationResult,
} from './derivation/derivation-contract.js';
import { IntentDerivationService } from './derivation/intent-derivation.service.js';
import { IntentCursorScope, decodeIntentCursor, encodeIntentCursor } from './intent-cursor.js';
import {
  INTENT_CONTEXT_READ_LIMITS,
  IntentContextMatchReason,
  IntentContextMode,
  intentQueryTokens,
  type IntentContextRequest,
  type IntentContextScope,
} from './intent-context.operations.js';
import {
  AUTHORITY_RANK,
  attachmentReason,
  compareFallbackMatches,
  compareMatches,
  expandNodeIds,
  PATH_SCOPED_NODE_KINDS,
  fileMemberLikePatterns,
  nodeSelectionTruncated,
  graphRepoHashOfNodeId,
  hasSelector,
  likePattern,
  mergeFeatureCandidates,
  mergeDerivationCandidates,
  mergeMatches,
  reasonForDerivedHit,
  type SelectedMatch,
  sourceRefMatchSets,
} from './intent-context.select.js';
import { readIntentPendingReview } from './intent-review-queue.service.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';

/** Effectivity plus every per-repo delivery (BR-5); `deliveries` is omitted when there are none. */
function releaseFacts(release: ReleaseSnapshot, id: string) {
  const deliveries = release.deliveriesOf(id);
  return { effectivity: release.effectivity(id), ...(deliveries.length ? { deliveries } : {}) };
}

/**
 * The evidence index key: an anchor identifies itself by item, repository, and
 * node. `\n` cannot appear in a slug id or a repo key, so the join is unambiguous.
 */
function evidenceKey(itemId: string, repoKey: string, nodeId: string): string {
  return `${itemId}\n${repoKey}\n${nodeId}`;
}

/** Row shape of the id-selection queries. */
interface CandidateIdRow {
  id: string;
  authorityRank: number;
  hits?: number;
}

/** Everything a returned item needs, read once per response. */
interface HydratedItem {
  id: string;
  kind: IntentItemKind;
  title: string;
  statement: string;
  rationale: string | null;
  payload: unknown;
  appliesWhen: unknown;
  domain: { appliesWhen: unknown } | null;
  feature: { appliesWhen: unknown } | null;
  authority: IntentItemAuthority;
  version: number;
  domainId: string | null;
  featureId: string | null;
  proposedSuccessorOfId: string | null;
  supersededById: string | null;
  updatedAt: Date;
  sources: Array<{
    kind: string;
    ref: string;
    localId: string;
    revision: string | null;
    locator: string | null;
    title: string | null;
    url: string | null;
  }>;
  anchors: Array<{
    repoKey: string;
    nodeId: string;
    nodeType: string;
    capturedVersionedId: string;
    rationale: string | null;
    source: 'ci' | 'manual';
  }>;
}

type EffectiveContextRequest = IntentContextRequest & { effectiveItemIds?: string[] };

/** A validated reader context and the condition evaluation of every candidate it has seen. */
interface ContextFilter {
  context: IntentContext;
  evaluations: Map<string, EffectiveConditionsEvaluation>;
}

/** A short stable digest of a reader context: sorted keys, sorted list values. */
const contextDigest = (context: IntentContext): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(context)
          .sort()
          .map((key) => {
            const value = context[key] as string | string[];
            return [key, Array.isArray(value) ? [...value].sort() : value];
          }),
      ),
    )
    .digest('base64url')
    .slice(0, 16);

/** Stored `applies_when`: `null` is an unconditioned item. */
const conditionsOf = (value: unknown): ContextCondition[] | undefined =>
  Array.isArray(value) ? (value as ContextCondition[]) : undefined;

/** Stored tree `applies_when`; an empty list is treated as none. */
const treeConditionsOf = (node: { appliesWhen: unknown } | null): ContextCondition[] | undefined => {
  const conditions = conditionsOf(node?.appliesWhen);
  return conditions && conditions.length > 0 ? conditions : undefined;
};

/** Relation selects that load the attachment's tree conditions, one batched query per level. */
const TREE_CONDITIONS_SELECT = {
  domain: { select: { appliesWhen: true } },
  feature: { select: { appliesWhen: true } },
} as const;

/**
 * A list entry's condition summary for a browse row: the item's own clauses,
 * whether a tree level adds any, and a business rule's variant count. Absent
 * when all three are empty, so an unconditioned entry keeps its bytes.
 */
export function listConditionsOf(row: {
  kind: string;
  payload: unknown;
  appliesWhen: unknown;
  domain: { appliesWhen: unknown } | null;
  feature: { appliesWhen: unknown } | null;
}) {
  const own = conditionsOf(row.appliesWhen) ?? [];
  const inherited = treeConditionsOf(row.domain) !== undefined || treeConditionsOf(row.feature) !== undefined;
  const variants = (row.payload as { variants?: unknown } | null)?.variants;
  const variantCount = row.kind === IntentKind.BusinessRule && Array.isArray(variants) ? variants.length : 0;
  if (own.length === 0 && !inherited && variantCount === 0) return undefined;
  return {
    ...(own.length > 0 ? { own } : {}),
    ...(inherited ? { inherited: true } : {}),
    ...(variantCount > 0 ? { variants: variantCount } : {}),
  };
}

@Injectable()
export class IntentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly derivation: IntentDerivationService,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  async read(workspaceId: string, request: EffectiveContextRequest) {
    const release = request.effectivity ? await readReleaseSnapshot(this.prisma, workspaceId) : undefined;
    if (release) request = { ...request, effectiveItemIds: release.effectiveIds };
    const scope = await this.resolveScope(workspaceId, request);
    const dimensions = request.context ? await this.resolveContext(workspaceId, request.context) : undefined;
    const filter = request.context ? { context: request.context, evaluations: new Map() } : undefined;
    const tokens = intentQueryTokens(request.query);
    const exactIds = await this.selectExact(workspaceId, request);
    const sourced = await this.selectBySource(workspaceId, request, exactIds);
    // The cap's extra row is the truncation evidence; a context may filter it away, the bound it proves stays.
    const sourceTruncated = sourced.length > INTENT_CONTEXT_READ_LIMITS.sourceItems;
    const exact = [...exactIds, ...sourced];
    const excludeIds = exact.map((match) => match.id);

    const modeAnswer =
      request.mode === IntentContextMode.List
        ? await this.readList(workspaceId, request, scope, tokens, exact, excludeIds, filter)
        : await this.readContext(workspaceId, request, scope, tokens, exact, excludeIds, filter);
    const isExcluded = (id: string) => filter?.evaluations.get(id)?.state === ContextMatchState.Excluded;
    const contextExcluded = filter ? [...filter.evaluations.keys()].filter(isExcluded).length : 0;
    // Items the caller named (exact id or source ref) must not vanish silently.
    const excludedIntentIds = [...new Set(excludeIds.filter(isExcluded))].sort();
    const notSupplied = filter ? undefined : await this.contextNotSupplied(workspaceId, modeAnswer);
    const answer = filter
      ? {
          ...modeAnswer,
          ...(sourceTruncated ? { truncated: true } : {}),
          // The registry rides only the `{}` call, the documented way to ask for it.
          ...(dimensions && Object.keys(request.context ?? {}).length === 0 ? { dimensions } : {}),
          ...(contextExcluded > 0 ? { contextExcluded } : {}),
          ...(excludedIntentIds.length > 0 ? { excludedIntentIds } : {}),
        }
      : notSupplied
        ? { ...modeAnswer, contextNotSupplied: notSupplied }
        : modeAnswer;

    // EVERY answer carries the waiting-candidate summary (§11, issue v1.1-01):
    // a proposed candidate was otherwise invisible until a human happened to
    // open the review tab, so the surface an agent already reads on every task
    // is where it learns there is something to nudge the maintainer about. It
    // is attached here rather than inside the two modes because it depends on
    // neither the selectors nor the graph — one workspace aggregate, one place.
    const pendingReview = await readIntentPendingReview(this.prisma, workspaceId);
    const pendingHandoffWhere: Prisma.IntentHandoffWhereInput = {
      workspaceId,
      OR: [
        { mappingState: { in: ['pending', 'needs_attention'] } },
        { deliveryState: { in: ['pending', 'needs_attention'] } },
      ],
    };
    // Compact by default in BOTH modes: the same ten operations repeated on every
    // task read were noise. Counts say whether to look; includeDiagnostics lists
    // the operation ids and the review breakdown when an agent must repair one.
    let handoffFreshness: object;
    let review: object = pendingReview;
    if (!request.includeDiagnostics) {
      const { waiting, oldestWaitingAt, hasReplacementCandidate } = pendingReview;
      // needs_attention wins over pending: an agent must repair it, while
      // pending alone retries automatically. It is a subset of the open set.
      const [open, needsAttention] = await Promise.all([
        this.prisma.intentHandoff.count({ where: pendingHandoffWhere }),
        this.prisma.intentHandoff.count({
          where: {
            workspaceId,
            OR: [{ mappingState: 'needs_attention' }, { deliveryState: 'needs_attention' }],
          },
        }),
      ]);
      // The review breakdown is small and bounded; only the list index trims it.
      if (request.mode === IntentContextMode.List) review = { waiting, oldestWaitingAt, hasReplacementCandidate };
      handoffFreshness = { pending: open - needsAttention, needsAttention };
    } else {
      const pendingHandoffs = await this.prisma.intentHandoff.findMany({
        where: pendingHandoffWhere,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 11,
        select: {
          id: true,
          repoKey: true,
          prNumber: true,
          mappingState: true,
          mappingReason: true,
          deliveryState: true,
          deliveryReason: true,
        },
      });
      handoffFreshness = { operations: pendingHandoffs.slice(0, 10), truncated: pendingHandoffs.length > 10 };
    }

    if (!release) return { ...answer, handoffFreshness, pendingReview: review };
    const label = <T extends { id: string }>(item: T) => ({ ...item, ...releaseFacts(release, item.id) });
    if ('matches' in answer) {
      return {
        ...answer,
        pendingReview: review,
        handoffFreshness,
        currentRelease: release.currentRelease,
        matches: answer.matches.map((item) => ({
          ...label(item),
          ...(item.proposedSuccessorOfId || item.supersededById
            ? {
                relation: {
                  ...(item.proposedSuccessorOfId ? { replaces: item.proposedSuccessorOfId } : {}),
                  ...(item.supersededById ? { replacedBy: item.supersededById } : {}),
                },
              }
            : {}),
        })),
      };
    }
    return {
      ...answer,
      handoffFreshness,
      pendingReview: review,
      currentRelease: release.currentRelease,
      entries: answer.entries.map(label),
    };
  }

  /**
   * A reader without `context` gets conditioned rules unfiltered, every variant
   * included; say so when the workspace declares dimensions and the answer holds
   * such an item. Absent otherwise, so a dimension-free workspace reads the same bytes.
   */
  private async contextNotSupplied(
    workspaceId: string,
    answer: { matches: { id: string }[] } | { entries: { id: string }[] },
  ) {
    const dimensions = await this.prisma.intentDimension.findMany({
      where: { workspaceId, archived: false },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (dimensions.length === 0) return undefined;
    const ids = 'matches' in answer ? answer.matches.map((match) => match.id) : answer.entries.map((entry) => entry.id);
    if (ids.length === 0) return undefined;
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { kind: true, payload: true, appliesWhen: true, ...TREE_CONDITIONS_SELECT },
    });
    const variantsOf = (row: (typeof rows)[number]) =>
      row.kind === IntentKind.BusinessRule
        ? ((row.payload as { variants?: RuleVariant[] } | null)?.variants ?? [])
        : [];
    const conditioned = rows.filter(
      (row) =>
        (conditionsOf(row.appliesWhen)?.length ?? 0) > 0 ||
        treeConditionsOf(row.domain) !== undefined ||
        treeConditionsOf(row.feature) !== undefined ||
        variantsOf(row).length > 0,
    );
    if (conditioned.length === 0) return undefined;
    // Name only the dimensions these items' conditions use (own, inherited, variant `when`, and the
    // targets of `item` clauses, one level), so a reader is not nudged toward dimensions that change nothing here.
    const dimensionsOfClauses = (clauses: ContextCondition[] | undefined) =>
      (clauses ?? []).flatMap((clause) => ('dimension' in clause ? [clause.dimension] : []));
    const referencedIds = [
      ...new Set(
        conditioned.flatMap((row) =>
          (conditionsOf(row.appliesWhen) ?? []).flatMap((clause) => ('item' in clause ? [clause.item] : [])),
        ),
      ),
    ];
    const referenced =
      referencedIds.length > 0
        ? await this.prisma.intentItem.findMany({
            where: { workspaceId, id: { in: referencedIds } },
            select: { appliesWhen: true, ...TREE_CONDITIONS_SELECT },
          })
        : [];
    const used = new Set(
      [...conditioned, ...referenced].flatMap((row) => [
        ...dimensionsOfClauses(conditionsOf(row.appliesWhen)),
        ...dimensionsOfClauses(treeConditionsOf(row.domain)),
        ...dimensionsOfClauses(treeConditionsOf(row.feature)),
      ]),
    );
    for (const variant of conditioned.flatMap(variantsOf)) {
      for (const dimension of Object.keys(variant.when ?? {})) used.add(dimension);
    }
    return {
      conditionedItems: conditioned.length,
      dimensions: dimensions.map((dimension) => dimension.id).filter((id) => used.has(id)),
    };
  }

  /* ------------------------------------------------------------- scope --- */

  /**
   * Resolve `domain`/`feature` against the tree, refusing an undeclared one by
   * NAME.
   *
   * Core's rule, carried over: "no item is attached to `payments`" and "this
   * workspace has no `payments`" must not look alike, or a caller reads an empty
   * result as "no product intent applies here".
   */
  private async resolveScope(
    workspaceId: string,
    request: EffectiveContextRequest,
  ): Promise<IntentContextScope | undefined> {
    if (request.feature === undefined && request.domain === undefined) return undefined;

    if (request.feature !== undefined) {
      const feature = await this.prisma.intentFeature.findUnique({
        where: { workspaceId_id: { workspaceId, id: request.feature } },
        select: { id: true, domainId: true },
      });
      if (!feature) {
        const declared = await this.prisma.intentFeature.findMany({
          where: { workspaceId, archived: false },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: INTENT_CONTEXT_READ_LIMITS.namedValues,
        });
        throw intentStateError(
          IntentErrorCode.FeatureNotFound,
          `intent feature '${request.feature}' is not declared in this workspace; declared features: ${
            declared.map((row) => row.id).join(', ') || '<none declared>'
          }`,
          ['feature'],
        );
      }
      // Both given: they must agree. Preferring one would make the same request
      // mean two different things depending on which the reader looked at.
      if (request.domain !== undefined && request.domain !== feature.domainId) {
        throw intentStateError(
          IntentErrorCode.FeatureNotFound,
          `intent feature '${feature.id}' is in domain '${feature.domainId}', not '${request.domain}'`,
          ['feature'],
        );
      }
      return { domainId: feature.domainId, featureId: feature.id };
    }

    const domainId = request.domain as string;
    const domain = await this.prisma.intentDomain.findUnique({
      where: { workspaceId_id: { workspaceId, id: domainId } },
      select: { id: true },
    });
    if (!domain) {
      const declared = await this.prisma.intentDomain.findMany({
        where: { workspaceId, archived: false },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: INTENT_CONTEXT_READ_LIMITS.namedValues,
      });
      throw intentStateError(
        IntentErrorCode.DomainNotFound,
        `intent domain '${domainId}' is not declared in this workspace; declared domains: ${
          declared.map((row) => row.id).join(', ') || '<none declared>'
        }`,
        ['domain'],
      );
    }
    return { domainId, featureId: null };
  }

  /**
   * Validate a reader context against the registry, refusing an undeclared
   * dimension or value by NAME the way `resolveScope` refuses a domain: an
   * empty answer must never stand in for "this workspace has no `plan`".
   */
  private async resolveContext(workspaceId: string, context: IntentContext) {
    const rows = await this.prisma.intentDimension.findMany({
      where: { workspaceId, archived: false },
      select: { id: true, title: true, values: true, multi: true },
      orderBy: { id: 'asc' },
    });
    const dimensions: IntentDimension[] = rows.map((row) => ({
      ...row,
      values: row.values as unknown as IntentDimensionValue[],
    }));
    const [issue] = validateContext(context, dimensions);
    if (!issue) return dimensions;
    const path = issue.path.map(String);
    const declared = dimensions.find((dimension) => dimension.id === issue.dimension);
    const named = (ids: string[]) =>
      ids.slice(0, INTENT_CONTEXT_READ_LIMITS.namedValues).join(', ') || '<none declared>';
    if (issue.code === RegistryIssueCode.DimensionNotFound) {
      throw intentStateError(
        IntentErrorCode.DimensionNotFound,
        `intent dimension '${issue.dimension}' is not declared in this workspace; declared dimensions: ${named(
          dimensions.map((dimension) => dimension.id),
        )}`,
        path,
      );
    }
    if (issue.code === RegistryIssueCode.DimensionValueNotFound) {
      throw intentStateError(
        IntentErrorCode.DimensionValueNotFound,
        `intent dimension '${issue.dimension}' declares no value '${issue.value}'; declared values: ${named(
          declared?.values.map((value) => value.id) ?? [],
        )}`,
        path,
      );
    }
    throw intentStateError(
      IntentErrorCode.DimensionNotMulti,
      `intent dimension '${issue.dimension}' holds one value; pass a single value id, not a list`,
      path,
    );
  }

  /**
   * Drop the matches whose conditions are false for the context (BR-1),
   * recording every evaluation on `filter` for the response.
   *
   * Runs over the whole candidate window, BEFORE any `limit` slice: filtering
   * a sliced page would under-fill it with the excluded rows' slots. `item`
   * clauses resolve through one batched lookup of the referenced rows; the
   * domain and feature conditions each item inherits (BR-1) through one per level.
   */
  private async applyContext<T extends { id: string }>(
    workspaceId: string,
    filter: ContextFilter | undefined,
    matches: readonly T[],
  ): Promise<T[]> {
    if (!filter || matches.length === 0) return [...matches];
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: [...new Set(matches.map((match) => match.id))] } },
      select: { id: true, appliesWhen: true, ...TREE_CONDITIONS_SELECT },
    });
    const referenced = [
      ...new Set(
        rows.flatMap((row) =>
          (conditionsOf(row.appliesWhen) ?? []).flatMap((clause) => ('item' in clause ? [clause.item] : [])),
        ),
      ),
    ];
    const refs =
      referenced.length > 0
        ? await this.prisma.intentItem.findMany({
            where: { workspaceId, id: { in: referenced } },
            select: { id: true, authority: true, appliesWhen: true, ...TREE_CONDITIONS_SELECT },
          })
        : [];
    // A referenced item contributes its EFFECTIVE clauses (its domain + feature + own), still one level deep.
    const refById = new Map(
      refs.map((ref) => [
        ref.id,
        {
          authority: ref.authority as IntentAuthority,
          appliesWhen: composeEffectiveConditions({
            [ConditionLevel.Domain]: treeConditionsOf(ref.domain),
            [ConditionLevel.Feature]: treeConditionsOf(ref.feature),
            [ConditionLevel.Item]: conditionsOf(ref.appliesWhen),
          }),
        },
      ]),
    );
    for (const row of rows) {
      filter.evaluations.set(
        row.id,
        evaluateEffectiveConditions(
          {
            [ConditionLevel.Domain]: treeConditionsOf(row.domain),
            [ConditionLevel.Feature]: treeConditionsOf(row.feature),
            [ConditionLevel.Item]: conditionsOf(row.appliesWhen),
          },
          filter.context,
          (id) => refById.get(id),
        ),
      );
    }
    return matches.filter((match) => filter.evaluations.get(match.id)?.state !== ContextMatchState.Excluded);
  }

  /* ------------------------------------------------------------- exact --- */

  /**
   * Exact ids, in the order asked for.
   *
   * Exempt from the authority filter, from `kind`, and from the tree scope: an
   * exact routed lookup stays authoritative, and it is the ONLY path to a
   * rejected or superseded item (spec §5, core BR-8/BR-13). A requested id this
   * workspace does not hold is a MISS reported in `unknownIntentIds`, not an
   * error.
   */
  private async selectExact(workspaceId: string, request: EffectiveContextRequest): Promise<SelectedMatch[]> {
    const ids = request.intentIds ?? [];
    if (ids.length === 0) return [];
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, authority: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const matches: SelectedMatch[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      matches.push({
        id,
        authorityRank: AUTHORITY_RANK[row.authority],
        reason: IntentContextMatchReason.ExactId,
      });
    }
    return matches;
  }

  /**
   * Every item sourced at a requested ref (a Jira issue, a spec), added beside the
   * exact ids rather than filtering the other selectors: a developer reading
   * `{sourceRefs, task}` gets the whole story's intent plus whatever the task
   * fuses in. Authority follows the default read (accepted; candidates on opt-in);
   * rejected and superseded stay reachable by exact id only. One row past the cap
   * is kept on purpose: it is what makes both modes report `truncated` instead of
   * a full page that looks complete. Only `kind: issue` refs fold case.
   */
  private async selectBySource(
    workspaceId: string,
    request: EffectiveContextRequest,
    already: readonly SelectedMatch[],
  ): Promise<SelectedMatch[]> {
    if (!request.sourceRefs?.length) return [];
    const { exact, caseless } = sourceRefMatchSets(request.sourceRefs);
    const authorities = request.includeCandidates ? ['accepted', 'candidate'] : ['accepted'];
    const skip = already.map((match) => match.id);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authority: keyof typeof AUTHORITY_RANK }>>`
      SELECT i.id, i.authority::text AS authority FROM intent_items i
      WHERE i.workspace_id = ${workspaceId}::uuid
        AND i.authority::text = ANY(${authorities}::text[])
        ${skip.length ? Prisma.sql`AND i.id NOT IN (${Prisma.join(skip)})` : Prisma.empty}
        AND EXISTS (
          SELECT 1 FROM intent_item_sources s
          WHERE s.workspace_id = i.workspace_id AND s.item_id = i.id
            AND (s.ref = ANY(${exact}::text[]) OR (s.kind::text = 'issue' AND LOWER(s.ref) = ANY(${caseless}::text[])))
        )
      ORDER BY i.id
      LIMIT ${INTENT_CONTEXT_READ_LIMITS.sourceItems + 1}`;
    return rows
      .map((row) => ({
        id: row.id,
        authorityRank: AUTHORITY_RANK[row.authority],
        reason: IntentContextMatchReason.Source,
      }))
      .sort((a, b) => a.authorityRank - b.authorityRank || a.id.localeCompare(b.id));
  }

  private unknownIntentIds(request: EffectiveContextRequest, exact: readonly SelectedMatch[]): string[] {
    const found = new Set(exact.map((match) => match.id));
    return (request.intentIds ?? []).filter((id) => !found.has(id));
  }

  /* --------------------------------------------------------- predicates --- */

  /** The narrowing every DISCOVERED match passes: authority, kind, tree scope. */
  private discoveredWhere(
    workspaceId: string,
    request: EffectiveContextRequest,
    scope: IntentContextScope | undefined,
    excludeIds: readonly string[],
  ): Prisma.Sql[] {
    const parts: Prisma.Sql[] = [Prisma.sql`i.workspace_id = ${workspaceId}::uuid`];

    const authority = request.includeCandidates
      ? Prisma.sql`i.authority::text IN ('accepted', 'candidate')`
      : Prisma.sql`i.authority::text = 'accepted'`;
    // Include production evidence BEFORE relevance selection and truncation, never append
    // unrelated effective rules after a selector has already bounded its answer.
    parts.push(
      request.effectiveItemIds?.length
        ? Prisma.sql`(${authority} OR (i.authority::text = 'superseded' AND i.id = ANY(${request.effectiveItemIds}::text[])))`
        : authority,
    );
    if (request.kinds !== undefined) parts.push(Prisma.sql`i.kind::text = ANY(${request.kinds}::text[])`);
    if (excludeIds.length > 0) parts.push(Prisma.sql`i.id NOT IN (${Prisma.join([...excludeIds])})`);
    if (scope) {
      parts.push(
        scope.featureId === null
          ? // A domain scope reaches its own branch (its items and its features'
            // items, which carry the domain by the attachment FK) plus the
            // product root above it.
            Prisma.sql`(i.domain_id = ${scope.domainId} OR (i.domain_id IS NULL AND i.feature_id IS NULL))`
          : // A feature scope: the feature's own items, its domain's, and the
            // product root's — inheritance down the branch (§6.2).
            Prisma.sql`(i.feature_id = ${scope.featureId}
                        OR (i.feature_id IS NULL AND i.domain_id = ${scope.domainId})
                        OR (i.feature_id IS NULL AND i.domain_id IS NULL))`,
      );
    }
    return parts;
  }

  /** `0` for accepted, `1` for candidate — the ordering key, inline so it can also page. */
  private get rankExpression(): Prisma.Sql {
    return Prisma.sql`(CASE WHEN i.authority::text = 'accepted' THEN 0 ELSE 1 END)::int`;
  }

  private async selectIds(where: Prisma.Sql[], order: Prisma.Sql, take: number): Promise<CandidateIdRow[]> {
    return this.prisma.$queryRaw<CandidateIdRow[]>`
      SELECT i.id AS id, ${this.rankExpression} AS "authorityRank"
      FROM intent_items i
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${take}
    `;
  }

  /**
   * Lexical selection over title, statement, and rationale.
   *
   * `ILIKE '%token%'` is what the `pg_trgm` GIN indexes on `title` and
   * `statement` accelerate (migration 20260901102000); `rationale` rides in the
   * same disjunction unindexed, because this query path searches all three
   * fields and narrowing it to the two indexed ones would silently answer a
   * different question. The task path (`selectTaskText`) differs on purpose: it
   * uses rationale only for ranking (weight C) and gates on title or statement.
   * Tokens are parameterised and wildcard-escaped.
   */
  private tokenPredicate(token: string): Prisma.Sql {
    const pattern = likePattern(token);
    return Prisma.sql`(i.title ILIKE ${pattern} OR i.statement ILIKE ${pattern} OR COALESCE(i.rationale, '') ILIKE ${pattern})`;
  }

  private async selectLexical(
    where: Prisma.Sql[],
    tokens: readonly string[],
    take: number,
    allowFallback: boolean,
  ): Promise<{ rows: CandidateIdRow[]; fallback: boolean }> {
    // Conjunction first, for precision: every token must appear somewhere.
    const conjunctive = await this.selectIds(
      [...where, ...tokens.map((token) => this.tokenPredicate(token))],
      Prisma.sql`"authorityRank", i.id`,
      take,
    );
    if (conjunctive.length > 0 || tokens.length < 2 || !allowFallback) {
      return { rows: conjunctive, fallback: false };
    }

    // The disjunctive FALLBACK, from an EMPTY conjunctive result only, ranked by
    // how many tokens each item hit. A multi-word query that matched nothing
    // otherwise answers "this workspace has no product intent here", which is a
    // different and usually false statement (core's rule; never mixed).
    const hits = Prisma.join(
      tokens.map((token) => Prisma.sql`(CASE WHEN ${this.tokenPredicate(token)} THEN 1 ELSE 0 END)`),
      ' + ',
    );
    const anyToken = Prisma.sql`(${Prisma.join(
      tokens.map((token) => this.tokenPredicate(token)),
      ' OR ',
    )})`;
    const rows = await this.prisma.$queryRaw<CandidateIdRow[]>`
      SELECT i.id AS id, ${this.rankExpression} AS "authorityRank", (${hits})::int AS hits
      FROM intent_items i
      WHERE ${Prisma.join([...where, anyToken], ' AND ')}
      ORDER BY hits DESC, "authorityRank", i.id
      LIMIT ${take}
    `;
    return { rows, fallback: true };
  }

  /** Rank all lexical candidates before the bound; no alphabetical pre-scan. */
  private async selectTaskText(
    where: Prisma.Sql[],
    task: string,
    take: number,
    files: IntentContextRequest['files'],
  ): Promise<CandidateIdRow[]> {
    // A task may name calculateSettlementAmount instead of "settlement amount".
    // File basenames supply code vocabulary even before the file has a graph node;
    // directory names would add broad terms such as src/server to unrelated tasks.
    const inputs = [task, ...(files ?? []).map(({ path }) => (path.split('/').at(-1) ?? '').replace(/\.[^.]+$/u, ''))];
    const text = inputs
      .flatMap((input) => [
        input,
        input.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2'),
      ])
      .join(' ');
    // Preserve unsplit identifiers as well: a rule may refer to the exact symbol.
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (words.length === 0) return [];
    const query = Prisma.sql`to_tsquery('english', ${words.join(' | ')})`;
    const lexemes = Prisma.sql`tsvector_to_array(to_tsvector('english', ${words.join(' ')}))`;
    const title = Prisma.sql`to_tsvector('english', i.title)`;
    // A rationale-only hit or one incidental statement word must not fill a
    // task answer: the title matches any task word, or the statement shares at
    // least two task lexemes (one for a one-lexeme task). Exact IDs and
    // code-linked constraints bypass this predicate. Lexemes are intersected
    // as-is, never re-stemmed: Snowball is not idempotent (licens -> licen).
    const relevant = Prisma.sql`(${title} @@ ${query} OR cardinality(ARRAY(
      SELECT unnest(${lexemes})
      INTERSECT
      SELECT unnest(tsvector_to_array(to_tsvector('english', i.statement)))
    )) >= GREATEST(1, LEAST(2, cardinality(${lexemes}))))`;
    const document = Prisma.sql`(
      setweight(to_tsvector('english', i.title), 'A') ||
      setweight(to_tsvector('english', i.statement), 'B') ||
      setweight(to_tsvector('english', COALESCE(i.rationale, '')), 'C')
    )`;
    return this.prisma.$queryRaw<CandidateIdRow[]>`
      SELECT i.id AS id, ${this.rankExpression} AS "authorityRank"
      FROM intent_items i
      WHERE ${Prisma.join(where, ' AND ')} AND ${document} @@ ${query} AND ${relevant}
      ORDER BY "authorityRank", ts_rank(${document}, ${query}, 32) DESC, i.id
      LIMIT ${take}
    `;
  }

  /* ----------------------------------------------------------- node ids --- */

  /**
   * The node selector: stored anchors UNION graph-derived applicability.
   *
   * The two halves answer different questions and neither subsumes the other.
   * The anchor half is exact and needs no graph — including the enclosing-scope
   * expansion, which the graph cannot express (an item anchored on a class
   * governs a method inside it). The derived half is §6.2 run backwards: an
   * anchor the queried nodes CALL (the admin-guard case), and the items attached
   * to any feature whose area covers a queried node.
   */
  private async selectByNodeIds(
    workspaceId: string,
    request: EffectiveContextRequest,
    scope: IntentContextScope | undefined,
    where: Prisma.Sql[],
    nodeIds: readonly string[],
    /** Exact-id matches: outside the discovered set, but still owed evidence. */
    exactIds: readonly string[],
  ): Promise<{
    matches: SelectedMatch[];
    scanTruncated: boolean;
    derivation: IntentNodeDerivationResult;
    unresolvedNodeIds: string[];
    matchedFeatureIds: string[];
  }> {
    const scan = request.context
      ? INTENT_CONTEXT_READ_LIMITS.contextCandidateScan
      : INTENT_CONTEXT_READ_LIMITS.candidateScan;
    const expanded = expandNodeIds(nodeIds);
    // Match members inside the item query, so eligibility and distinct-item
    // ordering happen before the bound (many anchors must not consume its slots).
    const patterns = fileMemberLikePatterns(nodeIds);
    const memberAnchor =
      patterns.length > 0
        ? Prisma.sql`EXISTS (
          SELECT 1 FROM intent_anchors a
          WHERE a.disabled_at IS NULL AND a.workspace_id = i.workspace_id AND a.item_id = i.id
            AND a.node_id LIKE ANY (ARRAY[${Prisma.join(patterns)}])
            AND array_length(string_to_array(a.node_id, ':'), 1) = 4
            AND split_part(a.node_id, ':', 4) <> ''
            AND split_part(a.node_id, ':', 2) IN (${Prisma.join([...PATH_SCOPED_NODE_KINDS])})
        )`
        : Prisma.sql`FALSE`;
    const exactAnchor = Prisma.sql`EXISTS (
          SELECT 1 FROM intent_anchors a
          WHERE a.disabled_at IS NULL AND a.workspace_id = i.workspace_id AND a.item_id = i.id
            AND a.node_id IN (${Prisma.join(expanded)})
        )`;
    const anchored = await this.selectIds(
      [...where, Prisma.sql`(${exactAnchor} OR ${memberAnchor})`],
      Prisma.sql`"authorityRank", i.id`,
      scan + 1,
    );

    const { nodes, unresolvedNodeIds } = await this.resolveNodes(workspaceId, nodeIds);
    const derivationBound = INTENT_CONTEXT_READ_LIMITS.derivationItems;
    const queriedRepoKeys = [...new Set(nodes.map((node) => node.repoKey))];

    // The item set derivation is allowed to place, in the two shapes derivation
    // can actually match — never a flat page of the workspace.
    //
    // Every anchor-derived reason (anchor_in_area / anchor_called_by_area /
    // anchor_calls_area) starts from a STORED anchor, so an item with no anchor
    // in a queried repository cannot be placed that way however much budget it
    // is given. Reading the anchored set first is what makes the bound cut
    // anchored candidates rather than let unrelated rows crowd the one item the
    // caller asked about — the observed miss at workspace scale.
    const anchoredCandidates =
      queriedRepoKeys.length > 0
        ? await this.selectIds(
            [
              ...where,
              Prisma.sql`EXISTS (
                SELECT 1 FROM intent_anchors a
                WHERE a.disabled_at IS NULL AND a.workspace_id = i.workspace_id AND a.item_id = i.id
                  AND a.repo_key IN (${Prisma.join(queriedRepoKeys)})
              )`,
            ],
            Prisma.sql`"authorityRank", i.id`,
            derivationBound + 1,
          )
        : [];
    const features = await this.derivableFeatures(
      workspaceId,
      scope,
      nodes.map((node) => node.repoKey),
      expanded,
    );
    // Only a candidate feature's branch can contribute inherited intent.
    // Filter before the item bound: unrelated domains must not hide a feature's own rule.
    const featureIds = features.features.map((feature) => feature.id);
    const domainIds = [...new Set(features.features.map((feature) => feature.domainId))];
    const attachedCandidates =
      featureIds.length > 0
        ? await this.selectIds(
            [
              ...where,
              Prisma.sql`(i.feature_id IN (${Prisma.join(featureIds)}) OR
        (i.feature_id IS NULL AND (i.domain_id IS NULL OR i.domain_id IN (${Prisma.join(domainIds)}))))`,
            ],
            Prisma.sql`"authorityRank", i.id`,
            derivationBound + 1,
          )
        : [];
    const { rankById, truncated: candidateUnionTruncated } = mergeDerivationCandidates(
      [...anchoredCandidates, ...attachedCandidates],
      derivationBound,
    );
    // The exact-id matches ride along so ONE derivation call covers the anchor
    // evidence of everything this response can return; they take no part in the
    // selection below.
    const items = await this.derivableItems(workspaceId, [...rankById.keys(), ...exactIds]);
    const nodeDerivation = await this.derivation.deriveNodeContext(workspaceId, {
      nodes,
      items,
      features: features.features,
      observedCheckouts: request.observed,
    });
    // A cut feature page can hide a match, so it rides the result BOTH modes
    // report from rather than being dropped on the floor.
    const derivation: IntentNodeDerivationResult = features.truncated
      ? { ...nodeDerivation, truncated: true, limits: [...nodeDerivation.limits, IntentDerivationLimit.FeatureScan] }
      : nodeDerivation;

    const derived: SelectedMatch[] = [];
    for (const hit of derivation.applicable) {
      const authorityRank = rankById.get(hit.itemId);
      // An exact-id hit is not a candidate: its ExactId reason already
      // outranks anything derivation could say, so it is skipped here.
      if (authorityRank === undefined) continue;
      derived.push({
        id: hit.itemId,
        authorityRank,
        reason: reasonForDerivedHit(hit.reasons),
        derivedReasons: [...hit.reasons],
      });
    }

    return {
      matches: mergeMatches([
        ...anchored.slice(0, scan).map((row) => ({ ...row, reason: IntentContextMatchReason.NodeAnchor })),
        ...derived,
      ]),
      // Each candidate query reads one past its bound; report actual cuts.
      scanTruncated:
        candidateUnionTruncated ||
        nodeSelectionTruncated({
          anchoredRows: anchored.length,
          anchorScan: scan,
          anchoredCandidateRows: anchoredCandidates.length,
          attachedCandidateRows: attachedCandidates.length,
          derivationBound,
          attachedPageInUse: features.features.length > 0,
        }),
      derivation,
      unresolvedNodeIds,
      matchedFeatureIds: derivation.matchedFeatureIds,
    };
  }

  /**
   * Bare node ids → the `{repoKey, nodeId}` pairs derivation addresses code by.
   *
   * A stable node id carries its graph repo hash as its first segment, so the
   * repository is READ BACK out of the id and resolved through the workspace
   * registry (§6.5) rather than asking the caller for a parameter the local
   * contract does not have. An id whose hash is not registered here is reported,
   * never guessed: it still matches stored anchors by exact id, it simply cannot
   * be traversed.
   */
  private async resolveNodes(
    workspaceId: string,
    nodeIds: readonly string[],
  ): Promise<{ nodes: FeatureSeedRef[]; unresolvedNodeIds: string[] }> {
    const repos = await this.controlPlane.listRepos(workspaceId);
    const keyByHash = new Map<string, string>();
    for (const repo of repos) {
      if (repo.intentRepoKey) keyByHash.set(repo.repoKey, repo.intentRepoKey);
    }
    const nodes: FeatureSeedRef[] = [];
    const unresolvedNodeIds: string[] = [];
    for (const nodeId of nodeIds) {
      const hash = graphRepoHashOfNodeId(nodeId);
      const repoKey = hash ? keyByHash.get(hash) : undefined;
      if (!repoKey) {
        unresolvedNodeIds.push(nodeId);
        continue;
      }
      nodes.push({ repoKey, nodeId });
    }
    return { nodes, unresolvedNodeIds };
  }

  private async derivableItems(workspaceId: string, ids: readonly string[]): Promise<DerivableIntentItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: [...ids] } },
      select: {
        id: true,
        domainId: true,
        featureId: true,
        anchors: {
          where: { disabledAt: null },
          select: { repoKey: true, nodeId: true, nodeType: true, capturedVersionedId: true },
          orderBy: { nodeId: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      attachment: { domainId: row.domainId, featureId: row.featureId },
      anchors: row.anchors.map((anchor) => ({
        repoKey: anchor.repoKey,
        nodeId: anchor.nodeId,
        nodeType: anchor.nodeType as VersionedAnchorNodeType,
        capturedVersionedId: anchor.capturedVersionedId,
      })),
    }));
  }

  /**
   * Features whose areas may claim the queried nodes, narrowed by the tree scope
   * and — when the caller named node ids — by the repositories those nodes live
   * in.
   *
   * The repo narrowing is EXACT, not a heuristic: §6.1 computes an area per
   * repository with the repo filter pinned, and a cross-repo edge never extends
   * one, so a feature with no seed in any queried repository cannot cover a
   * queried node however much budget it is given. Dropping those before the
   * `features` bound applies is what stops a large workspace from spending its
   * whole budget on features that could not have matched — the bound then cuts
   * candidates, not the answer.
   *
   * The features SEEDED on a queried node are read first and never cut, because
   * the alphabetical page is not relevance: past the bound it dropped exactly the
   * feature the caller was standing in. What the bound does cut is now REPORTED,
   * never silent.
   */
  private async derivableFeatures(
    workspaceId: string,
    scope: IntentContextScope | undefined,
    queriedRepoKeys: readonly string[] = [],
    queriedNodeIds: readonly string[] = [],
  ): Promise<{ features: DerivableFeature[]; truncated: boolean }> {
    const limit = INTENT_CONTEXT_READ_LIMITS.features;
    const repoKeys = [...new Set(queriedRepoKeys)];
    const where = {
      workspaceId,
      archived: false,
      ...(scope?.featureId ? { id: scope.featureId } : {}),
      ...(scope && scope.featureId === null ? { domainId: scope.domainId } : {}),
      ...(repoKeys.length > 0 ? { seeds: { some: { repoKey: { in: repoKeys } } } } : {}),
    };
    const seeded =
      queriedNodeIds.length > 0
        ? await this.prisma.intentFeature.findMany({
            where: {
              ...where,
              seeds: {
                some: {
                  nodeId: { in: [...queriedNodeIds] },
                  ...(repoKeys.length > 0 ? { repoKey: { in: repoKeys } } : {}),
                },
              },
            },
            select: { id: true, domainId: true, seeds: { select: { repoKey: true, nodeId: true } } },
            orderBy: { id: 'asc' },
            take: limit,
          })
        : [];
    const page = await this.prisma.intentFeature.findMany({
      where,
      select: { id: true, domainId: true, seeds: { select: { repoKey: true, nodeId: true } } },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const merged = mergeFeatureCandidates(seeded, page, limit);
    return {
      features: merged.rows.map((row) => ({ id: row.id, domainId: row.domainId, seeds: row.seeds })),
      truncated: merged.truncated,
    };
  }

  /* ------------------------------------------------------- context mode --- */

  private async readContext(
    workspaceId: string,
    request: EffectiveContextRequest,
    scope: IntentContextScope | undefined,
    tokens: string[],
    exact: SelectedMatch[],
    excludeIds: string[],
    filter: ContextFilter | undefined,
  ) {
    const unresolvedFiles: NonNullable<IntentContextRequest['files']> = [];
    if (request.files?.length) {
      const repos = await this.prisma.workspaceRepo.findMany({
        where: { workspaceId, intentRepoKey: { in: request.files.map((file) => file.repoKey) } },
        select: { repoKey: true, intentRepoKey: true },
      });
      const hashes = new Map(repos.map((repo) => [repo.intentRepoKey, repo.repoKey]));
      const fileNodeIds = request.files.flatMap((file) => {
        const hash = hashes.get(file.repoKey);
        if (hash) return [`${hash}:file:${file.path}`];
        unresolvedFiles.push(file);
        return [];
      });
      request = { ...request, nodeIds: [...new Set([...(request.nodeIds ?? []), ...fileNodeIds])] };
    }
    const limit = request.limit;
    const scan = filter ? INTENT_CONTEXT_READ_LIMITS.contextCandidateScan : INTENT_CONTEXT_READ_LIMITS.candidateScan;
    const where = this.discoveredWhere(workspaceId, request, scope, excludeIds);

    let discovered: SelectedMatch[] = [];
    let scanTruncated = false;
    let fallback = false;
    let derivation: IntentNodeDerivationResult | undefined;
    let unresolvedNodeIds: string[] = [];
    let matchedFeatureIds: string[] = [];

    if (request.nodeIds !== undefined) {
      // A present-but-empty node selector matched nothing, which is an answer.
      if (request.nodeIds.length > 0) {
        const selected = await this.selectByNodeIds(
          workspaceId,
          request,
          request.task ? undefined : scope,
          request.task ? this.discoveredWhere(workspaceId, request, undefined, excludeIds) : where,
          request.nodeIds,
          excludeIds,
        );
        discovered = selected.matches;
        scanTruncated = selected.scanTruncated;
        derivation = selected.derivation;
        unresolvedNodeIds = selected.unresolvedNodeIds;
        matchedFeatureIds = selected.matchedFeatureIds;
      }
    } else if (!request.task && tokens.length > 0) {
      const lexical = await this.selectLexical(where, tokens, scan + 1, true);
      fallback = lexical.fallback;
      scanTruncated = lexical.rows.length > scan;
      discovered = lexical.rows.slice(0, scan).map((row) => ({ ...row, reason: IntentContextMatchReason.Text }));
    } else if (!request.task && scope) {
      const rows = await this.selectIds(where, Prisma.sql`"authorityRank", i.id`, scan + 1);
      scanTruncated = rows.length > scan;
      discovered = rows.slice(0, scan).map((row) => ({ ...row, reason: IntentContextMatchReason.Attached }));
    } else if (!hasSelector(request)) {
      const rows = await this.selectIds(where, Prisma.sql`"authorityRank", i.id`, scan + 1);
      scanTruncated = rows.length > scan;
      discovered = rows.slice(0, scan).map((row) => ({ ...row, reason: IntentContextMatchReason.Default }));
    }

    if (request.task) {
      const text = await this.selectTaskText(where, request.task, scan + 1, request.files);
      scanTruncated ||= text.length > scan;
      // Reciprocal-rank fusion lets either retrieval path contribute without
      // comparing SQL text scores with graph distances. Agreement ranks first.
      const ranked = (matches: SelectedMatch[]) =>
        matches.map((match, index) => ({
          ...match,
          taskScore: 1 / (60 + index + 1),
          matchReasons: [match.reason],
        }));
      discovered = mergeMatches([
        ...ranked(
          discovered.sort(
            (a, b) =>
              a.authorityRank - b.authorityRank ||
              Number(b.reason === IntentContextMatchReason.NodeAnchor) -
                Number(a.reason === IntentContextMatchReason.NodeAnchor) ||
              compareMatches(a, b),
          ),
        ),
        ...ranked(text.slice(0, scan).map((row) => ({ ...row, reason: IntentContextMatchReason.Text }))),
      ]);
      discovered.sort(
        (a, b) => a.authorityRank - b.authorityRank || (b.taskScore ?? 0) - (a.taskScore ?? 0) || compareMatches(a, b),
      );
    } else {
      discovered.sort(fallback ? compareFallbackMatches : compareMatches);
    }
    const ordered = await this.applyContext(workspaceId, filter, [...exact, ...discovered]);
    const selected = ordered.slice(0, limit);
    const items = await this.hydrate(workspaceId, selected);

    // In the node-selector path derivation already ran, because its result
    // decided the selection; otherwise it runs over exactly what is being
    // returned, because §6.3 requires provenance and anchorStatus on every
    // context answer.
    const derived =
      derivation ??
      (await this.derivation.deriveNodeContext(workspaceId, {
        nodes: [],
        items: await this.derivableItems(
          workspaceId,
          selected.map((match) => match.id),
        ),
        features: [],
        observedCheckouts: request.observed,
      }));
    const evidence = await this.evidenceForReturned(workspaceId, request, selected, items, derived);

    return {
      mode: IntentContextMode.Context,
      limit,
      matches: selected.map((match) => this.toContextMatch(match, items, evidence.index, scope, filter)),
      truncated: ordered.length > selected.length || scanTruncated,
      omittedCount: ordered.length - selected.length,
      totalMatched: ordered.length,
      scanTruncated,
      unknownIntentIds: this.unknownIntentIds(request, exact),
      unresolvedNodeIds,
      ...(request.task ? { unresolvedFiles } : {}),
      matchedFeatureIds,
      evidence: { available: evidence.available },
      graph: {
        repos: derived.evidence.repos,
        ...(evidence.degradation ? { degradation: evidence.degradation } : {}),
        truncated: derived.truncated,
        limits: derived.limits,
        // Present only when the derivation ran out of budget before checking
        // every candidate feature: the narrowing that answers completely, next
        // to the marker that says the current answer does not.
        ...(derived.scopeSuggestion ? { scopeSuggestion: derived.scopeSuggestion } : {}),
      },
      anchorWarning: INTENT_ANCHOR_WARNING,
    };
  }

  /**
   * Anchor evidence for EXACTLY the anchors this response returns (§6.3, §6.4).
   *
   * The node-selector path derives over a bounded candidate set
   * (`derivationItems`), and the anchor half of that selector scans further than
   * that bound reaches. So an item can be RETURNED — matched by a stored anchor
   * — while its anchors were never handed to evidence resolution, and it would
   * come back with no `status` and no `snapshotFreshness` while
   * `evidence.available` still said `true`. Absent trust fields must mean one
   * thing only: the graph could not be read (§6.3). Anything else is a silent
   * downgrade of exactly the field a reviewer leans on.
   *
   * So the selection is checked against the evidence index, and any returned
   * item whose anchors were missed is resolved in a second pass. When that pass
   * cannot read the graph, the response says `available: false` with its
   * degradation rather than reporting partial evidence as complete.
   */
  private async evidenceForReturned(
    workspaceId: string,
    request: EffectiveContextRequest,
    selected: readonly SelectedMatch[],
    items: ReadonlyMap<string, HydratedItem>,
    derived: IntentNodeDerivationResult,
  ): Promise<{
    index: ReadonlyMap<string, AnchorEvidence>;
    available: boolean;
    degradation?: IntentDerivationDegradation;
  }> {
    const index = this.evidenceIndex(derived);
    if (!derived.evidence.available) {
      return { index, available: false, ...(derived.degradation ? { degradation: derived.degradation } : {}) };
    }

    const missing: string[] = [];
    for (const match of selected) {
      const item = items.get(match.id);
      if (!item) continue;
      if (item.anchors.some((anchor) => !index.has(evidenceKey(item.id, anchor.repoKey, anchor.nodeId)))) {
        missing.push(item.id);
      }
    }
    if (missing.length === 0) {
      return { index, available: true, ...(derived.degradation ? { degradation: derived.degradation } : {}) };
    }

    const topUp = await this.derivation.deriveNodeContext(workspaceId, {
      nodes: [],
      items: await this.derivableItems(workspaceId, missing),
      features: [],
      observedCheckouts: request.observed,
    });
    if (!topUp.evidence.available) {
      return { index, available: false, ...(topUp.degradation ? { degradation: topUp.degradation } : {}) };
    }
    for (const [key, anchor] of this.evidenceIndex(topUp)) index.set(key, anchor);
    return {
      index,
      available: true,
      ...((derived.degradation ?? topUp.degradation)
        ? { degradation: (derived.degradation ?? topUp.degradation) as IntentDerivationDegradation }
        : {}),
    };
  }

  /* ---------------------------------------------------------- list mode --- */

  /**
   * The payload-free index, with the same selectors and a cursor.
   *
   * It carries NO evidence and NO provenance, deliberately: leasing a graph
   * snapshot to page a list of titles would make the cheap surface as expensive
   * as the context read, and an index entry states nothing about code that
   * evidence could qualify. The node selector is the exception — it cannot be
   * answered without the graph, so that request does report what it leased.
   */
  private async readList(
    workspaceId: string,
    request: EffectiveContextRequest,
    scope: IntentContextScope | undefined,
    tokens: string[],
    allExact: SelectedMatch[],
    excludeIds: string[],
    filter: ContextFilter | undefined,
  ) {
    const limit = request.limit;
    const where = this.discoveredWhere(workspaceId, request, scope, excludeIds);
    // A filtered page may advance over excluded rows, so its cursor is only valid under the same context.
    const binding = filter ? contextDigest(filter.context) : undefined;
    const cursor = decodeIntentCursor(request.cursor, IntentCursorScope.Context, 2, binding);
    const exact = await this.applyContext(workspaceId, filter, allExact);

    if (request.nodeIds !== undefined) {
      return this.listNodeSelector(workspaceId, request, scope, where, exact, allExact, limit, cursor !== null, filter);
    }

    // Exact ids ride on the FIRST page only, and they spend page budget like any
    // other entry — a page that silently exceeded `limit` would break the
    // caller's own bound.
    const exactPage = cursor ? [] : exact.slice(0, limit);
    const take = limit - exactPage.length;
    // With a context, a page is filled from a candidate window rather than
    // `take` rows, so excluded rows cannot starve it.
    const bound = filter ? INTENT_CONTEXT_READ_LIMITS.contextCandidateScan : take;
    const keyset = cursor
      ? [Prisma.sql`(${this.rankExpression}, i.id) > (${Number(cursor[0])}::int, ${cursor[1]})`]
      : [];

    let rows: CandidateIdRow[] = [];
    let fallback = false;
    let reason = IntentContextMatchReason.Default;
    if (take > 0 && tokens.length > 0) {
      // A cursor is only ever issued from a conjunctive page, so its presence
      // proves the conjunction matched: the fallback is not reconsidered, and an
      // empty later page stays empty instead of re-answering with any-token hits.
      const lexical = await this.selectLexical([...where, ...keyset], tokens, bound + 1, cursor === null);
      rows = lexical.rows;
      fallback = lexical.fallback;
      reason = IntentContextMatchReason.Text;
    } else if (take > 0 && (scope !== undefined || !hasSelector(request))) {
      // Same guard the context mode applies: an id selector that matched nothing
      // is still a selector, and must not fall through to the whole accepted set
      // labelled `default`.
      rows = await this.selectIds([...where, ...keyset], Prisma.sql`"authorityRank", i.id`, bound + 1);
      if (scope) reason = IntentContextMatchReason.Attached;
    }

    // The fallback's hit-count order is not a keyset, so that page is bounded
    // and cursor-less rather than pretending to paginate.
    const examined = rows.slice(0, bound);
    const kept = await this.applyContext(workspaceId, filter, examined);
    const page = kept.slice(0, take);
    const more = kept.length > take || rows.length > bound;
    // A window that ran out before filling the page resumes after its last EXAMINED row.
    const last = kept.length > take ? page[page.length - 1] : examined[examined.length - 1];
    const nextCursor =
      !fallback && more && last
        ? encodeIntentCursor(IntentCursorScope.Context, [String(last.authorityRank), last.id], binding)
        : null;
    const matches = [...exactPage, ...page.map((row) => ({ ...row, reason }))];

    return {
      mode: IntentContextMode.List,
      limit,
      entries: await this.listEntries(workspaceId, matches, scope, filter),
      nextCursor,
      truncated: (fallback && more) || exact.length > exactPage.length,
      ...(cursor ? {} : { unknownIntentIds: this.unknownIntentIds(request, allExact) }),
    };
  }

  /** The node selector in list mode: bounded, cursor-less, graph-backed. */
  private async listNodeSelector(
    workspaceId: string,
    request: EffectiveContextRequest,
    scope: IntentContextScope | undefined,
    where: Prisma.Sql[],
    exact: SelectedMatch[],
    allExact: SelectedMatch[],
    limit: number,
    hasCursor: boolean,
    filter: ContextFilter | undefined,
  ) {
    if (hasCursor) {
      throw intentStateError(
        IntentErrorCode.CursorNotSupported,
        'A node-id selection unions stored anchors with graph derivation and is returned as one bounded page',
        ['cursor'],
      );
    }
    const nodeIds = request.nodeIds ?? [];
    const exactIds = allExact.map((match) => match.id);
    const selected =
      nodeIds.length > 0
        ? await this.selectByNodeIds(workspaceId, request, scope, where, nodeIds, exactIds)
        : undefined;
    const discovered = await this.applyContext(workspaceId, filter, (selected?.matches ?? []).sort(compareMatches));
    const ordered = [...exact, ...discovered];
    const page = ordered.slice(0, limit);

    return {
      mode: IntentContextMode.List,
      limit,
      entries: await this.listEntries(workspaceId, page, scope, filter),
      nextCursor: null,
      truncated: ordered.length > page.length || (selected?.scanTruncated ?? false),
      unknownIntentIds: this.unknownIntentIds(request, allExact),
      unresolvedNodeIds: selected?.unresolvedNodeIds ?? [],
      matchedFeatureIds: selected?.matchedFeatureIds ?? [],
      ...(selected
        ? {
            evidence: { available: selected.derivation.evidence.available },
            graph: {
              repos: selected.derivation.evidence.repos,
              ...(selected.derivation.degradation ? { degradation: selected.derivation.degradation } : {}),
              truncated: selected.derivation.truncated,
              limits: selected.derivation.limits,
              ...(selected.derivation.scopeSuggestion ? { scopeSuggestion: selected.derivation.scopeSuggestion } : {}),
            },
          }
        : {}),
    };
  }

  /* ------------------------------------------------------------ shaping --- */

  private async hydrate(workspaceId: string, matches: readonly SelectedMatch[]): Promise<Map<string, HydratedItem>> {
    if (matches.length === 0) return new Map();
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: matches.map((match) => match.id) } },
      select: {
        id: true,
        kind: true,
        title: true,
        statement: true,
        rationale: true,
        payload: true,
        appliesWhen: true,
        authority: true,
        version: true,
        domainId: true,
        featureId: true,
        ...TREE_CONDITIONS_SELECT,
        proposedSuccessorOfId: true,
        supersededById: true,
        updatedAt: true,
        sources: {
          select: { kind: true, ref: true, localId: true, revision: true, locator: true, title: true, url: true },
          orderBy: { id: 'asc' },
        },
        anchors: {
          where: { disabledAt: null },
          select: {
            repoKey: true,
            nodeId: true,
            nodeType: true,
            capturedVersionedId: true,
            rationale: true,
            source: true,
          },
          orderBy: { nodeId: 'asc' },
        },
      },
    });
    return new Map(rows.map((row) => [row.id, row as unknown as HydratedItem]));
  }

  /** Anchor evidence keyed the way an anchor identifies itself: repo plus node. */
  private evidenceIndex(derivation: IntentNodeDerivationResult): Map<string, AnchorEvidence> {
    const index = new Map<string, AnchorEvidence>();
    for (const item of derivation.evidence.items ?? []) {
      for (const anchor of item.anchors) {
        index.set(evidenceKey(item.itemId, anchor.anchor.repo, anchor.anchor.nodeId), anchor);
      }
    }
    return index;
  }

  private toContextMatch(
    match: SelectedMatch,
    items: Map<string, HydratedItem>,
    evidence: ReadonlyMap<string, AnchorEvidence>,
    scope: IntentContextScope | undefined,
    filter: ContextFilter | undefined,
  ) {
    const item = items.get(match.id) as HydratedItem;
    const inheritedDomain = treeConditionsOf(item.domain);
    const inheritedFeature = treeConditionsOf(item.feature);
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      statement: item.statement,
      rationale: item.rationale,
      payload: item.payload,
      // Absent, not null, on an unconditioned item: a pre-dimensions reader sees the same bytes.
      ...(item.appliesWhen ? { appliesWhen: item.appliesWhen } : {}),
      ...(inheritedDomain || inheritedFeature
        ? {
            inheritedConditions: {
              ...(inheritedDomain ? { domain: inheritedDomain } : {}),
              ...(inheritedFeature ? { feature: inheritedFeature } : {}),
            },
          }
        : {}),
      ...(filter ? { contextMatch: this.contextMatchOf(item, filter, true) } : {}),
      authority: item.authority,
      // The handoff token: a reviewer re-fetches these ids and compares this
      // number before deciding (spec §5).
      version: item.version,
      domainId: item.domainId,
      featureId: item.featureId,
      proposedSuccessorOfId: item.proposedSuccessorOfId,
      supersededById: item.supersededById,
      updatedAt: item.updatedAt.toISOString(),
      matchReason: this.reasonOf(match, item, scope),
      ...(match.matchReasons ? { matchReasons: match.matchReasons } : {}),
      ...(match.derivedReasons ? { derivedReasons: match.derivedReasons } : {}),
      sources: item.sources,
      anchors: item.anchors.map((anchor) => {
        const resolved = evidence.get(evidenceKey(item.id, anchor.repoKey, anchor.nodeId));
        return {
          repoKey: anchor.repoKey,
          nodeId: anchor.nodeId,
          nodeType: anchor.nodeType,
          capturedVersionedId: anchor.capturedVersionedId,
          rationale: anchor.rationale,
          // Who placed it: a maintainer in session, or the CI bindings sync.
          source: anchor.source,
          // Absent, not guessed, when the graph could not be read (§6.3).
          ...(resolved
            ? {
                status: resolved.status,
                snapshotFreshness: resolved.snapshotFreshness,
                ...(resolved.mismatchReason ? { mismatchReason: resolved.mismatchReason } : {}),
                ...(resolved.currentVersionedId ? { currentVersionedId: resolved.currentVersionedId } : {}),
              }
            : {}),
        };
      }),
    };
  }

  /**
   * `{state, open}` in both modes. The context mode adds the reasons and, for a
   * rule with variants, their resolution; the list mode stays payload-free.
   */
  private contextMatchOf(item: HydratedItem, filter: ContextFilter, full: boolean) {
    const { state, open, reasons, openBy } = filter.evaluations.get(item.id) as EffectiveConditionsEvaluation;
    // The open levels only say something once a tree level takes part; without one the bytes stay as before.
    const inherits = treeConditionsOf(item.domain) !== undefined || treeConditionsOf(item.feature) !== undefined;
    const levels = inherits && openBy ? { openBy } : {};
    if (!full) return { state, open, ...levels };
    const variants =
      item.kind === IntentKind.BusinessRule
        ? (item.payload as { variants?: RuleVariant[] } | null)?.variants
        : undefined;
    return {
      state,
      open,
      ...levels,
      ...(reasons.length > 0 ? { reasons } : {}),
      ...(variants ? { variant: resolveVariants(variants, filter.context) } : {}),
    };
  }

  private async listEntries(
    workspaceId: string,
    matches: readonly SelectedMatch[],
    scope: IntentContextScope | undefined,
    filter?: ContextFilter,
  ) {
    const items = await this.hydrate(workspaceId, matches);
    return matches.map((match) => {
      const item = items.get(match.id) as HydratedItem;
      const entry = {
        id: item.id,
        kind: item.kind,
        title: item.title,
        authority: item.authority,
        version: item.version,
        domainId: item.domainId,
        featureId: item.featureId,
        matchReason: this.reasonOf(match, item, scope),
        ...(match.matchReasons ? { matchReasons: match.matchReasons } : {}),
        ...(match.derivedReasons ? { derivedReasons: match.derivedReasons } : {}),
        ...(filter ? { contextMatch: this.contextMatchOf(item, filter, false) } : {}),
      };
      const conditions = listConditionsOf(item);
      return conditions ? { ...entry, conditions } : entry;
    });
  }

  /**
   * A tree-scope match reports WHERE on the branch it was attached, which is
   * only knowable once the row is in hand — every other reason is settled by the
   * selector that found it.
   */
  private reasonOf(
    match: SelectedMatch,
    item: { domainId: string | null; featureId: string | null },
    scope: IntentContextScope | undefined,
  ): IntentContextMatchReason {
    if (match.reason !== IntentContextMatchReason.Attached || !scope) return match.reason;
    return attachmentReason(item, scope);
  }
}
