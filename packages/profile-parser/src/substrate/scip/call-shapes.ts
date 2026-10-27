/**
 * Small CST / route / callee-expression free helpers.
 */
import type { Node as TsNode } from 'web-tree-sitter';
import type { RouteRule } from '../../types.js';
import { text, unquote } from './ts-text.js';

/** Route-rule scope: `inPaths` startsWith OR `inPathContains` substring (mirrors ts-morph). */
export function routeFileInScope(file: string, rule: RouteRule): boolean {
  const pathHit = rule.inPaths?.some((p) => file.startsWith(p)) ?? false;
  const containsHit = rule.inPathContains?.some((s) => file.includes(s)) ?? false;
  if (!rule.inPaths && !rule.inPathContains) return true;
  if (rule.inPaths) return pathHit || containsHit;
  return containsHit;
}

/**
 * `routes.joinNestedPaths`: join a relative route path (`''` for an index route) onto
 * the paths of the parent routes enclosing offset `idx` — `<Route path>` elements whose
 * children hold it, or config objects whose `children:` array does. Stops at the first
 * absolute parent; an index route with no parent path is `/`.
 */
export function nestedRoutePath(root: TsNode, idx: number, path: string): string {
  if (path.startsWith('/') || path.startsWith('[base]')) return path;
  let joined = path;
  let prev = root.descendantForIndex(idx);
  for (let n = prev?.parent ?? null; n && prev; prev = n, n = n.parent) {
    const base = parentRoutePath(n, prev)?.replace(/\/?\*$/, '');
    if (!base) continue;
    joined = joined ? `${base.replace(/\/$/, '')}/${joined}` : base;
    if (base.startsWith('/')) break;
  }
  return joined || '/';
}

/** The string `path` of `n` when `n` is a parent route reached from its child `prev`. */
function parentRoutePath(n: TsNode, prev: TsNode): string | undefined {
  let pathValue: TsNode | null | undefined;
  if (n.type === 'jsx_element') {
    const open = n.namedChildren.find((c) => c.type === 'jsx_opening_element');
    // Reached through its own opening tag: this is the route itself, not a parent.
    if (!open || open.id === prev.id || text(open.childForFieldName('name')) !== 'Route') return undefined;
    const attr = open.namedChildren.find((c) => c.type === 'jsx_attribute' && text(c.namedChildren[0]) === 'path');
    pathValue = attr?.namedChildren[1];
  } else if (n.type === 'object' && prev.type === 'pair' && pairKey(prev) === 'children') {
    pathValue = n.namedChildren.find((c) => c.type === 'pair' && pairKey(c) === 'path')?.childForFieldName('value');
  }
  return pathValue?.type === 'string' ? unquote(text(pathValue)) : undefined;
}

function pairKey(pair: TsNode): string {
  return text(pair.childForFieldName('key')).replace(/['"]/g, '');
}

/** 1-based line number of a character offset in `text`. */
export function lineAt(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Callee name of a `call_expression`, generics stripped (`create<T>` → `create`). */
export function calleeName(call: TsNode): string {
  const fn = call.childForFieldName('function');
  return text(fn)
    .replace(/<[^>]*>\s*$/, '')
    .trim();
}

/**
 * Tail identifier of a callee expression for the precision gate. Handles both a JS
 * call expression (`a.b.foo(...)` → `foo`) and a scip-typescript moniker whose tail
 * descriptor is the called name (`… Foo#bar().` → `bar`). Returns undefined when no
 * identifier can be extracted (the gate then leaves the edge untouched).
 */
export function calleeTail(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const m = expr.match(/([A-Za-z_$][\w$]*)\s*(?:\(\)?)?[.#]?\s*$/);
  return m?.[1];
}
