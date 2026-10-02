/**
 * Zig substrate — positive expectations (AC-2) and the anti-scenario twins (AC-3).
 *
 * The twins exist because "wrong node is worse than no node": every emitting rule is
 * paired with a shape that must emit NOTHING (an anonymous container, a `test` block, an
 * error set), or that must attribute to a DIFFERENT owner (a fn inside `Outer.Inner`).
 * A walker that only recognises the fixture's exact shapes would satisfy the positives
 * and fail here.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClassNode, type EnumNode, type FunctionNode, type ParsedRepo, StableIdGenerator } from '@coredoc/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import type { ZigProfile } from '../../types/zig-profile.js';
import { zigProvider } from '../../providers/zig.js';
import { discoverZigFileScope } from './zig-parser.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig');
const REPO_NAME = 'mini-zig';
const CONFIG = 'src/Config.zig';
const UTIL = 'src/util.zig';
const RECOVERY = 'src/recovery.zig';

const profile: ZigProfile = {
  parserId: 'mini-zig-v1',
  substrate: { language: 'zig', include: ['**/*.zig'], exclude: ['vendor/**'] },
};
const BARE: ZigProfile = { parserId: 'mini-zig-v1', substrate: { language: 'zig' } };

const idGen = new StableIdGenerator(FIXTURE, REPO_NAME);

let repo: ParsedRepo;

beforeAll(async () => {
  repo = await zigProvider.parse(profile, { repoRoot: FIXTURE, repoName: REPO_NAME });
});

const classById = (id: string): ClassNode | undefined => repo.classes.find((c) => c.id === id);
const enumById = (id: string): EnumNode | undefined => repo.enums.find((e) => e.id === id);
const fnById = (id: string): FunctionNode | undefined => repo.functions.find((f) => f.id === id);

describe('zig substrate — files, package and stats (BR-7)', () => {
  it('emits one FileNode per in-scope file, owned by the single root package', () => {
    expect(repo.files.map((f) => f.path)).toEqual([CONFIG, RECOVERY, UTIL]);
    expect(repo.packages).toEqual([
      {
        id: idGen.packageId('.'),
        name: REPO_NAME,
        path: '.',
        language: 'zig',
        manifestFile: 'build.zig.zon',
      },
    ]);
    for (const file of repo.files) {
      expect(file.language).toBe('zig');
      expect(file.extension).toBe('.zig');
      expect(file.packageId).toBe(idGen.packageId('.'));
      expect(file.id).toBe(idGen.fileId(file.path));
      expect(file.loc).toBeGreaterThan(0);
    }
    expect(repo.id).toBe(idGen.getRepoHash());
    expect(repo.type).toBe('library');
    expect(repo.stats.totalFiles).toBe(3);
    expect(repo.stats.parsedFiles).toBe(3);
    expect(repo.stats.skippedFiles).toBe(0);
  });

  it('reports the same scope through discoverZigFileScope', () => {
    const scope = discoverZigFileScope(FIXTURE, [], ['vendor/**']);
    expect(scope.included).toEqual([CONFIG, RECOVERY, UTIL]);
    expect(scope.profileExcluded).toEqual(['vendor/skipped.zig']);
  });
});

describe('zig substrate — file-struct (BR-3)', () => {
  const classId = () => idGen.classId(CONFIG, 'Config');

  it('emits a class named for the file, with its top-level fields as properties', () => {
    const cls = classById(classId());
    expect(cls).toBeDefined();
    expect(cls?.name).toBe('Config');
    expect(cls?.fileId).toBe(idGen.fileId(CONFIG));
    expect(cls?.kind).toBe('class');
    expect(cls?.isAbstract).toBe(false);
    expect(cls?.properties.map((p) => ({ name: p.name, type: p.type?.text, defaultValue: p.defaultValue }))).toEqual([
      { name: 'path', type: '[]const u8', defaultValue: undefined },
      { name: 'retries', type: 'u32', defaultValue: '3' },
    ]);
    expect(cls?.properties[0]?.documentation).toBe('Where the artifact is written.');
    expect(cls?.properties.every((p) => p.classId === classId() && p.visibility === 'public' && !p.isStatic)).toBe(
      true,
    );
  });

  it('makes the file-struct own the top-level functions as methods', () => {
    const init = fnById(idGen.methodId(CONFIG, 'Config', 'init'));
    const retryLimit = fnById(idGen.methodId(CONFIG, 'Config', 'retryLimit'));
    const reset = fnById(idGen.methodId(CONFIG, 'Config', 'reset'));
    expect(classById(classId())?.methods).toEqual([init?.id, retryLimit?.id, reset?.id]);
    expect(init?.kind).toBe('method');
    expect(init?.classId).toBe(classId());
    expect(init?.fileId).toBe(idGen.fileId(CONFIG));
    expect(init?.documentation).toBe('Build a config with defaults.\nThe second doc line.');
    expect(init?.returnType?.text).toBe('Self');
    expect(init?.parameters).toEqual([
      { name: 'path', type: { text: '[]const u8' }, isOptional: false, isRest: false },
    ]);
    expect(init?.isAsync).toBe(false);
    expect(init?.isGenerator).toBe(false);
  });

  it('marks visibility and isStatic from `pub` and the receiver parameter (BR-6)', () => {
    const init = fnById(idGen.methodId(CONFIG, 'Config', 'init'));
    const retryLimit = fnById(idGen.methodId(CONFIG, 'Config', 'retryLimit'));
    const reset = fnById(idGen.methodId(CONFIG, 'Config', 'reset'));
    expect([init?.isExported, init?.visibility, init?.isStatic]).toEqual([true, 'public', true]);
    expect([retryLimit?.isExported, retryLimit?.visibility, retryLimit?.isStatic]).toEqual([true, 'public', false]);
    expect([reset?.isExported, reset?.visibility, reset?.isStatic]).toEqual([false, 'private', false]);
  });

  it('qualifies a type nested in the file-struct with the file-struct name', () => {
    const inner = classById(idGen.classId(CONFIG, 'Config.Inner'));
    expect(inner?.name).toBe('Config.Inner');
    expect(inner?.isExported).toBe(true);
    const deeper = fnById(idGen.methodId(CONFIG, 'Config.Inner', 'deeper'));
    expect(deeper?.classId).toBe(inner?.id);
    expect(deeper?.isStatic).toBe(false);
    expect(inner?.methods).toEqual([deeper?.id]);
  });
});

describe('zig substrate — containers and functions in a namespace file (BR-2, BR-4..BR-6)', () => {
  it('emits nested containers as a dotted chain', () => {
    const outer = classById(idGen.classId(UTIL, 'Outer'));
    const inner = classById(idGen.classId(UTIL, 'Outer.Inner'));
    expect(outer?.methods).toEqual([]);
    expect(inner?.name).toBe('Outer.Inner');
    expect(inner?.isExported).toBe(false);
  });

  it('emits an enum as an EnumNode and, when it has functions, a class facet whose id the methods carry', () => {
    const level = enumById(idGen.enumId(UTIL, 'Level'));
    expect(level?.kind).toBe('enum');
    expect(level?.isExported).toBe(true);
    expect(level?.isConst).toBe(true);
    expect(level?.members).toEqual([
      { name: 'low', value: '1' },
      { name: 'high', value: undefined },
    ]);
    const facet = classById(idGen.classId(UTIL, 'Level'));
    const label = fnById(idGen.methodId(UTIL, 'Level', 'label'));
    expect(facet?.methods).toEqual([label?.id]);
    expect(label?.classId).toBe(facet?.id);
    expect(label?.isStatic).toBe(false);
  });

  it('emits no class facet for an enum without functions', () => {
    expect(enumById(idGen.enumId(UTIL, 'Plain'))?.members).toEqual([
      { name: 'first', value: undefined },
      { name: 'second', value: undefined },
    ]);
    expect(classById(idGen.classId(UTIL, 'Plain'))).toBeUndefined();
  });

  it('emits an extern fn (no body) and an export fn', () => {
    const native = fnById(idGen.functionId(UTIL, 'native'));
    expect(native?.kind).toBe('function');
    expect(native?.isExported).toBe(true);
    expect(native?.returnType?.text).toBe('i32');
    expect(native?.parameters).toEqual([{ name: 'handle', type: { text: 'i32' }, isOptional: false, isRest: false }]);
    expect(fnById(idGen.functionId(UTIL, 'shim'))?.kind).toBe('function');
  });

  it('carries the declaration source text on every function, as Swift and Go do', () => {
    const native = fnById(idGen.functionId(UTIL, 'native'));
    expect(native?.sourceCode).toMatch(/^pub extern .*fn native\(/);
    const listAppend = fnById(idGen.methodId(UTIL, 'List', 'append'));
    expect(listAppend?.sourceCode).toMatch(/^pub fn append\(/);
  });

  it('emits a generic type constructor as BOTH a function and a class with the inner methods (BR-5)', () => {
    const fn = fnById(idGen.functionId(UTIL, 'List'));
    expect(fn?.kind).toBe('function');
    expect(fn?.returnType?.text).toBe('type');
    const cls = classById(idGen.classId(UTIL, 'List'));
    expect(cls?.properties.map((p) => p.name)).toEqual(['items']);
    const append = fnById(idGen.methodId(UTIL, 'List', 'append'));
    expect(cls?.methods).toEqual([append?.id]);
    expect(append?.classId).toBe(cls?.id);
    expect(append?.isStatic).toBe(false);
  });

  it('emits fields of a struct with an anonymous field type as ordinary properties', () => {
    const wrapper = classById(idGen.classId(UTIL, 'Wrapper'));
    expect(
      wrapper?.properties.map((p) => ({ name: p.name, type: p.type?.text, defaultValue: p.defaultValue })),
    ).toEqual([
      { name: 'inner', type: 'struct { w: f32 }', defaultValue: undefined },
      { name: 'seed', type: 'u8', defaultValue: '7' },
    ]);
  });

  it('keeps every id, versionedId and name well-formed and referentially intact', () => {
    const full = repo;
    const report = checkReferentialIntegrity(full);
    expect(report.violations).toEqual([]);
    for (const node of [...repo.classes, ...repo.enums, ...repo.functions]) {
      expect(node.name.length).toBeGreaterThan(0);
      expect(idGen.belongsToRepo(node.id)).toBe(true);
      expect(idGen.getStableId(node.versionedId)).toBe(node.id);
    }
  });

  it('adapts to a full ParsedRepo with honest empty collections', () => {
    const full = repo;
    expect(full.type).toBe('library');
    expect(full.parserId).toBe('mini-zig-v1');
    // Empty because this fixture HAS none of them — `interfaces` is the only one empty by
    // design (LIM-A). The `std` imports it does have are the assembly describe's business.
    expect([full.interfaces, full.entrypoints, full.entities, full.dbOperations, full.externalCalls]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(full.stats.totalFunctions).toBe(repo.functions.length);
    expect(full.stats.totalClasses).toBe(repo.classes.length);
    expect(full.stats.parsedFiles).toBe(repo.files.length);
    expect(full.enums).toBe(repo.enums);
  });
});

describe('zig substrate — anti-scenarios (AC-3)', () => {
  it('(a) a namespace file emits no synthetic class and no method', () => {
    expect(repo.classes.find((c) => c.name === 'util')).toBeUndefined();
    const add = fnById(idGen.functionId(UTIL, 'add'));
    const secret = fnById(idGen.functionId(UTIL, 'secret'));
    expect(add?.kind).toBe('function');
    expect(add?.classId).toBeUndefined();
    expect(add?.documentation).toBe('Sum two numbers.');
    expect(secret?.isExported).toBe(false);
    // The only methods a namespace file can contribute are those declared INSIDE a container.
    const methodNames = repo.functions
      .filter((f) => f.fileId === idGen.fileId(UTIL) && f.kind === 'method')
      .map((f) => f.name)
      .sort();
    expect(methodNames).toEqual(['append', 'deep', 'label']);
  });

  it('(b) an anonymous struct field type and a `.{ … }` initializer emit no class', () => {
    const utilClasses = repo.classes
      .filter((c) => c.fileId === idGen.fileId(UTIL))
      .map((c) => c.name)
      .sort();
    expect(utilClasses).toEqual([
      'Bits',
      'Empty',
      'Level',
      'List',
      'Outer',
      'Outer.Inner',
      'Pair',
      'Payload',
      'Raw',
      'Wrapper',
    ]);
    expect(repo.classes.some((c) => c.name.includes('defaults'))).toBe(false);
  });

  it('(c) `test`, `error{}` and `comptime {}` emit nothing', () => {
    expect(repo.classes.some((c) => c.name === 'Failure')).toBe(false);
    expect(repo.enums.some((e) => e.name === 'Failure')).toBe(false);
    expect(repo.functions.some((f) => f.name.includes('adds numbers'))).toBe(false);
    expect(repo.functions.map((f) => f.name)).not.toContain('test');
  });

  it('(d) a `type`-returning fn whose body does not return a container emits only the function', () => {
    expect(fnById(idGen.functionId(UTIL, 'make'))?.kind).toBe('function');
    expect(classById(idGen.classId(UTIL, 'make'))).toBeUndefined();
    expect(repo.enums.some((e) => e.name === 'make')).toBe(false);
  });

  it('(e) a file whose grammar recovery produces errors still emits its other declarations', () => {
    expect(fnById(idGen.functionId(RECOVERY, 'keep'))?.isExported).toBe(true);
    expect(fnById(idGen.functionId(RECOVERY, 'legacy'))?.isExported).toBe(false);
    expect(classById(idGen.classId(RECOVERY, 'Kept'))?.properties.map((p) => p.name)).toEqual(['id']);
  });

  it('(f) a fn inside Outer.Inner is a method of Outer.Inner, never a top-level fn or a method of Outer', () => {
    const deep = fnById(idGen.methodId(UTIL, 'Outer.Inner', 'deep'));
    expect(deep?.kind).toBe('method');
    expect(deep?.classId).toBe(idGen.classId(UTIL, 'Outer.Inner'));
    expect(fnById(idGen.functionId(UTIL, 'deep'))).toBeUndefined();
    expect(fnById(idGen.methodId(UTIL, 'Outer', 'deep'))).toBeUndefined();
    expect(classById(idGen.classId(UTIL, 'Outer'))?.methods).toEqual([]);
  });

  it('(g) `packed struct(u8)` and `extern struct` are classes, not dropped', () => {
    expect(classById(idGen.classId(UTIL, 'Bits'))?.properties.map((p) => p.name)).toEqual(['lo', 'hi']);
    expect(classById(idGen.classId(UTIL, 'Raw'))?.properties.map((p) => p.name)).toEqual(['handle']);
  });

  it('(h) a `.zig` file matched by `exclude` contributes no file and no nodes', () => {
    expect(repo.files.some((f) => f.path.startsWith('vendor/'))).toBe(false);
    expect(repo.classes.some((c) => c.name === 'Ignored')).toBe(false);
    expect(repo.functions.some((f) => f.name === 'get')).toBe(false);
  });

  it('(i) `union(enum)` is a class, not an EnumNode', () => {
    expect(classById(idGen.classId(UTIL, 'Payload'))?.properties.map((p) => p.name)).toEqual(['num', 'text']);
    expect(enumById(idGen.enumId(UTIL, 'Payload'))).toBeUndefined();
  });

  it('(j) an empty container emits no phantom property and no phantom enum member', () => {
    // The grammar inserts a zero-width `container_field` into `struct {}` / `enum {}`.
    const empty = classById(idGen.classId(UTIL, 'Empty'));
    expect(empty?.properties).toEqual([]);
    expect(enumById(idGen.enumId(UTIL, 'Nothing'))?.members).toEqual([]);
  });

  it('(k) a tuple struct emits positional, uniquely identified properties carrying the type text', () => {
    const pair = classById(idGen.classId(UTIL, 'Pair'));
    expect(pair?.properties.map((p) => p.name)).toEqual(['0', '1']);
    expect(pair?.properties.map((p) => p.type?.text)).toEqual(['[]const u8', 'u32']);
    const ids = pair?.properties.map((p) => p.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });
});

/**
 * Step 9 (BR-18): the lanes' own tests wire each lane by hand; this one asserts that
 * `zigProvider.parse` wires ALL of them once, over the same two fixtures, and that the adapted
 * `ParsedRepo` carries every collection with stats that are the emitted lengths — the
 * failure this catches is a lane that works in isolation but is never called by the parser.
 */
describe('zig substrate — full assembly (BR-18, AC-12)', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
  let graph: ParsedRepo;
  let data: ParsedRepo;

  beforeAll(async () => {
    graph = await zigProvider.parse(BARE, { repoRoot: join(FIXTURES, 'mini-zig-graph'), repoName: 'mini-zig-graph' });
    data = await zigProvider.parse(BARE, { repoRoot: join(FIXTURES, 'mini-zig-data'), repoName: 'mini-zig-data' });
  });

  it('fills the graph collections from mini-zig-graph', () => {
    expect(graph.imports.length).toBeGreaterThan(0);
    expect(graph.imports.some((i) => i.moduleSpecifier === 'hub' && i.targetFileId !== undefined)).toBe(true);
    expect(graph.calls.length).toBeGreaterThan(0);
    expect(graph.calls.every((c) => c.calleeId !== undefined)).toBe(true);
    expect(new Set(graph.calls.map((c) => c.provenance))).toEqual(
      new Set(['zig-local', 'zig-self', 'zig-type', 'zig-import', 'zig-field']),
    );
    // `seen` vs `callSites` (LIM-6) is pinned on `resolveZigCalls` itself in zig-callgraph.test.ts.
    // The language-neutral record the graph reports, from the same measurement (BR-1/BR-2).
    expect(graph.stats.callResolution).toEqual({ callSites: 13, resolvedCalls: 10, outOfScopeCalls: 2 });
    expect(graph.stats.callResolution?.resolvedCalls).toBe(graph.calls.length);
    expect(graph.entrypoints.map((e) => (e.details as { command: string }).command)).toEqual(['main']);
    // BR-4: the db-op record travels the same way (this fixture executes no SQL).
    expect(graph.stats.dbOpResolution).toEqual({ dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 });
  });

  it('classifies constants and aliases (AC-12)', () => {
    const variables = new Map(graph.variables.map((v) => [v.name, v]));
    const aliases = new Map(graph.typeAliases.map((t) => [t.name, t]));

    expect(variables.get('VERSION')).toMatchObject({
      kind: 'variable',
      declarationKind: 'const',
      isExported: true,
      initialValue: '"1.0"',
    });
    expect(variables.get('counter')).toMatchObject({
      kind: 'variable',
      declarationKind: 'var',
      isExported: false,
      type: { text: 'u32' },
      initialValue: '0',
    });
    expect(aliases.get('Error')).toMatchObject({ kind: 'type-alias', aliasedType: { text: 'error{ Oops }' } });
    expect(aliases.get('Outer.Self')).toMatchObject({ aliasedType: { text: '@This()' } });
    expect(aliases.get('In')).toMatchObject({ aliasedType: { text: 'Outer.Inner' } });
    // A pure import binding is its ImportEdge, never a variable and never an alias (BR-16).
    expect(variables.has('std') || aliases.has('std')).toBe(false);
  });

  it('fills the data collections from mini-zig-data', () => {
    expect(data.entities.map((e) => e.tableName)).toEqual(['cache', 'cache_owner', 'pragma_first']);
    expect(data.dbOperations.length).toBeGreaterThan(0);
    // Every op on a DECLARED table joins to its entity; the one on `unknown_t` (no DDL
    // anywhere) is kept without one, and the one on the `test`-block-only `t_test` is dropped.
    expect(data.dbOperations.filter((op) => op.entityId === undefined).map((op) => op.entityName)).toEqual([
      'unknown_t',
    ]);
    expect(data.externalCalls.length).toBeGreaterThan(0);
    expect(data.entrypoints.map((e) => (e.details as { command: string }).command)).toEqual([
      'tool',
      'second-tool',
      'third',
    ]);
  });

  it('reports stats that are the emitted lengths and stays referentially intact', () => {
    for (const repo of [graph, data]) {
      const full = repo;
      expect(full.stats).toMatchObject({
        totalFunctions: full.functions.length,
        totalClasses: full.classes.length,
        totalCalls: full.calls.length,
        totalImports: full.imports.length,
        totalEntrypoints: full.entrypoints.length,
        totalEntities: full.entities.length,
        totalExternalCalls: full.externalCalls.length,
        parsedFiles: full.files.length,
      });
      // LIM-A: the only collection that stays empty by design.
      expect(full.interfaces).toEqual([]);
      const report = checkReferentialIntegrity(full);
      expect(report.violations, repo.name).toEqual([]);
      expect(report.danglingRefs, repo.name).toBe(0);
    }
  });
});

/**
 * D1: the built-in exclude policy, mirroring `DEFAULT_RS_EXCLUDES`. `build.zig` is a build
 * SCRIPT — its `pub fn build` is not repo behaviour and its presence in scope also makes it an
 * `@import` target — so it is excluded from the parsed source set while `parseZigBuild` keeps
 * reading it off disk.
 */
describe('discoverZigFileScope — built-in excludes (D1)', () => {
  const write = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'zig-scope-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  };

  const tree = {
    'build.zig': 'pub fn build() void {}\n',
    'src/main.zig': 'pub fn main() void {}\n',
    'zig-out/bin/gen.zig': 'pub fn gen() void {}\n',
    '.zig-cache/o/tmp.zig': 'pub fn tmp() void {}\n',
    'vendor/dep.zig': 'pub fn dep() void {}\n',
  };

  it('drops build.zig and the build-output trees, and the profile exclude still ADDS', () => {
    const root = write(tree);

    expect(discoverZigFileScope(root, [], []).included).toEqual(['src/main.zig', 'vendor/dep.zig']);
    expect(discoverZigFileScope(root, [], ['vendor/**']).included).toEqual(['src/main.zig']);
  });

  it('opts out entirely with excludeDefaults: false', () => {
    const root = write(tree);

    expect(discoverZigFileScope(root, [], [], false).included).toContain('build.zig');
  });

  it('keeps build.zig out of the parsed files and out of import resolution', async () => {
    const root = write({
      ...tree,
      // A file that imports the build script by path: with `build.zig` out of scope the edge is
      // external, never a repo file edge.
      'src/uses.zig': 'const b = @import("../build.zig");\npub fn go() void {\n    b.build();\n}\n',
    });

    const out = await zigProvider.parse(BARE, { repoRoot: root, repoName: 'zig-scope' });

    expect(out.files.map((f) => f.path)).not.toContain('build.zig');
    expect(out.functions.map((f) => f.name)).not.toContain('build');
    const edge = out.imports.find((i) => i.moduleSpecifier === '../build.zig');
    expect(edge?.targetFileId).toBeUndefined();
    expect(out.calls.map((c) => c.calleeExpression)).not.toContain('b.build');
  });
});

// A broken SYMLINK cannot express this case: discovery `statSync`s every entry, so it throws
// before the parser sees the file. An unreadable mode does, and is the same `readFileSync`
// failure at the same place — except when the suite runs as root, where nothing is unreadable.
describe.skipIf(process.getuid?.() === 0)('zig substrate — an unreadable file (BR-8)', () => {
  it('counts it in skippedFiles and still parses its sibling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zig-unreadable-'));
    const locked = join(root, 'locked.zig');
    writeFileSync(join(root, 'ok.zig'), 'pub fn only() void {}\n');
    writeFileSync(locked, 'pub fn hidden() void {}\n');
    chmodSync(locked, 0o000);

    try {
      const out = await zigProvider.parse(profile, { repoRoot: root, repoName: 'unreadable' });

      expect(out.stats).toMatchObject({ totalFiles: 2, parsedFiles: 1, skippedFiles: 1 });
      expect(out.errors).toEqual([
        { file: 'locked.zig', message: 'zig: file could not be read or parsed', severity: 'error' },
      ]);
      expect(out.functions.map((f) => f.name)).toEqual(['only']);
      expect(out.files.map((f) => f.path)).toEqual(['ok.zig']);
    } finally {
      chmodSync(locked, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
