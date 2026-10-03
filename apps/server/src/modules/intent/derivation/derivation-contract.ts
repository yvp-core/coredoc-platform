/**
 * Shapes and vocabulary of read-time intent derivation (spec §6).
 *
 * Everything here is DERIVED: a feature's code area, an item's applicability to
 * a feature, an anchor's status, and a snapshot's provenance are computed per
 * read and never stored (§4.9). Nothing in this file describes a persisted row.
 *
 * Two identities for a repository appear throughout and must not be confused:
 *
 * - `repoKey` — the DURABLE intent repo key (`workspace_repos.intent_repo_key`)
 *   that anchors and seeds address a repository by (§6.5).
 * - `graphRepoHash` — the repository id inside the graph snapshot
 *   (`workspace_repos.repo_key`), which is what a graph query filters on.
 */

import type { AnchorEvidence, SnapshotFreshness } from '@coredoc/db';
import type { VersionedAnchorNodeType } from '@coredoc/core';

/**
 * Why an item is applicable to a feature (§6.2).
 *
 * Every applicability hit names its reason so a consumer can tell an authored
 * attachment from a graph-derived one — an inherited business rule and a rule
 * that merely happens to be anchored on a called guard carry very different
 * weight for a reader, and a test cannot assert the guard case at all without
 * the distinction.
 */
export enum IntentMatchReason {
  /** Attached directly to this feature. */
  Attached = 'attached',
  /** Attached to the feature's domain or to the product root; inherited down the branch. */
  Inherited = 'inherited',
  /** An anchor lies in the feature's seeded area (seeds + containment + handlers). */
  AnchorInArea = 'anchor_in_area',
  /** An anchor is directly called by a node in that area — the admin-guard case. */
  AnchorCalledByArea = 'anchor_called_by_area',
  /**
   * An anchor (or a member of an anchored file/class) directly CALLS a queried
   * node — the reverse direction's mirror of {@link AnchorCalledByArea}.
   *
   * The baseline case an agent editing a shared callee needs: the rule lives on
   * the caller, which the change does not touch, so nothing else in §6.2 would
   * ever surface it.
   */
  AnchorCallsArea = 'anchor_calls_area',
}

/** What stopped a derivation short of the complete answer. */
export enum IntentDerivationLimit {
  /** The area's node budget filled. */
  NodeBudget = 'node_budget',
  /** The per-request query budget was spent. */
  QueryBudget = 'query_budget',
  /** A single traversal step returned more ids than its own cap allowed. */
  StepLimit = 'step_limit',
  /** The containment closure was still growing at the maximum depth. */
  ContainmentDepth = 'containment_depth',
  /** More candidate features exist than the read's feature bound could carry. */
  FeatureScan = 'feature_scan',
}

/** Why anchor-derived derivation could not run at all (§6.3). */
export enum IntentGraphUnavailableCode {
  WorkspaceNotFound = 'workspace_not_found',
  LegacyDatabaseUnavailable = 'legacy_database_unavailable',
  ActiveVersionMissing = 'active_version_missing',
  VersionNotFound = 'version_not_found',
  UnsupportedBackend = 'unsupported_backend',
  UnsupportedEngine = 'unsupported_engine',
  GraphObjectMissing = 'graph_object_missing',
  GraphDownloadTimeout = 'graph_download_timeout',
  GraphIntegrityFailed = 'graph_integrity_failed',
  GraphFormatUnsupported = 'graph_format_unsupported',
  GraphDescriptorInvalid = 'graph_descriptor_invalid',
  GraphCacheCapacity = 'graph_cache_capacity',
  GraphOpenFailed = 'graph_open_failed',
  GraphQueryFailed = 'graph_query_failed',
  /**
   * The snapshot opened, but its backend cannot answer set-shaped traversals
   * (the legacy Turso plane). Attachment-based applicability still works.
   */
  BatchTraversalUnsupported = 'batch_traversal_unsupported',
}

/** A seed of a feature's code area (§4.3). */
export interface FeatureSeedRef {
  repoKey: string;
  nodeId: string;
}

/** One anchor of an intent item, as derivation needs it (§4.6). */
export interface ItemAnchorRef {
  repoKey: string;
  nodeId: string;
  /**
   * Only the kinds the versioned-anchor contract covers (§4.6). Seeds are NOT
   * restricted this way — a Route or Package is a legitimate seed and an
   * illegitimate anchor — which is why the two use different types here.
   */
  nodeType: VersionedAnchorNodeType;
  capturedVersionedId: string;
}

/** The tree attachment of an item: product root (both null), a domain, or a feature. */
export interface ItemAttachmentRef {
  domainId: string | null;
  featureId: string | null;
}

/** The minimum an item must expose to be placed by derivation. */
export interface DerivableIntentItem {
  id: string;
  attachment: ItemAttachmentRef;
  anchors: readonly ItemAnchorRef[];
}

/** The feature a forward derivation is about. */
export interface DerivableFeature {
  id: string;
  domainId: string;
  seeds: readonly FeatureSeedRef[];
}

/** One repository's slice of a computed area. */
export interface FeatureAreaRepoSlice {
  repoKey: string;
  graphRepoHash: string;
  /**
   * Seeds + containment closure + resolved handlers. An anchor here reports
   * {@link IntentMatchReason.AnchorInArea}.
   */
  coreNodeIds: ReadonlySet<string>;
  /**
   * One-hop CALLS targets of the core, same repository. Part of the area per
   * §6.1, but reported as {@link IntentMatchReason.AnchorCalledByArea} so the
   * guard case is distinguishable from containment.
   */
  calledNodeIds: ReadonlySet<string>;
}

export interface FeatureArea {
  featureId: string;
  slices: readonly FeatureAreaRepoSlice[];
  truncated: boolean;
  limits: readonly IntentDerivationLimit[];
  queriesUsed: number;
}

/** One applicability hit. */
export interface ItemApplicability {
  itemId: string;
  /** Every reason that holds, in enum order; never empty for a returned hit. */
  reasons: IntentMatchReason[];
  /** Anchors that produced an anchor-derived reason, for explainability. */
  matchedAnchors: ItemAnchorRef[];
}

/** Per-repo graph provenance carried on every derived response (§6.3). */
export interface RepoGraphProvenance {
  repoKey: string | null;
  repoName: string;
  graphRepoHash: string;
  /** The immutable snapshot the read was served from; null on the legacy plane. */
  graphVersionId: string | null;
  /** When this repository last pushed into that workspace graph. */
  pushedAt: string | null;
  snapshotFreshness: SnapshotFreshness;
  /** Commit the snapshot was parsed at, when it recorded one. */
  graphCommit?: string;
  /** Commit the caller says they are looking at, when they said. */
  observedCommit?: string;
}

/** Anchor evidence for one item (§6.4), reported independently of provenance. */
export interface ItemAnchorEvidence {
  itemId: string;
  anchors: AnchorEvidence[];
  /** Present only when the item declares no anchors. */
  unmapped?: true;
}

export type IntentDerivationEvidence =
  | {
      available: true;
      items: ItemAnchorEvidence[];
      repos: RepoGraphProvenance[];
    }
  | {
      available: false;
      items?: undefined;
      /**
       * Provenance is still reported when the control plane could describe the
       * repos — a caller must be able to say WHICH graph was unreadable.
       */
      repos: RepoGraphProvenance[];
    };

/**
 * Why part of the derivation could not run.
 *
 * Present on BOTH degraded shapes, which are deliberately different:
 * an unreadable snapshot also sets `evidence.available: false`, while a
 * readable snapshot on a backend that cannot answer batched traversals keeps
 * evidence (anchorStatus still resolves) and loses only anchor-derived
 * applicability. Collapsing the two would tell a Turso workspace its intent has
 * no evidence, which is false.
 */
export interface IntentDerivationDegradation {
  code: IntentGraphUnavailableCode;
  remediation: string;
}

export interface IntentDerivationResult {
  applicable: ItemApplicability[];
  evidence: IntentDerivationEvidence;
  /** Present exactly when something degraded; never a silent omission. */
  degradation?: IntentDerivationDegradation;
  /** True when ANY bound tripped — area, applicability, or a step cap. */
  truncated: boolean;
  limits: IntentDerivationLimit[];
  queriesUsed: number;
}

/** Reverse direction (§6.2): the items that apply to a set of code nodes. */
export interface IntentNodeDerivationResult extends IntentDerivationResult {
  /** Features whose derived area covers at least one queried node. */
  matchedFeatureIds: string[];
  /**
   * The narrowing that would let this read derive completely, present exactly
   * when a bound stopped the walk before every candidate feature was checked.
   *
   * `truncated` says the answer is short; this says what to ask instead. A
   * caller that only ever hears "truncated" has no move except to re-send the
   * same request, which is why the honest marker alone was a support burden
   * rather than an answer.
   */
  scopeSuggestion?: string;
}
