/**
 * The result contract of onboarding import (spec §8.1).
 *
 * Its own file because it is a DURABLE format, not a service return type: the
 * response is stored verbatim in the idempotency ledger, so a retried import
 * replays this exact document months later and the CLI must still be able to
 * read it. That is also why `formatVersion` is here and why every field is a
 * plain JSON scalar or array — `Prisma.InputJsonValue` is what actually lands
 * in `intent_mutation_requests.response`.
 *
 * WHAT THE RESULT MUST NOT DO: hide a fact the import decided not to carry
 * over. Two such facts exist, and each has a field of its own — generic
 * relations (never imported, spec §8.1) and anchors whose repository identity
 * this workspace does not carry. Both are named rather than counted.
 */
import type { IntentItemAuthority } from '../../generated/prisma/client.js';

/** Bumped only if the shape changes in a way a stored older result would not satisfy. */
export const CLOUD_INTENT_IMPORT_FORMAT_VERSION = 1;

/** Why an anchor in the overlay did not become an `intent_anchors` row. */
export enum IntentImportSkipReason {
  /**
   * The anchor's `repo` is not a durable intent identity registered in this
   * workspace (spec §6.5), so there is no `repoKey` to store it under. It is
   * NOT invented from the repo name: an anchor under a fabricated key would
   * resolve `missing` against every snapshot forever, which is worse than an
   * absent anchor a maintainer can re-add with `anchor add`.
   */
  UnknownRepoKey = 'unknown_repo_key',
}

/**
 * Anchors skipped for one unresolvable repository identity.
 *
 * Grouped by identity rather than listed one-per-anchor because the identity is
 * the actionable unit — every anchor under it becomes importable the moment
 * that repo is connected and bound — and because a flat list on a maximal
 * overlay (500 items × 20 anchors) is a ledger row nobody wants to store.
 * `itemIds` is deduped and sorted, so the report stays bounded by the item
 * count while still naming exactly what lost its evidence.
 */
export interface CloudIntentImportSkippedAnchors {
  /** The overlay anchor's `repo` value, verbatim. */
  repo: string;
  reason: IntentImportSkipReason;
  /** How many anchor entries in the overlay named this identity. */
  anchorCount: number;
  /** Items that lost at least one anchor to this identity. Deduped, sorted. */
  itemIds: string[];
}

/** A generic overlay relation that import deliberately did not carry (spec §8.1). */
export interface CloudIntentDroppedRelation {
  from: string;
  type: string;
  to: string;
}

export interface CloudIntentImportedItem {
  id: string;
  /** Preserved from the overlay; import never promotes or demotes. */
  authority: IntentItemAuthority;
  domainId: string;
}

export interface CloudIntentImportResultV1 {
  formatVersion: number;
  workspaceId: string;
  /** The overlay revision recorded on every item's `import` transition. */
  localRevision: string;
  /** The overlay's own `projectId`, echoed so a stored result is traceable to its source. */
  projectId: string;
  createdDomains: Array<{ id: string; title: string }>;
  importedItems: CloudIntentImportedItem[];
  importedSourceCount: number;
  importedAnchorCount: number;
  skippedAnchors: CloudIntentImportSkippedAnchors[];
  /** Every relation in the overlay: none is imported, all are named. */
  droppedRelations: CloudIntentDroppedRelation[];
  /** What this workspace DOES carry, so an unresolved anchor identity is diagnosable in one round trip. */
  registeredRepoIdentities: string[];
}
