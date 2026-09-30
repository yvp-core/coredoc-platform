/**
 * Acceptance for the declaration hierarchy: `extends` / `implements` clauses must be BOUND to the
 * nodes they name, so the storage layer emits EXTENDS and IMPLEMENTS_INTERFACE instead of a
 * by-name type usage. Field evidence: both edge types read zero across the whole fleet graph, so
 * "what implements this interface" and "what extends this class" were structurally unanswerable.
 *
 * Identity is proved over the module graph, exactly as enum-member references are: a same-named
 * class in an unrelated module never captures the edge, and an external base stays name-only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PROFILE: ExtractionProfile = {
  parserId: 'test-hierarchy-edges',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

const write = (files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
};

const cls = (repo: ParsedRepo, name: string) => repo.classes.find((c) => c.name === name)!;
const iface = (repo: ParsedRepo, name: string) => repo.interfaces.find((i) => i.name === name)!;

describe('class/interface hierarchy references', () => {
  it('binds same-file extends and implements to the declaring nodes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-same-file-'));
    write({
      'shapes.ts': `export interface Runnable {
  run(): void;
}

export class Base {}

export class Worker extends Base implements Runnable {
  run(): void {}
}
`,
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-same-file');

    const worker = cls(repo, 'Worker');
    expect(worker.extends).toEqual({ name: 'Base', resolvedId: cls(repo, 'Base').id });
    expect(worker.implements).toEqual([{ name: 'Runnable', resolvedId: iface(repo, 'Runnable').id }]);
  });

  it('binds a base imported from another module by relative path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-relative-'));
    write({
      'base.ts': 'export class Base {}\nexport interface Port { run(): void }\n',
      'worker.ts': `import { Base, Port } from './base';

export class Worker extends Base implements Port {
  run(): void {}
}
`,
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-relative');

    expect(cls(repo, 'Worker').extends?.resolvedId).toBe(cls(repo, 'Base').id);
    expect(cls(repo, 'Worker').implements?.[0].resolvedId).toBe(iface(repo, 'Port').id);
  });

  it('unwinds an import alias to the exported declaration', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-alias-'));
    write({
      'base.ts': 'export class Base {}\n',
      'worker.ts': "import { Base as B } from './base';\n\nexport class Worker extends B {}\n",
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-alias');

    // The clause says `B`; the node it names is `Base`.
    expect(cls(repo, 'Worker').extends).toEqual({ name: 'B', resolvedId: cls(repo, 'Base').id });
  });

  it('follows a barrel re-export chain to the declaring module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-barrel-'));
    write({
      'domain/base.ts': 'export class Base {}\n',
      'domain/index.ts': "export * from './base';\n",
      'index.ts': "export { Base as RepoBase } from './domain';\n",
      'worker.ts': "import { RepoBase } from './index';\n\nexport class Worker extends RepoBase {}\n",
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-barrel');

    const base = repo.classes.find((c) => c.name === 'Base' && c.location.filePath === 'domain/base.ts')!;
    expect(cls(repo, 'Worker').extends?.resolvedId).toBe(base.id);
  });

  it('resolves a tsconfig path-alias import', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-tsconfig-'));
    write({
      'tsconfig.json': '{\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }\n}\n',
      'src/base.ts': 'export class Base {}\n',
      'src/worker.ts': "import { Base } from '@app/base';\n\nexport class Worker extends Base {}\n",
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-tsconfig');

    expect(cls(repo, 'Worker').extends?.resolvedId).toBe(cls(repo, 'Base').id);
  });

  it('leaves an external base name-only (the class belongs to the package, not this repo)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-external-'));
    write({
      'package.json': '{ "name": "app", "dependencies": { "@vendor/ui": "^1.0.0" } }\n',
      // A local class of the SAME name must not be captured by the vendor import.
      'local.ts': 'export class Component {}\n',
      'widget.ts': "import { Component } from '@vendor/ui';\n\nexport class Widget extends Component {}\n",
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-external');

    // The NAME is kept (the class node mirrors it), but the reference states that the base is
    // proven external: no in-repo node can be it, so the storage layer must not name-match one.
    expect(cls(repo, 'Widget').extends).toEqual({ name: 'Component', external: true });
  });

  it('marks a proven-external implements clause the same way', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-external-impl-'));
    write({
      'package.json': '{ "name": "app", "dependencies": { "@vendor/ui": "^1.0.0" } }\n',
      'local.ts': 'export interface Renderable { render(): void }\n',
      'widget.ts': `import { Renderable } from '@vendor/ui';

export class Widget implements Renderable {
  render(): void {}
}
`,
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-external-impl');

    expect(cls(repo, 'Widget').implements).toEqual([{ name: 'Renderable', external: true }]);
  });

  it('leaves an unproven base unmarked (unresolved is not external)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-unproven-'));
    write({
      // Nothing declares `@unknown/ui` a dependency and nothing installs it: identity is unknown,
      // which is NOT the same claim as "outside this repo".
      'widget.ts': "import { Component } from '@unknown/ui';\n\nexport class Widget extends Component {}\n",
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-unproven');

    expect(cls(repo, 'Widget').extends).toEqual({ name: 'Component' });
  });

  it('never binds a bare name to a same-named class in an unrelated module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-collision-'));
    write({
      'other/base.ts': 'export class Base {}\n',
      // No import at all: `Base` here is a global/ambient name, not that module's class.
      'worker.ts': 'export class Worker extends Base {}\n',
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-collision');

    expect(cls(repo, 'Worker').extends).toEqual({ name: 'Base' });
  });

  it('binds every entry of a multi-base interface extends clause', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-interface-'));
    write({
      'a.ts': 'export interface A { a: string }\n',
      'b.ts': `import { A } from './a';

export interface B { b: string }

export interface C extends A, B, Unknown {
  c: string;
}
`,
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-interface');

    expect(iface(repo, 'C').extends).toEqual([
      { name: 'A', resolvedId: iface(repo, 'A').id },
      { name: 'B', resolvedId: iface(repo, 'B').id },
      // Neither declared here nor imported: refused, not guessed.
      { name: 'Unknown' },
    ]);
  });

  it('binds a generic base on its identifier, leaving the type arguments out of the name', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-hierarchy-generic-'));
    write({
      'base.ts': 'export class Repository<T> { items: T[] = [] }\nexport interface Mapper<T> { map(v: T): T }\n',
      'user.ts': `import { Repository, Mapper } from './base';

export interface User { id: string }

export class UserRepository extends Repository<User> implements Mapper<User> {
  map(v: User): User {
    return v;
  }
}
`,
    });
    const { repo } = await runProfile(PROFILE, dir, 'hierarchy-generic');

    const userRepo = cls(repo, 'UserRepository');
    expect(userRepo.extends).toEqual({ name: 'Repository', resolvedId: cls(repo, 'Repository').id });
    expect(userRepo.implements).toEqual([{ name: 'Mapper', resolvedId: iface(repo, 'Mapper').id }]);
  });
});
