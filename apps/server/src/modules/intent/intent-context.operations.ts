/**
 * Request shape of the agent CONTEXT read (spec §7), and the vocabulary its
 * answers speak.
 *
 * It lives here rather than in `contract/` because it is a transport-shaped
 * query with its own normalising — repeated/comma query parameters, a page
 * cursor, an observed-checkout encoding — none of which an MCP tool expresses
 * this way. The
 * primitives (`slugId`, bounds, `parseContract`) still come from `contract/`, so
 * a slug or a node id cannot mean two different things on the two surfaces.
 *
 * Everything here is PURE: parsing and normalising a request, with no database
 * and no graph. `intent-context.select.ts` holds the equally pure selection
 * semantics, and `intent-context.service.ts` is the only part that touches rows.
 */
import {
  INTENT_CONTEXT_LIMITS,
  IntentContextSchema,
  IntentKind,
  defaultIntentLimit,
  type IntentContext,
} from '@coredoc/core';
import type { ObservedCheckout } from '@coredoc/db';
import { z } from 'zod';
import {
  IntentErrorCode,
  INTENT_CONTRACT_LIMITS,
  intentContractViolation,
  IntentPublicException,
  parseContract,
  repoKey,
  slugId,
} from './contract/index.js';
import { parseIntentPageLimit } from './intent-cursor.js';
import { intentStateError } from './intent-state-errors.js';

/**
 * The two answers this endpoint can give (spec §7).
 *
 * `context` is the expensive one — payloads, sources, anchors with their §6.4
 * status, and graph provenance. `list` is the payload-free index: what a caller
 * needs to orient or to page, and nothing that costs a graph lease.
 */
export enum IntentContextMode {
  Context = 'context',
  List = 'list',
}

/**
 * Why an item is in the answer.
 *
 * A superset of `@coredoc/core`'s `IntentMatchReason` (`exact_id`,
 * `node_anchor`, `text`, `default`) — the four the local overlay read already
 * speaks, kept VERBATIM so an agent that learned them locally reads a cloud
 * answer without a translation table. TypeScript cannot extend an enum, so the
 * four are restated and `intent-context.operations.test.ts` guards the superset
 * relation (the same device `IntentAuthorizingSourceKind` uses).
 *
 * The additions are the cloud's own: a tree it has that the overlay does
 * not (`attached`/`inherited`, §6.2), graph-derived applicability
 * (`node_derived`), which no local read can compute, and the recorded source
 * an item was captured from (`source`).
 */
export enum IntentContextMatchReason {
  /** Requested by exact intent id — the only path to a rejected/superseded item. */
  ExactId = 'exact_id',
  /** An item anchor names a requested node id, or an ENCLOSING scope of one. */
  NodeAnchor = 'node_anchor',
  /** The graph placed the item against the requested nodes (§6.2) — see `derivedReasons`. */
  NodeDerived = 'node_derived',
  /** Lexical match on title, statement, or rationale. */
  Text = 'text',
  /** An item source's `ref` equals a requested source ref (a `jira:` key compares case-insensitively). */
  Source = 'source',
  /** Attached to the requested feature (or, for a domain scope, inside that domain). */
  Attached = 'attached',
  /** Attached higher up the requested branch: the domain, or the product root. */
  Inherited = 'inherited',
  /** No selector was supplied: the workspace's current accepted intent. */
  Default = 'default',
}

/**
 * Server-enforced bounds this read cannot be talked out of.
 *
 * The ITEM bound is `INTENT_CONTEXT_LIMITS` imported from `@coredoc/core` — the
 * same 1..20/5 the local tool applies — because an agent must not get a
 * different-sized answer for the same question depending on which surface it
 * asked. The values below are the ones only a SQL-backed read needs.
 */
export const INTENT_CONTEXT_READ_LIMITS = {
  /** Exact ids per request. A routed handoff is a short list, not a bulk export. */
  intentIds: 50,
  /** Node ids per request: a diff's changed symbols, not a whole checkout. */
  nodeIds: 50,
  /** `kind` values per request: every kind, each named once. */
  kinds: Object.values(IntentKind).length,
  /** Source refs per request: a handful of tickets or specs, not a bulk export. */
  sourceRefs: 10,
  /** Items one source-ref read may add beside the exact ids. */
  sourceItems: 200,
  query: 200,
  task: 2000,
  /** Bytes of the REST `context` JSON parameter. */
  context: 4000,
  /** Tokens taken from `query`; extra tokens are refused, never silently dropped. */
  queryTokens: 10,
  observed: 20,
  /**
   * Rows a selector may examine before the answer is marked `truncated`. It
   * bounds the SET the ordering is total over, so truncation drops the same tail
   * on every run instead of whatever the planner happened to return first.
   */
  candidateScan: 500,
  /**
   * The same window when a reader `context` filters it: conditions run in the
   * app after the scan, so excluded rows would otherwise crowd out matches.
   * ponytail: 4x candidateScan is the ceiling; past it evaluate dimension clauses
   * SQL-side (JSONB predicates on applies_when) instead of widening the scan.
   */
  contextCandidateScan: 2000,
  /** Items handed to derivation for the node selector (§6.1 bounds do the rest). */
  derivationItems: 200,
  /** Features whose derived area may claim the queried nodes. */
  features: 100,
  /** Declared ids named back in an `unknown domain`/`unknown feature` refusal. */
  namedValues: 50,
} as const;

/**
 * Tasks are ephemeral search text, not stored statements. Line wrapping has no
 * search meaning, so normalise it before the shared content walk applies its
 * stored-body heuristic. Keep the task length and other content guards intact.
 * Shared by REST and hosted MCP; overwrite preserves the advertised string schema.
 */
export const IntentContextTaskSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTENT_CONTEXT_READ_LIMITS.task)
  .overwrite((task) => task.replace(/\n/g, ' '));

/** A query parameter that may arrive once or repeated. */
const repeatable = z.union([z.string(), z.array(z.string().max(INTENT_CONTRACT_LIMITS.nodeId))]);

/** Files supplied from the checkout; the server resolves their registered graph identity. */
export const IntentContextFileSchema = z
  .object({
    repoKey,
    path: z
      .string()
      .min(1)
      .max(INTENT_CONTRACT_LIMITS.nodeId)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          !path.includes(':') &&
          !path.split('/').some((part) => part === '..' || part === '.' || part === ''),
        'Use a repository-relative path with forward slashes',
      ),
  })
  .strict();

/**
 * The wire shape. Everything is a string because it is a query string; the
 * semantic parse is {@link normalizeIntentContextRequest}, which is where the
 * refusals with real messages live.
 */
export const IntentContextQuerySchema = z
  .object({
    mode: z.enum(IntentContextMode).optional(),
    intentIds: repeatable.optional(),
    query: z.string().max(INTENT_CONTEXT_READ_LIMITS.query).optional(),
    task: IntentContextTaskSchema.optional(),
    files: z.union([z.string(), z.array(z.string()).max(INTENT_CONTEXT_READ_LIMITS.nodeIds)]).optional(),
    nodeIds: repeatable.optional(),
    sourceRefs: z
      .union([z.string().max(INTENT_CONTRACT_LIMITS.ref), z.array(z.string().max(INTENT_CONTRACT_LIMITS.ref))])
      .optional(),
    domain: slugId().optional(),
    feature: slugId().optional(),
    // NOT `z.enum(IntentKind)`: an unknown kind must be refused with the six
    // valid values named (spec §12), not with a generic shape error.
    kind: z
      .union([
        z.string().max(INTENT_CONTRACT_LIMITS.slugId),
        z.array(z.string().max(INTENT_CONTRACT_LIMITS.slugId)).min(1).max(INTENT_CONTEXT_READ_LIMITS.kinds),
      ])
      .optional(),
    includeCandidates: z.enum(['true', 'false']).optional(),
    includeDiagnostics: z.enum(['true', 'false']).optional(),
    effectivity: z.enum(['true', 'false']).optional(),
    /** JSON object `{dimensionId: valueId | valueId[]}`, like each `files` entry. */
    context: z.string().max(INTENT_CONTEXT_READ_LIMITS.context).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
    observed: repeatable.optional(),
  })
  .strict();

export type IntentContextQuery = z.infer<typeof IntentContextQuerySchema>;

/** The tree scope a request asks about, after it has been resolved against the tree. */
export interface IntentContextScope {
  domainId: string;
  /** Null for a domain-wide scope. */
  featureId: string | null;
}

/** A normalised, bounded context request. */
export interface IntentContextRequest {
  mode: IntentContextMode;
  /**
   * PRESENT-BUT-EMPTY IS A SELECTOR. `intentIds=` (or `nodeIds=`) is a caller
   * that computed a selector and came up with nothing — answering it with the
   * default accepted set would be the widest possible answer to the narrowest
   * possible question. `undefined` means the caller did not select that way at all.
   */
  intentIds?: string[];
  query?: string;
  task?: string;
  files?: Array<z.infer<typeof IntentContextFileSchema>>;
  nodeIds?: string[];
  /** Source refs; present-but-empty is a selector like the id lists above. */
  sourceRefs?: string[];
  domain?: string;
  feature?: string;
  kinds?: IntentKind[];
  includeCandidates: boolean;
  includeDiagnostics?: boolean;
  effectivity?: boolean;
  /**
   * Reader context over declared dimensions. When present, items whose
   * `appliesWhen` is false for it are dropped and every returned item carries
   * `contextMatch`; when absent the answer is exactly the unfiltered one.
   */
  context?: IntentContext;
  /** Items per response (context mode, core's bound) or per page (list mode). */
  limit: number;
  cursor?: string;
  /** Observed checkout per DURABLE repo key; absent repos stay `unverified` (§6.3). */
  observed: Record<string, ObservedCheckout>;
}

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function tooMany(field: string, max: number): never {
  throw intentContractViolation(
    IntentErrorCode.SchemaViolation,
    `A context read accepts at most ${max} ${field} values`,
    [field],
  );
}

/**
 * Exact ids: comma-separated, repeated, or both.
 *
 * Splitting on commas is safe HERE and nowhere else on this endpoint: an intent
 * id is a slug (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), so a comma can never be part
 * of one. A node id can contain almost anything, which is why `nodeIds` takes
 * repeated parameters only — splitting one would silently truncate an id and
 * return a confidently wrong empty answer.
 */
function parseIntentIds(raw: string | string[] | undefined): string[] | undefined {
  const values = toArray(raw);
  if (values === undefined) return undefined;
  const ids: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const id = part.trim();
      if (id.length === 0) continue;
      if (ids.length >= INTENT_CONTEXT_READ_LIMITS.intentIds)
        tooMany('intentIds', INTENT_CONTEXT_READ_LIMITS.intentIds);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function parseNodeIds(raw: string | string[] | undefined): string[] | undefined {
  const values = toArray(raw);
  if (values === undefined) return undefined;
  const nodeIds: string[] = [];
  for (const value of values) {
    const nodeId = value.trim();
    if (nodeId.length === 0) continue;
    if (nodeIds.length >= INTENT_CONTEXT_READ_LIMITS.nodeIds) tooMany('nodeIds', INTENT_CONTEXT_READ_LIMITS.nodeIds);
    if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
  }
  return nodeIds;
}

/** Source refs: repeated only — a ref (a path, a URL) may contain a comma. */
function parseSourceRefs(raw: string | string[] | undefined): string[] | undefined {
  const values = toArray(raw);
  if (values === undefined) return undefined;
  const refs: string[] = [];
  for (const value of values) {
    const ref = value.trim();
    if (ref.length === 0) continue;
    if (refs.length >= INTENT_CONTEXT_READ_LIMITS.sourceRefs)
      tooMany('sourceRefs', INTENT_CONTEXT_READ_LIMITS.sourceRefs);
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** The ONE observed-state mechanism: `observed=<repoKey>@<commit>` or `…@<commit>:dirty`. */
const OBSERVED_COMMIT = /^([0-9a-f]{7,64})(:dirty)?$/i;

/**
 * Observed checkout state, repeated once per repository.
 *
 * `observed=github.com/acme/orders-api@<sha>[:dirty]`. Splitting at the LAST
 * `@` keeps a durable repo key that itself contains one unambiguous, and the
 * commit half is hex so the `:dirty` suffix cannot be confused with it.
 *
 * A repository the caller says nothing about stays `unverified` (§6.3): freshness
 * is never asserted by omission, so there is deliberately no "everything is
 * current" switch.
 */
function parseObserved(raw: string | string[] | undefined): Record<string, ObservedCheckout> {
  const values = toArray(raw) ?? [];
  if (values.length > INTENT_CONTEXT_READ_LIMITS.observed) tooMany('observed', INTENT_CONTEXT_READ_LIMITS.observed);
  const observed: Record<string, ObservedCheckout> = {};
  for (const value of values) {
    const separator = value.lastIndexOf('@');
    const repoKey = separator > 0 ? value.slice(0, separator).trim() : '';
    const state = separator > 0 ? value.slice(separator + 1).trim() : '';
    const match = OBSERVED_COMMIT.exec(state);
    if (!repoKey || !match) {
      throw intentContractViolation(
        IntentErrorCode.SchemaViolation,
        'observed must be "<repoKey>@<commit>" with an optional ":dirty" suffix',
        ['observed'],
      );
    }
    observed[repoKey] = { commit: (match[1] as string).toLowerCase(), dirty: match[2] !== undefined };
  }
  return observed;
}

/** A structured value carried as one JSON query parameter (REST) or re-encoded from a native MCP value. */
function parseJsonParameter<T>(field: string, raw: string, schema: z.ZodType<T>, shape: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw intentContractViolation(IntentErrorCode.SchemaViolation, `Each ${field} parameter is ${shape}`, [field]);
  }
  try {
    return parseContract(schema, decoded);
  } catch (error) {
    if (!(error instanceof IntentPublicException)) throw error;
    // The decoded value's paths are relative to it; the caller named the parameter.
    const { code, message, path, details } = error.publicError;
    throw intentContractViolation(
      code,
      message,
      [field, ...path],
      details?.map((detail) => ({ ...detail, path: [field, ...detail.path] })),
    );
  }
}

/** Kinds: comma-separated, repeated, or both (a kind is a slug). Fail fast on one outside the closed set, naming the six. */
function parseKinds(raw: string | string[] | undefined): IntentKind[] | undefined {
  const values = toArray(raw)?.flatMap((value) => value.split(',').map((part) => part.trim()));
  if (values === undefined) return undefined;
  const known = Object.values(IntentKind);
  const kinds: IntentKind[] = [];
  for (const value of values) {
    if (!known.includes(value as IntentKind)) {
      throw intentStateError(
        IntentErrorCode.UnknownKind,
        `intent kind '${value}' is not a known intent kind; valid kinds: ${known.join(', ')}`,
        ['kind'],
      );
    }
    if (!kinds.includes(value as IntentKind)) kinds.push(value as IntentKind);
  }
  return kinds;
}

/**
 * `limit` for CONTEXT mode: an integer inside `INTENT_CONTEXT_LIMITS`.
 *
 * Refused rather than clamped, unlike the local tool's `clampIntentLimit`: this
 * is a REST parameter, where `limit=100` is a caller that believes it will get a
 * hundred items, and silently handing back twenty is how a client ships a bug.
 * The bound itself is core's, so the two surfaces answer the same size.
 */
function parseContextLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > INTENT_CONTEXT_LIMITS.max) {
    throw intentStateError(
      IntentErrorCode.InvalidPageLimit,
      `limit must be an integer between ${INTENT_CONTEXT_LIMITS.min} and ${INTENT_CONTEXT_LIMITS.max} in context mode`,
      ['limit'],
    );
  }
  return Number(raw);
}

/** Tokens of the lexical selector: lowercase, whitespace-split, bounded. */
export function intentQueryTokens(query: string | undefined): string[] {
  if (query === undefined) return [];
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length > INTENT_CONTEXT_READ_LIMITS.queryTokens) {
    tooMany('query', INTENT_CONTEXT_READ_LIMITS.queryTokens);
  }
  return tokens;
}

/**
 * In LIST mode, more exact ids than one page holds is a REFUSAL.
 *
 * The list mode pages, and its cursor pages the DISCOVERED set by
 * `(authorityRank, id)` — an order that has nothing to do with the order the
 * caller listed its ids in. So exact ids ride page one and page one only, and a
 * first page that could not hold them all previously answered `truncated: true`
 * with `nextCursor: null`: a dead end that names no way to reach the rest.
 * Naming the limit instead lets the caller raise it or split the lookup, both of
 * which preserve their order.
 *
 * The CONTEXT mode is deliberately not covered: it does not page at all, and it
 * already reports `omittedCount` and `totalMatched` alongside the ids it did
 * return, in the order they were asked for. That is a bounded answer, not a dead
 * end.
 *
 * Applied to what was ASKED FOR, not to what exists: a caller that requested 30
 * ids into a page of 10 has a bug whether or not this workspace happens to hold
 * them, and "it worked until the ids existed" is the worse failure.
 */
function assertExactIdsFitTheAnswer(mode: IntentContextMode, intentIds: string[] | undefined, limit: number): void {
  if (mode !== IntentContextMode.List || intentIds === undefined || intentIds.length <= limit) return;
  throw intentContractViolation(
    IntentErrorCode.SchemaViolation,
    `A list page holds at most ${limit} entries, and ${intentIds.length} exact intentIds were requested. ` +
      'Raise limit or split the lookup: exact ids ride the first page and are never paged.',
    ['intentIds'],
  );
}

/**
 * Wire shape → normalised request.
 *
 * Pure and total: every refusal it raises is a caller-caused one with a message
 * that states the rule.
 */
export function normalizeIntentContextRequest(query: IntentContextQuery): IntentContextRequest {
  const mode = query.mode ?? IntentContextMode.Context;
  const text = query.query?.trim();
  if (query.task !== undefined && (mode !== IntentContextMode.Context || text)) {
    throw intentContractViolation(
      IntentErrorCode.SchemaViolation,
      'task is a context selector and cannot be combined with query or list mode',
      ['task'],
    );
  }
  if (query.files !== undefined && query.task === undefined) {
    throw intentContractViolation(IntentErrorCode.SchemaViolation, 'files accompanies the task selector', ['files']);
  }
  const files = toArray(query.files)?.map((value) =>
    parseJsonParameter('files', value, IntentContextFileSchema, 'a JSON object with repoKey and path'),
  );
  if ((files?.length ?? 0) > INTENT_CONTEXT_READ_LIMITS.nodeIds) tooMany('files', INTENT_CONTEXT_READ_LIMITS.nodeIds);
  // Bytes, on the raw string: REST's schema bounds characters, and MCP hands a
  // JSON.stringify of its native object straight here.
  if (query.context !== undefined && Buffer.byteLength(query.context) > INTENT_CONTEXT_READ_LIMITS.context) {
    throw intentContractViolation(
      IntentErrorCode.SchemaViolation,
      `context accepts at most ${INTENT_CONTEXT_READ_LIMITS.context} bytes of JSON`,
      ['context'],
    );
  }
  const context =
    query.context === undefined
      ? undefined
      : parseJsonParameter(
          'context',
          query.context,
          IntentContextSchema,
          'a JSON object of dimension ids to value ids',
        );
  const intentIds = parseIntentIds(query.intentIds);
  // Two bounds because they bound two different things: a context response is a
  // handful of payloads (core's 1..20), a list page is an index (1..200). An
  // omitted context limit stretches to cover exact ids (core's
  // `defaultIntentLimit`), so both read surfaces answer an N-id request the same
  // way instead of truncating it into a second call.
  const limit =
    mode === IntentContextMode.Context
      ? (parseContextLimit(query.limit) ?? defaultIntentLimit(intentIds?.length ?? 0))
      : parseIntentPageLimit(query.limit);
  if (mode === IntentContextMode.Context && query.cursor) {
    throw intentStateError(
      IntentErrorCode.CursorNotSupported,
      'A cursor pages the list mode; a context read is bounded by limit and reports truncation instead',
      ['cursor'],
    );
  }
  const nodeIds = parseNodeIds(query.nodeIds);
  if ((files?.length ?? 0) + (nodeIds?.length ?? 0) > INTENT_CONTEXT_READ_LIMITS.nodeIds)
    tooMany('files and nodeIds', INTENT_CONTEXT_READ_LIMITS.nodeIds);
  const kinds = parseKinds(query.kind);
  const sourceRefs = parseSourceRefs(query.sourceRefs);
  assertExactIdsFitTheAnswer(mode, intentIds, limit);
  return {
    mode,
    ...(intentIds === undefined ? {} : { intentIds }),
    // A blank query is NOT a text selector (core's rule): it selects nothing and
    // must not turn an otherwise unselected request into an empty answer.
    ...(text ? { query: text } : {}),
    ...(query.task === undefined ? {} : { task: query.task }),
    ...(files === undefined ? {} : { files }),
    ...(nodeIds === undefined ? {} : { nodeIds }),
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
    ...(query.domain ? { domain: query.domain } : {}),
    ...(query.feature ? { feature: query.feature } : {}),
    ...(kinds ? { kinds } : {}),
    includeCandidates: query.includeCandidates === 'true',
    ...(query.includeDiagnostics === undefined ? {} : { includeDiagnostics: query.includeDiagnostics === 'true' }),
    ...(query.effectivity === undefined ? {} : { effectivity: query.effectivity === 'true' }),
    ...(context === undefined ? {} : { context }),
    limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    observed: parseObserved(query.observed),
  };
}
