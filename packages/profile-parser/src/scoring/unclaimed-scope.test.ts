import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { unclaimedScope, unclaimedScopeRedFlags } from './unclaimed-scope.js';

const root = mkdtempSync(path.join(tmpdir(), 'unclaimed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seed(rel: string, content = '// x'): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('unclaimedScope', () => {
  it('reports known-language files not claimed by any target, clustered by top dirs', () => {
    seed('ui/App.tsx');
    seed('api/app.rb');
    seed('scripts/deploy.rb');
    seed('README.md'); // not a registered-language extension — never counted
    seed('node_modules/x/index.ts'); // skipped dir
    seed('dist/out.ts'); // skipped dir
    const report = unclaimedScope(root, new Set(['ui/App.tsx', 'api/app.rb']), []);
    expect(report.total).toBe(3);
    expect(report.unclaimed).toBe(1);
    expect(report.topDirs).toEqual([{ dir: 'scripts', count: 1 }]);
    expect(report.sampleFiles).toEqual(['scripts/deploy.rb']);
    expect(unclaimedScopeRedFlags(report)).toEqual([
      expect.stringContaining('1/3 known-language file(s) are claimed by no target'),
    ]);
  });

  it('counts repo-root dot-directory tooling as excluded, never as a language population', () => {
    const toolRoot = mkdtempSync(path.join(tmpdir(), 'unclaimed-tooling-'));
    try {
      for (const rel of [
        'main.go',
        '.claude/skills/adr/scripts/new_adr.js',
        '.claude/skills/adr/scripts/set_status.js',
        'web/.hidden/app.js', // not repo-root: still application source
      ]) {
        mkdirSync(path.dirname(path.join(toolRoot, rel)), { recursive: true });
        writeFileSync(path.join(toolRoot, rel), '// x');
      }
      const report = unclaimedScope(toolRoot, new Set(['main.go']), []);
      expect(report.intentionallyExcluded).toBe(2);
      expect(report.sampleFiles).toEqual(['web/.hidden/app.js']);
    } finally {
      rmSync(toolRoot, { recursive: true, force: true });
    }
  });

  it('returns zero unclaimed when every known file is claimed', () => {
    const report = unclaimedScope(root, new Set(['ui/App.tsx', 'api/app.rb', 'scripts/deploy.rb']), []);
    expect(report.unclaimed).toBe(0);
    expect(unclaimedScopeRedFlags(report)).toEqual([]);
  });

  it('keeps target exclusions non-fatal while reporting files matched by no target', () => {
    const scopedRoot = path.join(root, 'scoped');
    seed('scoped/ui/App.tsx');
    seed('scoped/ui/types.d.ts');
    seed('scoped/api/app.rb');
    seed('scoped/api/spec/widget_spec.rb');
    seed('scoped/scripts/orphan.ts');

    const report = unclaimedScope(scopedRoot, new Set(['ui/App.tsx', 'api/app.rb']), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set(['ui/types.d.ts']),
        explicitExclude: ['**/*.d.ts'],
      },
      {
        excludedPaths: new Set(['api/spec/widget_spec.rb']),
        profileExcludedPaths: new Set(),
        explicitExclude: ['api/spec/**'],
      },
    ]);

    expect(report.total).toBe(5);
    expect(report.intentionallyExcluded).toBe(2);
    expect(report.unclaimed).toBe(1);
    expect(report.topDirs).toEqual([{ dir: 'scripts', count: 1 }]);
    expect(unclaimedScopeRedFlags(report)).toEqual([
      expect.stringContaining('1/5 known-language file(s) are claimed by no target'),
    ]);
  });

  it('uses provider intent rather than emitted FileNodes when an overlapping target owns a file', () => {
    const scopedRoot = path.join(root, 'overlap');
    seed('overlap/shared/types.d.ts');

    const report = unclaimedScope(scopedRoot, new Set(['shared/types.d.ts']), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set(['shared/types.d.ts']),
        explicitExclude: ['**/*.d.ts'],
      },
      { excludedPaths: new Set(), profileExcludedPaths: new Set(), explicitExclude: [] },
    ]);

    expect(report.intentionallyExcluded).toBe(0);
    expect(report.unclaimed).toBe(0);
    expect(unclaimedScopeRedFlags(report)).toEqual([]);
  });

  it('allows an inventoried stray language only when a profile explicitly excludes it', () => {
    const strayRoot = path.join(root, 'stray');
    seed('stray/src/app.ts');
    seed('stray/scripts/legacy.py');

    const blocked = unclaimedScope(strayRoot, new Set(['src/app.ts']), [
      { excludedPaths: new Set(), profileExcludedPaths: new Set(), explicitExclude: [] },
    ]);
    expect(blocked.unclaimed).toBe(1);
    expect(unclaimedScopeRedFlags(blocked)).toHaveLength(1);

    const excluded = unclaimedScope(strayRoot, new Set(['src/app.ts']), [
      { excludedPaths: new Set(), profileExcludedPaths: new Set(), explicitExclude: ['scripts/legacy.py'] },
    ]);
    expect(excluded).toEqual({ total: 2, intentionallyExcluded: 1, unclaimed: 0, topDirs: [], sampleFiles: [] });

    const broad = unclaimedScope(strayRoot, new Set(['src/app.ts']), [
      { excludedPaths: new Set(), profileExcludedPaths: new Set(), explicitExclude: ['scripts/**/*.py'] },
    ]);
    expect(broad.unclaimed).toBe(1);
  });

  it('uses the extractor source set, excluding gitignored generated files and deleted tracked files', () => {
    const alignedRoot = path.join(root, 'aligned');
    seed('aligned/.gitignore', 'generated/\n');
    seed('aligned/src/live.ts');
    seed('aligned/src/deleted.ts');
    seed('aligned/generated/client.ts');
    execFileSync('git', ['init'], { cwd: alignedRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '.gitignore', 'src/live.ts', 'src/deleted.ts'], {
      cwd: alignedRoot,
      stdio: 'ignore',
    });
    rmSync(path.join(alignedRoot, 'src', 'deleted.ts'));

    const report = unclaimedScope(alignedRoot, new Set(['src/live.ts']), [
      { excludedPaths: new Set(), profileExcludedPaths: new Set(), explicitExclude: [] },
    ]);

    expect(report).toEqual({ total: 1, intentionallyExcluded: 0, unclaimed: 0, topDirs: [], sampleFiles: [] });
  });

  it('blocks a profile-authored exclude-all over ordinary same-language source', () => {
    const scopedRoot = path.join(root, 'exclude-all');
    seed('exclude-all/src/app.ts');

    const report = unclaimedScope(scopedRoot, new Set(), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set(['src/app.ts']),
        explicitExclude: ['**/*'],
      },
    ]);

    expect(report).toEqual({
      total: 1,
      intentionallyExcluded: 0,
      unclaimed: 1,
      topDirs: [{ dir: 'src', count: 1 }],
      sampleFiles: ['src/app.ts'],
    });
    expect(unclaimedScopeRedFlags(report)).toHaveLength(1);
  });

  it('allows conventional generated/test exclusions but blocks an ordinary source subtree glob', () => {
    const scopedRoot = path.join(root, 'profile-excludes');
    seed('profile-excludes/src/live.ts');
    seed('profile-excludes/src/generated/client.ts');
    seed('profile-excludes/src/live.test.ts');
    seed('profile-excludes/src/internal/hidden.ts');

    const report = unclaimedScope(scopedRoot, new Set(['src/live.ts']), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set(['src/generated/client.ts', 'src/live.test.ts', 'src/internal/hidden.ts']),
        explicitExclude: ['src/generated/**', '**/*.test.ts', 'src/internal/**'],
      },
    ]);

    expect(report.intentionallyExcluded).toBe(2);
    expect(report.unclaimed).toBe(1);
    expect(report.topDirs).toEqual([{ dir: 'src', count: 1 }]);
  });

  it('honors explicit e2e and fixture exclusions without dropping unexcluded tests or production source', () => {
    const scopedRoot = path.join(root, 'test-scope');
    const testFiles = ['e2e/login.ts', 'packages/ui/__fixtures__/user.ts', 'packages/ui/e2e/setup.ts'];
    for (const file of ['src/live.ts', 'src/contest.ts', ...testFiles]) seed(`test-scope/${file}`);

    const claimed = new Set(['src/live.ts']);
    expect(unclaimedScope(scopedRoot, claimed, []).unclaimed).toBe(4);

    const report = unclaimedScope(scopedRoot, claimed, [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set([...testFiles, 'src/contest.ts']),
        explicitExclude: ['**/e2e/**', '**/__fixtures__/**', '**/*test*'],
      },
    ]);

    expect(report.intentionallyExcluded).toBe(3);
    expect(report.unclaimed).toBe(1);
    expect(report.sampleFiles).toEqual(['src/contest.ts']);
  });

  it('does not let exact exclusions hide a multi-file non-target language population', () => {
    const scopedRoot = path.join(root, 'stray-population');
    seed('stray-population/src/app.ts');
    seed('stray-population/scripts/one.py');
    seed('stray-population/scripts/two.py');

    const report = unclaimedScope(scopedRoot, new Set(['src/app.ts']), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set(),
        explicitExclude: ['scripts/one.py', 'scripts/two.py'],
      },
    ]);

    expect(report.intentionallyExcluded).toBe(0);
    expect(report.unclaimed).toBe(2);
  });

  it('accepts an explicitly excluded bundled Monaco distribution without trusting arbitrary public JS', () => {
    const scopedRoot = path.join(root, 'public-vendor');
    seed('public-vendor/src/app.ts');
    seed('public-vendor/apps/studio/public/monaco-editor/editor/editor.main.js');
    seed('public-vendor/apps/studio/public/custom-runtime.js');

    const report = unclaimedScope(scopedRoot, new Set(['src/app.ts']), [
      {
        excludedPaths: new Set(),
        profileExcludedPaths: new Set([
          'apps/studio/public/monaco-editor/editor/editor.main.js',
          'apps/studio/public/custom-runtime.js',
        ]),
        explicitExclude: ['apps/studio/public/**'],
      },
    ]);

    expect(report.intentionallyExcluded).toBe(1);
    expect(report.unclaimed).toBe(1);
    expect(report.sampleFiles).toEqual(['apps/studio/public/custom-runtime.js']);
  });
});
