import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreProfile } from '../score.js';
import { loadCachedRepo, loadManifest, writeCache } from '../facts/cache/incremental-cache.js';
import { typescriptProvider } from './typescript.js';

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('TypeScript without installed repository dependencies', () => {
  it.each([
    'legacy',
    'fallback',
    'partial',
  ])('retries a %s incremental result instead of freezing degraded analysis', async (kind) => {
    root = mkdtempSync(join(tmpdir(), 'coredoc-ts-analysis-cache-'));
    const repoRoot = join(root, 'repo');
    const cacheDir = join(root, 'cache');
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, 'index.ts'), 'export function hello() { return "hello"; }');
    const profile = { parserId: 'test/cached-basic', substrate: { language: 'ts' as const, include: ['**/*.ts'] } };
    const opts = { repoRoot, repoName: 'fixture', incremental: true, cacheDir };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await typescriptProvider.parse(profile, opts);
    const legacy = loadCachedRepo(cacheDir)!;
    if (kind === 'legacy') delete legacy.stats.analysis;
    if (kind === 'partial') {
      legacy.stats.analysis = [{ language: 'ts', mode: 'enhanced', fallback: true, compilerReceiverTypes: false }];
      legacy.errors = [{ file: 'second-project', severity: 'error', message: 'SCIP project timed out' }];
    }
    legacy.functions = []; // A cache hit would return this stale result without re-parsing.
    writeCache(cacheDir, loadManifest(cacheDir)!, legacy);
    const refreshed = await typescriptProvider.parse(profile, opts);
    expect(refreshed.stats.analysis).toEqual(first.stats.analysis);
    expect(refreshed.stats.analysis?.[0].fallback).toBe(true);
    expect(refreshed.functions.map((fn) => fn.name)).toEqual(['hello']);
    expect(loadCachedRepo(cacheDir)?.stats.analysis).toEqual(first.stats.analysis);
  });

  it('reuses unchanged structural errors without retrying successful semantic work', async () => {
    root = mkdtempSync(join(tmpdir(), 'coredoc-structural-cache-'));
    const repoRoot = join(root, 'repo');
    const cacheDir = join(root, 'cache');
    mkdirSync(repoRoot);
    writeFileSync(join(repoRoot, 'App.vue'), '<script setup>function hello() {}</script>');
    const profile = {
      parserId: 'test/structural-cache',
      substrate: { language: 'ts' as const, include: ['**/*.vue'] },
    };
    const opts = { repoRoot, repoName: 'fixture', incremental: true, cacheDir };
    await typescriptProvider.parse(profile, opts);
    const cached = loadCachedRepo(cacheDir)!;
    cached.errors = [{ file: 'App.vue', severity: 'error', message: 'structural parse failed' }];
    writeCache(cacheDir, loadManifest(cacheDir)!, cached);
    expect(await typescriptProvider.parse(profile, opts)).toEqual(cached);
  });

  it('reports Vue-only structural analysis without inventing a failed SCIP request', async () => {
    root = mkdtempSync(join(tmpdir(), 'coredoc-vue-basic-'));
    writeFileSync(join(root, 'App.vue'), '<script setup lang="ts">function hello() { return "hello"; }</script>');
    const parsed = await typescriptProvider.parse(
      {
        parserId: 'test/vue-basic',
        substrate: { language: 'ts', include: ['**/*.vue'] },
      },
      { repoRoot: root, repoName: 'vue-fixture' },
    );
    expect(parsed.files).toHaveLength(1);
    expect(parsed.stats.analysis).toEqual([
      { language: 'ts', mode: 'basic', fallback: false, compilerReceiverTypes: false },
    ]);
  });

  it('parses and scores a nested source package without modifying the repository', async () => {
    root = mkdtempSync(join(tmpdir(), 'coredoc-ts-basic-'));
    const repoRoot = join(root, 'repo');
    const frontend = join(repoRoot, 'frontend');
    mkdirSync(frontend, { recursive: true });
    writeFileSync(join(frontend, 'package.json'), '{"name":"frontend","private":true}');
    writeFileSync(join(frontend, 'index.ts'), 'export function hello() { return "hello"; }\n');
    const profile = {
      parserId: 'test/basic',
      substrate: { language: 'ts' as const, include: ['frontend/**/*.ts'] },
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parsed = await typescriptProvider.parse(profile, { repoRoot, repoName: 'fixture' });
    expect(parsed.functions.some((fn) => fn.name === 'hello')).toBe(true);
    expect(parsed.errors?.filter((error) => error.severity === 'error')).toEqual([]);
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('node_modules') }),
    );
    expect(parsed.stats.analysis).toEqual([
      { language: 'ts', mode: 'basic', fallback: true, compilerReceiverTypes: false },
    ]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('SCIP indexing degraded'));

    const profilePath = join(root, 'profile.ts');
    writeFileSync(profilePath, `export default ${JSON.stringify(profile)};`);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    await expect(scoreProfile(profilePath, repoRoot)).resolves.toBe(true);
    expect(output.join('\n')).toContain('=== Profile completion: PASS ===');
    expect(readdirSync(repoRoot)).toEqual(['frontend']);
    expect(readdirSync(frontend).sort()).toEqual(['index.ts', 'package.json']);
    expect(existsSync(join(repoRoot, 'index.scip'))).toBe(false);
  });
});
