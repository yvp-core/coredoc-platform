/**
 * Ruby ActiveRecord DB-OPERATION extraction — generic ActiveRecord query call
 * sites (`Model.where`, `Model.create`, `record.update`, …) plus raw-SQL `execute` /
 * `exec_query` / `find_by_sql` / `select_all` calls. Each matched call becomes a
 * `DbOperation` whose performer is the enclosing `def` (a synthesized `FunctionNode`).
 *
 * GENERIC + CONFIGURABLE. The method→operation map is a default ActiveRecord
 * convention table, overridable via `cfg.opMap`; no client model, table, or company
 * names are inlined. Entity resolution is best-effort and never fabricates: only a
 * leftmost-root CONSTANT receiver that is a known entity resolves to that entity;
 * everything else (a non-constant root, or an unknown constant) is `entityName:
 * 'unknown'` with no `entityId`. Module-scope calls (no enclosing def) are skipped.
 *
 *   `Department.where(...)`       → read on Department (id set)
 *   `self.company.bookings.where`  → read, entityName 'unknown'
 *   `User.create(...)`            → create on User (id set)
 *
 * `extractRubyDbOps` is async because the underlying tree-sitter parser loads its WASM
 * grammar asynchronously (same shape as the sibling `extractRubyEgress`).
 */
import { type DbOperation, type DbOpResolutionStats, type FunctionNode, type StableIdGenerator } from '@coredoc/core';
import {
  CLASS_TYPES,
  DEF_TYPES,
  type TsNode,
  collectCalls,
  defOrClassName,
  methodName,
  nearestAncestor,
  qualifiedClassName,
  tokenText,
  withParsedRuby,
  rubyMethodId,
} from './ruby-cst.js';
import { classify } from './ruby-inflect.js';
import { makeFunctionNode } from '../file-nodes.js';

export interface RubyDbOpConfig {
  /** Canonical id generator (seeded for this repo) — mints performer/db-op/function ids. */
  idGen: StableIdGenerator;
  /** Override / extend the default method→operation map. Merged over the default. */
  opMap?: Record<string, string>;
}

/**
 * Default ActiveRecord method → DB-operation map (the generic convention table).
 * Route/Grape DSL verbs (`get`/`post`/`resource`) are deliberately absent, so this
 * map naturally excludes them — no special-casing needed.
 */
export const DEFAULT_DB_OP_MAP: Record<string, string> = {
  // read
  find: 'read',
  find_by: 'read',
  'find_by!': 'read',
  where: 'read',
  all: 'read',
  first: 'read',
  last: 'read',
  pluck: 'read',
  'exists?': 'read',
  count: 'read',
  find_each: 'read',
  take: 'read',
  none: 'read',
  order: 'read',
  limit: 'read',
  // create
  create: 'create',
  'create!': 'create',
  new: 'create',
  save: 'create',
  'save!': 'create',
  insert: 'create',
  insert_all: 'create',
  // update
  update: 'update',
  'update!': 'update',
  update_all: 'update',
  update_attribute: 'update',
  update_column: 'update',
  'increment!': 'update',
  touch: 'update',
  // delete
  destroy: 'delete',
  'destroy!': 'delete',
  delete: 'delete',
  delete_all: 'delete',
  destroy_all: 'delete',
  // transaction
  transaction: 'transaction',
};

/** Raw-SQL helper methods whose first string-literal arg is a SQL statement. */
const RAW_SQL_METHODS = new Set(['execute', 'exec_query', 'find_by_sql', 'select_all']);

/** Leading SQL verb → DB-operation. */
const SQL_VERB_OP: Record<string, string> = {
  SELECT: 'read',
  INSERT: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
};

/** A token is a Ruby constant (model class) when its first char is uppercase. */
function isConstant(text: string): boolean {
  const c = text[0];
  return !!c && c >= 'A' && c <= 'Z';
}

/**
 * Walk a call's receiver chain to its LEFTMOST root token. For `Model.where(...).first`
 * the receiver is `Model.where(...)` (a call), whose receiver is `Model`; for
 * `self.scope.update_all(...)` the chain bottoms out at `self`. Descends receiver
 * fields, else `child(0)`, until reaching a leaf node, and returns that leaf's text.
 */
function leftmostRootText(call: TsNode): string | undefined {
  let cur: TsNode | undefined = call.childForFieldName?.('receiver') ?? undefined;
  if (!cur) return undefined;
  for (;;) {
    const next: TsNode | undefined =
      cur.childForFieldName?.('receiver') ?? (cur.childCount > 0 ? cur.child(0) : undefined);
    if (!next || next.id === cur.id) break;
    cur = next;
  }
  return cur.text as string | undefined;
}

/**
 * First string-literal argument text of a call (inner content, quotes stripped),
 * or undefined when the first arg is not a static string. Used for raw SQL.
 */
function firstStringLiteralArg(call: TsNode): string | undefined {
  const args = call.childForFieldName?.('arguments');
  if (!args) return undefined;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c || c.type === ',' || c.type === '(' || c.type === ')') continue;
    if (c.type === 'string') return tokenText(c);
    // The first non-trivial arg is not a static string → no usable SQL.
    return undefined;
  }
  return undefined;
}

/** Parse the leading verb + first table (after FROM/INTO/UPDATE) from a SQL string. */
function parseSql(sql: string): { operation: string; table: string } | undefined {
  const verbMatch = /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(sql);
  if (!verbMatch) return undefined;
  const operation = SQL_VERB_OP[verbMatch[1].toUpperCase()];
  const tableMatch = /\b(?:FROM|INTO|UPDATE)\s+["'`]?([A-Za-z_][\w.]*)["'`]?/i.exec(sql);
  const table = tableMatch ? tableMatch[1] : '';
  return { operation, table };
}

/**
 * Extract ActiveRecord DB operations (and the enclosing-def FunctionNodes that perform
 * them) from a set of Ruby source files. Pure over source text + CST.
 */
export async function extractRubyDbOps(
  files: Array<{ relPath: string; source: string }>,
  entityNames: Set<string>,
  entityIdByName: Map<string, string>,
  cfg: RubyDbOpConfig,
): Promise<{ dbOperations: DbOperation[]; functions: FunctionNode[]; stats: DbOpResolutionStats }> {
  // A `Map`, not the merged object literal: the key is a method NAME read out of Ruby source, and
  // a plain object answers `constructor` / `toString` from `Object.prototype` — a non-undefined
  // "operation" that is a Function, which then travelled into the emitted `DbOperation`.
  const opMap = new Map(Object.entries({ ...DEFAULT_DB_OP_MAP, ...(cfg.opMap ?? {}) }));
  const idGen = cfg.idGen;

  const dbOperations: DbOperation[] = [];
  const functions = new Map<string, FunctionNode>();
  const seenDbOps = new Set<string>();

  // Pure observation (BR-4): a site is COUNTED where it is enumerated, before any drop, so the
  // rate cannot flatter itself by counting after the filter. Nothing here changes what is emitted.
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };
  /**
   * Class/module constants declared in the SCANNED files (`scanPaths`, app/ + lib/ by default) —
   * qualified and bare. That is where repo classes live; a constant absent from it is a gem.
   */
  const declaredConstants = new Set<string>();
  /** Root constants of unbound constant-rooted sites, judged once the whole repo is walked. */
  const unboundRootConstants: string[] = [];

  for (const { relPath, source } of files) {
    await withParsedRuby(source, (root) => {
      for (const ct of CLASS_TYPES) {
        for (const cnode of root.descendantsOfType(ct) as TsNode[]) {
          const qualified = qualifiedClassName(cnode);
          if (!qualified) continue;
          declaredConstants.add(qualified);
          declaredConstants.add(qualified.split('::').pop() as string);
        }
      }
      for (const call of collectCalls(root)) {
        const method = methodName(call);
        if (!method) continue;

        const isRawSql = RAW_SQL_METHODS.has(method);
        const mappedOp = opMap.get(method);
        if (!isRawSql && mappedOp === undefined) continue;

        // Performer: the enclosing def. Module-scope calls (no def) are skipped.
        const def = nearestAncestor(call, DEF_TYPES);
        if (!def) continue;
        stats.dbOpSites++;
        const defName = defOrClassName(def) ?? method;
        const defLine = def.startPosition.row + 1;
        // Singleton-aware: an instance and a class method of the same name in the same
        // class must not collide on one performer id. Same helper as the def index.
        const performerId = rubyMethodId(idGen, relPath, def);

        let operation: string;
        let entityName: string;
        let entityId: string | undefined;

        if (isRawSql) {
          const sql = firstStringLiteralArg(call);
          const parsed = sql ? parseSql(sql) : undefined;
          if (!parsed) continue; // raw-SQL helper without a usable static SQL string.
          operation = parsed.operation;
          // SQL tables are snake_case plural (`departments`); entities are PascalCase model
          // constants (`Department`). Strip any schema qualifier (`public.users` → `users`),
          // then classify so a raw-SQL op resolves to its entity instead of 'unknown'.
          const bareTable = parsed.table ? (parsed.table.split('.').pop() ?? parsed.table) : '';
          const entityConst = bareTable ? classify(bareTable) : '';
          if (entityNames.has(entityConst)) {
            entityName = entityConst;
            entityId = entityIdByName.get(entityConst);
          } else {
            entityName = parsed.table || 'unknown';
            entityId = undefined;
          }
        } else {
          // Defined by the guard above: a non-raw-SQL call with no mapping never reaches here.
          operation = mappedOp as string;
          const rootText = leftmostRootText(call);
          if (rootText && isConstant(rootText) && entityNames.has(rootText)) {
            entityName = rootText;
            entityId = entityIdByName.get(rootText);
          } else {
            entityName = 'unknown';
            entityId = undefined;
            // A CONSTANT root that is not a model may still be repo code (a service object, a
            // concern). Only a constant declared nowhere — a gem — is out of scope, and that
            // verdict needs every scanned file, so the name is queued rather than judged here.
            if (rootText && isConstant(rootText)) unboundRootConstants.push(rootText.replace(/^::/, ''));
          }
        }

        const startLine = call.startPosition.row + 1;
        const details = (call.text as string).slice(0, 200);

        // Dedup by a structural key (same performer + op + entity + location + text).
        const dedupKey = `${performerId}|${operation}|${entityName}|${startLine}|${details}`;
        if (!seenDbOps.has(dedupKey)) {
          seenDbOps.add(dedupKey);
          // Bound = an EMITTED operation carries a resolved entity id (BR-4, owner decision
          // 2026-09-18), so it is counted here rather than per enumerated site: two identical
          // ORM calls on one line collapse to one operation and used to count twice, which
          // could put `boundDbOps` above the number of operations that exist.
          if (entityId) stats.boundDbOps++;
          const id = idGen.dbOperationId(performerId, entityName, operation, `${relPath}:${startLine}`);
          dbOperations.push({
            id,
            versionedId: idGen.versionedId(id, details),
            performerId,
            entityId,
            entityName,
            operation: operation as DbOperation['operation'],
            details,
            location: { filePath: relPath, startLine, endLine: startLine },
          });
        }

        if (!functions.has(performerId)) {
          functions.set(performerId, makeFunctionNode(idGen, performerId, defName, 'method', relPath, defLine));
        }
      }
    });
  }

  for (const constant of unboundRootConstants) {
    if (!declaredConstants.has(constant)) stats.outOfScopeDbOps++;
  }

  return { dbOperations, functions: [...functions.values()], stats };
}
