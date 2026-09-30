import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPH_FILE_ENGINE_VERSION, GRAPH_FILE_FORMAT_COMPATIBILITY, heritageIdentityIsVerifiable } from './index.js';

describe('graph file compatibility identity', () => {
  it('matches the exact Ladybug runtime dependency and ignores environment overrides', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies['@ladybugdb/core']).toBe(GRAPH_FILE_ENGINE_VERSION);

    const previous = process.env.GRAPH_FILE_STORAGE_FORMAT_VERSION;
    process.env.GRAPH_FILE_STORAGE_FORMAT_VERSION = '999';
    try {
      expect(GRAPH_FILE_FORMAT_COMPATIBILITY.storageFormatVersion).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.GRAPH_FILE_STORAGE_FORMAT_VERSION;
      else process.env.GRAPH_FILE_STORAGE_FORMAT_VERSION = previous;
    }
  });

  it('carries a builder version distinct from the pre-reinterpretation one', () => {
    // The payload changed shape and — for heritage `ambiguous` — MEANING. A reader that cannot
    // tell phase3 from phase4 asserts verified identity for stale name matches.
    expect(GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion).not.toBe('phase3-v1');
  });
});

describe('heritageIdentityIsVerifiable', () => {
  it('accepts the builder that writes the current heritage semantics', () => {
    expect(heritageIdentityIsVerifiable(GRAPH_FILE_FORMAT_COMPATIBILITY.builderVersion)).toBe(true);
  });

  it('refuses pre-bump builders, where ambiguous:false meant only a unique name match', () => {
    expect(heritageIdentityIsVerifiable('phase3-v1')).toBe(false);
    expect(heritageIdentityIsVerifiable('phase2-v1')).toBe(false);
  });

  it('refuses an unknown or absent vintage rather than assuming the current one', () => {
    expect(heritageIdentityIsVerifiable(undefined)).toBe(false);
    expect(heritageIdentityIsVerifiable(null)).toBe(false);
    expect(heritageIdentityIsVerifiable('')).toBe(false);
    expect(heritageIdentityIsVerifiable('phase99-v1')).toBe(false);
  });
});
