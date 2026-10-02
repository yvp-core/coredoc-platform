/**
 * Shared zod primitives for the intent operation schemas.
 *
 * Lifted from the archived `intent-authority.contract.ts` (`text`,
 * `externalUrl`, the domain-slug regex, the `source` and `workItem` shapes).
 * One schema instance per concept, reused by the REST DTOs and the MCP tool
 * parameters — the archive's one-schema-two-surfaces pattern, which is what
 * makes drift between the two surfaces unrepresentable rather than merely
 * unlikely.
 */
import { INTENT_LIMITS, IntentSourceKind } from '@coredoc/core';
import { z } from 'zod';

/**
 * Bounded lengths, TAKEN from `INTENT_LIMITS` in `@coredoc/core` wherever the
 * cloud bounds the same value the local overlay format bounds.
 *
 * They are imported rather than restated, so drift between the two surfaces is
 * unrepresentable rather than merely test-detected: a bound the cloud enforces
 * is the bound core enforces, by construction. What this table still owns is
 * the MAPPING — which core bound governs which cloud field (a repo key is
 * bounded as an identity, a node id as a ref) — and the two bounds core has no
 * opinion about (`capturedVersionedId`, `batch`). `intent-primitives.test.ts`
 * probes core's real enforcement per field, so a re-pointed mapping fails there.
 *
 * EVERY NUMBER HERE IS ALSO A COLUMN WIDTH. A contract bound LOOSER than the
 * `VARCHAR(n)` it lands in is not a laxer rule — it is a §12 refusal converted
 * into a Postgres `22001` and a 500, with no path to tell the caller which field
 * was too long. `intent-primitives.test.ts` pins each bound to the migration's
 * column, so widening one here without widening the column fails there.
 */
export const INTENT_CONTRACT_LIMITS = {
  /** `intent_{domains,features,items}.title` VARCHAR(200). */
  title: INTENT_LIMITS.title,
  /** `intent_{domains,features,items}.statement` VARCHAR(2000). */
  statement: INTENT_LIMITS.statement,
  /** Any single free-text field: rationale, reason, note, seed note. All VARCHAR(2000). */
  text: INTENT_LIMITS.text,
  /**
   * Foreign identities: idempotency keys, source `localId`/`revision`.
   * `intent_mutation_requests.idempotency_key`, `intent_item_sources.local_id`
   * and `.revision`, `intent_authority_transitions.source_local_id` and
   * `.source_revision` — all VARCHAR(200).
   */
  id: INTENT_LIMITS.id,
  /** Item, domain, and feature ids are slugs quoted in hand-offs. All columns VARCHAR(64). */
  slugId: INTENT_LIMITS.itemId,
  /** `intent_item_sources.ref`/`.locator`, `intent_authority_transitions.source_ref` — VARCHAR(500). */
  ref: INTENT_LIMITS.ref,
  sourcesPerItem: INTENT_LIMITS.sourcesPerItem,
  anchorsPerItem: INTENT_LIMITS.anchorsPerItem,
  /**
   * `intent_anchors.repo_key` and `intent_feature_seeds.repo_key` are
   * VARCHAR(200), and core bounds an overlay's `repo` at its own `id` bound of
   * 200. This was 256 — wide enough for a 201-character repo key to pass the
   * contract and then fail in the driver.
   */
  repoKey: INTENT_LIMITS.id,
  /**
   * `intent_anchors.node_id` and `intent_feature_seeds.node_id` are VARCHAR(500),
   * and core bounds an overlay's anchor `nodeId` at its `ref` bound of 500. This
   * was 2000 — four times the column, so a long node id was a 500 rather than a
   * refusal naming `nodeId`.
   */
  nodeId: INTENT_LIMITS.ref,
  /**
   * `intent_anchors.captured_versioned_id` VARCHAR(500). The drift baseline is
   * resolved SERVER-side from the graph (spec §4.6), so no request field carries
   * it and no zod schema below uses this bound; it is stated because the value
   * is derived from a `nodeId` plus a version suffix and therefore is NOT
   * automatically inside the column just because `nodeId` is.
   */
  capturedVersionedId: 500,
  /** `intent_node_relations.why` VARCHAR(500): one sentence on why a reader should follow the link. */
  relationWhy: 500,
  /** Blocks in one node layout, and lines in one prose block or item body. */
  layoutBlocks: 1_000,
  layoutLines: 400,
  /**
   * Items per propose batch and decisions per review batch. The archive's bound;
   * a review batch is a human ceremony and a bootstrap packet is scoped to one
   * domain, so ten is a working size, not a technical ceiling.
   */
  batch: 10,
  /** Values on one context dimension; stored in `intent_dimensions.values` JSONB, bounded by core. */
  valuesPerDimension: INTENT_LIMITS.valuesPerDimension,
  /**
   * Item ids a `dimension_in_use` refusal names. The refusal is for a human to
   * act on, and the same bound as a tree delete's blocker list.
   */
  dimensionInUseItems: 20,
} as const;

/**
 * Slug form for item, domain, and feature ids: lowercase `a-z0-9` words joined
 * by single hyphens, first word starting with a letter. Restated from
 * `INTENT_SLUG_PATTERN` (`@coredoc/core`, not exported from its barrel); the
 * archive carried its own copy of the same regex for the same reason.
 */
export const INTENT_SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A required, trimmed, bounded string. Empty and whitespace-only are rejected. */
export const text = (max: number) => z.string().trim().min(1).max(max);

/** A slug id (`ordering`, `br-refund-window`). */
export const slugId = (max: number = INTENT_CONTRACT_LIMITS.slugId) =>
  text(max).regex(INTENT_SLUG_PATTERN, 'id must be a lowercase slug: a-z0-9 words joined by single hyphens');

export const externalUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => ['https:', 'http:'].includes(new URL(value).protocol), 'URL must use http or https');

/** A positive optimistic-concurrency token. Version 0 never exists: a created row starts at 1. */
export const itemVersion = z.number().int().positive();

/** SHA-256 hex, e.g. the local overlay revision an import records. */
export const canonicalRevision = z.string().regex(/^[a-f0-9]{64}$/, 'revision must be a sha-256 hex digest');

/**
 * Provenance of an authority change (spec §4.7). The kinds are core's
 * `IntentSourceKind` plus `import`: an import records ARRIVAL of already-decided
 * content, which is not any of the four reviewed-artifact kinds. A TypeScript
 * enum cannot extend another, so the four values are restated; the
 * `intent-operations.test.ts` guard asserts this enum stays a superset of
 * core's.
 */
export enum IntentAuthorizingSourceKind {
  Spec = 'spec',
  Issue = 'issue',
  Adr = 'adr',
  Manual = 'manual',
  Import = 'import',
}

/** An item's provenance row (spec §4.5). Identity is `(ref, localId)`. */
export const IntentSourceSchema = z
  .object({
    kind: z.enum(IntentSourceKind),
    ref: text(INTENT_CONTRACT_LIMITS.ref),
    localId: text(INTENT_CONTRACT_LIMITS.id),
    revision: text(INTENT_CONTRACT_LIMITS.id).optional(),
    locator: text(INTENT_CONTRACT_LIMITS.ref).optional(),
    title: text(INTENT_CONTRACT_LIMITS.title).optional(),
    url: externalUrl.optional(),
  })
  .strict();

/** The artifact that authorizes an authority transition (spec §4.7). */
export const IntentAuthorizingSourceSchema = z
  .object({
    kind: z.enum(IntentAuthorizingSourceKind),
    ref: text(INTENT_CONTRACT_LIMITS.ref),
    localId: text(INTENT_CONTRACT_LIMITS.id),
    revision: text(INTENT_CONTRACT_LIMITS.id).optional(),
  })
  .strict()
  .refine((source) => source.kind !== IntentAuthorizingSourceKind.Spec || source.revision !== undefined, {
    path: ['revision'],
    message: 'Specification approval requires the approved commit or content digest.',
  });

/** Optional delivery reference on a transition (spec §4.7). */
export const IntentWorkItemSchema = z
  .object({
    provider: text(64),
    id: text(256),
    displayKey: text(256).optional(),
    url: externalUrl.optional(),
  })
  .strict();

/**
 * Idempotency key on every mutation (spec §7). Opaque to the server: it is
 * hashed with the request into the mutation ledger, never parsed.
 */
export const idempotencyKey = text(INTENT_CONTRACT_LIMITS.id);

/** Durable repo identity within the workspace (spec §6.5). */
export const repoKey = text(INTENT_CONTRACT_LIMITS.repoKey);

/** A code-graph node id. The server resolves its type and versioned id; the caller never supplies graph facts. */
export const graphNodeId = text(INTENT_CONTRACT_LIMITS.nodeId);

export type IntentSourceInput = z.infer<typeof IntentSourceSchema>;
export type IntentAuthorizingSourceInput = z.infer<typeof IntentAuthorizingSourceSchema>;
export type IntentWorkItemInput = z.infer<typeof IntentWorkItemSchema>;
