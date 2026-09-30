import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runScipRuby } from './scip-run.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';

vi.mock('./scip-tool.js', () => ({
  rubyScipPrereqs: () => null,
  installedRubyTool: () => '/trusted/scip-ruby',
  rubyToolRelease: () => ({ sha256: 'pinned-tool-hash' }),
}));
vi.mock('../../facts/scip/isolated-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../facts/scip/isolated-process.js')>()),
  runIsolatedProcess: vi.fn(),
}));
let root: string;
let out: string;
const fixture = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/sample-app/index.scip');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ruby-source-'));
  out = mkdtempSync(join(tmpdir(), 'ruby-index-'));
  writeFileSync(join(root, 'app.rb'), 'class App; def run; 1; end; end');
  vi.mocked(runIsolatedProcess).mockImplementation(async (_command, args, options) => {
    expect(options.cwd).not.toBe(root);
    expect(args).toContain('--no-config');
    expect(readFileSync(join(options.cwd, 'app.rb'), 'utf8')).toContain('class App');
    copyFileSync(fixture, args[args.indexOf('--index-file') + 1]);
    return '';
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  vi.clearAllMocks();
});

it('indexes without a Gemfile, keeps source unchanged, and caches by all Ruby inputs', async () => {
  const first = await runScipRuby(root, { outDir: out });
  expect(first.ok).toBe(true);
  expect(readdirSync(root)).toEqual(['app.rb']);
  expect(await runScipRuby(root, { outDir: out })).toEqual(first);
  expect(runIsolatedProcess).toHaveBeenCalledTimes(1);
  mkdirSync(join(root, 'sorbet'));
  writeFileSync(join(root, 'sorbet', 'types.rbi'), 'class Dependency; end');
  expect((await runScipRuby(root, { outDir: out })).scipPath).not.toBe(first.scipPath);
  expect(runIsolatedProcess).toHaveBeenCalledTimes(2);
  const identities = vi
    .mocked(runIsolatedProcess)
    .mock.calls.map(([, args]) => args[args.indexOf('--gem-metadata') + 1]);
  // An unrelated file invalidates the cache, but cannot rename every Ruby symbol/edge.
  expect(identities[1]).toBe(identities[0]);
});

it('refuses source-local output and does not accept a failed process even if it wrote an index', async () => {
  await expect(runScipRuby(root, { outDir: join(root, 'output') })).rejects.toThrow(/outside/);
  vi.mocked(runIsolatedProcess).mockImplementationOnce(async (_command, args) => {
    copyFileSync(fixture, args[args.indexOf('--index-file') + 1]);
    throw new Error('tool interrupted');
  });
  expect(await runScipRuby(root, { outDir: out })).toMatchObject({
    ok: false,
    degradeReason: expect.stringContaining('interrupted'),
  });
});
