/**
 * `CloudIntentExportV1` — the export projection format (spec §9).
 *
 * A format of its OWN, deliberately not the local `IntentFileV2`: it carries
 * cloud facts the overlay has no place for (features, seeds, versions, the
 * authority history) and it is never a write authority — the server does not
 * read it back.
 *
 * ===========================================================================
 * DETERMINISM CONTRACT — what is hashed and what is volatile
 * ===========================================================================
 * The document is split so the determinism claim is checkable rather than
 * approximate:
 *
 * - `content` holds EVERYTHING that comes from committed rows. Its canonical
 *   bytes ({@link canonicalIntentJson}: object keys sorted at every depth,
 *   array order preserved) are byte-identical across two exports with no
 *   intervening committed intent write, and differ the moment one commits.
 * - `contentHash` is `sha256` over exactly those bytes. It therefore changes
 *   exactly when committed intent state or history changed (spec §14).
 * - `generatedAt` is the ONE volatile field. It is outside `content` and
 *   outside the hash, so "when was this taken" never masquerades as "what
 *   changed".
 *
 * Row identity is NATURAL, never surrogate: the `BigInt` autoincrement primary
 * keys of sources, anchors, seeds, and transitions are dropped, because a row
 * re-created with identical content would otherwise change the hash while
 * nothing a reader cares about changed. Every collection is sorted by its
 * natural key.
 *
 * The ops `AuditEvent` trail is deliberately absent (spec §9); transitions are
 * the decision history and they ARE included.
 */
import { createHash } from 'node:crypto';
import { canonicalIntentJson } from '@coredoc/core';

export const CLOUD_INTENT_EXPORT_FORMAT_VERSION = 1;

export interface CloudIntentExportDomain {
  id: string;
  title: string;
  statement: string;
  /** Tree conditions; absent when the node has none. */
  appliesWhen?: unknown;
  /** The node's document layout; absent when it has none. */
  layout?: unknown;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIntentExportFeature extends CloudIntentExportDomain {
  domainId: string;
  /** Absent at the top level, so exports without nesting keep their bytes. */
  parentFeatureId?: string;
}

export interface CloudIntentExportSeed {
  featureId: string;
  repoKey: string;
  nodeId: string;
  note: string | null;
  createdAt: string;
}

export interface CloudIntentExportItem {
  id: string;
  kind: string;
  domainId: string | null;
  featureId: string | null;
  title: string;
  statement: string;
  payload: unknown;
  /** Context conditions; absent when unconditioned, so pre-dimensions exports keep their bytes. */
  appliesWhen?: unknown;
  rationale: string | null;
  /** Lines under the statement; absent when there are none. */
  body?: unknown;
  authority: string;
  proposedSuccessorOfId: string | null;
  supersededById: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIntentExportDimension {
  id: string;
  title: string;
  values: unknown;
  multi: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIntentExportSource {
  itemId: string;
  kind: string;
  ref: string;
  localId: string;
  revision: string | null;
  locator: string | null;
  /** Descriptive, not identifying — identity stays `(ref, localId)`. */
  title: string | null;
  url: string | null;
}

export interface CloudIntentExportAnchor {
  source: string;
  disabledAt: string | null;
  disabledBy: string | null;
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  createdAt: string;
}

/**
 * `anchorStatus` is absent on purpose: it is derived at read time against the
 * current graph (spec §4.6), so an export could only ever record a snapshot
 * opinion that ages into a lie.
 */
export interface CloudIntentExportTransition {
  itemId: string;
  fromAuthority: string | null;
  toAuthority: string;
  actorId: string;
  actorRole: string;
  reason: string;
  sourceKind: string;
  sourceRef: string;
  sourceLocalId: string | null;
  sourceRevision: string | null;
  workItem: unknown;
  createdAt: string;
}

/** Everything derived from committed rows. Hashed in full. */
export interface CloudIntentExportContent {
  workspaceId: string;
  tree: {
    domains: CloudIntentExportDomain[];
    features: CloudIntentExportFeature[];
    seeds: CloudIntentExportSeed[];
  };
  /** The context-dimension registry; absent when the workspace declares none. */
  dimensions?: CloudIntentExportDimension[];
  items: CloudIntentExportItem[];
  sources: CloudIntentExportSource[];
  anchors: CloudIntentExportAnchor[];
  transitions: CloudIntentExportTransition[];
}

export interface CloudIntentExportV1 {
  formatVersion: number;
  /** VOLATILE. Outside `content`, outside `contentHash`. */
  generatedAt: string;
  /** `sha256` hex over the canonical bytes of `content`. */
  contentHash: string;
  content: CloudIntentExportContent;
}

/** The exact bytes `contentHash` covers. Exposed so a consumer can re-verify. */
export function canonicalExportContentBytes(content: CloudIntentExportContent): string {
  return canonicalIntentJson(content);
}

export function hashExportContent(content: CloudIntentExportContent): string {
  return createHash('sha256').update(canonicalExportContentBytes(content)).digest('hex');
}
