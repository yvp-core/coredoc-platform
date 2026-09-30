/**
 * `stats.callResolution` for the TypeScript/JS engine (spec BR-1, BR-2, LIM-6).
 *
 * The record is pure observation, counted in SITES: `callSites` counts the distinct sites
 * `internalCalls()` enumerated — including the ones the built-in drop removes — `resolvedCalls`
 * counts the sites an EMITTED edge bound, and a site whose bare callee name is declared nowhere
 * in the repo is out of scope rather than a miss.
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

const LIB = `export function helper(n: number): number {
  return n + 1;
}
`;

const APP = `import { helper } from './lib.js';

function local(n: number): number {
  return n;
}

export function run(n: number): number {
  setTimeout(() => local(1), 0);
  return helper(n) + local(n);
}
`;

/** `setTimeout` declared in the repo — the BR-1 collision case for the same platform site. */
const LIB_WITH_COLLISION = `${LIB}export function setTimeout(ms: number): number {
  return ms;
}
`;

const PROFILE: ExtractionProfile = {
  parserId: 'test-call-resolution',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
};

function writeFixture(lib: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-call-resolution-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cr-fixture', version: '1.0.0', type: 'module' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src'],
    }),
  );
  writeFileSync(join(root, 'src', 'lib.ts'), lib);
  writeFileSync(join(root, 'src', 'app.ts'), APP);
  return root;
}

describe('engine — stats.callResolution', () => {
  it('counts the built-in-dropped site and calls it out of scope', async () => {
    dir = writeFixture(LIB);
    const { repo } = await runProfile(PROFILE, dir, 'call-resolution');

    // The `setTimeout` site survives to the engine's built-in drop, so it is a counted site
    // that ships no edge — and `setTimeout` is declared by nothing here, so it is out of scope.
    expect(repo.calls.some((c) => c.calleeExpression === 'setTimeout')).toBe(false);
    // 4 sites: `setTimeout` and `local` on line 8, `helper` and `local` on line 9. The two
    // `local(n)` facts on line 9 (one structural, one SCIP — different edge ids) are ONE site.
    expect(repo.stats.callResolution).toEqual({ callSites: 4, resolvedCalls: 2, outOfScopeCalls: 1 });
    const { callSites, resolvedCalls, outOfScopeCalls } = repo.stats.callResolution as {
      callSites: number;
      resolvedCalls: number;
      outOfScopeCalls: number;
    };
    expect(resolvedCalls + outOfScopeCalls).toBeLessThanOrEqual(callSites);
    // The site with both a structural and a SCIP fact counts ONCE: five facts reach the engine
    // and four edges ship, yet the line-9 `local` site contributes a single counted site.
    const line9Local = repo.calls.filter((c) => c.calleeExpression === 'local' && c.location.startLine === 9);
    expect(line9Local.length).toBe(2);
    expect(callSites).toBe(4);
    // `resolvedCalls` is read from the emitted set, and counts sites — two edges bind `local`
    // on line 9 and line 8, so the emitted resolved-edge count and the site count agree here.
    expect(resolvedCalls).toBe(repo.calls.filter((c) => c.calleeId).length);
  });

  it('keeps the platform site IN scope when the repo declares the same name (BR-1)', async () => {
    dir = writeFixture(LIB_WITH_COLLISION);
    const { repo } = await runProfile(PROFILE, dir, 'call-resolution-collision');

    // Same sites, same dropped edge — but `setTimeout` is now an in-repo name, so the unbound
    // site counts against the extractor instead of being excused as out of scope.
    expect(repo.calls.some((c) => c.calleeExpression === 'setTimeout')).toBe(false);
    expect(repo.stats.callResolution).toEqual({ callSites: 4, resolvedCalls: 2, outOfScopeCalls: 0 });
  });
});
