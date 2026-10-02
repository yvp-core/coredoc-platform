import { pythonScipPrereqs } from '../substrate/python/scip-tool.js';
import { pythonSourceSignals } from '../scoring/python-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { PY_SOURCE_EXTENSIONS } from '../substrate/python/python-cst.js';
import { pythonSubstrate } from '../substrate/python/python-parser.js';
import { parseSubstrate } from '../substrate/parse-substrate.js';
import type { PythonProfile } from '../types/python-profile.js';
import type { LanguageProvider } from './types.js';

/** A Python extraction profile: has parserId+substrate and language 'python'. */
function isPythonProfile(v: unknown): v is PythonProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  return (v as PythonProfile).substrate?.language === 'python';
}

export const pythonProvider: LanguageProvider<PythonProfile> = {
  language: 'python',
  discovery: {
    scipPrereqs: pythonScipPrereqs,
    extensions: PY_SOURCE_EXTENSIONS,
  },
  isProfile: isPythonProfile,

  sourceFiles: (profile, repoRoot) => pythonSubstrate.scope(profile, repoRoot),
  parse: (profile, opts) => parseSubstrate(pythonSubstrate, profile, opts),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return pythonSourceSignals(ctx.repoRoot, ctx.profile as PythonProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift, Python http entrypoints carry synthetic handlerIds
  // with no FunctionNode handler, so the TS handler-consistency checks are N/A — and a
  // spurious dangling-handler red flag would force a permanent FAIL (PASS needs redFlags===0).
};
