import { describe, expect, it } from 'vitest';
import { HintKind, detectMissingConditionHints, detectVariantHints } from './authoring-hints.js';
import {
  ConditionLevel,
  ContextMatchState,
  composeEffectiveConditions,
  evaluateContextConditions,
  evaluateEffectiveConditions,
  resolveVariants,
} from './context-conditions.js';
import { IntentDimensionSchema, TreeConditionsSchema } from './schema.js';
import type { ContextCondition, IntentDimension, RuleVariant } from './types.js';

const dimensions: IntentDimension[] = [
  {
    id: 'country',
    title: 'Country',
    multi: false,
    values: [
      { id: 'br', title: 'Brazil', aliases: ['Brazilian', 'Brasil', 'br', 'Brazil'] },
      { id: 'de', title: 'Germany' },
      { id: 'ua', title: 'Ukraine' },
      { id: 'us', title: 'United States' },
    ],
  },
  {
    id: 'product',
    title: 'Product',
    multi: true,
    values: [
      { id: 'shifts', title: 'Shifts', aliases: ['shift planning'] },
      { id: 'ta', title: 'Time & Attendance' },
    ],
  },
];

describe('detectMissingConditionHints (AC-3, BR-3, LIM-1)', () => {
  const text = 'Brazilian companies get overtime at 50%';

  it('hints a value named by an alias when no effective clause constrains its dimension', () => {
    expect(detectMissingConditionHints(text, dimensions, [])).toEqual([
      { kind: HintKind.MissingCondition, dimension: 'country', value: 'br', matched: 'Brazilian' },
    ]);
  });

  it('does not hint a dimension an effective clause constrains', () => {
    expect(detectMissingConditionHints(text, dimensions, [{ dimension: 'country', in: ['br'] }])).toEqual([]);
  });

  it('does not hint text that names no value', () => {
    expect(detectMissingConditionHints('Overtime starts after 40 hours', dimensions, [])).toEqual([]);
  });

  it('matches whole words only, ignoring case, with Unicode boundaries and phrases', () => {
    expect(detectMissingConditionHints('Take a break before the BR shift', dimensions, [])).toEqual([
      { kind: HintKind.MissingCondition, dimension: 'country', value: 'br', matched: 'BR' },
    ]);
    expect(detectMissingConditionHints('Only take a break; brazilians excluded', dimensions, [])).toEqual([]);
    expect(detectMissingConditionHints('Válido no Brasil, sempre', dimensions, [])[0]?.matched).toBe('Brasil');
    expect(detectMissingConditionHints('éBrasil', dimensions, [])).toEqual([]);
    expect(detectMissingConditionHints('Uses Shift  Planning daily', dimensions, [])).toEqual([
      { kind: HintKind.MissingCondition, dimension: 'product', value: 'shifts', matched: 'Shift  Planning' },
    ]);
  });

  it('does not match bare value ids and emits one hint per value', () => {
    expect(detectMissingConditionHints('Let us see', dimensions, [])).toEqual([]);
    expect(
      detectMissingConditionHints('Brazil and Brasil: Brazilian rules', dimensions, []).map((h) => h.value),
    ).toEqual(['br']);
  });
});

describe('detectMissingConditionHints aliases replace the title', () => {
  const scope = (aliases?: string[]): IntentDimension[] => [
    { id: 'module', title: 'Module', multi: false, values: [{ id: 'project', title: 'Project', aliases }] },
  ];

  it('matches only aliases when a value declares them, never its title', () => {
    expect(detectMissingConditionHints('the project deadline', scope(['Project module']), [])).toEqual([]);
    expect(detectMissingConditionHints('the Project module', scope(['Project module']), [])).toEqual([
      { kind: HintKind.MissingCondition, dimension: 'module', value: 'project', matched: 'Project module' },
    ]);
  });

  // Changed 2026-09-28 after the pilot emulation: 91 of 94 hints on 109 real items were
  // title fallbacks ("Absence Policies admin", "Enabled"), so a title never names a value.
  it('never hints a value without aliases, and never one with empty aliases', () => {
    expect(IntentDimensionSchema.safeParse(scope([])[0]).success).toBe(true);
    expect(detectMissingConditionHints('the Project module', scope([]), [])).toEqual([]);
    expect(detectMissingConditionHints('the project deadline', scope(), [])).toEqual([]);
    expect(detectMissingConditionHints('Germany caps the week at 40h', dimensions, [])).toEqual([]);
  });
});

describe('detectMissingConditionHints skips negated mentions', () => {
  it.each([
    'Existing pay policies of non-Brazilian companies keep the old calculation',
    'Applies to non Brazilian companies',
    'Companies not in Brazil use the weekly trigger',
    'Every company without a Brazilian configuration can choose',
    'Outside Brazil the option is hidden',
    'All countries except Brazil',
    'Offered to countries other than Brazil',
  ])('%s', (text) => {
    expect(detectMissingConditionHints(text, dimensions, [])).toEqual([]);
  });

  it('still hints a later plain mention after a negated one', () => {
    expect(
      detectMissingConditionHints('Unlike non-Brazilian policies, Brazilian ones lose the rest pay', dimensions, []),
    ).toEqual([{ kind: HintKind.MissingCondition, dimension: 'country', value: 'br', matched: 'Brazilian' }]);
  });

  it('scans 16KB+ of negated mentions in linear time and hints nothing', () => {
    const foo: IntentDimension[] = [
      { id: 'thing', title: 'Thing', multi: false, values: [{ id: 'foo', title: 'Foo', aliases: ['foo'] }] },
    ];
    const text = 'non-foo '.repeat(4096);
    const started = performance.now();
    expect(detectMissingConditionHints(text, foo, [])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('does not treat a negation further back in the sentence as negating the mention', () => {
    expect(detectMissingConditionHints('Not only Brazilian companies are affected', dimensions, [])).toHaveLength(1);
  });
});

/** Every ambiguity hint must carry a complete witness `resolveVariants` reads as a tie of exactly that pair. */
function verifiedVariantHints(...args: Parameters<typeof detectVariantHints>) {
  const hints = detectVariantHints(...args);
  const all = args[0] ?? [];
  for (const hint of hints) {
    if (hint.kind !== HintKind.AmbiguousVariants) continue;
    const resolution = resolveVariants(all, hint.context);
    expect(resolution.state).toBe('ambiguous');
    expect(resolution.variants).toEqual(expect.arrayContaining([all[hint.variants[0]], all[hint.variants[1]]]));
  }
  return hints;
}

describe('detectVariantHints (AC-7, BR-5)', () => {
  const pair: RuleVariant[] = [
    { when: { country: 'de' }, outcome: 'a' },
    { when: { product: 'shifts' }, outcome: 'b' },
    { outcome: 'default' },
  ];

  it('hints two variants over different dimension sets that both match one context', () => {
    expect(verifiedVariantHints(pair, [], dimensions)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { country: 'de', product: 'shifts' } },
    ]);
    expect(resolveVariants(pair, { country: 'de', product: 'shifts' }).state).toBe('ambiguous');
  });

  it('drops the hint once a variant covers the union', () => {
    const covered = [...pair, { when: { country: 'de', product: 'shifts' }, outcome: 'c' }];
    expect(verifiedVariantHints(covered, [], dimensions)).toEqual([]);
  });

  it('still hints a context the covering variant does not reach', () => {
    const variants: RuleVariant[] = [
      { when: { country: ['de', 'us'] }, outcome: 'a' },
      { when: { product: 'shifts' }, outcome: 'b' },
      { when: { country: 'de', product: 'shifts' }, outcome: 'c' },
    ];
    expect(verifiedVariantHints(variants, [], dimensions)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { country: 'us', product: 'shifts' } },
    ]);
  });

  it('does not hint a variant pair where one is strictly more specific', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de' }, outcome: 'a' },
      { when: { country: 'de', product: 'shifts' }, outcome: 'b' },
    ];
    expect(verifiedVariantHints(variants, [], dimensions)).toEqual([]);
  });

  it('hints two same-set variants whose values differ only on a multi dimension', () => {
    const variants: RuleVariant[] = [
      { when: { product: 'ta' }, outcome: 'a' },
      { when: { product: 'shifts' }, outcome: 'b' },
    ];
    expect(verifiedVariantHints(variants, [], dimensions)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { product: ['ta', 'shifts'] } },
    ]);
    expect(resolveVariants(variants, { product: ['ta', 'shifts'] }).state).toBe('ambiguous');
    // A more specific variant settles only the contexts that also match its extra dimension.
    const covered = [...variants, { when: { product: ['ta', 'shifts'], country: 'de' }, outcome: 'c' }];
    expect(verifiedVariantHints(covered, [], dimensions)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { country: 'br', product: ['ta', 'shifts'] } },
    ]);
    expect(resolveVariants(covered, { country: 'br', product: ['ta', 'shifts'] }).state).toBe('ambiguous');
    // A same-set pair disjoint on a single-value dimension can never both match.
    const single: RuleVariant[] = [
      { when: { country: 'de', product: 'ta' }, outcome: 'a' },
      { when: { country: 'us', product: 'shifts' }, outcome: 'b' },
    ];
    expect(verifiedVariantHints(single, [], dimensions)).toEqual([]);
  });

  it('searches value combinations on a shared multi dimension, not only the first values', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de', product: ['ta', 'shifts'] }, outcome: 'a' },
      { when: { plan: 'pro', product: ['ta', 'shifts'] }, outcome: 'b' },
      // Covers every context holding `ta`; `shifts` alone stays ambiguous.
      { when: { country: 'de', plan: 'pro', product: 'ta' }, outcome: 'c' },
    ];
    const withPlan: IntentDimension[] = [
      ...dimensions,
      { id: 'plan', title: 'Plan', multi: false, values: [{ id: 'pro', title: 'Pro' }] },
    ];
    expect(verifiedVariantHints(variants, [], withPlan)).toEqual([
      {
        kind: HintKind.AmbiguousVariants,
        variants: [0, 1],
        context: { country: 'de', product: 'shifts', plan: 'pro' },
      },
    ]);
  });

  it('never hints a pair of unequal specificity: the one with more dimensions wins (BR-4)', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de', plan: 'pro' }, outcome: 'a' },
      { when: { product: 'shifts' }, outcome: 'b' },
    ];
    const withPlan: IntentDimension[] = [
      ...dimensions,
      { id: 'plan', title: 'Plan', multi: false, values: [{ id: 'pro', title: 'Pro' }] },
    ];
    expect(verifiedVariantHints(variants, [], withPlan)).toEqual([]);
    expect(resolveVariants(variants, { country: 'de', plan: 'pro', product: 'shifts' }).state).toBe('resolved');
  });

  describe('a more specific variant with a dimension outside the pair', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de' }, outcome: 'a' },
      { when: { product: 'shifts' }, outcome: 'b' },
      { when: { country: 'de', product: 'shifts', plan: 'pro' }, outcome: 'c' },
    ];
    const withPlan = (values: string[]): IntentDimension[] => [
      ...dimensions,
      { id: 'plan', title: 'Plan', multi: false, values: values.map((id) => ({ id, title: id })) },
    ];

    it('does not cover the pair: a context off its extra value ties', () => {
      const [hint, ...rest] = verifiedVariantHints(variants, [], withPlan(['pro', 'basic']));
      expect(rest).toEqual([]);
      expect(hint).toEqual({
        kind: HintKind.AmbiguousVariants,
        variants: [0, 1],
        context: { plan: 'basic', country: 'de', product: 'shifts' },
      });
      if (hint?.kind !== HintKind.AmbiguousVariants) throw new Error('expected an ambiguity hint');
      expect(resolveVariants(variants, hint.context)).toEqual({
        state: 'ambiguous',
        variants: [variants[0], variants[1]],
        open: [],
      });
    });

    it('does not hint when completing the context with the only plan value selects the specific variant', () => {
      expect(verifiedVariantHints(variants, [], withPlan(['pro']))).toEqual([]);
      expect(resolveVariants(variants, { country: 'de', product: 'shifts', plan: 'pro' }).state).toBe('resolved');
    });
  });

  it('reads only own properties of a variant `when`, so a `constructor` dimension works', () => {
    const withCtor: IntentDimension[] = [
      ...dimensions,
      { id: 'constructor', title: 'Ctor', multi: false, values: [{ id: 'x', title: 'x' }] },
    ];
    const variants: RuleVariant[] = [
      { when: { constructor: 'x' }, outcome: 'a' },
      { when: { product: 'shifts' }, outcome: 'b' },
    ];
    expect(verifiedVariantHints(variants, [], withCtor)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { constructor: 'x', product: 'shifts' } },
    ]);
    expect(resolveVariants(variants, { constructor: 'x', product: 'shifts' }).state).toBe('ambiguous');
  });

  it('finishes a max-size rule fast, within its work budget, without throwing', () => {
    const ids = Array.from({ length: 50 }, (_, n) => `v${n}`);
    const wide: IntentDimension[] = ['x', 'y', 'z'].map((id) => ({
      id,
      title: id,
      multi: true,
      values: ids.map((v) => ({ id: v, title: v })),
    }));
    const sets = [
      ['x', 'y'],
      ['y', 'z'],
      ['x', 'z'],
      ['x', 'y', 'z'],
    ];
    const variants: RuleVariant[] = Array.from({ length: 50 }, (_, n) => ({
      when: Object.fromEntries(sets[n % sets.length].map((d) => [d, n % 2 === 0 ? ids : ids.slice(0, 25)])),
      outcome: `o${n}`,
    }));
    const started = performance.now();
    const hints = verifiedVariantHints(variants, [], wide);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Array.isArray(hints)).toBe(true);
  });

  it('hints a dead variant excluded by the effective clauses', () => {
    const variants: RuleVariant[] = [{ when: { country: 'ua' }, outcome: 'a' }, { outcome: 'default' }];
    expect(verifiedVariantHints(variants, [{ dimension: 'country', notIn: ['ua'] }], dimensions)).toEqual([
      { kind: HintKind.DeadVariant, variant: 0 },
    ]);
    expect(
      verifiedVariantHints(
        [{ when: { country: 'us' }, outcome: 'a' }],
        [{ dimension: 'country', in: ['br'] }],
        dimensions,
      ),
    ).toEqual([{ kind: HintKind.DeadVariant, variant: 0 }]);
  });

  it('adds the value an `in` clause on a multi dimension requires to the witness', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de' }, outcome: 'a' },
      { when: { product: 'ta' }, outcome: 'b' },
    ];
    expect(verifiedVariantHints(variants, [{ dimension: 'product', in: ['shifts'] }], dimensions)).toEqual([
      { kind: HintKind.AmbiguousVariants, variants: [0, 1], context: { country: 'de', product: ['ta', 'shifts'] } },
    ]);
  });

  it('does not treat an `in` clause on a multi dimension as killing a variant', () => {
    expect(
      verifiedVariantHints(
        [{ when: { product: 'ta' }, outcome: 'a' }],
        [{ dimension: 'product', in: ['shifts'] }],
        dimensions,
      ),
    ).toEqual([]);
  });
});

describe('evaluateEffectiveConditions (BR-1)', () => {
  const domain: ContextCondition[] = [{ dimension: 'product', in: ['shifts'] }];
  const feature: ContextCondition[] = [{ dimension: 'country', notIn: ['ua'] }];
  const item: ContextCondition[] = [{ dimension: 'country', in: ['de'] }];
  const noItems = () => undefined;

  it('ANDs the levels and names the outermost excluding level', () => {
    expect(evaluateEffectiveConditions({ domain, feature, item }, { product: ['ta'], country: 'ua' }, noItems)).toEqual(
      {
        state: ContextMatchState.Excluded,
        open: [],
        reasons: [],
        decidedBy: ConditionLevel.Domain,
      },
    );
    expect(
      evaluateEffectiveConditions({ domain, feature, item }, { product: ['shifts'], country: 'ua' }, noItems).decidedBy,
    ).toBe(ConditionLevel.Feature);
    expect(
      evaluateEffectiveConditions({ domain, feature, item }, { product: ['shifts'], country: 'pl' }, noItems).decidedBy,
    ).toBe(ConditionLevel.Item);
    expect(
      evaluateEffectiveConditions({ domain, feature, item }, { product: ['ta', 'shifts'], country: 'de' }, noItems),
    ).toEqual({ state: ContextMatchState.Match, open: [], reasons: [] });
  });

  it('reports the levels that left dimensions open', () => {
    expect(evaluateEffectiveConditions({ domain, feature, item }, {}, noItems)).toEqual({
      state: ContextMatchState.Open,
      open: ['product', 'country'],
      reasons: [],
      openBy: [ConditionLevel.Domain, ConditionLevel.Feature, ConditionLevel.Item],
    });
  });

  it('matches evaluateContextConditions on the item alone', () => {
    const ctx = { country: 'pl' };
    expect(evaluateEffectiveConditions({ item }, ctx, noItems)).toEqual({
      ...evaluateContextConditions(item, ctx, noItems),
      decidedBy: ConditionLevel.Item,
    });
    expect(composeEffectiveConditions({ item, domain })).toEqual([...domain, ...item]);
  });
});

describe('tree conditions and aliases schema', () => {
  it('accepts dimension clauses and an empty list, rejects item and text clauses', () => {
    expect(TreeConditionsSchema.safeParse([]).success).toBe(true);
    expect(TreeConditionsSchema.safeParse([{ dimension: 'country', in: ['br'] }]).success).toBe(true);
    expect(TreeConditionsSchema.safeParse([{ item: 'br-x' }]).success).toBe(false);
    expect(TreeConditionsSchema.safeParse([{ text: 'only on weekends' }]).success).toBe(false);
  });

  it('bounds aliases', () => {
    const dim = (aliases: string[]) => ({ id: 'c', title: 'C', values: [{ id: 'br', title: 'Brazil', aliases }] });
    expect(IntentDimensionSchema.safeParse(dim(['Brasil'])).success).toBe(true);
    expect(IntentDimensionSchema.safeParse(dim([''])).success).toBe(false);
    expect(IntentDimensionSchema.safeParse(dim(Array.from({ length: 11 }, (_, i) => `a${i}`))).success).toBe(false);
  });
});
