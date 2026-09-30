/**
 * `ZigFileFacts` — the single-walk fact collection every slice-2 lane reads (BR-9, BR-11,
 * BR-14, BR-15, BR-16, BR-18).
 *
 * Each positive has the anti-scenario twin that matters for it: a call inside a `test` block,
 * a builtin "call", an `@embedFile` that is not an import, a `++` with a non-literal operand.
 * Recording LESS is the correct failure mode — a lane can drop a recorded row (`std.debug.print`
 * is the callgraph lane's to drop), but it cannot invent one this walk never saw.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ZigFileFacts, extractZigFileFacts, toZigFile } from './zig-declarations.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-facts');
const REL = 'src/facts.zig';
const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-facts');

let facts: ZigFileFacts;

/** Facts for an inline source, for shapes the fixture should not carry. */
async function factsOf(source: string, relPath = 'src/inline.zig'): Promise<ZigFileFacts> {
  return extractZigFileFacts(await toZigFile(relPath, source), new StableIdGenerator(FIXTURE, 'inline'));
}

beforeAll(async () => {
  facts = extractZigFileFacts(await toZigFile(REL, readFileSync(join(FIXTURE, REL), 'utf-8')), idGen);
});

describe('extractZigFileFacts — declarations and index', () => {
  it('still returns the slice-1 declarations', () => {
    expect(facts.decls.classes.map((c) => c.name)).toEqual(['Cache']);
    expect(facts.decls.functions.map((f) => f.name).sort()).toEqual(['exec', 'helper', 'load', 'main']);
  });

  it('indexes top-level functions, containers with their methods and property types', () => {
    expect([...facts.index.topLevelFunctions.keys()].sort()).toEqual(['exec', 'helper', 'main']);
    const cache = facts.index.containers.get('Cache');
    expect(cache?.classId).toBe(idGen.classId(REL, 'Cache'));
    expect([...(cache?.methodsByName.keys() ?? [])]).toEqual(['load']);
    expect(cache?.methodsByName.get('load')?.id).toBe(idGen.methodId(REL, 'Cache', 'load'));
    expect(cache?.propertyTypes.get('client')).toBe('std.http.Client');
    expect(cache?.propertyTypes.get('url')).toBe('[]const u8');
    // No top-level `container_field` here, so the file is a namespace, not a struct (BR-3).
    expect(facts.index.fileStruct).toBeUndefined();
  });

  it('keys every top-level and container-level binding value by its qualified name', () => {
    expect(facts.index.constBindings.get('std')?.text).toBe('@import("std")');
    expect(facts.index.constBindings.get('N')?.text).toBe('5');
    expect(facts.index.constBindings.get('Cache.SCHEMA')?.type).toBe('multiline_string');
    // A declaration inside a FUNCTION body is not a file- or container-level binding.
    expect(facts.index.constBindings.has('client')).toBe(false);
  });
});

describe('extractZigFileFacts — imports (BR-9)', () => {
  it('records every @import and @cInclude, and nothing else', () => {
    expect(facts.imports.map((i) => i.spec)).toEqual(['std', 'a.zig', 'b.zig', 'pcre2.h']);
    expect(facts.imports.find((i) => i.spec === 'std')).toMatchObject({
      localName: 'std',
      kind: 'import',
      isPub: false,
    });
  });

  it('binds the WHOLE selector of `@import("x.zig").Foo`, however deep', () => {
    expect(facts.imports.find((i) => i.spec === 'a.zig')).toMatchObject({ localName: 'Foo', members: ['Foo'] });
    expect(facts.imports.find((i) => i.spec === 'b.zig')?.members).toEqual(['Outer', 'Inner']);
    expect(facts.imports.find((i) => i.spec === 'std')?.members).toEqual([]);
  });

  it('turns each @cInclude into an external binding named by the declaring const', () => {
    expect(facts.imports.find((i) => i.spec === 'pcre2.h')).toMatchObject({ kind: 'cinclude', localName: 'c' });
  });

  it('does not treat @embedFile as an import', () => {
    expect(facts.imports.some((i) => i.spec === 'data.bin')).toBe(false);
  });

  it('records a `pub` re-export as pub, and a computed spec not at all', async () => {
    const f = await factsOf('pub const Browser = @import("browser/Browser.zig");\nconst dyn = @import(name);\n');
    expect(f.imports).toHaveLength(1);
    expect(f.imports[0]).toMatchObject({ spec: 'browser/Browser.zig', localName: 'Browser', isPub: true });
  });
});

describe('extractZigFileFacts — call sites (BR-11)', () => {
  const chains = (f: ZigFileFacts): string[] => f.callSites.map((c) => (c.chain ?? []).join('.'));

  it('records every call under an emitted function with its caller and chain', () => {
    expect(chains(facts)).toEqual([
      'self.client.fetch',
      'helper',
      'client.fetch',
      'std.debug.print',
      'exec',
      'exec',
      'helper',
    ]);
    const helperCall = facts.callSites.find(
      (c) => c.chain?.join('.') === 'helper' && c.callerId === idGen.functionId(REL, 'main'),
    );
    expect(helperCall?.callerOwnerQualifiedName).toBeUndefined();
    expect(facts.callSites[0]).toMatchObject({
      callerId: idGen.methodId(REL, 'Cache', 'load'),
      callerOwnerQualifiedName: 'Cache',
    });
  });

  it('records `std.debug.print` — filtering the standard library is the callgraph lane’s job', () => {
    const print = facts.callSites.find((c) => c.chain?.join('.') === 'std.debug.print');
    expect(print?.callerId).toBe(idGen.functionId(REL, 'main'));
    expect(print?.arguments).toEqual(['"hi"', '.{}']);
    expect(print?.location).toMatchObject({ filePath: REL });
  });

  it('records no call for a builtin, and none inside a `test` block', () => {
    expect(chains(facts)).not.toContain('@memcpy');
    // `helper()` and `exec(...)` appear in the `test` block too; only the four in `main` and
    // the one in `load` are recorded.
    expect(facts.callSites).toHaveLength(7);
    expect(facts.callSites.every((c) => c.location.startLine < 39)).toBe(true);
  });

  it('records a call under `try` once, unwrapped, and none at file scope', async () => {
    const f = await factsOf('fn a() !void {\n    try b();\n}\nconst x = b();\n');
    expect(f.callSites).toHaveLength(1);
    expect(f.callSites[0].node.type).toBe('call_expression');
    expect(f.callSites[0].chain).toEqual(['b']);
  });

  it('caps argument text at 200 chars', async () => {
    const f = await factsOf(`fn a() void {\n    b("${'x'.repeat(400)}");\n}\n`);
    expect(f.callSites[0].arguments[0]).toHaveLength(200);
  });
});

describe('extractZigFileFacts — SQL literals (BR-15)', () => {
  it('dedents a `\\\\` multiline DDL and attributes it to no caller at container scope', () => {
    const ddl = facts.sqlStrings.find((s) => s.text.startsWith('create table'));
    expect(ddl?.text).toBe('create table cache (\n  url text\n);');
    expect(ddl?.callerId).toBeUndefined();
    expect(ddl?.asCallArgument).toBe(false);
  });

  it('records a call-argument statement and a `++` concatenation, both under their caller', () => {
    const insert = facts.sqlStrings.find((s) => s.text.startsWith('insert'));
    expect(insert).toMatchObject({ callerId: idGen.functionId(REL, 'main'), asCallArgument: true });
    const concat = facts.sqlStrings.find((s) => s.text.startsWith('select'));
    expect(concat?.text).toBe('select count(*) from cache');
    expect(concat?.asCallArgument).toBe(true);
  });

  it('records nothing for a `++` with a non-literal operand, and nothing inside a `test`', async () => {
    const f = await factsOf('fn a(name: []const u8) void {\n    exec("select " ++ name);\n}\n');
    expect(f.sqlStrings).toEqual([]);
    expect(facts.sqlStrings.some((s) => s.text.includes('select 1 from cache'))).toBe(false);
    expect(facts.sqlStrings).toHaveLength(3);
  });

  it('records the local a `bufPrint` binds its formatted statement to, one hop only', async () => {
    const f = await factsOf(
      'fn a(id: u32) !void {\n' +
        '    var buf: [64]u8 = undefined;\n' +
        '    const sql = try std.fmt.bufPrint(&buf, "delete from t where id = {d}", .{id});\n' +
        '    try self.conn.exec(sql, .{});\n' +
        '}\n',
    );
    expect(f.sqlStrings).toMatchObject([{ calleeMethod: 'bufPrint', boundLocal: 'sql', asCallArgument: true }]);
  });

  it('records no bound local when the formatted statement is not a declaration value', async () => {
    const f = await factsOf(
      'fn a(id: u32) !void {\n    try run(try std.fmt.bufPrint(&buf, "delete from t", .{id}));\n}\n',
    );
    expect(f.sqlStrings.map((s) => s.boundLocal)).toEqual([undefined]);
  });

  it('records nothing for a string that starts with no SQL verb', async () => {
    const f = await factsOf('fn a() void {\n    exec("not a statement about select");\n}\n');
    expect(f.sqlStrings).toEqual([]);
  });
});

describe('extractZigFileFacts — std.http.Client receivers (BR-14)', () => {
  it('records the annotated local under its DECLARING function, and the container property', () => {
    // A local is visible only inside the function that declares it, so that is its key.
    expect(facts.httpClientDecls.get(`${idGen.functionId(REL, 'main')}:client`)).toBe('local');
    expect(facts.httpClientDecls.get('client')).toBeUndefined();
    expect(facts.httpClientDecls.get('Cache.client')).toBe('field');
  });

  it('records an initializer-typed local, and nothing for another type', async () => {
    const f = await factsOf(
      'fn a() void {\n    var c = std.http.Client{ .allocator = x };\n    var d = std.http.Client.init(x);\n    var e = std.http.Server{};\n}\n',
    );
    const caller = f.index.topLevelFunctions.get('a')?.id;
    expect([...f.httpClientDecls.entries()]).toEqual([
      [`${caller}:c`, 'local'],
      [`${caller}:d`, 'local'],
    ]);
  });
});

describe('extractZigFileFacts — constant candidates (BR-16)', () => {
  const byName = (name: string) => facts.constantCandidates.find((c) => c.qualifiedName === name);

  it('collects every non-container, non-import binding with its declaration kind', () => {
    // Container members come first: a container is emitted (and scanned) before the file
    // scope's own bindings are.
    expect(facts.constantCandidates.map((c) => c.qualifiedName)).toEqual([
      'Cache.SCHEMA',
      'blob',
      'Self',
      'VERSION',
      'N',
      'counter',
      'Error',
    ]);
    expect(byName('VERSION')).toMatchObject({ isPub: true, declarationKind: 'const', valueText: '"1.0"' });
    expect(byName('N')).toMatchObject({ isPub: false, declarationKind: 'const', valueText: '5' });
    expect(byName('counter')).toMatchObject({ declarationKind: 'var', typeText: 'u32', valueText: '0' });
    expect(byName('Self')?.valueText).toBe('@This()');
    expect(byName('Error')?.valueNode.type).toBe('error_set_declaration');
  });

  it('collects neither an import binding nor a container declaration', () => {
    expect(byName('std')).toBeUndefined();
    expect(byName('Foo')).toBeUndefined();
    expect(byName('c')).toBeUndefined();
    expect(byName('Cache')).toBeUndefined();
  });

  it('does not classify alias vs variable — that is the post-imports pass', () => {
    // Every candidate is reported the same way; `@This()` and `5` differ only by their value.
    expect(Object.keys(byName('Self') as object).includes('kind')).toBe(false);
  });
});
