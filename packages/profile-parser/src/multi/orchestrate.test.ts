import type { ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
// Barrel import first: registers the built-in providers before we add fakes.
import { registerLanguage } from '../providers/index.js';
import type { LanguageProvider, ParseOptions } from '../providers/types.js';
import type { BaseProfile } from '../types/profile-base.js';
import type { MultiTargetProfile } from '../types/multi-profile.js';
import { parseMultiTarget } from './orchestrate.js';

function makeRepo(over: Partial<ParsedRepo>): ParsedRepo {
  return {
    id: 'rh:repo:acme',
    name: 'acme',
    path: '/acme',
    parsedAt: '2026-07-16T00:00:00.000Z',
    parserVersion: '1.0.0',
    parserId: 'acme',
    packages: [],
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      skippedFiles: 0,
      totalFunctions: 0,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 0,
    },
    ...over,
  };
}

/** Fake language provider that records every ParseOptions it received. */
function fakeProvider(language: string, repo: ParsedRepo, seen: ParseOptions[]): LanguageProvider {
  return {
    language,
    discovery: { extensions: [`.${language}`] },
    isProfile: (v): v is BaseProfile =>
      typeof v === 'object' && v !== null && (v as BaseProfile).substrate?.language === language,
    sourceFiles: () => ({ included: [], excluded: [], profileExcluded: [] }),
    parse: async (_profile, opts) => {
      seen.push(opts);
      return repo;
    },
    sourceSignals: () => ({ http: 0, entities: 0 }),
  };
}

describe('parseMultiTarget', () => {
  it('parses every target with its provider and merges the results', async () => {
    const seenA: ParseOptions[] = [];
    const seenB: ParseOptions[] = [];
    registerLanguage(fakeProvider('fake-a', makeRepo({ functions: [{ id: 'fnA' } as never] }), seenA));
    registerLanguage(fakeProvider('fake-b', makeRepo({ functions: [{ id: 'fnB' } as never] }), seenB));
    const profile: MultiTargetProfile = {
      parserId: 'acme',
      repoType: 'monorepo',
      targets: [
        { name: 'a', substrate: { language: 'fake-a', include: [] } } as never,
        { name: 'b', substrate: { language: 'fake-b', include: [] } } as never,
      ],
    };
    const merged = await parseMultiTarget(profile, {
      repoRoot: '/acme',
      repoName: 'acme',
      repoKey: 'k',
    });
    expect(merged.functions.map((f) => f.id)).toEqual(['fnA', 'fnB']);
    expect(merged.type).toBe('monorepo');
    // Shared identity.
    expect(seenA[0].repoKey).toBe('k');
    expect(seenB[0].repoKey).toBe('k');
  });
});
