import { describe, expect, it } from 'vitest';
import { computeSparkline } from './Sparkline.js';

describe('computeSparkline', () => {
  it('returns null for fewer than two points', () => {
    expect(computeSparkline([])).toBeNull();
    expect(computeSparkline([7])).toBeNull();
  });

  it('produces a line path, a closed area path, and an end point', () => {
    const geo = computeSparkline([1, 4, 2, 8]);
    expect(geo).not.toBeNull();
    expect(geo!.line.startsWith('M')).toBe(true);
    expect(geo!.line).toContain('L');
    // area re-uses the line and closes back to the baseline
    expect(geo!.area.startsWith(geo!.line)).toBe(true);
    expect(geo!.area.endsWith('Z')).toBe(true);
  });

  it('anchors the first x at the left pad and the last at the right edge', () => {
    const geo = computeSparkline([3, 1, 5], 240, 34, 2)!;
    // first point x == pad
    expect(geo.line.startsWith('M2.0 ')).toBe(true);
    // end x == width - pad
    expect(geo.endX).toBeCloseTo(238, 5);
  });

  it('maps the max value to the top pad and the min to the bottom pad', () => {
    const geo = computeSparkline([0, 10], 240, 34, 2)!;
    // last value (10) is the max -> y at top pad
    expect(geo.endY).toBeCloseTo(2, 5);
  });

  it('produces finite coordinates for a flat series (no divide-by-zero)', () => {
    const geo = computeSparkline([5, 5, 5])!;
    expect(geo.line).not.toMatch(/NaN|Infinity/);
    expect(geo.area).not.toMatch(/NaN|Infinity/);
    expect(Number.isFinite(geo.endX)).toBe(true);
    expect(Number.isFinite(geo.endY)).toBe(true);
  });
});
