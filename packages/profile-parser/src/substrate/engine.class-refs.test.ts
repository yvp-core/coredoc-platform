/**
 * Acceptance for class usage references: code that CONSTRUCTS a class (`new UserService(...)`) or
 * IMPORTS it must be a reference to that class.
 *
 * Field evidence: a class's only incoming edge was the containment edge from its own file, so
 * "who uses this class" rendered a zero next to a service file that imports it and constructs it on
 * every request. Identity is proved over the module graph — a same-named class in an unrelated
 * module must never capture the reference.
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
  parserId: 'test-class-refs',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

const SERVICE = `export class UserService {
  load(id: string): string {
    return id;
  }
}
`;

/** Construction references sourced at the named function/method. */
const constructions = (repo: ParsedRepo, fn: string) =>
  (repo.classReferences ?? []).filter((r) => r.refKind === 'construction' && r.sourceId.endsWith(fn));

/** Import references sourced at the named file's node. */
const imports = (repo: ParsedRepo, file: string) =>
  (repo.classReferences ?? []).filter((r) => r.refKind === 'import' && r.sourceId.endsWith(`file:${file}`));

describe('class references — construction and import', () => {
  it('emits a construction reference for a class declared in the same file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-same-file-'));
    writeFileSync(
      join(dir, 'service.ts'),
      `${SERVICE}
export function makeService(): UserService {
  const first = new UserService();
  const second = new UserService();
  return first ?? second;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-same-file');

    const refs = constructions(repo, 'makeService');
    // Two `new` sites in one function are one dependency, not two.
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      className: 'UserService',
      declaringFile: 'service.ts',
      importedFrom: undefined,
    });
    // The class it names is an emitted node.
    expect(repo.classes.some((c) => c.name === 'UserService')).toBe(true);
  });

  it('resolves a cross-file named import to the declaring module, from a method body too', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-cross-file-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'controller.ts'),
      `import { UserService } from './service';

export class Controller {
  handle(): string {
    return new UserService().load('1');
  }
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-cross-file');

    const refs = constructions(repo, 'Controller.handle');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      className: 'UserService',
      importedFrom: './service',
      declaringFile: 'service.ts',
    });
  });

  it('records the exported name of an aliased import, not the local alias', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-alias-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService as Svc } from './service';

export function build(): Svc {
  return new Svc();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-alias');

    const refs = constructions(repo, 'build');
    expect(refs).toHaveLength(1);
    // The alias `Svc` names no class node — the EXPORTED name does.
    expect(refs[0]).toMatchObject({ className: 'UserService', declaringFile: 'service.ts' });
  });

  it('follows a barrel chain and an aliasing re-export to the declaring module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-barrel-'));
    mkdirSync(join(dir, 'domain'), { recursive: true });
    writeFileSync(join(dir, 'domain', 'service.ts'), SERVICE);
    writeFileSync(join(dir, 'domain', 'index.ts'), "export * from './service';\n");
    writeFileSync(join(dir, 'index.ts'), "export { UserService as RepoService } from './domain';\n");
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { RepoService } from './index';

export function buildFromBarrel(): RepoService {
  return new RepoService();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-barrel');

    const refs = constructions(repo, 'buildFromBarrel');
    expect(refs).toHaveLength(1);
    // The site names the barrel; the resolved identity names the declaration, under its declared name.
    expect(refs[0]).toMatchObject({
      className: 'UserService',
      importedFrom: './index',
      declaringFile: 'domain/service.ts',
    });
  });

  it('resolves a tsconfig path-alias import to the declaring module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-path-alias-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{\n  // paths for the app\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }\n}\n',
    );
    writeFileSync(join(dir, 'src', 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'src', 'consumer.ts'),
      `import { UserService } from '@app/service';

export function buildFromAlias(): UserService {
  return new UserService();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-path-alias');

    const refs = constructions(repo, 'buildFromAlias');
    expect(refs).toHaveLength(1);
    expect(refs[0].declaringFile).toBe('src/service.ts');
  });

  it('drops a reference whose module is a declared external dependency, same name or not', async () => {
    // The class is the PACKAGE's, not this repo's. A name-matched reference to the local
    // `UserService` would fabricate a dependency that does not exist in the code.
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-external-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "app", "dependencies": { "@vendor/users": "^1.0.0" } }\n');
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService } from '@vendor/users';

export function buildVendor(): UserService {
  return new UserService();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-external');

    expect(constructions(repo, 'buildVendor')).toHaveLength(0);
    expect(imports(repo, 'consumer.ts')).toHaveLength(0);
  });

  it('refuses a same-name collision in an unrelated module rather than name-matching it', async () => {
    // `other.ts` imports a FUNCTION named UserService from its own module; a repo-wide bare-name
    // match would hand that site the class in service.ts.
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-collision-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(join(dir, 'factory.ts'), 'export function UserService(): string {\n  return "not a class";\n}\n');
    writeFileSync(
      join(dir, 'other.ts'),
      `import { UserService } from './factory';

export function buildOther(): string {
  return String(new UserService());
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-collision');

    expect(constructions(repo, 'buildOther')).toHaveLength(0);
    expect(imports(repo, 'other.ts')).toHaveLength(0);
  });

  it('keeps an unresolvable specifier as a reference without a declaring file (honest refusal)', async () => {
    // Nothing proves this module external and nothing resolves it in-repo: the reference stays,
    // unresolved, for the storage layer to mark ambiguous — neither dropped nor trusted.
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-unresolved-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService } from '@unknown/users';

export function buildUnknown(): UserService {
  return new UserService();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-unresolved');

    const refs = constructions(repo, 'buildUnknown');
    expect(refs).toHaveLength(1);
    expect(refs[0].declaringFile).toBeUndefined();
  });

  it('emits an import reference from the importing FILE when nothing constructs the class there', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-import-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService } from './service';

export function describeService(svc: UserService): string {
  return svc.load('1');
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-import');

    const refs = imports(repo, 'consumer.ts');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      className: 'UserService',
      importedFrom: './service',
      declaringFile: 'service.ts',
    });
    // The importing FILE is the source: an import belongs to the module, not to any function in it.
    expect(repo.files.some((f) => f.id === refs[0].sourceId)).toBe(true);
  });

  it('emits no import reference for a type-only import, whole-statement or inline', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-type-only-'));
    writeFileSync(join(dir, 'service.ts'), `${SERVICE}export class Other {}\n`);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import type { UserService } from './service';
import { type Other } from './service';

export function describeTypes(svc: UserService, other: Other): string {
  return svc.load('1') + String(other);
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-type-only');

    // Type position is already carried by the annotations; an import row here would double-count it.
    expect(imports(repo, 'consumer.ts')).toHaveLength(0);
  });

  it('refuses a default import and a namespace-qualified construction', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-default-'));
    writeFileSync(join(dir, 'service.ts'), `${SERVICE}export default UserService;\n`);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import UserService from './service';
import * as svc from './service';

export function buildDefault(): unknown {
  return [new UserService(), new svc.UserService()];
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-default');

    // A default import binds no exported name to look up, and a dotted constructor names a symbol
    // through a namespace — neither is guessed.
    expect(constructions(repo, 'buildDefault')).toHaveLength(0);
    expect(imports(repo, 'consumer.ts')).toHaveLength(0);
  });

  it('sources a MODULE-SCOPE construction at the constructing file', async () => {
    // `export const client = new UserService()` is the shape a singleton/DI-less module uses, and
    // it has no enclosing function to source the reference at. The module itself is the constructor.
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-module-scope-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'client.ts'),
      `import { UserService } from './service';

export const client = new UserService();
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-module-scope');

    const refs = (repo.classReferences ?? []).filter(
      (r) => r.refKind === 'construction' && r.sourceId.endsWith('file:client.ts'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      className: 'UserService',
      importedFrom: './service',
      declaringFile: 'service.ts',
    });
    // The source is a real emitted node, so the edge is not dangling.
    expect(repo.files.some((f) => f.id === refs[0].sourceId)).toBe(true);
  });

  it('carries the local alias of an aliased import so the row can name what a reader greps for', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-alias-local-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService as Svc } from './service';

export function describeSvc(svc: Svc): string {
  return svc.load('1');
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-alias-local');

    const refs = imports(repo, 'consumer.ts');
    expect(refs).toHaveLength(1);
    // The class is `UserService`; the module calls it `Svc`.
    expect(refs[0]).toMatchObject({ className: 'UserService', localName: 'Svc' });
  });

  it('leaves localName unset when the import is not renamed (no payload for a non-fact)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-no-alias-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService } from './service';

export function describePlain(svc: UserService): string {
  return svc.load('1');
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-no-alias');

    expect(imports(repo, 'consumer.ts')[0].localName).toBeUndefined();
  });

  it('emits both the construction and the import when a file does both (the graph keeps both facts)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-class-refs-both-'));
    writeFileSync(join(dir, 'service.ts'), SERVICE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { UserService } from './service';

export function buildBoth(): UserService {
  return new UserService();
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'class-refs-both');

    // Two DIFFERENT sources (the function constructs, the file imports) — the storage layer is what
    // suppresses the weaker import row, so the parse output still carries both facts.
    expect(constructions(repo, 'buildBoth')).toHaveLength(1);
    expect(imports(repo, 'consumer.ts')).toHaveLength(1);
  });
});
