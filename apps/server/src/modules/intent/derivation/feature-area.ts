/**
 * `area(feature)` — spec §6.1.
 *
 * Per repository: the seeds, their downward containment closure (the
 * `CONTAINS_*` family plus `HAS_METHOD`, the only structural edge a method
 * has), the handlers
 * their routes/entrypoints reach through `HANDLES`, and ONE hop of `CALLS` out
 * of all of that. Multi-repo features are the union of per-repo areas, computed
 * with the repo filter pinned to that repo's graph hash — which is what makes a
 * cross-repo call edge unable to extend an area (§6.1, and the reason repo B
 * calling repo A's guard is a fixture case).
 *
 * The area is never stored (§4.9); it is recomputed per read inside the shared
 * {@link DerivationBudget}.
 */

import { EdgeType } from '@coredoc/core';
import type { IGraphBatchTraversalRepository, IGraphReadRepository } from '@coredoc/db';
import {
  type DerivableFeature,
  type FeatureArea,
  type FeatureAreaRepoSlice,
  type FeatureSeedRef,
  IntentDerivationLimit,
} from './derivation-contract.js';
import type { DerivationBudget } from './derivation-bounds.js';

/**
 * The downward containment family.
 *
 * `HAS_METHOD` IS here, decided in v1.1-05 after being deferred once. The graph
 * gives a method no other downward edge: `createContainsFunctionEdges`
 * (`packages/db/src/transformer.ts`) emits `CONTAINS_FUNCTION` only for
 * `kind === 'function'`, so a method's single inbound structural edge is
 * `HAS_METHOD` from its class. Without it, a class sitting squarely inside a
 * seeded package is in the area while every method on that class is not — and
 * anchoring a rule on a method is the ordinary case in an OO codebase, so the
 * omission read as "this rule does not apply here" rather than as a policy.
 *
 * The widening is bounded by the same node budget as the rest of the closure:
 * it adds one level below each in-area class, not a new traversal direction.
 */
export const AREA_CONTAINMENT_EDGE_TYPES: readonly EdgeType[] = Object.freeze([
  EdgeType.ContainsPackage,
  EdgeType.ContainsFile,
  EdgeType.ContainsFunction,
  EdgeType.ContainsClass,
  EdgeType.ContainsInterface,
  EdgeType.ContainsTypeAlias,
  EdgeType.ContainsEnum,
  EdgeType.ContainsVariable,
  EdgeType.ContainsEntity,
  EdgeType.ContainsComponent,
  EdgeType.ContainsRoute,
  EdgeType.HasMethod,
]);

/** Handler resolution: a Route/Entrypoint reaches its handler this way, not by containment. */
export const AREA_HANDLER_EDGE_TYPES: readonly EdgeType[] = Object.freeze([EdgeType.Handles]);

/** The one-hop call layer. */
export const AREA_CALL_EDGE_TYPES: readonly EdgeType[] = Object.freeze([EdgeType.Calls]);

/**
 * The batched-traversal capability, present only on a graph-native backend.
 *
 * Feature detection, never assumption: the legacy Turso plane implements
 * neither method, and a caller that finds `null` here degrades to
 * attachment-only derivation (§6.3) instead of failing the read.
 */
export interface BatchTraversalCapability {
  expandOutboundNodeIds: NonNullable<IGraphBatchTraversalRepository['expandOutboundNodeIds']>;
  selectReachedNodeIds: NonNullable<IGraphBatchTraversalRepository['selectReachedNodeIds']>;
  /**
   * Inbound call edges WITH their caller ids, for the one direction the two
   * set-shaped primitives cannot answer: which anchors CALL the queried code.
   * Both of those return a bare id set, so neither can say which anchor reached
   * what — and an applicability hit that cannot name its anchor is not a hit.
   *
   * Separately optional: it is an optional method of the common read contract,
   * not part of the batched-traversal pair, so a backend may have one and not
   * the other. `null` degrades just this direction.
   */
  getInternalCallEdges: NonNullable<IGraphReadRepository['getInternalCallEdges']> | null;
}

export function resolveBatchTraversal(repository: IGraphReadRepository): BatchTraversalCapability | null {
  const candidate = repository as IGraphReadRepository & Partial<IGraphBatchTraversalRepository>;
  if (typeof candidate.expandOutboundNodeIds !== 'function' || typeof candidate.selectReachedNodeIds !== 'function') {
    return null;
  }
  return {
    expandOutboundNodeIds: candidate.expandOutboundNodeIds.bind(candidate),
    selectReachedNodeIds: candidate.selectReachedNodeIds.bind(candidate),
    getInternalCallEdges:
      typeof candidate.getInternalCallEdges === 'function' ? candidate.getInternalCallEdges.bind(candidate) : null,
  };
}

function groupSeedsByRepoKey(seeds: readonly FeatureSeedRef[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const seed of seeds) {
    const bucket = grouped.get(seed.repoKey) ?? [];
    if (!bucket.includes(seed.nodeId)) bucket.push(seed.nodeId);
    grouped.set(seed.repoKey, bucket);
  }
  return grouped;
}

interface StepOutcome {
  admitted: string[];
  /** True when the step could not return everything the graph had. */
  incomplete: boolean;
}

async function expandStep(
  traversal: BatchTraversalCapability,
  frontier: readonly string[],
  edgeTypes: readonly EdgeType[],
  graphRepoHash: string,
  known: ReadonlySet<string>,
  budget: DerivationBudget,
): Promise<StepOutcome> {
  if (frontier.length === 0) return { admitted: [], incomplete: false };
  if (!budget.claimQuery()) return { admitted: [], incomplete: true };
  const step = await traversal.expandOutboundNodeIds(frontier, { edgeTypes, limit: budget.stepLimit() }, [
    graphRepoHash,
  ]);
  if (step.truncated) budget.recordLimit(IntentDerivationLimit.StepLimit);
  const fresh = step.nodeIds.filter((id) => !known.has(id));
  const admitted = budget.admitNodes(fresh);
  return { admitted, incomplete: step.truncated || admitted.length < fresh.length };
}

async function computeRepoSlice(
  traversal: BatchTraversalCapability,
  repoKey: string,
  graphRepoHash: string,
  seedIds: readonly string[],
  budget: DerivationBudget,
): Promise<FeatureAreaRepoSlice> {
  const core = new Set<string>(budget.admitNodes([...seedIds]));

  // 1. Containment closure, level by level. Bounding per level (rather than
  //    handing the whole walk to the engine) is what lets a tripped budget name
  //    the level it stopped at instead of returning an arbitrary prefix.
  let frontier = [...core];
  let depth = 0;
  for (; depth < budget.bounds.maxContainmentDepth && frontier.length > 0; depth += 1) {
    const step = await expandStep(traversal, frontier, AREA_CONTAINMENT_EDGE_TYPES, graphRepoHash, core, budget);
    for (const id of step.admitted) core.add(id);
    frontier = step.admitted;
    if (step.incomplete) {
      frontier = [];
      break;
    }
  }
  if (frontier.length > 0 && depth >= budget.bounds.maxContainmentDepth) {
    budget.recordLimit(IntentDerivationLimit.ContainmentDepth);
  }

  // 2. Handler resolution over everything reached so far. Handlers join the
  //    CORE (an anchor on a handler is in-area, not called-by-area).
  const handlers = await expandStep(traversal, [...core], AREA_HANDLER_EDGE_TYPES, graphRepoHash, core, budget);
  for (const id of handlers.admitted) core.add(id);

  // 3. Exactly one hop of CALLS out of the core. The result is kept SEPARATE
  //    from the core so §6.2 can report `anchor_called_by_area` distinctly, and
  //    so nothing here is ever used as a frontier again — one hop means one hop.
  const called = await expandStep(traversal, [...core], AREA_CALL_EDGE_TYPES, graphRepoHash, core, budget);

  return {
    repoKey,
    graphRepoHash,
    coreNodeIds: core,
    calledNodeIds: new Set(called.admitted),
    calleesTruncated: called.incomplete,
  };
}

export interface ComputeFeatureAreaInput {
  traversal: BatchTraversalCapability;
  feature: DerivableFeature;
  /** Durable repo key → graph repo hash, for the repos registered in this workspace. */
  graphRepoHashByKey: ReadonlyMap<string, string>;
  budget: DerivationBudget;
}

export async function computeFeatureArea(input: ComputeFeatureAreaInput): Promise<FeatureArea> {
  const { traversal, feature, graphRepoHashByKey, budget } = input;
  const slices: FeatureAreaRepoSlice[] = [];
  const unresolvedRepoKeys: string[] = [];

  for (const [repoKey, seedIds] of [...groupSeedsByRepoKey(feature.seeds)].sort(([a], [b]) => a.localeCompare(b))) {
    const graphRepoHash = graphRepoHashByKey.get(repoKey);
    if (!graphRepoHash) {
      // A seed naming a repo the workspace registry does not know is REPORTED,
      // never silently skipped: an area that is quietly missing a repository
      // looks identical to a feature that has no code there (§6.5).
      unresolvedRepoKeys.push(repoKey);
      continue;
    }
    slices.push(await computeRepoSlice(traversal, repoKey, graphRepoHash, seedIds, budget));
  }

  return {
    featureId: feature.id,
    slices,
    unresolvedRepoKeys,
    truncated: budget.truncated,
    limits: budget.limits,
    queriesUsed: budget.queriesUsed,
  };
}
