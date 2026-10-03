import { toolAnnotations } from '@coredoc/mcp';
import { McpAuthKind } from '../mcp-auth-context.js';
import { IntentHandoffService } from '../../modules/intent/intent-handoff.service.js';
import {
  IntentHandoffToolSchema,
  SaveIntentHandoffSchema,
  GetIntentHandoffSchema,
  ListIntentHandoffsSchema,
} from '../../modules/intent/intent-handoff.operations.js';
/**
 * The cloud intent MCP surface (spec §11): `get_intent_context`,
 * `intent_propose`, `intent_review`, `intent_tree`, `intent_anchor`, `intent_release`,
 * `intent_source_update`.
 *
 * ALWAYS REGISTERED, GATED PER WORKSPACE. The tools are static providers like
 * every other tool class here. The archive's env-gated `intentMcpProviders` is
 * deliberately discarded: MCP-Nest's registry is decorator-based and built
 * once, and a conditionally-registered tree tool would make the FIRST tree
 * write impossible on a workspace that has no intent content yet — which is
 * every workspace on the day this ships (§16, dark rollout). Registration is
 * therefore static; whether a workspace may LIST or CALL these tools is the
 * per-request fact `intentEnabled`, enforced by {@link IntentEnabledToolGuard}
 * on both `tools/list` and `tools/call`.
 *
 * STATES ARE RESULTS, NOT ERRORS. Three answers travel as typed results rather
 * than as thrown MCP errors, for the reason the local `get_intent_context`
 * gives: an agent that cannot get intent must be able to tell WHY and continue,
 * and a transport-level error is indistinguishable from a broken server.
 *   - `not_configured` — the workspace holds no domains, dimensions, or items.
 *   - `permission_denied` — the gate refused, naming what the call requires.
 *   - `error` — the §12 public triple, rendered by `renderIntentPublicError`
 *     and passed through untruncated (its own bound is the contract's).
 * A SUCCESSFUL answer is the service's response verbatim, with no wrapper and
 * no `status` field, so the MCP answer and the REST answer are the same bytes.
 *
 * NOT `BaseCoredocTool`. `executeWithMetrics` wraps every call in
 * `WorkspaceMcpContextService.withContext`, which LEASES the workspace graph
 * snapshot and throws `ACTIVE_VERSION_MISSING` when there is none. Intent is
 * readable and writable without a graph — §6.3 makes graph unavailability a
 * DEGRADATION, never an error — so these tools must not acquire that lease.
 * `IntentContextService` leases the graph itself, for exactly the part of the
 * answer that needs one. The metrics half of the base class is worth keeping
 * and is reproduced by {@link IntentTools.respond} without the lease.
 *
 * ONE SCHEMA, TWO SURFACES. Mutation parameters ARE the `contract/` operation
 * schemas the REST controllers validate against, and every body goes through
 * the same `parseContract` (schema + bounded-content walk), so the two surfaces
 * cannot drift and a content refusal names the same path on both. The context
 * read is the documented exception: its shared shape is a query STRING schema
 * (`intent-context.operations.ts` says so in its header), which no MCP tool
 * expresses that way — so this file declares the agent-facing native shape and
 * hands it to the same `normalizeIntentContextRequest`, which is where the
 * bounds and refusals actually live. `intent_tree` carries a second envelope of
 * its own ({@link parseEnvelope}) for the action it dispatches on; its BODY is
 * still validated by the shared operation schema, at the same paths.
 */
import { IntentReleaseService } from '../../modules/intent/intent-release.service.js';
import {
  ChangeIntentPlanSchema,
  IntentReleaseToolSchema,
  ListIntentReleasesSchema,
  PlanIntentReleaseSchema,
  PreviewIntentReleaseSchema,
  HumanRecordIntentReleaseSchema,
  RollbackIntentReleaseSchema,
} from '../../modules/intent/intent-release.operations.js';

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Tool, ToolGuards } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import type { Request } from 'express';
import { z } from 'zod';
import { INTENT_CONTEXT_LIMITS, IntentContextSchema, IntentKind } from '@coredoc/core';

import { TokenPermission } from '../../auth/token-permissions.js';
import type { WorkspaceMemberRole } from '../../modules/members/dto/workspace-role.enum.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';
import { IntentEnabledToolGuard } from '../intent-enabled.tool-guard.js';
import {
  AddIntentAnchorSchema,
  ArchiveIntentDimensionSchema,
  ArchiveIntentDomainSchema,
  ArchiveIntentFeatureSchema,
  CreateIntentDimensionSchema,
  CreateIntentDomainSchema,
  CreateIntentFeatureSchema,
  DeleteIntentDimensionSchema,
  DeleteIntentFeatureSeedSchema,
  DeleteIntentNodeRelationSchema,
  IntentErrorCode,
  INTENT_CONTRACT_LIMITS,
  INTENT_PUBLIC_ERROR_LIMITS,
  ProposeIntentItemsSchema,
  PutIntentFeatureSeedSchema,
  PutIntentNodeRelationSchema,
  RefreshIntentAnchorSchema,
  RemoveIntentAnchorSchema,
  ReviewIntentItemsSchema,
  UpdateIntentDimensionSchema,
  UpdateIntentDomainSchema,
  UpdateIntentFeatureSchema,
  UpdateIntentSourceSchema,
  intentContractViolation,
  parseContract,
  renderIntentPublicError,
  slugId,
  type IntentPublicError,
  DeleteIntentDomainSchema,
  DeleteIntentFeatureSchema,
  PreviewIntentAnchorQuerySchema,
} from '../../modules/intent/contract/index.js';
import { IntentAnchorService } from '../../modules/intent/intent-anchor.service.js';
import {
  INTENT_CONTEXT_READ_LIMITS,
  IntentContextMode,
  IntentContextFileSchema,
  IntentContextTaskSchema,
  normalizeIntentContextRequest,
  type IntentContextQuery,
} from '../../modules/intent/intent-context.operations.js';
import { IntentContextService } from '../../modules/intent/intent-context.service.js';
import { INTENT_PAGE_LIMITS } from '../../modules/intent/intent-cursor.js';
import { INTENT_READ_LIMITS, IntentReadService } from '../../modules/intent/intent-read.service.js';
import { IntentItemService } from '../../modules/intent/intent-item.service.js';
import type { IntentActor } from '../../modules/intent/intent-idempotency.js';
import { INTENT_ANCHOR_NODE_TYPES } from '../../modules/intent/intent-node-types.js';
import { IntentProposeService } from '../../modules/intent/intent-propose.service.js';
import { IntentReviewService } from '../../modules/intent/intent-review.service.js';
import { IntentTreeService } from '../../modules/intent/intent-tree.service.js';
import {
  INTENT_REVIEWER_ROLES,
  authorizeHumanReviewer,
  authorizeIntentPermission,
  intentActorRole,
} from '../intent-auth.js';
import type { IntentMcpAuth, IntentReviewerAuth } from '../intent-auth.js';

/* ------------------------------------------------------------- states --- */

/** The typed non-answer states. A successful call carries none of them. */
export enum IntentToolStatus {
  /** The workspace holds no intent content at all — see {@link NOT_CONFIGURED_MESSAGE}. */
  NotConfigured = 'not_configured',
  /** The caller's credential does not satisfy this tool's gate. */
  PermissionDenied = 'permission_denied',
  /** A §12 public refusal, passed through with its code and path. */
  Error = 'error',
}

/** What a refused call would have needed. Only the applicable half is present. */
export interface IntentPermissionRequirement {
  /** A service token must carry this permission. */
  permission?: TokenPermission;
  /** The call needs the acting human's own session; no token permission substitutes. */
  userSession?: true;
  /** Roles that may make this call, when a role is part of the gate. */
  roles?: WorkspaceMemberRole[];
}

export type IntentToolState =
  | { status: IntentToolStatus.NotConfigured; message: string }
  | { status: IntentToolStatus.PermissionDenied; requires: IntentPermissionRequirement; message: string }
  | { status: IntentToolStatus.Error; error: IntentPublicError };

/**
 * The one `not_configured` message, on every tool.
 *
 * It names the remedy because a state with no way forward is just an empty
 * answer with a label. `domain.create` is the bootstrap: with `dimension.create`
 * it is an action this state does NOT gate, or the workspace could never leave it.
 */
export const NOT_CONFIGURED_MESSAGE =
  'This workspace has no product intent yet: no domains, dimensions, or items. Start it with ' +
  "intent_tree action 'domain.create' from the acting user's own session (any workspace member).";

/* ---------------------------------------------------------- tree actions --- */

/** The tree operations `intent_tree` dispatches over. One tool, one action. */
export enum IntentTreeAction {
  DomainCreate = 'domain.create',
  DomainUpdate = 'domain.update',
  DomainArchive = 'domain.archive',
  DomainDelete = 'domain.delete',
  FeatureCreate = 'feature.create',
  FeatureUpdate = 'feature.update',
  FeatureArchive = 'feature.archive',
  FeatureDelete = 'feature.delete',
  SeedPut = 'seed.put',
  SeedDelete = 'seed.delete',
  DimensionCreate = 'dimension.create',
  DimensionUpdate = 'dimension.update',
  DimensionArchive = 'dimension.archive',
  DimensionDelete = 'dimension.delete',
  RelationPut = 'relation.put',
  RelationDelete = 'relation.delete',
}

/** Tree actions that do not require existing intent content. */
const BOOTSTRAP_TREE_ACTIONS: ReadonlySet<IntentTreeAction> = new Set([
  IntentTreeAction.DomainCreate,
  IntentTreeAction.DimensionCreate,
]);

/* -------------------------------------------------------- anchor actions --- */

/**
 * The anchor operations `intent_anchor` dispatches over.
 *
 * `Preview` is deliberately in the SAME enum as the three writes even though it
 * carries a different gate: an agent that has to discover a separate read tool
 * to satisfy "preview before you write" mostly does not, and the guardrail is
 * the reason this tool exists at all.
 */
export enum IntentAnchorAction {
  Preview = 'preview',
  Add = 'add',
  Refresh = 'refresh',
  Remove = 'remove',
}

/** The three actions that write. `Preview` is the only member that is not one. */
type IntentAnchorWriteAction = Exclude<IntentAnchorAction, IntentAnchorAction.Preview>;

/* --------------------------------------------------------------- schemas --- */

/**
 * The agent-facing shape of the context read.
 *
 * Native types where REST has query strings: arrays, a boolean, a number. The
 * BOUNDS are still the read's own (`INTENT_CONTEXT_READ_LIMITS`), stated here so
 * an agent sees them in the tool schema and again when it exceeds them.
 */
const GetIntentContextSchema = z
  .object({
    mode: z
      .enum(IntentContextMode)
      .optional()
      .describe(
        "'list' = payload-free index for orientation (a conditioned entry adds conditions {own?, inherited?, variants?}); " +
          "'context' (default) = payloads, anchors, provenance",
      ),
    intentIds: z
      .array(z.string())
      .max(INTENT_CONTEXT_READ_LIMITS.intentIds)
      .optional()
      .describe('Exact intent ids. The only selector that reaches a rejected or superseded item'),
    task: IntentContextTaskSchema.optional().describe(
      'Task text: fuses lexical relevance with files/nodeIds and exact intentIds in one bounded context read. Refresh before editing outside the requested scope.',
    ),
    files: z
      .array(IntentContextFileSchema)
      .max(INTENT_CONTEXT_READ_LIMITS.nodeIds)
      .optional()
      .describe(
        'Touched repository-relative paths with durable repoKey; used with task. No local parser or invented node ids required.',
      ),
    query: z
      .string()
      .max(INTENT_CONTEXT_READ_LIMITS.query)
      .optional()
      .describe(
        `Lexical search over title, statement, and rationale (at most ${INTENT_CONTEXT_READ_LIMITS.queryTokens} tokens)`,
      ),
    nodeIds: z
      .array(z.string())
      .max(INTENT_CONTEXT_READ_LIMITS.nodeIds)
      .optional()
      .describe(
        'Graph node ids — matches stored anchors, enclosing scopes (and, for a file id, anchors on its members), and graph-derived applicability',
      ),
    sourceRefs: z
      .array(z.string().min(1).max(INTENT_CONTRACT_LIMITS.ref))
      .max(INTENT_CONTEXT_READ_LIMITS.sourceRefs)
      .optional()
      .describe(
        'Source refs the intent was captured from, e.g. "jira:DAY-123" (Jira keys match case-insensitively) or a spec path',
      ),
    domain: slugId()
      .optional()
      .describe(
        'This domain and descendants. With task, narrows text discovery; code-linked constraints may cross domains',
      ),
    feature: slugId()
      .optional()
      .describe(
        'This feature and inherited rules. With task, narrows text discovery; code-linked constraints may cross features',
      ),
    kind: z
      .union([z.string(), z.array(z.string()).min(1).max(INTENT_CONTEXT_READ_LIMITS.kinds)])
      .optional()
      .describe(
        `A kind or a list of kinds, each one of: ${Object.values(IntentKind).join(', ')}. An unknown kind is refused, never treated as a miss`,
      ),
    effectivity: z
      .boolean()
      .optional()
      .describe(
        'Opt in to recorded production effectivity and active plans; includes superseded rules still effective in production',
      ),
    includeCandidates: z
      .boolean()
      .optional()
      .describe('Include proposed candidates alongside accepted intent. Default false: accepted intent only'),
    includeDiagnostics: z
      .boolean()
      .optional()
      .describe(
        'Include the review breakdown and the pending handoff operations with their ids. Default: compact counts',
      ),
    context: IntentContextSchema.optional().describe(
      'Reader context over declared dimensions, e.g. {"country": "de", "product": ["ta", "shifts"]} (a list only for a ' +
        'multi dimension). Drops items whose appliesWhen is false for it and adds contextMatch to each item. {} returns ' +
        'the declared dimensions without narrowing',
    ),
    limit: z
      .number()
      .int()
      .optional()
      .describe(
        `Items per answer: context mode 1-${INTENT_CONTEXT_LIMITS.max} (default ${INTENT_CONTEXT_LIMITS.default}), list mode ` +
          `1-${INTENT_PAGE_LIMITS.max} per page (default ${INTENT_PAGE_LIMITS.default}). Omitted alongside intentIds it covers every id you named`,
      ),
    cursor: z
      .string()
      .optional()
      .describe('List mode only: the nextCursor from the previous page. A non-null nextCursor means more pages exist'),
    observed: z
      .array(z.string())
      .max(INTENT_CONTEXT_READ_LIMITS.observed)
      .optional()
      .describe(
        'Your checkout per repo, as "<repoKey>@<commit>" or "<repoKey>@<commit>:dirty". Freshness is only claimed ' +
          'for repos you report; the rest stay unverified',
      ),
  })
  .strict();

type GetIntentContextInput = z.infer<typeof GetIntentContextSchema>;

const IntentTreeToolSchema = z
  .object({
    action: z.enum(IntentTreeAction).describe('Which tree operation this call performs'),
    request: z
      .record(z.string(), z.unknown())
      .describe("The body for `action` — see the tool description for each action's fields"),
  })
  .strict();

type IntentTreeToolInput = z.infer<typeof IntentTreeToolSchema>;

const IntentAnchorToolSchema = z
  .object({
    action: z.enum(IntentAnchorAction).describe('Which anchor operation this call performs'),
    request: z
      .record(z.string(), z.unknown())
      .describe("The body for `action` — see the tool description for each action's fields"),
  })
  .strict();

type IntentAnchorToolInput = z.infer<typeof IntentAnchorToolSchema>;

/** The three file-like reads: list the tree, open one node whole, search item text. */
export enum IntentReadAction {
  Tree = 'tree',
  Node = 'node',
  Search = 'search',
}

const IntentReadToolSchema = z
  .object({
    action: z.enum(IntentReadAction).describe("'tree' lists nodes, 'node' opens one whole, 'search' finds items"),
    domain: slugId().optional().describe('node: the domain to open. search: only items attached to this domain'),
    feature: slugId().optional().describe('node: the feature to open. search: only items attached to this feature'),
    kind: z
      .array(z.string())
      .min(1)
      .max(Object.values(IntentKind).length)
      .optional()
      .describe(`node/search: only these kinds (${Object.values(IntentKind).join(', ')})`),
    query: z
      .string()
      .max(INTENT_CONTEXT_READ_LIMITS.query)
      .optional()
      .describe(`search only: words that must ALL appear (at most ${INTENT_READ_LIMITS.searchTokens})`),
    includeCandidates: z.boolean().optional().describe('node/search: include unreviewed candidates. Default false'),
    refs: z
      .boolean()
      .optional()
      .describe('node/search: keep source references (Jira, Confluence, code) in the text. Default false: bare facts'),
    limit: z
      .number()
      .int()
      .optional()
      .describe(
        `search only: matches per answer, 1 to ${INTENT_READ_LIMITS.searchMax}, default ${INTENT_READ_LIMITS.searchDefault}`,
      ),
    after: slugId().optional().describe('node/search: the last item id of a TRUNCATED answer, to continue after it'),
  })
  .strict();

type IntentReadToolInput = z.infer<typeof IntentReadToolSchema>;

/** Fields each action accepts beyond `action`. Any other field is refused, never ignored. */
const INTENT_READ_FIELDS: Record<IntentReadAction, readonly (keyof IntentReadToolInput)[]> = {
  [IntentReadAction.Tree]: [],
  [IntentReadAction.Node]: ['domain', 'feature', 'kind', 'includeCandidates', 'refs', 'after'],
  [IntentReadAction.Search]: ['query', 'domain', 'feature', 'kind', 'includeCandidates', 'refs', 'limit', 'after'],
};

/* ---------------------------------------------------------- descriptions --- */

const GET_INTENT_CONTEXT_DESCRIPTION =
  'Read the rules that apply to code you are about to edit or review: by files/nodeIds (anchors and graph ' +
  'applicability), by the source a rule came from (sourceRefs), by exact intentIds (also rejected or superseded ones), ' +
  'or for a specific customer context. It is not the tool for product questions: to learn what a domain or feature ' +
  'does, what is open or what else it affects, use intent_read, which returns nodes whole. Prefer task (task text), files ({repoKey,path}) or known nodeIds, ' +
  'known intentIds and an optional domain/feature in ONE call. The server fuses text, stored anchors and graph ' +
  'applicability, deduplicates and ranks before bounding the answer. No index walk or local parser is required. ' +
  'Refresh when the task expands to new code. Exact-id reads fetch missing payloads; list mode is for browsing, ' +
  'not mandatory orientation. ' +
  'Only accepted items are discovered unless includeCandidates is true; only exact ids reach rejected/superseded ' +
  'items. sourceRefs selects items recorded from a source such as a Jira ticket ("jira:DAY-123"). Every item carries its version, match reason, sources and anchor evidence. An anchor is location, never ' +
  'runtime conformance. Check truncated, scanTruncated, unresolvedFiles/nodeIds and graph limits/freshness; empty ' +
  'or partial results do not establish that no rule applies. A missing graph degrades evidence, not lexical reads. ' +
  'An empty KB returns status not_configured with a remedy. pendingReview reports the outstanding decisions. ' +
  'With context, only items whose effective conditions (domain AND feature AND own appliesWhen) hold or stay open ' +
  'are returned; contextMatch gives state (match|open|unevaluated), the open dimension ids, openBy (the levels ' +
  'that left a dimension open) when a tree level takes part, and for a rule with variants the variant resolution ' +
  '(resolved|default|ambiguous|open, or base: no variant applies, requiredOutcome does). Items carry ' +
  'inheritedConditions {domain?, feature?} when their tree nodes are conditioned. Pass context when answering for a ' +
  'specific customer or user; contextExcluded counts scanned items its conditions dropped, and excludedIntentIds ' +
  'names the dropped items you asked for by intentIds or sourceRefs. contextNotSupplied ' +
  '{conditionedItems, dimensions} means conditioned rules were returned unfiltered, every variant included.';

const INTENT_READ_DESCRIPTION =
  'Read the product intent the way you read a folder of Markdown files. ' +
  'tree: the domains and their features, as ids and titles, nested; "(empty)" marks a node with no items. Call it ' +
  'first instead of guessing ids. node {domain | feature | neither for the product root, refs?, kind?, ' +
  'includeCandidates?}: one node as its document: prose, rules, use cases, flows, decisions, limitations and open ' +
  'questions, each item under its id. Below a --- line: the related nodes with the reason to read them, its features, ' +
  'what is in production or planned, and how many domain-level items also apply. Follow Related for impact questions. ' +
  'refs: false (default) gives the bare facts; refs: true keeps the Jira, Confluence and code references, for when ' +
  'you must cite or check a source. search {query, domain?, feature?, kind?, refs?, limit?, after?}: items whose ' +
  'text, body, payload or source refs contain every word, ordered by id, with the total, then the nodes whose prose (overview, How it works) contains them. An answer that stops short ' +
  'says TRUNCATED and how to get the rest. Requires the intent:read permission.';

const INTENT_PROPOSE_DESCRIPTION =
  'Propose intent CANDIDATES in this workspace: create new ones, or update a candidate by naming its id. `statement` is ' +
  'one sentence that stands alone (the rule, or who wants what); everything else the item says goes in `body` as ' +
  'Markdown lines (use-case bullets, numbered flow steps, a diagram). Proposing ' +
  'never accepts intent and never touches an accepted item. An explicit human approval of a specification section ' +
  'can authorize a separate intent_review for its unchanged verbatim items. Each item states its rule in `statement` so it stands without its payload, ' +
  'names at least one source (where the intent came from), attaches to the product root or to one domain or one ' +
  "feature (a domainId beside a featureId is a check and must be that feature's domain), and may carry anchor suggestions the server resolves against the workspace graph; an anchor is never " +
  'conformance proof. Omit `id` and the server derives one from the title; a title whose slug does not fit the id ' +
  'cap is REFUSED, because an id is immutable — pass a shorter title or an explicit id. ' +
  'To offer a replacement for an accepted item, name it in proposedSuccessorOfId — the swap ' +
  'itself is a reviewer decision. `appliesWhen` (AND-joined clauses {dimension, in|notIn}, {item}, {text}) says when ' +
  'an item applies, and a business_rule payload may carry `variants` [{when?, outcome, inputs?}]; dimensions and ' +
  'values must be declared with intent_tree, item clauses must name existing items or same-batch items proposed with an explicit id, ' +
  'without a cycle, and overlapping variants or a second default are refused; `appliesWhen: []` clears conditions. ' +
  'Items inherit their domain and feature conditions; set only conditions the approved text states. The response ' +
  'may carry non-blocking hints[] {proposalIndex, kind: missing-condition|ambiguous-variants|dead-variant|unaccepted-condition-item, …} for ' +
  'the reviewer; they never write a condition and are not a reason to ask the user. ' +
  'Every call carries an idempotencyKey; replaying one changes nothing. Requires ' +
  'the intent:propose permission.';

const INTENT_REVIEW_DESCRIPTION =
  "Record the acting human's decisions: accept, reject, supersede, defer or needs_edit. Authority changes require " +
  'either an explicit decision on the exact items or the human approval of an unchanged specification section ' +
  '(including an authorized resumption). Spec approval covers only items whose complete statement, condition, ' +
  'exceptions and scope are verbatim from that section. Read back the exact proposed ids and versions, verify ' +
  'their whole content and sources.revision, and use that spec section/revision as authorizingSource (revision is required for kind spec). Do not ask ' +
  'for a second approval of the same content. Supersede qualifies only when the approved section explicitly names ' +
  'the replaced id; inference, paraphrase or a changed source needs an explicit human decision. Each decision ' +
  'carries expectedVersion and a source-grounded reason; version conflicts write nothing. defer/needs_edit do not ' +
  'change authority. Requires a user session of any workspace member; service tokens cannot review regardless of permissions. ' +
  'The recorded actor is the authenticated user, never an identity supplied by the agent.';

const INTENT_TREE_DESCRIPTION =
  "Edit this workspace's product-intent tree: domains, features, feature seeds — the graph nodes that stake out " +
  "a feature's code area — and context dimensions (country, plan, role, …) that items condition on. Domains and features are created explicitly, never implicitly by a proposal; ids are " +
  'immutable; archiving is a visibility state, not a deletion; a delete is refused while children or attached items ' +
  'remain. A seed is identified by (featureId, repoKey, nodeId), so seed.put is both "declare" and "re-note". Every ' +
  "action takes an idempotencyKey. Requires the acting user's own session (any workspace member; no service " +
  'token): an agent acting in that session creates the domains, features and seeds its ' +
  'placement needs and reports what it created, while domain/feature archive and delete follow an explicit ' +
  'maintainer instruction naming the node. Bodies by action: ' +
  'domain.create {id, title, statement?, appliesWhen?, layout?}; domain.update {id, title?, statement?, appliesWhen?, layout?}; ' +
  'domain.archive {id, archived}; domain.delete {id}; ' +
  'feature.create {id, domainId, parentFeatureId?, title, statement?, appliesWhen?, layout?} (parentFeatureId nests it under ' +
  'another feature of the same domain); feature.update {id, title?, statement?, appliesWhen?, layout?, parentFeatureId?} ' +
  '(null moves it to the top level). layout is the node read as a document, in order: {heading, level: 2|3}, ' +
  '{lines: [Markdown]} and {item: id, style?: bullet|heading|prose} slots; an item with no slot is appended under ' +
  'its kind, and on update layout replaces the stored one ([] clears it); ' +
  'feature.archive {id, archived}; feature.delete {id}; seed.put {featureId, repoKey, nodeId, note?}; ' +
  'seed.delete {featureId, repoKey, nodeId}; dimension.create {id, title, values: [{id, title, aliases?}], multi?}; ' +
  'dimension.update {id, title?, values?, multi?} (values replaces the list); dimension.archive {id, archived}; ' +
  'dimension.delete {id}; relation.put {from: {kind: domain|feature, id}, to: {kind, id}, why} links two nodes a ' +
  'reader of one should also read, with the reason in one sentence (unordered; a put on an existing pair re-words ' +
  'why); relation.delete {from, to}. Deleting a node removes its relations. Dimension archive and delete follow an explicit maintainer instruction too; archive, ' +
  'delete, or dropping a value is refused with dimension_in_use, naming the blockers, while a domain, a feature, ' +
  'or a candidate or accepted item still references it. A domain or feature appliesWhen holds dimension clauses ' +
  'only ({dimension, in} | {dimension, notIn}); every item under the node inherits it (AND), [] clears it. Set ' +
  'structural conditions (which product a domain exists for) on the tree once, not on each item, and set or clear ' +
  'a domain/feature appliesWhen only on an explicit maintainer instruction naming the node, like archive and ' +
  'delete; a response that changed it reports affectedAcceptedItems (for a domain, including its features). Aliases are ' +
  'the words that name a value in prose; propose hints match aliases only, never a value title.';

const INTENT_ANCHOR_DESCRIPTION =
  'Attach, re-observe, or remove a code anchor on an intent item — the touchpoint that records "this reviewed ' +
  'rule was said to live here" — and preview any of it first. AN ANCHOR IS NEVER CONFORMANCE PROOF: it says a ' +
  'node was named and what its version looked like when captured, never that the code obeys the rule, and a ' +
  'matched anchor read off a stale snapshot proves nothing either. ONLY ACCEPTED items are anchorable — a ' +
  'candidate is refused, because anchoring unreviewed content would dress a proposal up as settled truth. ' +
  'PREVIEW BEFORE EVERY WRITE: preview {itemId, repoKey, nodeId} resolves exactly what a write would resolve, ' +
  'writes nothing and spends no idempotency key, and reports the resolved node type, the baseline, whether the ' +
  'write would create or refresh, and whether the stored baseline has drifted — show a human that before ' +
  'writing. Then: add {idempotencyKey, itemId, repoKey, nodeId, rationale?} stores the anchor with the baseline ' +
  'the server observes; refresh {idempotencyKey, itemId, repoKey, nodeId} re-observes that baseline against the ' +
  'current snapshot; remove {idempotencyKey, itemId, repoKey, nodeId} deletes the row and never touches the ' +
  'graph, so an anchor whose node is gone is still removable. Anchor identity is (itemId, repoKey, nodeId); node ' +
  'type and the drift baseline are resolved server-side from the workspace graph — never send them, and never ' +
  'reconstruct a nodeId from a file path, only pass ids you read out of tool output. Anchorable node kinds: ' +
  `${INTENT_ANCHOR_NODE_TYPES.join(', ')}. preview needs the intent:read permission; add, refresh, and remove ` +
  "need the acting user's own session (any workspace member; no service token, whatever its permissions or " +
  "its creator's role), and are never implied by conversational assent.";

const INTENT_SOURCE_UPDATE_DESCRIPTION =
  'Set the human title and/or the link (url) of a source document on EVERY item that cites its ref — accepted ' +
  'items included. Use it when a source shows as a bare ref like "confluence:1234567890" or cannot be opened: ' +
  'pass the page title as the reader sees it and its http(s) url. Title and url are descriptive only: this never ' +
  'changes a rule, its version or its authority, and a proposal is not needed. Body {idempotencyKey, ref, title?, ' +
  'url?}; at least one of title/url. Refused with source_not_found when no item cites ref. Requires the acting ' +
  "user's own session (any workspace member; no service token).";

/* ------------------------------------------------------------- helpers --- */

/** A tool body's answer: the payload plus what the metric should record about it. */
interface IntentToolAnswer {
  data: unknown;
  /** False for a refusal — a permission state is not a served query. */
  success: boolean;
  resultCount?: number | null;
}

function notConfigured(): IntentToolAnswer {
  return {
    data: { status: IntentToolStatus.NotConfigured, message: NOT_CONFIGURED_MESSAGE } satisfies IntentToolState,
    success: true,
    resultCount: 0,
  };
}

/**
 * Render a gate refusal as a state.
 *
 * Only `ForbiddenException` — the single failure the two authorizers raise — is
 * converted; anything else is a bug and must keep travelling as an error rather
 * than being relabelled "permission denied".
 */
function permissionDenied(error: unknown, requires: IntentPermissionRequirement): IntentToolAnswer {
  if (!(error instanceof ForbiddenException)) throw error;
  return {
    data: {
      status: IntentToolStatus.PermissionDenied,
      requires,
      message: error.message,
    } satisfies IntentToolState,
    success: false,
  };
}

function errorState(error: IntentPublicError): IntentToolAnswer {
  return { data: { status: IntentToolStatus.Error, error } satisfies IntentToolState, success: false };
}

/**
 * An action envelope: which action, and the untouched body for it. Shared by
 * `intent_tree` and `intent_anchor`, which are the two dispatching tools.
 *
 * Deliberately NOT `parseContract`: that would run the bounded-content walk
 * over the body from OUT here, so a secret-shaped string in a domain title
 * would be reported at `request.title` and, one action later, the same field's
 * shape error at `title`. The body is walked exactly once, by the per-action
 * `parseContract` at dispatch, so every path this tool reports is the one the
 * REST route reports for the same body. An unknown action is refused by the
 * enum itself, whose message names every valid action.
 */
function parseEnvelope<TSchema extends z.ZodType>(schema: TSchema, toolName: string, args: unknown): z.infer<TSchema> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data as z.infer<TSchema>;
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String) ?? [];
  // An unknown action also names each valid one as its own detail: the
  // intent_tree list outgrew the public message bound, which would truncate it.
  if (issue?.code === 'invalid_value') {
    throw intentContractViolation(
      IntentErrorCode.SchemaViolation,
      issue.message.length <= INTENT_PUBLIC_ERROR_LIMITS.messageChars
        ? issue.message
        : `Unknown ${path.join('.') || 'value'}; the valid ones are listed in details`,
      path,
      issue.values.map((value) => ({ code: IntentErrorCode.SchemaViolation, message: String(value), path })),
    );
  }
  throw intentContractViolation(
    IntentErrorCode.SchemaViolation,
    issue?.message ?? `The request does not match the ${toolName} schema`,
    path,
  );
}

/**
 * The actor recorded on every audit row: identity from the token, never from
 * the payload (§4.7).
 *
 * The ROLE comes from `intentActorRole`, which reads the auth KIND. The previous
 * `auth.role ?? 'service_token'` never reached its fallback: a service token
 * authenticates as the user who created it, so `role` was that creator's
 * membership and every machine write was audited as `owner` or `admin` — a
 * human role attached to an action no human took.
 */
function actorOf(auth: IntentMcpAuth): IntentActor {
  return { id: auth.actorId, role: intentActorRole(auth) };
}

/**
 * The native tool arguments as the context read's wire shape.
 *
 * A PRESENT-BUT-EMPTY array stays present: `intentIds: []` is a caller that
 * computed a selector and came up with nothing, and answering it with the
 * default accepted set is the widest possible answer to the narrowest possible
 * question. (`[]` is truthy in JS, so the spread below preserves it — that is
 * load-bearing, not incidental.)
 */
function toContextQuery(input: GetIntentContextInput): IntentContextQuery {
  return {
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.intentIds ? { intentIds: input.intentIds } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.files === undefined ? {} : { files: input.files.map((file) => JSON.stringify(file)) }),
    ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
    ...(input.sourceRefs ? { sourceRefs: input.sourceRefs } : {}),
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.feature ? { feature: input.feature } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.includeCandidates === undefined
      ? {}
      : { includeCandidates: input.includeCandidates ? ('true' as const) : ('false' as const) }),
    ...(input.effectivity === undefined
      ? {}
      : { effectivity: input.effectivity ? ('true' as const) : ('false' as const) }),
    ...(input.includeDiagnostics === undefined
      ? {}
      : { includeDiagnostics: input.includeDiagnostics ? ('true' as const) : ('false' as const) }),
    ...(input.context === undefined ? {} : { context: JSON.stringify(input.context) }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.observed ? { observed: input.observed } : {}),
  };
}

/** Items the context read actually returned, for the retrieval-quality metric. */
function contextResultCount(data: unknown): number | null {
  const answer = data as { matches?: unknown[]; entries?: unknown[] } | null;
  if (Array.isArray(answer?.matches)) return answer.matches.length;
  if (Array.isArray(answer?.entries)) return answer.entries.length;
  return null;
}

/* --------------------------------------------------------------- tools --- */

@Injectable()
export class IntentTools {
  private readonly logger = new Logger(IntentTools.name);

  /**
   * Every action, with the schema its body is validated against and the service
   * call it makes. A total `Record` over the enum: a new action fails the build
   * here rather than falling through to "unknown action" at runtime.
   */
  private readonly treeDispatch: Record<
    IntentTreeAction,
    (workspaceId: string, actor: IntentActor, body: unknown) => Promise<unknown>
  >;

  /**
   * The three anchor WRITES, with the schema each body is validated against.
   * `preview` is absent by construction: it is a read, it takes no actor, and
   * it passes a different gate, so it is dispatched explicitly rather than
   * hidden behind an ignored `actor` parameter.
   */
  private readonly anchorDispatch: Record<
    IntentAnchorWriteAction,
    (workspaceId: string, actor: IntentActor, body: unknown) => Promise<unknown>
  >;

  /**
   * The same per-action schemas `anchorDispatch` validates against, looked up
   * on their own so `intentAnchor` can run the schema check BEFORE the
   * not_configured probe (issue 08): a malformed body must fail with its own
   * schema error even against an empty workspace.
   */
  private readonly anchorWriteSchema: Record<IntentAnchorWriteAction, z.ZodType> = {
    [IntentAnchorAction.Add]: AddIntentAnchorSchema,
    [IntentAnchorAction.Refresh]: RefreshIntentAnchorSchema,
    [IntentAnchorAction.Remove]: RemoveIntentAnchorSchema,
  };

  constructor(
    private readonly context: IntentContextService,
    private readonly propose: IntentProposeService,
    private readonly review: IntentReviewService,
    private readonly tree: IntentTreeService,
    private readonly anchors: IntentAnchorService,
    private readonly metricsService: MetricsService,
    private readonly releases: IntentReleaseService,
    private readonly handoffs: IntentHandoffService,
    private readonly items: IntentItemService,
    private readonly reads: IntentReadService,
  ) {
    this.treeDispatch = {
      [IntentTreeAction.DomainCreate]: (ws, actor, body) =>
        this.tree.createDomain(ws, actor, parseContract(CreateIntentDomainSchema, body)),
      [IntentTreeAction.DomainUpdate]: (ws, actor, body) =>
        this.tree.updateDomain(ws, actor, parseContract(UpdateIntentDomainSchema, body)),
      [IntentTreeAction.DomainArchive]: (ws, actor, body) =>
        this.tree.archiveDomain(ws, actor, parseContract(ArchiveIntentDomainSchema, body)),
      [IntentTreeAction.DomainDelete]: (ws, actor, body) =>
        this.tree.deleteDomain(ws, actor, parseContract(DeleteIntentDomainSchema, body)),
      [IntentTreeAction.FeatureCreate]: (ws, actor, body) =>
        this.tree.createFeature(ws, actor, parseContract(CreateIntentFeatureSchema, body)),
      [IntentTreeAction.FeatureUpdate]: (ws, actor, body) =>
        this.tree.updateFeature(ws, actor, parseContract(UpdateIntentFeatureSchema, body)),
      [IntentTreeAction.FeatureArchive]: (ws, actor, body) =>
        this.tree.archiveFeature(ws, actor, parseContract(ArchiveIntentFeatureSchema, body)),
      [IntentTreeAction.FeatureDelete]: (ws, actor, body) =>
        this.tree.deleteFeature(ws, actor, parseContract(DeleteIntentFeatureSchema, body)),
      [IntentTreeAction.SeedPut]: (ws, actor, body) =>
        this.tree.putSeed(ws, actor, parseContract(PutIntentFeatureSeedSchema, body)),
      [IntentTreeAction.SeedDelete]: (ws, actor, body) =>
        this.tree.deleteSeed(ws, actor, parseContract(DeleteIntentFeatureSeedSchema, body)),
      [IntentTreeAction.DimensionCreate]: (ws, actor, body) =>
        this.tree.createDimension(ws, actor, parseContract(CreateIntentDimensionSchema, body)),
      [IntentTreeAction.DimensionUpdate]: (ws, actor, body) =>
        this.tree.updateDimension(ws, actor, parseContract(UpdateIntentDimensionSchema, body)),
      [IntentTreeAction.DimensionArchive]: (ws, actor, body) =>
        this.tree.archiveDimension(ws, actor, parseContract(ArchiveIntentDimensionSchema, body)),
      [IntentTreeAction.DimensionDelete]: (ws, actor, body) =>
        this.tree.deleteDimension(ws, actor, parseContract(DeleteIntentDimensionSchema, body)),
      [IntentTreeAction.RelationPut]: (ws, actor, body) =>
        this.tree.putRelation(ws, actor, parseContract(PutIntentNodeRelationSchema, body)),
      [IntentTreeAction.RelationDelete]: (ws, actor, body) =>
        this.tree.deleteRelation(ws, actor, parseContract(DeleteIntentNodeRelationSchema, body)),
    };

    this.anchorDispatch = {
      [IntentAnchorAction.Add]: (ws, actor, body) =>
        this.anchors.add(ws, actor, parseContract(AddIntentAnchorSchema, body)),
      [IntentAnchorAction.Refresh]: (ws, actor, body) =>
        this.anchors.refresh(ws, actor, parseContract(RefreshIntentAnchorSchema, body)),
      [IntentAnchorAction.Remove]: (ws, actor, body) =>
        this.anchors.remove(ws, actor, parseContract(RemoveIntentAnchorSchema, body)),
    };
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'get_intent_context',
    annotations: toolAnnotations('get_intent_context'),
    description:
      GET_INTENT_CONTEXT_DESCRIPTION +
      ' Every read returns compact pendingReview and handoffFreshness {pending, needsAttention} counts; when needsAttention > 0, re-read with includeDiagnostics:true to get the operation ids, then use intent_handoff get to inspect and repair them. Default reads carry authority only, with no production or withdrawal information. With effectivity:true, effective means current according to recorded delivery evidence (currentRelease), not live monitoring. With effectivity:true each item may carry deliveries[] {repoKey, pr, seq, deliveredRef, orderingToken}, one per recorded delivery across repositories. Implement planned only when the task explicitly includes that approved change via its sources or a maintainer instruction; otherwise follow effective and report the plan. Never implement withdrawn; not_effective is a retired/replaced rule, not a plan to implement; unknown is not proof of production availability.',
    parameters: GetIntentContextSchema,
  })
  async getIntentContext(args: unknown, _context: Context, request: Request) {
    return this.respond('get_intent_context', request, async () => {
      const auth = this.permissionGate(request, TokenPermission.IntentRead);
      if ('status' in auth) return auth.answer;

      const input = parseContract(GetIntentContextSchema, args);
      const data = await this.context.read(auth.workspaceId, normalizeIntentContextRequest(toContextQuery(input)));

      // An empty answer and an unconfigured workspace must never look alike.
      // The check runs only when the answer IS empty, so a workspace with
      // intent pays nothing for it.
      const resultCount = contextResultCount(data);
      if (resultCount === 0 && !(await this.hasIntentContent(auth.workspaceId))) return notConfigured();
      return { data, success: true, resultCount };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_read',
    annotations: toolAnnotations('intent_read'),
    description: INTENT_READ_DESCRIPTION,
    parameters: IntentReadToolSchema,
  })
  async intentRead(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_read', request, async () => {
      const auth = this.permissionGate(request, TokenPermission.IntentRead);
      if ('status' in auth) return auth.answer;

      const input = parseContract(IntentReadToolSchema, args);
      const allowed = new Set<string>(['action', ...INTENT_READ_FIELDS[input.action]]);
      const extra = Object.keys(input).filter((key) => !allowed.has(key));
      if (extra.length > 0) {
        throw intentContractViolation(
          IntentErrorCode.SchemaViolation,
          `action '${input.action}' does not take ${extra.join(', ')}`,
          [extra[0] as string],
        );
      }
      if (input.action === IntentReadAction.Search && input.query === undefined) {
        throw intentContractViolation(IntentErrorCode.SchemaViolation, "action 'search' needs query", ['query']);
      }
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();

      const ws = auth.workspaceId;
      const data =
        input.action === IntentReadAction.Tree
          ? await this.reads.tree(ws)
          : input.action === IntentReadAction.Node
            ? await this.reads.node(ws, input)
            : await this.reads.search(ws, { ...input, query: input.query as string });
      return { data, success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_release',
    annotations: toolAnnotations('intent_release'),
    description:
      "Record production availability separately from approval. preview {itemId} returns contentHash, sources and headSeq; list {limit?, beforeSeq?} returns evidence history, each entry carrying actorKind, pr and orderingToken when the delivery was automatic. Writes need the acting person's own session, any workspace member, never a service token: record {idempotencyKey, expectedHeadSeq, kind: release|baseline, deliveredRef, included: [{itemId, contentHash}], retired?: [itemId], reason?}; rollback {idempotencyKey, expectedHeadSeq, releaseSeq, reason}; plan {idempotencyKey, expectedHeadSeq, itemId, expectedVersion, reason}; withdraw/reinstate {idempotencyKey, expectedHeadSeq, itemId, reason?}. reason is required on plan and rollback only; elsewhere the server fills a system default. expectedHeadSeq is 0 for the first event. Only record verified availability, never infer it from merge or graph publication. Plan/withdraw do not change authority or production. Retry an uncertain write with the identical key and request; a stale head requires human reconciliation, not an automatic head update.",
    parameters: IntentReleaseToolSchema,
  })
  async intentRelease(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_release', request, async () => {
      const input = parseEnvelope(IntentReleaseToolSchema, 'intent_release', args);
      const auth =
        input.action === 'preview' || input.action === 'list'
          ? this.permissionGate(request, TokenPermission.IntentRead)
          : this.reviewerGate(request);
      if ('status' in auth) return auth.answer;
      const ws = auth.workspaceId;

      // Validated before not_configured — see intent_propose: every action's
      // body schema runs first, so a malformed body fails with its own error
      // even against an empty workspace.
      const previewItemId =
        input.action === 'preview' ? parseContract(PreviewIntentReleaseSchema, input.request).itemId : null;
      const listQuery = input.action === 'list' ? parseContract(ListIntentReleasesSchema, input.request) : null;
      const command =
        input.action === 'record'
          ? parseContract(HumanRecordIntentReleaseSchema, input.request)
          : input.action === 'rollback'
            ? { ...parseContract(RollbackIntentReleaseSchema, input.request), kind: 'rollback' as const }
            : input.action === 'plan'
              ? { ...parseContract(PlanIntentReleaseSchema, input.request), kind: 'plan' as const }
              : input.action === 'preview' || input.action === 'list'
                ? null
                : { ...parseContract(ChangeIntentPlanSchema, input.request), kind: input.action };

      if (!(await this.hasIntentContent(ws))) return notConfigured();
      if (input.action === 'preview')
        return { data: await this.releases.preview(ws, previewItemId as string), success: true };
      if (input.action === 'list') return { data: await this.releases.list(ws, listQuery!), success: true };
      return { data: await this.releases.record(ws, actorOf(auth), command!), success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_handoff',
    annotations: toolAnnotations('intent_handoff'),
    parameters: IntentHandoffToolSchema,
    description:
      'Save/get/list a reviewed implementation handoff. Save requires a human workspace member session: id (UUID), expectedVersion (0 creates), idempotencyKey, repoKey, reviewed headSha (40 lowercase hex characters), optional prNumber, bindings [{itemId, files: [path], symbols: [path#Name], replaceNodeIds: []}], delivers/retires [{itemId,version}], optional supersedesMappingIds. Limits: 50 bindings, 200 mapping targets, 32 KiB mapping; at most 200 delivers and 200 retires, with unique item IDs across both lists. Save before PR creation, attach its number after opening, refresh after code changes. Does not accept intent authority or create active links before merge. Read back version/status; needs_attention requires a corrected handoff. PR prose is display only. get needs id; list accepts repoKey, limit (max50), before (UUID from nextBefore of the previous page).',
  })
  async intentHandoff(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_handoff', request, async () => {
      const input = parseEnvelope(IntentHandoffToolSchema, 'intent_handoff', args);
      const auth = this.permissionGate(
        request,
        input.action === 'save' ? TokenPermission.IntentPropose : TokenPermission.IntentRead,
      );
      if ('status' in auth) return auth.answer;
      if (input.action === 'save' && auth.authKind !== McpAuthKind.Jwt)
        return permissionDenied(new ForbiddenException('A human workspace session is required to author a handoff'), {
          userSession: true,
        });

      // Validated before not_configured — see intent_propose.
      const save = input.action === 'save' ? parseContract(SaveIntentHandoffSchema, input.request) : null;
      const get = input.action === 'get' ? parseContract(GetIntentHandoffSchema, input.request) : null;
      const list = input.action === 'list' ? parseContract(ListIntentHandoffsSchema, input.request) : null;

      // Consistent with propose/review/anchor/release: a handoff is authority-
      // adjacent (it carries delivers/retires against real items), so it gets
      // the same not_configured gate on an empty workspace.
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();

      const data =
        input.action === 'save'
          ? await this.handoffs.save(auth.workspaceId, actorOf(auth), save!)
          : input.action === 'get'
            ? await this.handoffs.get(auth.workspaceId, get!.id)
            : await this.handoffs.list(auth.workspaceId, list!);
      return { data, success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_propose',
    annotations: toolAnnotations('intent_propose'),
    description: INTENT_PROPOSE_DESCRIPTION,
    parameters: ProposeIntentItemsSchema,
  })
  async intentPropose(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_propose', request, async () => {
      const auth = this.permissionGate(request, TokenPermission.IntentPropose);
      if ('status' in auth) return auth.answer;

      // Validated BEFORE the not_configured probe: a malformed body must fail
      // with its own schema error even against an empty workspace, not be
      // masked by a state check that never looked at the body.
      const input = parseContract(ProposeIntentItemsSchema, args);
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();
      return { data: await this.propose.propose(auth.workspaceId, actorOf(auth), input), success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_review',
    annotations: toolAnnotations('intent_review'),
    description: INTENT_REVIEW_DESCRIPTION,
    parameters: ReviewIntentItemsSchema,
  })
  async intentReview(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_review', request, async () => {
      const auth = this.reviewerGate(request);
      if ('status' in auth) return auth.answer;

      // Same ordering as intent_propose: schema errors surface even against an
      // empty workspace, rather than being masked by not_configured.
      const input = parseContract(ReviewIntentItemsSchema, args);
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();
      return { data: await this.review.review(auth.workspaceId, actorOf(auth), input), success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_tree',
    annotations: toolAnnotations('intent_tree'),
    description: INTENT_TREE_DESCRIPTION,
    parameters: IntentTreeToolSchema,
  })
  async intentTree(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_tree', request, async () => {
      const auth = this.reviewerGate(request);
      if ('status' in auth) return auth.answer;

      const input: IntentTreeToolInput = parseEnvelope(IntentTreeToolSchema, 'intent_tree', args);
      // `domain.create` and `dimension.create` are the actions an unconfigured
      // workspace must still accept: they are how a workspace stops being
      // unconfigured. Gating them would make the state permanent, which is the
      // failure static registration exists to avoid (§11).
      if (!BOOTSTRAP_TREE_ACTIONS.has(input.action) && !(await this.hasIntentContent(auth.workspaceId))) {
        return notConfigured();
      }

      const apply = this.treeDispatch[input.action];
      return { data: await apply(auth.workspaceId, actorOf(auth), input.request), success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_anchor',
    annotations: toolAnnotations('intent_anchor'),
    description: INTENT_ANCHOR_DESCRIPTION,
    parameters: IntentAnchorToolSchema,
  })
  async intentAnchor(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_anchor', request, async () => {
      // The envelope is read BEFORE the gate here, unlike `intent_tree`,
      // because the action IS the gate: preview is a member read of graph facts
      // gated at `intent:read`, the three writes are authority-adjacent and
      // take the reviewer gate. The envelope carries no content of
      // its own, so nothing is disclosed by shape-checking it first.
      const input: IntentAnchorToolInput = parseEnvelope(IntentAnchorToolSchema, 'intent_anchor', args);

      if (input.action === IntentAnchorAction.Preview) {
        const auth = this.permissionGate(request, TokenPermission.IntentRead);
        if ('status' in auth) return auth.answer;

        // Validated before not_configured — see intent_propose.
        const query = parseContract(PreviewIntentAnchorQuerySchema, input.request);
        if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();
        return { data: await this.anchors.preview(auth.workspaceId, query), success: true };
      }

      const auth = this.reviewerGate(request);
      if ('status' in auth) return auth.answer;

      // Validated before not_configured — see intent_propose. `anchorDispatch`
      // re-validates the same body against the same schema when it runs; that
      // second parse is a cheap no-op on input already known good, not a
      // second source of truth.
      parseContract(this.anchorWriteSchema[input.action], input.request);
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();

      const apply = this.anchorDispatch[input.action];
      return { data: await apply(auth.workspaceId, actorOf(auth), input.request), success: true };
    });
  }

  @ToolGuards([IntentEnabledToolGuard])
  @Tool({
    name: 'intent_source_update',
    annotations: toolAnnotations('intent_source_update'),
    description: INTENT_SOURCE_UPDATE_DESCRIPTION,
    parameters: UpdateIntentSourceSchema,
  })
  async intentSourceUpdate(args: unknown, _context: Context, request: Request) {
    return this.respond('intent_source_update', request, async () => {
      // Human session: the url is where every reader of an accepted rule is sent.
      const auth = this.reviewerGate(request);
      if ('status' in auth) return auth.answer;

      const input = parseContract(UpdateIntentSourceSchema, args);
      if (!(await this.hasIntentContent(auth.workspaceId))) return notConfigured();
      return { data: await this.items.updateSource(auth.workspaceId, actorOf(auth), input), success: true };
    });
  }

  /* ------------------------------------------------------------ gates --- */

  private permissionGate(
    request: Request,
    permission: TokenPermission,
  ): IntentMcpAuth | { status: IntentToolStatus.PermissionDenied; answer: IntentToolAnswer } {
    try {
      return authorizeIntentPermission(request, permission);
    } catch (error) {
      return {
        status: IntentToolStatus.PermissionDenied,
        answer: permissionDenied(error, { permission }),
      };
    }
  }

  private reviewerGate(
    request: Request,
  ): IntentReviewerAuth | { status: IntentToolStatus.PermissionDenied; answer: IntentToolAnswer } {
    try {
      return authorizeHumanReviewer(request);
    } catch (error) {
      return {
        status: IntentToolStatus.PermissionDenied,
        answer: permissionDenied(error, { userSession: true, roles: INTENT_REVIEWER_ROLES }),
      };
    }
  }

  /* ------------------------------------------------------------ state --- */

  /**
   * Does this workspace hold ANY intent content?
   *
   * One `EXISTS` query (`IntentTreeService.hasIntentContent`). It used to be a
   * tree page plus an item page — `getTree` materialised a domain row WITH its
   * features, and this predicate runs before EVERY mutation on this surface, so
   * the cheapest question asked was answered by the most expensive read.
   */
  private async hasIntentContent(workspaceId: string): Promise<boolean> {
    return this.tree.hasIntentContent(workspaceId);
  }

  /* ---------------------------------------------------------- plumbing --- */

  /**
   * Run one tool body, render whatever it produces, and record the metric.
   *
   * The metrics half of `BaseCoredocTool.executeWithMetrics` without the graph
   * lease (see the file header). Nothing escapes as a thrown MCP error: a
   * public refusal keeps its `{code, message, path}`, and anything else becomes
   * the fixed internal shape — logged here, because the log is the only place
   * an unexpected failure stays visible once the caller sees a bounded triple.
   */
  private async respond(
    toolName: string,
    request: Request,
    body: () => Promise<IntentToolAnswer>,
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const startedAt = Date.now();
    let answer: IntentToolAnswer;
    try {
      answer = await body();
    } catch (error) {
      const rendered = renderIntentPublicError(error);
      if (rendered.error.code === IntentErrorCode.InternalError) {
        this.logger.error(`${toolName} failed: ${(error as Error)?.message ?? error}`, (error as Error)?.stack);
      }
      answer = errorState(rendered.error);
    }

    const trusted = request as Request & { workspaceId?: string; user?: { id?: string } };
    if (trusted.workspaceId) {
      this.metricsService
        .recordMcpQuery({
          workspaceId: trusted.workspaceId,
          toolName,
          userId: trusted.user?.id ?? null,
          durationMs: Date.now() - startedAt,
          success: answer.success,
          resultCount: answer.resultCount ?? null,
          scope: null,
        })
        .catch((err) => {
          // Best-effort write; a swallowed outage must still be visible.
          this.logger.warn(`Failed to record MCP query metric for ${toolName}: ${(err as Error)?.message ?? err}`);
        });
    }

    // A text answer (the file-like reads) is already the document the reader sees.
    const text = typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data, null, 2);
    return { content: [{ type: 'text', text }] };
  }
}
