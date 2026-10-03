import { describe, expect, it } from 'vitest';
import { canonicalIntentJson } from './canonical-json.js';

describe('canonicalIntentJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalIntentJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('produces identical bytes regardless of construction order and drops undefined members', () => {
    expect(canonicalIntentJson({ x: 1, y: undefined, z: 2 })).toBe(canonicalIntentJson({ z: 2, x: 1 }));
  });
});
