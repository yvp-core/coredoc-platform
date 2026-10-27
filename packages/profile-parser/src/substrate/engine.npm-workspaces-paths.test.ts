/**
 * An npm/yarn workspace declares its members in the root package.json `workspaces`, has no root
 * tsconfig, and each app maps `@/*` in its own tsconfig. Indexed as one synthetic root project,
 * the member tsconfig (and its `paths`) is never read, so every `@/…` import call stays unbound.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeFixture(workspaces: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pp-npm-ws-')));
  const write = (rel: string, body: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  write('package.json', JSON.stringify({ name: 'acme', private: true, workspaces }));
  write('apps/web/package.json', JSON.stringify({ name: 'acme-web', version: '1.0.0' }));
  write(
    'apps/web/tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }),
  );
  write('apps/web/src/lib/widgets.ts', 'export function loadWidgets(n: number): number {\n  return n + 1;\n}\n');
  write(
    'apps/web/src/page.ts',
    "import { loadWidgets } from '@/lib/widgets';\nexport function page(): number {\n  return loadWidgets(1);\n}\n",
  );
  return root;
}

describe('call graph — npm/yarn workspace member with its own tsconfig paths', () => {
  it.each([
    ['array', ['apps/*']],
    ['{ packages }', { packages: ['apps/*'] }],
  ])('binds an `@/` import call through the member tsconfig (%s form)', async (_form, workspaces) => {
    dir = writeFixture(workspaces);
    const { repo } = await runProfile(
      { parserId: 'test-npm-ws-paths', substrate: { language: 'ts', include: ['apps/**/*.ts'] } },
      dir,
      'npm-ws-paths',
    );
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const edges = repo.calls
      .filter((c) => c.calleeId)
      .map((c) => `${nameById.get(c.callerId)}->${nameById.get(c.calleeId as string)}`);
    expect(edges).toContain('page->loadWidgets');
  });

  it('still resolves calls in member files the member tsconfig excludes (a sibling tsconfig covers them)', async () => {
    dir = writeFixture(['apps/*']);
    writeFileSync(
      join(dir, 'apps/web/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
        include: ['src'],
        exclude: ['src/legacy'],
      }),
    );
    writeFileSync(
      join(dir, 'apps/web/tsconfig.legacy.json'),
      JSON.stringify({ extends: './tsconfig.json', compilerOptions: { allowJs: true }, include: ['src/legacy'] }),
    );
    mkdirSync(join(dir, 'apps/web/src/legacy'), { recursive: true });
    writeFileSync(join(dir, 'apps/web/src/legacy/a.ts'), 'export function f() {\n  g();\n}\nfunction g() {}\n');
    const { repo } = await runProfile(
      { parserId: 'test-npm-ws-paths', substrate: { language: 'ts', include: ['apps/**/*.ts'] } },
      dir,
      'npm-ws-paths',
    );
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const edges = repo.calls
      .filter((c) => c.calleeId)
      .map((c) => `${nameById.get(c.callerId)}->${nameById.get(c.calleeId as string)}`);
    expect(edges).toEqual(expect.arrayContaining(['f->g', 'page->loadWidgets']));
  });
});
