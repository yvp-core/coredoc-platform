/**
 * Shared intent content bounds and strict validators: per-kind payloads,
 * context conditions, tree conditions, and the dimension registry.
 *
 * Zod strict object parsing — shape, enums, bounded text. Unknown keys are
 * REJECTED: that is what keeps source bodies, prompts, transcripts, and
 * arbitrary payloads out of stored intent (BR-14 / AC-11). Every error carries
 * a JSON path so a caller can point at the offending position.
 */
import { z } from 'zod';
import { DecisionStatus, INTENT_ID_MAX_LENGTH, INTENT_SLUG_PATTERN, type FlowPayload, IntentKind } from './types.js';

/**
 * Content bounds. The pilot holds a small reviewed set (~20-30 items, ~100
 * anchors); these caps are the structural half of BR-14 — a transcript, a spec
 * body, or a dumped file cannot fit through a bounded text field.
 */
export const INTENT_LIMITS = {
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
  /** Synthetic: further errors existed but were not reported (see {@link INTENT_ERROR_REPORT_LIMITS}). */
  ErrorsOmitted = 'errors_omitted',
  InvalidFlowBranchTarget = 'invalid_flow_branch_target',
  DuplicateFlowStepId = 'duplicate_flow_step_id',
}

export interface IntentValidationError {
  code: IntentValidationCode;
  path: (string | number)[];
  message: string;
}

/**
 * Bound a report before it leaves the validator: truncate every message and cap
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
 * (`checkVariantOverlap`, `validateAgainstRegistry`) run at cloud propose.
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

/** Item-level `appliesWhen`. */
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

/** The six payload shapes, addressable by kind. */
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
 * Both layers run: the strict per-kind schema AND the flow semantics zod
 * cannot express (spec §4.4, D9).
 *
 * Returns the issues; an empty array means the payload is acceptable. The
 * report is bounded by {@link boundErrorReport}.
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
  collectFlowPayloadErrors(parsed.data as FlowPayload, errors);
  return boundErrorReport(errors);
}

/**
 * The flow-payload semantics zod cannot express, pathed from the payload.
 *
 * A bare payload carries no flow id, so messages name no flow rather than a
 * placeholder — an invented id in a message is a fact the caller cannot check.
 */
function collectFlowPayloadErrors(payload: FlowPayload, errors: IntentValidationError[]): void {
  const stepIds = new Set<string>();
  payload.steps.forEach((step, stepIndex) => {
    if (stepIds.has(step.id)) {
      errors.push({
        code: IntentValidationCode.DuplicateFlowStepId,
        path: ['steps', stepIndex, 'id'],
        message: `duplicate flow step id '${step.id}'`,
      });
    }
    stepIds.add(step.id);
  });

  payload.steps.forEach((step, stepIndex) => {
    step.branches?.forEach((branch, branchIndex) => {
      if (stepIds.has(branch.toStepId)) return;
      errors.push({
        code: IntentValidationCode.InvalidFlowBranchTarget,
        path: ['steps', stepIndex, 'branches', branchIndex, 'toStepId'],
        message: `branch target '${branch.toStepId}' is not a step of this flow`,
      });
    });
  });
}
