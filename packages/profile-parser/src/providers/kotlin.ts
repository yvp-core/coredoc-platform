// =============================================================================
// Kotlin/Android LanguageProvider.
//
// A thin wrapper over `kotlinSubstrate` run through `parseSubstrate` (the bespoke tree-sitter-CST
// substrate): declarations, `import` edges, Tier-B calls, Room/Realm entities and operations,
// Retrofit egress, `mobile` entrypoints, Compose/Fragment/Activity components and navigation
// routes. No SCIP — Kotlin has no wired semantic index, so `discovery` omits `scipPrereqs` and
// the parse never throws on a missing one. `.kt` only: a Kotlin target never claims `.java`.
// =============================================================================
import { kotlinSourceSignals } from '../scoring/kotlin-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { kotlinSubstrate } from '../substrate/kotlin/kotlin-parser.js';
import { parseSubstrate } from '../substrate/parse-substrate.js';
import type { KotlinProfile } from '../types/kotlin-profile.js';
import type { LanguageProvider } from './types.js';

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

  sourceFiles: (profile, repoRoot) => kotlinSubstrate.scope(profile, repoRoot),
  parse: (profile, opts) => parseSubstrate(kotlinSubstrate, profile, opts),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return kotlinSourceSignals(ctx);
  },
  // No structuralChecks: like Swift and Zig, Kotlin has no declarative route/handler table to
  // check a profile against — entrypoints come from framework base classes and the manifest.
};
