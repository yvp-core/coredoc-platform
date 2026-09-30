// =============================================================================
// parseMultiTarget — run every target of a MultiTargetProfile through its
// LanguageProvider and merge the per-target ParsedRepos into one graph.
// =============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { resolveTargets } from '../providers/resolve.js';
import type { ParseOptions } from '../providers/types.js';
import type { MultiTargetProfile } from '../types/multi-profile.js';
import { mergeParsedRepos } from './merge.js';

/**
 * Targets run in parallel — the heavy parts (SCIP indexers) are independent
 * child processes. Every target shares repoRoot/repoName/repoKey so the merged
 * graph lives in one repoHash id space; incremental caches get a per-target
 * subdirectory so target manifests never collide.
 *
 * SCIP output is isolated per target UNCONDITIONALLY, via `scipOutDir` rather than `cacheDir`.
 * The indexer pool is async (`execFileAsync`, bounded concurrency), and the per-project index
 * filename is derived from the project path alone with no target discriminator — so two targets
 * sharing an output directory interleave `rmSync` → spawn → `loadScip` on the SAME `.scip` files
 * and nondeterministically lose call edges or fail to decode. Two TS/JS targets over one repoRoot
 * hit this, and a shared default directory is exactly what an undefined `cacheDir` used to give
 * them. Isolation must not depend on the caller opting into an incremental cache, hence the
 * separate knob and the temp fallback.
 */
export async function parseMultiTarget(profile: MultiTargetProfile, opts: ParseOptions): Promise<ParsedRepo> {
  const targets = resolveTargets(profile);
  // One scratch root per run when the caller supplied no cacheDir; removed when the run ends.
  const scipRoot = opts.cacheDir ?? mkdtempSync(path.join(tmpdir(), 'coredoc-scip-'));
  const ephemeral = scipRoot !== opts.cacheDir;
  try {
    const results = await Promise.all(
      targets.map(async (t) => ({
        name: t.name,
        repo: await t.provider.parse(t.profile, {
          ...opts,
          cacheDir: opts.cacheDir ? path.join(opts.cacheDir, t.name) : undefined,
          scipOutDir: path.join(scipRoot, t.name),
        }),
      })),
    );
    return mergeParsedRepos(profile.parserId, profile.repoType, results);
  } finally {
    if (ephemeral) rmSync(scipRoot, { recursive: true, force: true });
  }
}
