/**
 * BR-11 / BR-12 (AC-6, AC-8b–d): one `it` per resolution tier with the exact edge it produces,
 * then the anti-scenarios — and a total count, because the only way to tell "precision-first"
 * from "quietly emitting unresolved rows" is that `calls.length` equals the resolved set.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import type { CallEdge } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveZigCalls } from './zig-callgraph.js';
import { parseZigBuild } from './zig-build.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { buildZigImportTables, emitZigImports } from './zig-imports.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-graph');
const REL_PATHS = ['src/main.zig', 'src/hub.zig', 'src/net/Client.zig', 'src/Store.zig', 'src/util.zig'];

const MAIN = 'src/main.zig';
const CLIENT = 'src/net/Client.zig';
const UTIL = 'src/util.zig';

const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-graph');
let trees: ZigFile[];
let files: ZigFileEntry[];
let calls: CallEdge[];
let result: ReturnType<typeof resolveZigCalls>;

/** `zig-parser.ts`'s read → parse → walk, run directly: `parseZigRepo` does not wire these lanes yet. */
beforeAll(async () => {
  trees = [];
  for (const relPath of REL_PATHS) {
    trees.push(await toZigFile(relPath, readFileSync(join(FIXTURE, relPath), 'utf-8')));
  }
  files = trees.map((tree) => ({ relPath: tree.relPath, facts: extractZigFileFacts(tree, idGen) }));
  const build = await parseZigBuild(FIXTURE);
  const index = buildZigImportTables(files, build, new Set(REL_PATHS));
  result = resolveZigCalls(files, index, idGen);
  calls = result.calls;
});

afterAll(() => releaseParsedTrees([...trees, ...inlineTrees]));

const inlineTrees: ZigFile[] = [];

/**
 * Wire the lanes over inline sources, the way `zig-parser.ts` does — for the shapes the
 * `mini-zig-graph` fixture deliberately does not carry (shadowed names, a file-struct whose
 * basename is also an import).
 */
async function resolveInline(sources: Record<string, string>): Promise<ReturnType<typeof resolveZigCalls>> {
  const entries: ZigFileEntry[] = [];
  for (const [relPath, source] of Object.entries(sources)) {
    const file = await toZigFile(relPath, source);
    inlineTrees.push(file);
    entries.push({ relPath, facts: extractZigFileFacts(file, idGen) });
  }
  const empty = { modules: new Map<string, string>(), exeByRoot: new Map<string, string>() };
  return resolveZigCalls(entries, buildZigImportTables(entries, empty, new Set(Object.keys(sources))), idGen);
}

const at = (relPath: string, expression: string): CallEdge | undefined =>
  calls.find((c) => c.location.filePath === relPath && c.calleeExpression === expression);

describe('resolveZigCalls — resolution tiers (AC-6)', () => {
  it('zig-local: a bare call inside a container resolves to that container’s method', () => {
    expect(at(CLIENT, 'helper')).toEqual({
      id: idGen.callEdgeId(idGen.methodId(CLIENT, 'Client', 'run'), 'helper', `${CLIENT}:15`),
      callerId: idGen.methodId(CLIENT, 'Client', 'run'),
      calleeId: idGen.methodId(CLIENT, 'Client', 'helper'),
      provenance: 'zig-local',
      calleeExpression: 'helper',
      isMethodCall: false,
      arguments: [],
      location: { filePath: CLIENT, startLine: 15, endLine: 15 },
    });
  });

  it('zig-local: a bare call in a namespace file resolves to a top-level function', () => {
    const edge = at(UTIL, 'f');
    expect(edge?.callerId).toBe(idGen.functionId(UTIL, 'g'));
    expect(edge?.calleeId).toBe(idGen.functionId(UTIL, 'f'));
    expect(edge?.provenance).toBe('zig-local');
    expect(edge?.isMethodCall).toBe(false);
  });

  it('zig-self: `Self.m()` resolves to a method of the enclosing container', () => {
    expect(at(CLIENT, 'Self.helper')).toEqual({
      id: idGen.callEdgeId(idGen.methodId(CLIENT, 'Client', 'run'), 'Self.helper', `${CLIENT}:14`),
      callerId: idGen.methodId(CLIENT, 'Client', 'run'),
      calleeId: idGen.methodId(CLIENT, 'Client', 'helper'),
      provenance: 'zig-self',
      calleeExpression: 'Self.helper',
      isMethodCall: true,
      arguments: [],
      location: { filePath: CLIENT, startLine: 14, endLine: 14 },
    });
  });

  it('zig-type: `T.Inner.m()` resolves to the NESTED container’s method', () => {
    expect(at(UTIL, 'Outer.Inner.m')).toEqual({
      id: idGen.callEdgeId(idGen.functionId(UTIL, 'f'), 'Outer.Inner.m', `${UTIL}:16`),
      callerId: idGen.functionId(UTIL, 'f'),
      calleeId: idGen.methodId(UTIL, 'Outer.Inner', 'm'),
      provenance: 'zig-type',
      calleeExpression: 'Outer.Inner.m',
      isMethodCall: true,
      arguments: [],
      location: { filePath: UTIL, startLine: 16, endLine: 16 },
    });
  });

  it('zig-import: a namespace binding reaches a top-level function of the target file', () => {
    expect(at(MAIN, 'util.g')).toEqual({
      id: idGen.callEdgeId(idGen.functionId(MAIN, 'main'), 'util.g', `${MAIN}:13`),
      callerId: idGen.functionId(MAIN, 'main'),
      calleeId: idGen.functionId(UTIL, 'g'),
      provenance: 'zig-import',
      calleeExpression: 'util.g',
      isMethodCall: true,
      arguments: [],
      location: { filePath: MAIN, startLine: 13, endLine: 13 },
    });
  });

  it('zig-import: a file-struct import reaches the file-struct’s method', () => {
    const edge = at(MAIN, 'Client.init');
    expect(edge?.calleeId).toBe(idGen.methodId(CLIENT, 'Client', 'init'));
    expect(edge?.provenance).toBe('zig-import');
  });

  it('zig-import: two re-export hops through the hub file reach the declaring files', () => {
    expect(at(MAIN, 'hub.Client.init')?.calleeId).toBe(idGen.methodId(CLIENT, 'Client', 'init'));
    expect(at(MAIN, 'hub.Client.init')?.provenance).toBe('zig-import');
    expect(at(MAIN, 'hub.util.f')?.calleeId).toBe(idGen.functionId(UTIL, 'f'));
    expect(at(MAIN, 'hub.util.f')?.provenance).toBe('zig-import');
  });

  it('zig-import: a DEEP selector keeps its whole chain — `Outer.Inner.m`, not `Outer.m`', () => {
    // `const Inner = @import("util.zig").Outer.Inner;` then `Inner.m()`.
    expect(at(MAIN, 'Inner.m')?.calleeId).toBe(idGen.methodId(UTIL, 'Outer.Inner', 'm'));
    expect(at(MAIN, 'Inner.m')?.provenance).toBe('zig-import');
  });

  it('zig-import: the deep selector’s SHORTER prefix is not the callee', () => {
    // `Outer` declares an `m` of its own: a selector truncated to its head lands here.
    expect(at(MAIN, 'Inner.m')?.calleeId).not.toBe(idGen.methodId(UTIL, 'Outer', 'm'));
  });

  it('zig-field: `self.<field>.m()` resolves through the field’s declared type', () => {
    expect(at(CLIENT, 'self.store.put')).toEqual({
      id: idGen.callEdgeId(idGen.methodId(CLIENT, 'Client', 'run'), 'self.store.put', `${CLIENT}:13`),
      callerId: idGen.methodId(CLIENT, 'Client', 'run'),
      calleeId: idGen.methodId('src/Store.zig', 'Store', 'put'),
      provenance: 'zig-field',
      calleeExpression: 'self.store.put',
      isMethodCall: true,
      arguments: [],
      location: { filePath: CLIENT, startLine: 13, endLine: 13 },
    });
  });
});

describe('resolveZigCalls — dropped shapes (AC-8b–d)', () => {
  it('AC-8b: a call inside a `test` block emits nothing', () => {
    expect(calls.some((c) => c.location.filePath === UTIL && c.location.startLine > 26)).toBe(false);
  });

  it('AC-8c: a call on an external binding emits nothing', () => {
    expect(calls.some((c) => c.calleeExpression.startsWith('std.'))).toBe(false);
  });

  it('AC-8d: an unresolvable local receiver emits nothing — no unresolved rows at all', () => {
    expect(at(UTIL, 'p.run')).toBeUndefined();
    expect(calls.every((c) => c.calleeId !== undefined && c.provenance !== undefined)).toBe(true);
    // The whole expected resolved set, per tier: nothing more, nothing less.
    expect(result.byTier).toEqual({ 'zig-local': 2, 'zig-self': 1, 'zig-type': 1, 'zig-import': 5, 'zig-field': 1 });
    expect(calls.length).toBe(10);
    expect(result.resolved).toBe(10);
    expect(result.seen).toBeGreaterThan(10);
    expect(new Set(calls.map((c) => c.id)).size).toBe(10);
  });
});

describe('resolveZigCalls — call-resolution record (BR-1, BR-2)', () => {
  it('counts every seen site, the shipped edges, and the sites naming nothing in this repo', () => {
    // 13 enumerated sites: 10 shipped edges, the two `std.debug.print` sites out of scope, and
    // `p.run` — unbound, but `run` IS declared here (Client.run), so it counts against us.
    expect(result.seen).toBe(13);
    // Every site in this fixture carries a callee name, so the LIM-6 denominator equals `seen`.
    expect(result.callSites).toBe(13);
    expect(result.resolved).toBe(calls.length);
    expect(result.outOfScope).toBe(2);
    expect(result.resolved + result.outOfScope).toBeLessThanOrEqual(result.callSites);
  });

  it('counts a `std.debug.print` site the import-head rule drops, and calls it out of scope', async () => {
    expect(at(UTIL, 'std.debug.print')).toBeUndefined();
    const std = await resolveInline({
      'src/plain.zig':
        'const std = @import("std");\n' + 'pub fn f() void {\n' + '    std.debug.print("hi", .{});\n' + '}\n',
    });
    expect(std.calls).toEqual([]);
    expect(std.seen).toBe(1);
    expect(std.outOfScope).toBe(1);
  });

  it('keeps an unbound site IN scope when its bare name collides with an in-repo declaration', async () => {
    const collision = await resolveInline({
      'src/collide.zig':
        'const std = @import("std");\n' +
        'pub fn print() void {}\n' +
        'pub fn f() void {\n' +
        '    std.debug.print("hi", .{});\n' +
        '}\n',
    });
    expect(collision.calls).toEqual([]);
    expect(collision.seen).toBe(1);
    expect(collision.outOfScope).toBe(0);
  });

  it('keeps a nameless site out of the `callSites` denominator while `seen` still counts it', async () => {
    // `make().run()` has a call in the chain, so no name chain describes it: it can be neither
    // resolved nor classified out of scope (LIM-6), unlike the `g()` site beside it.
    const nameless = await resolveInline({
      'src/nameless.zig':
        'pub fn g() void {}\n' +
        'pub fn make() type {\n' +
        '    return struct {\n' +
        '        pub fn run(_: @This()) void {}\n' +
        '    };\n' +
        '}\n' +
        'pub fn f() void {\n' +
        '    make().run();\n' +
        '    g();\n' +
        '}\n',
    });
    expect(nameless.seen).toBe(3);
    expect(nameless.callSites).toBe(2);
    expect(nameless.resolved + nameless.outOfScope).toBeLessThanOrEqual(nameless.callSites);
  });
});

/**
 * A1/A2/A4/A6: a chain head the CALLER binds is that local. Every case is a pair — the same
 * expression resolving where nothing shadows it, and dropped where something does.
 */
describe('resolveZigCalls — lexical scope', () => {
  it('drops a bare call whose name is a parameter, and keeps the unshadowed twin', async () => {
    const result = await resolveInline({
      'src/scope.zig':
        'pub fn f() void {}\n' +
        'pub fn free() void {\n' +
        '    f();\n' +
        '}\n' +
        'pub fn shadowedByParam(f: *const fn () void) void {\n' +
        '    f();\n' +
        '}\n' +
        'pub fn shadowedByLocal() void {\n' +
        '    const f = makeFn();\n' +
        '    f();\n' +
        '}\n',
    });

    const callers = result.calls.filter((c) => c.calleeExpression === 'f').map((c) => c.callerId);
    expect(callers).toEqual([idGen.functionId('src/scope.zig', 'free')]);
    expect(callers).not.toContain(idGen.functionId('src/scope.zig', 'shadowedByParam'));
    expect(callers).not.toContain(idGen.functionId('src/scope.zig', 'shadowedByLocal'));
  });

  it('keeps a function-local `@import` out of the file table (A4)', async () => {
    const result = await resolveInline({
      'src/a.zig': 'pub fn g() void {}\n',
      'src/b.zig': 'pub fn g() void {}\n',
      'src/main.zig':
        'const util = @import("a.zig");\n' +
        'pub fn viaFile() void {\n' +
        '    util.g();\n' +
        '}\n' +
        'pub fn viaLocal() void {\n' +
        '    const util = @import("b.zig");\n' +
        '    util.g();\n' +
        '}\n',
    });

    const byCaller = new Map(result.calls.map((c) => [c.callerId, c.calleeId]));
    expect(byCaller.get(idGen.functionId('src/main.zig', 'viaFile'))).toBe(idGen.functionId('src/a.zig', 'g'));
    // The local binding is not in the file table, and it shadows the one that is — so the call
    // resolves to NOTHING rather than to `a.zig`'s `g`.
    expect(byCaller.has(idGen.functionId('src/main.zig', 'viaLocal'))).toBe(false);
  });

  it('lets an `@import` win over the file-struct of the same basename (RT2)', async () => {
    const result = await resolveInline({
      'src/net/Client.zig': 'host: []const u8,\n\npub fn connect(self: *Client) void {\n    _ = self;\n}\n',
      'src/Client.zig':
        'id: u32,\n\n' +
        'const Client = @import("net/Client.zig");\n\n' +
        'pub fn connect(self: *Client) void {\n    _ = self;\n}\n\n' +
        'pub fn go() void {\n    Client.connect();\n}\n',
    });

    const edge = result.calls.find((c) => c.calleeExpression === 'Client.connect');
    expect(edge?.calleeId).toBe(idGen.methodId('src/net/Client.zig', 'Client', 'connect'));
    expect(edge?.provenance).toBe('zig-import');
    // The twin: the file's OWN same-named method is not the callee.
    expect(edge?.calleeId).not.toBe(idGen.methodId('src/Client.zig', 'Client', 'connect'));
  });

  it('keeps the file-struct reachable through `Self` when no import shadows the basename', async () => {
    const result = await resolveInline({
      'src/Only.zig':
        'id: u32,\n\n' +
        'const Self = @This();\n\n' +
        'pub fn connect() void {}\n\n' +
        'pub fn go() void {\n    Only.connect();\n    Self.connect();\n}\n',
    });

    const target = idGen.methodId('src/Only.zig', 'Only', 'connect');
    expect(result.calls.find((c) => c.calleeExpression === 'Only.connect')?.calleeId).toBe(target);
    expect(result.calls.find((c) => c.calleeExpression === 'Self.connect')?.calleeId).toBe(target);
  });

  it('requires `self` to BE the first parameter name, not merely a receiver-typed one', async () => {
    const result = await resolveInline({
      'src/recv.zig':
        'pub const Box = struct {\n' +
        '    pub fn m(self: *Box) void {\n        self.helper();\n    }\n' +
        '    pub fn n(this: *Box, self: *Box) void {\n        _ = this;\n        self.helper();\n    }\n' +
        '    pub fn helper(self: *Box) void {\n        _ = self;\n    }\n' +
        '};\n',
    });

    const callers = result.calls.filter((c) => c.calleeExpression === 'self.helper').map((c) => c.callerId);
    expect(callers).toEqual([idGen.methodId('src/recv.zig', 'Box', 'm')]);
  });

  it('refuses a `build.zig` module named `std` as an in-repo target (RT1)', async () => {
    const entries: ZigFileEntry[] = [];
    for (const [relPath, source] of Object.entries({
      'src/std_shim.zig': 'pub const mem = struct {\n    pub fn eql() void {}\n};\n',
      'src/uses.zig': 'const std = @import("std");\npub fn go() void {\n    std.mem.eql();\n}\n',
    })) {
      const file = await toZigFile(relPath, source);
      inlineTrees.push(file);
      entries.push({ relPath, facts: extractZigFileFacts(file, idGen) });
    }
    // A build map that DID bind the reserved name — `resolveSpec` must ignore it on its own.
    const build = { modules: new Map([['std', 'src/std_shim.zig']]), exeByRoot: new Map<string, string>() };
    const index = buildZigImportTables(entries, build, new Set(entries.map((e) => e.relPath)));

    const edge = emitZigImports(entries, index, idGen).find((i) => i.moduleSpecifier === 'std');
    expect(edge?.targetFileId).toBeUndefined();
    expect(resolveZigCalls(entries, index, idGen).calls).toEqual([]);
  });
});
