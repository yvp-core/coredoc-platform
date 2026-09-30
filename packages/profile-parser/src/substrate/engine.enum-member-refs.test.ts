/**
 * Acceptance for value-position enum-member references: code that BRANCHES on a specific member
 * (`state === Status.Locked`) must be a reference to the enum carrying the member name, distinct
 * from code that merely uses the enum as a TYPE.
 *
 * Field evidence: the graph modelled the enum declaration and its type-level consumers only, so
 * "who consumes this enum" answered half the question and an added member looked consumer-free.
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

const SOURCE = `export enum Status {
  Open = 'open',
  Locked = 'locked',
}

/** TYPE-level consumer: names the enum in an annotation, never a member. */
export function describeStatus(status: Status): string {
  return String(status);
}

/** VALUE-level consumer: branches on one member. */
export function isLocked(status: Status): boolean {
  const repeated = status === Status.Locked;
  return repeated && status !== Status.Open;
}

export class Gate {
  check(status: Status): boolean {
    return status === Status.Locked;
  }
}

/** Not an enum member reference: a property read on a local object. */
export function readConfig(config: { Locked: boolean }): boolean {
  return config.Locked;
}
`;

const PROFILE: ExtractionProfile = {
  parserId: 'test-enum-member-refs',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

describe('enum member references — value position', () => {
  it('emits a member-carrying reference from the branching consumer and none from the type-level one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-'));
    writeFileSync(join(dir, 'status.ts'), SOURCE);
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs');

    const refs = repo.enumMemberReferences ?? [];
    const byMember = (name: string, fnName: string) =>
      refs.filter((r) => r.member === name && r.sourceId.endsWith(fnName));

    // The branching function references BOTH members it compares against.
    expect(byMember('Locked', 'isLocked')).toHaveLength(1);
    expect(byMember('Open', 'isLocked')).toHaveLength(1);
    // Repeated comparison against the same member collapses into one reference.
    expect(refs.filter((r) => r.member === 'Locked' && r.sourceId.endsWith('isLocked'))).toHaveLength(1);
    // A method body is a consumer too.
    expect(byMember('Locked', 'Gate.check')).toHaveLength(1);

    // Every reference names the enum and points at an emitted enum node.
    const statusEnum = repo.enums.find((e) => e.name === 'Status');
    expect(statusEnum).toBeDefined();
    expect(new Set(refs.map((r) => r.enumName))).toEqual(new Set(['Status']));

    // The TYPE-level consumer carries the enum as an annotation and produces NO member reference —
    // the two consumers are distinguishable.
    const describeFn = repo.functions.find((f) => f.name === 'describeStatus');
    expect(describeFn?.parameters[0]?.type?.text).toBe('Status');
    expect(refs.some((r) => r.sourceId.endsWith('describeStatus'))).toBe(false);

    // A same-named property on a plain object is not an enum reference.
    expect(refs.some((r) => r.sourceId.endsWith('readConfig'))).toBe(false);

    // Declared in the referencing file: nothing to resolve, no import to record. The declaring
    // file is the referencing file itself, so downstream identity resolution filters to the local
    // enum instead of name-matching every same-named enum in the repo.
    expect(refs.every((r) => r.importedFrom === undefined)).toBe(true);
    expect(refs.every((r) => r.declaringFile !== undefined && r.declaringFile.endsWith('status.ts'))).toBe(true);
  });

  it('records the exported name and module of an aliased import, not the local alias', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-alias-'));
    writeFileSync(join(dir, 'status.ts'), SOURCE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status as S } from './status';

export function isAliasLocked(value: S): boolean {
  return value === S.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-alias');

    const aliased = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isAliasLocked'));
    expect(aliased).toHaveLength(1);
    // The alias `S` never names an enum node — the EXPORTED name does.
    expect(aliased[0]).toMatchObject({
      enumName: 'Status',
      member: 'Locked',
      importedFrom: './status',
      declaringFile: 'status.ts',
    });
  });

  it('records the module of a plain (non-aliased) import so identity is checkable downstream', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-import-'));
    writeFileSync(join(dir, 'status.ts'), SOURCE);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status } from './status';

export function isPlainLocked(value: Status): boolean {
  return value === Status.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-import');

    const imported = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isPlainLocked'));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      enumName: 'Status',
      member: 'Locked',
      importedFrom: './status',
      declaringFile: 'status.ts',
    });
  });

  it('keeps two references when one function reads the same member name from two modules', async () => {
    // Same source, same exported enum name, same member — only the module differs. Keyed without
    // the module these collapse into one edge and one of the two dependencies disappears.
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-two-modules-'));
    writeFileSync(join(dir, 'a.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(join(dir, 'b.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status } from './a';
import { Status as B } from './b';

export function isEitherLocked(left: Status, right: B): boolean {
  return left === Status.Locked || right === B.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-two-modules');

    const refs = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isEitherLocked'));
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.importedFrom).sort()).toEqual(['./a', './b']);
    expect(new Set(refs.map((r) => r.id)).size).toBe(2);
  });

  it('follows a barrel re-export to the module that DECLARES the enum', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-barrel-'));
    writeFileSync(join(dir, 'a.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(join(dir, 'index.ts'), "export { Status } from './a';\n");
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status } from './index';

export function isBarrelLocked(value: Status): boolean {
  return value === Status.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-barrel');

    const refs = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isBarrelLocked'));
    expect(refs).toHaveLength(1);
    // The site names the barrel; the resolved identity names the declaration.
    expect(refs[0].importedFrom).toBe('./index');
    expect(refs[0].declaringFile).toBe('a.ts');
  });

  it('follows a chain of barrels and an aliasing star re-export to the declaring module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-barrel-chain-'));
    mkdirSync(join(dir, 'domain'), { recursive: true });
    writeFileSync(join(dir, 'domain', 'status.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(join(dir, 'domain', 'index.ts'), "export * from './status';\n");
    writeFileSync(join(dir, 'index.ts'), "export { Status as RepoStatus } from './domain';\n");
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { RepoStatus } from './index';

export function isChainLocked(value: RepoStatus): boolean {
  return value === RepoStatus.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-barrel-chain');

    const refs = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isChainLocked'));
    expect(refs).toHaveLength(1);
    // The re-export alias is unwound too: the declaring module exports it as `Status`.
    expect(refs[0]).toMatchObject({ enumName: 'Status', member: 'Locked', declaringFile: 'domain/status.ts' });
  });

  it('resolves a tsconfig path-alias import to the declaring module', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-alias-path-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      // Comments are legal in a tsconfig — the reader must tolerate them.
      '{\n  // paths for the app\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }\n}\n',
    );
    writeFileSync(join(dir, 'src', 'status.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(
      join(dir, 'src', 'consumer.ts'),
      `import { Status } from '@app/status';

export function isAliasPathLocked(value: Status): boolean {
  return value === Status.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-alias-path');

    const refs = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isAliasPathLocked'));
    expect(refs).toHaveLength(1);
    expect(refs[0].declaringFile).toBe('src/status.ts');
  });

  it('drops a reference whose module is a declared external dependency, same name or not', async () => {
    // The enum is the PACKAGE's, not this repo's. Keeping a name-matched reference to the local
    // `Status` would fabricate a dependency that does not exist in the code.
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-external-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "app", "dependencies": { "@vendor/status": "^1.0.0" } }\n');
    writeFileSync(join(dir, 'status.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status } from '@vendor/status';

export function isVendorLocked(value: Status): boolean {
  return value === Status.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-external');

    expect((repo.enumMemberReferences ?? []).some((r) => r.sourceId.endsWith('isVendorLocked'))).toBe(false);
  });

  it('keeps an unresolvable specifier as a reference without a declaring file (honest refusal)', async () => {
    // Nothing proves this module external and nothing resolves it in-repo: the reference stays,
    // unresolved, for the storage layer to mark ambiguous — neither dropped nor trusted.
    dir = mkdtempSync(join(tmpdir(), 'pp-enum-member-refs-unresolved-'));
    writeFileSync(join(dir, 'status.ts'), 'export enum Status {\n  Locked = "locked",\n}\n');
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { Status } from '@unknown/status';

export function isUnknownLocked(value: Status): boolean {
  return value === Status.Locked;
}
`,
    );
    const { repo } = await runProfile(PROFILE, dir, 'enum-member-refs-unresolved');

    const refs = (repo.enumMemberReferences ?? []).filter((r) => r.sourceId.endsWith('isUnknownLocked'));
    expect(refs).toHaveLength(1);
    expect(refs[0].declaringFile).toBeUndefined();
  });
});
