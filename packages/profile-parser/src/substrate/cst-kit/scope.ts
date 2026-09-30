/**
 * The enclosing-scope walk, and the canonical declaration id derived from it.
 *
 * Every substrate that mints declaration ids needs the same two things: the names of the scopes a
 * node sits inside, outermost first, and the id rule "file scope → a function id, anything nested
 * → a method id keyed on the joined scope". Keying on the scope is not cosmetic — a flat
 * file+name id merges every same-named declaration in a file onto one graph node, and every call
 * to either then lands on the survivor.
 *
 * Parameterised by a node-type set, a per-node segment function and a separator. A substrate whose
 * id rule is NOT this shape (no file-scope form, or a single nearest container rather than a
 * chain) keeps its own minting and uses `chain` alone, or neither.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { TsNode } from '../../tree-sitter/tree-sitter-loader.js';

export interface ScopeChainSpec {
  /** Node types that introduce a scope. Everything else is walked through. */
  scopeNodeTypes: ReadonlySet<string>;
  /**
   * The segments THIS scope node contributes, outermost-first — usually its one name. A node the
   * grammar left unnamed contributes an empty array: it adds no segment, and the walk continues
   * past it rather than aborting, because its children still have real names.
   */
  segmentsOf(node: TsNode): string[];
  /** How segments join into the scope key (`.`, `::`). */
  separator: string;
}

export interface ScopeChainId {
  /** The enclosing scope segments of `node`, OUTERMOST first, EXCLUDING `node` itself. */
  chain(node: TsNode): string[];
  /**
   * The canonical id of a declaration: `functionId(relPath, name)` when nothing encloses it,
   * `methodId(relPath, scope.join(separator), name)` otherwise. `extraSegments` are appended to
   * the chain — for the segments the declaration itself contributes, such as a receiver type.
   */
  id(
    idGen: StableIdGenerator,
    relPath: string,
    node: TsNode,
    opts?: { name?: string; extraSegments?: string[] },
  ): string;
}

export function makeScopeChainId(spec: ScopeChainSpec): ScopeChainId {
  const chain = (node: TsNode): string[] => {
    const out: string[] = [];
    let cur: TsNode | null = node?.parent ?? null;
    while (cur) {
      if (spec.scopeNodeTypes.has(cur.type)) out.unshift(...spec.segmentsOf(cur));
      cur = cur.parent;
    }
    return out;
  };
  return {
    chain,
    id: (idGen, relPath, node, opts) => {
      const scope = [...chain(node), ...(opts?.extraSegments ?? [])];
      const name = opts?.name ?? '(anonymous)';
      return scope.length === 0
        ? idGen.functionId(relPath, name)
        : idGen.methodId(relPath, scope.join(spec.separator), name);
    },
  };
}
