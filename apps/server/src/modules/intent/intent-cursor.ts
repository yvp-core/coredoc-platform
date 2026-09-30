/**
 * Stable list cursors for the intent module (spec §7: "All list endpoints
 * paginate with stable cursors").
 *
 * Same shape as the delivery module's codec (`canonical-delivery-read.contract.ts`):
 * a versioned, scope-tagged, base64url-encoded JSON triple. It is
 * re-instantiated here rather than imported because the delivery codec is typed
 * over that module's own key kinds (timestamps, decimals, stage ids) and lives
 * inside its read contract; the intent module's keys are all opaque STRINGS
 * (slug ids and decimal row ids), which lets this codec stay a third of the
 * size. Two small codecs beat one shared codec that has to speak both
 * vocabularies (rule of three: this is the second instance, not the third).
 *
 * The properties that matter are the delivery codec's, kept verbatim:
 * - versioned, so a future key change invalidates old cursors instead of
 *   silently mis-paging;
 * - scope-tagged, so a cursor from one endpoint is refused by another rather
 *   than decoded into a nonsensical keyset;
 * - round-trip checked (`bytes.toString('base64url') !== raw`), so padded or
 *   mutated variants of a valid cursor are refused;
 * - bounded, so a cursor is never an attacker-sized allocation.
 */
import { intentStateError } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

/** One value per paginated endpoint. A cursor is only valid for the scope it was issued in. */
export enum IntentCursorScope {
  TreeDomains = 'tree-domains',
  Features = 'features',
  FeatureSeeds = 'feature-seeds',
  Items = 'items',
  /** The candidates-only review queue, keyset over (createdAt, id) OLDEST first. */
  ReviewQueue = 'review-queue',
  /** The context read's `list` mode, keyset over (authority rank, id). */
  Context = 'context',
  ItemTransitions = 'item-transitions',
  WorkspaceTransitions = 'workspace-transitions',
}

const CURSOR_VERSION = 1;
const MAX_ENCODED_CHARS = 1024;
const MAX_DECODED_BYTES = 768;
const MAX_KEY_PART_CHARS = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * What a key part MEANS to the endpoint that will consume it.
 *
 * A decoded part used to be typed `string` and nothing more, which is only half
 * the contract: consumers hand parts to `BigInt()`, `Number()`, and `new Date()`
 * to rebuild a keyset predicate. `BigInt('x')` THROWS, `Number('x')` is `NaN`
 * (and `NaN::int` is a Postgres error), and `new Date('x')` is an Invalid Date —
 * so a hand-written cursor carrying a well-formed envelope around a garbage part
 * turned an `intent:read` route into a 500 instead of the §12 refusal it is.
 * Declaring the kind here refuses that at the decode seam, where the answer is
 * already `invalid_cursor`, rather than in each consumer.
 */
enum IntentCursorPartKind {
  /** A slug or other opaque id, compared as text. Any bounded non-empty string. */
  Opaque = 'opaque',
  /** A decimal integer, safe for `BigInt()` and `Number()`. */
  Integer = 'integer',
  /** An ISO-8601 instant exactly as `Date.prototype.toISOString` emits it. */
  Timestamp = 'timestamp',
}

/**
 * The keyset each scope pages on, in order. This is the single declaration of a
 * cursor's arity AND its part types: adding a scope without an entry here fails
 * loudly at the first decode rather than silently accepting anything.
 */
const CURSOR_KEYSETS: Record<IntentCursorScope, readonly IntentCursorPartKind[]> = {
  // `intent_domains.id` / `intent_features.id` / `intent_items.id` are slugs.
  [IntentCursorScope.TreeDomains]: [IntentCursorPartKind.Opaque],
  [IntentCursorScope.Features]: [IntentCursorPartKind.Opaque],
  [IntentCursorScope.Items]: [IntentCursorPartKind.Opaque],
  // `intent_feature_seeds.id` is a bigint row id: the consumer calls `BigInt()`.
  [IntentCursorScope.FeatureSeeds]: [IntentCursorPartKind.Integer],
  // (createdAt, item id) — `new Date()` then a text comparison.
  [IntentCursorScope.ReviewQueue]: [IntentCursorPartKind.Timestamp, IntentCursorPartKind.Opaque],
  // (authority rank, item id) — the rank is cast to `::int` in raw SQL.
  [IntentCursorScope.Context]: [IntentCursorPartKind.Integer, IntentCursorPartKind.Opaque],
  // (createdAt, bigint row id) — `new Date()` then `BigInt()`.
  [IntentCursorScope.ItemTransitions]: [IntentCursorPartKind.Timestamp, IntentCursorPartKind.Integer],
  [IntentCursorScope.WorkspaceTransitions]: [IntentCursorPartKind.Timestamp, IntentCursorPartKind.Integer],
};

/**
 * A decimal integer, optionally negative, short enough that `BigInt` and
 * `Number` both accept it without surprise. Leading zeros are refused so one row
 * has exactly one cursor.
 */
const INTEGER_PART_RE = /^-?(0|[1-9][0-9]{0,18})$/;

/** `2026-09-01T12:00:00.000Z` — the only form `Date.toISOString()` produces. */
const TIMESTAMP_PART_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isValidPart(part: unknown, kind: IntentCursorPartKind): part is string {
  if (typeof part !== 'string' || part.length === 0 || part.length > MAX_KEY_PART_CHARS) return false;
  switch (kind) {
    case IntentCursorPartKind.Opaque:
      return true;
    case IntentCursorPartKind.Integer:
      return INTEGER_PART_RE.test(part);
    case IntentCursorPartKind.Timestamp: {
      // The regex fixes the SHAPE; the round trip rejects shapes that are
      // well-formed but not real instants (month 13, 31 February).
      if (!TIMESTAMP_PART_RE.test(part)) return false;
      const parsed = new Date(part);
      // `toISOString()` on an Invalid Date THROWS a RangeError — the very thing
      // this function exists to keep away from a read route, so the emptiness of
      // the date is checked before it is formatted.
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === part;
    }
  }
}

/** Page sizes. `max` bounds a single response; `default` is what an unspecified caller gets. */
export const INTENT_PAGE_LIMITS = { default: 50, max: 200 } as const;

/**
 * Features returned inline per domain on a tree page. A tree read is a browse
 * surface, not an export: a domain with more features than this reports
 * `featuresTruncated` and the caller pages that domain through `GET
 * …/intent/features?domainId=`. Results never silently shrink (spec §6.1).
 */
export const INTENT_TREE_FEATURES_PER_DOMAIN = 100;

function invalidCursor(): never {
  throw intentStateError(IntentErrorCode.InvalidCursor, 'The pagination cursor is not valid for this list', ['cursor']);
}

/**
 * Encode the keyset of the last row on a page.
 *
 * Checked against the SAME table `decodeIntentCursor` reads, so a server that
 * emits a part its own decoder would refuse fails here — loudly, in a test —
 * rather than issuing a cursor that dead-ends the caller's next page.
 */
export function encodeIntentCursor(scope: IntentCursorScope, key: readonly string[], binding?: string): string {
  const kinds = CURSOR_KEYSETS[scope];
  if (
    key.length !== kinds.length ||
    !key.every((part, index) => isValidPart(part, kinds[index] as IntentCursorPartKind))
  ) {
    // A caller bug, not a caller-supplied value: the server builds these.
    throw new Error(`An intent cursor for '${scope}' must carry ${kinds.length} part(s) matching its keyset kinds`);
  }
  // `ctx` is written only when bound, so an unbound cursor keeps its bytes.
  const decoded = JSON.stringify(
    binding === undefined ? { v: CURSOR_VERSION, scope, key } : { v: CURSOR_VERSION, scope, key, ctx: binding },
  );
  if (Buffer.byteLength(decoded, 'utf8') > MAX_DECODED_BYTES) {
    throw new Error('The intent cursor exceeds the decoded size bound');
  }
  const encoded = Buffer.from(decoded, 'utf8').toString('base64url');
  if (encoded.length > MAX_ENCODED_CHARS) {
    throw new Error('The intent cursor exceeds the encoded size bound');
  }
  return encoded;
}

/**
 * Decode a cursor for `scope`, or `null` when the caller supplied none.
 *
 * `length` is the number of key parts the endpoint's keyset has; a cursor of a
 * different arity is refused rather than padded. It must agree with the scope's
 * entry in {@link CURSOR_KEYSETS} — a disagreement is a server bug (the two
 * declarations of one keyset drifted), not a caller refusal.
 *
 * Every returned part is guaranteed to satisfy its declared kind, so a consumer
 * may call `BigInt`, `Number`, or `new Date` on it without a guard.
 *
 * `binding` is the request state the cursor was issued under (e.g. a context
 * digest); a cursor bound to anything else, or bound when none is expected, is refused.
 */
export function decodeIntentCursor(
  raw: unknown,
  scope: IntentCursorScope,
  length: number,
  binding?: string,
): string[] | null {
  const kinds = CURSOR_KEYSETS[scope];
  if (kinds.length !== length) {
    throw new Error(`The '${scope}' cursor keyset declares ${kinds.length} part(s), but the caller expects ${length}`);
  }
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > MAX_ENCODED_CHARS || !BASE64URL_RE.test(raw)) invalidCursor();

  // `Buffer.from` does not throw on a base64url-shaped string; the round-trip
  // comparison is what refuses padded or otherwise mutated variants.
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length > MAX_DECODED_BYTES || bytes.toString('base64url') !== raw) invalidCursor();
  const decoded = bytes.toString('utf8');

  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    invalidCursor();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCursor();

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== (binding === undefined ? 3 : 4) ||
    record.ctx !== binding ||
    record.v !== CURSOR_VERSION ||
    record.scope !== scope ||
    !Array.isArray(record.key) ||
    record.key.length !== kinds.length ||
    // Every part must satisfy its DECLARED kind, not merely be a string: this is
    // the check that stops a hand-written `"x"` from reaching `BigInt()` and
    // becoming a 500 on a read route.
    !record.key.every((part, index) => isValidPart(part, kinds[index] as IntentCursorPartKind))
  ) {
    invalidCursor();
  }
  return record.key as string[];
}

/** `limit` query parameter: an integer in `[1, max]`, defaulting when absent. */
export function parseIntentPageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return INTENT_PAGE_LIMITS.default;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/.test(raw)) {
    throw intentStateError(
      IntentErrorCode.InvalidPageLimit,
      `limit must be an integer between 1 and ${INTENT_PAGE_LIMITS.max}`,
      ['limit'],
    );
  }
  const parsed = Number(raw);
  if (parsed > INTENT_PAGE_LIMITS.max) {
    throw intentStateError(
      IntentErrorCode.InvalidPageLimit,
      `limit must be an integer between 1 and ${INTENT_PAGE_LIMITS.max}`,
      ['limit'],
    );
  }
  return parsed;
}

/**
 * The keyset-paging idiom every list endpoint here uses: read `limit + 1` rows,
 * return `limit`, and issue a cursor only when a further row actually exists.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  scope: IntentCursorScope,
  keyOf: (row: T) => string[],
): { page: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { page: rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1] as T;
  return { page, nextCursor: encodeIntentCursor(scope, keyOf(last)) };
}
