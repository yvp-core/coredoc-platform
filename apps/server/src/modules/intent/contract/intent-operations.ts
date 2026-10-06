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
  IntentAuthority,
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
  externalUrl,
} from './intent-primitives.js';

/** Every mutation is idempotency-keyed (spec §7). */
const mutation = { idempotencyKey };

/** One Markdown line. Empty lines are kept: they separate paragraphs and list items. */
const markdownLine = z.string().max(INTENT_CONTRACT_LIMITS.text);

/**
 * A node as a document, in order: headings, prose lines, and slots that place
 * an item. The node read renders it verbatim; an item with no slot is
 * appended under its kind's section. `style: heading` renders an item as
 * `### <id>` (use cases, flows), `style: prose` as plain paragraphs (a node's
 * overview), and the default is a `- **<id>** — ` bullet.
 */
export const IntentNodeLayoutSchema = z
  .array(
    z.union([
      z.object({ heading: text(INTENT_CONTRACT_LIMITS.title), level: z.union([z.literal(2), z.literal(3)]) }).strict(),
      z.object({ lines: z.array(markdownLine).min(1).max(INTENT_CONTRACT_LIMITS.layoutLines) }).strict(),
      z.object({ item: slugId(), style: z.enum(['bullet', 'heading', 'prose']).optional() }).strict(),
    ]),
  )
  .max(INTENT_CONTRACT_LIMITS.layoutBlocks);

/** Lines under an item's statement: use-case bullets, flow steps, a diagram. */
export const IntentItemBodySchema = z.array(markdownLine).min(1).max(INTENT_CONTRACT_LIMITS.layoutLines);

/* ------------------------------------------------------------------ tree --- */

export const CreateIntentDomainSchema = z
  .object({
    ...mutation,
    id: slugId(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    appliesWhen: TreeConditionsSchema.optional(),
    layout: IntentNodeLayoutSchema.optional(),
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
    /** Replaces the node's layout; `[]` clears it. */
    layout: IntentNodeLayoutSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.statement !== undefined ||
      value.appliesWhen !== undefined ||
      value.layout !== undefined,
    'an update must change at least one of title, statement, appliesWhen or layout',
  );

/** Archiving is an explicit flag, both ways: un-archiving is the same operation. */
export const ArchiveIntentDomainSchema = z.object({ ...mutation, id: slugId(), archived: z.boolean() }).strict();

export const CreateIntentFeatureSchema = z
  .object({
    ...mutation,
    id: slugId(),
    domainId: slugId(),
    /** A feature of the same domain this one sits under; absent = top level. */
    parentFeatureId: slugId().optional(),
    title: text(INTENT_CONTRACT_LIMITS.title),
    statement: text(INTENT_CONTRACT_LIMITS.statement).optional(),
    appliesWhen: TreeConditionsSchema.optional(),
    layout: IntentNodeLayoutSchema.optional(),
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
    /** Replaces the node's layout; `[]` clears it. */
    layout: IntentNodeLayoutSchema.optional(),
    /** Moves the feature under another feature of its domain; `null` moves it to the top level. */
    parentFeatureId: slugId().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.statement !== undefined ||
      value.appliesWhen !== undefined ||
      value.layout !== undefined ||
      value.parentFeatureId !== undefined,
    'an update must change at least one of title, statement, appliesWhen, layout or parentFeatureId',
  );

export const ArchiveIntentFeatureSchema = z.object({ ...mutation, id: slugId(), archived: z.boolean() }).strict();

/**
 * Deleting a domain or feature is refused while it still holds children or
 * attached items (spec §4.1/§4.2), so the request needs nothing but the id —
 * there is no cascade to opt into and no force flag to add.
 */
export const DeleteIntentDomainSchema = z.object({ ...mutation, id: slugId() }).strict();
export const DeleteIntentFeatureSchema = z.object({ ...mutation, id: slugId() }).strict();

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

/* ------------------------------------------------------- node relations --- */

/** A tree node by kind and id. Domain and feature ids live in separate tables, so the kind is part of the identity. */
export const IntentNodeRefSchema = z
  .object({
    kind: z.enum(['domain', 'feature']).describe("'domain' or 'feature'"),
    id: slugId(),
  })
  .strict();

/**
 * "See also" between two nodes, with the reason a reader should follow it.
 * Like `seed.put`, a put both declares a relation and re-words its reason:
 * the identity is the unordered pair of endpoints.
 */
export const PutIntentNodeRelationSchema = z
  .object({
    ...mutation,
    from: IntentNodeRefSchema,
    to: IntentNodeRefSchema,
    why: text(INTENT_CONTRACT_LIMITS.relationWhy),
  })
  .strict();

export const DeleteIntentNodeRelationSchema = z
  .object({ ...mutation, from: IntentNodeRefSchema, to: IntentNodeRefSchema })
  .strict();

/* ------------------------------------------------------------- comments --- */

export const IntentCommentStatus = ['open', 'resolved'] as const;

/** What a comment thread is about: a feature or an item. */
export const IntentCommentTargetSchema = z
  .object({ kind: z.enum(['feature', 'item']).describe("'feature' or 'item'"), id: slugId() })
  .strict();

/** A new thread names its target; a reply names its thread's root and takes the root's target. */
export const CreateIntentCommentSchema = z
  .object({
    ...mutation,
    target: IntentCommentTargetSchema.optional(),
    parentId: z.uuid().optional(),
    body: text(INTENT_CONTRACT_LIMITS.text),
  })
  .strict()
  .refine((value) => (value.target === undefined) !== (value.parentId === undefined), {
    message: 'Name exactly one of target (a new thread) or parentId (a reply)',
    path: ['target'],
  });

export const SetIntentCommentStatusSchema = z
  .object({ ...mutation, id: z.uuid(), status: z.enum(IntentCommentStatus) })
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
    /**
     * Mandatory and self-contained: one sentence that states the rule (or who wants
     * what) without its body or payload (D9). Longer text belongs in `body`.
     */
    statement: text(INTENT_CONTRACT_LIMITS.statement).describe(
      'One sentence that stands alone without its body or payload: the rule, or who wants what',
    ),
    rationale: text(INTENT_CONTRACT_LIMITS.text).optional(),
    /** Markdown lines under the statement; absent keeps what is stored. */
    body: IntentItemBodySchema.optional().describe(
      'Everything else the item says, as Markdown lines: use-case bullets, numbered flow steps, a diagram. Absent ' +
        'keeps the stored body',
    ),
    /**
     * OPTIONAL structured payload (D9), validated by the refinement below
     * through core's own per-kind payload validation. Typed
     * as a JSON object rather than `unknown` so the MCP schema says at least
     * that much.
     */
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Structured detail validated per kind; a business_rule payload may carry variants [{when?, outcome, inputs?}], ' +
          'one outcome per context, at most one without when',
      ),
    /**
     * Context conditions, AND-joined; absent = keep what is stored (unconditional
     * on create), `[]` = clear them. Registry and item references are checked by
     * propose against the workspace, not here.
     */
    appliesWhen: z
      .array(ContextConditionSchema)
      .max(INTENT_LIMITS.conditionsPerItem)
      .optional()
      .describe(
        'When the item applies: AND-joined clauses {dimension, in: [values]} | {dimension, notIn: [values]} | ' +
          '{item: id} | {text} ({text} is never evaluated). [] clears the conditions; absent keeps what is stored',
      ),
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

/** Preview is a read: it resolves what a write would and writes nothing, so it carries no idempotency key. */
export const PreviewIntentAnchorQuerySchema = z.object({ itemId: slugId(), repoKey, nodeId: graphNodeId }).strict();

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

/* ----------------------------------------------------------- list queries --- */

/**
 * Shared list parameters. `limit` and `cursor` are parsed by the cursor codec
 * (they carry their own refusals), so they are strings here.
 */
const listQuery = {
  cursor: z.string().optional(),
  limit: z.string().optional(),
};

/**
 * Archived nodes are hidden from browse defaults and stay readable on request
 * (spec §4.1). An explicit `'true'` opts in — archiving is a visibility state,
 * never a deletion, and the KB must be able to show it.
 */
const includeArchived = z.enum(['true', 'false']).optional();

export const ListIntentTreeQuerySchema = z.object({ ...listQuery, includeArchived }).strict();

export const ListIntentFeaturesQuerySchema = z
  .object({ ...listQuery, includeArchived, domainId: slugId().optional() })
  .strict();

/** One node's document: the product root with neither id, a domain, or a feature. */
export const IntentNodeDocumentQuerySchema = z
  .object({
    domainId: slugId().optional(),
    featureId: slugId().optional(),
    includeCandidates: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const ListIntentFeatureSeedsQuerySchema = z.object({ ...listQuery }).strict();

/**
 * The browse INDEX of items — ids, titles, kinds, attachment, authority,
 * version. Deliberately not the agent context read (issue 07): no selectors, no
 * derivation, no evidence. It is what a KB list view and a paging client need.
 */
export const ListIntentItemsQuerySchema = z
  .object({
    ...listQuery,
    production: z.enum(['true', 'false']).optional(),
    effectivity: z.enum(['effective', 'planned', 'withdrawn', 'not_effective', 'unknown']).optional(),
    sourceRef: z.string().min(1).max(2048).optional(),
    sourceKind: z.enum(['spec', 'issue', 'adr', 'manual']).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    authorities: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(IntentAuthority)).min(1).max(4))
      .optional(),
    kinds: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(IntentKind)).min(1).max(6))
      .optional(),
    scopeFeatureId: slugId().optional(),
    /** Only live decisions whose choice is still open (the tree's `openQuestionCount`). */
    openQuestions: z.enum(['true', 'false']).optional(),
    /** Only items with at least one open comment thread. */
    openComments: z.enum(['true', 'false']).optional(),
    authority: z.enum(IntentAuthority).optional(),
    kind: z.enum(IntentKind).optional(),
    domainId: slugId().optional(),
    featureId: slugId().optional(),
  })
  .strict();

/**
 * The REVIEW QUEUE read (issue v1.1-04): the candidates-only slice of the item
 * index, plus the counts a reviewer surface needs before it pages anything.
 *
 * There is no `authority` parameter, deliberately: the queue IS the candidate
 * set, and a filter that could widen it to accepted items would make the badge
 * and the list disagree. The three filters are the ones a reviewer works
 * through — a domain, one feature inside it, or one kind of statement.
 */
export const ListIntentReviewQueueQuerySchema = z
  .object({
    ...listQuery,
    kind: z.enum(IntentKind).optional(),
    domainId: slugId().optional(),
    featureId: slugId().optional(),
  })
  .strict();

/** One target's threads, oldest first; `status` filters on the root's status. */
export const ListIntentCommentsQuerySchema = z
  .object({
    ...listQuery,
    featureId: slugId().optional(),
    itemId: slugId().optional(),
    status: z.enum(IntentCommentStatus).optional(),
  })
  .strict()
  .refine((value) => (value.featureId === undefined) !== (value.itemId === undefined), {
    message: 'Name exactly one of featureId or itemId',
    path: ['featureId'],
  });

export const ListIntentSourcesQuerySchema = z.object({ search: z.string().trim().max(200).optional() }).strict();

export type CreateIntentDomainInput = z.infer<typeof CreateIntentDomainSchema>;
export type UpdateIntentDomainInput = z.infer<typeof UpdateIntentDomainSchema>;
export type ArchiveIntentDomainInput = z.infer<typeof ArchiveIntentDomainSchema>;
export type CreateIntentFeatureInput = z.infer<typeof CreateIntentFeatureSchema>;
export type UpdateIntentFeatureInput = z.infer<typeof UpdateIntentFeatureSchema>;
export type ArchiveIntentFeatureInput = z.infer<typeof ArchiveIntentFeatureSchema>;
export type DeleteIntentDomainInput = z.infer<typeof DeleteIntentDomainSchema>;
export type DeleteIntentFeatureInput = z.infer<typeof DeleteIntentFeatureSchema>;
export type PutIntentFeatureSeedInput = z.infer<typeof PutIntentFeatureSeedSchema>;
export type DeleteIntentFeatureSeedInput = z.infer<typeof DeleteIntentFeatureSeedSchema>;
export type IntentNodeRefInput = z.infer<typeof IntentNodeRefSchema>;
export type PutIntentNodeRelationInput = z.infer<typeof PutIntentNodeRelationSchema>;
export type DeleteIntentNodeRelationInput = z.infer<typeof DeleteIntentNodeRelationSchema>;
export type CreateIntentCommentInput = z.infer<typeof CreateIntentCommentSchema>;
export type SetIntentCommentStatusInput = z.infer<typeof SetIntentCommentStatusSchema>;
export type ListIntentCommentsQuery = z.infer<typeof ListIntentCommentsQuerySchema>;
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
export type PreviewIntentAnchorQuery = z.infer<typeof PreviewIntentAnchorQuerySchema>;
export type ListIntentTreeQuery = z.infer<typeof ListIntentTreeQuerySchema>;
export type ListIntentFeaturesQuery = z.infer<typeof ListIntentFeaturesQuerySchema>;
export type ListIntentFeatureSeedsQuery = z.infer<typeof ListIntentFeatureSeedsQuerySchema>;
export type ListIntentItemsQuery = z.infer<typeof ListIntentItemsQuerySchema>;
export type ListIntentReviewQueueQuery = z.infer<typeof ListIntentReviewQueueQuerySchema>;
export type UpdateIntentSourceInput = z.infer<typeof UpdateIntentSourceSchema>;
