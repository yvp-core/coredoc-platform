/**
 * One zod schema per intent operation (spec §7), shared by the REST DTO
 * validation and the MCP tool parameters.
 *
 * Conventions carried from the archived contract:
 * - Every object is `.strict()`. An unknown key is a REFUSAL, not a silently
 *   dropped field: that is what keeps prompts, transcripts, and arbitrary
 *   blobs out of the workspace.
 * - Ids that a REST route carries in its path are ALSO in the body, because the
 *   MCP surface has no path. A controller asserts the two agree; the schema is
 *   the single shape both surfaces validate against.
 * - `z.record(z.string(), z.unknown())` rather than `z.unknown()` for free-form
 *   JSON. An `unknown` slot becomes an unconstrained MCP schema, and agents then
 *   serialize the object as a string — the record at least says "JSON object".
 */
import {
  ContextConditionSchema,
  INTENT_LIMITS,
  IntentDimensionSchema,
  IntentKind,
  TreeConditionsSchema,
  validateIntentPayload,
} from '@coredoc/core';
import { z } from 'zod';
import {
  INTENT_CONTRACT_LIMITS,
  IntentAuthorizingSourceSchema,
  IntentSourceSchema,
  IntentWorkItemSchema,
  graphNodeId,
  idempotencyKey,
  itemVersion,
  repoKey,
  slugId,
  text,
  canonicalRevision,
  externalUrl,
} from './intent-primitives.js';

/** Every mutation is idempotency-keyed (spec §7). */
const mutation = { idempotencyKey };

/* ------------------------------------------------------------------ tree --- */

export const CreateIntentDomainSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    appliesWhen: TreeConditionsSchema.optional(),
  })
  .strict();

/**
 * Ids are immutable (spec §4.1): an update names the domain and carries only
 * mutable fields, and must actually change something — an empty update is a
 * caller bug, not a no-op to absorb.
 */
export const UpdateIntentDomainSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title).optional(),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    /** Replaces the node's conditions; `[]` clears them. */
    appliesWhen: TreeConditionsSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.statement !== undefined || value.appliesWhen !== undefined,
    'an update must change at least one of title, statement or appliesWhen',
  );

/** Archiving is an explicit flag, both ways: un-archiving is the same operation. */
export const ArchiveIntentDomainSchema = z.object({ ...mutation, id: slugId(), archived: z.boolean() }).strict();

export const CreateIntentFeatureSchema = z
  .object({
    ...mutation,
    id: slugId(),
    domainId: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    appliesWhen: TreeConditionsSchema.optional(),
  })
  .strict();

export const UpdateIntentFeatureSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title).optional(),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    /** Replaces the node's conditions; `[]` clears them. */
    appliesWhen: TreeConditionsSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.statement !== undefined || value.appliesWhen !== undefined,
    'an update must change at least one of title, statement or appliesWhen',
  );

export const ArchiveIntentFeatureSchema = z.object({ ...mutation, id: slugId(), archived: z.boolean() }).strict();

/**
 * A seed is identified by `(featureId, repoKey, nodeId)` — no surrogate id to
 * keep in sync. `put` is therefore the same call for "declare" and "re-note".
 */
export const PutIntentFeatureSeedSchema = z
  .object({
    ...mutation,
    featureId: slugId(),
    repoKey,
    nodeId: graphNodeId,
    note: text(INTENT_CONTRACT_LIMITS.text).optional(),
  })
  .strict();

export const DeleteIntentFeatureSeedSchema = z
  .object({ ...mutation, featureId: slugId(), repoKey, nodeId: graphNodeId })
  .strict();

/* ------------------------------------------------------------ dimensions --- */

/** Core's registry shape: values `{id, title, aliases?}`, unique value ids, bounded. */
const dimensionValues = IntentDimensionSchema.shape.values;

/** A workspace context dimension (country, plan, role, …). `archived` is its own action. */
export const CreateIntentDimensionSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    values: dimensionValues,
    multi: z.boolean().optional(),
  })
  .strict();

/**
 * `values` REPLACES the list. Dropping a value is refused while an item still
 * references it (BR-7); a value is renamed by keeping its id and changing its title.
 */
export const UpdateIntentDimensionSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title).optional(),
    values: dimensionValues.optional(),
    multi: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.values !== undefined || value.multi !== undefined,
    'an update must change at least one of title, values, or multi',
  );

export const ArchiveIntentDimensionSchema = z.object({ ...mutation, id: slugId(), archived: z.boolean() }).strict();

export const DeleteIntentDimensionSchema = z.object({ ...mutation, id: slugId() }).strict();

/** The registry read. Archived dimensions are hidden unless asked for, like archived domains. */
export const ListIntentDimensionsQuerySchema = z
  .object({ includeArchived: z.enum(['true', 'false']).optional() })
  .strict();

/* --------------------------------------------------------------- propose --- */

/**
 * An anchor SUGGESTION on a proposal. It carries no `nodeType` and no
 * `capturedVersionedId`: graph facts are resolved server-side (spec §4.6), and
 * a suggestion on a candidate is not an anchor until the item is accepted.
 */
export const IntentAnchorSuggestionSchema = z
  .object({ repoKey, nodeId: graphNodeId, rationale: text(INTENT_CONTRACT_LIMITS.text).optional() })
  .strict();

export const ProposedIntentItemSchema = z
  .object({
    /**
     * Optional: an explicit id updates that candidate, an absent one lets the
     * server derive a kind-prefixed slug and dedupe by source identity.
     */
    id: slugId().optional(),
    kind: z.enum(IntentKind),
    title: text(INTENT_CONTRACT_LIMITS.title),
    /** Mandatory and self-contained: the item must state its rule without its payload (D9). */
    statement: text(INTENT_CONTRACT_LIMITS.statement),
    rationale: text(INTENT_CONTRACT_LIMITS.text).optional(),
    /**
     * OPTIONAL structured payload (D9), validated by the refinement below
     * through core's own per-kind payload validation — so a payload the cloud
     * accepts is one the local overlay format accepts, by construction. Typed
     * as a JSON object rather than `unknown` so the MCP schema says at least
     * that much.
     */
    payload: z.record(z.string(), z.unknown()).optional(),
    /**
     * Context conditions, AND-joined; absent = keep what is stored (unconditional
     * on create), `[]` = clear them. Registry and item references are checked by
     * propose against the workspace, not here.
     */
    appliesWhen: z.array(ContextConditionSchema).max(INTENT_LIMITS.conditionsPerItem).optional(),
    /**
     * Attachment: both absent = the product root (spec §4.4). A `featureId` places
     * the item in that feature; a `domainId` next to it is a check, not a second
     * placement — propose refuses it unless the feature belongs to that domain
     * (how a bootstrap packet proves "one packet, one domain" for a feature).
     */
    domainId: slugId().optional(),
    featureId: slugId().optional(),
    /** On a candidate: the accepted item this proposal intends to replace (spec §5). */
    proposedSuccessorOfId: slugId().optional(),
    sources: z.array(IntentSourceSchema).min(1).max(INTENT_CONTRACT_LIMITS.sourcesPerItem),
    anchorSuggestions: z.array(IntentAnchorSuggestionSchema).max(INTENT_CONTRACT_LIMITS.anchorsPerItem).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payload === undefined) return;
    for (const error of validateIntentPayload(value.kind, value.payload)) {
      context.addIssue({ code: 'custom', path: ['payload', ...error.path], message: error.message });
    }
  });

export const ProposeIntentItemsSchema = z
  .object({ ...mutation, items: z.array(ProposedIntentItemSchema).min(1).max(INTENT_CONTRACT_LIMITS.batch) })
  .strict()
  .superRefine((value, context) => {
    // Two proposals for one id in one batch have no defined order of application.
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (item.id === undefined) return;
      if (seen.has(item.id)) {
        context.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'duplicate item id in one batch' });
      }
      seen.add(item.id);
    });
  });

/* ---------------------------------------------------------------- review --- */

/**
 * `accept`, `reject`, and `supersede` change authority; `defer` and
 * `needs_edit` are reported outcomes that write nothing (spec §5, issue 04).
 * They are part of the same submitted batch so a reviewer's full pass over a
 * queue is one call with one result per item.
 */
export enum IntentReviewAction {
  Accept = 'accept',
  Reject = 'reject',
  Supersede = 'supersede',
  Defer = 'defer',
  NeedsEdit = 'needs_edit',
}

export const IntentReviewDecisionSchema = z
  .object({
    itemId: slugId(),
    /** Optimistic concurrency: the version the reviewer actually looked at (spec §5). */
    expectedVersion: itemVersion,
    action: z.enum(IntentReviewAction),
    /** `supersede` only: the accepted item's replacement, with the version the reviewer saw. */
    replacementItemId: slugId().optional(),
    replacementExpectedVersion: itemVersion.optional(),
    reason: text(INTENT_CONTRACT_LIMITS.text),
  })
  .strict()
  .superRefine((value, context) => {
    const supersede = value.action === IntentReviewAction.Supersede;
    if (supersede && (value.replacementItemId === undefined || value.replacementExpectedVersion === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['replacementItemId'],
        message: 'a supersede decision names the replacement item and the version of it the reviewer saw',
      });
      return;
    }
    if (!supersede && (value.replacementItemId !== undefined || value.replacementExpectedVersion !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['replacementItemId'],
        message: `replacement fields belong to a supersede decision, not to '${value.action}'`,
      });
      return;
    }
    if (supersede && value.replacementItemId === value.itemId) {
      context.addIssue({
        code: 'custom',
        path: ['replacementItemId'],
        message: 'an item cannot supersede itself',
      });
    }
  });

/**
 * Provenance sits on the BATCH, not the decision: one review pass is authorized
 * by one artifact and optionally one work item (spec §4.7, issue 04). The
 * per-decision `reason` is the reviewer's rationale for that item.
 */
export const ReviewIntentItemsSchema = z
  .object({
    ...mutation,
    authorizingSource: IntentAuthorizingSourceSchema,
    workItem: IntentWorkItemSchema.optional(),
    decisions: z.array(IntentReviewDecisionSchema).min(1).max(INTENT_CONTRACT_LIMITS.batch),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.decisions.forEach((decision, index) => {
      if (seen.has(decision.itemId)) {
        context.addIssue({
          code: 'custom',
          path: ['decisions', index, 'itemId'],
          message: 'two decisions on one item in a single batch',
        });
      }
      seen.add(decision.itemId);
    });
  });

/* --------------------------------------------------------------- anchors --- */

/** Anchor identity is `(itemId, repoKey, nodeId)`; the server resolves node type and versioned id. */
export const AddIntentAnchorSchema = z
  .object({
    ...mutation,
    itemId: slugId(),
    repoKey,
    nodeId: graphNodeId,
    rationale: text(INTENT_CONTRACT_LIMITS.text).optional(),
  })
  .strict();

/** Refresh re-resolves the drift baseline against the current snapshot. */
export const RefreshIntentAnchorSchema = z
  .object({ ...mutation, itemId: slugId(), repoKey, nodeId: graphNodeId })
  .strict();

export const RemoveIntentAnchorSchema = z
  .object({ ...mutation, itemId: slugId(), repoKey, nodeId: graphNodeId })
  .strict();

/* --------------------------------------------------------------- sources --- */

/**
 * Re-describe a source document on every item that cites it. `title` and `url`
 * are descriptive, not part of any source identity, so this never changes a
 * rule and may reach accepted items that a proposal cannot touch.
 */
export const UpdateIntentSourceSchema = z
  .object({
    ...mutation,
    ref: text(INTENT_CONTRACT_LIMITS.ref),
    title: text(INTENT_CONTRACT_LIMITS.title).optional(),
    url: externalUrl.optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.url !== undefined, 'an update must set title or url');

/* ---------------------------------------------------------------- import --- */

/**
 * Onboarding import (spec §8.1). The overlay is the local `IntentFileV2`
 * document; its full validation is core's `validateIntentFile` inside the
 * import service, not a second copy of the file schema here. This boundary
 * still says "JSON object" for the MCP-schema reason above, and the content
 * walk runs over the whole overlay with the import node budget.
 */
export const ImportIntentOverlaySchema = z
  .object({
    ...mutation,
    /** Revision of the local file, recorded on every imported item's transition. */
    localRevision: canonicalRevision,
    overlay: z.record(z.string(), z.unknown()),
  })
  .strict();

export type CreateIntentDomainInput = z.infer<typeof CreateIntentDomainSchema>;
export type UpdateIntentDomainInput = z.infer<typeof UpdateIntentDomainSchema>;
export type ArchiveIntentDomainInput = z.infer<typeof ArchiveIntentDomainSchema>;
export type CreateIntentFeatureInput = z.infer<typeof CreateIntentFeatureSchema>;
export type UpdateIntentFeatureInput = z.infer<typeof UpdateIntentFeatureSchema>;
export type ArchiveIntentFeatureInput = z.infer<typeof ArchiveIntentFeatureSchema>;
export type PutIntentFeatureSeedInput = z.infer<typeof PutIntentFeatureSeedSchema>;
export type DeleteIntentFeatureSeedInput = z.infer<typeof DeleteIntentFeatureSeedSchema>;
export type CreateIntentDimensionInput = z.infer<typeof CreateIntentDimensionSchema>;
export type UpdateIntentDimensionInput = z.infer<typeof UpdateIntentDimensionSchema>;
export type ArchiveIntentDimensionInput = z.infer<typeof ArchiveIntentDimensionSchema>;
export type DeleteIntentDimensionInput = z.infer<typeof DeleteIntentDimensionSchema>;
export type ListIntentDimensionsQuery = z.infer<typeof ListIntentDimensionsQuerySchema>;
export type ProposedIntentItemInput = z.infer<typeof ProposedIntentItemSchema>;
export type ProposeIntentItemsInput = z.infer<typeof ProposeIntentItemsSchema>;
export type IntentReviewDecisionInput = z.infer<typeof IntentReviewDecisionSchema>;
export type ReviewIntentItemsInput = z.infer<typeof ReviewIntentItemsSchema>;
export type AddIntentAnchorInput = z.infer<typeof AddIntentAnchorSchema>;
export type RefreshIntentAnchorInput = z.infer<typeof RefreshIntentAnchorSchema>;
export type RemoveIntentAnchorInput = z.infer<typeof RemoveIntentAnchorSchema>;
export type UpdateIntentSourceInput = z.infer<typeof UpdateIntentSourceSchema>;
export type ImportIntentOverlayInput = z.infer<typeof ImportIntentOverlaySchema>;
