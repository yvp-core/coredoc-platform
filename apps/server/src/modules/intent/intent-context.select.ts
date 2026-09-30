/**
 * The SELECTION SEMANTICS of the context read, ported from
 * `packages/core/src/intent/query.ts` and kept pure.
 *
 * The port is deliberate duplication, not an oversight: core's implementation
 * selects over an in-memory overlay file, and this one selects over SQL rows
 * behind a bounded scan. What must NOT differ is the meaning — precedence,
 * ordering, the present-but-empty rule, the enclosing-anchor rule, and the
 * disjunctive fallback — so every rule that has to agree lives HERE, in pure
 * functions the unit suite asserts against the same expectation matrix core's
 * `query.test.ts` uses.
 *
 * Nothing in this file touches Prisma, the graph, or the clock.
 */
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { IntentMatchReason as IntentDerivationMatchReason } from './derivation/derivation-contract.js';
import { IntentContextMatchReason } from './intent-context.operations.js';

/**
 * Node kinds whose stable id is `{repoHash}:{kind}:{path}:{name}`.
 *
 * Verbatim from core: hashed kinds (`entrypoint`, `route`) and edge kinds are
 * absent because their third segment is a type token or a digest, so deriving a
 * file id from one would invent an anchor that never existed.
 */
export const PATH_SCOPED_NODE_KINDS = new Set([
  'function',
  'class',
  'method',
  'interface',
  'type-alias',
  'enum',
  'variable',
  'entity',
  'component',
  'state-store',
]);

/**
 * The queried node id plus the ids of the scopes that ENCLOSE it — the set an
 * anchor may match exactly.
 *
 * A review agent asks about the node it is editing (a method) while an item is
 * usually anchored one level out (the class, or the file), so an anchor on an
 * enclosing scope governs the member inside it. The rule is TWO-WAY: a bare file
 * id expands to nothing here, and reaches the items anchored on that file's
 * members through {@link fileMemberLikePatterns} instead.
 *
 * Anything that does not parse as a stable node id degrades to exact matching.
 */
export function enclosingNodeIdCandidates(nodeId: string): string[] {
  const parts = nodeId.split(':');
  if (parts.length !== 4) return [nodeId];

  const [repoHash, kind, path, name] = parts as [string, string, string, string];
  if (!repoHash || !path || !name || !PATH_SCOPED_NODE_KINDS.has(kind)) return [nodeId];

  const candidates = [nodeId, `${repoHash}:file:${path}`];
  if (kind === 'method') {
    // Python preserves the full nested owner (`Outer.Inner.method`); other
    // substrates usually emit `Class.method`. Every proper dotted prefix is an
    // enclosing class candidate.
    const segments = name.split('.');
    for (let length = 1; length < segments.length; length++) {
      candidates.push(`${repoHash}:class:${path}:${segments.slice(0, length).join('.')}`);
    }
  }
  return candidates;
}

/** Every id an anchor may equal to satisfy one of the requested node ids. */
export function expandNodeIds(nodeIds: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const nodeId of nodeIds) {
    for (const candidate of enclosingNodeIdCandidates(nodeId)) expanded.add(candidate);
  }
  return [...expanded];
}

/**
 * Candidate features for one read: the EXACT ones first (seeded on a queried
 * node), then the alphabetical page, deduplicated and capped at `limit`.
 *
 * `truncated` is true exactly when a candidate was dropped. An unreported drop is
 * the defect this exists to close: the page alone is ordered by id, so with more
 * features than the bound an item attached to a later one went missing while the
 * response still claimed to be complete.
 */
export function mergeFeatureCandidates<T extends { id: string }>(
  seeded: readonly T[],
  page: readonly T[],
  limit: number,
): { rows: T[]; truncated: boolean } {
  const byId = new Map<string, T>();
  let truncated = false;
  for (const row of [...seeded, ...page]) {
    if (byId.has(row.id)) continue;
    if (byId.size >= limit) {
      truncated = true;
      break;
    }
    byId.set(row.id, row);
  }
  return { rows: [...byId.values()], truncated };
}

/**
 * The graph repo hash a stable node id was minted under — its first segment.
 *
 * Derivation addresses code as `{repoKey, nodeId}` while a caller supplies bare
 * node ids, exactly as the local tool does. Rather than adding a parameter the
 * local contract does not have, the repository is read back OUT of the id and
 * resolved through the workspace registry (§6.5); an id whose hash is not
 * registered is reported as unresolved, never guessed at.
 */
export function graphRepoHashOfNodeId(nodeId: string): string | null {
  const separator = nodeId.indexOf(':');
  if (separator <= 0) return null;
  return nodeId.slice(0, separator);
}

/**
 * Authority ordering: accepted before candidate, then the retained states.
 *
 * Only the first two are reachable without an exact id; the other two are ranked
 * so an exact-id batch mixing them still has a total order to fall back on.
 */
export const AUTHORITY_RANK: Record<IntentItemAuthority, number> = {
  [IntentItemAuthority.accepted]: 0,
  [IntentItemAuthority.candidate]: 1,
  [IntentItemAuthority.superseded]: 2,
  [IntentItemAuthority.rejected]: 3,
};

/**
 * Precedence when several selectors would explain the same item.
 *
 * Core reports one reason per item and checks node before text before default;
 * the cloud inserts its two derived kinds in between, so an item the graph
 * merely REACHED never outranks one the caller's own node ids named.
 */
const REASON_PRECEDENCE: readonly IntentContextMatchReason[] = [
  IntentContextMatchReason.ExactId,
  IntentContextMatchReason.Source,
  IntentContextMatchReason.NodeAnchor,
  IntentContextMatchReason.NodeDerived,
  IntentContextMatchReason.Text,
  IntentContextMatchReason.Attached,
  IntentContextMatchReason.Inherited,
  IntentContextMatchReason.Default,
];

export function strongerReason(
  left: IntentContextMatchReason,
  right: IntentContextMatchReason,
): IntentContextMatchReason {
  return REASON_PRECEDENCE.indexOf(left) <= REASON_PRECEDENCE.indexOf(right) ? left : right;
}

/**
 * How a §6.2 applicability hit reads as a context match reason.
 *
 * `anchor_in_area` in the REVERSE direction means the anchor sits on a node the
 * caller named, which is the same statement as `node_anchor`; everything else
 * the graph concluded (a called guard, a feature whose area covers the node) is
 * `node_derived`. The full derivation reason list travels alongside, so nothing
 * is lost in the narrowing.
 */
export function reasonForDerivedHit(reasons: readonly IntentDerivationMatchReason[]): IntentContextMatchReason {
  return reasons.includes(IntentDerivationMatchReason.AnchorInArea)
    ? IntentContextMatchReason.NodeAnchor
    : IntentContextMatchReason.NodeDerived;
}

/** Where an item sits relative to the requested tree scope. */
export function attachmentReason(
  item: { domainId: string | null; featureId: string | null },
  scope: { domainId: string; featureId: string | null },
): IntentContextMatchReason {
  if (scope.featureId !== null) {
    return item.featureId === scope.featureId ? IntentContextMatchReason.Attached : IntentContextMatchReason.Inherited;
  }
  // A domain scope: the domain's own branch is `attached`, the product root
  // above it is `inherited`.
  return item.domainId === scope.domainId ? IntentContextMatchReason.Attached : IntentContextMatchReason.Inherited;
}

/** One selected item before it is hydrated into a response. */
export interface SelectedMatch {
  id: string;
  authorityRank: number;
  reason: IntentContextMatchReason;
  derivedReasons?: IntentDerivationMatchReason[];
  /** Query tokens this item hit; only the disjunctive fallback ranks by it. */
  hits?: number;
  taskScore?: number;
  matchReasons?: IntentContextMatchReason[];
}

/**
 * The total order every truncation relies on: accepted before candidate, then
 * id. Ids are unique per workspace, so the order is total and truncation drops
 * the same tail on every run.
 */
export function compareMatches(left: SelectedMatch, right: SelectedMatch): number {
  return left.authorityRank - right.authorityRank || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** The fallback's order: token-hit count first, then the ordinary total order. */
export function compareFallbackMatches(left: SelectedMatch, right: SelectedMatch): number {
  return (right.hits ?? 0) - (left.hits ?? 0) || compareMatches(left, right);
}

/**
 * Merge hits for one item, keeping the strongest reason and every derivation
 * reason that explained it.
 */
export function mergeMatches(matches: readonly SelectedMatch[]): SelectedMatch[] {
  const byId = new Map<string, SelectedMatch>();
  for (const match of matches) {
    const existing = byId.get(match.id);
    if (!existing) {
      byId.set(match.id, { ...match });
      continue;
    }
    existing.reason = strongerReason(existing.reason, match.reason);
    if (match.taskScore !== undefined) existing.taskScore = (existing.taskScore ?? 0) + match.taskScore;
    if (match.matchReasons)
      existing.matchReasons = [...new Set([...(existing.matchReasons ?? []), ...match.matchReasons])];
    if (match.derivedReasons) {
      const merged = new Set([...(existing.derivedReasons ?? []), ...match.derivedReasons]);
      existing.derivedReasons = [...merged];
    }
  }
  return [...byId.values()];
}

/**
 * Does this request select at all?
 *
 * A PRESENT selector array is a selector, empty or not (core's rule): only a
 * request that named no selector of any kind means "the workspace's current
 * accepted intent". The tree scope counts as one — asking about a feature is a
 * question, not a filter on an unasked one.
 */
export function hasSelector(request: {
  intentIds?: string[];
  nodeIds?: string[];
  sourceRefs?: string[];
  query?: string;
  task?: string;
  domain?: string;
  feature?: string;
}): boolean {
  return (
    request.task !== undefined ||
    request.intentIds !== undefined ||
    request.nodeIds !== undefined ||
    request.sourceRefs !== undefined ||
    (request.query !== undefined && request.query.length > 0) ||
    request.domain !== undefined ||
    request.feature !== undefined
  );
}

/**
 * Source refs split for comparison: a `jira:<KEY>` ref ignores the key's case
 * (Jira keys are case-insensitive), every other ref compares exactly.
 */
export function sourceRefMatchSets(refs: readonly string[]): { exact: string[]; caseless: string[] } {
  const exact: string[] = [];
  const caseless: string[] = [];
  for (const ref of refs) {
    if (/^jira:/i.test(ref)) caseless.push(ref.toLowerCase());
    else exact.push(ref);
  }
  return { exact, caseless };
}

/**
 * Escape a lexical token for `ILIKE`.
 *
 * The token is caller text: an unescaped `%` would turn `100%` into a wildcard
 * and quietly widen the answer (the same class of leak as an unescaped Prisma
 * `contains`). Backslash is PostgreSQL's default LIKE escape character.
 */
export function likePattern(token: string): string {
  return `%${escapeLike(token)}%`;
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * ONE `LIKE` pattern per requested `{repoHash}:file:{path}` id — the file-to-
 * member half of the two-way anchor rule, which `IN (...)` cannot express
 * because the member names are unknown.
 *
 * One escaped pattern per file pins its hash and path. The server also checks
 * the four-segment shape, non-empty name, and PATH_SCOPED_NODE_KINDS inside SQL,
 * before bounding eligible items, matching core’s file-scope rule.
 */
export function fileMemberLikePatterns(nodeIds: readonly string[]): string[] {
  const patterns: string[] = [];
  for (const nodeId of nodeIds) {
    const parts = nodeId.split(':');
    if (parts.length !== 3 || parts[1] !== 'file' || !parts[0] || !parts[2]) continue;
    const [repoHash, , path] = parts as [string, string, string];
    patterns.push(`${escapeLike(repoHash)}:%:${escapeLike(path)}:%`);
  }
  return [...new Set(patterns)];
}

/** Every selector fetches one row past its bound, so only an actual cut reports truncation. */
export function nodeSelectionTruncated(counts: {
  anchoredRows: number;
  anchorScan: number;
  anchoredCandidateRows: number;
  attachedCandidateRows: number;
  derivationBound: number;
  attachedPageInUse: boolean;
}): boolean {
  return (
    counts.anchoredRows > counts.anchorScan ||
    counts.anchoredCandidateRows > counts.derivationBound ||
    (counts.attachedPageInUse && counts.attachedCandidateRows > counts.derivationBound)
  );
}

/** Merge discovery sources before applying their shared cap; source order cannot outrank authority. */
export function mergeDerivationCandidates(
  rows: readonly { id: string; authorityRank: number }[],
  limit: number,
): { rankById: Map<string, number>; truncated: boolean } {
  const ranks = new Map<string, number>();
  for (const row of rows) ranks.set(row.id, Math.min(ranks.get(row.id) ?? row.authorityRank, row.authorityRank));
  const ordered = [...ranks].sort(
    ([leftId, leftRank], [rightId, rightRank]) =>
      leftRank - rightRank || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
  );
  return { rankById: new Map(ordered.slice(0, limit)), truncated: ordered.length > limit };
}
