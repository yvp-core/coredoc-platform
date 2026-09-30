import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE_DIRS } from '../facts/discovery/ignore.js';
import type { ExtractionProfile } from '../types.js';
import { tsSourceSignals, tsStructuralChecks } from './ts-signals.js';

let fixtureDir: string | undefined;
const originalPath = process.env.PATH;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('TypeScript scoring helper runtime', () => {
  it('reuses the current Node-compatible executable when PATH has no node binary', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-runtime-'));
    const outPath = join(fixtureDir, 'score.json');
    writeFileSync(
      outPath,
      JSON.stringify({
        id: 'fixture',
        name: 'fixture',
        path: fixtureDir,
        files: [],
        functions: [],
        classes: [],
        entrypoints: [],
        entities: [],
        calls: [],
        imports: [],
      }),
    );

    const profile = {
      parserId: 'fixture/runtime',
      substrate: { language: 'ts', include: ['**/*.ts'] },
    } as ExtractionProfile;
    const context = { repoRoot: fixtureDir, outPath, profile, parsed: {} as ParsedRepo };

    // The packed desktop launches scoring with a clean system-only PATH. An empty PATH makes
    // this independent of whether the developer machine happens to expose `node` globally.
    process.env.PATH = fixtureDir;
    process.env.ELECTRON_RUN_AS_NODE = '1';

    expect(tsStructuralChecks(context)).toEqual({ errors: [], redFlags: [] });
  });

  it('scans source with portable grep arguments under the packed system PATH', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-runtime-'));
    const binDir = join(fixtureDir, 'bin');
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(binDir);
    mkdirSync(join(repoRoot, 'apps', 'web'), { recursive: true });
    writeFileSync(join(repoRoot, 'apps', 'web', 'api.ts'), "router.get('/users', handler);\n");
    for (const ignoredDir of DEFAULT_IGNORE_DIRS) {
      mkdirSync(join(repoRoot, ignoredDir), { recursive: true });
      writeFileSync(join(repoRoot, ignoredDir, 'generated.ts'), "router.get('/generated', handler);\n");
    }
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
    const outPath = join(fixtureDir, 'score.json');
    writeFileSync(
      outPath,
      JSON.stringify({
        id: 'fixture',
        name: 'fixture',
        path: repoRoot,
        files: [],
        functions: [],
        classes: [],
        entrypoints: [],
        entities: [],
        calls: [],
        imports: [],
      }),
    );

    const grep = join(binDir, 'grep');
    writeFileSync(
      grep,
      '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --include*|--exclude-dir*) exit 64;; esac; done\nexec /usr/bin/grep "$@"\n',
    );
    chmodSync(grep, 0o755);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;

    const profile = {
      parserId: 'fixture/runtime',
      substrate: { language: 'ts', include: ['**/*.ts'] },
    } as ExtractionProfile;
    const parsed = { files: [], functions: [], classes: [], entrypoints: [], entities: [], calls: [], imports: [] };

    expect(
      tsSourceSignals({ repoRoot, outPath, profile, parsed, sourceFiles: ['apps/web/api.ts'] } as never).http,
    ).toBe(1);
  });

  it('scans tracked and untracked files while excluding gitignored and default-ignored sources', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'profile-score-runtime-'));
    const repoRoot = join(fixtureDir, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(repoRoot, 'generated'), { recursive: true });
    mkdirSync(join(repoRoot, '.cache'), { recursive: true });
    writeFileSync(join(repoRoot, '.gitignore'), 'generated/\n');
    writeFileSync(join(repoRoot, 'src', 'tracked.ts'), "router.get('/tracked', handler);\n");
    writeFileSync(join(repoRoot, 'src', 'untracked.ts'), "router.get('/untracked', handler);\n");
    writeFileSync(join(repoRoot, 'generated', 'ignored.ts'), "router.get('/ignored', handler);\n");
    writeFileSync(join(repoRoot, '.cache', 'cached.ts'), "router.get('/cached', handler);\n");
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
    execFileSync('git', ['-C', repoRoot, 'init', '--quiet']);
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore', 'src/tracked.ts']);

    const outPath = join(fixtureDir, 'score.json');
    writeFileSync(
      outPath,
      JSON.stringify({
        id: 'fixture',
        name: 'fixture',
        path: repoRoot,
        files: [],
        functions: [],
        classes: [],
        entrypoints: [],
        entities: [],
        calls: [],
        imports: [],
      }),
    );

    const profile = {
      parserId: 'fixture/runtime',
      substrate: { language: 'ts', include: ['**/*.ts'] },
    } as ExtractionProfile;
    const parsed = { files: [], functions: [], classes: [], entrypoints: [], entities: [], calls: [], imports: [] };

    expect(
      tsSourceSignals({
        repoRoot,
        outPath,
        profile,
        parsed,
        sourceFiles: ['src/tracked.ts', 'src/untracked.ts'],
      } as never).http,
    ).toBe(2);
  });
});
