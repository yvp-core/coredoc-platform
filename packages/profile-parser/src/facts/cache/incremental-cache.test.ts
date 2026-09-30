import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../../types.js';
import {
  type ParseManifest,
  buildManifest,
  fingerprintProfile,
  loadCachedRepo,
  loadManifest,
  manifestsMatch,
  writeCache,
} from './incremental-cache.js';

const baseProfile: ExtractionProfile = {
  parserId: 'test-parser-v1',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/*.test.ts'] },
};

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'cg-cache-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(d, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}

describe('incremental-cache change detection (the soundness contract)', () => {
  it('matches an identical tree (clean) and is deterministic', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;', 'pnpm-lock.yaml': 'lock: 1' });
    const m1 = buildManifest(baseProfile, dir, ['src/a.ts']);
    const m2 = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(m1).toEqual(m2); // deterministic
    expect(manifestsMatch(m1, m2)).toBe(true);
  });

  it('misses when a file CONTENT changes', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;' });
    const before = buildManifest(baseProfile, dir, ['src/a.ts']);
    writeFileSync(join(dir, 'src/a.ts'), 'export const x = 2;'); // edit
    const after = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(manifestsMatch(before, after)).toBe(false);
  });

  it('misses when a file is ADDED to the discovered set', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;', 'src/b.ts': 'export const y = 2;' });
    const before = buildManifest(baseProfile, dir, ['src/a.ts']);
    const after = buildManifest(baseProfile, dir, ['src/a.ts', 'src/b.ts']);
    expect(manifestsMatch(before, after)).toBe(false);
  });

  it('misses when a file is REMOVED from the discovered set', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;', 'src/b.ts': 'export const y = 2;' });
    const before = buildManifest(baseProfile, dir, ['src/a.ts', 'src/b.ts']);
    const after = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(manifestsMatch(before, after)).toBe(false);
  });

  it('misses when the PROFILE changes (scope glob)', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;' });
    const before = buildManifest(baseProfile, dir, ['src/a.ts']);
    const widened: ExtractionProfile = {
      ...baseProfile,
      substrate: { ...baseProfile.substrate, include: ['src/**/*.ts', 'app/**/*.ts'] },
    };
    const after = buildManifest(widened, dir, ['src/a.ts']);
    expect(manifestsMatch(before, after)).toBe(false);
  });

  it('misses when a customRule function BODY changes (fingerprint includes function source)', () => {
    const p1: ExtractionProfile = {
      ...baseProfile,
      customRules: [{ name: 'r', phase: 'complete', run: () => 'original-body' }],
    };
    const p2: ExtractionProfile = {
      ...baseProfile,
      customRules: [{ name: 'r', phase: 'complete', run: () => 'changed-body' }],
    };
    expect(fingerprintProfile(p1)).not.toBe(fingerprintProfile(p2));
  });

  it('misses when the dependency LOCKFILE changes', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;', 'pnpm-lock.yaml': 'lock: 1' });
    const before = buildManifest(baseProfile, dir, ['src/a.ts']);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lock: 2'); // dep upgrade
    const after = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(manifestsMatch(before, after)).toBe(false);
  });

  it('misses when dependencies are installed or removed without changing the lockfile', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;', 'pnpm-lock.yaml': 'lock: 1' });
    const basic = buildManifest(baseProfile, dir, ['src/a.ts']);
    mkdirSync(join(dir, 'node_modules'));
    const installed = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(manifestsMatch(basic, installed)).toBe(false);
    rmSync(join(dir, 'node_modules'), { recursive: true });
    const removed = buildManifest(baseProfile, dir, ['src/a.ts']);
    expect(manifestsMatch(installed, removed)).toBe(false);
    expect(manifestsMatch(basic, removed)).toBe(true);
  });

  it('misses when parserVersion differs (manifest from an older engine)', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;' });
    const current = buildManifest(baseProfile, dir, ['src/a.ts']);
    const stale: ParseManifest = { ...current, parserVersion: '0.0.0-old' };
    expect(manifestsMatch(stale, current)).toBe(false);
  });

  it('round-trips manifest + repo through the cache dir', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;' });
    const cacheDir = join(dir, '.cache');
    const manifest = buildManifest(baseProfile, dir, ['src/a.ts']);
    const repo = { id: 'r', name: 'demo', functions: [{ id: 'f1' }] } as never;
    writeCache(cacheDir, manifest, repo);
    expect(loadManifest(cacheDir)).toEqual(manifest);
    expect(loadCachedRepo(cacheDir)).toEqual(repo);
  });

  it('loads null from an empty/absent cache dir (cold start)', () => {
    dir = repoWith({ 'src/a.ts': 'export const x = 1;' });
    expect(loadManifest(join(dir, 'nope'))).toBeNull();
    expect(loadCachedRepo(join(dir, 'nope'))).toBeNull();
  });
});
