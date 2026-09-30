/**
 * Parser-duplicate collapsing — the single source of truth for "which kind wins"
 * when the substrate emits ONE source-level declaration under multiple node kinds.
 *
 * The parser emits the same `(name, file, start_line)` under several kinds when a
 * declaration has more than one nature:
 *   - React functional component → `function` + `component` (every FC)
 *   - React class component      → `class` + `component`
 *   - TypeORM/MikroORM entity     → `class` + `entity` (every @Entity)
 *
 * Returned verbatim those are duplicate rows that inflate result/pagination
 * counts and burn tokens. Both `explain` and `search_symbols` collapse them to a
 * single winner. They MUST agree on the winner, or the same declaration resolves
 * to a different `type` depending on which tool you asked — so the precedence and
 * the bucketing live here, imported by both, rather than mirrored in each file.
 */
import type { CodeElementType } from './types.js';

/**
 * Winner precedence (lower wins): class > function > interface > type_alias >
 * enum > entity > component > route > variable. The class node carries methods +
 * inheritance; the function node carries callees + side effects; component/entity
 * are conceptual siblings that add no reachable info beyond the richer node.
 * Editing this changes BOTH explain and search_symbols.
 */
const KIND_PRECEDENCE: Record<string, number> = {
  class: 0,
  function: 1,
  interface: 2,
  type_alias: 3,
  enum: 4,
  entity: 5,
  component: 6,
  route: 7,
  variable: 8,
};

/** Minimal row shape needed to bucket + rank: a kind plus a stable location. */
interface KindedRow {
  name: string;
  filePath: string;
  startLine: number;
  type: string;
}

/**
 * Group rows that share `name|filePath|startLine` and collapse each group to its
 * precedence winner, reporting every collapsed kind in precedence order. `kinds`
 * has length > 1 only for a genuine multi-kind declaration; an ordinary symbol
 * comes back as a one-element group with `kinds: [type]`. Distinct symbols that
 * merely share a name are NOT merged (different file or line → different bucket).
 *
 * Generic over the row type so the db `CodeElement` path (`explain`) and the mcp
 * `CodeElementInfo` path (`search_symbols`) share one winner-selection rule.
 */
export function dedupeByKinds<T extends KindedRow>(rows: T[]): Array<{ element: T; kinds: CodeElementType[] }> {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.name}|${r.filePath}|${r.startLine}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }
  const merged: Array<{ element: T; kinds: CodeElementType[] }> = [];
  for (const arr of buckets.values()) {
    // Sort by precedence so the winner is first and `kinds` reads in a stable
    // order. Ties shouldn't happen (each kind appears at most once per location)
    // but if they do we keep the first.
    const sorted = [...arr].sort((a, b) => (KIND_PRECEDENCE[a.type] ?? 99) - (KIND_PRECEDENCE[b.type] ?? 99));
    merged.push({ element: sorted[0]!, kinds: sorted.map((r) => r.type as CodeElementType) });
  }
  return merged;
}
