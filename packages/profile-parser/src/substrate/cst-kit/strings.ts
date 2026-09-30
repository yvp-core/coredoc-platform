/**
 * The one string-literal reader every bespoke substrate parameterises, instead of rediscovering
 * the same CST traps grammar by grammar.
 *
 * Two traps this exists for, each found twice independently before it did:
 *   1. Some grammar builds expose NO content child at all — the literal's `.text` keeps its
 *      delimiters, so reading `string_content` silently yields `''` for every literal in the
 *      language. That is why `unquote` is the fallback and not an afterthought.
 *   2. In the grammars that DO expose a content child, escapes and interpolations are SIBLINGS of
 *      it, so the first content child is only a prefix of the value.
 *
 * Parameterised by node-type sets, predicates and one unquoting function only: nothing here knows
 * which grammar produced the node. A quirk that cannot be expressed as one of these fields stays
 * in the owning substrate's file, as a wrapper around the reader.
 */
import type { TsNode } from '../../tree-sitter/tree-sitter-loader.js';
import { namedChildren } from './walk.js';

export interface StringValueSpec {
  /** Node types this reader accepts; omit to accept any node the caller has already vetted. */
  stringNodeTypes?: ReadonlySet<string>;
  /** Child types whose own text IS (part of) the value, typically `string_content`. */
  contentChildTypes: ReadonlySet<string>;
  /**
   * `'first'` (default) takes the first content child alone — right when escapes and
   * interpolations must NOT be folded into the value. `'all'` concatenates every content and
   * rendered part in source order, which is what a template reader wants.
   */
  contentParts?: 'first' | 'all';
  /**
   * Non-content children rendered into the value instead of being skipped, e.g. an interpolation
   * rendered as `{expr}` so a path template keeps the segment. Implies `contentParts: 'all'`.
   */
  renderChild?: ReadonlyMap<string, (node: TsNode) => string>;
  /**
   * True when the content children may be trusted for this node. A grammar that puts escapes
   * beside the content child answers "no escape child is present here".
   */
  preferContentChildren?: (node: TsNode) => boolean;
  /** This grammar's whole quoting/prefix/escape rule, applied to `.text` when no content part was read. */
  unquote?: (text: string) => string | undefined;
  /** Value for an accepted node with no content part — a literal that is genuinely empty. */
  emptyValue?: string;
}

/** A reader for one grammar's string literals: node in, the literal's value out. */
export function makeStringValueReader(spec: StringValueSpec): (node?: TsNode | null) => string | undefined {
  const all = spec.contentParts === 'all' || spec.renderChild !== undefined;
  return (node) => {
    if (!node) return undefined;
    if (spec.stringNodeTypes && !spec.stringNodeTypes.has(node.type)) return undefined;
    if (!spec.preferContentChildren || spec.preferContentChildren(node)) {
      let out: string | undefined;
      for (const child of namedChildren(node)) {
        const part = spec.contentChildTypes.has(child.type)
          ? (child.text as string)
          : spec.renderChild?.get(child.type)?.(child);
        if (part === undefined) continue;
        out = (out ?? '') + part;
        if (!all) break;
      }
      if (out !== undefined) return out;
    }
    if (spec.emptyValue !== undefined) return spec.emptyValue;
    return spec.unquote?.((node.text ?? '') as string);
  };
}
