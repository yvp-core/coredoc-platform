import { describe, expect, it } from 'vitest';
import { parsePositiveIntegerFlag } from './cli-integers.js';

describe('parsePositiveIntegerFlag', () => {
  it('returns the fallback only when the flag is absent', () => {
    expect(parsePositiveIntegerFlag(undefined, '--runs', 3)).toBe(3);
    expect(parsePositiveIntegerFlag('4', '--runs', 3)).toBe(4);
  });

  it.each(['abc', '0', '-1', '1.5', 'Infinity', '1e3', '9007199254740992'])(
    'rejects invalid positive integer %s',
    (value) => {
      expect(() => parsePositiveIntegerFlag(value, '--runs', 3)).toThrow(
        `Invalid --runs "${value}": expected a positive integer.`,
      );
    },
  );
});
