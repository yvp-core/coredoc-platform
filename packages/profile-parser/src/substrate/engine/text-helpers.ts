/**
 * String / decorator / argument / SQL-Cypher free helpers.
 */
import type { DbOperationType } from '@coredoc/core/types';
import type { ArgNode } from '../interface.js';

export function decoName(dec: string): string {
  const m = /^([A-Za-z0-9_$]+)/.exec(dec.trim());
  return m ? m[1] : '';
}

/** Raw query text from an arg: a string/template literal (raw text) or a `{ sql: '…' }` object. */
export function queryText(arg: ArgNode | undefined): string | undefined {
  if (!arg) return undefined;
  const sqlEntry = arg.objectEntries?.find((e) => e.key === 'sql');
  const raw = (sqlEntry ? sqlEntry.valueText : arg.text)?.trim();
  if (!raw) return undefined;
  const m = /^(['"`])([\s\S]*)\1$/.exec(raw); // strip surrounding quotes/backticks (template literals)
  return m ? m[2] : raw;
}

/**
 * Strip leading whitespace, `;`, `--` line comments and block comments from a statement.
 *
 * Every verb match below is anchored at `^`, so a statement that opens with a comment — which is
 * the norm in a hand-written query file and inside a CTE body — parses as nothing at all.
 */
function stripSqlLeadingTrivia(sql: string): string {
  let s = sql;
  for (;;) {
    const next = s.replace(/^[\s;]+/, '');
    if (next.startsWith('--')) {
      const nl = next.indexOf('\n');
      if (nl === -1) return '';
      s = next.slice(nl + 1);
      continue;
    }
    if (next.startsWith('/*')) {
      const end = next.indexOf('*/', 2);
      if (end === -1) return '';
      s = next.slice(end + 2);
      continue;
    }
    return next;
  }
}

/**
 * Split a leading `WITH` clause into its CTE names, their bodies, and the main statement.
 *
 * A CTE query's top-level verb sits AFTER the `WITH` list, so without this the whole statement
 * reads as unparseable and the db-op is dropped. Returns undefined when the text does not start
 * with `WITH` or the clause is malformed — the caller then treats it as an ordinary statement.
 *
 * Scanning is character-wise rather than regex-based because a CTE body routinely contains
 * parentheses, `--` comments and quoted strings (`status IN ('completed','failed')`), any of
 * which defeats a paren-counting regex. Handles `RECURSIVE`, a column list
 * (`name (a, b) AS (…)`) and the `[NOT] MATERIALIZED` hint Postgres allows between `AS` and `(`.
 */
function splitCteClause(sql: string): { cteNames: Set<string>; bodies: string[]; main: string } | undefined {
  if (!/^with\b/i.test(sql)) return undefined;
  const cteNames = new Set<string>();
  const bodies: string[] = [];
  let i = 4; // past 'with'

  /** Advance past whitespace, `--` line comments and `/* *\/` block comments. */
  const skipTrivia = (): void => {
    for (;;) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql.startsWith('--', i)) {
        const nl = sql.indexOf('\n', i);
        if (nl === -1) {
          i = sql.length;
          return;
        }
        i = nl + 1;
        continue;
      }
      if (sql.startsWith('/*', i)) {
        const end = sql.indexOf('*/', i + 2);
        i = end === -1 ? sql.length : end + 2;
        continue;
      }
      return;
    }
  };

  skipTrivia();
  if (/^recursive\b/i.test(sql.slice(i))) {
    i += 9;
    skipTrivia();
  }

  for (;;) {
    // CTE name — bare or double-quoted.
    const nameMatch = /^(?:"([^"]+)"|(\w+))/.exec(sql.slice(i));
    if (!nameMatch) return undefined;
    cteNames.add((nameMatch[1] ?? nameMatch[2]).toLowerCase());
    i += nameMatch[0].length;
    skipTrivia();

    // Optional column list, then AS, then an optional materialization hint.
    if (sql[i] === '(') {
      const close = matchParen(sql, i);
      if (close === -1) return undefined;
      i = close + 1;
      skipTrivia();
    }
    if (!/^as\b/i.test(sql.slice(i))) return undefined;
    i += 2;
    skipTrivia();
    const hint = /^(?:not\s+)?materialized\b/i.exec(sql.slice(i));
    if (hint) {
      i += hint[0].length;
      skipTrivia();
    }

    if (sql[i] !== '(') return undefined;
    const close = matchParen(sql, i);
    if (close === -1) return undefined;
    bodies.push(sql.slice(i + 1, close));
    i = close + 1;
    skipTrivia();

    if (sql[i] === ',') {
      i++;
      skipTrivia();
      continue;
    }
    break;
  }

  const main = sql.slice(i).trim();
  return main ? { cteNames, bodies, main } : undefined;
}

/**
 * Index of the `)` closing the `(` at `open`, skipping quoted strings and comments.
 * Returns -1 when unbalanced.
 */
function matchParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote inside the literal, not its end.
          if (sql[i + 1] === quote) i++;
          else break;
        }
        i++;
      }
      continue;
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * A parsed SQL statement: the verb's operation, plus the relation it touches WHEN that
 * relation is statically readable. `entity` is absent for a statement whose target is a
 * function call (`FROM unnest($1)`), a subquery, or an interpolation the caller could not
 * fold (`FROM ${table}` / `FROM {table}`) — the op is real, the target is not knowable.
 */
export type SqlStatement = { op: DbOperationType; entity?: string };

/**
 * Bare or quoted SQL identifier. Postgres uses `"…"`, MySQL/ClickHouse backticks; a
 * single-quoted table name is not legal SQL but appears in hand-built statements.
 */
const SQL_IDENT = '(?:"([^"]+)"|`([^`]+)`|\'([^\']+)\'|([A-Za-z_][A-Za-z0-9_$]*))';
const TABLE_REF_RE = new RegExp(`^\\s*(?:${SQL_IDENT}\\s*\\.\\s*)?${SQL_IDENT}`);

/**
 * Bare words that follow a table-position keyword without BEING a table. `FROM table`
 * and `FROM select` come from templated SQL and hand-built fragments; `ONLY`/`LATERAL`
 * are Postgres modifiers. Quoted identifiers are exempt — `FROM "table"` really is a
 * table called `table`.
 */
const NON_TABLE_WORDS = new Set(['table', 'select', 'values', 'lateral', 'only', 'unnest']);

/**
 * Read the relation reference at the start of `rest`, preserving a schema qualifier:
 * `auth.users` → `auth.users` (never collapsed to the schema, which is what capturing the
 * first identifier after FROM used to do). Returns undefined when the position holds a
 * function call (`unnest(...)`, `generate_series(...)`), a subquery, an interpolation, or
 * one of the non-table keywords above.
 */
function readTableRef(rest: string, callsAreNotTables: boolean): string | undefined {
  const m = TABLE_REF_RE.exec(rest);
  if (!m) return undefined;
  const qualifier = m[1] ?? m[2] ?? m[3] ?? m[4];
  const name = m[5] ?? m[6] ?? m[7] ?? m[8];
  if (!name) return undefined;
  // In FROM position a `(` right after the reference means a function call, not a relation.
  // Everywhere else the parens are a column list (`INSERT INTO t (a, b)`, `CREATE TABLE t (…)`).
  if (callsAreNotTables && /^\s*\(/.test(rest.slice(m[0].length))) return undefined;
  const bare = m[8] !== undefined; // final part was unquoted
  if (bare && !qualifier && NON_TABLE_WORDS.has(name.toLowerCase())) return undefined;
  return qualifier ? `${qualifier}.${name}` : name;
}

/**
 * DDL statements over a RELATION (table / view / materialized view). DDL over other object
 * kinds (function, index, policy, type, extension, database, role) is deliberately NOT
 * matched: its target is not a relation, so emitting it would put a function name in the
 * `entityName` slot where every consumer expects a table.
 */
const DDL_RE =
  /^(?:(create)(?:\s+or\s+replace)?(?:\s+(?:temp|temporary|unlogged|global|local))?(?:\s+materialized)?\s+(?:table|view)(?:\s+if\s+not\s+exists)?|(drop)(?:\s+materialized)?\s+(?:table|view)(?:\s+if\s+exists)?|(alter)\s+table(?:\s+if\s+exists)?(?:\s+only)?|(truncate)(?:\s+table)?(?:\s+if\s+exists)?)\s+/i;

/**
 * Parse a SQL statement's leading verb → operation + the relation it touches (when readable).
 * `parseSqlOp` is the strict variant used where an op without a table is worthless.
 */
export function parseSqlStatement(sql: string): SqlStatement | undefined {
  const s = stripSqlLeadingTrivia(sql);

  // A `WITH` clause hides the real verb behind the CTE list, so unwrap it first. The op comes
  // from the MAIN statement (the top-level intent), but its table may be a CTE ALIAS — reporting
  // `recent` from `WITH recent AS (SELECT … FROM activity_log) SELECT … FROM recent` would invent
  // a table that does not exist, which is worse than the dropped op this replaces. So an alias
  // resolves to the first REAL table its bodies touch.
  const cte = splitCteClause(s);
  if (cte) {
    const mainOp = parseSqlStatement(cte.main);
    if (!mainOp) return undefined;
    if (!mainOp.entity || !cte.cteNames.has(mainOp.entity.toLowerCase())) return mainOp;
    for (const body of cte.bodies) {
      const inner = parseSqlStatement(body);
      if (inner?.entity && !cte.cteNames.has(inner.entity.toLowerCase()))
        return { op: mainOp.op, entity: inner.entity };
    }
    return { op: mainOp.op };
  }

  const verb = (op: DbOperationType, rest: string, callsAreNotTables = false): SqlStatement => {
    // `FROM ONLY tbl` / `UPDATE ONLY tbl` — the inheritance modifier sits where the table does.
    const entity = readTableRef(rest.replace(/^\s*only\s+/i, ' '), callsAreNotTables);
    return entity ? { op, entity } : { op };
  };

  const mSelect = /^select\b[\s\S]*?\bfrom\b/i.exec(s);
  if (mSelect) return verb('read', s.slice(mSelect[0].length), true);
  const mInsert = /^insert\s+(?:or\s+\w+\s+)?into\b/i.exec(s);
  if (mInsert) return verb('create', s.slice(mInsert[0].length));
  const mReplace = /^replace\s+into\b/i.exec(s);
  if (mReplace) return verb('create', s.slice(mReplace[0].length));
  const mUpdate = /^update\b/i.exec(s);
  if (mUpdate) return verb('update', s.slice(mUpdate[0].length));
  const mDelete = /^delete\s+from\b/i.exec(s);
  if (mDelete) return verb('delete', s.slice(mDelete[0].length));
  const mDdl = DDL_RE.exec(s);
  if (mDdl) return verb('ddl', s.slice(mDdl[0].length));
  return undefined;
}

/**
 * Strict variant: the op AND the table, or nothing. Callers that key an entity off the
 * result (rust sqlx, go query builders, the engine's non-`emitUnresolved` raw-query rules)
 * have no use for an op whose target is unreadable, and emitting one would fabricate a
 * relation. Use `parseSqlStatement` where the caller can mark the target unresolved.
 */
export function parseSqlOp(sql: string): { op: DbOperationType; entity: string } | undefined {
  const parsed = parseSqlStatement(sql);
  return parsed?.entity ? { op: parsed.op, entity: parsed.entity } : undefined;
}

/** Parse a Cypher query's dominant write clause → op + the first node label. */
export function parseCypherOp(cypher: string): { op: DbOperationType; entity: string } | undefined {
  const c = cypher.replace(/^[\s;]+/, '');
  if (/^(show|create\s+(?:vector\s+)?index|drop\b)/i.test(c)) return undefined; // DDL, not a data op
  const labelM = /\(\s*\w*\s*:\s*(\w+)/.exec(c);
  const entity = labelM ? labelM[1] : 'node';
  let op: DbOperationType;
  if (/\bdetach\s+delete\b|\bdelete\b/i.test(c)) op = 'delete';
  else if (/\bmerge\b/i.test(c) || /\bcreate\s*\(/i.test(c)) op = 'create';
  else if (/\bset\b/i.test(c)) op = 'update';
  else op = 'read';
  return { op, entity };
}

/** Extract a string-valued object-literal property from raw decorator/call text: `name: 'x'` → "x". */
export function objectPropFromText(text: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(text);
  return m ? m[2] : undefined;
}

export function firstStringArg(dec: string): string | undefined {
  const open = dec.indexOf('(');
  if (open < 0) return undefined;
  const inner = dec.slice(open + 1, dec.lastIndexOf(')'));
  const m = /^\s*['"`]([^'"`]*)['"`]/.exec(inner);
  return m ? m[1] : undefined;
}

/**
 * Positional string-literal args of a decorator/call text, in source order:
 * `@GrpcMethod('HeroesService', 'FindOne')` → ['HeroesService', 'FindOne']. Object
 * and expression args contribute nothing, so an ArgRef `arg` index maps to the Nth
 * string literal — sufficient for the simple `(string, string)` decorator
 * signatures this reads (gRPC service/method).
 */
export function decoStringArgs(dec: string): string[] {
  const open = dec.indexOf('(');
  if (open < 0) return [];
  const inner = dec.slice(open + 1, dec.lastIndexOf(')'));
  const out: string[] = [];
  const re = /['"`]([^'"`]*)['"`]/g;
  for (let m = re.exec(inner); m !== null; m = re.exec(inner)) out.push(m[1]);
  return out;
}

/**
 * Extract the enum member reference from a wrapped decorator arg.
 * Handles `@EventPattern(topicFor(Topics.EntityUpdatedV1))` →
 * returns "Topics.EntityUpdatedV1" as the stable cross-repo topic key.
 * Returns undefined when no wrapper call matches or the inner arg is not a member expression.
 */
export function firstWrappedMemberArg(dec: string, unwrapCalls: string[]): string | undefined {
  for (const fn of unwrapCalls) {
    const re = new RegExp(`\\b${fn}\\(([A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*)\\)`);
    const m = re.exec(dec);
    if (m) return m[1];
  }
  return undefined;
}

export function optionString(dec: string, key: string): string | undefined {
  const re = new RegExp(`${key}:\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = re.exec(dec);
  return m ? m[1] : undefined;
}

/**
 * Read a decorator option whose value is a bare identifier rather than a string
 * literal — e.g. `@Property({ type: JsonType })` / `type: UuidType`. The leading
 * `\b` keeps `type:` from matching inside `columnType:`. Returns undefined for
 * quoted values (use optionString for those).
 */
export function optionIdentifier(dec: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}:\\s*([A-Za-z_$][A-Za-z0-9_$]*)`);
  const m = re.exec(dec);
  return m ? m[1] : undefined;
}

/**
 * Resolve a decorator entity field's DB type. The TS property annotation is the
 * source of truth when it carries real information; when it's missing or
 * `unknown` (MikroORM infers from the decorator, e.g. `@Property({ type: 'int' })
 * retryNumber = 0`), fall back to the decorator's type/columnType option so the
 * column isn't reported as `unknown`. `typeOption` defaults to the standard
 * MikroORM/TypeORM keys; `dataTypeMap` optionally normalizes the raw token.
 */
export function resolveDecoratorFieldType(
  fieldDec: string,
  propType: string | undefined,
  typeOption: string[],
  dataTypeMap?: Record<string, string>,
): { dbType?: string; typeText: string } {
  if (propType && !propType.includes('unknown')) return { typeText: propType };
  let raw: string | undefined;
  for (const key of typeOption) {
    raw = optionString(fieldDec, key) ?? optionIdentifier(fieldDec, key);
    if (raw) break;
  }
  const dbType = raw ? (dataTypeMap?.[raw] ?? raw) : undefined;
  return { dbType, typeText: dbType ?? propType ?? 'unknown' };
}

export function arrowTarget(dec: string): string | undefined {
  const m = /=>\s*([A-Za-z0-9_$]+)/.exec(dec);
  return m ? m[1] : undefined;
}

export function objectEntryString(arg: ArgNode | undefined, key: string): string | undefined {
  if (!arg?.objectEntries) return undefined;
  const e = arg.objectEntries.find((x) => x.key === key);
  if (!e) return undefined;
  const m = /^['"`]([^'"`]*)['"`]$/.exec(e.valueText.trim());
  return m ? m[1] : undefined;
}

export function boolEntry(entries: NonNullable<ArgNode['objectEntries']>, key: string): boolean {
  return entries.find((e) => e.key === key)?.valueText.trim() === 'true';
}

export function boolEntryOpt(entries: NonNullable<ArgNode['objectEntries']>, key: string): boolean | undefined {
  const e = entries.find((x) => x.key === key);
  if (!e) return undefined;
  const t = e.valueText.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return undefined;
}

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function singularize(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  // `-es` after a sibilant is the plural suffix in full: `idb_indexes` -> `idb_index`,
  // `boxes` -> `box`, `matches` -> `match`, `classes` -> `class`. Without this the bare `-s`
  // rule leaves the trailing `e`.
  // ponytail: `-uses` and a bare `-ses` are deliberately NOT here — both are ambiguous
  // (`warehouses` -> `warehouse` and `clauses` -> `clause` are far more common table names than
  // `statuses` -> `status`), so the `-s` rule takes them and `statuses` -> `statuse` is the
  // known miss. Upgrade path is a real inflector with an exception list.
  if (/(?:x|z|ch|sh|ss)es$/i.test(name)) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

export function receiverPatternMatches(receiver: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return receiver.endsWith(pattern.slice(1));
  return receiver === pattern;
}
