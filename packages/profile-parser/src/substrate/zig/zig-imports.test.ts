/**
 * BR-9 / BR-10 (AC-7, AC-8a): the per-file binding table and the `ImportEdge`s it emits.
 *
 * The fixture is driven exactly the way `zig-parser.ts` will drive it — read, `toZigFile`,
 * `extractZigFileFacts`, `parseZigBuild` — because the thing under test is the RESOLUTION, and
 * resolution only behaves correctly when the importing file's own directory is the base.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import type { ImportEdge } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ZigBuildMap, parseZigBuild } from './zig-build.js';
import { resolveZigCalls } from './zig-callgraph.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { type ZigImportIndex, buildZigImportTables, emitZigImports, resolveBinding } from './zig-imports.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-graph');
const REL_PATHS = ['src/main.zig', 'src/hub.zig', 'src/net/Client.zig', 'src/Store.zig', 'src/util.zig'];

/** Mirrors `zig-parser.ts`'s read → parse → walk, without the substrate (it wires no lanes yet). */
async function loadGraphFixture(idGen: StableIdGenerator): Promise<{
  files: ZigFileEntry[];
  trees: ZigFile[];
  build: ZigBuildMap;
  index: ZigImportIndex;
}> {
  const trees: ZigFile[] = [];
  for (const relPath of REL_PATHS) {
    trees.push(await toZigFile(relPath, readFileSync(join(FIXTURE, relPath), 'utf-8')));
  }
  const files = trees.map((tree) => ({ relPath: tree.relPath, facts: extractZigFileFacts(tree, idGen) }));
  const build = await parseZigBuild(FIXTURE);
  const index = buildZigImportTables(files, build, new Set(REL_PATHS));
  return { files, trees, build, index };
}

const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-graph');
let files: ZigFileEntry[];
let trees: ZigFile[];
let index: ZigImportIndex;
let edges: ImportEdge[];

const of = (relPath: string, spec: string): ImportEdge | undefined =>
  edges.find((e) => e.sourceFileId === idGen.fileId(relPath) && e.moduleSpecifier === spec);

beforeAll(async () => {
  const loaded = await loadGraphFixture(idGen);
  files = loaded.files;
  trees = loaded.trees;
  index = loaded.index;
  edges = emitZigImports(files, index, idGen);
});

afterAll(() => releaseParsedTrees(trees));

describe('buildZigImportTables — a function-local `@import` (A4)', () => {
  it('emits its ImportEdge but keeps it out of the FILE binding table', async () => {
    const tree = await toZigFile(
      'src/local.zig',
      'const top = @import("util.zig");\npub fn go() void {\n    const inner = @import("Store.zig");\n    _ = inner;\n}\n',
    );
    const entry = { relPath: 'src/local.zig', facts: extractZigFileFacts(tree, idGen) };
    const scope = new Set([...REL_PATHS, 'src/local.zig']);
    const localIndex = buildZigImportTables([entry], { modules: new Map(), exeByRoot: new Map() }, scope);

    // The dependency on the file IS real, so the edge stands (BR-10)…
    const specs = emitZigImports([entry], localIndex, idGen).map((e) => e.moduleSpecifier);
    expect(specs).toEqual(['util.zig', 'Store.zig']);
    // …but only the file-scope name is a binding every other function can resolve against.
    expect([...(localIndex.byFile.get('src/local.zig')?.keys() ?? [])]).toEqual(['top']);

    releaseParsedTrees([tree]);
  });
});

describe('buildZigImportTables — binding table (BR-9)', () => {
  it('resolves a relative spec against the IMPORTING file, not the repo root', () => {
    // `src/net/Client.zig` + `../Store.zig` → `src/Store.zig`; a root-relative read would miss.
    expect(index.byFile.get('src/net/Client.zig')?.get('Store')).toEqual({
      spec: '../Store.zig',
      targetRelPath: 'src/Store.zig',
      members: [],
      isPub: false,
    });
    expect(index.byFile.get('src/main.zig')?.get('Client')?.targetRelPath).toBe('src/net/Client.zig');
  });

  it('resolves a bare name through the build.zig module map and leaves the rest external', () => {
    expect(index.byFile.get('src/main.zig')?.get('hub')).toEqual({
      spec: 'hub',
      targetRelPath: 'src/hub.zig',
      members: [],
      isPub: false,
    });
    expect(index.byFile.get('src/main.zig')?.get('std')?.targetRelPath).toBeUndefined();
    expect(index.byFile.get('src/util.zig')?.get('c')).toEqual({ spec: 'h.h', members: [], isPub: false });
  });

  it('records the selected member of a member import', () => {
    expect(index.byFile.get('src/main.zig')?.get('Aliased')).toEqual({
      spec: 'util.zig',
      targetRelPath: 'src/util.zig',
      members: ['Outer'],
      isPub: false,
    });
  });

  it('records a DEEP selector whole, not just its head', () => {
    expect(index.byFile.get('src/main.zig')?.get('Inner')?.members).toEqual(['Outer', 'Inner']);
  });
});

describe('resolveBinding — re-export hops (BR-9)', () => {
  it('returns the direct target of a plain namespace binding', () => {
    expect(resolveBinding(index, 'src/main.zig', 'hub')).toEqual({ targetRelPath: 'src/hub.zig', members: [] });
  });

  it('follows a hub file’s own pub re-export to the declaring file', () => {
    expect(resolveBinding(index, 'src/hub.zig', 'Client')).toEqual({
      targetRelPath: 'src/net/Client.zig',
      members: [],
    });
  });

  it('keeps the member when the chain ends in a member import, and drops an external head', () => {
    expect(resolveBinding(index, 'src/main.zig', 'Aliased')).toEqual({
      targetRelPath: 'src/util.zig',
      members: ['Outer'],
    });
    expect(resolveBinding(index, 'src/main.zig', 'Inner')).toEqual({
      targetRelPath: 'src/util.zig',
      members: ['Outer', 'Inner'],
    });
    expect(resolveBinding(index, 'src/main.zig', 'std')).toBeUndefined();
    expect(resolveBinding(index, 'src/main.zig', 'nosuchname')).toBeUndefined();
  });
});

describe('emitZigImports — ImportEdges (AC-7)', () => {
  it('emits one edge per distinct (file, spec), in file then first-seen order', () => {
    expect(edges.map((e) => e.moduleSpecifier)).toEqual([
      'std',
      'hub',
      'util.zig',
      'missing.zig',
      '../outside.zig',
      'net/Client.zig',
      'net/Client.zig',
      'util.zig',
      '../Store.zig',
      'std',
      'std',
      'h.h',
    ]);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });

  it('resolves a relative import to its target file', () => {
    expect(of('src/net/Client.zig', '../Store.zig')).toEqual({
      id: idGen.importEdgeId(idGen.fileId('src/net/Client.zig'), '../Store.zig'),
      sourceFileId: idGen.fileId('src/net/Client.zig'),
      moduleSpecifier: '../Store.zig',
      targetFileId: idGen.fileId('src/Store.zig'),
      isTypeOnly: false,
      importKind: 'namespace',
      importedNames: [{ name: '*', alias: 'Store' }],
    });
  });

  it('leaves @import("std") external — an edge with no targetFileId', () => {
    const std = of('src/main.zig', 'std');
    expect(std?.targetFileId).toBeUndefined();
    expect(std?.importKind).toBe('namespace');
    expect(std?.importedNames).toEqual([{ name: '*', alias: 'std' }]);
  });

  it('resolves a module name through the build.zig map', () => {
    expect(of('src/main.zig', 'hub')?.targetFileId).toBe(idGen.fileId('src/hub.zig'));
  });

  it('merges two bindings of one spec into a named edge carrying a resolvedId', () => {
    const utilFacts = files.find((f) => f.relPath === 'src/util.zig')?.facts;
    const outerId = utilFacts?.decls.classes.find((c) => c.name === 'Outer')?.id;
    const innerId = utilFacts?.decls.classes.find((c) => c.name === 'Outer.Inner')?.id;
    expect(outerId).toBeDefined();
    expect(innerId).toBeDefined();
    expect(of('src/main.zig', 'util.zig')).toEqual({
      id: idGen.importEdgeId(idGen.fileId('src/main.zig'), 'util.zig'),
      sourceFileId: idGen.fileId('src/main.zig'),
      moduleSpecifier: 'util.zig',
      targetFileId: idGen.fileId('src/util.zig'),
      isTypeOnly: false,
      importKind: 'named',
      importedNames: [
        { name: '*', alias: 'util' },
        { name: 'Outer', alias: 'Aliased', resolvedId: outerId },
        // The DOTTED selector, resolved to the NESTED container it really names.
        { name: 'Outer.Inner', alias: 'Inner', resolvedId: innerId },
      ],
    });
  });

  it('emits a @cInclude header as an external edge and @embedFile as nothing', () => {
    expect(of('src/util.zig', 'h.h')).toEqual({
      id: idGen.importEdgeId(idGen.fileId('src/util.zig'), 'h.h'),
      sourceFileId: idGen.fileId('src/util.zig'),
      moduleSpecifier: 'h.h',
      isTypeOnly: false,
      importKind: 'namespace',
      importedNames: [{ name: '*', alias: 'c' }],
    });
    expect(edges.some((e) => e.moduleSpecifier.includes('blob'))).toBe(false);
  });

  it('AC-8a: an escaping or missing import gets an edge with NO fabricated targetFileId', () => {
    expect(of('src/main.zig', '../outside.zig')?.targetFileId).toBeUndefined();
    expect(of('src/main.zig', 'missing.zig')?.targetFileId).toBeUndefined();
  });
});

describe('resolveBinding — a re-export CYCLE (BR-12)', () => {
  it('terminates, and resolves no call through the cycle', async () => {
    // `a.X` re-exports `b.Y`, which re-exports `a.X`. Without the seen set this hops forever;
    // with it the walk stops on the second visit and the call lane simply names nothing.
    const sources: Record<string, string> = {
      'src/a.zig': 'pub const X = @import("b.zig").Y;\npub fn go() void {\n    X.m();\n}\n',
      'src/b.zig': 'pub const Y = @import("a.zig").X;\n',
    };
    const cycleIdGen = new StableIdGenerator('/cycle', 'cycle');
    const cycleTrees: ZigFile[] = [];
    const cycleFiles: ZigFileEntry[] = [];
    for (const [relPath, source] of Object.entries(sources)) {
      const tree = await toZigFile(relPath, source);
      cycleTrees.push(tree);
      cycleFiles.push({ relPath, facts: extractZigFileFacts(tree, cycleIdGen) });
    }
    const empty: ZigBuildMap = { modules: new Map(), exeByRoot: new Map() };
    const cycleIndex = buildZigImportTables(cycleFiles, empty, new Set(Object.keys(sources)));

    try {
      expect(resolveBinding(cycleIndex, 'src/a.zig', 'X')).toEqual({
        targetRelPath: 'src/a.zig',
        members: ['X'],
      });
      // The call site IS recorded; it just resolves to nothing (LIM-B: dropped, not guessed).
      const resolution = resolveZigCalls(cycleFiles, cycleIndex, cycleIdGen);
      expect(resolution.seen).toBe(1);
      expect(resolution.calls).toEqual([]);
    } finally {
      releaseParsedTrees(cycleTrees);
    }
  });
});
