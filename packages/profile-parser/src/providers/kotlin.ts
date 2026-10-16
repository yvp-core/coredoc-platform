// =============================================================================
// Kotlin/Android LanguageProvider.
//
// A thin wrapper over `kotlinSubstrate` run through `parseSubstrate` (the bespoke tree-sitter-CST
// substrate): declarations, `import` edges, Tier-B calls, Room/Realm entities and operations,
// Retrofit egress, `mobile` entrypoints, Compose/Fragment/Activity components and navigation
// routes. No SCIP — Kotlin has no wired semantic index, so the parse never throws on a missing
// one. `.kt` only: a Kotlin target never claims `.java`.
// =============================================================================
import { kotlinSourceSignals } from '../scoring/kotlin-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { kotlinSubstrate } from '../substrate/kotlin/kotlin-parser.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import type { KotlinProfile } from '../types/kotlin-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const kotlinProvider: LanguageProvider<KotlinProfile> = {
  language: 'kotlin',
  discovery: { extensions: ['.kt'] },
  isProfile: (v): v is KotlinProfile =>
    hasLanguage(v, 'kotlin') && Array.isArray((v as KotlinProfile).substrate.include),

  ...substrateEntry(kotlinSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return kotlinSourceSignals(ctx);
  },
  // No structuralChecks: like Swift and Zig, Kotlin has no declarative route/handler table to
  // check a profile against — entrypoints come from framework base classes and the manifest.
};
