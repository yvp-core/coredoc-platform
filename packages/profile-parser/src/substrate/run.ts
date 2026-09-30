/**
 * run.ts — runs one SubstrateProfileEngine over the tree-sitter+SCIP
 * substrate, wired to the existing profiles, to reproduce both golden repos.
 *
 * Usage:
 *   npx tsx packages/profile-parser/src/substrate/run.ts \
 *     <path-to-profile-module> <repoPath> <outJson> [goldenJson]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildManifest,
  loadCachedRepo,
  loadManifest,
  manifestsMatch,
  writeCache,
} from '../facts/cache/incremental-cache.js';
import { discover } from '../facts/discovery/discover.js';
import { buildBaseline } from '../facts/index.js';
import type { ParsedRepo } from '@coredoc/core/types';
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
  /** Enable the incremental clean-skip fast-path (reuse the cached parse when nothing changed). */
  incremental?: boolean;
  /** Where the manifest + cached ParsedRepo live (per-repo). Required for `incremental` to engage. */
  cacheDir?: string;
  /**
   * Where the SCIP indexer writes. Defaults to `cacheDir`; a concurrent multi-target run MUST
   * pass a distinct value per target, because the per-project index filename is derived from the
   * project path alone and carries no target discriminator — two targets sharing a directory
   * would delete and rewrite each other's index files mid-parse.
   */
  scipOutDir?: string;
}

export async function runProfile(
  profile: ExtractionProfile,
  repoRoot: string,
  repoName: string,
  repoKey?: string,
  opts: RunProfileOptions = {},
): Promise<{ repo: ParsedRepo; engine?: SubstrateProfileEngine }> {
  const fullRun = async (): Promise<{ repo: ParsedRepo; engine: SubstrateProfileEngine }> => {
    // Wall-clock the dominant parse cost (baseline build — incl. the SCIP subprocess — plus the
    // engine pass). assemble() can't measure this (it runs inside engine.run, after the baseline is
    // already built), so it stamps 0 and we overwrite with the true elapsed here.
    const t0 = Date.now();
    // repoKey threads into id hashing (repoHash = hash(repoKey ?? repoName)); it must reach BOTH
    // buildBaseline (node ids) and engine.run → assemble (the repo id), or a repo whose key ≠ name
    // would get a different repoHash than the legacy parser path. See @coredoc/core two-ID system.
    const baseline = await buildBaseline(
      { repoRoot, repoName, repoKey, scipOutDir: opts.scipOutDir ?? opts.cacheDir },
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
          baseline.scipIncomplete === true ||
          (!baseline.scip && repo.files.some((file) => semanticFiles.has(file.path))),
        compilerReceiverTypes: false,
      },
    ];
    return { repo, engine };
  };

  // Incremental clean-skip: when nothing that affects the output changed (source bytes, profile,
  // scope, parser version, deps), reuse the prior ParsedRepo and skip the dominant-cost SCIP
  // subprocess entirely. On ANY change or any doubt → full re-parse (the manifest over-invalidates).
  // The output is byte-identical by construction: a clean hit returns the exact prior full parse.
  if (opts.incremental && opts.cacheDir) {
    const plan = discover(repoRoot);
    const relPaths = [...plan.languages.typescript.files, ...plan.languages.javascript.files, ...plan.vueFiles];
    const current = buildManifest(profile, repoRoot, relPaths);
    const prior = loadManifest(opts.cacheDir);
    if (prior && manifestsMatch(prior, current)) {
      const cached = loadCachedRepo(opts.cacheDir);
      // Older cached results cannot establish whether the semantic tier ran.
      if (cached?.stats.analysis?.length && !cached.stats.analysis.some((item) => item.fallback))
        return { repo: cached }; // Retry degraded runs: tooling/dependencies may have recovered independently of source.
    }
    const result = await fullRun();
    writeCache(opts.cacheDir, current, result.repo); // persist only AFTER a successful parse
    return result;
  }

  return fullRun();
}

export async function runSubstrateWithEngine(
  profilePath: string,
  repoRoot: string,
  repoName: string,
): Promise<{ repo: ParsedRepo; engine?: SubstrateProfileEngine }> {
  const mod = (await import(pathToFileURL(resolve(profilePath)).href)) as Record<string, unknown>;
  const profile = Object.values(mod).find(
    (v): v is ExtractionProfile => typeof v === 'object' && v !== null && 'parserId' in v && 'substrate' in v,
  );
  if (!profile) throw new Error(`No ExtractionProfile export found in ${profilePath}`);
  return runProfile(profile, repoRoot, repoName);
}

export async function runSubstrate(profileKey: string, repoRoot: string, repoName: string): Promise<ParsedRepo> {
  return (await runSubstrateWithEngine(profileKey, repoRoot, repoName)).repo;
}

async function main(): Promise<void> {
  const [profilePath, repoRoot, outJson, goldenJson] = process.argv.slice(2);
  if (!profilePath || !repoRoot || !outJson) {
    console.error('Usage: run.ts <path-to-profile-module> <repoPath> <outJson> [goldenJson]');
    process.exit(2);
  }
  const repoName = basename(profilePath).replace(/\.[tj]s$/, '');
  const t0 = Date.now();
  console.error(`[substrate] buildBaseline + engine(${repoName}) …`);
  const { repo, engine } = await runSubstrateWithEngine(profilePath, repoRoot, repoName);
  writeFileSync(outJson, JSON.stringify(repo, null, 1));
  console.error(`[substrate] wrote ${outJson} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const http = repo.entrypoints.filter((e) => e.type === 'http').length;
  const queue = repo.entrypoints.filter((e) => e.type === 'queue').length;
  console.error('\n========== SUBSTRATE ENGINE RESULT ==========');
  console.error(`http=${http} queue=${queue} entities=${repo.entities.length} dbOps=${repo.dbOperations.length}`);
  console.error(
    `functions=${repo.functions.length} classes=${repo.classes.length} calls=${repo.calls.length} externalCalls=${repo.externalCalls.length}`,
  );

  if (repo.components?.length) {
    const ids = new Set(repo.components.map((c) => c.id));
    let total = 0;
    let nullId = 0;
    let dangling = 0;
    for (const c of repo.components) {
      for (const u of c.childComponents ?? []) {
        total++;
        if (u.componentId == null) nullId++;
        else if (!ids.has(u.componentId)) dangling++;
      }
    }
    console.error('\n========== FRONTEND (substrate, SCIP resolution) ==========');
    console.error(
      `components=${repo.components.length} childUsages=${total} resolvedBySCIP=${engine?.frontendStats.resolvedBySCIP ?? 0} nullId=${nullId} (${total ? Math.round((nullId / total) * 100) : 0}%) trueDangling=${dangling}`,
    );
  }

  const routes = repo.routes ?? [];
  const stateStores = repo.stateStores ?? [];
  if (routes.length || stateStores.length) {
    const compIds = new Set((repo.components ?? []).map((c) => c.id));
    const withId = routes.filter((r) => r.componentId != null);
    const routeDangling = withId.filter((r) => !compIds.has(r.componentId as string)).length;
    console.error('\n========== ROUTES + STATE STORES (substrate) ==========');
    console.error(
      `routes=${routes.length} componentIdResolved=${withId.length} routeDangling=${routeDangling} | stateStores=${stateStores.length}`,
    );
  }

  if (goldenJson) {
    const golden = JSON.parse(readFileSync(goldenJson, 'utf8'));
    const gHttp = new Set<string>(
      golden.entrypoints
        .filter((e: any) => e.type === 'http')
        .map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const tHttp = new Set<string>(
      repo.entrypoints
        .filter((e: any) => e.type === 'http')
        .map((e: any) => `${e.details.method} ${e.details.fullPath}`),
    );
    const gQueue = new Set<string>(
      golden.entrypoints.filter((e: any) => e.type === 'queue').map((e: any) => e.details.topic),
    );
    const tQueue = new Set<string>(
      repo.entrypoints.filter((e: any) => e.type === 'queue').map((e: any) => e.details.topic),
    );
    const gEnt = new Set<string>(golden.entities.map((e: any) => e.name));
    const tEnt = new Set<string>(repo.entities.map((e: any) => e.name));
    const ov = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
    console.error('\n========== vs GOLDEN ==========');
    console.error(
      `http     | golden ${gHttp.size} | substrate ${tHttp.size} | exact ${ov(gHttp, tHttp)}/${gHttp.size}`,
    );
    console.error(
      `queue    | golden ${gQueue.size} | substrate ${tQueue.size} | exact ${ov(gQueue, tQueue)}/${gQueue.size}`,
    );
    console.error(`entities | golden ${gEnt.size} | substrate ${tEnt.size} | exact ${ov(gEnt, tEnt)}/${gEnt.size}`);
    console.error(`dbOps    | golden ${golden.dbOperations.length} | substrate ${repo.dbOperations.length}`);
    console.error(`calls    | golden ${golden.stats.totalCalls} | substrate ${repo.calls.length}`);
    console.error(`externalCalls | golden ${golden.stats.totalExternalCalls} | substrate ${repo.externalCalls.length}`);
    console.error('\nhttp missing:', [...gHttp].filter((x) => !tHttp.has(x)).slice(0, 12));
    console.error('http extra:  ', [...tHttp].filter((x) => !gHttp.has(x)).slice(0, 12));
    console.error('entity missing:', [...gEnt].filter((x) => !tEnt.has(x)).slice(0, 12));
    console.error('entity extra:  ', [...tEnt].filter((x) => !gEnt.has(x)).slice(0, 12));
  }
}

// Run as a script (not when imported by the vitest). Matched by entrypoint PATH,
// not by comparing import.meta.url to argv[1]: the single-file CLI bundle folds
// every module into one file, so that comparison is true for every module and
// main() hijacks any `coredoc <cmd>` invocation. Same guard shape as
// packages/mcp/src/index.ts.
const _entrypoint = process.argv[1]?.replace(/\\/g, '/');
if (_entrypoint?.endsWith('substrate/run.ts') || _entrypoint?.endsWith('substrate/run.js')) {
  main().catch((e) => {
    console.error('[substrate] FAILED:', e);
    process.exit(1);
  });
}
