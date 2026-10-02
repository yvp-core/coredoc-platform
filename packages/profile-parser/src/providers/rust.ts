import { rustScipPrereqs } from '../substrate/rust/scip-tool.js';
import { rustSourceSignals } from '../scoring/rust-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { rustSubstrate } from '../substrate/rust/rust-parser.js';
import { parseSubstrate } from '../substrate/parse-substrate.js';
import type { RustProfile } from '../types/rust-profile.js';
import type { LanguageProvider } from './types.js';

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

  sourceFiles: (profile, repoRoot) => rustSubstrate.scope(profile, repoRoot),
  parse: (profile, opts) => parseSubstrate(rustSubstrate, profile, opts),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rustSourceSignals(ctx.repoRoot, ctx.profile as RustProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift/Python, Rust http entrypoints registered through a
  // router call-shape carry synthetic handlerIds with no FunctionNode handler, so the TS
  // handler-consistency checks are N/A — and a spurious dangling-handler red flag would force
  // a permanent FAIL (overall PASS needs redFlags === 0).
};
