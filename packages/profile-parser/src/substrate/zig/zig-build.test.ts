/**
 * BR-13a: the `build.zig` module/exe map.
 *
 * The two vendored fixtures reproduce the only two shapes seen in the wild — the root module
 * bound to a `const` and then passed to `addExecutable`, and a helper `fn` whose parameters
 * carry the exe name and root path from each call site. Names are neutral on purpose; the
 * real repos are asserted separately, gated on a sibling checkout.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseZigBuild } from './zig-build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHAPES = join(HERE, '__fixtures__', 'build-shapes');
const REPO_ROOT = resolve(HERE, '../../../../..');

const asObject = (map: Map<string, string>) => Object.fromEntries([...map.entries()].sort());

describe('parseZigBuild — fixture shapes', () => {
  it('reads a const-bound root module and its executable', async () => {
    const map = await parseZigBuild(join(SHAPES, 'const-root'));

    expect(asObject(map.exeByRoot)).toEqual({ 'src/entry.zig': 'widget' });
    // `flags_dep.module("flags")` is a package dependency, not an in-repo module (BR-13a).
    expect(asObject(map.modules)).toEqual({ helpers: 'src/helpers.zig' });
  });

  it('substitutes helper-fn parameters per call site — one executable each', async () => {
    const map = await parseZigBuild(join(SHAPES, 'helper-root'));

    expect(asObject(map.exeByRoot)).toEqual({
      'src/main.zig': 'widget',
      'src/main_worker.zig': 'widget-worker',
    });
    expect(asObject(map.modules)).toEqual({ shared: 'src/shared.zig' });
  });

  it('reads an `.imports = &.{…}` array whose module is built in this repo', async () => {
    // The `.{ .name = …, .module = … }` element form, with the module bound to a local
    // `createModule` — the shape a repo uses when the root module imports a sibling module.
    const map = await parseZigBuild(join(SHAPES, 'imports-array-inrepo'));

    expect(map.modules.get('shared')).toBe('src/shared.zig');
  });

  it('scopes a `const` to the helper that declares it — one root each, not the first twice', async () => {
    // A5: two helpers, both writing `const root = b.path(…)`. A flat const table resolves the
    // second helper's `root` to the FIRST helper's path and points both exes at one file.
    const map = await parseZigBuild(join(SHAPES, 'two-helpers'));

    expect(asObject(map.exeByRoot)).toEqual({
      'src/first.zig': 'first',
      'src/second.zig': 'second',
    });
  });

  it('refuses to bind a module under a reserved toolchain name (RT1)', async () => {
    const map = await parseZigBuild(join(SHAPES, 'reserved-std'));

    // A module literally named `std` would make every `@import("std")` an in-repo edge.
    expect(map.modules.has('std')).toBe(false);
    // …and the sibling declaration in the same file is untouched: the guard is per NAME.
    expect(map.modules.get('shim')).toBe('src/std_shim.zig');
  });

  it('yields empty maps when there is no build.zig', async () => {
    const map = await parseZigBuild(SHAPES);

    expect(map.modules.size).toBe(0);
    expect(map.exeByRoot.size).toBe(0);
  });

  it('yields empty maps for a syntactically broken build.zig, without throwing', async () => {
    const map = await parseZigBuild(join(SHAPES, 'broken'));

    expect(map.modules.size).toBe(0);
    expect(map.exeByRoot.size).toBe(0);
  });
});

const ZEEGREP = resolve(REPO_ROOT, '..', 'zeegrep');
const BROWSER = resolve(REPO_ROOT, '..', 'browser');
const GROUND_TRUTH = existsSync(join(ZEEGREP, 'build.zig')) && existsSync(join(BROWSER, 'build.zig'));

if (!GROUND_TRUTH) {
  console.warn(
    `[zig-build] SKIPPED ground-truth cases: need sibling checkouts at ${ZEEGREP} and ${BROWSER} ` +
      '(the fixture shapes above are derived from their build.zig files).',
  );
}

describe.skipIf(!GROUND_TRUTH)('parseZigBuild — real build.zig ground truth', () => {
  it('resolves the zeegrep executable through its const-bound root module', async () => {
    const map = await parseZigBuild(ZEEGREP);

    expect(map.exeByRoot.get('src/main.zig')).toBe('zg');
    expect(map.modules.has('opt')).toBe(false); // `opt_dep.module("opt")` is not in-repo
  });

  it('resolves the browser module and its three helper-built executables', async () => {
    const map = await parseZigBuild(BROWSER);

    expect(map.modules.get('lightpanda')).toBe('src/lightpanda.zig');
    expect(map.exeByRoot.get('src/main.zig')).toBe('lightpanda');
    expect(map.exeByRoot.get('src/main_snapshot_creator.zig')).toBe('lightpanda-snapshot-creator');
    expect(map.exeByRoot.get('src/main_skills.zig')).toBe('lightpanda-skills');
  });
});
