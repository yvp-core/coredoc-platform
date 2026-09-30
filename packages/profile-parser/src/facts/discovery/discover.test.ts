import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('discover', () => {
  it('flags TS prerequisites met when tsconfig + node_modules exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    mkdirSync(join(dir, 'node_modules'));
    const plan = discover(dir);
    expect(plan.languages.typescript.fileCount).toBe(1);
    expect(plan.languages.typescript.scipPrereqsMet).toBe(true);
    expect(plan.languages.typescript.degradeReason).toBeUndefined();
  });

  it('excludes vendored/build/VCS dirs even with source files inside', () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1;');
    // Committed-style vendored / build blobs that must never be parsed — a Yarn-berry
    // zero-installs release (`.yarn/releases/*.cjs`) is the case that inflated the graph.
    mkdirSync(join(dir, '.yarn', 'releases'), { recursive: true });
    writeFileSync(join(dir, '.yarn', 'releases', 'yarn-4.cjs'), 'module.exports = {};');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'a.js'), 'var x = 1;');
    mkdirSync(join(dir, '.worktrees', 'feature', 'src'), { recursive: true });
    writeFileSync(join(dir, '.worktrees', 'feature', 'src', 'duplicate.ts'), 'export const duplicate = true;');
    // The intent overlay lives in `.coredoc/` and must never be ingested as source (BR-10/AC-13).
    mkdirSync(join(dir, '.coredoc'));
    writeFileSync(join(dir, '.coredoc', 'helper.ts'), 'export const leaked = true;');
    const plan = discover(dir);
    const all = [...plan.languages.typescript.files, ...plan.languages.javascript.files];
    expect(all).toEqual(['src/a.ts']); // only the real source file survives
  });

  it('marks TS semantic tier degraded when node_modules missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-'));
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const plan = discover(dir);
    expect(plan.languages.typescript.scipPrereqsMet).toBe(false);
    expect(plan.languages.typescript.degradeReason).toMatch(/node_modules/);
  });
});
