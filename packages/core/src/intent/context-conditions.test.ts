import { describe, expect, it } from 'vitest';
import {
  ConditionReasonCode,
  ContextMatchState,
  RegistryIssueCode,
  VariantIssueCode,
  VariantResolutionState,
  checkVariantOverlap,
  evaluateContextConditions,
  resolveVariants,
  validateAgainstRegistry,
  validateContext,
  type ConditionItemLookup,
} from './context-conditions.js';
import {
  ContextConditionsSchema,
  IntentContextSchema,
  IntentDimensionSchema,
  validateIntentPayload,
} from './schema.js';
import { type ContextCondition, IntentAuthority, type IntentDimension, IntentKind, type RuleVariant } from './types.js';

const noItems: ConditionItemLookup = () => undefined;

const dimensions: IntentDimension[] = [
  { id: 'country', title: 'Country', multi: false, values: ['de', 'pl', 'ua'].map((id) => ({ id, title: id })) },
  { id: 'plan', title: 'Plan', multi: false, values: [{ id: 'pro', title: 'Pro' }] },
  {
    id: 'product',
    title: 'Product',
    multi: true,
    values: ['ta', 'project', 'shifts'].map((id) => ({ id, title: id })),
  },
  { id: 'legacy', title: 'Legacy', multi: false, archived: true, values: [{ id: 'x', title: 'x' }] },
];

// The spec's pilot shape: br-weekly-overtime-threshold.
const overtimeConditions: ContextCondition[] = [{ dimension: 'country', notIn: ['ua'] }];
const overtimeVariants: RuleVariant[] = [
  { when: { country: 'de' }, outcome: '40h' },
  { outcome: 'contractHoursPerWeek × 1.1, capped at 48h', inputs: ['contractHoursPerWeek'] },
];

describe('pilot overtime rule (AC-2)', () => {
  it('de resolves the 40h variant', () => {
    expect(evaluateContextConditions(overtimeConditions, { country: 'de' }, noItems).state).toBe(
      ContextMatchState.Match,
    );
    expect(resolveVariants(overtimeVariants, { country: 'de' })).toEqual({
      state: VariantResolutionState.Resolved,
      variants: [overtimeVariants[0]],
      open: [],
    });
  });

  it('pl falls back to the default formula with its inputs', () => {
    const resolution = resolveVariants(overtimeVariants, { country: 'pl' });
    expect(resolution.state).toBe(VariantResolutionState.Default);
    expect(resolution.variants).toEqual([overtimeVariants[1]]);
    expect(resolution.variants[0]?.inputs).toEqual(['contractHoursPerWeek']);
  });

  it('ua is excluded by notIn', () => {
    expect(evaluateContextConditions(overtimeConditions, { country: 'ua' }, noItems).state).toBe(
      ContextMatchState.Excluded,
    );
  });

  it('is valid against the registry and has no overlap', () => {
    expect(validateAgainstRegistry(overtimeConditions, overtimeVariants, dimensions)).toEqual([]);
    expect(checkVariantOverlap(overtimeVariants)).toEqual([]);
    expect(
      validateIntentPayload(IntentKind.BusinessRule, {
        condition: 'Weekly worked hours exceed the threshold',
        requiredOutcome: 'Hours above the threshold count as overtime',
        observer: 'Payroll export',
        variants: overtimeVariants,
      }),
    ).toEqual([]);
  });
});

describe('evaluateContextConditions', () => {
  it('reports an absent dimension as open (AC-3)', () => {
    expect(evaluateContextConditions([{ dimension: 'plan', in: ['pro'] }], { country: 'de' }, noItems)).toEqual({
      state: ContextMatchState.Open,
      open: ['plan'],
      reasons: [],
    });
  });

  it('treats a missing appliesWhen as unconditional', () => {
    expect(evaluateContextConditions(undefined, {}, noItems).state).toBe(ContextMatchState.Match);
  });

  it('matches multi-value contexts by intersection (AC-10)', () => {
    const shifts: ContextCondition[] = [{ dimension: 'product', in: ['shifts'] }];
    expect(evaluateContextConditions(shifts, { product: ['ta', 'shifts'] }, noItems).state).toBe(
      ContextMatchState.Match,
    );
    expect(evaluateContextConditions(shifts, { product: ['ta'] }, noItems).state).toBe(ContextMatchState.Excluded);
    const both: ContextCondition[] = [
      { dimension: 'product', in: ['ta'] },
      { dimension: 'product', in: ['shifts'] },
    ];
    expect(evaluateContextConditions(both, { product: ['shifts'] }, noItems).state).toBe(ContextMatchState.Excluded);
  });

  it('never evaluates a text clause (AC-4)', () => {
    expect(evaluateContextConditions([{ text: 'Only during onboarding' }], {}, noItems)).toEqual({
      state: ContextMatchState.Unevaluated,
      open: [],
      reasons: [{ clause: 0, code: ConditionReasonCode.TextCondition }],
    });
  });

  it('marks an item clause to a superseded, rejected, or missing item unevaluated (AC-4)', () => {
    const lookup: ConditionItemLookup = (id) =>
      id === 'cap-old'
        ? { authority: IntentAuthority.Superseded }
        : id === 'cap-no'
          ? { authority: IntentAuthority.Rejected }
          : undefined;
    const result = evaluateContextConditions(
      [{ item: 'cap-old' }, { item: 'cap-no' }, { item: 'cap-gone' }],
      {},
      lookup,
    );
    expect(result.state).toBe(ContextMatchState.Unevaluated);
    expect(result.reasons).toEqual([
      { clause: 0, code: ConditionReasonCode.ItemSuperseded, item: 'cap-old' },
      { clause: 1, code: ConditionReasonCode.ItemRejected, item: 'cap-no' },
      { clause: 2, code: ConditionReasonCode.ItemNotFound, item: 'cap-gone' },
    ]);
  });

  it('never lets an unreviewed candidate filter another item', () => {
    const lookup: ConditionItemLookup = () => ({
      authority: IntentAuthority.Candidate,
      appliesWhen: [{ dimension: 'country', in: ['br'] }],
    });
    expect(evaluateContextConditions([{ item: 'cap-draft' }], { country: 'us' }, lookup)).toEqual({
      state: ContextMatchState.Unevaluated,
      open: [],
      reasons: [{ clause: 0, code: ConditionReasonCode.ItemNotAccepted, item: 'cap-draft' }],
    });
  });

  it("evaluates a referenced item's dimension clauses one level deep", () => {
    const lookup: ConditionItemLookup = () => ({
      authority: IntentAuthority.Accepted,
      appliesWhen: [{ dimension: 'product', in: ['shifts'] }, { dimension: 'plan', in: ['pro'] }, { item: 'cap-x' }],
    });
    expect(evaluateContextConditions([{ item: 'cap-shifts' }], { product: ['ta'] }, lookup).state).toBe(
      ContextMatchState.Excluded,
    );
    // Unevaluated outranks open; both are reported.
    expect(evaluateContextConditions([{ item: 'cap-shifts' }], { product: ['shifts'] }, lookup)).toEqual({
      state: ContextMatchState.Unevaluated,
      open: ['plan'],
      reasons: [{ clause: 0, code: ConditionReasonCode.NestedItemCondition, item: 'cap-shifts' }],
    });
  });
});

describe('resolveVariants', () => {
  it('returns every top-specificity match as ambiguous (AC-10)', () => {
    const variants: RuleVariant[] = [
      { when: { product: 'ta' }, outcome: 'A' },
      { when: { product: 'shifts' }, outcome: 'B' },
    ];
    expect(resolveVariants(variants, { product: ['ta', 'shifts'] })).toEqual({
      state: VariantResolutionState.Ambiguous,
      variants,
      open: [],
    });
  });

  it('prefers the more specific match', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de' }, outcome: 'A' },
      { when: { country: 'de', plan: 'pro' }, outcome: 'B' },
    ];
    expect(resolveVariants(variants, { country: 'de', plan: 'pro' }).variants).toEqual([variants[1]]);
  });

  it('falls back to the base requiredOutcome without a match or default', () => {
    expect(resolveVariants([{ when: { country: 'de' }, outcome: 'A' }], { country: 'pl' }).state).toBe(
      VariantResolutionState.Base,
    );
  });

  it('returns matching-or-open variants with open dimensions', () => {
    const variants: RuleVariant[] = [
      { when: { country: 'de', plan: 'pro' }, outcome: 'A' },
      { when: { country: 'pl' }, outcome: 'B' },
      { outcome: 'C' },
    ];
    expect(resolveVariants(variants, { country: 'de' })).toEqual({
      state: VariantResolutionState.Open,
      variants: [variants[0], variants[2]],
      open: ['plan'],
    });
  });
});

describe('a dimension id that names a prototype member', () => {
  it('treats an absent `constructor` dimension as open, not supplied', () => {
    expect(evaluateContextConditions([{ dimension: 'constructor', in: ['x'] }], {}, noItems)).toEqual({
      state: ContextMatchState.Open,
      open: ['constructor'],
      reasons: [],
    });
    const variants: RuleVariant[] = [{ when: { constructor: 'x' }, outcome: 'A' }, { outcome: 'B' }];
    expect(resolveVariants(variants, {})).toEqual({
      state: VariantResolutionState.Open,
      variants,
      open: ['constructor'],
    });
    expect(resolveVariants(variants, { constructor: 'x' }).state).toBe(VariantResolutionState.Resolved);
  });
});

describe('checkVariantOverlap (BR-5)', () => {
  it('rejects intersecting variants over the same dimension set', () => {
    expect(
      checkVariantOverlap([
        { when: { country: ['de', 'pl'] }, outcome: 'A' },
        { when: { country: 'pl' }, outcome: 'B' },
        { when: { country: 'de', plan: 'pro' }, outcome: 'C' },
      ]),
    ).toEqual([{ code: VariantIssueCode.VariantOverlap, index: 1, otherIndex: 0 }]);
  });

  it('allows same dimension set when one dimension is disjoint', () => {
    expect(
      checkVariantOverlap([
        { when: { country: 'de', plan: 'pro' }, outcome: 'A' },
        { when: { plan: 'pro', country: 'pl' }, outcome: 'B' },
      ]),
    ).toEqual([]);
  });

  it('rejects a second default', () => {
    expect(checkVariantOverlap([{ outcome: 'A' }, { outcome: 'B' }])).toEqual([
      { code: VariantIssueCode.SecondDefault, index: 1, otherIndex: 0 },
    ]);
  });
});

describe('registry validation', () => {
  it('flags undeclared, archived, and unknown values', () => {
    expect(
      validateAgainstRegistry(
        [{ dimension: 'region', in: ['eu'] }, { dimension: 'legacy', in: ['x'] }, { text: 'free text' }],
        [{ when: { country: ['de', 'fr'] }, outcome: 'A' }],
        dimensions,
      ),
    ).toEqual([
      { code: RegistryIssueCode.DimensionNotFound, path: ['appliesWhen', 0, 'in'], dimension: 'region' },
      { code: RegistryIssueCode.DimensionNotFound, path: ['appliesWhen', 1, 'in'], dimension: 'legacy' },
      {
        code: RegistryIssueCode.DimensionValueNotFound,
        path: ['variants', 0, 'when', 'country'],
        dimension: 'country',
        value: 'fr',
      },
    ]);
  });

  it('rejects a list for a single-value dimension in a read context (AC-10)', () => {
    expect(validateContext({ country: ['de', 'pl'] }, dimensions)).toEqual([
      { code: RegistryIssueCode.DimensionNotMulti, path: ['context', 'country'], dimension: 'country' },
    ]);
    expect(validateContext({ country: 'de', product: ['ta', 'shifts'] }, dimensions)).toEqual([]);
  });
});

describe('schemas', () => {
  it('parse the new shapes strictly', () => {
    expect(
      IntentDimensionSchema.parse({ id: 'country', title: 'Country', values: [{ id: 'de', title: 'DE' }] }).multi,
    ).toBe(false);
    expect(ContextConditionsSchema.safeParse([{ dimension: 'country', in: ['de'], extra: 1 }]).success).toBe(false);
    expect(ContextConditionsSchema.safeParse([{ dimension: 'Country', in: ['de'] }]).success).toBe(false);
    expect(IntentContextSchema.safeParse({ product: [] }).success).toBe(true);
    expect(
      validateIntentPayload(IntentKind.BusinessRule, {
        condition: 'c',
        requiredOutcome: 'r',
        observer: 'o',
        variants: [{ when: {}, outcome: 'x' }],
      }),
    ).not.toEqual([]);
  });
});
