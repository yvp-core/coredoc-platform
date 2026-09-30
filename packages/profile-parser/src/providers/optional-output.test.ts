import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { goProvider } from './go.js';
import { pythonProvider } from './python.js';
import { rustProvider } from './rust.js';

const { runGo, runPython, runRust } = vi.hoisted(() => ({ runGo: vi.fn(), runPython: vi.fn(), runRust: vi.fn() }));
vi.mock('../substrate/go/scip-run.js', () => ({ runScipGo: runGo }));
vi.mock('../substrate/python/scip-run.js', () => ({ runScipPython: runPython }));
vi.mock('../substrate/rust/scip-run.js', () => ({ runScipRust: runRust }));
afterEach(() => vi.restoreAllMocks());

it.each([
  { language: 'go', provider: goProvider, run: runGo, ext: 'go' },
  { language: 'python', provider: pythonProvider, run: runPython, ext: 'py' },
  { language: 'rust', provider: rustProvider, run: runRust, ext: 'rs' },
] as const)('$language forwards separate index directories for concurrent targets', async ({
  language,
  provider,
  run,
  ext,
}) => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  run.mockResolvedValue({ ok: false, degradeReason: 'fixture tooling unavailable' });
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../substrate', language, '__fixtures__/scip');
  const opts = { repoRoot, repoName: 'fixture', cacheDir: '/cache/shared' };
  const profile = {
    parserId: 'fixture',
    substrate: { language, include: [`**/*.${ext}`], analysis: { mode: 'enhanced' as const } },
  };
  // Each provider gets its own valid discriminated profile through the public parse boundary.
  if (provider.isProfile(profile))
    await Promise.all([
      provider.parse(profile, { ...opts, scipOutDir: '/indexes/first' }),
      provider.parse(profile, { ...opts, scipOutDir: '/indexes/second' }),
    ]);
  expect(run.mock.calls.map(([, options]) => options.outDir).sort()).toEqual(['/indexes/first', '/indexes/second']);
});
