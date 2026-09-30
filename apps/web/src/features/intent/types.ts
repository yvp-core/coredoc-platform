import type { IntentEffectivity, IntentCurrentRelease } from './release-types.js';
/**
 * Wire contract for the cloud intent knowledge base
 * (`/api/v1/workspaces/:workspaceId/intent/…`, spec §7).
 *
 * These shapes mirror `apps/server/src/modules/intent/*` 1:1. They are restated
 * here rather than imported because the server's vocabulary is not packaged for
 * external consumption, and value-importing `@coredoc/core` from a browser
 * bundle does not work — so this module has deliberately NO imports at all.
 *
 * Two markers are kept INDEPENDENT on purpose and must never be merged into one
 * "status" in the UI (spec §6.3/§6.4): an anchor's `status` says whether the
 * node still reproduces, and `snapshotFreshness` / the per-repo graph provenance
 * says how old the snapshot that answer came from is. A matched anchor on a
 * months-old snapshot is not proof of anything.
 */

/* ------------------------------------------------------------ vocabulary --- */

/** Authority lifecycle (spec §4.4, §5). Terminal: rejected, superseded. */
export enum IntentAuthority {
  Candidate = 'candidate',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Superseded = 'superseded',
}

/** Item kinds (spec §4.4). The id prefix is derived from these server-side. */
export enum IntentItemKind {
  Capability = 'capability',
  UseCase = 'use_case',
  Flow = 'flow',
  BusinessRule = 'business_rule',
  Limitation = 'limitation',
  Decision = 'decision',
}

/**
 * Provenance artifact kinds (spec §4.5). The server's authorizing-source enum
 * also admits `import`, but the review service refuses it
 * (`authorizing_source_kind_not_allowed`) — an import records arrival, not a
 * decision — so the review form deliberately offers only these four.
 */
export enum IntentSourceKind {
  Spec = 'spec',
  Issue = 'issue',
  Adr = 'adr',
  Manual = 'manual',
}

/**
 * One clause of an item's `appliesWhen`; clauses are joined with AND
 * (intent-dimensions spec, item-level context conditions).
 */
export type ContextCondition =
  | { dimension: string; in: string[] }
  | { dimension: string; notIn: string[] }
  /** Applies only where the referenced item applies (one level deep). */
  | { item: string }
  /** Human-readable, never machine-evaluated. */
  | { text: string };

/** Dimension id → one value id, or a list of value ids. */
export type DimensionValueSelection = Record<string, string | string[]>;

/** A tree node's structural condition — dimension clauses only, no `{item}`/`{text}` (ADR-1, BR-1/BR-2). */
export type TreeCondition = { dimension: string; in: string[] } | { dimension: string; notIn: string[] };

/** What `intent_propose` names a hint (intent-dimensions-inheritance spec, BR-3/BR-5). Never blocks, never writes. */
export enum AuthoringHintKind {
  MissingCondition = 'missing-condition',
  AmbiguousVariants = 'ambiguous-variants',
  DeadVariant = 'dead-variant',
  UnacceptedConditionItem = 'unaccepted-condition-item',
}

/** A non-blocking authoring hint, returned by propose and recomputed on the review queue read. */
export type AuthoringHint =
  | { kind: AuthoringHintKind.MissingCondition; dimension: string; value: string; matched: string }
  | {
      kind: AuthoringHintKind.AmbiguousVariants;
      variants: [number, number];
      context: Record<string, string | string[]>;
    }
  | { kind: AuthoringHintKind.DeadVariant; variant: number }
  | { kind: AuthoringHintKind.UnacceptedConditionItem; item: string };

/** A `business_rule` payload variant: an outcome for one slice of context. */
export interface RuleVariant {
  /** Absent means the default variant. A list names alternatives, not a conjunction. */
  when?: DimensionValueSelection;
  /** Text; may be a formula over `inputs`. */
  outcome: string;
  /** Runtime values a formula reads. Not dimensions, never enumerated. */
  inputs?: string[];
}

/** Per-anchor drift verdict, computed at read time (spec §6.4). */
export enum IntentAnchorStatus {
  Matched = 'matched',
  Changed = 'changed',
  Missing = 'missing',
}

/** Snapshot provenance, reported independently of {@link IntentAnchorStatus}. */
export enum IntentSnapshotFreshness {
  Current = 'current',
  Stale = 'stale',
  Unknown = 'unknown',
  Unverified = 'unverified',
}

/** What the reviewer asked for (spec §5). `defer`/`needs_edit` write nothing. */
export enum IntentReviewAction {
  Accept = 'accept',
  Reject = 'reject',
  Supersede = 'supersede',
  Defer = 'defer',
  NeedsEdit = 'needs_edit',
}

/** What the server actually did, per decision. `refused` carries an error. */
export enum IntentReviewOutcome {
  Accepted = 'accepted',
  Rejected = 'rejected',
  Superseded = 'superseded',
  Deferred = 'deferred',
  NeedsEdit = 'needs_edit',
  Refused = 'refused',
}

/**
 * The one refusal code the review UI branches on: the reviewer decided against a
 * version that is no longer current, so the decision must be re-made against
 * what the item says now. Every other code is displayed verbatim.
 */
export const INTENT_VERSION_CONFLICT_CODE = 'version_conflict';

/* ---------------------------------------------------------------- errors --- */

/** One field-level detail inside a structured intent error (spec §12). */
export interface IntentErrorDetail {
  code: string;
  message: string;
  path: string[];
}

/** `IntentExceptionFilter`'s public error body — surfaced verbatim, never summarized. */
export interface IntentErrorEnvelope extends IntentErrorDetail {
  statusCode: number;
  timestamp: string;
  requestPath?: string;
  details?: IntentErrorDetail[];
}

/* ------------------------------------------------------------------ tree --- */

export interface IntentDomainView {
  id: string;
  title: string;
  statement: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Structural conditions set on the tree node itself; absent means unconditional (ADR-1). */
  appliesWhen?: TreeCondition[];
}

export interface IntentFeatureView extends IntentDomainView {
  domainId: string;
}

export interface IntentTreeDomain extends IntentDomainView {
  features: IntentFeatureView[];
  /** The server bounds features per domain and says so rather than shrinking silently. */
  featuresTruncated: boolean;
}

export interface IntentTreeResponse {
  domains: IntentTreeDomain[];
  nextCursor: string | null;
}

export interface IntentFeaturesResponse {
  features: IntentFeatureView[];
  nextCursor: string | null;
}

export interface IntentFeatureSeed {
  repoKey: string;
  nodeId: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IntentFeatureSeedsResponse {
  seeds: IntentFeatureSeed[];
  nextCursor: string | null;
}

export interface IntentTreeQuery {
  includeArchived?: boolean;
  cursor?: string;
  limit?: number;
}

export interface IntentFeaturesQuery extends IntentTreeQuery {
  domainId?: string;
}

/* ------------------------------------------------------------ dimensions --- */

export interface IntentDimensionValue {
  id: string;
  title: string;
  /** Alternative names used only to recognise mentions in text (hint matching, LIM-1). */
  aliases?: string[];
}

/** A workspace-declared, enumerable context attribute (country, plan, role, …). */
export interface IntentDimension {
  id: string;
  title: string;
  values: IntentDimensionValue[];
  /** A `multi` dimension holds several values at once in a context. */
  multi: boolean;
  archived?: boolean;
}

export interface IntentDimensionsResponse {
  dimensions: IntentDimension[];
}

/* ----------------------------------------------------------------- items --- */

/**
 * A list row's condition summary (`GET items` and the context read's list
 * mode): the item's own clauses, whether a domain/feature adds any, and a
 * business rule's variant count. Absent on an unconditioned row.
 */
export interface IntentListConditions {
  own?: ContextCondition[];
  inherited?: boolean;
  variants?: number;
}

/** How a reader context evaluated an item (`contextMatch.state`). */
export enum IntentContextMatchState {
  Match = 'match',
  Excluded = 'excluded',
  Open = 'open',
  Unevaluated = 'unevaluated',
}

/** A list-mode `contextMatch`: the state and the dimension ids it still depends on. */
export interface IntentListContextMatch {
  state: IntentContextMatchState;
  open: string[];
  openBy?: string[];
}

/** The payload-free browse index row (`GET items`). */
export interface IntentItemSummary {
  conditions?: IntentListConditions;
  /** Present only on a "preview as" row, read from the context list mode with a `context`. */
  contextMatch?: IntentListContextMatch;
  effectivity?: IntentEffectivity;
  id: string;
  kind: IntentItemKind;
  title: string;
  authority: IntentAuthority;
  version: number;
  domainId: string | null;
  featureId: string | null;
  proposedSuccessorOfId: string | null;
  supersededById: string | null;
  updatedAt: string;
}

export interface IntentItemsResponse {
  currentRelease?: IntentCurrentRelease | null;
  headSeq?: number;
  items: IntentItemSummary[];
  nextCursor: string | null;
}

export interface IntentItemsQuery {
  production?: 'true';
  effectivity?: IntentEffectivity;
  sourceRef?: string;
  sourceKind?: string;
  search?: string;
  authorities?: string;
  kinds?: string;
  scopeFeatureId?: string;
  authority?: IntentAuthority;
  kind?: IntentItemKind;
  domainId?: string;
  featureId?: string;
  cursor?: string;
  limit?: number;
}

/* ---------------------------------------------------------- review queue --- */

/**
 * One domain's share of the waiting queue. `domainId: null` is the product root
 * (spec §4.4), which is a bucket of its own and never folded into a domain.
 */
export interface IntentPendingReviewDomain {
  domainId: string | null;
  waiting: number;
  oldestWaitingAt: string;
}

/**
 * The workspace-wide waiting-candidate summary, carried by the queue read and by
 * every context read (spec §7, §11).
 *
 * ZERO IS AN ANSWER, ABSENT IS NOT: a workspace with nothing waiting answers
 * `waiting: 0` with an empty breakdown, so a client never has to tell "nothing
 * waiting" apart from "this server does not report it". `byDomain` is bounded
 * server-side and says so through `byDomainTruncated`; `waiting` is always the
 * exact total, because that is what a badge shows.
 */
export interface IntentPendingReviewSummary {
  waiting: number;
  oldestWaitingAt: string | null;
  /** At least one waiting candidate proposes to replace an accepted item (§5). */
  hasReplacementCandidate: boolean;
  byDomain: IntentPendingReviewDomain[];
  byDomainTruncated: boolean;
}

/**
 * A queue row. Narrower than {@link IntentItemSummary} on purpose: the route
 * selects candidates only, and a candidate has no `supersededById` — the field
 * is absent here rather than reported as a `null` the server never sent.
 */
export interface IntentReviewQueueItem {
  id: string;
  kind: IntentItemKind;
  title: string;
  authority: IntentAuthority;
  version: number;
  domainId: string | null;
  featureId: string | null;
  proposedSuccessorOfId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Non-blocking authoring hints, recomputed at read time (BR-3, BR-5). */
  hints?: AuthoringHint[];
}

/**
 * One page of the review queue plus the two numbers a reviewer needs before
 * paging: `total` for the applied filter, `summary` for the whole workspace.
 * This is what replaced the renderer's exhaustive candidate walk.
 */
export interface IntentReviewQueueResponse {
  summary: IntentPendingReviewSummary;
  total: number;
  items: IntentReviewQueueItem[];
  nextCursor: string | null;
}

export interface IntentReviewQueueQuery {
  kind?: IntentItemKind;
  domainId?: string;
  featureId?: string;
  cursor?: string;
  limit?: number;
}

/* --------------------------------------------------------------- context --- */

export interface IntentItemSource {
  kind: IntentSourceKind;
  ref: string;
  localId: string;
  revision: string | null;
  locator: string | null;
  /** The document's human name, when the capturing agent passed it. */
  title: string | null;
  url: string | null;
}

/**
 * A stored anchor plus, when the graph could be read, its drift verdict.
 * `status` and `snapshotFreshness` are absent — never guessed — while the graph
 * is unavailable (§6.3), which is a different statement from `missing`.
 */
export interface IntentItemAnchor {
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  status?: IntentAnchorStatus;
  snapshotFreshness?: IntentSnapshotFreshness;
  mismatchReason?: string;
  currentVersionedId?: string;
}

export interface IntentContextMatch extends IntentItemSummary {
  statement: string;
  rationale: string | null;
  payload: unknown;
  matchReason: string;
  derivedReasons?: string[];
  sources: IntentItemSource[];
  anchors: IntentItemAnchor[];
  /** Item-level context conditions; absent means unconditional. */
  appliesWhen?: ContextCondition[];
  /**
   * The domain's and feature's own structural conditions, inherited by this item
   * (ADR-1: always AND, never opted out of). Absent per level means that level
   * had none — never merged into `appliesWhen`, so the source stays visible.
   */
  inheritedConditions?: { domain?: TreeCondition[]; feature?: TreeCondition[] };
  /**
   * Present only when the read supplied a `context` (intent-dimensions §UC-4).
   * Context mode adds `reasons` and a rule's `variant` resolution, which the
   * detail pane does not render yet.
   */
  contextMatch?: IntentListContextMatch & { reasons?: unknown; variant?: unknown };
}

/** Per-repo snapshot provenance, reported on every context read (§6.3). */
export interface IntentRepoGraphProvenance {
  repoKey: string | null;
  repoName: string;
  graphRepoHash: string;
  graphVersionId: string | null;
  pushedAt: string | null;
  snapshotFreshness: IntentSnapshotFreshness;
  graphCommit?: string;
  observedCommit?: string;
}

export interface IntentGraphEvidence {
  repos: IntentRepoGraphProvenance[];
  /** Present when the snapshot could not be read at all — degradation, not error. */
  degradation?: { code: string; remediation: string };
  truncated: boolean;
  limits: string[];
}

export interface IntentContextResponse {
  mode: string;
  limit: number;
  matches: IntentContextMatch[];
  truncated: boolean;
  omittedCount: number;
  totalMatched: number;
  scanTruncated: boolean;
  unknownIntentIds: string[];
  unresolvedNodeIds: string[];
  matchedFeatureIds: string[];
  evidence: { available: boolean };
  graph: IntentGraphEvidence;
  anchorWarning: string;
  /** The waiting-candidate summary, on every context read (spec §7, §11). */
  pendingReview: IntentPendingReviewSummary;
}

/** One entry of the context read's list mode — payload-free, like the items index. */
export interface IntentContextListEntry {
  id: string;
  kind: IntentItemKind;
  title: string;
  authority: IntentAuthority;
  version: number;
  domainId: string | null;
  featureId: string | null;
  matchReason: string;
  effectivity?: IntentEffectivity;
  contextMatch?: IntentListContextMatch;
  conditions?: IntentListConditions;
}

export interface IntentContextListResponse {
  mode: 'list';
  entries: IntentContextListEntry[];
  nextCursor: string | null;
  truncated: boolean;
  /** Scanned items the supplied context dropped; absent when none. */
  contextExcluded?: number;
}

/** A "preview as" list read: the browse scope plus the reader context. */
export interface IntentContextListQuery {
  domain?: string;
  feature?: string;
  kinds?: IntentItemKind[];
  query?: string;
  includeCandidates: boolean;
  /** Canonical JSON of the reader context (sorted keys), so it doubles as a stable query key. */
  context: string;
}

export interface IntentContextQuery {
  intentIds?: string[];
  includeCandidates?: boolean;
  limit?: number;
}

/* --------------------------------------------------------------- anchors --- */

/**
 * Re-capture one anchor's baseline against the current snapshot (spec §7). It is
 * addressed by `(itemId, repoKey, nodeId)` — an anchor has no surrogate id — and
 * carries an idempotency key like every other mutation. Admin/owner on a user
 * session only; the server refuses anything else whatever this renderer shows.
 */
export interface IntentAnchorRefreshInput {
  idempotencyKey: string;
  itemId: string;
  repoKey: string;
  nodeId: string;
}

/** The stored anchor as the write path returns it. */
export interface IntentAnchorRecord {
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * `changed: false` means the stored baseline already matched the snapshot, so
 * the refresh was a no-op — the row's `changed` mark was stale, not the anchor.
 * `previousCapturedVersionedId` is what the row showed before, which is the
 * before→after pair the detail row renders.
 */
export interface IntentAnchorRefreshResponse {
  anchor: IntentAnchorRecord;
  changed: boolean;
  previousCapturedVersionedId: string;
  graphVersionId: string | null;
}

/* ----------------------------------------------------------- transitions --- */

export interface IntentTransitionSource {
  kind: string;
  ref: string;
  localId: string | null;
  revision: string | null;
}

export interface IntentTransition {
  id: string;
  itemId: string;
  /** `null` for an import arrival, which fabricates no decision that never happened. */
  from: string | null;
  to: string;
  actorId: string;
  actorRole: string;
  reason: string;
  authorizingSource: IntentTransitionSource;
  workItem: unknown | null;
  createdAt: string;
}

export interface IntentTransitionsResponse {
  transitions: IntentTransition[];
  nextCursor: string | null;
}

export interface IntentTransitionsQuery {
  cursor?: string;
  limit?: number;
}

/* ---------------------------------------------------------------- review --- */

export interface IntentAuthorizingSource {
  kind: IntentSourceKind;
  ref: string;
  localId: string;
  revision?: string;
}

export interface IntentWorkItemRef {
  provider: string;
  id: string;
  displayKey?: string;
  url?: string;
}

export interface IntentReviewDecisionInput {
  itemId: string;
  /** The version the reviewer actually looked at (spec §5). */
  expectedVersion: number;
  action: IntentReviewAction;
  /** `supersede` only: the replacement candidate and the version seen of it. */
  replacementItemId?: string;
  replacementExpectedVersion?: number;
  reason: string;
}

/**
 * Provenance sits on the BATCH, never on a decision: one review pass is
 * authorized by one artifact and optionally one work item (spec §4.7). The UI
 * enforces the same thing — one provenance group per submitted batch.
 */
export interface IntentReviewRequest {
  idempotencyKey: string;
  authorizingSource: IntentAuthorizingSource;
  workItem?: IntentWorkItemRef;
  decisions: IntentReviewDecisionInput[];
}

export interface IntentReviewDecisionResult {
  decisionIndex: number;
  itemId: string;
  action: string;
  outcome: IntentReviewOutcome;
  /** Authority AFTER this decision; unchanged on a refusal or a defer. */
  authority: IntentAuthority | null;
  /** New version, or the CURRENT one on a refusal — this is what a re-decide reads. */
  version: number | null;
  replacement?: { itemId: string; authority: IntentAuthority; version: number };
  error?: IntentErrorDetail;
}

/**
 * A 200 with per-decision results. One reviewer's stale version refuses only
 * that decision; the siblings in the batch still apply.
 */
export interface IntentReviewResponse {
  decisions: IntentReviewDecisionResult[];
}

/* --------------------------------------------------------- tree mutations --- */

export interface IntentDomainCreateInput {
  idempotencyKey: string;
  id: string;
  title: string;
  statement?: string;
}

export interface IntentDomainUpdateInput {
  idempotencyKey: string;
  id: string;
  title?: string;
  statement?: string;
}

export interface IntentArchiveInput {
  idempotencyKey: string;
  id: string;
  archived: boolean;
}

export interface IntentDeleteInput {
  idempotencyKey: string;
  id: string;
}

export interface IntentFeatureCreateInput extends IntentDomainCreateInput {
  domainId: string;
}

/**
 * A feature update is its OWN operation (`UpdateIntentFeatureSchema`), even
 * though the server's schema currently accepts the same fields as the domain
 * one: `domainId` is immutable, so re-parenting is not an update, and a channel
 * typed with the domain input reads as if the two contracts were the same by
 * construction rather than by coincidence. Aliased rather than duplicated so a
 * divergence is one edit here plus one at the call sites.
 */
export type IntentFeatureUpdateInput = IntentDomainUpdateInput;

export interface IntentSeedPutInput {
  idempotencyKey: string;
  featureId: string;
  repoKey: string;
  nodeId: string;
  note?: string;
}

export interface IntentSeedDeleteInput {
  idempotencyKey: string;
  featureId: string;
  repoKey: string;
  nodeId: string;
}

export interface IntentDomainMutationResponse {
  domain: IntentDomainView;
}

export interface IntentFeatureMutationResponse {
  feature: IntentFeatureView;
}

export interface IntentSeedMutationResponse {
  seed: { featureId: string; repoKey: string; nodeId: string; note: string | null; createdAt: string };
  created: boolean;
}

export interface IntentDeleteResponse {
  deleted: { kind: string; id?: string; featureId?: string; nodeId?: string; cascadedSeedCount?: number };
}
