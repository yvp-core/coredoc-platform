// =============================================================================
// Kotlin/Android LanguageProvider.
//
// A thin wrapper over `parseKotlinRepo` + `toFullParsedRepo` (the bespoke tree-sitter-CST
// substrate): declarations, `import` edges, Tier-B calls, Room/Realm entities and operations,
// Retrofit egress, `mobile` entrypoints, Compose/Fragment/Activity components and navigation
// routes. No SCIP — Kotlin has no wired semantic index, so `discovery` omits `scipPrereqs` and
// the parse never throws on a missing one. `.kt` only: a Kotlin target never claims `.java`.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { kotlinSourceSignals } from '../scoring/kotlin-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverKotlinFileScope, parseKotlinRepo, toFullParsedRepo } from '../substrate/kotlin/kotlin-parser.js';
import type { KotlinProfile } from '../types/kotlin-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A Kotlin extraction profile: has parserId+substrate+include and language 'kotlin'. */
function isKotlinProfile(v: unknown): v is KotlinProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  const substrate = (v as KotlinProfile).substrate;
  return substrate?.language === 'kotlin' && Array.isArray(substrate.include);
}

export const kotlinProvider: LanguageProvider<KotlinProfile> = {
  language: 'kotlin',
  discovery: {
    extensions: ['.kt'],
    // No scipPrereqs: every collection comes from the tree-sitter CST.
  },
  isProfile: isKotlinProfile,

  sourceFiles(profile: KotlinProfile, repoRoot: string) {
    return discoverKotlinFileScope(repoRoot, profile.substrate.include ?? [], profile.substrate.exclude ?? []);
  },

  async parse(profile: KotlinProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const kotlin = await parseKotlinRepo(
      opts.repoRoot,
      opts.repoName,
      // No `incremental`/`cacheDir`/`scipOutDir`: Kotlin has neither an incremental cache nor a
      // SCIP indexer, so those `ParseOptions` fields are accepted here and go no further.
      { repoKey: opts.repoKey, httpPrefix: opts.httpPrefix },
      profile,
    );
    return toFullParsedRepo(kotlin, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return kotlinSourceSignals(ctx);
  },
  // No structuralChecks: like Swift and Zig, Kotlin has no declarative route/handler table to
  // check a profile against — entrypoints come from framework base classes and the manifest.
};
