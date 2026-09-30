import { describe, expect, it } from 'vitest';
import { ByteMultiPatternMatcher } from './multi-pattern.js';

describe('ByteMultiPatternMatcher', () => {
  it('scans realistic multi-megabyte chunks against ten thousand patterns and preserves chunk-boundary state', () => {
    const patterns = Array.from({ length: 10_000 }, (_, index) =>
      Buffer.from(`SOURCE_CANARY_${index.toString().padStart(5, '0')}_${index.toString(16).padStart(24, 'a')}`),
    );
    const matcher = new ByteMultiPatternMatcher(patterns);
    const clean = Buffer.alloc(2 * 1024 * 1024, 'x');

    expect(matcher.push(clean.subarray(0, 1024 * 1024))).toBe(false);
    expect(matcher.push(clean.subarray(1024 * 1024))).toBe(false);

    matcher.reset();
    const needle = patterns.at(-1)!;
    expect(matcher.push(needle.subarray(0, 11))).toBe(false);
    expect(matcher.push(needle.subarray(11))).toBe(true);
  });
});
