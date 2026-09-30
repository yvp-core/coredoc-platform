/**
 * Package enumeration walks every package.json in the repo, which is a wider set than the
 * profile's parsed surface. Vendored grammars and test fixtures ship manifests, so without
 * scoping they surface as Package nodes owning no files — 7 of gitnexus's 11 packages were
 * this kind of noise. Asserts the scope step drops them and keeps the ones that own code.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeFile(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

describe('package scoping', () => {
  it('keeps packages that own parsed files and drops the ones excluded from the substrate', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-pkg-'));
    writeFile('package.json', JSON.stringify({ name: 'root' }));
    writeFile('app/package.json', JSON.stringify({ name: '@acme/app' }));
    writeFile('app/src/main.ts', 'export function main() { return 1; }\n');
    // Both carry a manifest but neither is in the profile's substrate scope.
    writeFile('vendor/tree-sitter-dart/package.json', JSON.stringify({ name: 'tree-sitter-dart' }));
    writeFile('vendor/tree-sitter-dart/index.ts', 'export const grammar = {};\n');
    writeFile('app/test/fixtures/demo/package.json', JSON.stringify({ name: 'demo-fixture' }));
    writeFile('app/test/fixtures/demo/index.ts', 'export const fixture = 1;\n');

    const profile: ExtractionProfile = {
      parserId: 'test-package-scope',
      substrate: {
        language: 'ts',
        include: ['app/**/*.ts'],
        exclude: ['**/node_modules/**', '**/vendor/**', '**/test/**'],
      },
    };
    const { repo } = await runProfile(profile, dir, 'pkg-test');

    expect(repo.packages.map((p) => p.path).sort()).toEqual(['.', 'app']);
    expect(repo.files.map((f) => f.path)).toEqual(['app/src/main.ts']);
  });

  it('keeps every package in a repo whose packages are all in scope', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-pkg-'));
    writeFile('package.json', JSON.stringify({ name: 'root' }));
    writeFile('a/package.json', JSON.stringify({ name: '@acme/a' }));
    writeFile('a/index.ts', 'export const a = 1;\n');
    writeFile('b/package.json', JSON.stringify({ name: '@acme/b' }));
    writeFile('b/index.ts', 'export const b = 2;\n');

    const profile: ExtractionProfile = {
      parserId: 'test-package-scope-all',
      substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    };
    const { repo } = await runProfile(profile, dir, 'pkg-test-all');

    expect(repo.packages.map((p) => p.path).sort()).toEqual(['.', 'a', 'b']);
  });
});
