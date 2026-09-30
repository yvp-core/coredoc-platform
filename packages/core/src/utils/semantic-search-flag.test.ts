import { describe, it, expect, afterEach } from 'vitest';
import { semanticSearchEnabled } from './semantic-search-flag.js';

describe('semanticSearchEnabled', () => {
  const ORIGINAL = process.env.ENABLE_SEMANTIC_SEARCH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ENABLE_SEMANTIC_SEARCH;
    else process.env.ENABLE_SEMANTIC_SEARCH = ORIGINAL;
  });

  it('defaults to false when unset (fail-closed)', () => {
    delete process.env.ENABLE_SEMANTIC_SEARCH;
    expect(semanticSearchEnabled()).toBe(false);
  });

  it('is true only for "true" or "1"', () => {
    process.env.ENABLE_SEMANTIC_SEARCH = 'true';
    expect(semanticSearchEnabled()).toBe(true);
    process.env.ENABLE_SEMANTIC_SEARCH = '1';
    expect(semanticSearchEnabled()).toBe(true);
  });

  it('is false for any other value (fail-closed)', () => {
    for (const v of ['false', 'yes', '0', 'TRUE', 'on', '']) {
      process.env.ENABLE_SEMANTIC_SEARCH = v;
      expect(semanticSearchEnabled()).toBe(false);
    }
  });
});
