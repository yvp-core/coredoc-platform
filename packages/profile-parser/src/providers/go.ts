import { goSourceSignals } from '../scoring/go-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { goSubstrate } from '../substrate/go/go-parser.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import type { GoProfile } from '../types/go-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const goProvider: LanguageProvider<GoProfile> = {
  language: 'go',
  discovery: { extensions: ['.go'] },
  isProfile: (v): v is GoProfile => hasLanguage(v, 'go'),

  ...substrateEntry(goSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return goSourceSignals(ctx.repoRoot, ctx.profile as GoProfile, ctx.parsed, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift/Python/Rust, Go http entrypoints registered through a
  // router call-shape carry synthetic handlerIds with no FunctionNode handler (chi's
  // `r.Get("/x", h)` names a handler the substrate resolves only when it is statically
  // decidable), so the TS handler-consistency checks are N/A — and a spurious dangling-handler
  // red flag would force a permanent FAIL (overall PASS needs redFlags === 0).
};
