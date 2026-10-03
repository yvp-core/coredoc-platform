/**
 * The presentation vocabulary: labels, marks and the payload formatters.
 *
 * The payload formatters carry the rule that matters here — a payload is
 * optional and free-form on the wire (D9), so none of them may assert a
 * kind-specific shape or throw on one it does not recognise. This is the
 * web mirror of the desktop suite of the same name; there was no web file
 * before (intent-dimensions spec, step 8).
 */

import { describe, expect, it } from 'vitest';
import {
  stripSourceRefs,
  canonicalPreviewContext,
  conditionChips,
  conditionDimensions,
  contextConditionText,
  contextMatchChip,
  humanizeIntentKey,
  inheritedConditionGroups,
  inheritedConditionSourceLabel,
  intentDetailFields,
  intentFlowSteps,
  intentPayloadVariants,
  isUnevaluatedCondition,
  variantWhenCell,
  variantWhenText,
} from './intent-presentation.js';
import { IntentContextMatchState, type IntentDimension } from './types.js';

describe('humanizeIntentKey', () => {
  it('spaces camelCase and snake_case keys alike', () => {
    expect(humanizeIntentKey('primaryActor')).toBe('Primary actor');
    expect(humanizeIntentKey('required_outcome')).toBe('Required outcome');
  });
});

describe('intentDetailFields', () => {
  it('renders scalar and all-scalar-array fields, dropping steps and variants', () => {
    const fields = intentDetailFields({
      condition: 'order older than 30 days',
      exceptions: ['fraud hold', 'chargeback open'],
      steps: [{ id: '1' }],
      variants: [{ outcome: '40h' }],
    });

    expect(fields.map((f) => f.key)).toEqual(['condition', 'exceptions']);
    expect(fields.find((f) => f.key === 'exceptions')?.values).toEqual(['fraud hold', 'chargeback open']);
  });

  it('falls back to formatted JSON for a non-scalar value instead of dropping it (AC-8)', () => {
    const fields = intentDetailFields({
      mixedArray: ['a', { nested: true }],
      nestedObject: { region: 'EU', tiers: ['a', 'b'] },
    });

    const mixed = fields.find((f) => f.key === 'mixedArray');
    const nested = fields.find((f) => f.key === 'nestedObject');
    expect(mixed?.value).toContain('"nested": true');
    expect(nested?.value).toContain('"region": "EU"');
  });
});

describe('intentFlowSteps', () => {
  it('is null for a payload that carries no step list', () => {
    expect(intentFlowSteps({ condition: 'x' })).toBeNull();
  });
});

describe('contextConditionText and isUnevaluatedCondition (BR-1..BR-3)', () => {
  it('reads an `in` clause and a `notIn` clause as plain sentences', () => {
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

  it('extracts each variant row with its readable `when` and its inputs', () => {
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

const REGISTRY: IntentDimension[] = [
  {
    id: 'country',
    title: 'Country',
    multi: false,
    values: [
      { id: 'br', title: 'BR' },
      { id: 'us', title: 'US' },
    ],
  },
  { id: 'plan', title: 'Plan', multi: false, values: [{ id: 'pro', title: 'Pro' }] },
];

describe('condition chips (browse rows)', () => {
  it('names own clauses by value title, then inherited, then the variant count', () => {
    expect(conditionChips({ own: [{ dimension: 'country', notIn: ['br'] }] }, REGISTRY)).toEqual(['not BR']);
    expect(conditionChips({ own: [{ dimension: 'country', in: ['br', 'us'] }] }, REGISTRY)).toEqual(['BR, US']);
    expect(conditionChips({ inherited: true }, REGISTRY)).toEqual(['inherited']);
    expect(conditionChips({ variants: 2 }, REGISTRY)).toEqual(['2 variants']);
    expect(
      conditionChips(
        {
          own: [
            { dimension: 'country', in: ['br'] },
            { dimension: 'plan', notIn: ['pro'] },
          ],
          inherited: true,
          variants: 1,
        },
        REGISTRY,
      ),
    ).toEqual(['BR · not Pro', 'inherited', '1 variant']);
  });

  it('is empty for an unconditioned row and falls back to ids off the registry', () => {
    expect(conditionChips(undefined, REGISTRY)).toEqual([]);
    expect(conditionChips({ own: [{ dimension: 'role', in: ['admin'] }] }, null)).toEqual(['admin']);
  });
});

describe('preview-as helpers', () => {
  it('marks only an open or unevaluated context match', () => {
    expect(contextMatchChip({ state: IntentContextMatchState.Open, open: ['country'] }, REGISTRY)).toBe(
      'depends on Country',
    );
    expect(contextMatchChip({ state: IntentContextMatchState.Unevaluated, open: [] }, REGISTRY)).toBe(
      'not machine-evaluated',
    );
    expect(contextMatchChip({ state: IntentContextMatchState.Match, open: [] }, REGISTRY)).toBeNull();
    expect(contextMatchChip(undefined, REGISTRY)).toBeNull();
  });

  it('serialises the choice canonically and keeps an explicit empty list', () => {
    expect(canonicalPreviewContext({})).toBeNull();
    expect(canonicalPreviewContext({ product: [] })).toBe('{"product":[]}');
    expect(canonicalPreviewContext({ product: ['ta', 'shifts'], country: 'br' })).toBe(
      '{"country":"br","product":["shifts","ta"]}',
    );
  });

  it('lists the dimensions a node condition uses, with value titles', () => {
    expect(
      conditionDimensions(
        [
          { dimension: 'country', notIn: ['br'] },
          { dimension: 'country', in: ['us', 'br'] },
        ],
        REGISTRY,
      ),
    ).toEqual([{ id: 'country', title: 'Country', values: ['BR', 'US'] }]);
  });
});

describe('stripSourceRefs', () => {
  it('drops ref groups with dates, across a line break, and keeps other parentheses', () => {
    expect(stripSourceRefs('Pay out. *(jira:ACME-304,\njira:ACME-305, 2025-05-07)*')).toBe('Pay out.');
    expect(stripSourceRefs('Opt in? *(jira:ACME-307, 2022-01-27; confluence:1000002, 2025-05-07)*')).toBe('Opt in?');
    expect(stripSourceRefs('Retries (Android up to 5 times) (br-limit).')).toBe(
      'Retries (Android up to 5 times) (br-limit).',
    );
  });

  it('drops a ref with locators, and keeps URLs, link targets and code fences', () => {
    expect(stripSourceRefs('Above pay rates. *(jira:ACME-306 Step 7, Visibility gate)* Next.')).toBe(
      'Above pay rates. Next.',
    );
    expect(stripSourceRefs('See [docs](https://wiki.example/x) (https://wiki.example/y).')).toBe(
      'See [docs](https://wiki.example/x) (https://wiki.example/y).',
    );
    const fenced = '```mermaid\nA --> B(db:read)\n```';
    expect(stripSourceRefs(`Flow *(jira:PROD-1)*\n${fenced}`)).toBe(`Flow\n${fenced}`);
  });
});
