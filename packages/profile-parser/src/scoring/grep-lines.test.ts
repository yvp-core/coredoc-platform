import { describe, expect, it } from 'vitest';
import { sumGrepCounts } from './grep-lines.js';

const RS_NOISE = /(\/target\/|\/vendor\/|\/tests?\/|\/benches\/|\/examples\/|\/node_modules\/)/;
const PY_NOISE =
  /(\/tests?\/|_test\.py|_pb2\.py|\/migrations\/|\/site-packages\/|\/node_modules\/|\/\.?venv\/|__pycache__)/;
const RB_NOISE = /(_spec|_test|\/spec\/|\/test\/|vendor)/;
const SWIFT_NOISE = /(Tests?\/|\/Test\/|\.generated\.swift)/;

describe('sumGrepCounts', () => {
  it('sums the per-file counts of `grep -rEc` output', () => {
    const out = '/repo/src/a.rs:3\n/repo/src/b.rs:4\n';
    expect(sumGrepCounts(out, ['/repo'], RS_NOISE)).toBe(7);
  });

  it('excludes noise directories INSIDE the repo', () => {
    const out = '/repo/src/a.rs:3\n/repo/target/debug/gen.rs:9\n/repo/tests/it.rs:5\n';
    expect(sumGrepCounts(out, ['/repo'], RS_NOISE)).toBe(3);
  });

  it('does NOT let a noise word in the CHECKOUT path zero the count', () => {
    // The bug this helper exists to prevent: the exclusion matched the path to the checkout, so
    // every line was dropped. A zero denominator scores `not_applicable` — read as a PASS.
    for (const root of [
      '/Users/dev/examples/api',
      '/srv/vendor/api',
      '/home/ci/tests/api',
      '/x/node_modules/api',
      '/build/target/api',
    ]) {
      expect(sumGrepCounts(`${root}/src/a.rs:3\n`, [root], RS_NOISE), root).toBe(3);
    }
  });

  it('holds for every language noise pattern', () => {
    expect(sumGrepCounts('/dev/tests/app/app/urls.py:4\n', ['/dev/tests/app'], PY_NOISE)).toBe(4);
    expect(sumGrepCounts('/dev/tests/app/app/tests/urls.py:4\n', ['/dev/tests/app'], PY_NOISE)).toBe(0);
    expect(sumGrepCounts('/dev/vendor/app/config/routes.rb:6\n', ['/dev/vendor/app'], RB_NOISE)).toBe(6);
    expect(sumGrepCounts('/dev/vendor/app/spec/routing.rb:6\n', ['/dev/vendor/app'], RB_NOISE)).toBe(0);
    expect(sumGrepCounts('/dev/Tests/App/Sources/M.swift:2\n', ['/dev/Tests/App'], SWIFT_NOISE)).toBe(2);
    expect(sumGrepCounts('/dev/Tests/App/AppTests/M.swift:2\n', ['/dev/Tests/App'], SWIFT_NOISE)).toBe(0);
  });

  it('strips the LONGEST matching root when include roots nest', () => {
    // With `/repo` stripped instead of `/repo/examples`, the rest reads as `/examples/...`.
    const out = '/repo/examples/src/a.rs:5\n';
    expect(sumGrepCounts(out, ['/repo', '/repo/examples'], RS_NOISE)).toBe(5);
  });

  it('handles a trailing-slash root and a single-FILE root', () => {
    // Ruby scopes to `join(repoRoot, 'app/api/')` (glob keeps the slash) and to routes.rb itself.
    expect(sumGrepCounts('/repo/app/api/v1/users.rb:2\n', ['/repo/app/api/'], RB_NOISE)).toBe(2);
    expect(sumGrepCounts('/repo/config/routes.rb:8\n', ['/repo/config/routes.rb'], RB_NOISE)).toBe(8);
  });

  it('ignores lines with no trailing :count', () => {
    expect(sumGrepCounts('/repo/src/a.rs\n\n/repo/src/b.rs:2\n', ['/repo'], RS_NOISE)).toBe(2);
  });
});
