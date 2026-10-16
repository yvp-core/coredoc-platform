import { pythonSourceSignals } from '../scoring/python-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { PY_SOURCE_EXTENSIONS } from '../substrate/python/python-cst.js';
import { pythonSubstrate } from '../substrate/python/python-parser.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import type { PythonProfile } from '../types/python-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const pythonProvider: LanguageProvider<PythonProfile> = {
  language: 'python',
  discovery: { extensions: PY_SOURCE_EXTENSIONS },
  isProfile: (v): v is PythonProfile => hasLanguage(v, 'python'),

  ...substrateEntry(pythonSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return pythonSourceSignals(ctx.repoRoot, ctx.profile as PythonProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift, Python http entrypoints carry synthetic handlerIds
  // with no FunctionNode handler, so the TS handler-consistency checks are N/A — and a
  // spurious dangling-handler red flag would force a permanent FAIL (PASS needs redFlags===0).
};
