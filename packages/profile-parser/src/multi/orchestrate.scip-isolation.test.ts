import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerLanguage } from '../providers/registry.js';
import type { LanguageProvider, ParseOptions } from '../providers/types.js';
import type { MultiTargetProfile } from '../types/multi-profile.js';
import { parseMultiTarget } from './orchestrate.js';

/** Targets resolve their providers through the registry, so the fakes have to be registered. */
const FAKE_LANGUAGES = ['scip-isolation-fixture-a', 'scip-isolation-fixture-b'] as const;

/**
 * Two targets of one MultiTargetProfile must never share a SCIP output directory.
 *
 * The per-project index filename is derived from the project path alone and carries no target
 * discriminator, and the indexer pool is async — so a shared directory lets one target's
 * pre-spawn `rmSync` land between another target's write and its decode, nondeterministically
 * dropping call edges. `orchestrate.ts` used to leave them sharing a repo-local default whenever
 * the caller passed no `cacheDir`; isolation must not depend on opting into an incremental cache.
 */
function emptyRepo(name: string) {
  return {
    id: name,
    name,
    path: '/repo',
    type: 'backend' as const,
    parsedAt: '2026-01-01T00:00:00.000Z',
    parserVersion: 'test',
    parserId: 'test',
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
  };
}

const seenScipDirs: (string | undefined)[] = [];

for (const language of FAKE_LANGUAGES) {
  registerLanguage({
    language,
    isProfile: () => true,
    async parse(_profile: unknown, opts: ParseOptions) {
      seenScipDirs.push(opts.scipOutDir);
      return emptyRepo(opts.repoName);
    },
  } as unknown as LanguageProvider);
}

function recordingProfile(): MultiTargetProfile {
  return {
    parserId: 'multi-test',
    repoType: 'backend',
    targets: [
      { name: 'target-a', substrate: { language: FAKE_LANGUAGES[0], include: [] } },
      { name: 'target-b', substrate: { language: FAKE_LANGUAGES[1], include: [] } },
    ],
  } as unknown as MultiTargetProfile;
}

describe('parseMultiTarget SCIP isolation', () => {
  it('gives every target a distinct scipOutDir even with no cacheDir', async () => {
    seenScipDirs.length = 0;
    await parseMultiTarget(recordingProfile(), { repoRoot: '/repo', repoName: 'r' });
    const seen = seenScipDirs;

    expect(seen).toHaveLength(2);
    for (const dir of seen) expect(dir).toBeTruthy();
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('removes the ephemeral scip root once the run finishes', async () => {
    seenScipDirs.length = 0;
    await parseMultiTarget(recordingProfile(), { repoRoot: '/repo', repoName: 'r' });
    const seen = seenScipDirs;

    // Both targets sit under one temp root; it must not survive the call.
    for (const dir of seen) expect(existsSync(dir as string)).toBe(false);
  });

  it('keeps target scip dirs distinct under a caller-supplied cacheDir', async () => {
    seenScipDirs.length = 0;
    await parseMultiTarget(recordingProfile(), {
      repoRoot: '/repo',
      repoName: 'r',
      cacheDir: '/tmp/coredoc-cache-fixture',
    });
    const seen = seenScipDirs;

    expect(new Set(seen).size).toBe(seen.length);
    for (const dir of seen) expect(dir).toContain('/tmp/coredoc-cache-fixture');
  });
});
