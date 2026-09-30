import { statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DocumentSchema, IndexSchema } from '@scip-code/scip';
import { create, toBinary } from '@bufbuild/protobuf';
import { appleToolchain } from '../../facts/scip/apple-toolchain.js';
import { loadScip } from '../../facts/scip/decode.js';
import { homebrewRuntimeReadRoots } from '../../facts/scip/homebrew-runtime.js';
import { runIndexer } from '../../facts/scip/indexer-shell.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';
import { goIndexInputs } from './scip-inputs.js';
import { goScipPrereqs, goScipTools } from './scip-tool.js';

/** The `go.mod` files that define the modules to index, vendored copies excluded. */
function goModules(files: string[]): string[] {
  return files.filter((file) => /(^|\/)go\.mod$/.test(file) && !file.split('/').includes('vendor')).sort();
}

export async function runScipGo(
  repoRoot: string,
  options: { outDir?: string; signal?: AbortSignal; onLog?: (text: string) => void } = {},
) {
  return runIndexer(
    {
      degradePrefix: 'scip-go',
      outSubdir: 'go',
      prereqs: goScipPrereqs,
      inputs: (files) => {
        if (!goModules(files).length)
          throw new Error('Enhanced Go analysis requires a go.mod module. Use basic analysis for this repository.');
        return goIndexInputs(files);
      },
      // Compiling the modules in place keeps Go's own module and build caches warm between runs.
      inPlace: true,
      reuse: {
        cacheFile: 'latest.scip-cache',
        exportFile: 'go-index.scip-cache',
        reusing: 'Reusing the last successful Go index.',
      },
      // Installation paths cannot identify a toolchain: Go and Apple update builds in place.
      cacheKey: (snapshot, root) => {
        const apple = appleToolchain(root);
        return JSON.stringify([
          1,
          snapshot.hash,
          process.platform,
          process.arch,
          apple.env,
          apple.cacheIdentity,
          Object.values(goScipTools(root)).map((path) => [path, statSync(path).mtimeMs, statSync(path).size]),
        ]);
      },
      // Each module's index is validated as it is produced, before it is merged in; the combined
      // file is this function's own output and is not re-decoded to check itself.
      validate: () => true,
      index: async (ctx) => {
        const tools = goScipTools(ctx.root);
        const apple = appleToolchain(ctx.root);
        const combined = create(IndexSchema);
        for (const [i, module] of goModules(ctx.files).entries()) {
          const path = dirname(module);
          const index = join(ctx.work, `${i}.scip`);
          await runIsolatedProcess(
            tools.indexer,
            [
              '--output',
              index,
              '--module-root',
              join(ctx.snapshot.root, path),
              '--module-version',
              ctx.snapshot.hash,
              '--skip-tests',
              './...',
            ],
            {
              label: 'Go',
              cwd: join(ctx.snapshot.root, path),
              sourceRoot: ctx.root,
              sourceFiles: Object.keys(ctx.snapshot.sourceHashes),
              readRoots: [
                dirname(tools.indexer),
                tools.sdk,
                dirname(tools.go),
                ...apple.readRoots,
                ...[tools.indexer, tools.go].flatMap(homebrewRuntimeReadRoots),
              ],
              writeRoots: [ctx.work, ctx.cache],
              signal: ctx.signal,
              onLog: ctx.onLog,
              allowNetwork: true,
              env: {
                ...apple.env,
                PATH: [dirname(tools.go), apple.bin, '/usr/bin', '/bin'].filter(Boolean).join(':'),
                HOME: ctx.work,
                TMPDIR: ctx.work,
                GOROOT: tools.sdk,
                GOPATH: join(ctx.cache, 'go'),
                GOCACHE: join(ctx.cache, 'build'),
                GOMODCACHE: join(ctx.cache, 'modules'),
                // The checkout is read-only: go must never try to write back go.mod or go.sum.
                GOFLAGS: '-mod=readonly',
                GOTOOLCHAIN: 'local',
                GOENV: 'off',
                GOPACKAGESDRIVER: 'off',
              },
            },
          );
          const loaded = loadScip(index);
          if (loaded.lenientUtf8 || !loaded.documents.some((doc) => doc.occurrences.length))
            throw new Error(`scip-go produced no valid index for ${module}.`);
          for (const doc of loaded.documents) combined.documents.push(createDocument(doc, path));
        }
        const combinedPath = join(ctx.work, 'combined.scip');
        writeFileSync(combinedPath, toBinary(IndexSchema, combined));
        return combinedPath;
      },
    },
    repoRoot,
    options,
  );
}

/** Re-root one module's document at its path within the repository, so the merged index is repo-relative. */
function createDocument(doc: ReturnType<typeof loadScip>['documents'][number], module: string) {
  return create(DocumentSchema, {
    relativePath: module === '.' ? doc.relativePath : `${module}/${doc.relativePath}`,
    positionEncoding: doc.positionEncoding ?? 1,
    occurrences: doc.occurrences,
  });
}

export { goScipPrereqs } from './scip-tool.js';
