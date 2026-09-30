// =============================================================================
// Swift LanguageProvider.
//
// A thin wrapper over `parseSwiftRepo` + `toFullParsedRepo` (the bespoke tree-sitter-CST
// substrate, Ruby-style). No SCIP: Swift has no wired semantic-index prerequisite, so
// `discovery` omits `scipPrereqs` and the parse never throws on a missing index.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { swiftSourceSignals } from '../scoring/swift-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverSwiftFileScope, parseSwiftRepo, toFullParsedRepo } from '../substrate/swift/swift-parser.js';
import type { SwiftProfile } from '../types/swift-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A Swift extraction profile: has parserId+substrate and language 'swift'. */
function isSwiftProfile(v: unknown): v is SwiftProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as SwiftProfile).substrate?.language === 'swift';
}

export const swiftProvider: LanguageProvider<SwiftProfile> = {
  language: 'swift',
  discovery: {
    extensions: ['.swift'],
    // No scipPrereqs: Swift ships Tier-B (tree-sitter CST only). A real Swift semantic index
    // (scip-swift / IndexStoreDB) needs a full Xcode/SwiftPM build, unavailable in CLI/CI —
    // deferred. The parse never throws on a missing index.
  },
  isProfile: isSwiftProfile,

  sourceFiles(profile: SwiftProfile, repoRoot: string) {
    return discoverSwiftFileScope(repoRoot, profile.substrate.include, profile.substrate.exclude ?? []);
  },

  async parse(profile: SwiftProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const swift = await parseSwiftRepo(
      opts.repoRoot,
      opts.repoName,
      { httpPrefix: opts.httpPrefix, repoKey: opts.repoKey, cacheDir: opts.cacheDir },
      profile,
    );
    return toFullParsedRepo(swift, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return swiftSourceSignals(ctx.repoRoot, ctx.profile as SwiftProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby, Swift emits no real FunctionNode handler for its
  // (deferred) synthetic entrypoints, so the TS handler-consistency checks are N/A — and a
  // spurious dangling-handler red flag would force a permanent FAIL (PASS needs redFlags===0).
};
