import { describe, expect, it } from 'vitest';
import { type GoModule, dependsOnAny, discoverGoModules, moduleOwnerPath, parseGoMod } from './go-modules.js';

/** A module descriptor the way `discoverGoModules` would emit it. */
function mod(modulePath: string, path: string, dependencies: string[] = [], isWorkspace = false): GoModule {
  return { modulePath, path, dependencies: new Set(dependencies), isWorkspace };
}

describe('parseGoMod', () => {
  it('reads the module path, the go version and every require form', () => {
    const parsed = parseGoMod(
      `module github.com/acme/api

go 1.22

toolchain go1.22.3

require (
	github.com/go-chi/chi/v5 v5.0.10
	github.com/lib/pq v1.10.9 // indirect
)

require github.com/spf13/cobra v1.8.0

replace (
	github.com/acme/internal => ../internal
)

exclude github.com/bad/dep v0.1.0
`,
      'fallback',
    );
    expect(parsed.modulePath).toBe('github.com/acme/api');
    expect(parsed.goVersion).toBe('1.22');
    expect(parsed.isWorkspace).toBe(false);
    // `// indirect` is stripped with every other comment BEFORE the name is read, and a `replace` /
    // `exclude` directive names a module that is NOT a requirement.
    expect([...parsed.dependencies].sort()).toEqual([
      'github.com/go-chi/chi/v5',
      'github.com/lib/pq',
      'github.com/spf13/cobra',
    ]);
  });

  it('marks a go.work as a workspace and falls back to the directory name for its module path', () => {
    const parsed = parseGoMod('go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n', 'root');
    expect(parsed.isWorkspace).toBe(true);
    expect(parsed.modulePath).toBe('root');
    // `use` entries are directories, not requirements — recording them as dependencies would make
    // every framework gate think the repo requires a module called `./api`.
    expect(parsed.dependencies.size).toBe(0);
  });

  it('marks the single-line use form too', () => {
    expect(parseGoMod('go 1.22\nuse ./api\n', 'root').isWorkspace).toBe(true);
  });
});

describe('discoverGoModules', () => {
  it('finds every go.mod plus go.work, and skips vendored / testdata manifests', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'go-modules-'));
    const manifests: Record<string, string> = {
      'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n',
      'api/go.mod': 'module github.com/acme/api\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.0.10\n',
      'worker/go.mod': 'module github.com/acme/worker\n\ngo 1.21\n',
      'api/vendor/github.com/x/y/go.mod': 'module github.com/x/y\n',
      'api/testdata/broken/go.mod': 'module example.com/fixture\n',
    };
    for (const [rel, content] of Object.entries(manifests)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    try {
      const modules = discoverGoModules(root);
      expect(modules.map((m) => m.path)).toEqual(['.', 'api', 'worker']);
      expect(modules.map((m) => m.modulePath)).toEqual(['root', 'github.com/acme/api', 'github.com/acme/worker']);
      expect(modules[0].isWorkspace).toBe(true);
      expect(modules[1].manifestFile).toBe('api/go.mod');
      expect(modules[1].goVersion).toBe('1.22');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('moduleOwnerPath', () => {
  const modules = [mod('root', '.', [], true), mod('github.com/acme/api', 'services/api')];

  it('picks the longest matching prefix', () => {
    expect(moduleOwnerPath('services/api/handler/user.go', modules)).toBe('services/api');
    expect(moduleOwnerPath('tools/gen.go', modules)).toBe('.');
  });

  it('returns undefined when no module contains the file, rather than guessing one', () => {
    expect(moduleOwnerPath('tools/gen.go', [mod('github.com/acme/api', 'services/api')])).toBeUndefined();
    // A sibling directory that merely shares a prefix is NOT inside the module.
    expect(moduleOwnerPath('services/apixyz/main.go', [mod('github.com/acme/api', 'services/api')])).toBeUndefined();
  });
});

describe('dependsOnAny', () => {
  const modules = [mod('github.com/acme/api', '.', ['github.com/go-chi/chi/v5', 'gorm.io/gorm'])];

  it('matches on the module-path PREFIX so a gate written without /vN still fires', () => {
    // Go encodes the major version IN the path from v2 on, so a gate for `github.com/go-chi/chi`
    // must match a `require github.com/go-chi/chi/v5`.
    expect(dependsOnAny(modules, ['github.com/go-chi/chi'])).toBe(true);
    expect(dependsOnAny(modules, ['gorm.io/gorm'])).toBe(true);
  });

  it('does NOT match an unrelated module, nor a gate more specific than the requirement', () => {
    expect(dependsOnAny(modules, ['github.com/gin-gonic/gin'])).toBe(false);
    expect(dependsOnAny(modules, ['gorm.io/gorm/v3'])).toBe(false);
    // A prefix that is not a path boundary must not match.
    expect(dependsOnAny(modules, ['github.com/go-chi/ch'])).toBe(false);
    expect(dependsOnAny([], ['github.com/go-chi/chi'])).toBe(false);
  });
});
