import type { ParsedRepo } from '@coredoc/core/types';
import { buildBaseline } from '../facts/pipeline.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import { TreeSitterScipSubstrate } from './tree-sitter-scip.js';

/**
 * Run an ExtractionProfile *object* over a repo through the substrate engine.
 * This is the engine entry point the CLI profile-run path and the authoring
 * scorer use: it takes a profile object (not a registry key), so any authored
 * profile module can be run without being registered here.
 */
export interface RunProfileOptions {
  /**
   * Where the SCIP indexer writes. A concurrent multi-target run MUST pass a distinct value per
   * target, because the per-project index filename is derived from the project path alone and
   * carries no target discriminator — two targets sharing a directory would delete and rewrite
   * each other's index files mid-parse.
   */
  scipOutDir?: string;
}

export async function runProfile(
  profile: ExtractionProfile,
  repoRoot: string,
  repoName: string,
  repoKey?: string,
  opts: RunProfileOptions = {},
): Promise<{ repo: ParsedRepo; engine: SubstrateProfileEngine }> {
  // Wall-clock the dominant parse cost (baseline build — incl. the SCIP subprocess — plus the
  // engine pass). assemble() can't measure this (it runs inside engine.run, after the baseline is
  // already built), so it stamps 0 and we overwrite with the true elapsed here.
  const t0 = Date.now();
  // repoKey threads into id hashing (repoHash = hash(repoKey ?? repoName)); it must reach BOTH
  // buildBaseline (node ids) and engine.run → assemble (the repo id), or a repo whose key ≠ name
  // would get a different repoHash than the legacy parser path. See @coredoc/core two-ID system.
  const baseline = await buildBaseline(
    { repoRoot, repoName, repoKey, scipOutDir: opts.scipOutDir },
    { runScip: true, resolveAnonCallbacks: profile.callGraph?.resolveAnonCallbacks },
  );
  const substrate = await TreeSitterScipSubstrate.create(baseline, {
    repoRoot,
    scope: { include: profile.substrate.include, exclude: profile.substrate.exclude ?? [] },
    di: profile.di?.style === 'constructor-type',
    stripGenerics: profile.di?.stripGenerics,
    accessorHooks: profile.callGraph?.accessorHooks,
  });
  const engine = new SubstrateProfileEngine(profile, substrate);
  // The engine is done reading the CST once `run` returns, and `repo` holds only plain data, so
  // the WASM-side trees are freed here. web-tree-sitter has no tree GC and a hard 2GB Emscripten
  // cap; retaining one tree per scoped file until process exit is what aborts large monorepos
  // (and every target of a multi-target run compounds it). In a `finally` because a throwing
  // `engine.run` leaks exactly the same trees — and a multi-target run then keeps going.
  let repo: ParsedRepo;
  try {
    repo = engine.run(baseline, { repoRoot, repoName, repoKey });
  } finally {
    substrate.dispose();
  }
  repo.stats.parseTimeMs = Date.now() - t0;
  const semanticFiles = new Set([
    ...baseline.plan.languages.typescript.files,
    ...baseline.plan.languages.javascript.files,
  ]);
  repo.stats.analysis = [
    {
      language: profile.substrate.language,
      mode: baseline.scip ? 'enhanced' : 'basic',
      // Vue-only targets are structurally analyzed by design; SCIP does not support SFCs.
      fallback:
        baseline.scipIncomplete === true || (!baseline.scip && repo.files.some((file) => semanticFiles.has(file.path))),
      compilerReceiverTypes: false,
    },
  ];
  return { repo, engine };
}
