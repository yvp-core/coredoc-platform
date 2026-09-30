/**
 * Small CST / route / callee-expression free helpers.
 */
import type { Node as TsNode } from 'web-tree-sitter';
import type { RouteRule } from '../../types.js';
import { text } from './ts-text.js';

/** Route-rule scope: `inPaths` startsWith OR `inPathContains` substring (mirrors ts-morph). */
export function routeFileInScope(file: string, rule: RouteRule): boolean {
  const pathHit = rule.inPaths?.some((p) => file.startsWith(p)) ?? false;
  const containsHit = rule.inPathContains?.some((s) => file.includes(s)) ?? false;
  if (!rule.inPaths && !rule.inPathContains) return true;
  if (rule.inPaths) return pathHit || containsHit;
  return containsHit;
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
