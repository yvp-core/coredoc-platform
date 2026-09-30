import { goScipPrereqs } from '../substrate/go/scip-tool.js';
import type { ParsedRepo } from '@coredoc/core/types';
import { goSourceSignals } from '../scoring/go-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverGoFileScope } from '../substrate/go/go-cst.js';
import { parseGoRepo, toFullParsedRepo } from '../substrate/go/go-parser.js';
import type { GoProfile } from '../types/go-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A Go extraction profile: has parserId+substrate and language 'go'. */
function isGoProfile(v: unknown): v is GoProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as GoProfile).substrate?.language === 'go';
}

export const goProvider: LanguageProvider<GoProfile> = {
  language: 'go',
  discovery: {
    scipPrereqs: goScipPrereqs,
    extensions: ['.go'],
  },
  isProfile: isGoProfile,

  sourceFiles(profile: GoProfile, repoRoot: string) {
    return discoverGoFileScope(
      repoRoot,
      profile.substrate.include,
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    );
  },

  async parse(profile: GoProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const gs = await parseGoRepo(
      opts.repoRoot,
      opts.repoName,
      { httpPrefix: opts.httpPrefix, repoKey: opts.repoKey, cacheDir: opts.cacheDir, scipOutDir: opts.scipOutDir },
      profile,
    );
    return toFullParsedRepo(gs, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return goSourceSignals(ctx.repoRoot, ctx.profile as GoProfile, ctx.parsed, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift/Python/Rust, Go http entrypoints registered through a
  // router call-shape carry synthetic handlerIds with no FunctionNode handler (chi's
  // `r.Get("/x", h)` names a handler the substrate resolves only when it is statically
  // decidable), so the TS handler-consistency checks are N/A — and a spurious dangling-handler
  // red flag would force a permanent FAIL (overall PASS needs redFlags === 0).
};
