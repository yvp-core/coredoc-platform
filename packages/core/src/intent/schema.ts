/**
 * Strict schema + semantic validation for `IntentFileV2`.
 *
 * Two layers, both fail-closed:
 *  1. Zod strict object parsing — shape, enums, bounded text. Unknown keys are
 *     REJECTED: that is what keeps source bodies, prompts, transcripts, and
 *     arbitrary payloads out of the file (BR-14 / AC-11).
 *  2. Cross-item semantics zod cannot express — duplicate identities, relation
 *     endpoint kinds, flow branch targets, project scope (AC-2).
 *
 * Every error carries a JSON path so a CLI or agent can point at the offending
 * position instead of restating the whole file.
 */
import { z } from 'zod';
import {
  DecisionStatus,
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  INTENT_LEGACY_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION,
  INTENT_SLUG_PATTERN,
  type FlowPayload,
  IntentAuthority,
  type IntentFileV2,
  IntentKind,
  IntentRelationType,
  IntentSourceKind,
  VERSIONED_ANCHOR_NODE_TYPES,
} from './types.js';

/**
 * Content bounds. The pilot holds a small reviewed set (~20-30 items, ~100
 * anchors); these caps are the structural half of BR-14 — a transcript, a spec
 * body, or a dumped file cannot fit through a bounded text field.
 */
export const INTENT_LIMITS = {
  items: 500,
  relations: 2000,
  title: 200,
  statement: 2000,
  /** Any single payload text field (outcome, condition, rationale, step action...). */
  text: 2000,
  /** Any payload string list (preconditions, alternatives, consequences...). */
  listEntries: 50,
  steps: 50,
  branchesPerStep: 10,
  sourcesPerItem: 10,
  anchorsPerItem: 20,
  id: 200,
  /**
   * Item and domain ids are slugs, not free identifiers: they are quoted in
   * hand-offs and error messages, so they are capped far below the generic
   * `id` bound that still covers foreign identities (`localId`, `revision`).
   */
  itemId: INTENT_ID_MAX_LENGTH,
  /** A registry that no longer fits on one review screen is a modelling problem, not a bound to raise. */
  domains: 50,
  ref: 500,
  /** Workspace context-dimension registry, bounded like the domain registry. */
  dimensions: 50,
  valuesPerDimension: 100,
  aliasesPerValue: 10,
  alias: 100,
  /** `appliesWhen` clauses on one item. */
  conditionsPerItem: 20,
  /** Value ids in one `in`/`notIn` clause or one variant `when` entry. */
  valuesPerCondition: 50,
  variantsPerRule: 50,
  inputsPerVariant: 20,
} as const;

/**
 * Reporting bounds. A validation error is rendered into a terminal, an agent
 * context, or a log line, and its message quotes UNTRUSTED content (zod echoes
 * the offending key, we echo ids and refs). Without a bound, a single crafted
 * key or a file full of broken items turns an error report into an unbounded
 * dump of attacker-authored text.
 */
export const INTENT_ERROR_REPORT_LIMITS = {
  /** Max characters of any single error message (longer messages are elided). */
  messageChars: 200,
  /** Max errors returned; the rest are summarised by one synthetic error. */
  errors: 20,
} as const;

const ELLIPSIS = '…';

export enum IntentValidationCode {
  /** Shape/enum/bounds failure reported by the strict schema. */
  Schema = 'schema',
  /** File exists but is not parseable JSON. */
  Malformed = 'malformed',
  NewerSchemaVersion = 'newer_schema_version',
  /** The pre-slug, pre-domain v1 overlay; refused with migration remediation (BR-22). */
  LegacySchemaVersion = 'legacy_schema_version',
  DuplicateItemId = 'duplicate_item_id',
  /** An id that is not `<kind prefix>-<slug>` for its own kind (BR-16). */
  InvalidItemId = 'invalid_item_id',
  InvalidDomainId = 'invalid_domain_id',
  DuplicateDomainId = 'duplicate_domain_id',
  /** An item referencing a domain the registry does not declare (BR-18). */
  UndeclaredDomain = 'undeclared_domain',
  DuplicateSourceIdentity = 'duplicate_source_identity',
  DanglingRelationEndpoint = 'dangling_relation_endpoint',
  InvalidRelationKindPair = 'invalid_relation_kind_pair',
  /** A relation whose two endpoints are the same item (X supersedes X). */
  SelfReferentialRelation = 'self_referential_relation',
  /** Synthetic: further errors existed but were not reported (see {@link INTENT_ERROR_REPORT_LIMITS}). */
  ErrorsOmitted = 'errors_omitted',
  InvalidFlowBranchTarget = 'invalid_flow_branch_target',
  DuplicateFlowStepId = 'duplicate_flow_step_id',
  ProjectMismatch = 'project_mismatch',
}

export interface IntentValidationError {
  code: IntentValidationCode;
  path: (string | number)[];
  message: string;
}

export type IntentValidationResult = { ok: true; file: IntentFileV2 } | { ok: false; errors: IntentValidationError[] };

export interface IntentValidationOptions {
  /** When set, the file's `projectId` must equal it (project isolation, BR-12). */
  expectedProjectId?: string;
}

/** `items[2].payload.steps[1].id: message` — the shape a CLI or agent can act on. */
export function formatIntentValidationErrors(errors: IntentValidationError[]): string {
  return errors.map((e) => `${formatPath(e.path)}: ${e.message}`).join('\n');
}

function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return '<file>';
  return path
    .map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`))
    .join('');
}

/**
 * Bound a report before it leaves the validator (or any other producer of
 * intent validation errors — capture's proposals-document rejection reuses it):
 * truncate every message and cap
 * the array, appending one synthetic error that states how many were dropped so
 * a consumer never mistakes the cap for "that was all of it".
 */
export function boundErrorReport(errors: IntentValidationError[]): IntentValidationError[] {
  const kept = errors.slice(0, INTENT_ERROR_REPORT_LIMITS.errors).map((error) => ({
    ...error,
    message: truncateMessage(error.message),
  }));
  const omitted = errors.length - kept.length;
  if (omitted > 0) {
    kept.push({
      code: IntentValidationCode.ErrorsOmitted,
      path: [],
      message: `${omitted} further validation error(s) were omitted; fix the reported ones and validate again`,
    });
  }
  return kept;
}

function truncateMessage(message: string): string {
  if (message.length <= INTENT_ERROR_REPORT_LIMITS.messageChars) return message;
  return message.slice(0, INTENT_ERROR_REPORT_LIMITS.messageChars - ELLIPSIS.length) + ELLIPSIS;
}

const text = (max: number) => z.string().min(1).max(max);
const textList = (max: number) => z.array(text(INTENT_LIMITS.text)).max(max);

const SourceRefSchema = z
  .object({
    kind: z.enum(IntentSourceKind),
    ref: text(INTENT_LIMITS.ref),
    localId: text(INTENT_LIMITS.id),
    revision: text(INTENT_LIMITS.id).optional(),
    locator: text(INTENT_LIMITS.ref).optional(),
  })
  .strict();

const CodeAnchorSchema = z
  .object({
    repo: text(INTENT_LIMITS.id),
    nodeId: text(INTENT_LIMITS.ref),
    nodeType: z.enum(VERSIONED_ANCHOR_NODE_TYPES),
    capturedVersionedId: text(INTENT_LIMITS.ref),
    rationale: text(INTENT_LIMITS.text),
  })
  .strict();

const CapabilityPayloadSchema = z
  .object({
    outcome: text(INTENT_LIMITS.text),
    beneficiary: text(INTENT_LIMITS.text),
    boundary: text(INTENT_LIMITS.text),
  })
  .strict();

const UseCasePayloadSchema = z
  .object({
    primaryActor: text(INTENT_LIMITS.text),
    trigger: text(INTENT_LIMITS.text),
    preconditions: textList(INTENT_LIMITS.listEntries),
    successOutcome: text(INTENT_LIMITS.text),
    failureOutcomes: textList(INTENT_LIMITS.listEntries),
  })
  .strict();

const FlowStepSchema = z
  .object({
    id: text(INTENT_LIMITS.id),
    actor: text(INTENT_LIMITS.text),
    action: text(INTENT_LIMITS.text),
    outcome: text(INTENT_LIMITS.text),
    branches: z
      .array(z.object({ condition: text(INTENT_LIMITS.text), toStepId: text(INTENT_LIMITS.id) }).strict())
      .max(INTENT_LIMITS.branchesPerStep)
      .optional(),
  })
  .strict();

const FlowPayloadSchema = z
  .object({
    trigger: text(INTENT_LIMITS.text),
    terminationCondition: text(INTENT_LIMITS.text),
    steps: z.array(FlowStepSchema).min(1).max(INTENT_LIMITS.steps),
  })
  .strict();

const slug = text(INTENT_LIMITS.itemId).regex(
  INTENT_SLUG_PATTERN,
  'must be a slug: lowercase a-z0-9 words joined by -',
);
const slugList = z.array(slug).min(1).max(INTENT_LIMITS.valuesPerCondition);

const DimensionValueSelectionSchema = z
  .record(slug, z.union([slug, slugList]))
  .refine((when) => Object.keys(when).length > 0, 'must name at least one dimension; omit it for the default variant');

const RuleVariantSchema = z
  .object({
    when: DimensionValueSelectionSchema.optional(),
    outcome: text(INTENT_LIMITS.text),
    inputs: z.array(text(INTENT_LIMITS.id)).max(INTENT_LIMITS.inputsPerVariant).optional(),
  })
  .strict();

/**
 * Registry-free shape only: the variant-overlap and registry checks
 * (`checkVariantOverlap`, `validateAgainstRegistry`) run at cloud propose, and
 * the local overlay accepts variants without them (LIM-1).
 */
const BusinessRulePayloadSchema = z
  .object({
    condition: text(INTENT_LIMITS.text),
    requiredOutcome: text(INTENT_LIMITS.text),
    observer: text(INTENT_LIMITS.text),
    exceptions: textList(INTENT_LIMITS.listEntries).optional(),
    variants: z.array(RuleVariantSchema).min(1).max(INTENT_LIMITS.variantsPerRule).optional(),
  })
  .strict();

const DimensionInClauseSchema = z.object({ dimension: slug, in: slugList }).strict();
const DimensionNotInClauseSchema = z.object({ dimension: slug, notIn: slugList }).strict();

export const ContextConditionSchema = z.union([
  DimensionInClauseSchema,
  DimensionNotInClauseSchema,
  z.object({ item: slug }).strict(),
  z.object({ text: text(INTENT_LIMITS.text) }).strict(),
]);

/** Item-level `appliesWhen` (cloud only; not part of the local overlay format, LIM-1). */
export const ContextConditionsSchema = z.array(ContextConditionSchema).min(1).max(INTENT_LIMITS.conditionsPerItem);

/**
 * Domain/feature `appliesWhen`: dimension clauses only, so the tree holds no
 * item references. An empty list clears the node's conditions.
 */
export const TreeConditionsSchema = z
  .array(z.union([DimensionInClauseSchema, DimensionNotInClauseSchema]))
  .max(INTENT_LIMITS.conditionsPerItem);

export const IntentDimensionSchema = z
  .object({
    id: slug,
    title: text(INTENT_LIMITS.title),
    values: z
      .array(
        z
          .object({
            id: slug,
            title: text(INTENT_LIMITS.title),
            aliases: z.array(text(INTENT_LIMITS.alias)).max(INTENT_LIMITS.aliasesPerValue).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(INTENT_LIMITS.valuesPerDimension)
      .refine((values) => new Set(values.map((v) => v.id)).size === values.length, 'value ids must be unique'),
    multi: z.boolean().default(false),
    archived: z.boolean().optional(),
  })
  .strict();

/**
 * A read context. An empty list is legal for a `multi` dimension (no product
 * subscribed); whether a list is allowed at all is a registry question
 * (`validateContext`).
 */
export const IntentContextSchema = z.record(slug, z.union([slug, z.array(slug).max(INTENT_LIMITS.valuesPerDimension)]));

const LimitationPayloadSchema = z
  .object({
    constraint: text(INTENT_LIMITS.text),
    reason: text(INTENT_LIMITS.text),
    affects: text(INTENT_LIMITS.text),
  })
  .strict();

const DecisionPayloadSchema = z
  .object({
    question: text(INTENT_LIMITS.text),
    choice: text(INTENT_LIMITS.text).optional(),
    choiceStatus: z.enum(DecisionStatus),
    rationale: text(INTENT_LIMITS.text),
    alternatives: textList(INTENT_LIMITS.listEntries),
    consequences: textList(INTENT_LIMITS.listEntries),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const open = payload.choiceStatus === DecisionStatus.Open;
    if (open && payload.choice !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['choice'], message: 'An open decision has no choice yet' });
    }
    if (!open && payload.choice === undefined) {
      ctx.addIssue({ code: 'custom', path: ['choice'], message: `A ${payload.choiceStatus} decision needs a choice` });
    }
  });

const itemBase = {
  id: text(INTENT_LIMITS.itemId),
  domain: text(INTENT_LIMITS.itemId),
  title: text(INTENT_LIMITS.title),
  statement: text(INTENT_LIMITS.statement),
  authority: z.enum(IntentAuthority),
  sources: z.array(SourceRefSchema).min(1).max(INTENT_LIMITS.sourcesPerItem),
  codeAnchors: z.array(CodeAnchorSchema).max(INTENT_LIMITS.anchorsPerItem).optional(),
};

const itemSchemaFor = <K extends IntentKind, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z.object({ ...itemBase, kind: z.literal(kind), payload }).strict();

const IntentItemSchema = z.discriminatedUnion('kind', [
  itemSchemaFor(IntentKind.Capability, CapabilityPayloadSchema),
  itemSchemaFor(IntentKind.UseCase, UseCasePayloadSchema),
  itemSchemaFor(IntentKind.Flow, FlowPayloadSchema),
  itemSchemaFor(IntentKind.BusinessRule, BusinessRulePayloadSchema),
  itemSchemaFor(IntentKind.Limitation, LimitationPayloadSchema),
  itemSchemaFor(IntentKind.Decision, DecisionPayloadSchema),
]);

/** The same six payload shapes the item union carries, addressable by kind. */
const PAYLOAD_SCHEMA_BY_KIND: Record<IntentKind, z.ZodType> = {
  [IntentKind.Capability]: CapabilityPayloadSchema,
  [IntentKind.UseCase]: UseCasePayloadSchema,
  [IntentKind.Flow]: FlowPayloadSchema,
  [IntentKind.BusinessRule]: BusinessRulePayloadSchema,
  [IntentKind.Limitation]: LimitationPayloadSchema,
  [IntentKind.Decision]: DecisionPayloadSchema,
};

/**
 * Validate ONE payload against its kind, pathed relative to the payload object.
 *
 * The cloud contract accepts an item's payload before the item is a file
 * (spec §4.4, D9), so it needs this half of {@link validateIntentFile} on its
 * own. Both layers run: the strict per-kind schema AND the flow semantics zod
 * cannot express — a payload the cloud accepts is a payload the local overlay
 * format accepts, by construction rather than by parallel maintenance.
 *
 * Returns the issues; an empty array means the payload is acceptable. The
 * report is bounded exactly as a file report is.
 */
export function validateIntentPayload(kind: IntentKind, payload: unknown): IntentValidationError[] {
  const parsed = PAYLOAD_SCHEMA_BY_KIND[kind].safeParse(payload);
  if (!parsed.success) {
    return boundErrorReport(
      parsed.error.issues.map((issue) => ({
        code: IntentValidationCode.Schema,
        path: issue.path as (string | number)[],
        message: issue.message,
      })),
    );
  }

  if (kind !== IntentKind.Flow) return [];
  const errors: IntentValidationError[] = [];
  collectFlowPayloadErrors(parsed.data as FlowPayload, [], errors);
  return boundErrorReport(errors);
}

const IntentRelationSchema = z
  .object({
    from: text(INTENT_LIMITS.itemId),
    type: z.enum(IntentRelationType),
    to: text(INTENT_LIMITS.itemId),
  })
  .strict();

const IntentDomainSchema = z
  .object({
    id: text(INTENT_LIMITS.itemId),
    title: text(INTENT_LIMITS.title),
    statement: text(INTENT_LIMITS.statement).optional(),
  })
  .strict();

export const IntentFileSchema = z
  .object({
    schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
    projectId: text(INTENT_LIMITS.id),
    domains: z.array(IntentDomainSchema).max(INTENT_LIMITS.domains),
    items: z.array(IntentItemSchema).max(INTENT_LIMITS.items),
    relations: z.array(IntentRelationSchema).max(INTENT_LIMITS.relations),
  })
  .strict();

const ANY_KIND: readonly IntentKind[] = Object.values(IntentKind);
const FLOW_CHAIN: readonly IntentKind[] = [IntentKind.Capability, IntentKind.UseCase, IntentKind.Flow];

/** The controlled registry: which endpoint kinds each relation may connect. */
const RELATION_RULES: Record<
  IntentRelationType,
  {
    from: readonly IntentKind[];
    to: readonly IntentKind[];
    sameKind?: boolean;
    pairs?: readonly [IntentKind, IntentKind][];
  }
> = {
  [IntentRelationType.Contains]: {
    from: [IntentKind.Capability, IntentKind.UseCase],
    to: [IntentKind.UseCase, IntentKind.Flow],
    pairs: [
      [IntentKind.Capability, IntentKind.UseCase],
      [IntentKind.UseCase, IntentKind.Flow],
    ],
  },
  [IntentRelationType.Governs]: { from: [IntentKind.BusinessRule], to: FLOW_CHAIN },
  [IntentRelationType.Constrains]: {
    from: [IntentKind.Limitation],
    to: [...FLOW_CHAIN, IntentKind.BusinessRule],
  },
  [IntentRelationType.Decides]: { from: [IntentKind.Decision], to: ANY_KIND },
  [IntentRelationType.DependsOn]: { from: FLOW_CHAIN, to: FLOW_CHAIN },
  [IntentRelationType.Supersedes]: { from: ANY_KIND, to: ANY_KIND, sameKind: true },
};

function relationPairAllowed(type: IntentRelationType, from: IntentKind, to: IntentKind): boolean {
  const rule = RELATION_RULES[type];
  if (rule.pairs) return rule.pairs.some(([f, t]) => f === from && t === to);
  if (rule.sameKind && from !== to) return false;
  return rule.from.includes(from) && rule.to.includes(to);
}

/**
 * BR-16 in one place: an id is `<kind prefix>-<slug>` with at least one slug
 * word beyond the prefix.
 *
 * Returns the actionable message, or `undefined` when the id is well formed.
 * The prefix and the format are reported as ONE error: an id like `BR-3` fails
 * both, and reporting two errors for one string would not tell the maintainer
 * anything the single message does not.
 */
export function describeItemIdViolation(id: string, kind: IntentKind): string | undefined {
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
  if (!INTENT_SLUG_PATTERN.test(id)) {
    return `intent id '${id}' must be '${prefix}-<slug>': lowercase a-z0-9 words joined by '-' (e.g. '${prefix}-refund-window')`;
  }
  if (id.length > INTENT_ID_MAX_LENGTH) {
    return `intent id '${id}' is longer than the ${INTENT_ID_MAX_LENGTH}-character cap`;
  }
  if (!id.startsWith(`${prefix}-`)) {
    return `intent id '${id}' does not carry the '${prefix}-' prefix its kind '${kind}' requires`;
  }
  return undefined;
}

/**
 * Source identity is `(ref, localId)` — the document and the position inside it
 * (BR-6). `kind` is a CLASSIFICATION of that document, not part of its identity:
 * including it would make a re-capture that reclassified the same source (spec →
 * ticket) look like a new source and append a duplicate.
 */
function sourceIdentity(source: { ref: string; localId: string }): string {
  return JSON.stringify([source.ref, source.localId]);
}

function describeIdentity(source: { ref: string; localId: string }): string {
  return `(${source.ref}, ${source.localId})`;
}

/**
 * Validate an unknown value as an intent file.
 *
 * Fails closed: a semantic pass runs only after the schema pass succeeds, so a
 * caller never receives a partially trusted model.
 */
export function validateIntentFile(input: unknown, options: IntentValidationOptions = {}): IntentValidationResult {
  const unsupported = detectUnsupportedSchemaVersion(input);
  if (unsupported) return { ok: false, errors: [unsupported] };

  const parsed = IntentFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: boundErrorReport(
        parsed.error.issues.map((issue) => ({
          code: IntentValidationCode.Schema,
          path: issue.path as (string | number)[],
          message: issue.message,
        })),
      ),
    };
  }

  // Checked assignment, not a cast: if IntentFileSchema and the IntentFileV2
  // interface ever drift apart, this line stops compiling.
  const file: IntentFileV2 = parsed.data;
  const errors = validateSemantics(file, options);
  return errors.length > 0 ? { ok: false, errors: boundErrorReport(errors) } : { ok: true, file };
}

/**
 * The two unsupported-version refusals, kept DISTINCT from a generic shape
 * error because they need different actions from the reader.
 *
 * A newer file needs a newer Coredoc. A v1 file needs the one-time reviewed
 * migration to slug ids and domains: it is not partially loaded and never
 * silently upgraded (BR-22), because a lenient read would have to invent both
 * an id format and a domain for every item.
 */
function detectUnsupportedSchemaVersion(input: unknown): IntentValidationError | null {
  if (typeof input !== 'object' || input === null) return null;
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number') return null;
  if (version === INTENT_LEGACY_SCHEMA_VERSION) {
    return {
      code: IntentValidationCode.LegacySchemaVersion,
      path: ['schemaVersion'],
      message: LEGACY_SCHEMA_REMEDIATION,
    };
  }
  if (version <= INTENT_SCHEMA_VERSION) return null;
  return {
    code: IntentValidationCode.NewerSchemaVersion,
    path: ['schemaVersion'],
    message:
      `intent.json declares schemaVersion ${version}, but this Coredoc supports ${INTENT_SCHEMA_VERSION}. ` +
      'Upgrade Coredoc to read this file; do not downgrade the file by hand.',
  };
}

/**
 * Authored once and exported so every surface (CLI validate/status/context, MCP)
 * shows the maintainer the SAME remediation for a pre-migration overlay.
 */
export const LEGACY_SCHEMA_REMEDIATION =
  `intent.json declares schemaVersion ${INTENT_LEGACY_SCHEMA_VERSION}, which predates slug intent ids and the ` +
  `domains registry required by schemaVersion ${INTENT_SCHEMA_VERSION}. This overlay needs the one-time reviewed ` +
  'migration: declare `domains`, give every item a `<kind-prefix>-<slug>` id and one declared `domain`, repoint ' +
  'the relation endpoints, and write the result through the canonical writer. No surface reads a v1 overlay.';

function validateSemantics(file: IntentFileV2, options: IntentValidationOptions): IntentValidationError[] {
  const errors: IntentValidationError[] = [];

  if (options.expectedProjectId !== undefined && file.projectId !== options.expectedProjectId) {
    errors.push({
      code: IntentValidationCode.ProjectMismatch,
      path: ['projectId'],
      message: `intent file belongs to project '${file.projectId}', expected '${options.expectedProjectId}'`,
    });
  }

  // The registry is validated FIRST so an item's domain reference is checked
  // against a known-good set of declared ids rather than against duplicates.
  const declaredDomains = new Set<string>();
  file.domains.forEach((domain, index) => {
    if (!INTENT_SLUG_PATTERN.test(domain.id)) {
      errors.push({
        code: IntentValidationCode.InvalidDomainId,
        path: ['domains', index, 'id'],
        message: `domain id '${domain.id}' must be a slug: lowercase a-z0-9 words joined by '-' (e.g. 'order-capture')`,
      });
      return;
    }
    if (declaredDomains.has(domain.id)) {
      errors.push({
        code: IntentValidationCode.DuplicateDomainId,
        path: ['domains', index, 'id'],
        message: `duplicate domain id '${domain.id}' in the registry`,
      });
      return;
    }
    declaredDomains.add(domain.id);
  });
  const declaredDomainList = [...declaredDomains].join(', ') || '<none declared>';

  const kindById = new Map<string, IntentKind>();
  const seenIds = new Set<string>();
  // Source identity must be unambiguous WITHIN one authority class: re-capture
  // (BR-6) needs exactly one candidate to update, and two accepted items sharing
  // one identity would leave "what is the accepted intent of this source?"
  // ambiguous. ACROSS classes it is legitimate — an accepted item and the
  // candidate proposing a change to it share their identity by design (BR-2).
  const identityOwners = new Map<string, { itemId: string; path: (string | number)[] }>();
  const ownerKey = (authority: IntentAuthority, identity: string) => `${authority}\x00${identity}`;

  file.items.forEach((item, itemIndex) => {
    const idError = describeItemIdViolation(item.id, item.kind);
    if (idError !== undefined) {
      errors.push({
        code: IntentValidationCode.InvalidItemId,
        path: ['items', itemIndex, 'id'],
        message: idError,
      });
    }

    // A stranded item — one whose domain was removed from the registry — is the
    // same error as one that never referenced a declared domain: the file is
    // rejected as a whole, so a registry edit cannot leave items behind (BR-19).
    if (!declaredDomains.has(item.domain)) {
      errors.push({
        code: IntentValidationCode.UndeclaredDomain,
        path: ['items', itemIndex, 'domain'],
        message:
          `item '${item.id}' references domain '${item.domain}', which the registry does not declare; ` +
          `declared domains: ${declaredDomainList}`,
      });
    }

    if (seenIds.has(item.id)) {
      errors.push({
        code: IntentValidationCode.DuplicateItemId,
        path: ['items', itemIndex, 'id'],
        message: `duplicate intent item id '${item.id}'`,
      });
    }
    seenIds.add(item.id);
    kindById.set(item.id, item.kind);

    const identitiesInItem = new Set<string>();
    item.sources.forEach((source, sourceIndex) => {
      const identity = sourceIdentity(source);
      const path = ['items', itemIndex, 'sources', sourceIndex];
      if (identitiesInItem.has(identity)) {
        errors.push({
          code: IntentValidationCode.DuplicateSourceIdentity,
          path,
          message: `source identity ${describeIdentity(source)} is repeated inside item '${item.id}'`,
        });
        return;
      }
      identitiesInItem.add(identity);

      const key = ownerKey(item.authority, identity);
      const owner = identityOwners.get(key);
      if (owner !== undefined) {
        errors.push({
          code: IntentValidationCode.DuplicateSourceIdentity,
          path,
          message:
            `source identity ${describeIdentity(source)} is already claimed by ${item.authority} item ` +
            `'${owner.itemId}' at ${formatPath(owner.path)}`,
        });
        return;
      }
      identityOwners.set(key, { itemId: item.id, path });
    });

    if (item.kind === IntentKind.Flow) {
      collectFlowPayloadErrors(item.payload, ['items', itemIndex, 'payload'], errors, item.id);
    }
  });

  file.relations.forEach((relation, index) => {
    // Every controlled relation is directed between two DISTINCT items; a self
    // loop ('X supersedes X') is meaningless and would make traversal cyclic.
    if (relation.from === relation.to) {
      errors.push({
        code: IntentValidationCode.SelfReferentialRelation,
        path: ['relations', index],
        message: `relation '${relation.type}' points item '${relation.from}' at itself`,
      });
      return;
    }

    const fromKind = kindById.get(relation.from);
    const toKind = kindById.get(relation.to);
    if (fromKind === undefined) {
      errors.push({
        code: IntentValidationCode.DanglingRelationEndpoint,
        path: ['relations', index, 'from'],
        message: `relation endpoint '${relation.from}' does not exist in this file`,
      });
    }
    if (toKind === undefined) {
      errors.push({
        code: IntentValidationCode.DanglingRelationEndpoint,
        path: ['relations', index, 'to'],
        message: `relation endpoint '${relation.to}' does not exist in this file`,
      });
    }
    if (fromKind === undefined || toKind === undefined) return;
    if (!relationPairAllowed(relation.type, fromKind, toKind)) {
      errors.push({
        code: IntentValidationCode.InvalidRelationKindPair,
        path: ['relations', index],
        message: `relation '${relation.type}' is not allowed from ${fromKind} to ${toKind}`,
      });
    }
  });

  return errors;
}

/**
 * The flow-payload semantics zod cannot express, pathed from `pathPrefix`.
 *
 * Both entry points share it: {@link validateIntentFile} passes the item's
 * position (`items.2.payload`) and its id, {@link validateIntentPayload} passes
 * an empty prefix and no id because a bare payload has neither. The `in flow
 * '<id>'` clause is therefore omitted rather than filled with a placeholder —
 * an invented id in a message is a fact the caller cannot check.
 */
function collectFlowPayloadErrors(
  payload: FlowPayload,
  pathPrefix: (string | number)[],
  errors: IntentValidationError[],
  flowId?: string,
): void {
  const inFlow = flowId === undefined ? '' : ` in flow '${flowId}'`;
  const ofFlow = flowId === undefined ? ' of this flow' : ` of flow '${flowId}'`;

  const stepIds = new Set<string>();
  payload.steps.forEach((step, stepIndex) => {
    if (stepIds.has(step.id)) {
      errors.push({
        code: IntentValidationCode.DuplicateFlowStepId,
        path: [...pathPrefix, 'steps', stepIndex, 'id'],
        message: `duplicate flow step id '${step.id}'${inFlow}`,
      });
    }
    stepIds.add(step.id);
  });

  payload.steps.forEach((step, stepIndex) => {
    step.branches?.forEach((branch, branchIndex) => {
      if (stepIds.has(branch.toStepId)) return;
      errors.push({
        code: IntentValidationCode.InvalidFlowBranchTarget,
        path: [...pathPrefix, 'steps', stepIndex, 'branches', branchIndex, 'toStepId'],
        message: `branch target '${branch.toStepId}' is not a step${ofFlow}`,
      });
    });
  });
}
