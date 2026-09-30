import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runScipRust } from './scip-run.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';

const state = vi.hoisted(() => ({ sdk: '' }));
vi.mock('./scip-tool.js', () => ({
  rustScipPrereqs: () => null,
  rustScipTools: () => ({
    indexer: join(state.sdk, 'rust-analyzer'),
    cargo: join(state.sdk, 'cargo'),
    rustc: join(state.sdk, 'rustc'),
    sdk: state.sdk,
  }),
}));
vi.mock('../../facts/scip/apple-toolchain.js', () => ({ appleToolchain: () => ({ env: {}, readRoots: [], bin: '' }) }));
vi.mock('../../facts/scip/homebrew-runtime.js', () => ({ homebrewRuntimeReadRoots: () => [] }));
vi.mock('../../facts/scip/isolated-process.js', async (original) => ({
  ...(await original<typeof import('../../facts/scip/isolated-process.js')>()),
  runIsolatedProcess: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'rust-version-'));
  roots.push(root);
  state.sdk = join(root, 'sdk');
  mkdirSync(state.sdk);
  for (const tool of ['rust-analyzer', 'cargo', 'rustc']) writeFileSync(join(state.sdk, tool), 'fixture tool');
  vi.stubEnv('COREDOC_HOME', join(root, 'home'));
  const source = join(root, 'repo');
  mkdirSync(source);
  writeFileSync(join(source, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  writeFileSync(join(source, 'lib.rs'), 'pub fn run() {}');
  vi.mocked(runIsolatedProcess).mockImplementation(async (_command, args, options) => {
    if (args[0] === '--version') return version;
    writeFileSync(
      args[3],
      Buffer.from(
        readFileSync(new URL('./__fixtures__/scip/index.scip.base64', import.meta.url), 'utf8').trim(),
        'base64',
      ),
    );
    writeFileSync(options.env!.RA_LOG_FILE!, 'DEBUG load_cargo: LoadCargoConfig\n');
    return '';
  });
  return runScipRust(source, { outDir: join(root, 'output') });
}

it.each([
  'rust-analyzer 0.3.3050-standalone (new 2026-09-20)',
  'rust-analyzer 1.93.0 (vendor)',
  'unexpected version',
])('does not start indexing an unverified analyzer: %s', async (version) => {
  const result = await run(version);
  expect(result.ok).toBe(false);
  expect(result.degradeReason).toContain(version);
  expect(result.degradeReason).toContain('0.3.3049');
  expect(runIsolatedProcess).toHaveBeenCalledTimes(1);
  expect(runIsolatedProcess).toHaveBeenCalledWith(
    join(state.sdk, 'rust-analyzer'),
    ['--version'],
    expect.objectContaining({ allowNetwork: false, timeoutMs: 10_000 }),
  );
});

it('indexes with the verified standalone analyzer version', async () => {
  const result = await run('rust-analyzer 0.3.3049-standalone (682a84e95b 2026-09-13)\n');
  expect(result.ok, result.degradeReason).toBe(true);
  expect(vi.mocked(runIsolatedProcess).mock.calls.map((call) => call[1][0])).toEqual(['--version', 'scip']);
});
