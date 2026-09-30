/**
 * Item→feature applicability and its reverse (spec §6.2).
 *
 * No membership is ever stored (D6). An item reaches a feature by attachment,
 * by inheritance down the tree branch, or because one of its anchors sits in —
 * or is directly called by — the feature's derived area. Every hit names which,
 * because "this rule applies here" is a claim a reader must be able to check.
 *
 * The node-id selector is the SAME computation run backwards: the caller's node
 * set plays the part of the area, and the identical bounds apply.
 */

import { enclosingNodeIdCandidates } from '../intent-context.select.js';
import type {
  DerivableFeature,
  DerivableIntentItem,
  FeatureArea,
  FeatureAreaRepoSlice,
  FeatureSeedRef,
  ItemAnchorRef,
  ItemApplicability,
} from './derivation-contract.js';
import { IntentDerivationLimit, IntentMatchReason } from './derivation-contract.js';
import type { DerivationBudget } from './derivation-bounds.js';
import {
  AREA_CALL_EDGE_TYPES,
  AREA_CONTAINMENT_EDGE_TYPES,
  type BatchTraversalCapability,
  computeFeatureArea,
} from './feature-area.js';

/** Stable reporting order: authored reasons before derived ones. */
const REASON_ORDER: readonly IntentMatchReason[] = [
  IntentMatchReason.Attached,
  IntentMatchReason.Inherited,
  IntentMatchReason.AnchorInArea,
  IntentMatchReason.AnchorCalledByArea,
  IntentMatchReason.AnchorCallsArea,
];

class ApplicabilityAccumulator {
  private readonly reasons = new Map<string, Set<IntentMatchReason>>();
  private readonly anchors = new Map<string, ItemAnchorRef[]>();

  add(itemId: string, reason: IntentMatchReason, anchor?: ItemAnchorRef): void {
    const existing = this.reasons.get(itemId) ?? new Set<IntentMatchReason>();
    existing.add(reason);
    this.reasons.set(itemId, existing);
    if (!anchor) return;
    const matched = this.anchors.get(itemId) ?? [];
    if (!matched.some((known) => known.repoKey === anchor.repoKey && known.nodeId === anchor.nodeId)) {
      matched.push(anchor);
    }
    this.anchors.set(itemId, matched);
  }

  /** Hits in the caller's item order — a stable response beats a fast one here. */
  collect(items: readonly DerivableIntentItem[]): ItemApplicability[] {
    const output: ItemApplicability[] = [];
    for (const item of items) {
      const reasons = this.reasons.get(item.id);
      if (!reasons || reasons.size === 0) continue;
      output.push({
        itemId: item.id,
        reasons: REASON_ORDER.filter((reason) => reasons.has(reason)),
        matchedAnchors: this.anchors.get(item.id) ?? [],
      });
    }
    return output;
  }
}

/** Attachment (§4.4): exactly one of product root, a domain, or a feature. */
function addAttachmentReasons(
  accumulator: ApplicabilityAccumulator,
  item: DerivableIntentItem,
  feature: DerivableFeature,
): void {
  const { domainId, featureId } = item.attachment;
  if (featureId !== null) {
    if (featureId === feature.id) accumulator.add(item.id, IntentMatchReason.Attached);
    return;
  }
  // Inheritance is down-the-branch only: the product root reaches every
  // feature, a domain reaches its own features, and nothing reaches sideways.
  if (domainId === null || domainId === feature.domainId) {
    accumulator.add(item.id, IntentMatchReason.Inherited);
  }
}

interface AnchorLayers {
  coreNodeIds: ReadonlySet<string>;
  calledNodeIds: ReadonlySet<string>;
  calleesTruncated: boolean;
}

function layersByRepoKey(slices: readonly FeatureAreaRepoSlice[]): Map<string, AnchorLayers> {
  return new Map(
    slices.map((slice) => [
      slice.repoKey,
      {
        coreNodeIds: slice.coreNodeIds,
        calledNodeIds: slice.calledNodeIds,
        calleesTruncated: slice.calleesTruncated,
      },
    ]),
  );
}

interface PendingRecheck {
  itemId: string;
  anchor: ItemAnchorRef;
}

/**
 * Place every anchor against the layers of its own repository.
 *
 * Anchors whose repo has no layer are simply not matched here: a feature with
 * no seed in that repository has no area there, and §6.1 refuses to let a
 * cross-repo edge invent one.
 */
function placeAnchors(
  accumulator: ApplicabilityAccumulator,
  items: readonly DerivableIntentItem[],
  layers: ReadonlyMap<string, AnchorLayers>,
): Map<string, PendingRecheck[]> {
  const pendingByRepoKey = new Map<string, PendingRecheck[]>();
  for (const item of items) {
    for (const anchor of item.anchors) {
      const layer = layers.get(anchor.repoKey);
      if (!layer) continue;
      if (layer.coreNodeIds.has(anchor.nodeId)) {
        accumulator.add(item.id, IntentMatchReason.AnchorInArea, anchor);
        continue;
      }
      if (layer.calledNodeIds.has(anchor.nodeId)) {
        accumulator.add(item.id, IntentMatchReason.AnchorCalledByArea, anchor);
        continue;
      }
      // The callee layer was cut short, so "not in the set" is not yet an
      // answer for this anchor — ask the graph about this exact node instead of
      // reporting a false negative.
      if (!layer.calleesTruncated) continue;
      const pending = pendingByRepoKey.get(anchor.repoKey) ?? [];
      pending.push({ itemId: item.id, anchor });
      pendingByRepoKey.set(anchor.repoKey, pending);
    }
  }
  return pendingByRepoKey;
}

async function resolvePendingRechecks(
  accumulator: ApplicabilityAccumulator,
  pendingByRepoKey: ReadonlyMap<string, PendingRecheck[]>,
  sourcesByRepoKey: ReadonlyMap<string, { graphRepoHash: string; sourceNodeIds: readonly string[] }>,
  traversal: BatchTraversalCapability,
  budget: DerivationBudget,
): Promise<void> {
  for (const [repoKey, pending] of pendingByRepoKey) {
    const source = sourcesByRepoKey.get(repoKey);
    if (!source || source.sourceNodeIds.length === 0) continue;
    const candidateIds = [...new Set(pending.map((entry) => entry.anchor.nodeId))];
    if (!budget.claimQuery()) return;
    const reached = await traversal.selectReachedNodeIds(
      source.sourceNodeIds,
      candidateIds,
      { edgeTypes: AREA_CALL_EDGE_TYPES, limit: budget.stepLimit() },
      [source.graphRepoHash],
    );
    const matched = new Set(reached.nodeIds);
    for (const entry of pending) {
      if (matched.has(entry.anchor.nodeId)) {
        accumulator.add(entry.itemId, IntentMatchReason.AnchorCalledByArea, entry.anchor);
      }
    }
  }
}

/**
 * Node kinds that call nothing themselves — their members do.
 *
 * A caller looking at a file (or a class) names the CONTAINER, not each
 * function in it, and a container carries no `CALLS` edge: the one-hop check
 * run straight off the queried ids therefore derived nothing at all for the
 * most ordinary query there is.
 *
 * The kind is the second segment of a stable node id (`{repoHash}:{kind}:…`).
 */
const CONTAINER_NODE_KINDS: ReadonlySet<string> = new Set(['file', 'class']);

/**
 * Containment levels walked below a queried container before the calls hop.
 *
 * TWO, because a file's calling code is routinely a METHOD: `file →
 * CONTAINS_CLASS → class → HAS_METHOD → method` is the ordinary OO shape, and
 * one level stopped at the class — which calls nothing — so a file query in a
 * service-class codebase derived nothing. Only container-kind members are
 * expanded again, so the second level costs one query for a file that holds a
 * class and none for one that does not. It is a fixed cap rather than the
 * area's `maxContainmentDepth`: this is a queried node, not a seeded area, and
 * a caller naming a file must not be able to buy a package-deep closure.
 */
const MAX_CONTAINER_LEVELS = 2;

function containerIds(nodeIds: Iterable<string>): string[] {
  return [...nodeIds].filter((nodeId) => CONTAINER_NODE_KINDS.has(nodeId.split(':')[1] ?? ''));
}

/**
 * Members of the queried containers, {@link MAX_CONTAINER_LEVELS} levels down,
 * charged to the shared budget like any other step. Nothing else is expanded: a
 * query that named no container costs no query at all.
 */
async function expandContainerMembers(
  traversal: BatchTraversalCapability,
  nodeIds: ReadonlySet<string>,
  graphRepoHash: string,
  budget: DerivationBudget,
): Promise<string[]> {
  const members: string[] = [];
  const seen = new Set(nodeIds);
  let frontier = containerIds(nodeIds);
  for (let level = 0; level < MAX_CONTAINER_LEVELS && frontier.length > 0; level += 1) {
    if (!budget.claimQuery()) break;
    const step = await traversal.expandOutboundNodeIds(
      frontier,
      { edgeTypes: AREA_CONTAINMENT_EDGE_TYPES, limit: budget.stepLimit() },
      [graphRepoHash],
    );
    if (step.truncated) budget.recordLimit(IntentDerivationLimit.StepLimit);
    const admitted = budget.admitNodes(step.nodeIds.filter((id) => !seen.has(id)));
    for (const id of admitted) {
      seen.add(id);
      members.push(id);
    }
    frontier = containerIds(admitted);
  }
  return members;
}

/**
 * Anchors that CALL the queried code, attributed to the anchor that did it.
 *
 * One query per repository, keyed on the queried nodes (the callee side), and
 * the caller ids come back WITH the edge — which is why this direction uses
 * `getInternalCallEdges` rather than the batched pair: `selectReachedNodeIds`
 * returns a bare id set, so it can say that some anchor calls the queried code
 * but never which one, and `matchedAnchors` would have to be guessed.
 *
 * A caller also stands for its enclosing class and file. File anchors are the
 * CI manifest default, so they must participate in derived applicability too.
 * This is context evidence (anchor_calls_area), not proof of conformance.
 *
 * The callee set is CAPPED by the same per-step bound every other traversal
 * spends, and a cap that bites is reported: this read is one query whose cost
 * grows with the ids handed to it.
 */
async function anchorIdsCallingNodes(
  traversal: BatchTraversalCapability,
  calleeIds: readonly string[],
  graphRepoHash: string,
  budget: DerivationBudget,
): Promise<ReadonlySet<string> | null> {
  const readCallEdges = traversal.getInternalCallEdges;
  if (!readCallEdges || calleeIds.length === 0) return null;
  const limit = budget.stepLimit();
  const callees = calleeIds.slice(0, limit);
  if (callees.length < calleeIds.length) budget.recordLimit(IntentDerivationLimit.StepLimit);
  if (!budget.claimQuery()) return null;
  const edges = await readCallEdges([graphRepoHash], callees);
  const ids = new Set<string>();
  for (const edge of edges) for (const candidate of enclosingNodeIdCandidates(edge.callerId)) ids.add(candidate);
  return ids;
}

export interface ResolveFeatureApplicabilityInput {
  feature: DerivableFeature;
  items: readonly DerivableIntentItem[];
  /** Null when the graph is unavailable — attachment and inheritance still resolve. */
  area: FeatureArea | null;
  traversal: BatchTraversalCapability | null;
  budget: DerivationBudget;
}

export async function resolveFeatureApplicability(
  input: ResolveFeatureApplicabilityInput,
): Promise<ItemApplicability[]> {
  const accumulator = new ApplicabilityAccumulator();
  for (const item of input.items) addAttachmentReasons(accumulator, item, input.feature);

  if (input.area && input.traversal) {
    const layers = layersByRepoKey(input.area.slices);
    const pending = placeAnchors(accumulator, input.items, layers);
    await resolvePendingRechecks(
      accumulator,
      pending,
      new Map(
        input.area.slices.map((slice) => [
          slice.repoKey,
          { graphRepoHash: slice.graphRepoHash, sourceNodeIds: [...slice.coreNodeIds] },
        ]),
      ),
      input.traversal,
      input.budget,
    );
  }

  return accumulator.collect(input.items);
}

export interface ResolveNodeApplicabilityInput {
  /** The code the caller is looking at, addressed the way anchors are. */
  nodes: readonly FeatureSeedRef[];
  items: readonly DerivableIntentItem[];
  /**
   * Features whose areas may claim these nodes. Bounded by the caller; the
   * shared budget stops the walk either way.
   */
  features: readonly DerivableFeature[];
  graphRepoHashByKey: ReadonlyMap<string, string>;
  traversal: BatchTraversalCapability | null;
  budget: DerivationBudget;
}

export interface NodeApplicabilityResult {
  applicable: ItemApplicability[];
  /** The features whose derived area contains at least one of the queried nodes. */
  matchedFeatureIds: string[];
  /**
   * Candidate features the budget stopped this walk from deciding either way,
   * highest-ranked first.
   *
   * Non-empty is the honest statement "these were never checked" — the input to
   * the scope suggestion the response carries, and the reason a truncated node
   * read is actionable rather than merely flagged.
   */
  undeterminedFeatureIds: string[];
}

/**
 * Relevance tiers for spending the budget on candidate features, best first.
 *
 * The budget buys a bounded number of feature areas, so WHICH features it buys
 * is a product decision, not an implementation detail: ordering by id spent it
 * on an alphabetical prefix, which no caller could predict and which is right
 * only by accident. These tiers are computed from rows already in hand — no
 * graph query pays for the ordering itself.
 */
enum FeatureRelevance {
  /** A queried node IS one of the feature's seeds: the area is about this code. */
  SeedIsQueriedNode = 0,
  /** An item attached to this feature is anchored on a queried node. */
  AnchorOnQueriedNode = 1,
  /** A seed shares a repository with a queried node — the only tier that can match at all. */
  RepoOverlap = 2,
  /** No seed in any queried repository: §6.1 makes coverage impossible. */
  NoOverlap = 3,
}

/**
 * The path segment of a stable node id, or `''` when it has none.
 *
 * Always the third segment: `{repoHash}:{kind}:{path}` for a file or package and
 * `{repoHash}:{kind}:{path}:{name}` for a symbol. Hashed kinds (a route, an
 * entrypoint) put a digest there instead, which is harmless HERE and nowhere
 * else — a digest shares no leading path segment with a real path, so it scores
 * zero rather than scoring wrong. This is a ranking signal, never a decision.
 */
function nodeIdPath(nodeId: string): string {
  return nodeId.split(':')[2] ?? '';
}

/** How many leading `/`-separated segments two paths share. */
function sharedPathDepth(left: string, right: string): number {
  if (left === '' || right === '') return 0;
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  let shared = 0;
  while (
    shared < leftSegments.length &&
    shared < rightSegments.length &&
    leftSegments[shared] === rightSegments[shared]
  )
    shared += 1;
  return shared;
}

interface RankedFeature {
  feature: DerivableFeature;
  relevance: FeatureRelevance;
  /** Deepest path overlap between any seed and any queried node in its repo. */
  pathDepth: number;
}

/**
 * Order candidate features by how likely their area is to cover the queried
 * nodes: seed-is-the-node first, then features an anchored item already ties to
 * this code, then plain repository overlap ordered by how deep into the tree the
 * seed and the queried node agree. Ties break on id, so the order stays total
 * and a truncated walk drops the same tail on every run.
 */
function rankFeatures(
  features: readonly DerivableFeature[],
  nodesByRepoKey: ReadonlyMap<string, Set<string>>,
  items: readonly DerivableIntentItem[],
): RankedFeature[] {
  const featureIdsWithAnchoredItem = new Set<string>();
  for (const item of items) {
    if (item.attachment.featureId === null) continue;
    if (item.anchors.some((anchor) => nodesByRepoKey.get(anchor.repoKey)?.has(anchor.nodeId))) {
      featureIdsWithAnchoredItem.add(item.attachment.featureId);
    }
  }

  const ranked = features.map((feature) => {
    let relevance = FeatureRelevance.NoOverlap;
    let pathDepth = 0;
    for (const seed of feature.seeds) {
      const queried = nodesByRepoKey.get(seed.repoKey);
      if (!queried) continue;
      if (queried.has(seed.nodeId)) relevance = FeatureRelevance.SeedIsQueriedNode;
      else if (relevance > FeatureRelevance.RepoOverlap) relevance = FeatureRelevance.RepoOverlap;
      const seedPath = nodeIdPath(seed.nodeId);
      for (const nodeId of queried) pathDepth = Math.max(pathDepth, sharedPathDepth(seedPath, nodeIdPath(nodeId)));
    }
    if (relevance === FeatureRelevance.RepoOverlap && featureIdsWithAnchoredItem.has(feature.id)) {
      relevance = FeatureRelevance.AnchorOnQueriedNode;
    }
    return { feature, relevance, pathDepth };
  });

  return ranked.sort(
    (left, right) =>
      left.relevance - right.relevance ||
      right.pathDepth - left.pathDepth ||
      (left.feature.id < right.feature.id ? -1 : left.feature.id > right.feature.id ? 1 : 0),
  );
}

/**
 * The reverse direction of §6.2, sharing this module's computation and bounds.
 *
 * The queried node set stands in for an area: an anchor ON one of those nodes
 * is `anchor_in_area`, an anchor those nodes CALL is `anchor_called_by_area`,
 * and an item attached to (or inherited by) a feature whose area covers any of
 * those nodes is `attached` / `inherited`.
 *
 * Candidate features are walked in RELEVANCE order ({@link rankFeatures}) rather
 * than the order the caller listed them: the shared budget buys a bounded number
 * of areas, and spending it on the features whose seeds sit nearest the queried
 * code is the difference between a useful bounded answer and an arbitrary one.
 * Whatever the budget did not reach is returned as `undeterminedFeatureIds`.
 */
export async function resolveNodeApplicability(input: ResolveNodeApplicabilityInput): Promise<NodeApplicabilityResult> {
  const accumulator = new ApplicabilityAccumulator();
  const nodesByRepoKey = new Map<string, Set<string>>();
  for (const node of input.nodes) {
    const bucket = nodesByRepoKey.get(node.repoKey) ?? new Set<string>();
    bucket.add(node.nodeId);
    nodesByRepoKey.set(node.repoKey, bucket);
  }

  // Anchors ON the queried nodes need no graph access at all.
  for (const item of input.items) {
    for (const anchor of item.anchors) {
      if (nodesByRepoKey.get(anchor.repoKey)?.has(anchor.nodeId)) {
        accumulator.add(item.id, IntentMatchReason.AnchorInArea, anchor);
      }
    }
  }

  const matchedFeatureIds: string[] = [];
  const undeterminedFeatureIds: string[] = [];
  if (!input.traversal) {
    return { applicable: accumulator.collect(input.items), matchedFeatureIds, undeterminedFeatureIds };
  }
  const traversal = input.traversal;

  // Anchors the queried nodes CALL — one query per repository, over the exact
  // anchor ids in play rather than the whole callee neighbourhood.
  for (const [repoKey, nodeIds] of nodesByRepoKey) {
    const graphRepoHash = input.graphRepoHashByKey.get(repoKey);
    if (!graphRepoHash) continue;
    const candidates = [
      ...new Set(
        input.items.flatMap((item) =>
          item.anchors
            .filter((anchor) => anchor.repoKey === repoKey && !nodeIds.has(anchor.nodeId))
            .map((anchor) => anchor.nodeId),
        ),
      ),
    ];
    if (candidates.length === 0) continue;
    const members = await expandContainerMembers(traversal, nodeIds, graphRepoHash, input.budget);
    if (!input.budget.claimQuery()) break;
    const reached = await traversal.selectReachedNodeIds(
      [...nodeIds, ...members],
      candidates,
      { edgeTypes: AREA_CALL_EDGE_TYPES, limit: input.budget.stepLimit() },
      [graphRepoHash],
    );
    const matched = new Set(reached.nodeIds);
    // …and anchors that CALL the queried code: the baseline case, where the rule
    // lives on the caller and the edit is inside the shared callee.
    const callers = await anchorIdsCallingNodes(traversal, [...nodeIds, ...members], graphRepoHash, input.budget);
    for (const item of input.items) {
      for (const anchor of item.anchors) {
        if (anchor.repoKey !== repoKey) continue;
        if (matched.has(anchor.nodeId)) {
          accumulator.add(item.id, IntentMatchReason.AnchorCalledByArea, anchor);
        }
        if (callers?.has(anchor.nodeId) && !nodeIds.has(anchor.nodeId)) {
          accumulator.add(item.id, IntentMatchReason.AnchorCallsArea, anchor);
        }
      }
    }
  }

  // Features whose area covers a queried node lend their attached/inherited
  // items to the answer — the same tree walk as the forward direction, run in
  // RELEVANCE order so a budget that runs out has already bought the areas most
  // likely to matter. A caller with no queried nodes at all skips the walk
  // outright: no area can cover a node that was never named, so every query
  // would buy a guaranteed miss.
  const ranked = nodesByRepoKey.size === 0 ? [] : rankFeatures(input.features, nodesByRepoKey, input.items);
  for (let index = 0; index < ranked.length; index += 1) {
    if (!input.budget.hasQueryHeadroom()) {
      // Never checked, and said so: an unreported skip here is exactly the
      // silent shrink §6.1 forbids, and it is what makes the response able to
      // name a narrowing that would derive completely.
      for (const remaining of ranked.slice(index)) undeterminedFeatureIds.push(remaining.feature.id);
      input.budget.recordLimit(IntentDerivationLimit.QueryBudget);
      break;
    }
    const feature = (ranked[index] as RankedFeature).feature;
    const area = await computeFeatureArea({
      traversal,
      feature,
      graphRepoHashByKey: input.graphRepoHashByKey,
      budget: input.budget,
    });
    const covers = area.slices.some((slice) => {
      const queried = nodesByRepoKey.get(slice.repoKey);
      if (!queried) return false;
      for (const nodeId of queried) {
        if (slice.coreNodeIds.has(nodeId) || slice.calledNodeIds.has(nodeId)) return true;
      }
      return false;
    });
    if (!covers) continue;
    matchedFeatureIds.push(feature.id);
    for (const item of input.items) addAttachmentReasons(accumulator, item, feature);
  }

  return { applicable: accumulator.collect(input.items), matchedFeatureIds, undeterminedFeatureIds };
}
