/**
 * `SymbolIdentityResolver` — the REFUSALS.
 *
 * The resolver's whole point is that identity is proved over the module graph rather than guessed
 * from a name, so the branches that decline to answer are the ones carrying the correctness
 * guarantee. Every `export *` fixture in the three engine suites is a LONE barrel, so the
 * two-barrels-claim-one-name branch and the chain bounds had never executed. Regression in the
 * bounds is not a wrong edge but unbounded recursion inside `coredoc parse`, hence the explicit
 * per-test timeouts.
 *
 * Built on `parseTsStructural` + the resolver directly (not `runProfile`): these are module-graph
 * properties, and driving them through a full parse would hide which step refused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeclKind, createSymbolIdentityResolver } from './symbol-ref-identity.js';
import { type StructuralFile, parseTsStructural } from './ts-structural.js';

/** A repo root that does not exist: no package.json, no tsconfig — pure module-graph resolution. */
const NO_REPO = join(tmpdir(), 'symbol-ref-identity-absent-root');

async function resolverFor(files: Record<string, string>, repoRoot = NO_REPO) {
  const structural: StructuralFile[] = [];
  for (const [path, source] of Object.entries(files)) {
    structural.push(await parseTsStructural(path, source, 'typescript'));
  }
  return createSymbolIdentityResolver(structural, { repoRoot, workspacePackageNames: [] });
}

describe('star re-export collision', () => {
  it('refuses to bind a name two barrels both claim', async () => {
    const resolver = await resolverFor({
      'a/thing.ts': 'export class Widget {}\n',
      'b/thing.ts': 'export class Widget {}\n',
      'barrel-a.ts': "export * from './a/thing';\n",
      'barrel-b.ts': "export * from './b/thing';\n",
      'index.ts': "export * from './barrel-a';\nexport * from './barrel-b';\n",
      'consumer.ts': "import { Widget } from './index';\n",
    });

    // Two star targets each yield a DIFFERENT declaring file, so the name has no decidable owner.
    // Unresolved (never a pick): the caller then keeps the reference without a declaringFile and
    // the storage layer marks it ambiguous.
    const identity = resolver.resolve('consumer.ts', 'Widget', './index', [DeclKind.Class]);
    expect(identity).toEqual({ kind: 'unresolved' });
  }, 10_000);

  it('binds through a LONE barrel — the collision above is the refusal, not a broken fixture', async () => {
    const resolver = await resolverFor({
      'a/thing.ts': 'export class Widget {}\n',
      'index.ts': "export * from './a/thing';\n",
      'consumer.ts': "import { Widget } from './index';\n",
    });

    expect(resolver.resolve('consumer.ts', 'Widget', './index', [DeclKind.Class])).toEqual({
      kind: 'declared',
      filePath: 'a/thing.ts',
      declaredName: 'Widget',
      declKind: DeclKind.Class,
    });
  }, 10_000);

  it('binds when two barrels re-export the SAME declaration (one owner, reached twice)', async () => {
    const resolver = await resolverFor({
      'a/thing.ts': 'export class Widget {}\n',
      'barrel-a.ts': "export * from './a/thing';\n",
      'barrel-b.ts': "export * from './a/thing';\n",
      'index.ts': "export * from './barrel-a';\nexport * from './barrel-b';\n",
      'consumer.ts': "import { Widget } from './index';\n",
    });

    // Both paths land on the same `filePath::declaredName`, so there is exactly one owner and
    // nothing to abstain from — the guard keys on the DECLARATION, not on the number of routes.
    expect(resolver.resolve('consumer.ts', 'Widget', './index', [DeclKind.Class])).toMatchObject({
      kind: 'declared',
      filePath: 'a/thing.ts',
    });
  }, 10_000);
});

describe('re-export chain bounds', () => {
  it('terminates on a mutual `export *` ring instead of recursing forever', async () => {
    const resolver = await resolverFor({
      'a.ts': "export * from './b';\n",
      'b.ts': "export * from './a';\n",
      'consumer.ts': "import { Nowhere } from './a';\n",
    });

    // Nothing in the ring declares the name; the `seen` set is what makes this return at all.
    expect(resolver.resolve('consumer.ts', 'Nowhere', './a', [DeclKind.Class])).toEqual({ kind: 'unresolved' });
  }, 10_000);

  it('terminates on a ring even when a declaration sits inside it', async () => {
    const resolver = await resolverFor({
      'a.ts': "export * from './b';\n",
      'b.ts': "export class Ringed {}\nexport * from './a';\n",
      'consumer.ts': "import { Ringed } from './a';\n",
    });

    expect(resolver.resolve('consumer.ts', 'Ringed', './a', [DeclKind.Class])).toMatchObject({
      kind: 'declared',
      filePath: 'b.ts',
    });
  }, 10_000);

  it('gives up past MAX_REEXPORT_HOPS rather than walking an unbounded chain', async () => {
    const long: Record<string, string> = { 'decl.ts': 'export class Deep {}\n' };
    // 12 named hops — comfortably past the bound, which is deliberately shallow because a real
    // barrel chain is shallow and a deep one is a ring or a mistake.
    for (let i = 0; i < 12; i++) {
      long[`hop${i}.ts`] = `export { Deep } from './${i === 11 ? 'decl' : `hop${i + 1}`}';\n`;
    }
    long['consumer.ts'] = "import { Deep } from './hop0';\n";
    const resolver = await resolverFor(long);

    expect(resolver.resolve('consumer.ts', 'Deep', './hop0', [DeclKind.Class])).toEqual({ kind: 'unresolved' });
  }, 10_000);

  it('still binds a chain INSIDE the bound', async () => {
    const resolver = await resolverFor({
      'decl.ts': 'export class Deep {}\n',
      'hop1.ts': "export { Deep } from './decl';\n",
      'hop0.ts': "export { Deep } from './hop1';\n",
      'consumer.ts': "import { Deep } from './hop0';\n",
    });

    expect(resolver.resolve('consumer.ts', 'Deep', './hop0', [DeclKind.Class])).toMatchObject({
      kind: 'declared',
      filePath: 'decl.ts',
    });
  }, 10_000);
});

describe('declared-dependency manifests', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('proves externality from a WORKSPACE package manifest, not just the root one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sri-workspace-deps-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', devDependencies: { turbo: '^2' } }));
    const structural = [await parseTsStructural('packages/api/src/a.ts', 'export class A {}\n', 'typescript')];
    // pnpm does not symlink a sub-package's deps into the root node_modules, so without reading
    // `packages/api/package.json` there is no proof at all and `express` reads as unresolved —
    // which is what re-enables the by-name hierarchy fabrication.
    mkdirSync(join(dir, 'packages/api'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/api/package.json'),
      JSON.stringify({ name: '@x/api', dependencies: { express: '^4' } }),
    );

    const resolver = await createSymbolIdentityResolver(structural, {
      repoRoot: dir,
      workspacePackageNames: ['root', '@x/api'],
      workspacePackagePaths: ['.', 'packages/api'],
    });

    expect(resolver.resolve('packages/api/src/a.ts', 'Router', 'express', [DeclKind.Class])).toEqual({
      kind: 'external',
    });
    expect(resolver.manifestErrors).toEqual([]);
  }, 10_000);

  it('reports a manifest that exists but will not parse, instead of silently losing its deps', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sri-bad-manifest-'));
    writeFileSync(join(dir, 'package.json'), '{ "dependencies": { "express": ');
    const structural = [await parseTsStructural('a.ts', 'export class A {}\n', 'typescript')];

    const resolver = await createSymbolIdentityResolver(structural, {
      repoRoot: dir,
      workspacePackageNames: [],
      workspacePackagePaths: ['.'],
    });

    expect(resolver.manifestErrors).toHaveLength(1);
    expect(resolver.manifestErrors[0]).toContain('package.json');
    // The cost of the unreadable manifest, stated: externality is no longer provable.
    expect(resolver.resolve('a.ts', 'Router', 'express', [DeclKind.Class])).toEqual({ kind: 'unresolved' });
  }, 10_000);

  it('says nothing when there is simply no manifest (ENOENT is not an error)', async () => {
    const resolver = await resolverFor({ 'a.ts': 'export class A {}\n' });
    expect(resolver.manifestErrors).toEqual([]);
  }, 10_000);
});
