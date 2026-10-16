/**
 * Shared tree-sitter-go CST helpers for the Go substrate. Generic Go — no framework- or
 * client-specific assumptions. The entrypoint / entity / db-op / egress / call-graph extractors
 * all build on these primitives.
 *
 * Four things live ONCE here because every lane depends on them, and the first three fail
 * SILENTLY when assumed away:
 *
 *   1. `goStringValue` — this grammar build gives string literals NO `string_content` child
 *      (`interpreted_string_literal.namedChildCount === 0`; the only named children that ever
 *      appear are `escape_sequence` nodes, and `raw_string_literal` has none at all). So the
 *      Python idiom `descendantsOfType('string_content')[0]?.text` yields '' for EVERY Go string
 *      with no error at all — empty route paths, empty table names, empty SQL.
 *   2. `itemName` / `receiverTypeName` — a method's name is a `field_identifier`, not an
 *      `identifier`. In `func (s *Svc) Handle()` the first `identifier` descendant is the RECEIVER
 *      VARIABLE `s`, so a `descendantsOfType('identifier')[0]` reach names every method after its
 *      receiver. Always go through the `name` field.
 *   3. `goFunctionId` — the canonical decl id keyed on the enclosing scope chain (receiver type →
 *      enclosing funcs → name). Go hangs the same method name (`Get`, `Close`, `ServeHTTP`) off
 *      every type in a file and permits several `init` funcs per file, so a flat file+name id
 *      collapses them onto one node and corrupts the call graph.
 *   4. `discoverGoFileScope` — the built-in exclude floor. `vendor/` is NOT in the shared enumerator's
 *      `DEFAULT_IGNORE_DIRS`, and `*_test.go` files typically outnumber the code they test.
 */
import type { StableIdGenerator } from '@coredoc/core';
import { type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { makeScopeChainId } from '../cst-kit/scope.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { makeEnclosingWalker, namedChildrenOfType, nearestAncestor } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

/** A parsed Go source file: repo-relative path, its text, and the CST root node. */
export interface GoFile {
  relPath: string;
  source: string;
  root: TsNode;
}

// tree-sitter-go node types the substrate depends on.
export const SOURCE_FILE = 'source_file';
export const PACKAGE_CLAUSE = 'package_clause';
export const PACKAGE_IDENTIFIER = 'package_identifier';
export const IMPORT_SPEC = 'import_spec';
export const FUNCTION_DECLARATION = 'function_declaration';
export const METHOD_DECLARATION = 'method_declaration';
export const FUNC_LITERAL = 'func_literal';
export const TYPE_SPEC = 'type_spec';
export const TYPE_ALIAS = 'type_alias';
export const STRUCT_TYPE = 'struct_type';
export const FIELD_DECLARATION_LIST = 'field_declaration_list';
export const FIELD_DECLARATION = 'field_declaration';
export const INTERFACE_TYPE = 'interface_type';
export const METHOD_SPEC = 'method_spec';
export const VAR_DECLARATION = 'var_declaration';
export const VAR_SPEC = 'var_spec';
export const CONST_DECLARATION = 'const_declaration';
export const CONST_SPEC = 'const_spec';
export const CALL_EXPRESSION = 'call_expression';
export const SELECTOR_EXPRESSION = 'selector_expression';
export const PARAMETER_LIST = 'parameter_list';
export const PARAMETER_DECLARATION = 'parameter_declaration';
export const VARIADIC_PARAMETER_DECLARATION = 'variadic_parameter_declaration';
export const QUALIFIED_TYPE = 'qualified_type';
export const COMPOSITE_LITERAL = 'composite_literal';
export const KEYED_ELEMENT = 'keyed_element';
export const SHORT_VAR_DECLARATION = 'short_var_declaration';
export const ASSIGNMENT_STATEMENT = 'assignment_statement';
export const RETURN_STATEMENT = 'return_statement';
export const EXPRESSION_LIST = 'expression_list';
export const BLOCK = 'block';
export const FOR_CLAUSE = 'for_clause';
export const RANGE_CLAUSE = 'range_clause';
export const TYPE_SWITCH_STATEMENT = 'type_switch_statement';
export const UNARY_EXPRESSION = 'unary_expression';
export const BINARY_EXPRESSION = 'binary_expression';
export const PARENTHESIZED_EXPRESSION = 'parenthesized_expression';
export const IDENTIFIER = 'identifier';
export const FIELD_IDENTIFIER = 'field_identifier';
export const TYPE_IDENTIFIER = 'type_identifier';
export const BLANK_IDENTIFIER = 'blank_identifier';
export const DOT = 'dot';
export const INTERPRETED_STRING_LITERAL = 'interpreted_string_literal';
export const RAW_STRING_LITERAL = 'raw_string_literal';
export const ESCAPE_SEQUENCE = 'escape_sequence';

/** Node types that DECLARE a named function (free function, method). */
export const DEF_TYPES = new Set<string>([FUNCTION_DECLARATION, METHOD_DECLARATION]);
/** Node types that own a body, i.e. can contain a call site — declarations plus closures. */
export const FN_SCOPE_TYPES = new Set<string>([FUNCTION_DECLARATION, METHOD_DECLARATION, FUNC_LITERAL]);
/** The two string literal node types. */
export const STRING_LITERAL_TYPES = new Set<string>([INTERPRETED_STRING_LITERAL, RAW_STRING_LITERAL]);

export { nearestAncestor, namedChildrenOfType };

/**
 * The `name` field text of a declaration (func/method/type_spec/var_spec/const_spec/field/method_spec).
 *
 * Always read through the `name` FIELD, never through a descendant scan: a `method_declaration`'s
 * name is a `field_identifier` that comes AFTER the receiver, so the first `identifier` descendant
 * is the receiver variable (`s` in `func (s *Svc) Handle()`), not the method.
 */
export function itemName(node: TsNode): string | undefined {
  return (node?.childForFieldName?.('name')?.text ?? undefined) as string | undefined;
}

/**
 * Whether a Go identifier is EXPORTED — the whole of Go's visibility model is "the first rune is a
 * Unicode uppercase letter (class Lu)". There is no `pub`, no `export`, no modifier node to look
 * for, so this is the only visibility signal the CST can offer.
 */
export function isExported(name: string | undefined): boolean {
  return !!name && /^\p{Lu}/u.test(name);
}

/** The package a file declares, from its `package_clause`. */
export function packageName(file: GoFile): string | undefined {
  const clause = (file?.root?.descendantsOfType?.(PACKAGE_CLAUSE) ?? [])[0] as TsNode | undefined;
  const ident = clause?.descendantsOfType?.(PACKAGE_IDENTIFIER)?.[0] as TsNode | undefined;
  return (ident?.text ?? undefined) as string | undefined;
}

/**
 * A type expression stripped down to the possibly-qualified name it denotes: pointers,
 * slices/arrays, maps, channels, variadics and the generic instantiation tail all peeled —
 * `[]*db.User[T]` → 'db.User'. Shared by `baseTypeName` and `typeQualifier` so the two can never
 * disagree about where the name ends and the wrapper begins.
 */
function peeledTypeName(text: string): string {
  let t = text.trim();
  // Peel prefixes that wrap a type without changing which type it is.
  for (;;) {
    const next = t.replace(/^(\*|\.\.\.|\[[^\]]*\]|map\[[^\]]*\]|<-chan\s+|chan\s+(<-\s*)?)/, '').trim();
    if (next === t) break;
    t = next;
  }
  // Generic instantiation tail (`Repo[T]`).
  return t.split('[')[0].trim();
}

/**
 * A type expression's base type name: pointers, slices/arrays, maps, channels, variadics, generic
 * arguments and the package qualifier all stripped — `[]*db.User[T]` → 'User'.
 *
 * The package qualifier is DROPPED on purpose: this answers "which type is this", and the qualifier
 * is a per-file local alias, not an identity. A lane that needs to know WHICH package the type came
 * from must resolve the qualifier through the file's import table (`go-imports.ts`) instead — see
 * `typeQualifier` for the other half of that pair.
 */
export function baseTypeName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const segment = peeledTypeName(text).split('.').pop() ?? '';
  return segment || undefined;
}

/**
 * A type expression's package QUALIFIER: `[]*db.User` → 'db', `*Handler` → undefined.
 *
 * The counterpart to `baseTypeName`: together they say "type `name`, as spelled through local alias
 * `qualifier` in THIS file". A caller must resolve the qualifier through the declaring file's import
 * table to learn which package really declares the type — the alias alone is not an identity, and
 * two files can spell the same package differently.
 */
export function typeQualifier(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const parts = peeledTypeName(text).split('.');
  // A Go type expression is at most `pkg.Name`, so the qualifier is the segment before the last.
  return parts.length > 1 ? parts[parts.length - 2] || undefined : undefined;
}

/**
 * The receiver's base type for a `method_declaration`: `func (s *Svc) …` → 'Svc'.
 *
 * The receiver is a `parameter_list` holding ONE `parameter_declaration`; its `type` is a
 * `pointer_type` for the (overwhelmingly common) pointer receiver and a bare `type_identifier` for
 * a value receiver. Both spellings name the SAME type, so both must collapse to one name or a
 * type's methods split across two graph nodes.
 */
export function receiverTypeName(methodDecl: TsNode): string | undefined {
  const receiver = methodDecl?.childForFieldName?.('receiver') as TsNode | undefined;
  const decl = receiver?.descendantsOfType?.(PARAMETER_DECLARATION)?.[0] as TsNode | undefined;
  const typeText = (decl?.childForFieldName?.('type')?.text ?? receiver?.text) as string | undefined;
  return baseTypeName(typeText);
}

/**
 * The names a `field_declaration` declares.
 *
 * `childForFieldName('name')` returns only the FIRST — Go's `a, b int` is one declaration with two
 * `field_identifier` children, and an EMBEDDED field (`type A struct { B }`) has none at all. A
 * lane that reads only the `name` field silently drops every second grouped column and mistakes an
 * embedded struct for an anonymous field.
 */
export function fieldNames(fieldDecl: TsNode): string[] {
  return namedChildrenOfType(fieldDecl, FIELD_IDENTIFIER).map((c) => c.text as string);
}

// =============================================================================
// String literals — Go has NO `string_content` child in this grammar build
// =============================================================================

/** The Go escapes worth decoding; `\xNN` / `\uNNNN` / `\UNNNNNNNN` are left verbatim (see below). */
const GO_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

/**
 * Decode the single-character Go escapes. Numeric escapes (hex, unicode and octal forms) are left
 * as written rather than decoded: they are vanishingly rare in the strings this substrate reads
 * (route paths, table names, topics, URLs) and a half-correct decoder that mangles them would be
 * worse than a verbatim one a reader can still recognize.
 */
function decodeGoEscapes(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const mapped = s[i] === '\\' ? GO_ESCAPES[s[i + 1]] : undefined;
    if (mapped === undefined) {
      out += s[i];
      continue;
    }
    out += mapped;
    i++;
  }
  return out;
}

/**
 * The VALUE of a Go string literal, delimiters stripped.
 *
 * `interpreted_string_literal.namedChildCount === 0` in this grammar build (the quotes are
 * anonymous children and there is no `string_content`), and `.text` INCLUDES the quotes — so the
 * Python idiom `descendantsOfType('string_content')[0]?.text` returns '' for every Go string,
 * silently. `raw_string_literal` is backtick-delimited and, per Go's actual semantics, performs NO
 * escape processing: `` `a\nb` `` is a five-character string.
 *
 * A `string_content` child is preferred when one exists so a future grammar bump does not break
 * this — but only for literals with no `escape_sequence` children, because in the grammars that DO
 * expose `string_content` the escapes are separate siblings and the content node holds just the
 * first chunk.
 */
export const goStringValue = makeStringValueReader({
  contentChildTypes: new Set(['string_content']),
  preferContentChildren: (node) => ((node.descendantsOfType?.(ESCAPE_SEQUENCE) ?? []) as TsNode[]).length === 0,
  unquote: (text) => {
    if (text.length < 2) return undefined;
    if (text.startsWith('`')) return text.endsWith('`') ? text.slice(1, -1) : undefined;
    if (!text.startsWith('"') || !text.endsWith('"')) return undefined;
    return decodeGoEscapes(text.slice(1, -1));
  },
});

/** Every string literal (interpreted or raw) among a node's direct named children, as values. */
export function directStringValues(node: TsNode | undefined): string[] {
  const out: string[] = [];
  const n = node?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i) as TsNode | undefined;
    if (c && STRING_LITERAL_TYPES.has(c.type)) {
      const v = goStringValue(c);
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

// =============================================================================
// Struct tags
// =============================================================================

/** `key:"value"` pair at the head of a struct tag body, per `reflect.StructTag`'s own grammar. */
const TAG_PAIR = /^([^\s:"]+):"([^"]*)"/;

/**
 * Parse a Go struct tag into `key → value`, where the value is its FIRST comma segment:
 * `` `json:"id,omitempty" db:"id"` `` → `{ json: 'id', db: 'id' }`.
 *
 * The first comma segment is the part that names something (a column, a JSON field); everything
 * after it is option flags (`omitempty`, `primaryKey`). A lane that needs the flags reads the tag
 * node's own text.
 *
 * The tag is the TRAILING string-literal child of a `field_declaration` — normally a
 * `raw_string_literal`, but the interpreted spelling (`"json:\"id\""`) is legal Go and appears in
 * generated code, so the value is read through `goStringValue` rather than by slicing backticks.
 * Parsing STOPS at the first malformed pair, exactly as `reflect.StructTag.Get` does, instead of
 * skipping ahead and inventing a key from the tail.
 */
export function structTags(fieldDecl: TsNode): Map<string, string> {
  const tags = new Map<string, string>();
  const n = fieldDecl?.namedChildCount ?? 0;
  let literal: TsNode | undefined;
  for (let i = 0; i < n; i++) {
    const c = fieldDecl.namedChild(i) as TsNode | undefined;
    if (c && STRING_LITERAL_TYPES.has(c.type)) literal = c;
  }
  let body = literal ? goStringValue(literal) : undefined;
  if (!body) return tags;
  while (body.length > 0) {
    body = body.replace(/^[\s]+/, '');
    const m = TAG_PAIR.exec(body);
    if (!m) break;
    if (!tags.has(m[1])) tags.set(m[1], m[2].split(',')[0]);
    body = body.slice(m[0].length);
  }
  return tags;
}

// =============================================================================
// Canonical decl id — enclosing scope chain
// =============================================================================

/**
 * The name a `func_literal` is known by: the variable it is directly bound to
 * (`handler := func(…)`, `var handler = func(…)`, `handler = func(…)`), else undefined.
 *
 * Go's handler idiom binds closures to names far more often than Rust's does, and two closures in
 * one enclosing function are routine (a `setupRoutes` registering several inline handlers). Reading
 * the binding keeps those apart without keying anything on a source position, which would move a
 * node's id every time an unrelated line above it changed.
 */
function funcLiteralName(node: TsNode): string | undefined {
  // Every binding form wraps the literal in an `expression_list`, so its position in that list is
  // what pairs it with a target: `a, h := 1, func(){}` binds the literal to `h`, not to `a`.
  const parent = node?.parent;
  if (parent?.type !== EXPRESSION_LIST) return undefined;
  const index = indexOfNamedChild(parent, node);
  const stmt = parent.parent;
  if (index < 0 || !stmt) return undefined;

  let target: TsNode | undefined;
  if (stmt.type === SHORT_VAR_DECLARATION || stmt.type === ASSIGNMENT_STATEMENT) {
    if (stmt.childForFieldName?.('right')?.id !== parent.id) return undefined;
    target = stmt.childForFieldName?.('left')?.namedChild?.(index) as TsNode | undefined;
  } else if (stmt.type === VAR_SPEC || stmt.type === CONST_SPEC) {
    // `var h = func(){}` — the names are the spec's leading `identifier` children, and the literal
    // lives under its `value` list, so the two are paired positionally the same way.
    if (stmt.childForFieldName?.('value')?.id !== parent.id) return undefined;
    target = namedChildrenOfType(stmt, IDENTIFIER)[index];
  }

  const text = (target?.text ?? '') as string;
  // `_ = func(){}` binds nothing; a field target (`s.handler = func(){}`) is named by its tail.
  if (!text || text === '_') return undefined;
  return text.split('.').pop() || undefined;
}

/** Position of `child` among `parent`'s named children, or -1. */
function indexOfNamedChild(parent: TsNode, child: TsNode): number {
  const n = parent?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    if (parent.namedChild(i)?.id === child?.id) return i;
  }
  return -1;
}

/** The name a function-ish node is identified by, for id minting and graph labels. */
export function goDeclName(node: TsNode): string {
  if (node?.type === FUNC_LITERAL) return funcLiteralName(node) ?? '(anonymous)';
  return itemName(node) ?? '(anonymous)';
}

/**
 * The scope segments a function-ish node contributes when it ENCLOSES something else: a method
 * contributes both its receiver type and its own name (`Svc`, `Handle`), everything else just its
 * name.
 */
function ownScopeSegments(node: TsNode): string[] {
  if (node?.type !== METHOD_DECLARATION) return [goDeclName(node)];
  const receiver = receiverTypeName(node);
  return receiver ? [receiver, goDeclName(node)] : [goDeclName(node)];
}

/**
 * The enclosing scope names of a node, OUTERMOST first, EXCLUDING the node itself.
 *
 * Go has no module-per-file and no nested types, so the only nesting that exists is functional:
 * funcs, methods (which carry their receiver type) and closures.
 */
const goScope = makeScopeChainId({
  scopeNodeTypes: FN_SCOPE_TYPES,
  segmentsOf: ownScopeSegments,
  separator: '.',
});

export const goScopeChain = goScope.chain;

/**
 * Canonical id for a Go function, method or closure, keyed on its enclosing scope chain. A file-
 * scope `func` → `functionId(file, name)`; anything with a receiver or an enclosing function →
 * `methodId(file, scope.join('.'), name)`.
 *
 * Keying on the scope is not cosmetic. Go hangs `Get`/`Close`/`ServeHTTP` off every type in a file
 * and allows several `func init()` per file, so a flat file+name id merges unrelated declarations
 * into one graph node and every call to either lands on the survivor. Used by BOTH the call-graph
 * def index and the db-op performer minting, so a def's node id matches its performer id.
 *
 * Boundary: two truly anonymous closures in the SAME enclosing function collapse onto one id (the
 * engine's synthesized-handler path is what distinguishes inline handlers), as do repeated
 * `func init()` in one file — a documented collapse, like Rust's two-impl-blocks case.
 */
export function goFunctionId(idGen: StableIdGenerator, relPath: string, node: TsNode): string {
  // A method's own receiver type is the innermost scope segment, so it is appended to the chain
  // rather than contributed by an ancestor.
  const receiver = node?.type === METHOD_DECLARATION ? receiverTypeName(node) : undefined;
  return goScope.id(idGen, relPath, node, {
    name: goDeclName(node),
    extraSegments: receiver ? [receiver] : [],
  });
}

/**
 * The function, method or closure that CONTAINS a node — what a call site is attributed to.
 *
 * Returns undefined for a node at package scope (`var router = chi.NewRouter()`, a `const` block).
 * That is not a failure: Go really does run those at package-init time with no enclosing function,
 * so a caller must attribute them to the file (or synthesize an initializer) rather than assume a
 * function is always there.
 */
export const enclosingFunction = makeEnclosingWalker(FN_SCOPE_TYPES);

// =============================================================================
// File discovery
// =============================================================================

/**
 * Built-in default excludes for Go repos. These SHIP in code (a profile's `exclude` EXTENDS them;
 * `excludeDefaults: false` opts out entirely).
 *
 * `vendor/` is the important one: it is NOT in the shared enumerator's `DEFAULT_IGNORE_DIRS` floor
 * and a vendored repo commits its entire dependency tree, so without this every third-party
 * framework's own source would be parsed as if it were this repo's code. `*_test.go` is excluded
 * because Go co-locates tests with the code they test, so leaving them in roughly doubles the
 * function count with scaffolding — but it is a DEFAULT, not a hardcode: a profile that wants to
 * extract from tests turns the whole floor off. `*.pb.go` (which also covers `*_grpc.pb.go`) is
 * generated protobuf: thousands of machine-written methods that describe the wire format, not the
 * service. `testdata/` is Go's reserved name for fixture trees the toolchain itself ignores.
 */
export const DEFAULT_GO_EXCLUDES: string[] = ['**/vendor/**', '**/testdata/**', '**/*_test.go', '**/*.pb.go'];

/**
 * `.go` sources in scope: the gitignore-honoring repo walk (`enumerateRepoFiles`) filtered to
 * `.go` + the profile's include/exclude globs. An empty `include` defaults to all `.go` files; the
 * effective exclude is `DEFAULT_GO_EXCLUDES` plus the profile's `exclude` unless
 * `excludeDefaults === false`. Shared by the parser and the scorer.
 */
export const discoverGoFileScope = makeFileScopeDiscoverer({
  extensions: ['.go'],
  defaultInclude: ['**/*.go'],
  defaultExclude: DEFAULT_GO_EXCLUDES,
});
