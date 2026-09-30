// =============================================================================
// TypeScript / JavaScript LanguageProvider.
//
// A thin wrapper over `runProfile` (tree-sitter with optional SCIP enrichment).
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { discover, TS_JS_SOURCE_EXTENSIONS } from '../facts/discovery/discover.js';
import { runProfile } from '../substrate/run.js';
import { applySourceFileScope } from '../substrate/source-file-scope.js';
import { tsSourceSignals, tsStructuralChecks } from '../scoring/ts-signals.js';
import type { ExtractionProfile } from '../types/profile.js';
import type { LanguageProvider, ParseOptions } from './types.js';

/** A TS/JS extraction profile: has parserId+substrate and language ts|js. */
function isExtractionProfile(v: unknown): v is ExtractionProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('substrate' in v)) return false;
  const lang = (v as ExtractionProfile).substrate?.language;
  return lang === 'ts' || lang === 'js';
}

export const typescriptProvider: LanguageProvider<ExtractionProfile> = {
  language: 'ts',
  aliases: ['js'],
  discovery: {
    extensions: TS_JS_SOURCE_EXTENSIONS,
  },
  isProfile: isExtractionProfile,

  sourceFiles(profile: ExtractionProfile, repoRoot: string) {
    const plan = discover(repoRoot);
    return applySourceFileScope(
      [...plan.languages.typescript.files, ...plan.languages.javascript.files, ...plan.vueFiles],
      profile.substrate.include,
      [],
      profile.substrate.exclude ?? [],
    );
  },

  async parse(profile: ExtractionProfile, opts: ParseOptions): Promise<ParsedRepo> {
    const { repo } = await runProfile(profile, opts.repoRoot, opts.repoName, opts.repoKey, {
      incremental: opts.incremental,
      cacheDir: opts.cacheDir,
      scipOutDir: opts.scipOutDir,
    });

    const scipIssues = (repo.errors ?? []).filter((e) => /scip|tsconfig|index\.scip/i.test(e.message));
    // Severity alone does not tell a degrade apart from a notice: a missing
    // node_modules is reported as a warning yet drops SCIP (fallback analysis),
    // while the duplicate-document dedupe notice is a warning with SCIP intact.
    // The "install scip-typescript" hint only fits an actual degrade.
    const degraded =
      (repo.stats.analysis ?? []).some((a) => a.fallback) || scipIssues.some((e) => e.severity === 'error');
    const scipIssue = scipIssues.find((e) => e.severity === 'error') ?? scipIssues[0];
    if (scipIssue) {
      console.warn(
        `[coredoc] SCIP ${degraded ? 'indexing degraded' : 'notice'} for ${opts.repoName}: ${scipIssue.message}` +
          (degraded
            ? `\n  Call and external-call edges may be incomplete. Ensure 'scip-typescript' is installed and the repo type-checks.`
            : ''),
      );
    }
    return repo;
  },

  sourceSignals: tsSourceSignals,
  structuralChecks: tsStructuralChecks,
};
