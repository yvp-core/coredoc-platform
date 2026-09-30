/**
 * Grammar-agnostic CST walk primitives, shared by every bespoke substrate.
 *
 * These are parameterised by node-type sets only: nothing here knows or asks which grammar
 * produced the node, so a fix to a walk lands once for every substrate that uses it. A grammar
 * quirk that cannot be expressed as a node-type set stays in the owning substrate's own file.
 *
 * Every accessor tolerates an absent node: a CST shape that lacks an intermediate child is a
 * normal outcome on real source, not a programming error, and the caller decides what a miss means.
 */
import type { TsNode } from '../../tree-sitter/tree-sitter-loader.js';

/** Nearest ancestor of `node` whose type is in `types`. */
export function nearestAncestor(node: TsNode, types: ReadonlySet<string>): TsNode | undefined {
  let cur: TsNode | null = node?.parent ?? null;
  while (cur) {
    if (types.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** All direct named children of `node`, in source order (NOT descendants — nesting is meaningful). */
export function namedChildren(node: TsNode | undefined): TsNode[] {
  const out: TsNode[] = [];
  const n = node?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = node.namedChild(i) as TsNode | undefined;
    if (child) out.push(child);
  }
  return out;
}

/** Direct named children of `node` with the given type, in source order. */
export function namedChildrenOfType(node: TsNode | undefined, type: string): TsNode[] {
  const out: TsNode[] = [];
  const n = node?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = node.namedChild(i) as TsNode | undefined;
    if (child?.type === type) out.push(child);
  }
  return out;
}

/** The first direct named child with the given type. */
export function firstChildOfType(node: TsNode | undefined, type: string): TsNode | undefined {
  const n = node?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = node.namedChild(i) as TsNode | undefined;
    if (child?.type === type) return child;
  }
  return undefined;
}

/**
 * `nearestAncestor` curried on one type set — the shape every "enclosing X" accessor wants
 * (enclosing function, enclosing type container, enclosing scope).
 */
export const makeEnclosingWalker =
  (types: ReadonlySet<string>) =>
  (node: TsNode): TsNode | undefined =>
    nearestAncestor(node, types);
