import { describe, it, expect, afterEach } from 'vitest';
import { allowSourcesInGraph } from './source-flag.js';

describe('allowSourcesInGraph', () => {
  const ORIGINAL = process.env.ALLOW_SOURCES_IN_GRAPH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
    else process.env.ALLOW_SOURCES_IN_GRAPH = ORIGINAL;
  });

  it('defaults to false when unset (fail-closed)', () => {
    delete process.env.ALLOW_SOURCES_IN_GRAPH;
    expect(allowSourcesInGraph()).toBe(false);
  });

  it('is true only for "true" or "1"', () => {
    process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
    expect(allowSourcesInGraph()).toBe(true);
    process.env.ALLOW_SOURCES_IN_GRAPH = '1';
    expect(allowSourcesInGraph()).toBe(true);
  });

  it('is false for any other value (fail-closed)', () => {
    for (const v of ['false', 'yes', '0', 'TRUE', 'on', '']) {
      process.env.ALLOW_SOURCES_IN_GRAPH = v;
      expect(allowSourcesInGraph()).toBe(false);
    }
  });
});
