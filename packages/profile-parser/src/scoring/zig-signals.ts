// =============================================================================
// Zig source signals for the coverage scorer (BR-17).
//
// The entity denominator and the entity numerator must share ONE definition of "SQL", or the
// scorecard measures a different repo than the parser extracted. So `entities` is not a grep: it
// runs the SAME `parseCreateTables` helper the `zig-dbops` lane runs, over the same text the
// parser can see — `test` blocks removed (a `test` block is a caller for nothing) and `\\`
// multiline fragments dedented (the parser reads them through `sqlText`). `cli` and
// `externalCalls` stay text-level counts, because `pub fn main` and `std.http.Client` are exactly
// the observables their lanes gate on.
//
// `dbOperations` is deliberately OMITTED and disclosed through `dbOperationsNote` instead (the
// go-signals precedent): the only thing a text scan can count is DISTINCT OPERATED TABLES, while
// the numerator is OP ROWS — several statements per table, plus the formatted-one-hop idiom a
// scan cannot see. Those two units are not commensurable, so a ratio built from them is a
// fabricated number; omitting the signal makes the row SELF-RELATIVE and says why on the row.
//
// `http` and `queue` are 0 on purpose: Zig has no declarative route or queue surface in this
// slice (LIM-C), so those rows score `not_applicable` instead of a false FAIL.
// =============================================================================
import { readFileSync } from 'node:fs';
import { parseCreateTables } from '../substrate/engine/sql-ddl.js';
import { absoluteSourceFiles } from './explicit-source-files.js';
import type { ScoreContext, SourceSignals } from './score-core.js';

/** The entrypoint observable (BR-13): `pub fn maintenance` must NOT match. */
const PUB_MAIN_RE = /\bpub fn main\s*\(/g;
/** The egress observable (BR-14/LIM-D): the only client this substrate recognises. */
const HTTP_CLIENT = 'std.http.Client';

/** Basis disclosure for the `dbOperations` row, which has no commensurable denominator. */
const DB_OPERATIONS_NOTE = 'operated-table count is not commensurable with op rows; db-ops score self-relative';

/** Everything before an unquoted `//`. */
function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString && ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/**
 * Net brace depth of one line, with braces inside a `"…"` literal ignored — a `test` block
 * containing `"}"` in a string would otherwise end at that string and leak the rest of the
 * block into the scored text. Same in-string scan as `stripLineComment`; Zig has no block
 * comment and no multi-line `"…"`, so one line is a complete string context.
 */
function braceDelta(line: string): number {
  let delta = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString && ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

/**
 * One file's source with `test` blocks removed, `//` comments stripped and `\\` multiline
 * fragments dedented — the text the parser can actually see.
 *
 * ponytail: brace scanner, not a parser — strings with unbalanced braces can skew the
 * denominator. Upgrade path is the tree-sitter walk, which costs a parse per scored file.
 */
function readableText(source: string): string {
  const kept: string[] = [];
  let depth = 0;
  let skipping = false;

  for (const raw of source.split('\n')) {
    const trimmed = raw.trimStart();
    const isFragment = trimmed.startsWith('\\\\');
    // A `\\` line runs to end of line as STRING: it carries no code, no comment and no brace.
    const code = isFragment ? '' : stripLineComment(raw);
    if (!skipping && depth === 0 && /^test\b/.test(code.trimStart())) skipping = true;

    if (!skipping) kept.push(isFragment ? trimmed.slice(2) : code);

    depth += braceDelta(code);
    if (skipping && depth <= 0) {
      skipping = false;
      depth = 0;
    }
  }
  return kept.join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** Zig source-signal denominators, read off the provider's own source set (BR-17). */
export function zigSourceSignals(ctx: ScoreContext): SourceSignals {
  let cli = 0;
  let externalCalls = 0;
  const tables = new Set<string>();

  for (const file of absoluteSourceFiles(ctx.repoRoot, ctx.sourceFiles)) {
    let source: string;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      continue; // an unreadable file is a skipped file for the parser too (BR-8)
    }
    const text = readableText(source);

    cli += text.match(PUB_MAIN_RE)?.length ?? 0;
    externalCalls += countOccurrences(text, HTTP_CLIENT);
    for (const draft of parseCreateTables(text)) tables.add(draft.tableName);
  }

  return {
    http: 0,
    queue: 0,
    entities: tables.size,
    dbOperationsNote: DB_OPERATIONS_NOTE,
    externalCalls,
    cli,
  };
}
