// =============================================================================
// Ruby LanguageProvider.
//
// A thin wrapper over `parseSubstrate(rubySubstrate)`.
// =============================================================================
import { rubyScipPrereqs } from '../substrate/ruby/scip-tool.js';
import { rubySourceSignals } from '../scoring/ruby-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { RUBY_SOURCE_EXTENSIONS, rubySubstrate } from '../substrate/ruby/ruby-parser.js';
import { parseSubstrate } from '../substrate/parse-substrate.js';
import type { RubyProfile } from '../types/ruby-profile.js';
import type { LanguageProvider } from './types.js';

function isRubyProfile(v: unknown): v is RubyProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as RubyProfile).substrate?.language === 'ruby';
}

export const rubyProvider: LanguageProvider<RubyProfile> = {
  language: 'ruby',
  discovery: {
    extensions: RUBY_SOURCE_EXTENSIONS,
    // Tier-A (scip-ruby) prerequisite. Unlike TS, the Ruby parse does NOT throw on an
    // unmet prereq — the substrate degrades to the Tier-B heuristic. Exposed here for
    // the LanguageDiscovery contract / tooling surface.
    scipPrereqs: (repoRoot: string): string | null => rubyScipPrereqs(repoRoot),
  },
  isProfile: isRubyProfile,

  sourceFiles: (profile, repoRoot) => rubySubstrate.scope(profile, repoRoot),
  // scip-ruby writes a single `index.scip` (plus its source-hash sidecar) into `scipOutDir` and
  // deletes it before each run, so concurrent targets must not share one. See orchestrate.ts.
  parse: (profile, opts) => parseSubstrate(rubySubstrate, profile, opts),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rubySourceSignals(ctx.repoRoot, ctx.profile as RubyProfile, ctx.sourceFiles);
  },
  // No structuralChecks: Ruby http entrypoints carry synthetic handlerIds with no
  // FunctionNode, so the TS handler checks are N/A.
};
