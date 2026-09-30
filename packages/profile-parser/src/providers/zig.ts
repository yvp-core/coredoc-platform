// =============================================================================
// Zig LanguageProvider.
//
// A thin wrapper over `parseZigRepo` + `toFullParsedRepo` (the bespoke tree-sitter-CST
// substrate): types, functions, `@import` edges, Tier-B calls, `cli` entrypoints, egress,
// raw-SQL entities/ops, constants and aliases. No SCIP: Zig has no wired semantic-index
// prerequisite, so `discovery` omits `scipPrereqs` and the parse never throws on a missing index.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { zigSourceSignals } from '../scoring/zig-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverZigFileScope, parseZigRepo, toFullParsedRepo } from '../substrate/zig/zig-parser.js';
import type { ZigProfile } from '../types/zig-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A Zig extraction profile: has parserId+substrate and language 'zig'. */
function isZigProfile(v: unknown): v is ZigProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as ZigProfile).substrate?.language === 'zig';
}

export const zigProvider: LanguageProvider<ZigProfile> = {
  language: 'zig',
  discovery: {
    extensions: ['.zig'],
    // No scipPrereqs: Zig has no SCIP indexer, so every collection comes from the
    // tree-sitter CST — the parse never throws on a missing index.
  },
  isProfile: isZigProfile,

  sourceFiles(profile: ZigProfile, repoRoot: string) {
    return discoverZigFileScope(
      repoRoot,
      profile.substrate.include ?? [],
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    );
  },

  async parse(profile: ZigProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const zig = await parseZigRepo(
      opts.repoRoot,
      opts.repoName,
      { repoKey: opts.repoKey, cacheDir: opts.cacheDir },
      profile,
    );
    return toFullParsedRepo(zig, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return zigSourceSignals(ctx);
  },
  // No structuralChecks: like Swift/Ruby, Zig has no route/handler table to check a profile
  // against — its only entrypoint is `pub fn main`, whose handler is the emitted function
  // itself, so the TS handler-consistency checks are N/A rather than a permanent FAIL.
};
