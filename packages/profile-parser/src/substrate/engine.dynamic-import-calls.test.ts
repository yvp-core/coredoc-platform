/**
 * Acceptance for call resolution through a destructured `await import()`:
 *
 *   const { transformParsedRepo } = await import('@coredoc/db');
 *   transformParsedRepo(parsed, …);            // ← must be a CALLS edge
 *
 * Field evidence: every `await import('@coredoc/db')` site in the server's
 * push.service.ts produced no CALLS edge to `transformParsedRepo`, while the
 * static-import callers of the same function resolved. scip-typescript binds the
 * destructured name to a document-`local` symbol, so the call site carries
 * `local N` and the SCIP edge pass skips it — but the BINDING site carries a
 * reference to the real export, which is what this fix reads.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const LIB = `export function transformParsedRepo(x: number): number {
  return x + 1;
}
export function getTransformStats(x: number): number {
  return x;
}
export function other(y: number): number {
  return y;
}
`;

const CONSUMER = `import { other } from './lib.js';

export async function computeChangeset(n: number): Promise<number> {
  const { transformParsedRepo } = await import('./lib.js');
  return transformParsedRepo(n);
}

export async function applyIncremental(n: number): Promise<number> {
  const { transformParsedRepo: transform, getTransformStats } = await import('./lib.js');
  return transform(n) + getTransformStats(n);
}

export function staticCaller(n: number): number {
  return other(n);
}

export async function unresolvableSpecifier(name: string): Promise<number> {
  const { transformParsedRepo } = await import(\`./\${name}.js\`);
  return transformParsedRepo(1);
}
`;

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-dyn-import-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // scip-typescript's prerequisite check is the presence of node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dyn-import-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src'],
    }),
  );
  writeFileSync(join(root, 'src', 'lib.ts'), LIB);
  writeFileSync(join(root, 'src', 'consumer.ts'), CONSUMER);
  return root;
}

/**
 * A two-package pnpm workspace: `@fix/app` dynamically imports `@fix/lib` through the
 * package's published `dist/index.d.ts` barrel, mirroring `apps/server` → `@coredoc/db`.
 */
function writeWorkspaceFixture(): string {
  // realpath: scip-typescript resolves the project dirs it is handed, and on macOS the OS
  // temp dir is a symlink (`/var` → `/private/var`). Without this the indexed document paths
  // don't match the repo-relative paths the substrate keys on and the whole index is unusable.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pp-dyn-import-ws-')));
  const write = (rel: string, body: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  };
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('package.json', JSON.stringify({ name: 'dyn-import-ws-fixture', version: '1.0.0', private: true }));
  write(
    'packages/lib/package.json',
    JSON.stringify({ name: '@fix/lib', version: '1.0.0', type: 'module', types: 'dist/index.d.ts' }),
  );
  write(
    'packages/lib/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        declaration: true,
        outDir: 'dist',
      },
      include: ['src'],
    }),
  );
  write(
    'packages/lib/src/transformer.ts',
    'export function transformParsedRepo(x: number): number {\n  return x + 1;\n}\n',
  );
  write('packages/lib/src/index.ts', "export { transformParsedRepo } from './transformer.js';\n");
  write('packages/lib/dist/index.d.ts', "export { transformParsedRepo } from './transformer.js';\n");
  write('packages/lib/dist/transformer.d.ts', 'export declare function transformParsedRepo(x: number): number;\n');
  write('packages/app/package.json', JSON.stringify({ name: '@fix/app', version: '1.0.0', type: 'module' }));
  write(
    'packages/app/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        baseUrl: '.',
        paths: { '@fix/lib': ['../lib/dist/index.d.ts'] },
      },
      include: ['src'],
    }),
  );
  write(
    'packages/app/src/push.ts',
    'export async function computeChangeset(n: number): Promise<number> {\n' +
      "  const { transformParsedRepo } = await import('@fix/lib');\n" +
      '  return transformParsedRepo(n);\n' +
      '}\n',
  );
  return root;
}

const PROFILE: ExtractionProfile = {
  parserId: 'test-dynamic-import-calls',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
};

describe('call graph — destructured `await import()` bindings', () => {
  it('resolves calls through shorthand and aliased dynamic-import bindings', async () => {
    dir = writeFixture();
    const { repo } = await runProfile(PROFILE, dir, 'dyn-import');
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const edges = repo.calls
      .filter((c) => c.calleeId)
      .map((c) => `${nameById.get(c.callerId)}->${nameById.get(c.calleeId as string)}@${c.location.startLine}`);

    // Control: the static import path already resolved.
    expect(edges).toContain('staticCaller->other@14');
    // Shorthand destructure, resolved AT THE CALL SITE (line 5), not the binding line.
    expect(edges).toContain('computeChangeset->transformParsedRepo@5');
    // Aliased destructure + a second binding on the same line.
    expect(edges).toContain('applyIncremental->transformParsedRepo@10');
    expect(edges).toContain('applyIncremental->getTransformStats@10');
    // Fail-safe: a template-literal specifier is unresolvable — no guessed edge.
    expect(edges.some((e) => e.startsWith('unresolvableSpecifier->'))).toBe(false);
  });

  // The shape the field evidence actually has: the imported module is another WORKSPACE
  // PACKAGE consumed through its published barrel (`dist/index.d.ts`). There scip-typescript
  // records only a document-`local` at the binding site — the package reference in the
  // declarator plus the cross-package definition key are what resolve it.
  it('resolves a binding imported from another workspace package through its dist barrel', async () => {
    dir = writeWorkspaceFixture();
    const { repo } = await runProfile(
      {
        parserId: 'test-dynamic-import-workspace',
        substrate: {
          language: 'ts',
          include: ['packages/*/src/**/*.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      dir,
      'dyn-import-ws',
    );
    const nameById = new Map(repo.functions.map((f) => [f.id, f.name]));
    const edges = repo.calls
      .filter((c) => c.calleeId)
      .map((c) => `${nameById.get(c.callerId)}->${nameById.get(c.calleeId as string)}`);
    expect(edges).toContain('computeChangeset->transformParsedRepo');
  });
});
