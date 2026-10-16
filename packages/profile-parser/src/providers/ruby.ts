// =============================================================================
// Ruby LanguageProvider.
//
// A thin wrapper over `parseSubstrate(rubySubstrate)`.
// =============================================================================
import { rubySourceSignals } from '../scoring/ruby-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { RUBY_SOURCE_EXTENSIONS, rubySubstrate } from '../substrate/ruby/ruby-parser.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import type { RubyProfile } from '../types/ruby-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const rubyProvider: LanguageProvider<RubyProfile> = {
  language: 'ruby',
  discovery: { extensions: RUBY_SOURCE_EXTENSIONS },
  isProfile: (v): v is RubyProfile => hasLanguage(v, 'ruby'),

  // scip-ruby writes a single `index.scip` (plus its source-hash sidecar) into `scipOutDir` and
  // deletes it before each run, so concurrent targets must not share one. See orchestrate.ts.
  ...substrateEntry(rubySubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rubySourceSignals(ctx.repoRoot, ctx.profile as RubyProfile, ctx.sourceFiles);
  },
  // No structuralChecks: Ruby http entrypoints carry synthetic handlerIds with no
  // FunctionNode, so the TS handler checks are N/A.
};
