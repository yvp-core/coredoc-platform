/**
 * The public error contract of the cloud intent service (spec §12).
 *
 * Every refusal a caller can act on is a `{ code, message, path }` triple:
 * a machine-readable code, a bounded human message, and the EXACT field path
 * that failed. That triple travels verbatim over REST (rendered by
 * {@link IntentExceptionFilter}) and over MCP (rendered by
 * {@link renderIntentPublicError} into a typed tool result), so a CLI or an
 * agent never has to parse prose to find the offending field.
 *
 * Nothing internal is representable in this shape: there is no field for a
 * stack, a SQL fragment, or an upstream provider message, and the only path
 * from an unknown `Error` into it is {@link renderIntentPublicError}, which
 * discards the original message and emits the fixed internal text.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable refusal codes — THE vocabulary of the intent service.
 *
 * Codes are the stable contract; messages are for humans and may be reworded, so
 * a caller branches on the code. The three groups below (content, workspace
 * state, anchor) once lived in three enums bridged by widening casts, which made
 * a code's group a fact about server file layout rather than about the refusal.
 * They are one enum because the wire shape was always one shape: a caller reads
 * `{code, message, path}` and never had a way to tell the groups apart.
 */
export enum IntentErrorCode {
  ReleaseItemNotReleasable = 'release_item_not_releasable',
  ReleaseContentMismatch = 'release_content_mismatch',
  ReleaseConflictingItems = 'release_conflicting_items',
  ReleaseOutOfOrder = 'release_out_of_order',
  ReleaseNotCurrent = 'release_not_current',
  ReleaseRefRecorded = 'release_ref_recorded',
  ReleaseNotFound = 'release_not_found',
  /**
   * The caller is a machine and the workspace did not delegate to one: a
   * service token holding `intent:release` records `kind: release` only while
   * `intentReleaseTrigger` is `deploy` (amendment §4). Every other combination
   * — another kind, another mode — stays human-only.
   */
  ReleaseModeForbids = 'release_mode_forbids',
  /**
   * The PR trailers could not be read EXACTLY: a token that is not
   * `<item-id>@<version>`, an id that is not a slug, one id at two versions, an
   * item both delivered and retired, or no items at all (amendment §1). A
   * partial parse would assert production state nobody reviewed.
   */
  TrailerInvalid = 'trailer_invalid',
  /** A trailer named an id this workspace does not hold. */
  ReleaseItemUnknown = 'release_item_unknown',
  /**
   * A trailer named a version that is no longer the item's current version: the
   * item changed after review, so a human must decide whether the delivered code
   * still implements it. The answer carries the current version. No automatic
   * reconciliation (amendment §1).
   */
  ReleaseVersionStale = 'release_version_stale',
  PlanNotPlannable = 'plan_not_plannable',
  PlanNotActive = 'plan_not_active',
  PlanNotWithdrawn = 'plan_not_withdrawn',

  // ---- Content: the request itself is unacceptable ----

  /** Shape, enum, or bounds failure reported by the operation schema (includes per-kind payload validation). */
  SchemaViolation = 'schema_violation',
  /** A string matched the secret-shaped pattern (keys, tokens, `password:` assignments). */
  ContentSecretShaped = 'content_secret_shaped',
  /** A string matched the email-shaped pattern. Identity comes from the token, never from payload text. */
  ContentEmailShaped = 'content_email_shaped',
  /** A long multi-line string: a pasted source body or transcript rather than a bounded statement. */
  ContentSourceBodyShaped = 'content_source_body_shaped',
  /** A `url` field carrying credentials or token-shaped query parameters. */
  ContentUrlCredentials = 'content_url_credentials',
  /** A `url` field whose value is not a parseable URL at all. */
  ContentUrlUnparseable = 'content_url_unparseable',
  /** The request structure exceeded the nesting-depth or node budget. */
  ContentStructureExceeded = 'content_structure_exceeded',
  /** A string carried a control character other than newline or tab. */
  ContentControlChars = 'content_control_chars',
  /** Fallback for anything unexpected. Carries no detail by construction. */
  InternalError = 'internal_error',

  // ---- Request addressing and paging: well-formed content, unusable request ----

  /** A route path id and the same id in the body disagree. */
  PathBodyMismatch = 'path_body_mismatch',
  /** A list cursor is not a cursor this endpoint issued. */
  InvalidCursor = 'invalid_cursor',
  /** A `limit` query parameter outside the allowed range. */
  InvalidPageLimit = 'invalid_page_limit',
  /**
   * A cursor on a read that does not page: the bounded context mode, and the
   * two context selections whose order is not keyset-able (the node selector's
   * graph union, and the lexical disjunctive fallback). Refused rather than
   * ignored — a silently dropped cursor re-serves page one forever.
   */
  CursorNotSupported = 'cursor_not_supported',
  /**
   * A `kind` filter outside the closed set. A malformed REQUEST, never a miss:
   * "no item has kind `rules`" and "there is no such kind" must not look alike.
   */
  UnknownKind = 'unknown_kind',

  // ---- Workspace state: the request was well-formed, the state says no ----

  /**
   * The workspace has intent turned OFF (`intentEnabled = false`), so the whole
   * automatic machinery is inert. Only surfaces that would otherwise write intent
   * state without a human session use this — an automatic caller must be able to
   * tell "the feature is off" from "there was nothing to record".
   */
  IntentDisabled = 'intent_disabled',
  /** The named domain does not exist in this workspace. */
  DomainNotFound = 'domain_not_found',
  /** The named feature does not exist in this workspace. */
  FeatureNotFound = 'feature_not_found',
  /** A proposal names both a feature and a domain, and the feature belongs to another domain. */
  FeatureDomainMismatch = 'feature_domain_mismatch',
  /** The named item does not exist in this workspace. */
  ItemNotFound = 'item_not_found',
  /** The named seed identity is not declared on this feature. */
  SeedNotFound = 'seed_not_found',
  /** No item in this workspace cites the named source ref. */
  SourceNotFound = 'source_not_found',
  /** Create was called for an id that already exists. Ids are immutable; create is not upsert. */
  TreeNodeExists = 'tree_node_exists',
  /** Delete refused: the domain or feature still holds children or attached items. */
  TreeNodeNotEmpty = 'tree_node_not_empty',
  /** A clause, variant, or dimension action names a dimension that is not declared, or is archived. */
  DimensionNotFound = 'dimension_not_found',
  /** A clause or variant names a value the dimension does not declare. */
  DimensionValueNotFound = 'dimension_value_not_found',
  /** A read context gives a list of values for a single-value dimension. */
  DimensionNotMulti = 'dimension_not_multi',
  /**
   * Archive, delete, or a value drop refused: a candidate or accepted item still
   * references the dimension or value (BR-7). `details` names the items.
   */
  DimensionInUse = 'dimension_in_use',
  /** An `item` condition clause names an item that exists neither in the workspace nor in the batch. */
  ConditionItemNotFound = 'condition_item_not_found',
  /** An `item` condition clause names a rejected or superseded item; it could never filter. */
  ConditionItemInactive = 'condition_item_inactive',
  /** An `item` condition clause would close a cycle of item references. */
  ConditionCycle = 'condition_cycle',
  /** Two rule variants could match one context at equal specificity, or a rule has a second default (BR-5). */
  VariantOverlap = 'variant_overlap',
  /** A seed node id whose type segment is outside the seed allowlist. */
  UnsupportedSeedNodeType = 'unsupported_seed_node_type',
  /** A seed or anchor naming a repo key that is not registered in this workspace. */
  UnknownRepoKey = 'unknown_repo_key',

  /** Propose named an item that exists but is accepted, rejected, or superseded. */
  ItemNotCandidate = 'item_not_candidate',
  /** Propose named an existing item with a different `kind`; the kind is part of the id scheme. */
  ItemKindImmutable = 'item_kind_immutable',
  /** A supplied item id whose prefix does not match its kind. */
  ItemIdKindMismatch = 'item_id_kind_mismatch',
  /** One proposal's sources match more than one existing candidate. */
  AmbiguousSourceIdentity = 'ambiguous_source_identity',
  /** A supplied id and the proposal's source identity point at different items. */
  SourceIdentityConflict = 'source_identity_conflict',
  /** No slug could be derived from the proposal's title and no id was supplied. */
  UnderivableItemId = 'underivable_item_id',
  /** The title's slug does not fit the id cap, so the derived id would drop words. */
  IdWouldTruncate = 'id_would_truncate',
  /** Review named an item that is not `accepted`, so there is nothing to supersede. */
  ItemNotAccepted = 'item_not_accepted',
  /** A supersede decision whose replacement candidate does not name this predecessor. */
  ReplacementNotProposed = 'replacement_not_proposed',
  /** A supersede decision whose replacement is of a different `kind` than the predecessor. */
  ReplacementKindMismatch = 'replacement_kind_mismatch',
  /** A plain `accept` on a candidate that carries `proposedSuccessorOfId`. */
  ReplacementDecisionRequired = 'replacement_decision_required',
  /** One item is the subject of more than one decision in a single review batch. */
  ReviewSubjectRepeated = 'review_subject_repeated',
  /** `import` as a review batch's authorizing source: that kind belongs to the import flow. */
  AuthorizingSourceKindNotAllowed = 'authorizing_source_kind_not_allowed',

  /**
   * Import refused because the workspace already holds intent content
   * (spec §8.1). v1 import is onboarding, not merge; the refusal enumerates
   * which kinds are non-empty so the caller can see what is in the way.
   */
  WorkspaceNotEmpty = 'workspace_not_empty',
  /**
   * The uploaded overlay is not a valid `IntentFileV2`. Distinct from
   * {@link SchemaViolation}: the ENVELOPE was well-formed and the failure came
   * from core's `validateIntentFile` over the overlay document itself, whose
   * paths are overlay paths (`overlay.items.3.domain`).
   */
  ImportOverlayInvalid = 'import_overlay_invalid',
  /** The workspace holds more intent rows than one export document may carry. */
  ExportTooLarge = 'export_too_large',

  /** The item's `version` moved between read and write. Carries the current version. */
  VersionConflict = 'version_conflict',
  /**
   * A propose planned an update to a candidate that a concurrent review has
   * since accepted, rejected, or superseded. Nothing was written; propose again
   * to create a successor candidate. Distinct from {@link VersionConflict}: a
   * retry of the same update can never succeed.
   */
  ItemNoLongerCandidate = 'item_no_longer_candidate',
  /** The idempotency key was already spent on a different operation. */
  IdempotencyOperationConflict = 'idempotency_operation_conflict',
  /** The idempotency key was already spent on a different request body. */
  IdempotencyRequestConflict = 'idempotency_request_conflict',
  /** A concurrent replay of the same key is still committing. Retry. */
  IdempotencyInFlight = 'idempotency_in_flight',
  /**
   * A unique violation that is NOT the idempotency-ledger race — a duplicate
   * domain id, a repeated anchor identity, a seed proposed twice. Separate from
   * {@link IdempotencyInFlight} because these are NOT retryable: telling the
   * caller to "retry to read its result" when no winner exists is a loop that
   * can never terminate. The message names the constraint.
   */
  UniqueConstraintViolation = 'unique_constraint_violation',
  /**
   * The transaction did not commit — a serialization failure between concurrent
   * `Serializable` writers, or a transaction that ran past its budget. Nothing
   * was applied and the idempotency key is still UNSPENT, so re-sending the same
   * request with the same key is the correct and safe recovery.
   */
  TransactionConflict = 'transaction_conflict',

  // ---- Anchors: capturing a drift baseline REFUSES rather than degrades (§4.6) ----

  /** The resolved node type is outside the versioned-anchor allowlist (§4.6). */
  AnchorNodeTypeUnsupported = 'anchor_node_type_unsupported',
  /** The node is not in the workspace snapshot, so there is no baseline to observe. */
  AnchorNodeMissing = 'anchor_node_missing',
  /** The node exists but carries no `versionedId`, so drift could never be detected. */
  AnchorVersionedIdAbsent = 'anchor_versioned_id_absent',
  /** The graph could not be read at all. A write cannot degrade — retry when a snapshot exists. */
  AnchorGraphUnavailable = 'anchor_graph_unavailable',
  /** Refresh/remove named an anchor identity this item does not carry. */
  AnchorNotFound = 'anchor_not_found',

  AnchorsProgressChanged = 'anchors_progress_changed',
  AnchorsPublishBusy = 'anchors_publish_busy',
  AnchorsRepoChanged = 'anchors_repo_changed',
  MappingHistoryUnavailable = 'mapping_history_unavailable',

  // ---- PR anchor apply: CI resolves against the snapshot ITS run published ----

  /**
   * The `graphCommit` the sync names is not the one the workspace's current
   * snapshot was parsed at. The whole call is refused and nothing is written:
   * an older or superseded run must never overwrite a newer run's mapping.
   */
  BindingsSnapshotMismatch = 'bindings_snapshot_mismatch',
}

/**
 * Reporting bounds. A message quotes rule text only, never untrusted content,
 * but the cap stays: a schema failure over a large batch can produce many
 * issues and the report must not become an unbounded dump.
 */
export const INTENT_PUBLIC_ERROR_LIMITS = {
  messageChars: 200,
  details: 20,
} as const;

const ELLIPSIS = '…';

/** One failing field. */
export interface IntentErrorDetail {
  code: IntentErrorCode;
  /** Bounded, rule-stating text. Never echoes request content. */
  message: string;
  /**
   * Full path from the request root to the failing field; array indices are
   * their decimal string (`['items', '0', 'payload', 'owner']`). Empty for a
   * whole-request failure.
   */
  path: string[];
}

/** The body a caller receives. `details` appears when several fields failed at once. */
export interface IntentPublicError extends IntentErrorDetail {
  details?: IntentErrorDetail[];
}

/** `items[0].payload.owner` — the shape a CLI or agent can point a human at. */
export function formatIntentErrorPath(path: string[]): string {
  if (path.length === 0) return '<request>';
  return path
    .map((segment, index) => (/^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`))
    .join('');
}

function truncate(message: string): string {
  if (message.length <= INTENT_PUBLIC_ERROR_LIMITS.messageChars) return message;
  return message.slice(0, INTENT_PUBLIC_ERROR_LIMITS.messageChars - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Truncate every message and cap the detail list, appending one synthetic
 * detail stating how many were dropped so a consumer never mistakes the cap for
 * "that was all of it" (same discipline as `boundErrorReport` in
 * `@coredoc/core`, applied to this module's public shape).
 */
export function boundIntentPublicError(error: IntentPublicError): IntentPublicError {
  const bounded: IntentPublicError = {
    code: error.code,
    message: truncate(error.message),
    path: [...error.path],
  };
  if (error.details === undefined) return bounded;

  const kept = error.details
    .slice(0, INTENT_PUBLIC_ERROR_LIMITS.details)
    .map((detail) => ({ code: detail.code, message: truncate(detail.message), path: [...detail.path] }));
  const omitted = error.details.length - kept.length;
  if (omitted > 0) {
    kept.push({
      code: error.code,
      path: [],
      message: `${omitted} further field error(s) were omitted; fix the reported ones and send the request again`,
    });
  }
  bounded.details = kept;
  return bounded;
}

/**
 * The only exception type this module throws for a refusal the caller caused.
 *
 * It extends `HttpException` so that if one ever escapes the module-scoped
 * filter (thrown from a guard, an interceptor, or a non-intent route), the
 * global filter still renders `code` and `message` from the response body
 * instead of collapsing it into a bare 500 — degradation, not a leak.
 */
export class IntentPublicException extends HttpException {
  readonly publicError: IntentPublicError;

  constructor(error: IntentPublicError, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    const bounded = boundIntentPublicError(error);
    super({ statusCode: status, ...bounded }, status);
    this.publicError = bounded;
  }
}

/** A content/schema refusal: always the caller's request, always 400. */
export function intentContractViolation(
  code: IntentErrorCode,
  message: string,
  path: string[],
  details?: IntentErrorDetail[],
): IntentPublicException {
  return new IntentPublicException({ code, message, path, ...(details ? { details } : {}) }, HttpStatus.BAD_REQUEST);
}

/**
 * The single mapper every surface uses (REST filter, MCP tools, and any future
 * transport): a known public refusal keeps its triple, anything else becomes
 * the fixed internal shape. The unknown error's own message is DISCARDED here —
 * that is the guarantee that a stack, a SQL fragment, or a provider error can
 * never reach a caller.
 */
export function renderIntentPublicError(exception: unknown): { status: number; error: IntentPublicError } {
  if (exception instanceof IntentPublicException) {
    return { status: exception.getStatus(), error: exception.publicError };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: {
      code: IntentErrorCode.InternalError,
      message: 'The intent service could not complete this request.',
      path: [],
    },
  };
}
