import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { create, toBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@scip-code/scip';
import { afterEach, expect, it, vi } from 'vitest';
import { runScipGo } from '../../substrate/go/scip-run.js';
import { runScipRust } from '../../substrate/rust/scip-run.js';
import { runIsolatedProcess } from './isolated-process.js';
import { loadOptionalScip } from './source-manifest.js';
import { optionalAnalysis } from './index-host.js';

const state = vi.hoisted(() => ({ sdk: '', appleIdentity: 'native-v1' }));
vi.mock('../../substrate/go/scip-tool.js', () => ({
  goScipPrereqs: () => null,
  goScipTools: () => ({ go: join(state.sdk, 'go'), indexer: join(state.sdk, 'scip-go'), sdk: state.sdk }),
}));
vi.mock('../../substrate/rust/scip-tool.js', () => ({
  rustScipPrereqs: () => null,
  rustScipTools: () => ({
    cargo: join(state.sdk, 'cargo'),
    rustc: join(state.sdk, 'rustc'),
    indexer: join(state.sdk, 'rust-analyzer'),
    sdk: state.sdk,
  }),
}));
vi.mock('./apple-toolchain.js', () => ({
  appleToolchain: () => ({ env: {}, readRoots: [], bin: '', cacheIdentity: state.appleIdentity }),
}));
vi.mock('./homebrew-runtime.js', () => ({ homebrewRuntimeReadRoots: () => [] }));
vi.mock('./isolated-process.js', async (original) => ({
  ...(await original<typeof import('./isolated-process.js')>()),
  runIsolatedProcess: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  state.appleIdentity = 'native-v1';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  'go',
  'rust',
] as const)('%s reuses source/tool-matched indexes and warm caches, preserving the last success on failure', async (language) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'direct-index-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  state.sdk = join(root, 'sdk');
  mkdirSync(state.sdk);
  for (const tool of ['go', 'scip-go', 'cargo', 'rustc', 'rust-analyzer'])
    writeFileSync(join(state.sdk, tool), 'tool v1');
  vi.stubEnv('COREDOC_HOME', join(root, 'coredoc'));
  const file = language === 'go' ? 'main.go' : 'src/lib.rs';
  writeFileSync(join(repo, file), language === 'go' ? 'package main\nfunc main() {}' : 'pub fn run() {}');
  writeFileSync(
    join(repo, language === 'go' ? 'go.mod' : 'Cargo.toml'),
    language === 'go' ? 'module example.com/fixture\ngo 1.23\n' : '[package]\nname="fixture"\nversion="0.1.0"\n',
  );
  const run = language === 'go' ? runScipGo : runScipRust;
  let builds = 0;
  let fail = false;
  let cancel: AbortController | undefined;
  let editDuringBuild = false;
  const dependencyCaches: string[] = [];
  vi.mocked(runIsolatedProcess).mockImplementation(async (_command, args, options) => {
    if (args[0] === '--version') return 'rust-analyzer 0.3.3049-standalone';
    builds++;
    expect(options.cwd).toBe(repo);
    expect(options.sourceFiles).toContain(file);
    expect(options.writeRoots).not.toContain(repo);
    const cache = (language === 'go' ? options.env?.GOMODCACHE : options.env?.CARGO_HOME)!;
    dependencyCaches.push(cache);
    mkdirSync(cache, { recursive: true });
    if (builds > 1) expect(readFileSync(join(cache, 'downloaded'), 'utf8')).toBe('dependency');
    writeFileSync(join(cache, 'downloaded'), 'dependency');
    if (fail) throw new Error('fixture build failed');
    writeFileSync(
      args[args.indexOf('--output') + 1],
      toBinary(
        IndexSchema,
        create(IndexSchema, {
          metadata: { projectRoot: `file://${repo}` },
          documents: [{ relativePath: file, occurrences: [{ range: [0, 0, 1], symbol: 'local 0', symbolRoles: 1 }] }],
        }),
      ),
    );
    if (language === 'rust') writeFileSync(options.env!.RA_LOG_FILE!, 'DEBUG load_cargo: LoadCargoConfig\n');
    cancel?.abort();
    if (editDuringBuild) {
      const path = join(repo, file);
      const source = readFileSync(path);
      writeFileSync(path, 'temporary editor changes');
      writeFileSync(path, source);
      utimesSync(path, new Date(0), new Date(0));
    }
    return '';
  });
  const first = await run(repo);
  expect(first.ok, first.degradeReason).toBe(true);
  const cachePath = join(
    root,
    'coredoc/scip',
    createHash('sha256').update(repo).digest('hex').slice(0, 16),
    language,
    'latest.scip-cache',
  );
  const saved = readFileSync(cachePath);
  const expectedIndex = loadOptionalScip(first.scip!);
  // Different request output directories must not turn the persistent cache cold.
  const second = await run(repo, { outDir: join(root, 'request-2') });
  expect(second.ok).toBe(true);
  expect(loadOptionalScip(second.scipPath!).sourceHashes).toEqual(loadOptionalScip(first.scip!).sourceHashes);
  expect(builds).toBe(1);
  for (const outDir of [undefined, join(root, 'request-interleaved')]) {
    const received = await run(repo, {
      outDir,
      onLog(message) {
        if (!message.startsWith('Reusing')) return;
        const replacement = deserialize(saved);
        replacement.cacheKey = 'different-toolchain-or-manifest';
        replacement.scip = Buffer.from(
          toBinary(
            IndexSchema,
            create(IndexSchema, {
              metadata: { projectRoot: 'file:///competing-run' },
              documents: [
                { relativePath: file, occurrences: [{ range: [0, 0, 1], symbol: 'local 1', symbolRoles: 1 }] },
              ],
            }),
          ),
        );
        replacement.indexSha256 = createHash('sha256').update(replacement.scip).digest('hex');
        writeFileSync(cachePath, serialize(replacement));
      },
    });
    expect(received.ok).toBe(true);
    expect(loadOptionalScip(received.scip ?? received.scipPath!)).toEqual(expectedIndex);
    if (received.scipPath) expect(loadOptionalScip(received.scipPath)).toEqual(expectedIndex);
    expect(await optionalAnalysis(language, { fallback: false }, async () => received, loadOptionalScip)).toMatchObject(
      {
        result: expectedIndex,
        analysis: { mode: 'enhanced', fallback: false },
      },
    );
    writeFileSync(cachePath, saved);
  }
  writeFileSync(join(repo, file), `${readFileSync(join(repo, file), 'utf8')}\n// edited\n`);
  fail = true;
  expect((await run(repo)).ok).toBe(false);
  expect(readFileSync(cachePath)).toEqual(saved);
  fail = false;
  expect((await run(repo)).ok).toBe(true);
  expect(new Set(dependencyCaches).size).toBe(1);
  expect(readFileSync(cachePath)).not.toEqual(saved);
  expect(readdirSync(join(cachePath, '..')).sort()).toEqual(['cache', 'latest.scip-cache']);
  const indexer = join(state.sdk, language === 'go' ? 'scip-go' : 'rust-analyzer');
  writeFileSync(indexer, 'tool v2 with changed bytes');
  expect((await run(repo)).ok).toBe(true);
  expect(builds).toBe(4);
  state.appleIdentity = 'native-v2-at-the-same-paths';
  expect((await run(repo)).ok).toBe(true);
  expect(builds).toBe(5);
  const latest = readFileSync(cachePath);
  writeFileSync(join(repo, file), `${readFileSync(join(repo, file), 'utf8')}\n// another edit\n`);
  cancel = new AbortController();
  await expect(run(repo, { signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(readFileSync(cachePath)).toEqual(latest);
  cancel = undefined;
  editDuringBuild = true;
  expect(await run(repo)).toMatchObject({ ok: false, degradeReason: expect.stringContaining('source changed') });
  expect(readFileSync(cachePath)).toEqual(latest);
});
