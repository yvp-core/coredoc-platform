import { describe, it, expect } from 'vitest';
import { clampLimit } from './graph-query-defaults.js';

// Every backend routes caller-supplied limits through clampLimit, so its
// boundary behaviour is the shared contract the backends rely on.
describe('clampLimit', () => {
  it('caps at the maximum and falls back for non-positive / non-numeric input', () => {
    expect(clampLimit(5000)).toBe(1000);
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-1)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
  });

  it('floors fractional limits and honours custom maximum/fallback', () => {
    expect(clampLimit(10.9)).toBe(10);
    expect(clampLimit(5000, 200, 50)).toBe(200);
  });
});
