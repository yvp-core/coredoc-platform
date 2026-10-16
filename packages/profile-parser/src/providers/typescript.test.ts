import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreProfile } from '../score.js';
import { typescriptProvider } from './typescript.js';

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('TypeScript without installed repository dependencies', () => {
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
