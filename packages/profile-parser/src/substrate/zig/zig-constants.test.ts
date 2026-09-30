/**
 * BR-16: the const/var → typeAlias | variable split, driven straight through
 * `classifyZigConstants` so each rule is asserted on the shape that exercises it.
 *
 * The cases that matter are the ones a keyword-based split gets wrong: a `const` that names a
 * type declared in ANOTHER file is an alias, an `@import` binding is neither (its `ImportEdge`
 * already says it), and a chain that resolves to nothing is a plain value — never a fabricated
 * alias to a type nobody emitted.
 */
import { StableIdGenerator } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZigBuildMap } from './zig-build.js';
import { type ZigConstants, classifyZigConstants } from './zig-constants.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { buildZigImportTables } from './zig-imports.js';

const SOURCES: Record<string, string> = {
  'src/a.zig': [
    'const b = @import("b.zig");',
    '/// The alias.',
    'pub const T = b.Foo;',
    // A namespace binding: an ImportEdge, never a constant.
    'const ns = @import("b.zig");',
    // Nothing named `nope` is bound here, so the chain resolves to no emitted type.
    'const Q = nope.Thing;',
    '',
  ].join('\n'),
  'src/b.zig': 'pub const Foo = struct {\n    x: u32,\n};\n',
  // Two declarations of one qualified name mint one id: first wins (BR-4).
  'src/dup.zig': 'pub const VERSION = "1";\npub const VERSION = "2";\n',
};

const idGen = new StableIdGenerator('/consts', 'consts');
const trees: ZigFile[] = [];
let out: ZigConstants;

beforeAll(async () => {
  const files: ZigFileEntry[] = [];
  for (const [relPath, source] of Object.entries(SOURCES)) {
    const tree = await toZigFile(relPath, source);
    trees.push(tree);
    files.push({ relPath, facts: extractZigFileFacts(tree, idGen) });
  }
  const empty: ZigBuildMap = { modules: new Map(), exeByRoot: new Map() };
  const index = buildZigImportTables(files, empty, new Set(Object.keys(SOURCES)));
  out = classifyZigConstants(files, index, idGen);
});

afterAll(() => releaseParsedTrees(trees));

describe('classifyZigConstants', () => {
  it('makes a cross-file alias a typeAlias, carrying the value text as written', () => {
    expect(out.typeAliases.map((t) => t.name)).toEqual(['T']);
    expect(out.typeAliases[0]).toMatchObject({
      kind: 'type-alias',
      aliasedType: { text: 'b.Foo' },
      isExported: true,
      documentation: 'The alias.',
      id: idGen.typeAliasId('src/a.zig', 'T'),
    });
  });

  it('emits NEITHER node for a namespace import binding', () => {
    for (const node of [...out.variables, ...out.typeAliases]) expect(node.name).not.toBe('ns');
  });

  it('makes an unresolved chain a plain variable, not an alias to a type nobody emitted', () => {
    const q = out.variables.find((v) => v.name === 'Q');
    expect(q).toMatchObject({ kind: 'variable', declarationKind: 'const', initialValue: 'nope.Thing' });
  });

  it('keeps the FIRST declaration when one file declares a qualified name twice', () => {
    const versions = out.variables.filter((v) => v.name === 'VERSION');
    expect(versions).toHaveLength(1);
    expect(versions[0].initialValue).toBe('"1"');
  });
});
