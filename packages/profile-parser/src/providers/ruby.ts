// =============================================================================
// Ruby LanguageProvider.
//
// A thin wrapper over `parseRubyRepo` + `toFullParsedRepo`.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { rubyScipPrereqs } from '../substrate/ruby/scip-tool.js';
import { rubySourceSignals } from '../scoring/ruby-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import {
  discoverRubyFileScope,
  parseRubyRepo,
  RUBY_SOURCE_EXTENSIONS,
  toFullParsedRepo,
} from '../substrate/ruby/ruby-parser.js';
import type { RubyProfile } from '../types/ruby-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

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
    // unmet prereq — `parseRubyRepo` degrades to the Tier-B heuristic. Exposed here for
    // the LanguageDiscovery contract / tooling surface.
    scipPrereqs: (repoRoot: string): string | null => rubyScipPrereqs(repoRoot),
  },
  isProfile: isRubyProfile,

  sourceFiles(profile: RubyProfile, repoRoot: string) {
    return discoverRubyFileScope(
      repoRoot,
      profile.substrate.include,
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    );
  },

  async parse(profile: RubyProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const ruby = await parseRubyRepo(
      opts.repoRoot,
      opts.repoName,
      {
        httpPrefix: opts.httpPrefix,
        repoKey: opts.repoKey,
        cacheDir: opts.cacheDir,
        // scip-ruby writes a single `index.scip` (plus its source-hash sidecar) into this dir and
        // deletes it before each run, so concurrent targets must not share one. See orchestrate.ts.
        scipOutDir: opts.scipOutDir,
      },
      profile,
    );
    return toFullParsedRepo(ruby, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return rubySourceSignals(ctx.repoRoot, ctx.profile as RubyProfile, ctx.sourceFiles);
  },
  // No structuralChecks: Ruby http entrypoints carry synthetic handlerIds with no
  // FunctionNode, so the TS handler checks are N/A.
};
