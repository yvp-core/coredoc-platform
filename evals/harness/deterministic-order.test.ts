import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from './deterministic-order.js';

describe('compareCodeUnits', () => {
  it('uses locale-independent UTF-16 code-unit order', () => {
    expect(['i', 'I', '\u0130', '\u0131'].sort(compareCodeUnits)).toEqual([
      'I',
      'i',
      '\u0130',
      '\u0131',
    ]);
  });
});
