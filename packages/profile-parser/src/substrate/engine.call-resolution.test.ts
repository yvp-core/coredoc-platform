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

/** `setTimeout` declared in the repo and imported by the app — the BR-1 collision case. */
const LIB_WITH_COLLISION = `${LIB}export function setTimeout(ms: number): number {
  return ms;
}
`;
const APP_WITH_COLLISION = APP.replace('import { helper }', 'import { helper, setTimeout }');

const PROFILE: ExtractionProfile = {
  parserId: 'test-call-resolution',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
};

function writeFixture(lib: string, app = APP): string {
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
  writeFileSync(join(root, 'src', 'app.ts'), app);
  return root;
}

describe('engine — stats.callResolution', () => {
  it('counts each call site once and resolves every call on a multi-call line', async () => {
    dir = writeFixture(LIB);
    const { repo } = await runProfile(PROFILE, dir, 'call-resolution');

    // The compiler proves `setTimeout` is the platform's, so the SCIP pass drops its site as stdlib
    // noise — it is neither an edge nor a counted site. That leaves `local` on line 8 and `helper` and
    // `local` on line 9, each bound by exactly one edge: two calls on one line resolve independently.
    expect(repo.calls.some((c) => c.calleeExpression === 'setTimeout')).toBe(false);
    expect(repo.stats.callResolution).toEqual({ callSites: 3, resolvedCalls: 3, outOfScopeCalls: 0 });
    const line9 = repo.calls.filter((c) => c.location.startLine === 9).map((c) => [c.calleeExpression, c.calleeId]);
    expect(line9).toEqual([
      ['helper', expect.stringContaining(':helper')],
      ['local', expect.stringContaining(':local')],
    ]);
  });

  it('keeps a repo function named like a platform built-in as a resolved, counted site (BR-1)', async () => {
    dir = writeFixture(LIB_WITH_COLLISION, APP_WITH_COLLISION);
    const { repo } = await runProfile(PROFILE, dir, 'call-resolution-collision');

    // `setTimeout` is now the repo's own import: the built-in drop must not hide the real call.
    const setTimeoutCall = repo.calls.find((c) => c.calleeExpression === 'setTimeout');
    expect(setTimeoutCall?.calleeId).toContain('src/lib.ts:setTimeout');
    expect(repo.stats.callResolution).toEqual({ callSites: 4, resolvedCalls: 4, outOfScopeCalls: 0 });
  });
});
