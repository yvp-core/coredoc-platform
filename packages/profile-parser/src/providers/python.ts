import { pythonScipPrereqs } from '../substrate/python/scip-tool.js';
import type { ParsedRepo } from '@coredoc/core/types';
import { pythonSourceSignals } from '../scoring/python-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { discoverPythonFileScope, PY_SOURCE_EXTENSIONS } from '../substrate/python/python-cst.js';
import { parsePythonRepo, toFullParsedRepo } from '../substrate/python/python-parser.js';
import type { PythonProfile } from '../types/python-profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

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

  sourceFiles(profile: PythonProfile, repoRoot: string) {
    return discoverPythonFileScope(
      repoRoot,
      profile.substrate.include,
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    );
  },

  async parse(profile: PythonProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const py = await parsePythonRepo(
      opts.repoRoot,
      opts.repoName,
      { httpPrefix: opts.httpPrefix, repoKey: opts.repoKey, cacheDir: opts.cacheDir, scipOutDir: opts.scipOutDir },
      profile,
    );
    return toFullParsedRepo(py, opts.repoRoot, profile.parserId, new Date().toISOString());
  },

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return pythonSourceSignals(ctx.repoRoot, ctx.profile as PythonProfile, ctx.sourceFiles);
  },
  // No structuralChecks: like Ruby/Swift, Python http entrypoints carry synthetic handlerIds
  // with no FunctionNode handler, so the TS handler-consistency checks are N/A — and a
  // spurious dangling-handler red flag would force a permanent FAIL (PASS needs redFlags===0).
};
