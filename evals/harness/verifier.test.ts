import { describe, it, expect } from 'vitest';
import { f1, scoreFromExistence } from './verifier.js';

describe('verifier scoring math', () => {
  it('f1 is correct on overlapping sets', () => {
    const cited = ['a', 'b', 'c'];
    const truth = ['b', 'c', 'd'];
    const r = f1(cited, truth);
    expect(r.precision).toBeCloseTo(2 / 3);
    expect(r.recall).toBeCloseTo(2 / 3);
    expect(r.f1).toBeCloseTo(2 / 3);
  });

  it('f1 of empty cited is zero', () => {
    expect(f1([], ['a']).f1).toBe(0);
  });

  it('scoreFromExistence is the percentage of items that exist', () => {
    expect(scoreFromExistence([true, true, false, false])).toBe(50);
  });

  it('scoreFromExistence of empty is zero', () => {
    expect(scoreFromExistence([])).toBe(0);
  });
});
