/**
 * Zig SQL DATA ACCESS (BR-15) — entities from `CREATE TABLE` DDL and db operations from the
 * non-DDL SQL a function executes. Zig has no ORM: every fixture writes raw SQL as a string
 * literal (`"insert into …"`) or a `\\` multiline block, which the declaration walk already
 * collected and dedented into `facts.sqlStrings` (test blocks excluded by construction).
 *
 * Three rules keep this honest:
 *   - A DDL string is an ENTITY only, never an operation: `create table` describes the schema,
 *     it does not read or write a row.
 *   - A SQL-looking string is an operation only when it carries SQL STRUCTURE — `update t SET`,
 *     `insert INTO t`, `select … FROM t` — and not merely a leading verb, because
 *     `run("update available packages")` otherwise invents a table called `available`.
 *   - A SQL-looking string is an operation only when a DB-EXECUTION method is what receives it —
 *     directly, or one hop later through the local a `std.fmt.bufPrint` bound it to:
 *     `std.debug.print("update err: {any}", …)` and `log.err(.cache, "delete from cache", …)`
 *     are log lines, and without this gate they fabricate ops on tables named `err` and `cache`.
 *   - The `CREATE TABLE` parser is the shared `engine/sql-ddl.ts` one Rust uses, so a Zig table
 *     and a Rust migration produce the same fields, relations and entity name.
 *
 * Entities are repo-wide FIRST-WINS per table name (BR-4): the same table declared twice (a
 * schema constant and a migration string) is one entity, keyed on the file that declared it first.
 */
import type { DbOperation, DbOpResolutionStats, EntityNode, StableIdGenerator } from '@coredoc/core';
import type { SourceLocation } from '@coredoc/core/types';
import { type SqlTableDraft, entityNameFromTable, parseCreateTables } from '../engine/sql-ddl.js';
import { parseSqlOp } from '../engine/text-helpers.js';
import { DB_EXEC_METHODS, type ZigFileEntry, type ZigSqlString } from './zig-declarations.js';

export { DB_EXEC_METHODS };

/**
 * SQL STRUCTURE, not just a leading verb. `parseSqlOp` reads `update available packages` as an
 * UPDATE of a table called `available`, and English prose handed to a repo's own execute verb is
 * exactly the shape that fabricates such a table. Every accepted statement must carry the
 * keyword that makes it SQL: `insert into t`, `replace into t`, `update t set`, `delete from t`,
 * `select … from t` (which also covers `with … select … from t`, since the CTE body ends in one).
 */
const SQL_STRUCTURE: RegExp[] = [
  /\binsert\s+(?:or\s+\w+\s+)?into\s+\S/i,
  /\breplace\s+into\s+\S/i,
  /\bupdate\s+\S+\s+set\b/i,
  /\bdelete\s+from\s+\S/i,
  /\bselect\b[\s\S]*?\bfrom\s+\S/i,
];

function hasSqlStructure(text: string): boolean {
  return SQL_STRUCTURE.some((re) => re.test(text));
}

/** `public.users` → `users`. A schema qualifier names the same entity the bare table does. */
function bareTable(table: string): string {
  return table.slice(table.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Whether a DDL literal is a schema declaration rather than a message. A `create table …` handed
 * straight to a method that does not execute SQL (`log.info(…)`, `std.debug.print(…)`) describes
 * nothing; a const-bound literal, a DB-verb argument and a bare literal all still do (BR-15).
 */
function declaresSchema(sql: ZigSqlString, execMethods: ReadonlySet<string>): boolean {
  return !sql.asCallArgument || execMethods.has(sql.calleeMethod ?? '');
}

/**
 * The lines of ONE `create table` inside the literal that carries it. Five tables in one schema
 * constant share the literal's location otherwise, which points every one of them at the same
 * line. `sqlText` dedents but preserves newlines, so a newline count over the draft's offsets is
 * the statement's offset within the literal.
 */
function statementLocation(sql: { text: string; location: SourceLocation }, draft: SqlTableDraft): SourceLocation {
  const newlines = (text: string): number => text.split('\n').length - 1;
  const startLine = sql.location.startLine + newlines(sql.text.slice(0, draft.matchIndex));
  return {
    ...sql.location,
    startLine,
    endLine: startLine + newlines(sql.text.slice(draft.matchIndex, draft.endIndex)),
  };
}

/** `EntityNode`s for every `CREATE TABLE` in a Zig string literal (BR-15). */
export function emitZigEntities(
  files: ReadonlyArray<ZigFileEntry>,
  idGen: StableIdGenerator,
  profileMethods?: string[],
): EntityNode[] {
  const out: EntityNode[] = [];
  const claimed = new Set<string>();
  const execMethods = new Set([...DB_EXEC_METHODS, ...(profileMethods ?? [])]);

  for (const { relPath, facts } of files) {
    for (const sql of facts.sqlStrings) {
      if (!declaresSchema(sql, execMethods)) continue;
      for (const draft of parseCreateTables(sql.text)) {
        if (claimed.has(draft.tableName)) continue;
        claimed.add(draft.tableName);
        const id = idGen.entityId(relPath, draft.tableName);
        out.push({
          id,
          versionedId: idGen.versionedId(id, sql.text),
          name: entityNameFromTable(draft.tableName),
          kind: 'entity',
          location: statementLocation(sql, draft),
          fileId: idGen.fileId(relPath),
          ormType: 'sql',
          tableName: draft.tableName,
          fields: draft.fields,
          relations: draft.relations,
        });
      }
    }
  }
  return out;
}

/**
 * `DbOperation`s for every non-DDL SQL statement passed as a call argument inside an emitted
 * function (BR-15). A statement `parseSqlOp` cannot name a table for is DROPPED — an op with no
 * entity is worthless to every consumer, and guessing one would fabricate a table.
 *
 * `stats` is the BR-4 resolution record. A site is a `facts.sqlStrings` entry a DB verb executes
 * for a known caller: SQL that never reached `facts.sqlStrings` at all, SQL with no caller, and
 * SQL that is not a call argument are UNCOUNTED by construction (LIM-4) — the denominator reads
 * "of the counted sites", never "of the SQL in this repo".
 */
export function emitZigDbOps(
  files: ReadonlyArray<ZigFileEntry>,
  entities: ReadonlyArray<EntityNode>,
  idGen: StableIdGenerator,
  profileMethods?: string[],
): { dbOperations: DbOperation[]; stats: DbOpResolutionStats } {
  const entityIdByTable = new Map(entities.map((e) => [bareTable(e.tableName), e.id]));
  // UNION with the defaults, never replacement (same rule as `rust-signals.ts`): a profile may
  // name its repo's own execution verb, but must not be able to switch the generic ones off and
  // silently shrink the lane below what a bare profile extracts.
  const execMethods = new Set([...DB_EXEC_METHODS, ...(profileMethods ?? [])]);
  const testOnlyTables = new Set<string>();
  for (const { facts } of files) for (const table of facts.testOnlyTables) testOnlyTables.add(bareTable(table));
  const out: DbOperation[] = [];
  // Two identical statements on ONE line mint one id: first wins, as everywhere else (BR-4).
  const seen = new Set<string>();
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };

  for (const { relPath, facts } of files) {
    // Caller → the argument texts it hands to a DB verb, precomputed once per file: the
    // one-hop check below is otherwise a scan of every call site per SQL literal.
    const execArgsByCaller = new Map<string, Set<string>>();
    for (const call of facts.callSites) {
      if (!execMethods.has(call.chain?.at(-1) ?? '')) continue;
      let args = execArgsByCaller.get(call.callerId);
      if (!args) {
        args = new Set<string>();
        execArgsByCaller.set(call.callerId, args);
      }
      // ANY argument, not just the first: a generic verb takes its result type in slot 0
      // (`conn.scalar(i64, sql, .{…})`), and the gate is already the DB verb.
      for (const arg of call.arguments) args.add(arg.trim());
    }

    for (const sql of facts.sqlStrings) {
      // No caller → nothing performs the operation; not an argument → it is a schema constant.
      if (!sql.callerId || !sql.asCallArgument) continue;
      // …and an argument to something that does not EXECUTE SQL is a log/format string —
      // UNLESS it was formatted into a local that a DB verb in the same function then executes
      // (`const sql = try std.fmt.bufPrint(&buf, "delete from t …"); try conn.exec(sql, .{})`).
      // ONE hop only: a local passed through another local, or out of the function, stays
      // dropped (LIM-B) rather than guessed.
      const executesBoundLocal =
        sql.boundLocal !== undefined && (execArgsByCaller.get(sql.callerId)?.has(sql.boundLocal) ?? false);
      if (!executesBoundLocal && (!sql.calleeMethod || !execMethods.has(sql.calleeMethod))) continue;
      stats.dbOpSites++;
      // …and a verb with no SQL structure behind it is prose: `run("update available packages")`.
      if (!hasSqlStructure(sql.text)) continue;
      const parsed = parseSqlOp(sql.text);
      if (!parsed || parsed.op === 'ddl') continue;
      // A table no entity declares and only a `test` block creates is test scaffolding: an op
      // on it from a non-test helper would show up in the graph as a real, unowned table.
      // `public.users` and `Users` name the same entity, so both sides are compared bare.
      const table = bareTable(parsed.entity);
      if (!entityIdByTable.has(table) && testOnlyTables.has(table)) {
        stats.outOfScopeDbOps++; // a test-only table is declared by no entity of this repo
        continue;
      }

      const line = sql.location.startLine;
      const entityId = entityIdByTable.get(table);
      const id = idGen.dbOperationId(sql.callerId, table, parsed.op, `${relPath}:${line}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        versionedId: idGen.versionedId(id, sql.text),
        performerId: sql.callerId,
        entityId,
        entityName: table,
        operation: parsed.op,
        details: sql.text.slice(0, 200),
        location: sql.location,
      });
    }
  }
  // BR-4: bound counts EMITTED ops with an entity id — two identical statements on one line are
  // one op, so they bind once (a table no entity declares stays in scope and unbound).
  stats.boundDbOps = out.filter((o) => o.entityId !== undefined).length;

  return { dbOperations: out, stats };
}
