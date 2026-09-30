/**
 * The run envelope every optional SCIP indexer shares, so the isolation and caching rules are
 * written once instead of once per language.
 *
 * The shell owns: the prerequisite gate, the content-addressed cache directory, a private
 * scratch dir that is the run's ONLY writable root and is removed on every exit path, the
 * source snapshot — copied into the scratch dir, or read in place and re-fingerprinted after the
 * run — index validation, publication, reuse of a published generation, and turning a failure into
 * a `degradeReason` while letting an abort propagate.
 *
 * The shell does NOT own the sandbox: the argv, `readRoots`, `env` and any probe stay inside the
 * caller's `index()` body, because those are the security boundary and they are not the same
 * shape twice. Nothing here knows which indexer is running — the setup message, the cache
 * subdirectory and the failure prefix all come from the spec.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { enumerateRepoFiles } from '../discovery/discover.js';
import { loadScip } from './decode.js';
import { outsideSource } from './isolated-process.js';
import type { IndexerResult } from './run-indexer.js';
import { copyIndexSource, readIndexSource } from './source-copy.js';
import {
  cachedOptionalScip,
  copyOptionalScip,
  type OptionalScipResult,
  publishOptionalScip,
  type ScipArtifact,
} from './source-manifest.js';

/** The content-addressed view of the repository inputs an indexer is allowed to read. */
export type IndexSource = ReturnType<typeof copyIndexSource>;

export interface IndexerContext {
  /** The repository root, resolved through symbolic links. */
  root: string;
  /** Private scratch directory: the run's only writable root, removed when it ends. */
  work: string;
  /** Where published indexes for this repository live. */
  output: string;
  /**
   * Where the indexer keeps its own build/dependency caches: a directory that survives the run
   * when the spec reuses generations, otherwise the scratch dir that is removed with it.
   */
  cache: string;
  /** The repository's files, enumerated once. */
  files: string[];
  /** The source snapshot the indexer reads: a private copy, or the checkout itself when `inPlace`. */
  snapshot: IndexSource;
  /** The published path this run will write. */
  target: string;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
}

export interface IndexerSpec {
  /** The indexer's own name, used for the failure message and the `degradeReason` prefix. */
  degradePrefix: string;
  /** Cache subdirectory under the per-repository index directory. */
  outSubdir: string;
  /** Null when this indexer can run here; otherwise the reason the caller degrades to basic analysis. */
  prereqs(repoRoot: string): string | null;
  /** The repository files to snapshot. Throws when the repository lacks what this indexer needs. */
  inputs(files: string[], root: string): string[];
  /**
   * Run the indexer and return the index file to publish — or undefined when `ctx.target` already
   * holds a usable index and nothing new was produced.
   */
  index(ctx: IndexerContext): Promise<string | undefined>;
  /** Whether a produced index is usable. Default: decoded cleanly and carries occurrences. */
  validate?(indexPath: string): boolean;
  /** The index's identity beyond its sources. Default: the snapshot hash alone. */
  cacheKey?(snapshot: IndexSource, root: string): string;
  /**
   * Read the checkout's inputs in place instead of copying them into the scratch dir — for
   * indexers that compile the repository and must see it at its own paths. The `index()` body is
   * then responsible for granting the sandbox read access to exactly `snapshot.sourceHashes`, and
   * the shell re-fingerprints those files afterwards, so a checkout edited (or edited and reverted)
   * during compilation is refused instead of published.
   */
  inPlace?: boolean;
  /**
   * Keep ONE published generation plus a build cache that outlives the run, instead of a file
   * named after the source hash and a scratch-only build. `cacheKey` then identifies the toolchain
   * and platform inside the published manifest: a run whose sources and key match reuses that
   * generation without invoking the indexer, and `outDir` receives a copy under `exportFile`
   * rather than holding the cache itself. The captured bytes, never the replaceable cache path,
   * are what the run returns.
   */
  reuse?: {
    /** Basename of the single published generation under the per-repository index directory. */
    cacheFile: string;
    /** Basename of the copy written into the caller's `outDir`. */
    exportFile: string;
    /** Logged when the published generation is reused instead of re-indexing. */
    reusing: string;
  };
}

function decodesWithOccurrences(indexPath: string): boolean {
  const loaded = loadScip(indexPath);
  return !loaded.lenientUtf8 && loaded.documents.some((doc) => doc.occurrences.length > 0);
}

export async function runIndexer(
  spec: IndexerSpec,
  repoRoot: string,
  options: { outDir?: string; signal?: AbortSignal; onLog?: (text: string) => void } = {},
): Promise<IndexerResult & OptionalScipResult> {
  const issue = spec.prereqs(repoRoot);
  if (issue) return { ok: false, degradeReason: issue };
  const root = realpathSync(repoRoot);
  const reuse = spec.reuse;
  const home = join(
    resolveCoredocHome(),
    'scip',
    createHash('sha256').update(root).digest('hex').slice(0, 16),
    spec.outSubdir,
  );
  // Refuses an output directory inside the checkout BEFORE anything is created, so a bad caller
  // fails loudly rather than degrading to basic analysis. A reused generation always lives in the
  // per-repository directory: one request's output directory must not turn the build cache cold.
  const output = outsideSource(root, reuse ? home : (options.outDir ?? home));
  mkdirSync(output, { recursive: true });
  const work = mkdtempSync(join(output, 'run-'));
  let cache = work;
  if (reuse) {
    cache = join(output, 'cache');
    mkdirSync(cache, { recursive: true });
  }
  /** Hand back the captured generation, plus a copy in the caller's output directory. */
  const deliver = (scip: ScipArtifact, exportFile: string): IndexerResult & OptionalScipResult => {
    if (!options.outDir) return { ok: true, scip };
    const dir = outsideSource(root, options.outDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, exportFile);
    copyOptionalScip(scip, path);
    return { ok: true, scip, scipPath: path };
  };
  try {
    const files = enumerateRepoFiles(root);
    const inputs = spec.inputs(files, root);
    const snapshot = spec.inPlace ? readIndexSource(root, inputs) : copyIndexSource(root, work, inputs);
    const key = spec.cacheKey?.(snapshot, root) ?? snapshot.hash;
    const target = join(output, reuse ? reuse.cacheFile : `${key}.scip`);
    if (reuse) {
      const cached = cachedOptionalScip(target, key);
      if (cached) {
        options.signal?.throwIfAborted();
        options.onLog?.(reuse.reusing);
        return deliver(cached, reuse.exportFile);
      }
    }
    const produced = await spec.index({
      root,
      work,
      output,
      cache,
      files,
      snapshot,
      target,
      signal: options.signal,
      onLog: options.onLog,
    });
    if (produced === undefined) return { ok: true, scipPath: target };
    if (!(spec.validate ?? decodesWithOccurrences)(produced))
      throw new Error(`${spec.degradePrefix} produced no valid index.`);
    if (spec.inPlace) {
      const current = readIndexSource(root, spec.inputs(enumerateRepoFiles(root), root));
      if (current.hash !== snapshot.hash || current.stamp !== snapshot.stamp)
        throw new Error('Repository source changed during indexing. Re-run analysis.');
      options.signal?.throwIfAborted();
    }
    const published = publishOptionalScip(produced, target, snapshot, reuse ? key : undefined);
    return reuse ? deliver(published, reuse.exportFile) : { ok: true, scipPath: target };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      ok: false,
      degradeReason: `${spec.degradePrefix}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
