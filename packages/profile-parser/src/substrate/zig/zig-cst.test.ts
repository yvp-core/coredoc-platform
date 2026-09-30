/**
 * CST-helper tests for the Zig substrate. Every assertion here is a claim about the
 * BUNDLED tree-sitter-zig grammar (tree-sitter-wasms 0.1.13), which is the surface that
 * silently returns `undefined` forever when a field name is wrong.
 */
import { releaseParsedTree } from '../../tree-sitter/tree-release.js';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_DECLS,
  type TsNode,
  builtinName,
  builtinStringArg,
  callArguments,
  calleeOf,
  containerOf,
  declValue,
  enclosingFunctionDecl,
  enumLiteralName,
  initializerEntries,
  memberChain,
  sqlText,
  unwrapTry,
  declName,
  docComment,
  fieldFacts,
  fnName,
  hasModifier,
  isTypeConstructor,
  namedChildrenOfType,
  parameterFacts,
  parseZig,
  referencesSelf,
  returnTypeText,
  returnedContainer,
} from './zig-cst.js';

const SOURCE = `const std = @import("std");

/// First doc line.
/// Second doc line.
pub fn build(alloc: std.mem.Allocator) Thing {
    return .{ .a = alloc };
}

fn hidden(self: *Self, n: u32) void {
    _ = self;
    _ = n;
}

pub const Thing = struct {
    a: u32 = 7,
    b: []const u8,
};

const Level = enum(u8) { low = 1, high };
const Choice = union(enum) { one: u32 };
const Failure = error{ Timeout };

pub fn List(comptime T: type) type {
    return struct { items: []T };
}

fn make() type {
    return std.ArrayList(u8);
}
`;

async function root(): Promise<TsNode> {
  return await parseZig(SOURCE);
}

function varDecl(node: TsNode, name: string): TsNode {
  const found = (node.descendantsOfType('variable_declaration') as TsNode[]).find((n) => declName(n) === name);
  if (!found) throw new Error(`no variable_declaration named ${name}`);
  return found;
}

function fnDecl(node: TsNode, name: string): TsNode {
  const found = (node.descendantsOfType('function_declaration') as TsNode[]).find((n) => fnName(n) === name);
  if (!found) throw new Error(`no function_declaration named ${name}`);
  return found;
}

describe('zig-cst', () => {
  it('reads the declared name of a variable_declaration (no `name` field on that node)', async () => {
    const r = await root();
    expect(declName(varDecl(r, 'Thing'))).toBe('Thing');
    expect(declName(varDecl(r, 'std'))).toBe('std');
  });

  it('returns the container value child only for container declarations', async () => {
    const r = await root();
    expect(containerOf(varDecl(r, 'Thing'))?.type).toBe('struct_declaration');
    expect(containerOf(varDecl(r, 'Level'))?.type).toBe('enum_declaration');
    expect(containerOf(varDecl(r, 'Choice'))?.type).toBe('union_declaration');
    // An error set and a plain import are NOT containers we emit.
    expect(containerOf(varDecl(r, 'Failure'))).toBeUndefined();
    expect(containerOf(varDecl(r, 'std'))).toBeUndefined();
    expect(CONTAINER_DECLS.has('error_set_declaration')).toBe(false);
  });

  it('reads function names, modifiers and return types', async () => {
    const r = await root();
    expect(fnName(fnDecl(r, 'build'))).toBe('build');
    expect(hasModifier(fnDecl(r, 'build'), 'pub')).toBe(true);
    expect(hasModifier(fnDecl(r, 'hidden'), 'pub')).toBe(false);
    expect(returnTypeText(fnDecl(r, 'build'))).toBe('Thing');
    expect(returnTypeText(fnDecl(r, 'hidden'))).toBe('void');
  });

  it('collects contiguous /// comments preceding a declaration', async () => {
    const r = await root();
    expect(docComment(fnDecl(r, 'build'))).toBe('First doc line.\nSecond doc line.');
    expect(docComment(fnDecl(r, 'hidden'))).toBeUndefined();
  });

  it('reads parameter names and type text', async () => {
    const r = await root();
    expect(parameterFacts(fnDecl(r, 'hidden'))).toEqual([
      { name: 'self', typeText: '*Self' },
      { name: 'n', typeText: 'u32' },
    ]);
  });

  it('reads container field name, type text and default value', async () => {
    const r = await root();
    const thing = containerOf(varDecl(r, 'Thing')) as TsNode;
    const fields = namedChildrenOfType(thing, 'container_field').map(fieldFacts);
    expect(fields).toEqual([
      { kind: 'named', name: 'a', typeText: 'u32', defaultValue: '7' },
      { kind: 'named', name: 'b', typeText: '[]const u8', defaultValue: undefined },
    ]);
    const level = containerOf(varDecl(r, 'Level')) as TsNode;
    expect(namedChildrenOfType(level, 'container_field').map(fieldFacts)).toEqual([
      { kind: 'named', name: 'low', typeText: undefined, defaultValue: '1' },
      { kind: 'named', name: 'high', typeText: undefined, defaultValue: undefined },
    ]);
  });

  it('reports the phantom field of an empty container as no field at all', async () => {
    // `struct {}` / `enum {}` parse with ONE zero-width `container_field` whose `name` is an
    // empty `identifier`; trusting it emitted a property named '' (and a colliding id).
    const r = await parseZig('const Empty = struct {};\nconst Nothing = enum {};\n');
    const empty = containerOf(varDecl(r, 'Empty')) as TsNode;
    const nothing = containerOf(varDecl(r, 'Nothing')) as TsNode;
    expect(namedChildrenOfType(empty, 'container_field')).toHaveLength(1);
    expect(namedChildrenOfType(empty, 'container_field').map(fieldFacts)).toEqual([undefined]);
    expect(namedChildrenOfType(nothing, 'container_field').map(fieldFacts)).toEqual([undefined]);
  });

  it('tells an identifier-typed tuple element from a typeless union member by the container', async () => {
    // Both shapes are `[name=identifier]` with no `type` field; only the parent container
    // distinguishes them, since a struct field is never typeless in Zig.
    const r = await parseZig('const T = struct { Foo, Foo };\nconst U = union(enum) { a, b: u32 };\n');
    const t = containerOf(varDecl(r, 'T')) as TsNode;
    expect(namedChildrenOfType(t, 'container_field').map(fieldFacts)).toEqual([
      { kind: 'positional', typeText: 'Foo', defaultValue: undefined },
      { kind: 'positional', typeText: 'Foo', defaultValue: undefined },
    ]);
    const u = containerOf(varDecl(r, 'U')) as TsNode;
    expect(namedChildrenOfType(u, 'container_field').map(fieldFacts)).toEqual([
      { kind: 'named', name: 'a', typeText: undefined, defaultValue: undefined },
      { kind: 'named', name: 'b', typeText: 'u32', defaultValue: undefined },
    ]);
  });

  it('reports a tuple field as positional, carrying the type the grammar labelled `name`', async () => {
    const r = await parseZig('const Pair = struct { []const u8, u32 };\n');
    const pair = containerOf(varDecl(r, 'Pair')) as TsNode;
    expect(namedChildrenOfType(pair, 'container_field').map(fieldFacts)).toEqual([
      { kind: 'positional', typeText: '[]const u8', defaultValue: undefined },
      { kind: 'positional', typeText: 'u32', defaultValue: undefined },
    ]);
  });

  it('identifies a generic type constructor and the container it returns', async () => {
    const r = await root();
    expect(isTypeConstructor(fnDecl(r, 'List'))).toBe(true);
    expect(returnedContainer(fnDecl(r, 'List'))?.type).toBe('struct_declaration');
    // `type`-returning, but its body does not directly return a container declaration.
    expect(isTypeConstructor(fnDecl(r, 'make'))).toBe(true);
    expect(returnedContainer(fnDecl(r, 'make'))).toBeUndefined();
    expect(isTypeConstructor(fnDecl(r, 'build'))).toBe(false);
  });

  it('recognises a receiver parameter type by Self, @This() or the container name', () => {
    expect(referencesSelf('*Self', 'Thing')).toBe(true);
    expect(referencesSelf('Self', 'Thing')).toBe(true);
    expect(referencesSelf('*@This()', 'Thing')).toBe(true);
    expect(referencesSelf('Thing', 'Thing')).toBe(true);
    expect(referencesSelf('*const Thing', 'Thing')).toBe(true);
    expect(referencesSelf('u32', 'Thing')).toBe(false);
    expect(referencesSelf(undefined, 'Thing')).toBe(false);
  });
});

/**
 * Expression accessors (slice 2). Same contract as above: every `expect` is a claim about the
 * bundled grammar, and the shapes that silently return `undefined` when a field name is wrong
 * (`call_expression.function`, `field_expression.member`, `binary_expression.operator`) are the
 * reason each accessor gets its own `it`.
 */
const EXPR_SOURCE = `const std = @import("std");
const Foo = @import("a.zig").Foo;
const Self = @This();
const N = 5;
var counter: u32 = 0;
var client: std.http.Client = .{};
var pending: u32 = undefined;

pub fn run(self: *Self) !void {
    foo(1, "two");
    const r = try self.a.b();
    _ = r;
    client.fetch(.{ .location = .{ .url = "https://x/y" }, .method = .GET });
    _ = @This().m();
    @memcpy(a, b);
    const ddl =
        \\\\create table cache (
        \\\\  url text
        \\\\);
    ;
    _ = ddl;
    _ = "select " ++ "count(*)";
    _ = "select " ++ name;
}

test "in a test block" {
    foo();
}
`;

async function exprRoot(): Promise<TsNode> {
  return await parseZig(EXPR_SOURCE);
}

/** The n-th `call_expression` in source order (`try`/`@…` wrappers included). */
function calls(node: TsNode): TsNode[] {
  return node.descendantsOfType('call_expression') as TsNode[];
}

function callNamed(node: TsNode, text: string): TsNode {
  const found = calls(node).find((c) => (c.text as string).startsWith(text));
  if (!found) throw new Error(`no call starting with ${text}`);
  return found;
}

describe('zig-cst — expression accessors', () => {
  it('reads the callee through the `function` field', async () => {
    const r = await exprRoot();
    expect(calleeOf(callNamed(r, 'foo(1')).type).toBe('identifier');
    expect(calleeOf(callNamed(r, 'self.a.b')).text).toBe('self.a.b');
  });

  it('reads individual arguments through the argument-list wrapper', async () => {
    const r = await exprRoot();
    expect(callArguments(callNamed(r, 'foo(1')).map((a: TsNode) => a.text)).toEqual(['1', '"two"']);
    expect(callArguments(callNamed(r, 'self.a.b'))).toEqual([]);
  });

  it('unwraps `try` and leaves any other node alone', async () => {
    const r = await exprRoot();
    const tryNode = (r.descendantsOfType('try_expression') as TsNode[])[0];
    expect(unwrapTry(tryNode).type).toBe('call_expression');
    expect(unwrapTry(tryNode).text).toBe('self.a.b()');
    const bare = callNamed(r, 'foo(1');
    expect(unwrapTry(bare)).toBe(bare);
  });

  it('builds a member chain, and refuses one it cannot name', async () => {
    const r = await exprRoot();
    expect(memberChain(calleeOf(callNamed(r, 'self.a.b')))).toEqual(['self', 'a', 'b']);
    expect(memberChain(calleeOf(callNamed(r, 'foo(1')))).toEqual(['foo']);
    expect(memberChain(calleeOf(callNamed(r, '@This().m')))).toEqual(['@This()', 'm']);
    // An enum literal and an import head are not name chains.
    const enumLit = (r.descendantsOfType('field_expression') as TsNode[]).find((n) => n.text === '.GET');
    expect(memberChain(enumLit)).toBeUndefined();
    expect(memberChain(varDecl(r, 'Foo').namedChild(1))).toBeUndefined();
  });

  it('reads a builtin name and its single string argument', async () => {
    const r = await exprRoot();
    const importNode = varDecl(r, 'std').namedChild(1);
    expect(builtinName(importNode)).toBe('@import');
    expect(builtinStringArg(importNode)).toBe('std');
    expect(builtinName(varDecl(r, 'Self').namedChild(1))).toBe('@This');
    expect(builtinStringArg(varDecl(r, 'Self').namedChild(1))).toBeUndefined();
  });

  it('reads an enum literal name, and nothing from a member access', async () => {
    const r = await exprRoot();
    const enumLit = (r.descendantsOfType('field_expression') as TsNode[]).find((n) => n.text === '.GET');
    expect(enumLiteralName(enumLit)).toBe('GET');
    expect(enumLiteralName(calleeOf(callNamed(r, 'self.a.b')))).toBeUndefined();
  });

  it('reads one level of `.{ .key = value }` entries', async () => {
    const r = await exprRoot();
    const init = callArguments(callNamed(r, 'client.fetch'))[0];
    const entries = initializerEntries(init);
    expect([...entries.keys()]).toEqual(['location', 'method']);
    expect(entries.get('method')?.text).toBe('.GET');
    const nested = initializerEntries(entries.get('location') as TsNode);
    expect(nested.get('url')?.text).toBe('"https://x/y"');
  });

  it('reads SQL text from a string, a dedented multiline and a `++` of both', async () => {
    const r = await exprRoot();
    const multiline = (r.descendantsOfType('multiline_string') as TsNode[])[0];
    expect(sqlText(multiline)).toBe('create table cache (\n  url text\n);');
    const concats = r.descendantsOfType('binary_expression') as TsNode[];
    expect(sqlText(concats[0])).toBe('select count(*)');
    // One non-literal operand makes the whole expression unreadable, not partially read.
    expect(sqlText(concats[1])).toBeUndefined();
    expect(sqlText(calleeOf(callNamed(r, 'foo(1')))).toBeUndefined();
  });

  it('finds the nearest enclosing function declaration', async () => {
    const r = await exprRoot();
    expect(fnName(enclosingFunctionDecl(callNamed(r, 'foo(1')) as TsNode)).toBe('run');
    expect(enclosingFunctionDecl(varDecl(r, 'std'))).toBeUndefined();
  });

  it('reads a declaration value, and none when there is only an annotation', async () => {
    const r = await exprRoot();
    expect(declValue(varDecl(r, 'N'))?.text).toBe('5');
    expect(declValue(varDecl(r, 'counter'))?.text).toBe('0');
    expect(declValue(varDecl(r, 'client'))?.text).toBe('.{}');
    // `undefined` is an ANONYMOUS token: the declaration binds no value node.
    expect(declValue(varDecl(r, 'pending'))).toBeUndefined();
  });
});

describe('MAX_CST_DEPTH — recursion cap (DoS)', () => {
  it('folds a 6000-operand `++` chain without throwing, and reads nothing from it', async () => {
    // Node depth is attacker-controlled: one `binary_expression` per operand. Uncapped, this
    // overflows the stack and takes the whole parse down.
    const chain = Array(6000).fill('"a"').join(' ++ ');
    const root = await parseZig(`const sql = ${chain};\n`);
    const concat = (root.descendantsOfType('binary_expression') as TsNode[])[0];

    expect(() => sqlText(concat)).not.toThrow();
    expect(sqlText(concat)).toBeUndefined();
    releaseParsedTree(root);
  });
});
