/**
 * The presentation vocabulary: labels, marks and the two payload formatters.
 *
 * The payload formatters carry the rule that matters here — a payload is
 * optional and free-form on the wire (D9), so neither of them may assert a
 * kind-specific shape or throw on one it does not recognise.
 */

import { describe, expect, it } from 'vitest';
import { AuthoringHintKind, IntentAnchorStatus, IntentSnapshotFreshness } from '../../../shared/intent-types.js';
import { IntentItemScope } from './intent-panel-state';
import {
  anchorStatusMark,
  authoringHintText,
  contextConditionText,
  humanizeIntentKey,
  inheritedConditionGroups,
  inheritedConditionSourceLabel,
  intentDetailFields,
  intentFlowSteps,
  intentPayloadVariants,
  isUnevaluatedCondition,
  itemScopeLabel,
  snapshotFreshnessMark,
  variantWhenCell,
  variantWhenText,
} from './intent-presentation';

describe('itemScopeLabel', () => {
  it('says nothing for an item attached to the node already being read', () => {
    expect(itemScopeLabel(IntentItemScope.Attached)).toBeNull();
  });

  it('names the feature an item lives in, falling back when the title is unknown', () => {
    expect(itemScopeLabel(IntentItemScope.InFeature, 'Refunds')).toBe('in Refunds');
    expect(itemScopeLabel(IntentItemScope.InFeature, null)).toBe('in a feature');
  });

  it('distinguishes the two inheritance sources', () => {
    expect(itemScopeLabel(IntentItemScope.InheritedDomain)).toBe('inherited · domain');
    expect(itemScopeLabel(IntentItemScope.InheritedRoot)).toBe('inherited · product root');
  });
});

describe('anchor and snapshot marks', () => {
  it('keeps the two marks in the server’s own vocabulary', () => {
    expect(anchorStatusMark(IntentAnchorStatus.Changed)).toBe('anchor changed');
    expect(snapshotFreshnessMark(IntentSnapshotFreshness.Stale)).toBe('snapshot stale');
  });

  it('says "unevaluated"/"not reported" for an absent field — absence is not a verdict', () => {
    expect(anchorStatusMark(undefined)).toBe('anchor unevaluated');
    expect(snapshotFreshnessMark(undefined)).toBe('snapshot not reported');
  });
});

describe('humanizeIntentKey', () => {
  it('turns a payload key into a label', () => {
    expect(humanizeIntentKey('primaryActor')).toBe('Primary actor');
    expect(humanizeIntentKey('required_outcome')).toBe('Required outcome');
    expect(humanizeIntentKey('trigger')).toBe('Trigger');
  });
});

describe('intentDetailFields', () => {
  it('renders scalars and string lists, and leaves steps to the step renderer', () => {
    const fields = intentDetailFields({
      condition: 'older than 30 days',
      exceptions: ['fraud hold', 'manual override'],
      steps: [{ id: 'a' }],
    });
    expect(fields.map((field) => field.key)).toEqual(['condition', 'exceptions']);
    expect(fields[1]?.values).toEqual(['fraud hold', 'manual override']);
  });

  it('returns nothing for a payload that is not an object, rather than throwing', () => {
    expect(intentDetailFields(null)).toEqual([]);
    expect(intentDetailFields('a statement')).toEqual([]);
    expect(intentDetailFields([1, 2])).toEqual([]);
  });

  it('excludes variants (rendered as a table) the same way it excludes steps', () => {
    const fields = intentDetailFields({ condition: 'x', variants: [{ outcome: '40h' }] });
    expect(fields.map((field) => field.key)).toEqual(['condition']);
  });

  it('falls back to formatted JSON for a non-scalar value instead of dropping it (AC-8)', () => {
    const fields = intentDetailFields({
      mixedArray: ['a', { nested: true }],
      nestedObject: { region: 'EU' },
    });
    expect(fields.find((f) => f.key === 'mixedArray')?.value).toContain('"nested": true');
    expect(fields.find((f) => f.key === 'nestedObject')?.value).toContain('"region": "EU"');
  });
});

describe('contextConditionText and isUnevaluatedCondition (BR-1..BR-3)', () => {
  it('reads `in` and `notIn` clauses as plain sentences', () => {
    expect(contextConditionText({ dimension: 'country', in: ['de', 'pl'] })).toBe('country in de, pl');
    expect(contextConditionText({ dimension: 'country', notIn: ['ua'] })).toBe('country not in ua');
  });

  it('reads an `item` clause as "applies where X applies"', () => {
    expect(contextConditionText({ item: 'br-shift-planning' })).toBe('applies where br-shift-planning applies');
  });

  it('marks only a `text` clause as not machine-evaluated', () => {
    const text = { text: 'Only for legacy accounts' };
    expect(contextConditionText(text)).toBe('Only for legacy accounts');
    expect(isUnevaluatedCondition(text)).toBe(true);
    expect(isUnevaluatedCondition({ dimension: 'country', in: ['de'] })).toBe(false);
  });
});

describe('intentPayloadVariants and variantWhenText (worked example)', () => {
  const payload = {
    condition: 'Weekly worked hours exceed the threshold',
    variants: [
      { when: { country: 'de' }, outcome: '40h' },
      { outcome: 'contractHoursPerWeek × 1.1, capped at 48h', inputs: ['contractHoursPerWeek'] },
    ],
  };

  it('extracts each variant with its readable `when` and its inputs', () => {
    const variants = intentPayloadVariants(payload);
    expect(variants).toHaveLength(2);
    expect(variantWhenText(variants?.[0]?.when)).toBe('country = de');
    expect(variants?.[0]?.outcome).toBe('40h');
    expect(variantWhenText(variants?.[1]?.when)).toBe('default');
    expect(variants?.[1]?.inputs).toEqual(['contractHoursPerWeek']);
  });

  it('renders a multi-dimension `when` joined with "; " and "∈" for a list', () => {
    expect(variantWhenText({ country: 'de', product: ['ta', 'shifts'] })).toBe('country = de; product ∈ ta, shifts');
  });

  it('is null for a payload with no variants', () => {
    expect(intentPayloadVariants({ condition: 'x' })).toBeNull();
  });
});

describe('variantWhenCell (AC-8: no payload field is silently dropped)', () => {
  it('reads "default" only when `when` is absent on the raw variant', () => {
    const variants = intentPayloadVariants({ variants: [{ outcome: '40h' }] });
    expect(variantWhenCell(variants![0]!)).toBe('default');
  });

  it('shows the raw `when` as JSON, not "default", when every entry is malformed', () => {
    const variants = intentPayloadVariants({ variants: [{ when: { country: 5 }, outcome: '40h' }] });
    const cell = variantWhenCell(variants![0]!);
    expect(cell).not.toBe('default');
    expect(cell).toBe('{\n  "country": 5\n}');
  });

  it('shows raw JSON when sanitizing drops only some of the `when` entries', () => {
    const variants = intentPayloadVariants({ variants: [{ when: { country: 'de', product: 5 }, outcome: '40h' }] });
    const cell = variantWhenCell(variants![0]!);
    expect(cell).not.toBe('default');
    expect(cell).toBe('{\n  "country": "de",\n  "product": 5\n}');
  });

  it('reads the clean `when` normally when nothing was lost', () => {
    const variants = intentPayloadVariants({ variants: [{ when: { country: 'de' }, outcome: '40h' }] });
    expect(variantWhenCell(variants![0]!)).toBe('country = de');
  });

  it('shows raw "null", not "default", when `when` is present but null', () => {
    const variants = intentPayloadVariants({ variants: [{ when: null, outcome: '40h' }] });
    const cell = variantWhenCell(variants![0]!);
    expect(cell).not.toBe('default');
    expect(cell).toBe('null');
  });

  it('shows raw "{}", not "default", when `when` is present but empty', () => {
    const variants = intentPayloadVariants({ variants: [{ when: {}, outcome: '40h' }] });
    const cell = variantWhenCell(variants![0]!);
    expect(cell).not.toBe('default');
    expect(cell).toBe('{}');
  });
});

describe('intentDetailFields: unparsed variants (AC-8)', () => {
  it('emits a raw-JSON "Variants" field when every entry fails to parse', () => {
    const payload = { condition: 'x', variants: [{ when: { country: 'de' } }] }; // no outcome
    expect(intentPayloadVariants(payload)).toBeNull();
    const fields = intentDetailFields(payload);
    const variantsField = fields.find((f) => f.key === 'variants');
    expect(variantsField).toBeDefined();
    expect(variantsField!.label).toBe('Variants');
    expect(variantsField!.value).toContain('"country": "de"');
  });

  it('emits the raw-JSON "Variants" field alongside a partially valid table', () => {
    const payload = {
      variants: [{ outcome: '40h' }, { when: { country: 'de' } }], // second entry has no outcome
    };
    const parsed = intentPayloadVariants(payload);
    expect(parsed).toHaveLength(1);
    const fields = intentDetailFields(payload);
    expect(fields.find((f) => f.key === 'variants')).toBeDefined();
  });

  it('does not emit a "Variants" field when every entry parses', () => {
    const payload = { variants: [{ outcome: '40h' }] };
    const fields = intentDetailFields(payload);
    expect(fields.find((f) => f.key === 'variants')).toBeUndefined();
  });
});

describe('intentFlowSteps', () => {
  it('reads the steps a flow payload carries, branches included', () => {
    const steps = intentFlowSteps({
      steps: [
        {
          id: 'ask',
          actor: 'Customer',
          action: 'requests',
          outcome: 'a row exists',
          branches: [{ condition: 'too old', toStepId: 'refuse' }],
        },
      ],
    });
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.actor).toBe('Customer');
    expect(steps?.[0]?.branches).toEqual([{ condition: 'too old', toStepId: 'refuse' }]);
  });

  it('is null for every payload without a step list', () => {
    expect(intentFlowSteps({ condition: 'x' })).toBeNull();
    expect(intentFlowSteps(null)).toBeNull();
    expect(intentFlowSteps({ steps: [] })).toBeNull();
  });

  it('survives a step whose fields are missing or the wrong type', () => {
    const steps = intentFlowSteps({ steps: [{ actor: 12, branches: 'nope' }] });
    expect(steps?.[0]?.id).toBe('step-1');
    expect(steps?.[0]?.actor).toBe('12');
    expect(steps?.[0]?.branches).toEqual([]);
  });
});

describe('authoringHintText (intent-dimensions-inheritance BR-3, BR-5)', () => {
  it('renders a missing-condition hint naming the matched mention and the dimension value', () => {
    expect(
      authoringHintText({
        kind: AuthoringHintKind.MissingCondition,
        dimension: 'country',
        value: 'br',
        matched: 'Brazilian',
      }),
    ).toBe('Mentions “Brazilian” (country = br) but has no country condition');
  });

  it('renders an ambiguous-variants hint 1-based, with the shared context', () => {
    expect(
      authoringHintText({
        kind: AuthoringHintKind.AmbiguousVariants,
        variants: [0, 1],
        context: { country: 'de', product: 'shifts' },
      }),
    ).toBe('Variants 1 and 2 both match country = de; product = shifts — add a more specific variant');
  });

  it('renders a dead-variant hint 1-based', () => {
    expect(authoringHintText({ kind: AuthoringHintKind.DeadVariant, variant: 2 })).toBe(
      "Variant 3 can never apply under the item's conditions",
    );
  });

  it('renders an unaccepted condition-item hint naming the target', () => {
    expect(authoringHintText({ kind: AuthoringHintKind.UnacceptedConditionItem, item: 'cap-rest-pay' })).toBe(
      'Applies where cap-rest-pay applies, but cap-rest-pay is not accepted yet — until it is, this condition filters nothing',
    );
  });
});

describe('inheritedConditionGroups / inheritedConditionSourceLabel (UC-3)', () => {
  it('orders domain before feature and drops empty levels', () => {
    const groups = inheritedConditionGroups({
      domain: [{ dimension: 'product', in: ['shifts'] }],
      feature: [],
    });
    expect(groups).toEqual([{ source: 'domain', clauses: [{ dimension: 'product', in: ['shifts'] }] }]);
  });

  it('returns no groups when nothing is inherited', () => {
    expect(inheritedConditionGroups(undefined)).toEqual([]);
    expect(inheritedConditionGroups({})).toEqual([]);
  });

  it('labels a group by its source and the node id', () => {
    const group = { source: 'domain' as const, clauses: [{ dimension: 'product', in: ['shifts'] }] };
    expect(inheritedConditionSourceLabel(group, 'shifts', null)).toBe('from domain shifts');
    expect(inheritedConditionSourceLabel({ ...group, source: 'feature' }, 'shifts', 'overtime')).toBe(
      'from feature overtime',
    );
  });
});
