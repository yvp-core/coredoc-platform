import { rustSourceSignals } from '../scoring/rust-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { rustSubstrate } from '../substrate/rust/rust-parser.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import type { RustProfile } from '../types/rust-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const rustProvider: LanguageProvider<RustProfile> = {
  language: 'rust',
  discovery: { extensions: ['.rs'] },
  isProfile: (v): v is RustProfile => hasLanguage(v, 'rust'),

  ...substrateEntry(rustSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rustSourceSignals(ctx.repoRoot, ctx.profile as RustProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift/Python, Rust http entrypoints registered through a
  // router call-shape carry synthetic handlerIds with no FunctionNode handler, so the TS
  // handler-consistency checks are N/A — and a spurious dangling-handler red flag would force
  // a permanent FAIL (overall PASS needs redFlags === 0).
};
