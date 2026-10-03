/**
 * The skeleton's contract, through `parseSubstrate` only: tree release on every exit path,
 * skipped files as `ParseError`s, owned stats, and the `enhanceCalls` rules. The table at the
 * bottom pins tree conservation for every real substrate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withOptionalIndexHost } from '../facts/scip/index-host.js';
import { goProvider } from '../providers/go.js';
import { kotlinProvider } from '../providers/kotlin.js';
import { pythonProvider } from '../providers/python.js';
import { rubyProvider } from '../providers/ruby.js';
import { rustProvider } from '../providers/rust.js';
import { swiftProvider } from '../providers/swift.js';
import { zigProvider } from '../providers/zig.js';
import type { LanguageProvider } from '../providers/types.js';
import { countTrees } from '../tree-sitter/__fixtures__/count-trees.js';
import type { GoProfile } from '../types.js';
import { applySourceFileScope } from './source-file-scope.js';
import { type Substrate, parseSubstrate } from './parse-substrate.js';

let work: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});

function repo(files: Record<string, string>): string {
  work = mkdtempSync(join(tmpdir(), 'parse-substrate-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    writeFileSync(join(work, rel), text);
  }
  return work;
}

const profile: GoProfile = { parserId: 'skeleton', substrate: { language: 'go' } };

/** A substrate whose scope is exactly `included`, so a missing file exercises the skip path. */
function substrate(included: string[], extract: Substrate<GoProfile>['extract']): Substrate<GoProfile> {
  return {
    language: 'go',
    parserVersion: '0.0.0-test',
    grammar: 'go',
    scope: () => applySourceFileScope(included, ['**/*']),
    extract,
  };
}

describe('parseSubstrate', () => {
  it('stamps identity and owns the file counts', async () => {
    const root = repo({ 'a.go': 'package a\n', 'b.go': 'package b\n' });
    const parsed = await parseSubstrate(
      substrate(['a.go', 'b.go', 'gone.go'], async () => ({ type: 'backend' })),
      profile,
      { repoRoot: root, repoName: 'r', repoKey: 'key' },
    );
    expect(parsed).toMatchObject({ name: 'r', path: root, parserId: 'skeleton', parserVersion: '0.0.0-test' });
    expect(parsed.id).toBe(new StableIdGenerator(root, 'key').getRepoHash());
    expect(parsed.stats).toMatchObject({ totalFiles: 3, parsedFiles: 2, skippedFiles: 1 });
    expect(parsed.errors).toEqual([
      { file: 'gone.go', message: 'go: file could not be read or parsed', severity: 'error' },
    ]);
  });

  it('frees every tree when extract throws', async () => {
    const root = repo({ 'a.go': 'package a\n', 'b.go': 'package b\n' });
    const counts = await countTrees(async () => {
      await expect(
        parseSubstrate(
          substrate(['a.go', 'b.go'], async () => {
            throw new Error('lane failed');
          }),
          profile,
          { repoRoot: root, repoName: 'r' },
        ),
      ).rejects.toThrow('lane failed');
    });
    expect(counts.created).toBe(2);
    expect(counts.released).toBe(2);
  });

  it('keeps trees alive for extract, including the SCIP merge', async () => {
    const root = repo({ 'a.go': 'package a\n' });
    let seenType: string | undefined;
    await withOptionalIndexHost(
      async () => ({ basic: true }),
      () =>
        parseSubstrate(
          {
            ...substrate(['a.go'], async ({ files, enhanceCalls }) => {
              await enhanceCalls({ calls: [], stats: { callSites: 0, resolvedCalls: 0 } as never });
              seenType = files[0].root.type;
              return {};
            }),
            scip: { language: 'go', run: vi.fn(), facts: vi.fn() },
          },
          profile,
          { repoRoot: root, repoName: 'r' },
        ),
    );
    expect(seenType).toBe('source_file');
  });

  it('records the analysis mode from enhanceCalls and allows it once', async () => {
    const root = repo({ 'a.go': 'package a\n' });
    const parsed = await withOptionalIndexHost(
      async () => ({ basic: true }),
      () =>
        parseSubstrate(
          {
            ...substrate(['a.go'], async ({ enhanceCalls }) => {
              const basic = { calls: [], stats: { callSites: 0, resolvedCalls: 0 } as never };
              await enhanceCalls(basic);
              await expect(enhanceCalls(basic)).rejects.toThrow('callable once');
              return {};
            }),
            scip: { language: 'go', run: vi.fn(), facts: vi.fn() },
          },
          profile,
          { repoRoot: root, repoName: 'r' },
        ),
    );
    expect(parsed.stats.analysis).toEqual([
      { language: 'go', mode: 'basic', compilerReceiverTypes: false, fallback: false },
    ]);
  });

  it('refuses enhanceCalls without a scip spec', async () => {
    const root = repo({ 'a.go': 'package a\n' });
    await expect(
      parseSubstrate(
        substrate(['a.go'], async ({ enhanceCalls }) => {
          await enhanceCalls({ calls: [], stats: {} as never });
          return {};
        }),
        profile,
        { repoRoot: root, repoName: 'r' },
      ),
    ).rejects.toThrow('needs Substrate.scip');
  });
});

// Every substrate frees every tree it parses on a normal run. A substrate added to this table
// is covered for the leak class that once took real runs past web-tree-sitter's 2GB heap.
const SUBSTRATES: [string, LanguageProvider, Record<string, string>][] = [
  ['go', goProvider, { 'go.mod': 'module x\n', 'main.go': 'package main\nfunc main() { run() }\nfunc run() {}\n' }],
  ['python', pythonProvider, { 'app.py': 'def main():\n    run()\n\ndef run():\n    pass\n' }],
  ['rust', rustProvider, { 'src/lib.rs': 'pub fn a() {}\n' }],
  ['ruby', rubyProvider, { 'app/a.rb': 'class A\n  def run; end\nend\n' }],
  ['kotlin', kotlinProvider, { 'A.kt': 'package a\nclass A\n' }],
  ['swift', swiftProvider, { 'App.swift': 'func main() { run() }\nfunc run() {}\n' }],
  ['zig', zigProvider, { 'src/main.zig': 'pub fn main() void {}\n' }],
];

describe.each(SUBSTRATES)('%s substrate tree conservation', (language, provider, files) => {
  it('releases every tree it creates', async () => {
    const root = repo(files);
    const counts = await countTrees(async () => {
      await provider.parse({ parserId: 't', substrate: { language } }, { repoRoot: root, repoName: 'r' });
    });
    expect(counts.created).toBeGreaterThan(0);
    expect(counts.released).toBe(counts.created);
  });
});
