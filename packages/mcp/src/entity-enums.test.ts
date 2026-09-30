import { describe, it, expect } from 'vitest';
import { enumBaseId, enumValuesSuffix } from './entity-enums.js';

describe('enumBaseId', () => {
  it.each([
    ['WebhookStatus', 'WebhookStatus'],
    ['ShiftStatusEnum', 'ShiftStatusEnum'],
    ['WebhookStatus[]', 'WebhookStatus'], // array element
    ['EventType | null', 'EventType'], // nullable
    ['EventType | undefined', 'EventType'],
    ['string', null], // primitive (lowercase)
    ['unknown', null],
    ['number[]', null],
    ['A | B', null], // multi-type union, not a single enum
    ['Record<string, number>', null], // generic
    [undefined, null],
    ['', null],
  ])('extracts base id of %j → %j', (input, expected) => {
    expect(enumBaseId(input)).toBe(expected);
  });
});

describe('enumValuesSuffix', () => {
  it('renders the value list', () => {
    expect(
      enumValuesSuffix([
        { name: 'Active', value: 'active' },
        { name: 'Paused', value: 'paused' },
      ]),
    ).toBe(' {active, paused}');
  });
  it('falls back to the member name when no value', () => {
    expect(enumValuesSuffix([{ name: 'Draft' }])).toBe(' {Draft}');
  });
  it('caps long value lists with a +N more overflow', () => {
    const members = Array.from({ length: 15 }, (_, i) => ({ name: `M${i}`, value: `v${i}` }));
    const out = enumValuesSuffix(members);
    expect(out).toContain('v0, v1');
    expect(out).toContain('+3 more');
  });
  it('returns empty for no members', () => {
    expect(enumValuesSuffix([])).toBe('');
    expect(enumValuesSuffix(undefined)).toBe('');
  });
});
