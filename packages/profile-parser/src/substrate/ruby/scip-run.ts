import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadScip } from '../../facts/scip/decode.js';
import { runIndexer } from '../../facts/scip/indexer-shell.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';
import { loadOptionalScip } from '../../facts/scip/source-manifest.js';
import { installedRubyTool, rubyScipPrereqs, rubyToolRelease } from './scip-tool.js';
export { rubyScipPrereqs } from './scip-tool.js';

/**
 * A usable scip-ruby index: decodes cleanly AND carries scip-ruby's own symbols. The stricter
 * symbol check is what lets a cached file be trusted without re-running the indexer.
 */
function valid(path: string): boolean {
  try {
    const index = loadScip(path);
    return (
      !index.lenientUtf8 &&
      index.documents.some((doc) => doc.occurrences.some((o) => o.symbol.startsWith('scip-ruby ')))
    );
  } catch {
    return false;
  }
}

export async function runScipRuby(
  repoRoot: string,
  options: { outDir?: string; signal?: AbortSignal; onLog?: (text: string) => void } = {},
) {
  return runIndexer(
    {
      degradePrefix: 'scip-ruby',
      outSubdir: 'ruby',
      prereqs: rubyScipPrereqs,
      inputs: (files) => files.filter((file) => /\.rbi?$/.test(file)),
      // The pinned tool release is part of the identity: a different scip-ruby spells symbols
      // differently over the same sources, so its output must not be served from this cache.
      cacheKey: (snapshot) =>
        createHash('sha256')
          .update(snapshot.hash)
          .update(rubyToolRelease().sha256)
          .update('no-config-stable-identity-v2')
          .digest('hex'),
      validate: valid,
      index: async (ctx) => {
        if (existsSync(ctx.target) && valid(ctx.target)) {
          try {
            loadOptionalScip(ctx.target);
            return undefined;
          } catch {
            // Older or interrupted cache entries rebuild with their source manifest.
          }
        }
        // Resolved from the caller's path, not the realpath'd root: that is where the tool
        // lookup and its prerequisite check already agreed the indexer lives.
        const tool = installedRubyTool(repoRoot)!;
        const index = join(ctx.work, 'index.scip');
        await runIsolatedProcess(
          tool,
          ['--no-config', '--suppress-non-critical', '--gem-metadata', 'coredoc-local@0', '--index-file', index, '.'],
          {
            label: 'Ruby',
            cwd: ctx.snapshot.root,
            sourceRoot: ctx.root,
            readRoots: [dirname(tool)],
            writeRoots: [ctx.work],
            signal: ctx.signal,
            onLog: ctx.onLog,
            env: { PATH: '/usr/bin:/bin', HOME: ctx.work, TMPDIR: ctx.work },
          },
        );
        return index;
      },
    },
    repoRoot,
    options,
  );
}
