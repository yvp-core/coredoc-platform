/**
 * Shared tree-sitter-rust CST helpers for the Rust substrate. Generic Rust — no framework-
 * or client-specific assumptions. The entrypoint / entity / db-op / egress / call-graph
 * extractors all build on these primitives.
 *
 * Three things live ONCE here because every lane depends on them, and all three differ from
 * the Python analogues in ways that fail SILENTLY if assumed away:
 *
 *   1. Attribute-macro machinery. `#[get("/p")]`, `#[program]`, `#[ink(message)]`,
 *      `#[entry_point]`, `#[derive(Queryable)]`, `#[sea_orm(table_name = "…")]` are all the
 *      same CST shape, so one reader serves web frameworks AND smart contracts. Unlike
 *      Python's `decorated_definition`, Rust does NOT wrap the item: `attribute_item` nodes
 *      are PRECEDING SIBLINGS, and comments interleave between them.
 *   2. `rustStringValue` — this grammar build gives `string_literal` NO `string_content`
 *      child, so Python's `descendantsOfType('string_content')[0]` returns '' for every Rust
 *      string with no error (empty routes, empty table names, empty SQL).
 *   3. `rustFunctionId` — the canonical decl id keyed on the FULL enclosing scope chain
 *      (mod → impl/trait → enclosing fns → name). Rust puts same-named methods (`new`, `from`,
 *      `handle`) on every type in a file; a flat file+name id would collapse them.
 */
import type { StableIdGenerator } from '@coredoc/core';
import { TreeSitterLoader, type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { makeScopeChainId } from '../cst-kit/scope.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { nearestAncestor } from '../cst-kit/walk.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

/** A parsed Rust source file: repo-relative path, its text, and the CST root node. */
export interface RustFile {
  relPath: string;
  source: string;
  root: TsNode;
}

/** Parse Rust source and return the root node. The loader memoises the Parser per grammar. */
export async function parseRust(source: string): Promise<TsNode> {
  return (await TreeSitterLoader.getInstance().getParser('rust')).parse(source).rootNode;
}

// tree-sitter-rust node types the substrate depends on.
export const FUNCTION_ITEM = 'function_item';
export const STRUCT_ITEM = 'struct_item';
export const ENUM_ITEM = 'enum_item';
export const TRAIT_ITEM = 'trait_item';
export const IMPL_ITEM = 'impl_item';
export const MOD_ITEM = 'mod_item';
export const ATTRIBUTE_ITEM = 'attribute_item';
export const CALL_EXPRESSION = 'call_expression';
export const FIELD_EXPRESSION = 'field_expression';
export const GENERIC_FUNCTION = 'generic_function';
export const SCOPED_IDENTIFIER = 'scoped_identifier';
export const MACRO_INVOCATION = 'macro_invocation';
export const TOKEN_TREE = 'token_tree';
export const STRING_LITERAL = 'string_literal';
export const RAW_STRING_LITERAL = 'raw_string_literal';

/** Node types that represent a Rust function definition (free fn, method, trait method). */
export const DEF_TYPES = new Set<string>([FUNCTION_ITEM]);
/** Node types that introduce a named type (struct/enum/trait). */
export const TYPE_ITEM_TYPES = new Set<string>([STRUCT_ITEM, ENUM_ITEM, TRAIT_ITEM]);
/** Comment node types that interleave between attributes and their item. */
const COMMENT_TYPES = new Set<string>(['line_comment', 'block_comment']);
/** Nodes that introduce a scope segment for the canonical decl id. */
const SCOPE_TYPES = new Set<string>([MOD_ITEM, IMPL_ITEM, TRAIT_ITEM, FUNCTION_ITEM]);

export { nearestAncestor };

/** The `name` field text of an item (fn/struct/enum/trait/mod). */
export function itemName(node: TsNode): string | undefined {
  return (node?.childForFieldName?.('name')?.text ?? undefined) as string | undefined;
}

/**
 * Whether a `function_item` is `async`. The grammar groups `async` / `const` / `unsafe` /
 * `extern` into a single `function_modifiers` node before the `fn` token, so there is no bare
 * `async` child to look for.
 */
export function isAsyncFn(node: TsNode): boolean {
  for (let i = 0; i < (node?.childCount ?? 0); i++) {
    const c = node.child(i);
    if (c?.type === 'fn') return false;
    if (c?.type === 'function_modifiers' && (c.text as string).includes('async')) return true;
  }
  return false;
}

/** Whether an item carries a `pub` visibility modifier. */
export function isPublic(node: TsNode): boolean {
  for (let i = 0; i < (node?.childCount ?? 0); i++) {
    if (node.child(i)?.type === 'visibility_modifier') return true;
  }
  return false;
}

/** The last `::` segment of a path (`tonic::async_trait` → 'async_trait'; `get` → 'get'). */
export function lastPathSegment(path: string): string {
  const i = path.lastIndexOf('::');
  return i === -1 ? path : path.slice(i + 2);
}

/** A bare Rust type identifier — what a nominal type name may look like once sigils are gone. */
const RUST_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strip a type's generic/lifetime tail and reference sigils: `&mut Foo<'a, T>` → 'Foo',
 * `&'a StdoutEmitter` → 'StdoutEmitter'.
 *
 * Returns `undefined` for anything that is not a NOMINAL type after stripping — a tuple
 * (`impl From<X> for (A, upload::Args)`), a slice, a function pointer. Those spellings used to
 * leak the raw fragment (`'a StdoutEmitter`, `Args)`) into the scope chain, so a method's
 * `classId` named a type that cannot exist; "no nominal type here" is the honest answer, and
 * callers already treat `undefined` as "not a type-scoped item".
 */
export function baseTypeName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const stripped = text
    .replace(/^[&*]+\s*(mut\s+|const\s+)?/, '')
    // Reference lifetimes bind after the `&` (`&'a mut Foo`), so they are stripped second.
    .replace(/^'[A-Za-z_][A-Za-z0-9_]*\s+(mut\s+)?/, '')
    .trim();
  const cut = stripped.split('<')[0].trim();
  if (!cut) return undefined;
  const name = lastPathSegment(cut);
  return RUST_IDENT.test(name) ? name : undefined;
}

// =============================================================================
// String literals — Rust has NO `string_content` child in this grammar build
// =============================================================================

/**
 * The VALUE of a Rust string literal, quotes stripped.
 *
 * `string_literal.namedChildCount === 0` in this grammar build and `.text` is `"\"hello\""`
 * (quotes included), so the Python idiom `descendantsOfType('string_content')[0]?.text`
 * yields `''` for every Rust string — silently, with no error. Handles `"…"`, `r"…"`,
 * `r#"…"#` (any hash count) and byte-string prefixes; a `string_content` child is preferred
 * when present so a future grammar bump does not break this.
 */
export const rustStringValue = makeStringValueReader({
  contentChildTypes: new Set(['string_content']),
  unquote: (text) => {
    const raw = /^[a-zA-Z]*r(#*)"([\s\S]*)"\1$/.exec(text);
    if (raw) return raw[2];
    const plain = /^[a-zA-Z]*"([\s\S]*)"$/.exec(text);
    if (plain) return plain[1];
    return undefined;
  },
});

/** Every string literal (plain or raw) among a node's direct named children, as values. */
export function directStringValues(node: TsNode | undefined): string[] {
  const out: string[] = [];
  const n = node?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild(i) as TsNode | undefined;
    if (c && (c.type === STRING_LITERAL || c.type === RAW_STRING_LITERAL)) {
      const v = rustStringValue(c);
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

// =============================================================================
// Attribute-macro machinery — the single highest-leverage primitive
// =============================================================================

/**
 * The `attribute` nodes attached to an item, in SOURCE order.
 *
 * Rust does not wrap a decorated item: `#[…]` produces an `attribute_item` node that is a
 * PRECEDING SIBLING of the item. Comments interleave freely — for
 * `#[derive(Debug)] / /// docs / #[get("/a")] / // plain / pub fn h()` the sibling chain
 * from the fn is `line_comment ← attribute_item ← line_comment ← attribute_item`. A walk
 * that stops at the first non-`attribute_item` therefore loses every doc-commented handler,
 * which is most of them in real code. Comments are SKIPPED; the walk stops at the first
 * node that is neither an attribute nor a comment (otherwise the previous item's attributes
 * would leak onto this one).
 */
export function attributesOf(item: TsNode): TsNode[] {
  const out: TsNode[] = [];
  let cur: TsNode | null = item?.previousNamedSibling ?? null;
  while (cur) {
    if (COMMENT_TYPES.has(cur.type)) {
      cur = cur.previousNamedSibling;
      continue;
    }
    if (cur.type !== ATTRIBUTE_ITEM) break;
    const attr = cur.namedChild?.(0) as TsNode | undefined;
    if (attr) out.push(attr);
    cur = cur.previousNamedSibling;
  }
  return out.reverse();
}

/** An attribute's path as written (`get`, `tonic::async_trait`, `cfg_attr`). */
export function attributePath(attr: TsNode): string {
  const head = attr?.namedChild?.(0) as TsNode | undefined;
  return (head?.text ?? '') as string;
}

/** An attribute's NAME — the last `::` segment of its path (`tonic::async_trait` → 'async_trait'). */
export function attributeName(attr: TsNode): string {
  return lastPathSegment(attributePath(attr));
}

/** An attribute's argument `token_tree` (`#[get("/p")]` → `("/p")`); undefined for a bare `#[program]`. */
export function attributeArgs(attr: TsNode): TsNode | undefined {
  return (attr?.childForFieldName?.('arguments') ?? undefined) as TsNode | undefined;
}

/** Whether a `token_tree` contains `name` as a named identifier at any nesting depth. */
function tokenTreeMentions(tree: TsNode | undefined, name: string): boolean {
  if (!tree) return false;
  for (const id of (tree.descendantsOfType?.('identifier') ?? []) as TsNode[]) {
    if (id.text === name) return true;
  }
  return false;
}

/**
 * Whether an attribute applies one of `names`.
 *
 * Matches when the attribute path's LAST segment equals a name, OR when the attribute is a
 * `cfg_attr` whose token tree mentions the name. That second arm is not an optimization:
 * CosmWasm's real-world shape is `#[cfg_attr(not(feature = "library"), entry_point)]`, not a
 * bare `#[entry_point]`, so a plain path match silently misses the majority of real contracts.
 */
export function attributeMatches(attr: TsNode, names: readonly string[]): boolean {
  const name = attributeName(attr);
  if (names.includes(name)) return true;
  if (name !== 'cfg_attr') return false;
  const args = attributeArgs(attr);
  return names.some((n) => tokenTreeMentions(args, n));
}

/** The first attribute on `item` matching one of `names`, if any. */
export function findAttribute(item: TsNode, names: readonly string[]): TsNode | undefined {
  return attributesOf(item).find((a) => attributeMatches(a, names));
}

/** Whether `item` carries an attribute matching one of `names`. */
export function hasAttribute(item: TsNode, names: readonly string[]): boolean {
  return findAttribute(item, names) !== undefined;
}

/**
 * The derive macros on an item: `#[derive(Debug, Queryable)]` → ['Debug','Queryable'].
 * Fully-qualified derives (`#[derive(sqlx::FromRow)]`) reduce to their last segment.
 */
export function deriveMacros(item: TsNode): string[] {
  const out: string[] = [];
  for (const attr of attributesOf(item)) {
    if (attributeName(attr) !== 'derive') continue;
    const args = attributeArgs(attr);
    const n = args?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      const child = args.namedChild(i) as TsNode | undefined;
      // This grammar preserves each derive path inside a meta_item wrapper.
      const c = child?.type === 'meta_item' ? child.namedChild(0) : child;
      if (c?.type === 'identifier' || c?.type === SCOPED_IDENTIFIER || c?.type === 'type_identifier') {
        out.push(lastPathSegment(c.text as string));
      }
    }
  }
  return out;
}

/**
 * A `key = "value"` string tail inside an attribute's token tree
 * (`#[sea_orm(table_name = "users")]` → 'users'; `#[diesel(table_name = users)]` → 'users').
 *
 * A `token_tree` is token SOUP — `=`, `->`, `,` are anonymous nodes with no structure to walk —
 * so the rule is: named-child scan for positional string args, `.text` + regex for structured
 * key/value tails. Never parse a token tree structurally.
 */
export function attributeKeyValue(attr: TsNode, key: string): string | undefined {
  const args = attributeArgs(attr);
  if (!args) return undefined;
  const text = (args.text ?? '') as string;
  const quoted = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(text);
  if (quoted) return quoted[1];
  const bare = new RegExp(`\\b${key}\\s*=\\s*([A-Za-z_][A-Za-z0-9_:]*)`).exec(text);
  return bare ? bare[1] : undefined;
}

/** The positional string arguments of an attribute (`#[get("/p")]` → ['/p']). */
export function attributeStringArgs(attr: TsNode): string[] {
  return directStringValues(attributeArgs(attr));
}

// =============================================================================
// Canonical decl id — full enclosing scope chain
// =============================================================================

/** The type an `impl` block is FOR (`impl Trait for Foo<T>` → 'Foo'; `impl Foo` → 'Foo'). */
export function implTypeName(implNode: TsNode): string | undefined {
  return baseTypeName(implNode?.childForFieldName?.('type')?.text as string | undefined);
}

/** The trait an `impl` block implements (`impl Greeter for X` → 'Greeter'), if any. */
export function implTraitName(implNode: TsNode): string | undefined {
  return baseTypeName(implNode?.childForFieldName?.('trait')?.text as string | undefined);
}

/**
 * The enclosing scope names of a node, OUTERMOST first, excluding the node itself:
 * `mod` names, `impl` target types, `trait` names, and enclosing fn names.
 */
/** An `impl` block is named by the type it targets, every other item by its own name. */
function itemSegment(node: TsNode): string[] {
  const n = node.type === IMPL_ITEM ? implTypeName(node) : itemName(node);
  return n ? [n] : [];
}

const rustScope = makeScopeChainId({ scopeNodeTypes: SCOPE_TYPES, segmentsOf: itemSegment, separator: '::' });

export const rustScopeChain = rustScope.chain;

/** The enclosing TYPE names of a node (impl targets / traits / structs), outermost first. */
export const rustTypeChain = makeScopeChainId({
  scopeNodeTypes: new Set([IMPL_ITEM, ...TYPE_ITEM_TYPES]),
  segmentsOf: itemSegment,
  separator: '::',
}).chain;

/**
 * Canonical id for a Rust fn, keyed on its full enclosing scope chain. Free fns at file
 * scope → `functionId(file, name)`; anything inside a `mod`, `impl` or `trait` →
 * `methodId(file, scope.join('::'), name)`. Used by BOTH the call-graph def index and the
 * db-op performer minting, so a def's node id matches its performer id and they merge.
 *
 * Boundary: two `impl Foo` blocks in one file (inherent + trait) with the same method name
 * collapse onto one id — a documented collapse, like Swift's same-name overloads.
 */
export function rustFunctionId(idGen: StableIdGenerator, relPath: string, fnNode: TsNode): string {
  return rustScope.id(idGen, relPath, fnNode, { name: itemName(fnNode) ?? '(anonymous)' });
}

// =============================================================================
// File discovery
// =============================================================================

/**
 * Built-in default excludes for Rust repos. These SHIP in code (a profile's `exclude`
 * EXTENDS them; `excludeDefaults: false` opts out entirely).
 *
 * `target/` is the important one: it is NOT in the shared enumerator's `DEFAULT_IGNORE_DIRS`
 * floor, so a built workspace would otherwise drag its whole build tree into scope.
 * `migrations/**` is deliberately NOT excluded by Python reflex — that is exactly where a
 * sqlx/diesel repo's schema DDL lives (the highest-fidelity entity source in Rust); only its
 * `.rs` files are out of scope, and they are not matched here anyway.
 */
export const DEFAULT_RS_EXCLUDES: string[] = [
  '**/target/**',
  '**/vendor/**',
  '**/tests/**',
  '**/benches/**',
  '**/examples/**',
  '**/build.rs',
];

/**
 * Enumerate `.rs` sources in scope: the gitignore-honoring repo walk (`enumerateRepoFiles`)
 * filtered to `.rs` + the profile's include/exclude globs. An empty `include` defaults to all
 * `.rs` files; the effective exclude is `DEFAULT_RS_EXCLUDES` plus the profile's `exclude`
 * unless `excludeDefaults === false`. Sorted for deterministic output.
 */
export function discoverRustFiles(
  root: string,
  include: string[],
  exclude: string[] = [],
  excludeDefaults?: boolean,
): string[] {
  return discoverRustFileScope(root, include, exclude, excludeDefaults).included;
}

/** The scorer-facing source scope, derived by the same discovery policy as the parser. */
export const discoverRustFileScope = makeFileScopeDiscoverer({
  extensions: ['.rs'],
  defaultInclude: ['**/*.rs'],
  defaultExclude: DEFAULT_RS_EXCLUDES,
});
