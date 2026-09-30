import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

// Vue-only analysis is structurally complete by design, so its healthy basic result can be
// cached without an installed indexer. Degraded TS/JS cache retries are covered in providers/typescript.test.ts.
const profile: ExtractionProfile = {
  parserId: 'inc-test-v1',
  substrate: { language: 'ts', include: ['src/**/*.vue'], exclude: [] },
};

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runProfile — incremental clean-skip', () => {
  it('reuses the cache when nothing changed, and re-parses when a source file changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-inc-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.vue'), '<script lang="ts">export class A { run() { return 1; } }</script>');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock: 1');
    const cacheDir = join(dir, '.cache');

    // 1. Cold run (empty cache) → full parse, writes manifest + cached repo, returns the engine.
    const cold = await runProfile(profile, dir, 'inc', undefined, { incremental: true, cacheDir });
    expect(cold.repo.functions.length).toBeGreaterThan(0); // a real parse happened
    expect(cold.engine).toBeDefined();

    // 2. Tamper the cached repo with a sentinel name; the manifest still matches the unchanged tree.
    //    If a re-run returns the sentinel, it PROVABLY reused the cache instead of re-parsing.
    writeFileSync(join(cacheDir, 'parsed.json'), JSON.stringify({ ...cold.repo, name: 'SENTINEL' }));

    // 3. Re-run, nothing changed → CLEAN SKIP: returns the cached (sentinel) repo, builds no engine.
    const clean = await runProfile(profile, dir, 'inc', undefined, { incremental: true, cacheDir });
    expect(clean.repo.name).toBe('SENTINEL'); // cache hit, no re-parse
    expect(clean.engine).toBeUndefined(); // clean skip never constructs the engine / runs SCIP

    // 4. Edit a source file → manifest mismatch → FULL re-parse, bypassing the stale sentinel.
    writeFileSync(
      join(dir, 'src', 'a.vue'),
      '<script lang="ts">export class A { run() { return 2; } other() { return 3; } }</script>',
    );
    const dirty = await runProfile(profile, dir, 'inc', undefined, { incremental: true, cacheDir });
    expect(dirty.repo.name).toBe('inc'); // a real parse (not the sentinel)
    expect(dirty.engine).toBeDefined();

    // 5. The cache was refreshed by the dirty run → a subsequent clean run reuses the FRESH parse.
    const after = await runProfile(profile, dir, 'inc', undefined, { incremental: true, cacheDir });
    expect(after.repo.name).toBe('inc'); // the refreshed cache, not the discarded sentinel
    expect(after.engine).toBeUndefined();
  });

  it('is a no-op (always full-parses) when incremental is off — default behavior unchanged', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-inc-off-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.vue'), '<script lang="ts">export class A { run() { return 1; } }</script>');
    // No opts → no cache read or written, engine always present.
    const r1 = await runProfile(profile, dir, 'inc');
    expect(r1.engine).toBeDefined();
    const r2 = await runProfile(profile, dir, 'inc');
    expect(r2.engine).toBeDefined();
    expect(r2.repo.name).toBe('inc');
  });
});
