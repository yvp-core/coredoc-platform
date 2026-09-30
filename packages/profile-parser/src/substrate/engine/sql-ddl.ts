/**
 * Generic plain-SQL `CREATE TABLE` DDL parsing — a plain text parse over any `.sql` source, no
 * per-language AST involved. Shared on purpose: Rust's entity extractor (`rust-entities.ts`,
 * migration globs) is today's consumer; the Zig substrate's db-op lane (`zig-dbops.ts`, inline SQL
 * strings) is the next one. Keep this module free of language-specific coupling (no `RustFile`,
 * no tree-sitter node types) so both can call it on a bare `sql: string`.
 */
import type { EntityField, EntityRelation } from '@coredoc/core';
import { singularize } from './text-helpers.js';

/** `users` → `User`; `user_profiles` → `UserProfile`. */
export function entityNameFromTable(table: string): string {
  return singularize(table)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export function makeField(
  name: string,
  type: string,
  opts: { nullable?: boolean; primaryKey?: boolean; unique?: boolean } = {},
): EntityField {
  return {
    name,
    columnName: name,
    type: { text: type },
    dbType: type,
    isPrimaryKey: opts.primaryKey ?? false,
    isNullable: opts.nullable ?? false,
    isUnique: opts.unique ?? false,
    isGenerated: false,
  };
}

/**
 * `name type` at the head of a column definition. The type is the first token plus an optional
 * `(...)` group (`varchar(255)`, `numeric(10, 2)`), and at most ONE further word so multi-word
 * types survive (`double precision`) — but never a CONSTRAINT keyword, which is what made
 * `id integer primary key` report `dbType: 'integer primary'`.
 */
const COLUMN_RE =
  /^["`']?(\w+)["`']?\s+(\w+(?:\s*\([^)]*\))?(?:\s+(?!(?:primary|not|null|references|unique|default|check|constraint|collate|generated|auto_increment|autoincrement)\b)\w+)?)/i;

/**
 * Quote-state step for the two structural scans below. A SQL literal may hold `(`, `)` and `,`
 * (`default ')'`, `check (y in ('a,b'))`), so a scan that does not track quoting ends the
 * column list at the wrong paren or splits one column into two. `''` inside a `'…'` literal
 * reads as close-then-open, which lands on the same state.
 */
function nextQuote(quote: string, ch: string): string {
  if (quote) return ch === quote ? '' : quote;
  return ch === "'" || ch === '"' || ch === '`' ? ch : '';
}

/** Split a `CREATE TABLE (...)` column list on top-level commas (parens/quotes aware). */
export function splitColumns(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of body) {
    const wasQuoted = quote !== '';
    quote = nextQuote(quote, ch);
    if (!wasQuoted && quote === '') {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** One `CREATE TABLE` parsed out of a `.sql` source, before a caller mints ids around it. */
export interface SqlTableDraft {
  tableName: string;
  fields: EntityField[];
  /** From inline `references` on a column and table-level `foreign key (...) references ...`. */
  relations: EntityRelation[];
  /** Offset of the `create table` match start, for line/checksum computation by the caller. */
  matchIndex: number;
  /** Offset just past the column list's closing paren. */
  endIndex: number;
}

/** Parse every `CREATE TABLE` in a SQL source into a draft. Tables with no columns are skipped. */
export function parseCreateTables(sql: string): SqlTableDraft[] {
  const drafts: SqlTableDraft[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`']?([\w.]+)["`']?\s*\(/gi;
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    // Scan forward to the matching close paren of the column list, quoting aware.
    let depth = 1;
    let quote = '';
    let i = m.index + m[0].length;
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      const wasQuoted = quote !== '';
      quote = nextQuote(quote, ch);
      if (wasQuoted || quote !== '') continue;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const body = sql.slice(m.index + m[0].length, i - 1);
    const tableName = (m[1].split('.').pop() as string).toLowerCase();
    const fields: EntityField[] = [];
    const relations: EntityRelation[] = [];
    const pkFromConstraint = new Set<string>();

    for (const raw of splitColumns(body)) {
      const line = raw.trim();
      if (!line) continue;
      const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(line);
      if (pk) {
        for (const c of pk[1].split(',')) pkFromConstraint.add(c.trim().replace(/["`']/g, ''));
        continue;
      }
      const fk =
        /^(?:constraint\s+\w+\s+)?foreign\s+key\s*\(\s*["`']?(\w+)["`']?\s*\)\s*references\s+["`']?(\w+)/i.exec(line);
      if (fk) {
        relations.push({ name: fk[1], type: 'many-to-one', targetEntityName: fk[2].toLowerCase() });
        continue;
      }
      if (/^(unique|check|constraint|primary|foreign|exclude)\b/i.test(line)) continue;
      const col = COLUMN_RE.exec(line);
      if (!col) continue;
      const name = col[1];
      const inlineRef = /references\s+["`']?(\w+)/i.exec(line);
      if (inlineRef) {
        relations.push({ name, type: 'many-to-one', targetEntityName: inlineRef[1].toLowerCase() });
      }
      fields.push(
        makeField(name, col[2].trim(), {
          nullable: !/\bnot\s+null\b/i.test(line) && !/\bprimary\s+key\b/i.test(line),
          primaryKey: /\bprimary\s+key\b/i.test(line),
          unique: /\bunique\b/i.test(line),
        }),
      );
    }
    for (const f of fields) if (pkFromConstraint.has(f.name)) f.isPrimaryKey = true;

    if (fields.length > 0) {
      drafts.push({
        tableName,
        fields,
        relations,
        matchIndex: m.index,
        endIndex: i,
      });
    }
    re.lastIndex = i;
    m = re.exec(sql);
  }
  return drafts;
}
