/**
 * The TWO node-type allowlists (plan decision, audit §3).
 *
 * They are deliberately separate lists, not one list with a flag:
 *
 * - {@link INTENT_ANCHOR_NODE_TYPES} — what an ANCHOR may point at. Anchors
 *   carry a `capturedVersionedId` drift baseline, so the list is exactly the
 *   node kinds the transformer persists `properties.versionedId` for. It
 *   reuses core's `VERSIONED_ANCHOR_NODE_TYPES`, also consumed by overlay
 *   validation and the PR mapping resolver.
 *
 * - {@link INTENT_SEED_NODE_TYPES} — what a FEATURE SEED may point at. A seed
 *   is a declared entry point of a code area and has no drift baseline, so it
 *   additionally admits Route and Package, and drops ExternalCall (which has no
 *   node-id spelling to seed with). Spelled out in full rather than derived from
 *   the anchor list: the two lists answer different questions and must be
 *   readable independently — which is only true while each one is accurate on
 *   its own, so neither carries a member the other list silently removes.
 */
import { NodeType, type NodeIdKind, VERSIONED_ANCHOR_NODE_TYPES } from '@coredoc/core';

/** Anchorable kinds — those with a versioned id (spec §4.6). */
export const INTENT_ANCHOR_NODE_TYPES = VERSIONED_ANCHOR_NODE_TYPES;

/**
 * Seedable kinds — the anchorable ones plus Route and Package (spec §4.3).
 *
 * `NodeType.ExternalCall` is the one anchorable kind MISSING here, and its
 * absence is the honest statement rather than an oversight: an external call is
 * emitted under an edge id kind and has no node-id spelling
 * ({@link NODE_ID_KIND_BY_NODE_TYPE} maps it to `null`), so it could never
 * survive into {@link INTENT_SEED_NODE_ID_KINDS} — the list the seed check
 * actually enforces. It used to be listed here anyway, which told a reader of
 * this list alone the opposite of what the endpoint does. It stays fully
 * ANCHORABLE ({@link INTENT_ANCHOR_NODE_TYPES}); only seeding was never real.
 */
export const INTENT_SEED_NODE_TYPES: NodeType[] = [
  NodeType.File,
  NodeType.Function,
  NodeType.Class,
  NodeType.Interface,
  NodeType.Entrypoint,
  NodeType.Entity,
  NodeType.Component,
  NodeType.StateStore,
  NodeType.TypeAlias,
  NodeType.Enum,
  NodeType.Variable,
  // Seed-only additions: an area's declared entry points are routes, packages,
  // and entrypoints far more often than they are functions.
  NodeType.Route,
  NodeType.Package,
];

/**
 * How each `NodeType` spells itself inside a stable node id
 * (`{repoHash}:{type}:{path}:{name}` — `@coredoc/core/id-generator`).
 *
 * Total over the enum on purpose: a node type added to core fails the build
 * here instead of silently defaulting to "not seedable". `null` means the kind
 * has no node-id spelling at all — a repository is not a graph node addressed
 * this way, and an external call is emitted under an EDGE id kind.
 */
const NODE_ID_KIND_BY_NODE_TYPE: Record<NodeType, NodeIdKind | null> = {
  [NodeType.Repository]: null,
  [NodeType.Package]: 'package',
  [NodeType.File]: 'file',
  [NodeType.Function]: 'function',
  [NodeType.Class]: 'class',
  [NodeType.Interface]: 'interface',
  [NodeType.Entrypoint]: 'entrypoint',
  [NodeType.Entity]: 'entity',
  [NodeType.Component]: 'component',
  [NodeType.Route]: 'route',
  [NodeType.StateStore]: 'state-store',
  [NodeType.TypeAlias]: 'type-alias',
  [NodeType.Enum]: 'enum',
  [NodeType.Variable]: 'variable',
  [NodeType.ExternalCall]: null,
};

/**
 * The seed allowlist expressed in node-ID vocabulary, which is what a seed
 * request actually carries: `PutIntentFeatureSeedSchema` has a `nodeId` and no
 * `nodeType`, and `intent_feature_seeds` has no node-type column, so the check
 * reads the id's own type segment.
 *
 * `method` is a node-id kind with no `NodeType` (methods are class members) and
 * is therefore not seedable — a consequence of the map above, not extra policy.
 * `external_call` is absent for the same reason one level up: it is not in
 * {@link INTENT_SEED_NODE_TYPES} because it has no node-id spelling at all.
 */
export const INTENT_SEED_NODE_ID_KINDS: NodeIdKind[] = INTENT_SEED_NODE_TYPES.map(
  (type) => NODE_ID_KIND_BY_NODE_TYPE[type],
).filter((kind): kind is NodeIdKind => kind !== null);

/**
 * The type segment of a stable node id, or `null` when the value is not one.
 *
 * Deliberately a two-line split rather than `StableIdGenerator.parseId`: that
 * method is an instance method on a generator bound to a repo root, and the
 * only fact needed here is the second colon-separated segment.
 */
export function nodeIdKindOf(nodeId: string): string | null {
  const segments = nodeId.split(':');
  if (segments.length < 3) return null;
  const kind = segments[1];
  return kind === undefined || kind.length === 0 ? null : kind;
}
