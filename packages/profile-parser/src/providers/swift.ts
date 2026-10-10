// =============================================================================
// Swift LanguageProvider.
//
// A thin wrapper over `swiftSubstrate` run through `parseSubstrate` (the bespoke
// tree-sitter-CST substrate, Ruby-style). No SCIP: Swift ships Tier-B (tree-sitter CST only). A real
// Swift semantic index (scip-swift / IndexStoreDB) needs a full Xcode/SwiftPM build, unavailable in
// CLI/CI — deferred. The parse never throws on a missing index.
// =============================================================================
import { swiftSourceSignals } from '../scoring/swift-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import { swiftSubstrate } from '../substrate/swift/swift-parser.js';
import type { SwiftProfile } from '../types/swift-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const swiftProvider: LanguageProvider<SwiftProfile> = {
  language: 'swift',
  discovery: { extensions: ['.swift'] },
  isProfile: (v): v is SwiftProfile => hasLanguage(v, 'swift'),

  ...substrateEntry(swiftSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return swiftSourceSignals(ctx.repoRoot, ctx.profile as SwiftProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby, Swift emits no real FunctionNode handler for its
  // (deferred) synthetic entrypoints, so the TS handler-consistency checks are N/A — and a
  // spurious dangling-handler red flag would force a permanent FAIL (PASS needs redFlags===0).
};
