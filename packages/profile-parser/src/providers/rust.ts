import { rustScipPrereqs } from '../substrate/rust/scip-tool.js';
import type { ParsedRepo } from '@coredoc/core/types';
import { rustSourceSignals } from '../scoring/rust-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverRustFileScope } from '../substrate/rust/rust-cst.js';
import { parseRustRepo, toFullParsedRepo } from '../substrate/rust/rust-parser.js';
import type { RustProfile } from '../types/rust-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A Rust extraction profile: has parserId+substrate and language 'rust'. */
function isRustProfile(v: unknown): v is RustProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as RustProfile).substrate?.language === 'rust';
}

export const rustProvider: LanguageProvider<RustProfile> = {
  language: 'rust',
  discovery: {
    scipPrereqs: rustScipPrereqs,
    extensions: ['.rs'],
  },
  isProfile: isRustProfile,

  sourceFiles(profile: RustProfile, repoRoot: string) {
    return discoverRustFileScope(
      repoRoot,
      profile.substrate.include,
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    );
  },

  async parse(profile: RustProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const rs = await parseRustRepo(
      opts.repoRoot,
      opts.repoName,
      { httpPrefix: opts.httpPrefix, repoKey: opts.repoKey, cacheDir: opts.cacheDir, scipOutDir: opts.scipOutDir },
      profile,
    );
    return toFullParsedRepo(rs, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rustSourceSignals(ctx.repoRoot, ctx.profile as RustProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift/Python, Rust http entrypoints registered through a
  // router call-shape carry synthetic handlerIds with no FunctionNode handler, so the TS
  // handler-consistency checks are N/A — and a spurious dangling-handler red flag would force
  // a permanent FAIL (overall PASS needs redFlags === 0).
};
