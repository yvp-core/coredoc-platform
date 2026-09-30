/**
 * Context conditions: pure evaluation of item `appliesWhen` clauses and
 * business-rule `variants` against a reader-supplied context.
 *
 * Every dimension value is handled as a SET, so a single value and a `multi`
 * list follow one rule: `in` holds when the sets intersect, `notIn` when they
 * do not. Registry lookups stay with the caller; these functions only see ids.
 */
import {
  type ContextCondition,
  type DimensionValueSelection,
  IntentAuthority,
  type IntentContext,
  type IntentDimension,
  type RuleVariant,
} from './types.js';

export enum ContextMatchState {
  Match = 'match',
  Excluded = 'excluded',
  Open = 'open',
  Unevaluated = 'unevaluated',
}

export enum ConditionReasonCode {
  TextCondition = 'text-condition',
  ItemNotFound = 'item-not-found',
  ItemRejected = 'item-rejected',
  ItemSuperseded = 'item-superseded',
  ItemNotAccepted = 'item-not-accepted',
  NestedItemCondition = 'nested-item-condition',
}

export interface ConditionReason {
  /** Index of the clause in the evaluated item's `appliesWhen`. */
  clause: number;
  code: ConditionReasonCode;
  /** The referenced item, for an `item` clause. */
  item?: string;
}

export interface ContextConditionsEvaluation {
  state: ContextMatchState;
  /** Dimension ids the context left open, deduplicated in clause order. */
  open: string[];
  reasons: ConditionReason[];
}

/** What an `item` clause needs to know about the item it references. */
export interface ConditionItemRef {
  authority: IntentAuthority;
  appliesWhen?: ContextCondition[];
}

export type ConditionItemLookup = (itemId: string) => ConditionItemRef | undefined;

export const toSet = (value: string | string[]): Set<string> => new Set(Array.isArray(value) ? value : [value]);

/**
 * A record's OWN value for a dimension id. A valid slug id like `constructor`
 * would otherwise read an inherited prototype member as a supplied value.
 */
export const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export const intersects = (a: Set<string>, b: Iterable<string>): boolean => {
  for (const v of b) if (a.has(v)) return true;
  return false;
};

/** `true`/`false` for a decided dimension clause, `undefined` when its dimension is absent from the context. */
function dimensionClauseTruth(clause: DimensionClause, context: IntentContext): boolean | undefined {
  const value = ownValue(context, clause.dimension);
  if (value === undefined) return undefined;
  const set = toSet(value);
  return 'in' in clause ? intersects(set, clause.in) : !intersects(set, clause.notIn);
}

export type DimensionClause = Extract<ContextCondition, { dimension: string }>;

export const isDimensionClause = (clause: ContextCondition): clause is DimensionClause => 'dimension' in clause;

/**
 * Evaluate an item's `appliesWhen` (BR-1..BR-3).
 *
 * `excluded` iff any clause is false. Otherwise `unevaluated` takes precedence
 * over `open`: supplying the open dimensions can still never settle an
 * unevaluated clause. Both `open` and `reasons` are always reported.
 */
export function evaluateContextConditions(
  conditions: ContextCondition[] | undefined,
  context: IntentContext,
  lookup: ConditionItemLookup,
): ContextConditionsEvaluation {
  const open = new Set<string>();
  const reasons: ConditionReason[] = [];
  let excluded = false;
  const applyDimension = (clause: DimensionClause) => {
    const truth = dimensionClauseTruth(clause, context);
    if (truth === undefined) open.add(clause.dimension);
    else if (!truth) excluded = true;
  };

  (conditions ?? []).forEach((clause, index) => {
    if (isDimensionClause(clause)) {
      applyDimension(clause);
      return;
    }
    if ('text' in clause) {
      reasons.push({ clause: index, code: ConditionReasonCode.TextCondition });
      return;
    }

    const ref = lookup(clause.item);
    const blocked =
      ref === undefined
        ? ConditionReasonCode.ItemNotFound
        : ref.authority === IntentAuthority.Rejected
          ? ConditionReasonCode.ItemRejected
          : ref.authority === IntentAuthority.Superseded
            ? ConditionReasonCode.ItemSuperseded
            : // An unreviewed candidate's conditions can change without review, so they never filter another item.
              ref.authority !== IntentAuthority.Accepted
              ? ConditionReasonCode.ItemNotAccepted
              : undefined;
    if (ref === undefined || blocked !== undefined) {
      reasons.push({ clause: index, code: blocked ?? ConditionReasonCode.ItemNotFound, item: clause.item });
      return;
    }
    // One level deep: the referenced item's own item/text clauses are not followed.
    for (const inner of ref.appliesWhen ?? []) {
      if (isDimensionClause(inner)) {
        applyDimension(inner);
      } else {
        reasons.push({
          clause: index,
          code: 'item' in inner ? ConditionReasonCode.NestedItemCondition : ConditionReasonCode.TextCondition,
          item: clause.item,
        });
      }
    }
  });

  const state = excluded
    ? ContextMatchState.Excluded
    : reasons.length > 0
      ? ContextMatchState.Unevaluated
      : open.size > 0
        ? ContextMatchState.Open
        : ContextMatchState.Match;
  return { state, open: [...open], reasons };
}

/** The tree levels whose `appliesWhen` make up an item's effective conditions, outermost first. */
export enum ConditionLevel {
  Domain = 'domain',
  Feature = 'feature',
  Item = 'item',
}

export type LeveledConditions = Partial<Record<ConditionLevel, ContextCondition[] | undefined>>;

const LEVEL_ORDER = [ConditionLevel.Domain, ConditionLevel.Feature, ConditionLevel.Item];

/** BR-1: an item's effective conditions are its domain's AND its feature's AND its own clauses. */
export const composeEffectiveConditions = (levels: LeveledConditions): ContextCondition[] =>
  LEVEL_ORDER.flatMap((level) => levels[level] ?? []);

export interface EffectiveConditionsEvaluation extends ContextConditionsEvaluation {
  /** The first level, outermost first, whose clauses excluded the item (state `excluded` only). */
  decidedBy?: ConditionLevel;
  /** The levels whose clauses left a dimension open, outermost first (omitted when none did). */
  openBy?: ConditionLevel[];
}

/**
 * Evaluate each level with `evaluateContextConditions` and AND the results.
 * `reasons[].clause` indexes the level's own list; only the item level can
 * produce reasons, since tree conditions hold dimension clauses only.
 */
export function evaluateEffectiveConditions(
  levels: LeveledConditions,
  context: IntentContext,
  lookup: ConditionItemLookup,
): EffectiveConditionsEvaluation {
  const open = new Set<string>();
  const reasons: ConditionReason[] = [];
  const openBy: ConditionLevel[] = [];
  let decidedBy: ConditionLevel | undefined;
  for (const level of LEVEL_ORDER) {
    const result = evaluateContextConditions(levels[level], context, lookup);
    if (result.state === ContextMatchState.Excluded && decidedBy === undefined) decidedBy = level;
    if (result.open.length > 0) openBy.push(level);
    for (const d of result.open) open.add(d);
    reasons.push(...result.reasons);
  }
  const state =
    decidedBy !== undefined
      ? ContextMatchState.Excluded
      : reasons.length > 0
        ? ContextMatchState.Unevaluated
        : open.size > 0
          ? ContextMatchState.Open
          : ContextMatchState.Match;
  return {
    state,
    open: [...open],
    reasons,
    ...(decidedBy !== undefined && { decidedBy }),
    ...(openBy.length > 0 && { openBy }),
  };
}

export enum VariantResolutionState {
  Resolved = 'resolved',
  Default = 'default',
  /** No variant applies; the rule's `requiredOutcome` is the outcome. */
  Base = 'base',
  Ambiguous = 'ambiguous',
  Open = 'open',
}

export interface VariantResolution {
  state: VariantResolutionState;
  variants: RuleVariant[];
  /** Variant dimensions the context leaves open (state `open` only). */
  open: string[];
}

const specificity = (variant: RuleVariant): number => Object.keys(variant.when ?? {}).length;

/**
 * Resolve a rule's variants for a context (BR-4). A rule without variants
 * resolves to `base` (its `requiredOutcome`) with no variants; callers only resolve rules that carry them.
 */
export function resolveVariants(variants: RuleVariant[] | undefined, context: IntentContext): VariantResolution {
  const all = variants ?? [];
  const dims = new Set(all.flatMap((v) => Object.keys(v.when ?? {})));
  const open = [...dims].filter((d) => ownValue(context, d) === undefined);
  // Open dimensions count as matching here; with none open this is exact matching.
  const matches = (v: RuleVariant) =>
    Object.entries(v.when ?? {}).every(([d, values]) => {
      const supplied = ownValue(context, d);
      return supplied === undefined || intersects(toSet(supplied), toSet(values));
    });

  if (open.length > 0) {
    return { state: VariantResolutionState.Open, variants: all.filter(matches), open };
  }

  const matching = all.filter((v) => v.when !== undefined && matches(v));
  if (matching.length === 0) {
    const fallback = all.find((v) => v.when === undefined);
    return fallback
      ? { state: VariantResolutionState.Default, variants: [fallback], open: [] }
      : { state: VariantResolutionState.Base, variants: [], open: [] };
  }
  const top = Math.max(...matching.map(specificity));
  const winners = matching.filter((v) => specificity(v) === top);
  return {
    state: winners.length > 1 ? VariantResolutionState.Ambiguous : VariantResolutionState.Resolved,
    variants: winners,
    open: [],
  };
}

export enum VariantIssueCode {
  VariantOverlap = 'variant_overlap',
  SecondDefault = 'second_default',
}

export interface VariantIssue {
  code: VariantIssueCode;
  /** The offending variant. */
  index: number;
  /** The earlier variant it collides with. */
  otherIndex: number;
}

export const dimensionSetKey = (when: DimensionValueSelection): string => JSON.stringify(Object.keys(when).sort());

/**
 * BR-5: a second default, or two variants over the same dimension set whose
 * value sets intersect on every dimension (both could match one context at
 * equal specificity).
 */
export function checkVariantOverlap(variants: RuleVariant[] | undefined): VariantIssue[] {
  const issues: VariantIssue[] = [];
  const all = variants ?? [];
  const firstDefault = all.findIndex((v) => v.when === undefined);
  all.forEach((variant, index) => {
    const when = variant.when;
    if (when === undefined) {
      if (index !== firstDefault)
        issues.push({ code: VariantIssueCode.SecondDefault, index, otherIndex: firstDefault });
      return;
    }
    for (let other = 0; other < index; other++) {
      const otherWhen = all[other].when;
      if (otherWhen === undefined || dimensionSetKey(otherWhen) !== dimensionSetKey(when)) continue;
      if (Object.keys(when).every((d) => intersects(toSet(when[d]), toSet(otherWhen[d])))) {
        issues.push({ code: VariantIssueCode.VariantOverlap, index, otherIndex: other });
      }
    }
  });
  return issues;
}

export enum RegistryIssueCode {
  DimensionNotFound = 'dimension_not_found',
  DimensionValueNotFound = 'dimension_value_not_found',
  /** A read context gives a list for a single-value dimension. */
  DimensionNotMulti = 'dimension_not_multi',
}

export interface RegistryIssue {
  code: RegistryIssueCode;
  path: (string | number)[];
  dimension: string;
  value?: string;
}

/** Declared, non-archived dimensions by id. */
const activeDimensions = (dimensions: IntentDimension[]): Map<string, IntentDimension> =>
  new Map(dimensions.filter((d) => !d.archived).map((d) => [d.id, d]));

function checkSelection(
  registry: Map<string, IntentDimension>,
  dimension: string,
  values: string | string[],
  path: (string | number)[],
  issues: RegistryIssue[],
): IntentDimension | undefined {
  const declared = registry.get(dimension);
  if (declared === undefined) {
    issues.push({ code: RegistryIssueCode.DimensionNotFound, path, dimension });
    return undefined;
  }
  const known = new Set(declared.values.map((v) => v.id));
  for (const value of toSet(values)) {
    if (!known.has(value)) issues.push({ code: RegistryIssueCode.DimensionValueNotFound, path, dimension, value });
  }
  return declared;
}

/**
 * BR-6 registry half: every dimension and value named by `appliesWhen` clauses
 * or rule variants must be declared and not archived. A list in a variant
 * `when` is allowed for any dimension (it lists alternatives). `item` clauses
 * are the caller's lookup.
 */
export function validateAgainstRegistry(
  conditions: ContextCondition[] | undefined,
  variants: RuleVariant[] | undefined,
  dimensions: IntentDimension[],
): RegistryIssue[] {
  const registry = activeDimensions(dimensions);
  const issues: RegistryIssue[] = [];
  (conditions ?? []).forEach((clause, index) => {
    if (!isDimensionClause(clause)) return;
    const key = 'in' in clause ? 'in' : 'notIn';
    const values = 'in' in clause ? clause.in : clause.notIn;
    checkSelection(registry, clause.dimension, values, ['appliesWhen', index, key], issues);
  });
  (variants ?? []).forEach((variant, index) => {
    for (const [dimension, values] of Object.entries(variant.when ?? {})) {
      checkSelection(registry, dimension, values, ['variants', index, 'when', dimension], issues);
    }
  });
  return issues;
}

/** A read context: declared dimensions and values only, and a list only for a `multi` dimension. */
export function validateContext(context: IntentContext, dimensions: IntentDimension[]): RegistryIssue[] {
  const registry = activeDimensions(dimensions);
  const issues: RegistryIssue[] = [];
  for (const [dimension, values] of Object.entries(context)) {
    const declared = checkSelection(registry, dimension, values, ['context', dimension], issues);
    if (declared !== undefined && !declared.multi && Array.isArray(values)) {
      issues.push({ code: RegistryIssueCode.DimensionNotMulti, path: ['context', dimension], dimension });
    }
  }
  return issues;
}
