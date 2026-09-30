import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appleToolchain } from '../../facts/scip/apple-toolchain.js';
import { homebrewRuntimeReadRoots } from '../../facts/scip/homebrew-runtime.js';
import { runIndexer } from '../../facts/scip/indexer-shell.js';
import { type IsolatedProcessOptions, runIsolatedProcess } from '../../facts/scip/isolated-process.js';
import { assertRustWorkspaceLoaded, assertSupportedRustAnalyzerVersion } from './load-diagnostics.js';
import { rustIndexInputs } from './scip-inputs.js';
import { rustScipPrereqs, rustScipTools } from './scip-tool.js';

export const RUST_MAC_POLICY = ['(allow signal (target same-sandbox))'];

export async function runScipRust(
  repoRoot: string,
  options: { outDir?: string; signal?: AbortSignal; onLog?: (text: string) => void } = {},
) {
  return runIndexer(
    {
      degradePrefix: 'rust-analyzer',
      outSubdir: 'rust',
      prereqs: rustScipPrereqs,
      inputs: (files) => {
        if (!files.includes('Cargo.toml'))
          throw new Error(
            'Enhanced Rust analysis requires Cargo.toml at the repository root. Use basic analysis for this repository.',
          );
        // Cargo.lock is frequently ignored in library repositories, but is still a compiler input.
        return rustIndexInputs([...files, 'Cargo.lock']);
      },
      // Compiling the crate in place keeps cargo's registry and target directories warm between runs.
      inPlace: true,
      reuse: {
        cacheFile: 'latest.scip-cache',
        exportFile: 'rust-index.scip-cache',
        reusing: 'Reusing the last successful Rust index.',
      },
      // Installation paths cannot identify a toolchain: rustup and Apple update builds in place.
      cacheKey: (snapshot, root) => {
        const apple = appleToolchain(root);
        return JSON.stringify([
          1,
          snapshot.hash,
          process.platform,
          process.arch,
          apple.env,
          apple.cacheIdentity,
          Object.values(rustScipTools(root)).map((path) => [path, statSync(path).mtimeMs, statSync(path).size]),
        ]);
      },
      index: async (ctx) => {
        const tools = rustScipTools(ctx.root);
        const apple = appleToolchain(ctx.root);
        const index = join(ctx.work, 'index.scip');
        const diagnostics = join(ctx.work, 'load.log');
        const isolatedOptions: IsolatedProcessOptions = {
          // rust-analyzer kills and waits for its own proc-macro workers during teardown.
          // This permits signals only within this Rust sandbox, never to host processes.
          macPolicy: RUST_MAC_POLICY,
          label: 'Rust',
          cwd: ctx.snapshot.root,
          sourceRoot: ctx.root,
          sourceFiles: Object.keys(ctx.snapshot.sourceHashes),
          readRoots: [
            dirname(tools.indexer),
            tools.sdk,
            dirname(tools.cargo),
            ...apple.readRoots,
            ...[tools.indexer, tools.cargo, tools.rustc].flatMap(homebrewRuntimeReadRoots),
          ],
          writeRoots: [ctx.work, ctx.cache],
          signal: ctx.signal,
          onLog: ctx.onLog,
          allowNetwork: true,
          failOnOutput: /cargo metadata: failed exit status/,
          env: {
            ...apple.env,
            PATH: [dirname(tools.cargo), apple.bin, '/usr/bin', '/bin'].filter(Boolean).join(':'),
            HOME: ctx.work,
            TMPDIR: ctx.work,
            CARGO: tools.cargo,
            RUSTC: tools.rustc,
            CARGO_HOME: join(ctx.cache, 'cargo'),
            CARGO_TARGET_DIR: join(ctx.cache, 'target'),
            RUST_SRC_PATH: join(tools.sdk, 'lib/rustlib/src/rust/library'),
            // The SCIP command suppresses build-script failures unless load-cargo debug logging is enabled.
            RA_LOG: 'load_cargo=debug',
            RA_LOG_FILE: diagnostics,
          },
        };
        // Probe the selected executable under the same isolation, before executing repository build code.
        const version = await runIsolatedProcess(tools.indexer, ['--version'], {
          ...isolatedOptions,
          allowNetwork: false,
          timeoutMs: 10_000,
          onLog: undefined,
        });
        assertSupportedRustAnalyzerVersion(version);
        await runIsolatedProcess(tools.indexer, ['scip', ctx.snapshot.root, '--output', index], isolatedOptions);
        assertRustWorkspaceLoaded(readFileSync(diagnostics, 'utf8'));
        return index;
      },
    },
    repoRoot,
    options,
  );
}

export { rustScipPrereqs } from './scip-tool.js';
