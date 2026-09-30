/**
 * Deterministic selection over a loaded intent overlay.
 *
 * This is the ONE selection implementation behind both agent read surfaces
 * (`coredoc intent context` and the local `get_intent_context` MCP tool), so a
 * human and an agent asking the same question get the same items in the same
 * order. It is pure: no filesystem, no graph, no clock, no randomness — code
 * anchors are only READ here (matching by node id); resolving them into
 * evidence belongs to `@coredoc/db`.
 *
 * Selection semantics (spec "Agent context contract", BR-13):
 *
 * - Exact `intentIds` win over text matching and are the ONLY way to reach a
 *   `rejected` or `superseded` item.
 * - Text matching is deterministic lexical AND-matching (see
 *   {@link matchesQuery}), with a single disjunctive FALLBACK when that returns
 *   nothing (see {@link countQueryHits}); no embedding, ranking model, or fuzzy
 *   merge.
 * - `nodeIds` match items whose stored code anchors reference those stable node
 *   ids or an ENCLOSING scope of them (a method query reaches its class and
 *   file anchors), and a FILE query also reaches anchors on that file's members
 *   (see {@link enclosingNodeIdCandidates}).
 * - With no selector at all, the request means "the current accepted intent of
 *   this project", bounded by the same limit. An ABSENT selector is not an empty
 *   one: `nodeIds: []` is a selector that matched nothing and returns nothing.
 *
 * The module also owns the payload-free INDEX read ({@link listIntentIndex}),
 * the cheap orientation surface behind `coredoc intent list` and the MCP tool's
 * list mode. It is a sibling of the context read, not a variant of it: it never
 * takes a selector, never returns payloads or relations, and carries its own,
 * larger bound ({@link INTENT_INDEX_LIMITS}).
 */
import type { IntentDomain, IntentFileV2, IntentItem, IntentRelation } from './types.js';
import { IntentAuthority, IntentKind } from './types.js';

/**
 * Response bound. The 1..20 range is the spec's; the default is deliberately
 * far below the maximum so an unqualified agent call stays cheap.
 *
 * PROVISIONAL: 5 is a compact starting point, not a measured optimum. Issue 06
 * (benchmark corpus) is what tunes it — change it there, with the corpus
 * evidence, not from intuition here.
 */
export const INTENT_CONTEXT_LIMITS = {
  min: 1,
  max: 20,
  default: 5,
  /**
   * Hard cap on the one-hop relations returned alongside the items. The item
   * limit does NOT bound them: a schema-max overlay may attach thousands of
   * relations to a single returned item, which would blow past the response
   * budget the item limit exists to protect.
   */
  relations: 50,
} as const;

/**
 * The fixed caveat every context response carries (LIM-2, spec "Agent context
 * contract"). Authored once here because BOTH read surfaces must state it
 * identically; a consumer that saw it on one surface and not the other could
 * read an unchanged anchor as proof the intent is satisfied.
 */
export const INTENT_ANCHOR_WARNING =
  'Code anchors are implementation touchpoints, not conformance proof: an unchanged anchor does not show the intent is satisfied, and the anchor set is not a complete list of the code that implements it.';

/** Why an item is in the result. Reported so a consumer can weigh an exact routed ID against a search hit. */
export enum IntentMatchReason {
  /** Requested by exact intent ID (BR-8 routed handoff). */
  ExactId = 'exact_id',
  /** An item code anchor references a requested node id. */
  NodeAnchor = 'node_anchor',
  /** Lexical match on the item's text. */
  Text = 'text',
  /** No selector was supplied: the project's current accepted intent. */
  Default = 'default',
}

/**
 * Bound on ONE index response (BR-27).
 *
 * Deliberately its own constant, an order of magnitude above
 * {@link INTENT_CONTEXT_LIMITS}: an index entry is five short fields, while a
 * context match carries a typed payload, sources, and anchors, so the two
 * surfaces cannot share a budget. It is a fixed cap, not a caller-supplied
 * limit — the index exists to orient in one call, and a caller that wants less
 * narrows by `domain`/`kind` instead of paging.
 */
export const INTENT_INDEX_LIMITS = {
  max: 100,
} as const;

/** A malformed index/context REQUEST: a filter naming a value the overlay or the schema does not know (BR-20/BR-24). */
export enum IntentQueryErrorCode {
  UnknownDomain = 'unknown_domain',
  UnknownKind = 'unknown_kind',
}

/**
 * A malformed REQUEST, never a miss.
 *
 * "No item is in domain `payments`" and "this overlay has no domain
 * `payments`" must not look alike: the first is an answer, the second means the
 * caller asked the wrong question and would otherwise read an empty result as
 * "no product intent applies".
 */
export class IntentQueryError extends Error {
  constructor(
    readonly code: IntentQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IntentQueryError';
  }
}

export interface IntentQueryRequest {
  /** Exact intent IDs; the only path to a rejected/superseded item. */
  intentIds?: string[];
  /**
   * Declared domain id. Filters DISCOVERED matches (text, node, default) and
   * composes with them; exact `intentIds` are exempt, because an exact routed
   * lookup stays authoritative (BR-8/BR-20).
   */
  domain?: string;
  /** Bounded lexical query over title, statement, and payload text. */
  query?: string;
  /** Stable code-node IDs; matches items anchored to them. */
  nodeIds?: string[];
  /** Opt-in required for `candidate` items (BR-13). */
  includeCandidates?: boolean;
  /** Clamped into {@link INTENT_CONTEXT_LIMITS}; omitted takes {@link defaultIntentLimit}. */
  limit?: number;
}

export interface IntentQueryMatch {
  item: IntentItem;
  matchReason: IntentMatchReason;
}

export interface IntentQueryResult {
  matches: IntentQueryMatch[];
  /** One-hop controlled relations with at least one endpoint among the returned items. */
  relations: IntentRelation[];
  /** Whether {@link INTENT_CONTEXT_LIMITS.relations} dropped some of those relations. */
  relationsTruncated: boolean;
  /** Relations that matched but were dropped by that cap. */
  omittedRelationCount: number;
  /** Effective limit after clamping. */
  limit: number;
  truncated: boolean;
  /** Items that matched but were dropped by the limit. */
  omittedCount: number;
  totalMatched: number;
  /** Requested IDs that do not exist in the overlay — a miss, not an error. */
  unknownIntentIds: string[];
}

/**
 * The limit an OMITTED `limit` takes: the compact default, stretched to cover
 * exact ids.
 *
 * `intentIds` is an exact selector, not a page: a caller that named N ids asked
 * N answerable questions, and truncating them forced a second call for ids the
 * caller already had. Only the exact selector stretches — `query`, `nodeIds`,
 * and a bare read discover an unknown-sized set, which is what the compact
 * default exists to bound — and the same `max` an explicit limit is clamped to
 * still applies, so no surface can be talked into an unbounded answer.
 */
export function defaultIntentLimit(intentIdCount = 0): number {
  return Math.min(INTENT_CONTEXT_LIMITS.max, Math.max(INTENT_CONTEXT_LIMITS.default, intentIdCount));
}

/** Clamp a caller-supplied limit; an absent or non-numeric value takes {@link defaultIntentLimit}. */
export function clampIntentLimit(limit?: number, intentIdCount = 0): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return defaultIntentLimit(intentIdCount);
  return Math.min(INTENT_CONTEXT_LIMITS.max, Math.max(INTENT_CONTEXT_LIMITS.min, Math.floor(limit)));
}

/**
 * Searchable text of one item: its title, statement, and every string leaf of
 * its typed payload (payload strings carry the actual product semantics —
 * conditions, outcomes, rationales — so excluding them would make the query
 * surface title-only).
 *
 * Source refs and code anchors are deliberately NOT searchable: they are
 * identities (`spec/widget-ordering`, `aaaa:function:…`), and matching them
 * lexically would make an unrelated query hit every item from one document.
 */
function searchableText(item: IntentItem): string {
  const parts: string[] = [item.title, item.statement];
  collectStrings(item.payload, parts);
  return parts.join('\n').toLowerCase();
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStrings(entry, out);
  }
}

/**
 * The exact text rule: lowercase the item's searchable text, split the query on
 * whitespace, and require EVERY token to appear as a substring. AND rather than
 * OR keeps a multi-word query narrowing (the same rule `search_symbols` uses);
 * substring rather than token equality lets `order` find `ordering` without any
 * stemmer. A misspelling matches nothing — by design (LIM-3: no fuzzy layer).
 */
function matchesQuery(text: string, tokens: string[]): boolean {
  return tokens.every((token) => text.includes(token));
}

/**
 * How many query tokens this text contains — the ranking key of the DISJUNCTIVE
 * FALLBACK.
 *
 * The rule, in full: conjunction first for precision; disjunction only when the
 * conjunction discovered NOTHING; never mixed. A multi-word query is a phrase a
 * human typed, and requiring every token is right whenever it hits — but when
 * it hits nothing the caller gets "this project has no product intent here",
 * which is a different and usually false statement (the pilot's "warehouse
 * stock shortfall" missed an overlay carrying both a warehouse limit and a
 * stock rule). So an empty conjunctive result re-matches with any-token
 * semantics, ordered by how many tokens each item hit, then by the ordinary
 * accepted-before-candidate + id order.
 *
 * Deterministic and total: the ranking key is an integer count over a fixed
 * token list and ties fall through to the same total order truncation already
 * relies on. Because the fallback only runs from an EMPTY result it cannot
 * reorder, dilute, or add to any query that already matched.
 */
function countQueryHits(text: string, tokens: string[]): number {
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits;
}

function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Whether a non-exact match may return this item.
 *
 * `rejected`/`superseded` are unreachable here on purpose: retained for
 * provenance, they can only be pulled by exact ID (BR-13).
 */
function passesAuthorityFilter(item: IntentItem, includeCandidates: boolean): boolean {
  if (item.authority === IntentAuthority.Accepted) return true;
  return includeCandidates && item.authority === IntentAuthority.Candidate;
}

/**
 * Node kinds whose stable id is `{repoHash}:{kind}:{path}:{name}` — the third
 * segment really is a file path (see `StableIdGenerator` in `id-generator.ts`).
 * Hashed kinds (`entrypoint`, `route`) and edge kinds are deliberately absent:
 * their third segment is a type token or a digest, so deriving a file id from
 * it would invent an anchor that never existed.
 */
const PATH_SCOPED_NODE_KINDS = new Set([
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
 * A review agent asks about the node it is editing (a method), while an intent
 * item is usually anchored one level out (the class, or the file). Exact-id
 * equality made that lookup silently empty, so the rule is: an anchor on an
 * enclosing scope governs the member inside it.
 *
 * - `hash:method:path:Outer.Inner.member` → itself, both enclosing classes, `hash:file:path`
 * - `hash:function:path:name` → itself, `hash:file:path`
 * - any other path-scoped node → itself, `hash:file:path`
 *
 * A bare `hash:file:path` query expands to nothing here; it reaches the members
 * of that file through {@link fileScopeOfAnchor} instead, so the rule is
 * TWO-WAY: an enclosing anchor covers its members, and a file query covers
 * items anchored to any path-scoped member of that file (an agent about to edit
 * a file asks about the file, while the item is anchored on one function in it).
 *
 * Anything that does not parse as a stable node id degrades to exact matching.
 */
function enclosingNodeIdCandidates(nodeId: string): string[] {
  const parts = nodeId.split(':');
  // `{repoHash}:{kind}:{path}:{name}` — exactly four segments. A path holding a
  // ':' would land here too, and is treated as unparseable rather than guessed.
  if (parts.length !== 4) return [nodeId];

  const [repoHash, kind, path, name] = parts as [string, string, string, string];
  if (!repoHash || !path || !name || !PATH_SCOPED_NODE_KINDS.has(kind)) return [nodeId];

  const candidates = [nodeId, `${repoHash}:file:${path}`];
  if (kind === 'method') {
    // Python preserves the full nested owner (`Outer.Inner.method`), while
    // other substrates usually emit `Class.method`. Every proper dotted prefix
    // is an enclosing class candidate; the last segment is the method itself.
    const segments = name.split('.');
    for (let length = 1; length < segments.length; length++) {
      candidates.push(`${repoHash}:class:${path}:${segments.slice(0, length).join('.')}`);
    }
  }
  return candidates;
}

/** Every id an anchor may equal to satisfy one of the requested node ids. */
function expandNodeIds(nodeIds: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const nodeId of nodeIds) {
    for (const candidate of enclosingNodeIdCandidates(nodeId)) expanded.add(candidate);
  }
  return expanded;
}

/** The requested `{repoHash}:file:{path}` ids — the other half of the two-way rule. */
function requestedFileScopes(nodeIds: string[]): Set<string> {
  const scopes = new Set<string>();
  for (const nodeId of nodeIds) {
    const parts = nodeId.split(':');
    if (parts.length === 3 && parts[1] === 'file' && parts[0] && parts[2]) scopes.add(nodeId);
  }
  return scopes;
}

/**
 * The file a path-scoped member anchor lives in, or null for anything else.
 *
 * Built from the WHOLE id, so the match respects the repo hash and the exact
 * path: `src/a.ts` never reaches `src/a.ts.bak`, and a hashed kind whose third
 * segment is a type token never reads as a file member.
 */
function fileScopeOfAnchor(anchorNodeId: string): string | null {
  const parts = anchorNodeId.split(':');
  if (parts.length !== 4) return null;
  const [repoHash, kind, path, name] = parts as [string, string, string, string];
  if (!repoHash || !path || !name || !PATH_SCOPED_NODE_KINDS.has(kind)) return null;
  return `${repoHash}:file:${path}`;
}

const AUTHORITY_RANK: Record<IntentAuthority, number> = {
  [IntentAuthority.Accepted]: 0,
  [IntentAuthority.Candidate]: 1,
  [IntentAuthority.Superseded]: 2,
  [IntentAuthority.Rejected]: 3,
};

/** Fail fast on an undeclared domain, naming what the overlay does declare. */
function assertDeclaredDomain(file: IntentFileV2, domain: string | undefined): void {
  if (domain === undefined) return;
  if (file.domains.some((declared) => declared.id === domain)) return;
  const declared = file.domains.map((entry) => entry.id).join(', ') || '<none declared>';
  throw new IntentQueryError(
    IntentQueryErrorCode.UnknownDomain,
    `intent domain '${domain}' is not declared by this overlay; declared domains: ${declared}`,
  );
}

export function selectIntentContext(file: IntentFileV2, request: IntentQueryRequest = {}): IntentQueryResult {
  assertDeclaredDomain(file, request.domain);
  const limit = clampIntentLimit(request.limit, request.intentIds?.length ?? 0);
  const includeCandidates = request.includeCandidates === true;
  const byId = new Map(file.items.map((item) => [item.id, item]));

  // Exact IDs first, in the order asked for: a routed handoff's ordering is the
  // caller's own priority, and re-sorting it would fight BR-8.
  const exact: IntentQueryMatch[] = [];
  const unknownIntentIds: string[] = [];
  const seen = new Set<string>();
  for (const id of request.intentIds ?? []) {
    if (seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) {
      unknownIntentIds.push(id);
      seen.add(id);
      continue;
    }
    seen.add(id);
    exact.push({ item, matchReason: IntentMatchReason.ExactId });
  }

  const tokens = queryTokens(request.query);
  const nodeIds = expandNodeIds(request.nodeIds ?? []);
  const fileScopes = requestedFileScopes(request.nodeIds ?? []);
  const anchorMatches = (anchorNodeId: string): boolean => {
    if (nodeIds.has(anchorNodeId)) return true;
    if (fileScopes.size === 0) return false;
    const scope = fileScopeOfAnchor(anchorNodeId);
    return scope !== null && fileScopes.has(scope);
  };
  // A PRESENT selector array is a selector, empty or not. A caller that computed
  // `nodeIds` from a diff and matched no node asked the narrowest possible
  // question; answering it with the whole default accepted set — labelled
  // `default`, the only hint — is the widest possible answer, and the same
  // failure `malformedSelector` refuses for a wrong-typed selector. An empty
  // array here means "nothing matched", which is a legitimate result.
  const hasSelector = request.intentIds !== undefined || tokens.length > 0 || request.nodeIds !== undefined;

  // One searchable text per item, at most once: it is a recursive walk of the
  // whole typed payload, and the disjunctive fallback below re-visits every item
  // the conjunctive pass already walked.
  const searchTextByItem = new Map<IntentItem, string>();
  const searchTextOf = (item: IntentItem): string => {
    const cached = searchTextByItem.get(item);
    if (cached !== undefined) return cached;
    const text = searchableText(item);
    searchTextByItem.set(item, text);
    return text;
  };

  const discovered: IntentQueryMatch[] = [];
  for (const item of file.items) {
    if (seen.has(item.id)) continue;
    if (!passesAuthorityFilter(item, includeCandidates)) continue;
    if (request.domain !== undefined && item.domain !== request.domain) continue;

    let reason: IntentMatchReason | undefined;
    if (nodeIds.size > 0 && (item.codeAnchors ?? []).some((a) => anchorMatches(a.nodeId))) {
      reason = IntentMatchReason.NodeAnchor;
    } else if (tokens.length > 0 && matchesQuery(searchTextOf(item), tokens)) {
      reason = IntentMatchReason.Text;
    } else if (!hasSelector) {
      reason = IntentMatchReason.Default;
    }
    if (!reason) continue;

    seen.add(item.id);
    discovered.push({ item, matchReason: reason });
  }

  // Accepted before candidate, then intent ID — a total order over a set whose
  // ids are unique, so truncation drops the same items on every run.
  discovered.sort(
    (a, b) => AUTHORITY_RANK[a.item.authority] - AUTHORITY_RANK[b.item.authority] || (a.item.id < b.item.id ? -1 : 1),
  );

  // Disjunctive fallback (see {@link countQueryHits}): ONLY from an empty
  // conjunctive result, and only for a multi-token query — for one token the two
  // semantics are the same rule, so there is nothing to fall back to.
  if (discovered.length === 0 && tokens.length > 1) {
    const ranked: Array<{ item: IntentItem; hits: number }> = [];
    for (const item of file.items) {
      if (seen.has(item.id)) continue;
      if (!passesAuthorityFilter(item, includeCandidates)) continue;
      if (request.domain !== undefined && item.domain !== request.domain) continue;
      const hits = countQueryHits(searchTextOf(item), tokens);
      if (hits === 0) continue;
      ranked.push({ item, hits });
    }
    ranked.sort(
      (a, b) =>
        b.hits - a.hits ||
        AUTHORITY_RANK[a.item.authority] - AUTHORITY_RANK[b.item.authority] ||
        (a.item.id < b.item.id ? -1 : 1),
    );
    for (const { item } of ranked) {
      seen.add(item.id);
      discovered.push({ item, matchReason: IntentMatchReason.Text });
    }
  }

  const ordered = [...exact, ...discovered];
  const matches = ordered.slice(0, limit);
  const returnedIds = new Set(matches.map((match) => match.item.id));

  // Authored file order is a total, stable order over the relation array, so the
  // same overlay always yields the same relations before the cap.
  const attached = file.relations.filter((relation) => returnedIds.has(relation.from) || returnedIds.has(relation.to));
  const relations = attached.slice(0, INTENT_CONTEXT_LIMITS.relations);

  return {
    matches,
    relations,
    relationsTruncated: attached.length > relations.length,
    omittedRelationCount: attached.length - relations.length,
    limit,
    truncated: ordered.length > matches.length,
    omittedCount: ordered.length - matches.length,
    totalMatched: ordered.length,
    unknownIntentIds,
  };
}

// =============================================================================
// The payload-free index (BR-23..BR-27)
// =============================================================================

export interface IntentIndexRequest {
  /** Declared domain id; composes conjunctively with {@link kind} (BR-24). */
  domain?: string;
  /** One of the six semantic kinds; composes conjunctively with {@link domain} (BR-24). */
  kind?: IntentKind;
  /** Opt-in required for `candidate` items; rejected/superseded are never listed (BR-25). */
  includeCandidates?: boolean;
}

/** One listed item. Payload-free BY CONTRACT (BR-23) — the detail surfaces stay `intent context`/`intent status`. */
export interface IntentIndexEntry {
  id: string;
  title: string;
  kind: IntentKind;
  domain: string;
  authority: IntentAuthority;
}

export interface IntentIndexResult {
  /**
   * The full declared registry, ALWAYS in registry order and never narrowed by
   * the filters: it is what tells the caller which `domain` ids exist, so
   * hiding the ones the filter excluded would remove the answer the call was
   * made for (BR-23, and BR-19's declared-but-unused domains stay visible).
   */
  domains: Array<{ id: string; title: string }>;
  entries: IntentIndexEntry[];
  truncated: boolean;
  /** Entries that matched but were dropped by {@link INTENT_INDEX_LIMITS}.max. */
  omittedCount: number;
  totalMatched: number;
}

/** Kind enum DECLARATION order — the second ordering key (BR-27). */
const KIND_ORDER: IntentKind[] = Object.values(IntentKind);

/** Fail fast on a kind outside the closed set, naming the six the schema knows (BR-24). */
function assertKnownKind(kind: IntentKind | undefined): void {
  if (kind === undefined) return;
  if (KIND_ORDER.includes(kind)) return;
  throw new IntentQueryError(
    IntentQueryErrorCode.UnknownKind,
    `intent kind '${kind}' is not a known intent kind; valid kinds: ${KIND_ORDER.join(', ')}`,
  );
}

function registryOrder(domains: IntentDomain[]): Map<string, number> {
  return new Map(domains.map((domain, index) => [domain.id, index]));
}

/**
 * The payload-free browse surface: the domain registry plus the matching items
 * reduced to id/title/kind/domain/authority.
 *
 * Pure and deterministic, like {@link selectIntentContext}, and it holds three
 * rules the context read does not:
 *
 * - Filters compose conjunctively, and an undeclared domain or unknown kind is
 *   an ERROR naming the valid values — never an empty list, which a caller
 *   would read as "this overlay has nothing there" (BR-24).
 * - `rejected` and `superseded` items are unreachable here at all: BR-13 keeps
 *   them exact-ID-only, and an index has no exact-ID path (BR-25).
 * - Ordering is total — domain registry order, then kind enum order, then id —
 *   so truncation at {@link INTENT_INDEX_LIMITS}.max drops the same tail on
 *   every run (BR-27).
 */
export function listIntentIndex(file: IntentFileV2, request: IntentIndexRequest = {}): IntentIndexResult {
  assertDeclaredDomain(file, request.domain);
  assertKnownKind(request.kind);
  const includeCandidates = request.includeCandidates === true;
  const domainRank = registryOrder(file.domains);

  const matched = file.items.filter((item) => {
    if (!passesAuthorityFilter(item, includeCandidates)) return false;
    if (request.domain !== undefined && item.domain !== request.domain) return false;
    if (request.kind !== undefined && item.kind !== request.kind) return false;
    return true;
  });

  matched.sort(
    (a, b) =>
      // An item whose domain is not in the registry cannot exist in a validated
      // overlay; ranking it last keeps the sort total instead of undefined-NaN.
      (domainRank.get(a.domain) ?? file.domains.length) - (domainRank.get(b.domain) ?? file.domains.length) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const kept = matched.slice(0, INTENT_INDEX_LIMITS.max);

  return {
    domains: file.domains.map((domain) => ({ id: domain.id, title: domain.title })),
    entries: kept.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      domain: item.domain,
      authority: item.authority,
    })),
    truncated: matched.length > kept.length,
    omittedCount: matched.length - kept.length,
    totalMatched: matched.length,
  };
}
