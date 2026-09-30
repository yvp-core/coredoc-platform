/**
 * Shared tree-sitter-ruby CST helpers for the Ruby substrate. Generic Ruby —
 * no framework- or client-specific assumptions. The Grape / Rails-routes / egress
 * extractors all build on these primitives.
 */
import type { StableIdGenerator } from '@coredoc/core';
import { TreeSitterLoader, type TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { makeScopeChainId } from '../cst-kit/scope.js';
import { makeStringValueReader } from '../cst-kit/strings.js';
import { nearestAncestor } from '../cst-kit/walk.js';
import { releaseParsedTree } from '../../tree-sitter/tree-release.js';

// Re-exported: every extractor in this language's lane imports its node type from here.
export type { TsNode };

/** tree-sitter-ruby node types that represent a method call. */
export const CALL_TYPES = ['call', 'command', 'command_call', 'method_call'] as const;

/** Parse Ruby source and return the root node. The loader memoises the Parser per grammar. */
export async function parseRuby(source: string): Promise<TsNode> {
  return (await TreeSitterLoader.getInstance().getParser('ruby')).parse(source).rootNode;
}

/**
 * Free the WASM-side tree that owns `root`. Re-exported from the shared tree-sitter helper — the one
 * implementation every substrate (go/python/rust/swift/TS) already shares — rather than
 * redefined here: a Ruby-local copy drifted from it (an optional-called `delete?.()` that would
 * silently no-op if the web-tree-sitter API shape ever changed, turning a leak into a green test).
 */
export { releaseParsedTree };

/**
 * Parse `source`, run `fn` over the root, and release the tree on EVERY exit path (return, throw,
 * rejection). web-tree-sitter never GCs trees and its Emscripten heap is hard-capped at 2GB, so a
 * missed release is a latent `Aborted()` on a large repo — and the hand-written
 * `parse → try → finally release` pairing that guards it was repeated at ten call sites, where
 * omitting it is invisible until the OOM. Use this instead of `parseRuby` + `finally` so the
 * release cannot be forgotten.
 *
 * `fn` must return PLAIN DATA: the tree is gone by the time the result is observed.
 */
export async function withParsedRuby<T>(source: string, fn: (root: TsNode) => T | Promise<T>): Promise<T> {
  const root = await parseRuby(source);
  try {
    return await fn(root);
  } finally {
    releaseParsedTree(root);
  }
}

/** All call-shaped nodes in the tree. */
export function collectCalls(root: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const t of CALL_TYPES) out.push(...(root.descendantsOfType(t) as TsNode[]));
  return out;
}

export function isCall(node: TsNode | null | undefined): boolean {
  return !!node && (CALL_TYPES as readonly string[]).includes(node.type);
}

/** The method name of a call (`foo.bar(...)` → "bar"; bare `bar ...` → "bar"). */
export function methodName(node: TsNode): string | undefined {
  return node.childForFieldName?.('method')?.text ?? node.child(0)?.text;
}

/** The receiver text of a call, if any (`foo.bar` → "foo"). */
export function receiverText(node: TsNode): string | undefined {
  return node.childForFieldName?.('receiver')?.text;
}

/** The call's own trailing `do…end` / `{…}` block, if any. */
export function ownBlock(node: TsNode): TsNode | undefined {
  const byField = node.childForFieldName?.('block');
  if (byField) return byField;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === 'do_block' || c?.type === 'block') return c;
  }
  return undefined;
}

/**
 * Whether `node` sits inside a hash/array/keyword-pair (an OPTION value, e.g. a
 * string in `http_codes: [{ message: 'x' }]`) before reaching `call` — such strings
 * are not positional arguments.
 */
export function isNestedOption(node: TsNode, call: TsNode): boolean {
  let cur = node.parent;
  while (cur && cur.id !== call.id) {
    if (cur.type === 'hash' || cur.type === 'array' || cur.type === 'pair' || cur.type === 'keyword_argument') {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * The inner text of a string literal: the first `string_content` piece, else the text with one
 * layer of quotes stripped. Interpolation is deliberately NOT folded in — a token read here is
 * used as a path or identifier, and `"a#{x}b"` must not read as the literal `ab`.
 */
const stringLiteralValue = makeStringValueReader({
  contentChildTypes: new Set(['string_content']),
  unquote: (text) => text.replace(/^['"`]|['"`]$/g, ''),
});

/** Strip surrounding quotes / leading `:` and return the inner text of a string/symbol node. */
export function tokenText(node: TsNode): string {
  // A symbol has no content child at all — its quirk stays here rather than widening the reader.
  if (node.type === 'simple_symbol') return (node.text as string).replace(/^:/, '');
  return stringLiteralValue(node) as string;
}

/**
 * First POSITIONAL string OR symbol argument of a call — before the call's own block,
 * not nested in an option hash/array. String args with whitespace (descriptions) are
 * rejected, so the result is safe to use as a path/identifier token.
 */
export function firstArg(node: TsNode): { kind: 'string' | 'symbol'; value: string } | undefined {
  const block = ownBlock(node);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  const candidates: Array<{ start: number; kind: 'string' | 'symbol'; value: string }> = [];
  for (const s of node.descendantsOfType('string') as TsNode[]) {
    if (s.startIndex >= blockStart || isNestedOption(s, node)) continue;
    const inner = tokenText(s);
    if (/\s/.test(inner)) continue;
    candidates.push({ start: s.startIndex, kind: 'string', value: inner });
  }
  for (const sym of node.descendantsOfType('simple_symbol') as TsNode[]) {
    if (sym.startIndex >= blockStart || isNestedOption(sym, node)) continue;
    candidates.push({ start: sym.startIndex, kind: 'symbol', value: tokenText(sym) });
  }
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0];
}

/** Join path segments into a normalized `/a/b/c` route (collapses slashes, drops empties). */
export function normalizePath(segments: string[]): string {
  const joined = segments
    .flatMap((s) => s.split('/'))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** tree-sitter-ruby node types for method definitions (`def` / `def self.`). */
export const DEF_TYPES = new Set(['method', 'singleton_method']);
/** tree-sitter-ruby node types for class/module definitions. */
export const CLASS_TYPES = new Set(['class', 'module']);

export { nearestAncestor };

/** The `name` field text of a class/module/method node (its identifier/constant). */
export function defOrClassName(node: TsNode): string | undefined {
  return (node.childForFieldName?.('name')?.text ?? undefined) as string | undefined;
}

/**
 * Nesting-qualified name of a class/module node: its own `name` text prefixed by every named
 * enclosing class/module, so `module A; class B` reads 'A::B' — the same spelling `class A::B`
 * already gives itself, which is what makes the two forms of one class share a key.
 *
 * Undefined when the node itself is unnamed (a malformed/ERROR parse): an unnamed container emits
 * no ClassNode, so nothing may be keyed on it. An unnamed node in the MIDDLE of the chain
 * contributes no segment rather than aborting the walk — its children still have a real name.
 *
 * Use this for any REPO-WIDE index: the bare `name` alone puts `Billing::Client` and
 * `Github::Client` in one bucket, where the last file parsed silently wins.
 */
const rubyNesting = makeScopeChainId({
  scopeNodeTypes: CLASS_TYPES,
  segmentsOf: (node) => {
    const name = defOrClassName(node);
    return name ? [name] : [];
  },
  separator: '::',
});

export function qualifiedClassName(node: TsNode): string | undefined {
  const own = defOrClassName(node);
  if (!own) return undefined;
  return [...rubyNesting.chain(node), own].join('::');
}

/** tree-sitter-ruby node type for a `class << self` singleton-class block. */
export const SINGLETON_CLASS_TYPE = 'singleton_class';

/**
 * Whether a `def` is a class/singleton method: `def self.x` (a `singleton_method` node)
 * or a `def x` nested inside a `class << self` block. Both belong to the class's
 * singleton and are distinct from an instance method of the same name — so they must
 * get distinct ids (see `rubyMethodId`).
 */
export function isSingletonDef(def: TsNode): boolean {
  if (def.type === 'singleton_method') return true;
  let cur: TsNode | null = def.parent;
  while (cur) {
    if (cur.type === SINGLETON_CLASS_TYPE) return true;
    if (CLASS_TYPES.has(cur.type)) return false;
    cur = cur.parent;
  }
  return false;
}

/**
 * Canonical id for a Ruby method `def`. Instance methods → `methodId(file, Class, name)`;
 * class/singleton methods → `methodId(file, Class, 'self.'+name)` so an instance method
 * and a class method of the SAME name in the SAME class do not collapse onto one id
 * (which would merge two distinct methods and break the call graph). Used by BOTH the
 * call-graph def index and the db-op performer minting so their ids match for one def.
 *
 * Minted here rather than through the shared `id()`: Ruby has no file-scope function form — a
 * top-level `def` belongs to `Object` — so the "empty chain → functionId" rule the kit encodes
 * would change every top-level method's id.
 */
export function rubyMethodId(idGen: StableIdGenerator, relPath: string, def: TsNode): string {
  const name = defOrClassName(def) ?? '(anonymous)';
  const cls = nearestAncestor(def, CLASS_TYPES);
  // NESTING-QUALIFIED, not the immediate bare name. `Billing::Client#fetch` and
  // `Github::Client#fetch` declared in ONE file hashed to the same id, so the
  // second def was silently dropped by the by-id de-dup and every
  // `Github::Client.fetch` call bound to Billing's method — a wrong edge at full
  // confidence. Tests only missed it because their namespaces sat in separate
  // files, where `relPath` happened to separate the ids.
  const clsName = cls ? (qualifiedClassName(cls) ?? 'Object') : 'Object';
  return idGen.methodId(relPath, clsName, isSingletonDef(def) ? `self.${name}` : name);
}
