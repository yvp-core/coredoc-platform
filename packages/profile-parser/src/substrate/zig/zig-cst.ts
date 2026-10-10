/**
 * Shared tree-sitter-zig CST helpers. Generic Zig — no framework or repo-specific
 * assumptions; the declaration walk builds on these primitives.
 *
 * Node vocabulary, probed from @cursorless/tree-sitter-wasms 0.10.0. These are
 * exactly the facts that fail silently when guessed:
 *   - A named type is a `variable_declaration` whose value child is a container declaration
 *     (`struct_declaration` / `enum_declaration` / `union_declaration` / `opaque_declaration`).
 *     The declaration carries NO `name` field: the declared name is its first named
 *     `identifier` child (a typed declaration exposes its annotation under `type`).
 *   - `function_declaration` has `name`, `parameters`, `type` (the RETURN type) and `body`
 *     (absent for `extern fn`). `pub` / `extern` / `export` / `inline` are ANONYMOUS children.
 *   - `container_field` has `name` and (except for enum members) `type`; a default value
 *     follows an anonymous `=` child. Its `name` is NOT always a declared name: an empty
 *     container yields a phantom field and a tuple struct labels its TYPE as `name` — see
 *     `fieldFacts`, which is the only place allowed to read that field.
 *   - `error_set_declaration` is deliberately NOT a container here: an error set is neither a
 *     class nor an enum in this vertical (BR-2).
 *   - `///` doc comments are `comment` siblings preceding the declaration.
 */
import { type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { makeEnclosingWalker, namedChildrenOfType } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

export const SOURCE_FILE = 'source_file';
export const VARIABLE_DECL = 'variable_declaration';
export const FUNCTION_DECL = 'function_declaration';
export const CONTAINER_FIELD = 'container_field';
export const COMMENT = 'comment';
export const BLOCK = 'block';
export const RETURN_EXPRESSION = 'return_expression';

/** Container declarations that become a graph node (BR-2). `error_set_declaration` is not one. */
export const CONTAINER_DECLS: ReadonlySet<string> = new Set([
  'struct_declaration',
  'enum_declaration',
  'union_declaration',
  'opaque_declaration',
]);

export { namedChildrenOfType };

/** Whether `node` carries the anonymous keyword child `keyword` (`pub`, `extern`, `export`). */
export function hasModifier(node: TsNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === keyword) return true;
  }
  return false;
}

/** The declared name of a `variable_declaration` — its first named `identifier` child. */
export function declName(node: TsNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'identifier') return child.text as string;
  }
  return undefined;
}

/** The container declaration a `variable_declaration` binds, when it binds one. */
export function containerOf(node: TsNode): TsNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && CONTAINER_DECLS.has(child.type)) return child;
  }
  return undefined;
}

/** The `name` field of a `function_declaration`. */
export function fnName(node: TsNode): string | undefined {
  return node.childForFieldName?.('name')?.text as string | undefined;
}

/** The declared RETURN type text of a `function_declaration` (the `type` field). */
export function returnTypeText(node: TsNode): string | undefined {
  return node.childForFieldName?.('type')?.text as string | undefined;
}

/** Contiguous `///` comment lines immediately preceding a declaration, joined by newline. */
export function docComment(node: TsNode): string | undefined {
  const lines: string[] = [];
  let prev: TsNode | null = node.previousNamedSibling;
  while (prev && prev.type === COMMENT) {
    const text = prev.text as string;
    if (!text.startsWith('///')) break;
    lines.unshift(text.slice(3).trim());
    prev = prev.previousNamedSibling;
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** A field the grammar names: `a: u32 = 7`, or a bare enum member (`typeText` absent). */
export interface NamedFieldFacts {
  kind: 'named';
  name: string;
  /** Declared type text; absent for a bare enum member. */
  typeText?: string;
  /** Literal following `=`, as written. */
  defaultValue?: string;
}

/** A tuple-struct field: it has a type but NO name of its own — only its ordinal position. */
export interface PositionalFieldFacts {
  kind: 'positional';
  typeText: string;
  defaultValue?: string;
}

export type FieldFacts = NamedFieldFacts | PositionalFieldFacts;

/**
 * Name, type text and default of one `container_field`; `undefined` when the field is a
 * grammar artefact rather than a declared field. Two probed facts about the bundled grammar,
 * both of which produced a wrong node when the `name` field was trusted as written:
 *   - An EMPTY container (`struct {}`, `enum {}`) still parses to ONE `container_field`, whose
 *     only child is a zero-width `identifier` (empty text; `isMissing` reads FALSE on it in
 *     this web-tree-sitter build, so emptiness — not that flag — is the reliable signal).
 *     It denotes no field: `undefined`.
 *   - A TUPLE struct (`struct { []const u8, u32 }`) labels the TYPE node as the `name` field
 *     and exposes no `type` field. The name node is then not an `identifier` (`slice_type`,
 *     `builtin_type`, …), which is how a positional field is told apart from a named one.
 *   - When a tuple element's type IS an identifier (`struct { Foo, Bar }`) that shape is
 *     indistinguishable from a bare enum/union member — same `[name=identifier]`, no `type` —
 *     so the CONTAINER decides: a STRUCT field can never be typeless in Zig, while a `union`
 *     member legitimately can (`union(enum) { a, b: u32 }`). Hence a typeless identifier field
 *     is positional only under `struct_declaration` (or `source_file`, the implicit file-struct).
 */
export function fieldFacts(node: TsNode): FieldFacts | undefined {
  const nameNode = node.childForFieldName?.('name');
  const name = nameNode?.text as string | undefined;
  if (!nameNode || !name) return undefined;
  const typeText = node.childForFieldName?.('type')?.text as string | undefined;
  let defaultValue: string | undefined;
  let seenEquals = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === '=') {
      seenEquals = true;
      continue;
    }
    if (seenEquals && child.isNamed) {
      defaultValue = child.text as string;
      break;
    }
  }
  const inStruct = node.parent?.type === 'struct_declaration' || node.parent?.type === SOURCE_FILE;
  if (nameNode.type !== 'identifier' || (typeText === undefined && inStruct)) {
    return { kind: 'positional', typeText: name, defaultValue };
  }
  return { kind: 'named', name, typeText, defaultValue };
}

export interface ZigParameterFacts {
  name: string;
  typeText?: string;
}

/** Parameters of a `function_declaration`, in source order. */
export function parameterFacts(node: TsNode): ZigParameterFacts[] {
  // `parameters` is a plain named child, NOT a field (probed): `childForFieldName('parameters')`
  // returns null on this grammar build and would silently drop every parameter.
  const params = namedChildrenOfType(node, 'parameters')[0];
  if (!params) return [];
  return namedChildrenOfType(params, 'parameter').map((p) => ({
    name: (p.childForFieldName?.('name')?.text as string | undefined) ?? '',
    typeText: p.childForFieldName?.('type')?.text as string | undefined,
  }));
}

/** A function whose declared return type is the literal `type` — a candidate type constructor. */
export function isTypeConstructor(node: TsNode): boolean {
  return returnTypeText(node) === 'type';
}

/**
 * The container a type constructor DIRECTLY returns (`fn F(...) type { return struct {…}; }`).
 * Undefined when the body returns anything else (a call, a comptime branch): that type is not
 * knowable without evaluation, and inventing one would be a fabricated node (BR-5).
 */
export function returnedContainer(node: TsNode): TsNode | undefined {
  const body = node.childForFieldName?.('body');
  if (!body || body.type !== BLOCK) return undefined;
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt) continue;
    const ret = stmt.type === RETURN_EXPRESSION ? stmt : namedChildrenOfType(stmt, RETURN_EXPRESSION)[0];
    if (!ret) continue;
    for (let j = 0; j < ret.namedChildCount; j++) {
      const value = ret.namedChild(j);
      if (value && CONTAINER_DECLS.has(value.type)) return value;
    }
  }
  return undefined;
}

/**
 * Whether a parameter type text denotes the enclosing container — the Zig receiver idiom
 * (`self: Self`, `self: *@This()`, `self: *const Config`). Used for `isStatic` (BR-6).
 */
export function referencesSelf(typeText: string | undefined, containerSimpleName: string): boolean {
  if (!typeText) return false;
  const bare = bareTypeText(typeText);
  return bare === 'Self' || bare === '@This()' || (containerSimpleName.length > 0 && bare === containerSimpleName);
}

/**
 * A type annotation stripped to the bare name chain it denotes: `*const []Store` → `Store`.
 * ONE spelling of this rule for every lane that has to compare a written type to a declared
 * name (`referencesSelf`, the call graph's field tier, the `std.http.Client` gate).
 */
export function bareTypeText(text: string): string {
  return text
    .replace(/[*?]/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/\s+/g, '');
}

/** 1-based source range of a node, for a `SourceLocation`. */
export function locationOf(node: TsNode, filePath: string): { filePath: string; startLine: number; endLine: number } {
  return {
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Expression vocabulary (slice 2: imports, calls, egress, SQL).
 *
 * Probed from the same bundled grammar (dump-grammar.ts, 2026-09-14). The facts that fail
 * silently when guessed:
 *   - `call_expression` has `function` and `arguments` fields; its argument expressions are
 *     the named children of `arguments`. Builtins also own an `arguments` node.
 *   - `field_expression` has `object` + `member`. An ENUM LITERAL (`.GET`, `.location`) is a
 *     `field_expression` with a `member` but NO `object` — the same node type as member access.
 *   - `@memcpy(a, b)` is a `builtin_function`, never a `call_expression`; builtins are therefore
 *     absent from a `call_expression` sweep by construction, not by filtering.
 *   - `string` exposes `string_content`; `multiline_string` is a LEAF whose text keeps every
 *     `\\` prefix and newline. Concatenation is `binary_expression` with `operator` `++`.
 *   - `var x: u32 = undefined` has NO value child (`undefined` is anonymous), so the value of a
 *     `variable_declaration` is its last named child ONLY when that child is not the annotation.
 * ---------------------------------------------------------------------------
 */

export const CALL_EXPRESSION = 'call_expression';
export const FIELD_EXPRESSION = 'field_expression';
export const BUILTIN_FUNCTION = 'builtin_function';
export const BUILTIN_IDENTIFIER = 'builtin_identifier';
export const ARGUMENTS = 'arguments';
export const TRY_EXPRESSION = 'try_expression';
export const TEST_DECL = 'test_declaration';
export const STRING = 'string';
export const STRING_CONTENT = 'string_content';
export const MULTILINE_STRING = 'multiline_string';
export const BINARY_EXPRESSION = 'binary_expression';
export const ANON_STRUCT_INIT = 'anonymous_struct_initializer';
export const INITIALIZER_LIST = 'initializer_list';
export const ASSIGNMENT_EXPRESSION = 'assignment_expression';
export const ERROR_SET_DECL = 'error_set_declaration';
export const IDENTIFIER = 'identifier';
export const STRUCT_INIT = 'struct_initializer';
export const UNARY_EXPRESSION = 'unary_expression';

/** Both spellings of a struct literal: `.{ … }` (anonymous) and `T{ … }` (typed). */
const STRUCT_INITS: ReadonlySet<string> = new Set([ANON_STRUCT_INIT, STRUCT_INIT]);

/**
 * Recursion cap for every CST descent in this module. Node depth is attacker-controlled —
 * a generated `"a" ++ "a" ++ …` chain nests one `binary_expression` per operand — so an
 * uncapped walk turns a source file into a stack-overflow DoS on the parse process.
 */
export const MAX_CST_DEPTH = 4000;

/** Two nodes denote the same source range (web-tree-sitter hands out fresh objects per access). */
export function sameNode(a: TsNode | null | undefined, b: TsNode | null | undefined): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** The callee of a `call_expression` — its `function` field. */
export function calleeOf(call: TsNode): TsNode | undefined {
  return call.childForFieldName?.('function') ?? undefined;
}

/** Argument expressions, excluding the callee and the argument-list wrapper. */
export function callArguments(call: TsNode): TsNode[] {
  return call.childForFieldName?.('arguments')?.namedChildren ?? [];
}

/** `try expr` → `expr` (repeatedly); any other node is returned unchanged. */
export function unwrapTry(node: TsNode): TsNode {
  let current = node;
  while (current?.type === TRY_EXPRESSION) {
    const inner = current.namedChild(0);
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/** The `@name` of a `builtin_function` (`@import("std")` → `'@import'`). */
export function builtinName(node: TsNode): string | undefined {
  if (node?.type !== BUILTIN_FUNCTION) return undefined;
  return namedChildrenOfType(node, BUILTIN_IDENTIFIER)[0]?.text as string | undefined;
}

/** The text of a `string` literal without its quotes, via the `string_content` child. */
export const stringValue = makeStringValueReader({
  stringNodeTypes: new Set([STRING]),
  contentChildTypes: new Set([STRING_CONTENT]),
  emptyValue: '',
});

/** The single string argument of a builtin (`@import("x")` → `'x'`); undefined when it has none. */
export function builtinStringArg(node: TsNode): string | undefined {
  if (node?.type !== BUILTIN_FUNCTION) return undefined;
  const args = namedChildrenOfType(node, ARGUMENTS)[0];
  if (!args) return undefined;
  const first = args.namedChild(0);
  return stringValue(first);
}

/**
 * `a.b.c` → `['a','b','c']`, a bare `a` → `['a']`, a `@This()`-headed chain → `['@This()', …]`.
 * Undefined for anything a name chain cannot describe: an enum literal (`.GET`), a call in the
 * chain (`f().b`), any other builtin head. Precision-first — a partial chain is a wrong chain.
 */
export function memberChain(node: TsNode, depth = 0): string[] | undefined {
  if (!node || depth > MAX_CST_DEPTH) return undefined;
  if (node.type === IDENTIFIER) return [node.text as string];
  if (node.type === BUILTIN_FUNCTION) return builtinName(node) === '@This' ? ['@This()'] : undefined;
  if (node.type !== FIELD_EXPRESSION) return undefined;
  const object = node.childForFieldName?.('object');
  const member = node.childForFieldName?.('member');
  if (!object || member?.type !== IDENTIFIER) return undefined;
  const head = memberChain(object, depth + 1);
  return head ? [...head, member.text as string] : undefined;
}

/** `&.{ … }` → the initializer it points at; anything else unchanged. */
function unwrapRef(node: TsNode): TsNode {
  return node?.type === UNARY_EXPRESSION ? (node.childForFieldName?.('argument') ?? node) : node;
}

/** The `initializer_list` of a struct literal, `&`-prefix unwrapped; undefined for anything else. */
function initializerList(node: TsNode): TsNode | undefined {
  const struct = unwrapRef(node);
  if (!struct || !STRUCT_INITS.has(struct.type)) return undefined;
  return namedChildrenOfType(struct, INITIALIZER_LIST)[0];
}

/** `&.{ .{ … }, .{ … } }` → the struct literals it lists (the positional counterpart of the above). */
export function initializerElements(node: TsNode): TsNode[] {
  const list = initializerList(node);
  if (!list) return [];
  const out: TsNode[] = [];
  for (let i = 0; i < list.namedChildCount; i++) {
    const child = list.namedChild(i);
    if (child && STRUCT_INITS.has(child.type)) out.push(child);
  }
  return out;
}

/** `.GET` → `'GET'`. An enum literal is a `field_expression` with a member but NO object. */
export function enumLiteralName(node: TsNode): string | undefined {
  if (node?.type !== FIELD_EXPRESSION) return undefined;
  if (node.childForFieldName?.('object')) return undefined;
  const member = node.childForFieldName?.('member');
  return member?.type === IDENTIFIER ? (member.text as string) : undefined;
}

/**
 * `.{ .url = X, .method = Y }` → `url → X`, `method → Y`. One level only: a nested
 * `.{ … }` is returned as the value node, and the caller recurses if it wants to.
 */
export function initializerEntries(node: TsNode): Map<string, TsNode> {
  const out = new Map<string, TsNode>();
  const list = initializerList(node);
  if (!list) return out;
  for (const entry of namedChildrenOfType(list, ASSIGNMENT_EXPRESSION)) {
    const key = enumLiteralName(entry.childForFieldName?.('left'));
    const value = entry.childForFieldName?.('right');
    if (key && value && !out.has(key)) out.set(key, value);
  }
  return out;
}

/**
 * The literal text a node denotes, for SQL detection (BR-15): a `string` → its content; a
 * `multiline_string` → each line stripped of leading whitespace and its `\\` prefix, joined by
 * newline; a `++` `binary_expression` whose BOTH operands are literal text → their concatenation.
 * Anything else — including a `++` with one non-literal operand — is undefined, never partial.
 */
export function sqlText(node: TsNode, depth = 0): string | undefined {
  if (!node || depth > MAX_CST_DEPTH) return undefined;
  if (node.type === STRING) return stringValue(node);
  if (node.type === MULTILINE_STRING) {
    return (node.text as string)
      .split('\n')
      .map((line: string) => {
        const trimmed = line.trimStart();
        return trimmed.startsWith('\\\\') ? trimmed.slice(2) : trimmed;
      })
      .join('\n');
  }
  if (node.type === BINARY_EXPRESSION && node.childForFieldName?.('operator')?.text === '++') {
    const left = sqlText(node.childForFieldName?.('left'), depth + 1);
    const right = sqlText(node.childForFieldName?.('right'), depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

/**
 * A single-line string value: a `"…"` literal, or a `++` chain of them. Unlike `sqlText` a
 * `multiline_string` is NOT folded — a URL is never written as a `\\` block, and folding one
 * would invent newlines inside the value.
 */
export function stringConstText(node: TsNode | undefined, depth = 0): string | undefined {
  if (!node || depth > MAX_CST_DEPTH) return undefined;
  if (node.type === STRING) return stringValue(node);
  if (node.type === BINARY_EXPRESSION && node.childForFieldName?.('operator')?.text === '++') {
    const left = stringConstText(node.childForFieldName?.('left'), depth + 1);
    const right = stringConstText(node.childForFieldName?.('right'), depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

/** The NEAREST enclosing `function_declaration`, or undefined at file scope / inside a `test`. */
export const enclosingFunctionDecl = makeEnclosingWalker(new Set([FUNCTION_DECL]));

/**
 * The value a `variable_declaration` binds: its last named child, unless that child IS the type
 * annotation (`var x: u32 = undefined` has no value node — `undefined` is an anonymous token).
 */
export function declValue(node: TsNode): TsNode | undefined {
  if (node?.type !== VARIABLE_DECL) return undefined;
  const last = node.namedChild(node.namedChildCount - 1);
  // The first named child is the declared NAME (`_ = r;` parses as a declaration named `_`),
  // so a declaration whose last named child is still the name binds nothing.
  if (!last || sameNode(last, node.namedChild(0))) return undefined;
  const annotation = node.childForFieldName?.('type');
  return sameNode(last, annotation) ? undefined : last;
}
