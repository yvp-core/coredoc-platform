import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types/profile.js';
import type { GoProfile } from '../types/go-profile.js';
import type { PythonProfile } from '../types/python-profile.js';
import type { RubyProfile } from '../types/ruby-profile.js';
import type { RustProfile } from '../types/rust-profile.js';
import { goProvider, pythonProvider, rubyProvider, rustProvider, typescriptProvider } from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-source-files-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe('LanguageProvider sourceFiles contract', () => {
  it('aligns TS/JS metadata and intended files with mts, cts, and Vue substrate discovery', () => {
    const root = repo({
      'src/a.ts': 'export const a = 1;',
      'src/b.mts': 'export const b = 1;',
      'src/c.cts': 'export const c = 1;',
      'src/App.vue': '<script setup lang="ts">const app = 1</script>',
      'src/skip.spec.ts': 'export const skipped = 1;',
    });
    const profile: ExtractionProfile = {
      parserId: 'ts-source-contract',
      substrate: { language: 'ts', include: ['src/**/*'], exclude: ['**/*.spec.ts'] },
    };

    expect(typescriptProvider.discovery.extensions).toEqual([
      '.ts',
      '.mts',
      '.cts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.vue',
    ]);
    expect(typescriptProvider.sourceFiles(profile, root)).toEqual({
      included: ['src/App.vue', 'src/a.ts', 'src/b.mts', 'src/c.cts'],
      excluded: ['src/skip.spec.ts'],
      profileExcluded: ['src/skip.spec.ts'],
    });
  });

  it('includes Python stubs and applies the same built-in defaults as the parser', () => {
    const root = repo({
      'src/main.py': 'def main(): pass',
      'src/native.pyi': 'def native() -> None: ...',
      'src/generated.py': 'def generated(): pass',
      '.venv/lib/site.py': 'def dependency(): pass',
      'app/migrations/0001.py': 'def migration(): pass',
    });
    const profile: PythonProfile = {
      parserId: 'python-source-contract',
      substrate: { language: 'python', include: ['src/**/*.py', 'src/**/*.pyi'], exclude: ['src/generated.py'] },
    };

    expect(pythonProvider.discovery.extensions).toEqual(['.py', '.pyi']);
    expect(pythonProvider.sourceFiles(profile, root)).toEqual({
      included: ['src/main.py', 'src/native.pyi'],
      excluded: ['.venv/lib/site.py', 'app/migrations/0001.py', 'src/generated.py'],
      profileExcluded: ['src/generated.py'],
    });

    expect(
      pythonProvider.sourceFiles(
        { ...profile, substrate: { ...profile.substrate, include: [], excludeDefaults: false } },
        root,
      ).included,
    ).toEqual(['.venv/lib/site.py', 'app/migrations/0001.py', 'src/main.py', 'src/native.pyi']);
  });

  it('applies Go and Rust built-in source exclusions before scope auditing', () => {
    const goRoot = repo({
      'cmd/main.go': 'package main',
      'cmd/main_test.go': 'package main',
      'cmd/api.pb.go': 'package main',
      'vendor/example/lib.go': 'package example',
      'testdata/fixture.go': 'package fixture',
    });
    const goProfile: GoProfile = {
      parserId: 'go-source-contract',
      substrate: { language: 'go', include: ['cmd/**/*.go'] },
    };
    expect(goProvider.sourceFiles(goProfile, goRoot)).toEqual({
      included: ['cmd/main.go'],
      excluded: ['cmd/api.pb.go', 'cmd/main_test.go', 'testdata/fixture.go', 'vendor/example/lib.go'],
      profileExcluded: [],
    });

    const rustRoot = repo({
      'src/lib.rs': 'pub fn live() {}',
      'target/generated.rs': 'pub fn generated() {}',
      'vendor/lib.rs': 'pub fn vendored() {}',
      'tests/integration.rs': 'pub fn test() {}',
      'benches/bench.rs': 'pub fn bench() {}',
      'examples/demo.rs': 'pub fn demo() {}',
      'build.rs': 'fn main() {}',
    });
    const rustProfile: RustProfile = {
      parserId: 'rust-source-contract',
      substrate: { language: 'rust', include: ['src/**/*.rs'] },
    };
    expect(rustProvider.sourceFiles(rustProfile, rustRoot)).toEqual({
      included: ['src/lib.rs'],
      excluded: [
        'benches/bench.rs',
        'build.rs',
        'examples/demo.rs',
        'target/generated.rs',
        'tests/integration.rs',
        'vendor/lib.rs',
      ],
      profileExcluded: [],
    });
  });

  it('parses .rake sources while preserving Ruby default skips and profile exclusions', async () => {
    const root = repo({
      'app/main.rb': 'def app_main; end',
      'config/routes.rb': "get 'health'\n",
      'tasks/setup.rake': 'def setup_task; end',
      'app/ignored.rb': 'def explicitly_ignored; end',
      'spec/widget_spec.rb': 'def spec_only; end',
      'test/widget_test.rb': 'def test_only; end',
      'db/migrate/001.rb': 'def migration_only; end',
      'vendor/tool.rake': 'def vendor_only; end',
    });
    const profile: RubyProfile = {
      parserId: 'ruby-source-contract',
      substrate: {
        language: 'ruby',
        include: ['app/**/*.rb', 'tasks/**/*.rake'],
        exclude: ['app/ignored.rb'],
      },
      entrypoints: { grape: { enabled: false }, railsRoutes: { enabled: true }, queue: { enabled: false } },
    };

    expect(rubyProvider.sourceFiles(profile, root)).toEqual({
      included: ['app/main.rb', 'tasks/setup.rake'],
      excluded: [
        'app/ignored.rb',
        'db/migrate/001.rb',
        'spec/widget_spec.rb',
        'test/widget_test.rb',
        'vendor/tool.rake',
      ],
      profileExcluded: ['app/ignored.rb'],
    });

    // `excludeDefaults: false` drops the built-in spec/test/db/vendor skips, exactly as it does
    // for Python/Go/Rust/Zig. Only the profile's own `exclude` survives.
    expect(
      rubyProvider.sourceFiles(
        { ...profile, substrate: { ...profile.substrate, include: [], excludeDefaults: false } },
        root,
      ),
    ).toEqual({
      included: [
        'app/main.rb',
        'config/routes.rb',
        'db/migrate/001.rb',
        'spec/widget_spec.rb',
        'tasks/setup.rake',
        'test/widget_test.rb',
        'vendor/tool.rake',
      ],
      excluded: ['app/ignored.rb'],
      profileExcluded: ['app/ignored.rb'],
    });

    const parsed = await rubyProvider.parse(profile, { repoRoot: root, repoName: 'ruby-source-contract' });
    expect(parsed.functions.map((fn) => `${fn.location.filePath}:${fn.name}`).sort()).toEqual([
      'app/main.rb:app_main',
      'tasks/setup.rake:setup_task',
    ]);
    expect(parsed.entrypoints.some((entrypoint) => entrypoint.location.filePath === 'config/routes.rb')).toBe(true);
  });
});
