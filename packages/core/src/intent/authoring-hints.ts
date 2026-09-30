/**
 * Non-blocking authoring hints (BR-3, BR-5). Pure and registry-driven: they
 * never write a condition and never fail a proposal.
 */
import {
  ContextMatchState,
  VariantResolutionState,
  dimensionSetKey,
  evaluateContextConditions,
  intersects,
  isDimensionClause,
  ownValue,
  resolveVariants,
  toSet,
  validateContext,
} from './context-conditions.js';
import type { ContextCondition, IntentContext, IntentDimension, RuleVariant } from './types.js';

export enum HintKind {
  MissingCondition = 'missing-condition',
  AmbiguousVariants = 'ambiguous-variants',
  DeadVariant = 'dead-variant',
  /** An `item` clause names a candidate: it reads `unevaluated` and filters nothing until that item is accepted. */
  UnacceptedConditionItem = 'unaccepted-condition-item',
}

export interface UnacceptedConditionItemHint {
  kind: HintKind.UnacceptedConditionItem;
  /** The referenced item, still a candidate. */
  item: string;
}

export interface MissingConditionHint {
  kind: HintKind.MissingCondition;
  dimension: string;
  value: string;
  /** The text as it appears in the scanned text. */
  matched: string;
}

export interface AmbiguousVariantsHint {
  kind: HintKind.AmbiguousVariants;
  /** Indexes of the two variants, ascending. */
  variants: [number, number];
  /** A complete context (every variant dimension set) that `resolveVariants` reads as `ambiguous` with both among the winners. */
  context: IntentContext;
}

export interface DeadVariantHint {
  kind: HintKind.DeadVariant;
  variant: number;
}

export type AuthoringHint =
  | MissingConditionHint
  | AmbiguousVariantsHint
  | DeadVariantHint
  | UnacceptedConditionItemHint;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole word/phrase, case-insensitive, Unicode letter/digit boundaries; inner whitespace matches any run. */
const termPattern = (term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${term.trim().split(/\s+/).map(escapeRegExp).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');

/**
 * A mention the text negates right before it ("non-Brazilian", "without Shifts",
 * "outside Brazil", "except Brazil"): it names the value in order to exclude it,
 * so it is not a missing `in` condition. English only, like the rest of the text.
 */
const NEGATED_BEFORE =
  /(?:\bnon[-\s]?|\bnot\s+(?:in\s+|for\s+)?|\bwithout\s+(?:an?\s+|the\s+)?|\boutside\s+(?:of\s+)?(?:the\s+)?|\bexcept\s+(?:for\s+|in\s+)?|\bexcluding\s+|\bother\s+than\s+)$/iu;

/**
 * How far back `NEGATED_BEFORE` looks. Its longest alternative with single
 * spaces is "outside of the " (15 chars) plus the `\b` context char; testing
 * only this tail keeps the scan linear. Wider whitespace runs than the slack are not seen as negation.
 */
const NEGATION_WINDOW = 32;

/** Compiled alias patterns per value, per registry dimension object: callers hint many items against one registry. */
const aliasPatternCache = new WeakMap<IntentDimension, RegExp[][]>();

const aliasPatterns = (dimension: IntentDimension): RegExp[][] => {
  let compiled = aliasPatternCache.get(dimension);
  if (compiled === undefined) {
    compiled = dimension.values.map((value) =>
      (value.aliases ?? []).filter((term) => term.trim() !== '').map(termPattern),
    );
    aliasPatternCache.set(dimension, compiled);
  }
  return compiled;
};

function firstUnnegatedMatch(pattern: RegExp, text: string): string | undefined {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (!NEGATED_BEFORE.test(text.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index))) return match[0];
  }
  return undefined;
}

/**
 * BR-3 / LIM-1: one hint per (dimension, value) the text names, on dimensions
 * no effective dimension clause constrains. A value is named ONLY by its
 * `aliases`: the registry author lists the words that mean the value in prose.
 * Titles are display text ("Admin", "Enabled", "Project") and collide with
 * ordinary words, so a value without aliases is never hinted. Bare value ids are
 * not matched either: short slugs ("us", "de", "ta") collide with ordinary words.
 * A negated mention ("non-Brazilian", "without Shifts") is skipped.
 * Only dimension clauses count: callers fold an `item` clause's target clauses into `effectiveClauses`.
 */
export function detectMissingConditionHints(
  text: string,
  dimensions: IntentDimension[],
  effectiveClauses: ContextCondition[],
): MissingConditionHint[] {
  const constrained = new Set(effectiveClauses.filter(isDimensionClause).map((c) => c.dimension));
  const hints: MissingConditionHint[] = [];
  for (const dimension of dimensions) {
    if (dimension.archived || constrained.has(dimension.id)) continue;
    const patterns = aliasPatterns(dimension);
    dimension.values.forEach((value, index) => {
      let match: string | undefined;
      for (const pattern of patterns[index] ?? []) {
        match = firstUnnegatedMatch(pattern, text);
        if (match !== undefined) break;
      }
      if (match !== undefined) {
        hints.push({ kind: HintKind.MissingCondition, dimension: dimension.id, value: value.id, matched: match });
      }
    });
  }
  return hints;
}

// ponytail: fixed search bounds; a rule past them gets fewer ambiguity hints, never an error. Raise if real rules need more.
/** Candidate contexts enumerated per pair. */
const MAX_CANDIDATE_CONTEXTS = 256;
/** Candidate values per union dimension (a shared multi dimension yields value pairs). */
const MAX_OPTIONS_PER_DIMENSION = 64;
/** Candidate contexts built plus covering checks across the whole call; once spent, no further ambiguity hints are emitted. */
const VARIANT_WORK_BUDGET = 100_000;

/**
 * BR-5. A variant is dead when, on some dimension, every value it lists is
 * excluded by the effective clauses: a `notIn` removes its values; an `in`
 * restricts a single-value dimension only (a `multi` context can hold an `in`
 * value next to the variant's). Per BR-4 the variant with the most dimensions
 * wins, so only two live variants of EQUAL specificity can tie: over different
 * dimension sets when a context over their union matches both and no more
 * specific variant matches it too; over the same set when they differ only on
 * `multi` dimensions, which a context can satisfy with one value from each.
 * Value sets that intersect on every dimension are `checkVariantOverlap`'s.
 * A hint is emitted only with a verified witness: a complete, registry-valid
 * context the effective clauses keep, for which `resolveVariants` itself
 * returns `ambiguous` with both variants among the winners. When the bounded
 * search finds none, the pair is not hinted.
 */
export function detectVariantHints(
  variants: RuleVariant[] | undefined,
  effectiveClauses: ContextCondition[],
  dimensions: IntentDimension[],
): (AmbiguousVariantsHint | DeadVariantHint)[] {
  const all = variants ?? [];
  const multi = new Set(dimensions.filter((d) => d.multi).map((d) => d.id));
  const clauses = effectiveClauses.filter(isDimensionClause);
  const live = (dimension: string, values: string | string[]): string[] =>
    clauses
      .filter((c) => c.dimension === dimension)
      .reduce(
        (acc, c) =>
          'notIn' in c
            ? acc.filter((v) => !c.notIn.includes(v))
            : multi.has(dimension)
              ? acc
              : acc.filter((v) => c.in.includes(v)),
        [...toSet(values)],
      );
  const liveWhen = all.map((v) =>
    v.when === undefined ? undefined : Object.fromEntries(Object.entries(v.when).map(([d, vs]) => [d, live(d, vs)])),
  );

  const hints: (AmbiguousVariantsHint | DeadVariantHint)[] = [];
  const isDead = (i: number) => {
    const when = liveWhen[i];
    return when !== undefined && Object.values(when).some((vs) => vs.length === 0);
  };
  all.forEach((_, i) => {
    if (isDead(i)) hints.push({ kind: HintKind.DeadVariant, variant: i });
  });

  // For each variant dimension, a live registry value no variant lists: setting it can never make a variant match.
  const variantDims = [...new Set(all.flatMap((v) => Object.keys(v.when ?? {})))];
  const freeValue = new Map<string, string>();
  for (const d of variantDims) {
    const listed = new Set(all.flatMap((v) => (v.when && Object.hasOwn(v.when, d) ? [...toSet(v.when[d])] : [])));
    const free = dimensions
      .find((dim) => dim.id === d && !dim.archived)
      ?.values.find((value) => !listed.has(value.id) && live(d, value.id).length > 0);
    if (free !== undefined) freeValue.set(d, free.id);
  }

  /** A multi value plus, per unmet `in` clause on its dimension, that clause's first live value, so the clauses keep it. */
  const withRequired = (d: string, value: string | string[]): string | string[] => {
    if (!multi.has(d)) return value;
    const values = [...toSet(value)];
    for (const c of clauses) {
      if (c.dimension !== d || !('in' in c) || c.in.some((v) => values.includes(v))) continue;
      const pick = c.in.find((v) => live(d, v).length > 0);
      if (pick !== undefined) values.push(pick);
    }
    return values.length === 1 ? values[0] : values;
  };

  let budget = VARIANT_WORK_BUDGET;
  // Value sets of the variants that can win over a pair: live, conditioned ones.
  const whenSets = all.map((v, k) =>
    v.when === undefined || isDead(k)
      ? undefined
      : Object.entries(v.when).map(([d, values]) => [d, toSet(values)] as const),
  );
  /** Cheap pre-filter: variant `k` beats a pair of `pairSpecificity` dimensions in the complete `context` (BR-4). */
  const covers = (k: number, context: IntentContext, pairSpecificity: number) => {
    budget--;
    const when = whenSets[k];
    return (
      when !== undefined &&
      when.length > pairSpecificity &&
      when.every(([d, values]) => {
        const supplied = ownValue(context, d);
        return supplied !== undefined && intersects(values, Array.isArray(supplied) ? supplied : [supplied]);
      })
    );
  };
  /** Oracle: a complete, registry-valid context the clauses keep, which `resolveVariants` reads as a tie of the pair. */
  const ties = (context: IntentContext, i: number, j: number) => {
    budget -= all.length + 1;
    const resolution = resolveVariants(all, context);
    return (
      resolution.state === VariantResolutionState.Ambiguous &&
      resolution.variants.includes(all[i]) &&
      resolution.variants.includes(all[j]) &&
      evaluateContextConditions(clauses, context, () => undefined).state !== ContextMatchState.Excluded &&
      validateContext(context, dimensions).length === 0
    );
  };

  pairs: for (let j = 0; j < all.length; j++) {
    for (let i = 0; i < j; i++) {
      if (budget <= 0) break pairs;
      const a = liveWhen[i];
      const b = liveWhen[j];
      if (a === undefined || b === undefined || isDead(i) || isDead(j)) continue;
      const pairSpecificity = Object.keys(a).length;
      // Unequal specificity: the variant with more dimensions wins wherever both match.
      if (Object.keys(b).length !== pairSpecificity) continue;
      const sameSet = dimensionSetKey(a) === dimensionSetKey(b);
      // Same set intersecting on every dimension: `checkVariantOverlap` refuses it.
      if (sameSet && Object.keys(a).every((d) => intersects(toSet(a[d]), b[d]))) continue;
      const union = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      // Candidate context values per union dimension. A shared multi dimension holds a
      // shared value, or one value from each variant, so disjoint multi values can still both match.
      const options = union.map((d): (string | string[])[] => {
        const av = ownValue(a, d);
        const bv = ownValue(b, d);
        if (av === undefined || bv === undefined) return (av ?? bv ?? []).slice(0, MAX_OPTIONS_PER_DIMENSION);
        const out: (string | string[])[] = av.filter((v) => bv.includes(v)).slice(0, MAX_OPTIONS_PER_DIMENSION);
        if (!multi.has(d)) return out;
        for (const x of av) {
          for (const y of bv) {
            if (out.length >= MAX_OPTIONS_PER_DIMENSION) return out;
            if (y !== x) out.push([x, y]);
          }
        }
        return out;
      });
      // Every other variant dimension too, so the witness is complete: preferably a value
      // no variant lists, else each live registry value (the bounded search may then miss).
      const extra = variantDims.filter((d) => !union.includes(d));
      for (const d of extra) {
        const free = freeValue.get(d);
        options.push(
          free !== undefined
            ? [free]
            : (dimensions.find((dim) => dim.id === d && !dim.archived)?.values ?? [])
                .map((value) => value.id)
                .filter((v) => live(d, v).length > 0)
                .slice(0, MAX_OPTIONS_PER_DIMENSION),
        );
      }
      if (options.some((o) => o.length === 0)) continue;
      const keys = [...union, ...extra];
      let candidates: IntentContext[] = [{}];
      for (let n = 0; n < keys.length; n++) {
        const next: IntentContext[] = [];
        grow: for (const c of candidates) {
          for (const v of options[n]) {
            if (next.length >= MAX_CANDIDATE_CONTEXTS) break grow;
            budget--;
            next.push({ ...c, [keys[n]]: withRequired(keys[n], v) });
          }
        }
        candidates = next;
      }
      const witness = candidates.find(
        (c) => budget > 0 && !all.some((_, k) => k !== i && k !== j && covers(k, c, pairSpecificity)) && ties(c, i, j),
      );
      if (witness) hints.push({ kind: HintKind.AmbiguousVariants, variants: [i, j], context: witness });
    }
  }
  return hints;
}
