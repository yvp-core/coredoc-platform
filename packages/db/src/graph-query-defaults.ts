/**
 * Shared query-shape constants for the depth-N subgraph, dead-code, and
 * cross-repo bridge queries. Kept in ONE place so the SQLite and Neo4j backends
 * apply byte-identical edge-type sets and thresholds — parity between the two is
 * asserted by apps/server/.../graph.parity.test.ts, and drifting these lists
 * apart is exactly the kind of divergence that test exists to catch.
 */
import { EdgeType, NodeType } from './types.js';

/**
 * Default edge kinds a bare depth-N traverse follows — the *execution-flow*
 * edges. Deliberately excludes the structural `CONTAINS_*` edges and the dense
 * `USES_TYPE` edges so a depth-5 walk from one node cannot explode into the
 * whole file/type graph. The `MAKES_EXTERNAL_CALL` + `RESOLVES_TO` + `HANDLES`
 * trio lets the walk cross repos via the materialized bridge.
 */
export const SUBGRAPH_FLOW_EDGE_TYPES: readonly EdgeType[] = [
  EdgeType.Calls,
  EdgeType.Handles,
  EdgeType.MakesExternalCall,
  EdgeType.ResolvesTo,
  EdgeType.ReferencesVariable,
];

/** Node kinds the dead-code scan defaults to when the caller names none. */
export const DEAD_CODE_DEFAULT_TYPES: readonly NodeType[] = [NodeType.Function, NodeType.Class];

/**
 * Inbound edge kinds that count as "this node is used", per node kind. A node
 * with NONE of these pointing at it (and not exported) is a dead-code candidate.
 *
 * `HAS_METHOD` is deliberately absent for functions — every method carries an
 * inbound `HAS_METHOD` from its owning class, so counting it would flag nothing.
 * `HANDLES` IS included for functions so entrypoint handlers (reachable from
 * outside the repo) never register as dead. Node kinds without a specific entry
 * fall back to {@link DEAD_CODE_FALLBACK_USAGE_EDGES}.
 */
export const DEAD_CODE_USAGE_EDGES: Partial<Record<NodeType, readonly EdgeType[]>> = {
  [NodeType.Function]: [EdgeType.Calls, EdgeType.ReferencesVariable, EdgeType.UsesType, EdgeType.Handles],
  [NodeType.Class]: [EdgeType.UsesType, EdgeType.Extends, EdgeType.ImplementsInterface],
};

/** Usage edges for node kinds without a specific entry in {@link DEAD_CODE_USAGE_EDGES}. */
export const DEAD_CODE_FALLBACK_USAGE_EDGES: readonly EdgeType[] = [
  EdgeType.Calls,
  EdgeType.ReferencesVariable,
  EdgeType.UsesType,
  EdgeType.Handles,
  EdgeType.Extends,
  EdgeType.ImplementsInterface,
  EdgeType.OperatesOn,
];

/** The usage-edge set for a given node kind (specific entry, else the fallback). */
export function deadCodeUsageEdges(type: NodeType): readonly EdgeType[] {
  return DEAD_CODE_USAGE_EDGES[type] ?? DEAD_CODE_FALLBACK_USAGE_EDGES;
}

/**
 * Rows an unresolved-call query returns when the caller names no limit. Shared so
 * both file engines answer the same bounded set for the same graph — a repo with
 * weak static resolution holds thousands of these.
 */
export const UNRESOLVED_CALL_DEFAULT_LIMIT = 50;

/**
 * A repo whose fraction of functions with ≥1 outgoing CALLS edge is below this
 * is treated as "low call-graph coverage": there, a missing inbound CALLS edge
 * is more likely a profile-extraction gap than true dead code, so its dead-code
 * results are flagged "suspect". 0.5 = fewer than half the functions have any
 * resolved outgoing call.
 */
export const LOW_COVERAGE_CALL_RATIO = 0.5;

/**
 * Repos (by name) whose call-graph coverage is below {@link LOW_COVERAGE_CALL_RATIO}.
 * Shared by both backends' `findDeadNodes` so the "suspect" flagging is identical.
 */
export function lowCoverageRepoNames(
  coverage: Array<{ repoName: string; functionCount: number; functionsWithCalls: number }>,
): string[] {
  return coverage
    .filter((c) => c.functionCount > 0 && c.functionsWithCalls / c.functionCount < LOW_COVERAGE_CALL_RATIO)
    .map((c) => c.repoName);
}

/**
 * Clamp a caller-supplied row limit into a bounded, positive integer. Shared by
 * all three backends so `limit: 5000` (or 0 / NaN / Infinity) yields the same
 * bounded page everywhere — the cross-backend contract test asserts this parity
 * on `getNeighbors` and `listNodesByType`.
 */
/**
 * Per-query-family caps for {@link clampLimit}, named once so a cap change is a
 * single edit instead of a hunt through three backends. Every site passes
 * `X.max, X.fallback`; the cross-backend contract test pins the parity.
 */
/** `getNeighbors` — one node's immediate ring. */
export const NEIGHBOR_LIMIT = { max: 200, fallback: 50 } as const;
/** `listNodesByType` — a paged node listing. */
export const NODE_PAGE_LIMIT = { max: 1000, fallback: 50 } as const;
/** `findCode` — symbol search. */
export const SYMBOL_SEARCH_LIMIT = { max: 1000, fallback: 50 } as const;
/** `listEntrypoints`. */
export const ENTRYPOINT_LIST_LIMIT = { max: 1000, fallback: 50 } as const;
/** `getEdgesAmong` — edges within an already-bounded node set, so a wider cap. */
export const EDGES_AMONG_LIMIT = { max: 10_000, fallback: 2000 } as const;
/** `getSubgraph` — nodes a depth-N walk may materialize. */
export const SUBGRAPH_NODE_CAP = { max: 200, fallback: 50 } as const;
/** Ladybug's internal id-expansion steps feeding a subgraph walk (ids only, not rows). */
export const SUBGRAPH_EXPANSION_LIMIT = { max: 100_000, fallback: 1000 } as const;
/** `findDeadNodes`. */
export const DEAD_NODE_LIMIT = { max: 200, fallback: 50 } as const;
/** `getCrossRepoBridges`. */
export const BRIDGE_LIMIT = { max: 200, fallback: 50 } as const;
/** `queryUnresolvedCalls` — falls back to {@link UNRESOLVED_CALL_DEFAULT_LIMIT}. */
export const UNRESOLVED_CALL_LIMIT = { max: 1000, fallback: UNRESOLVED_CALL_DEFAULT_LIMIT } as const;

export function clampLimit(value: number, maximum = 1000, fallback = 50): number {
  const integer = Math.floor(Number(value));
  if (!Number.isFinite(integer) || integer <= 0) return fallback;
  return Math.min(integer, maximum);
}
