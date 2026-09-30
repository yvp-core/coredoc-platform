/**
 * Tiny tree-sitter node text helpers, shared by tree-sitter-scip.ts and the
 * call-shape free helpers.
 */
import type { Node as TsNode } from 'web-tree-sitter';

export function text(n: TsNode | null | undefined): string {
  return n?.text ?? '';
}

export function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}
