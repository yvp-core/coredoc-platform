/**
 * Rust DB-OPERATION extraction — sqlx macros, diesel DSL and sea-orm verbs → `DbOperation[]`.
 * Each matched site's performer is the enclosing fn (a synthesized `FunctionNode` is returned in
 * `functions` so the performer has a node even when the call-graph lane didn't emit one).
 *
 * **The receiver gate is mandatory, not an optimization.** `.filter`, `.find`, `.first`,
 * `.count`, `.get`, `.load`, `.all` and `.one` are ordinary `Iterator` / `HashMap` / `Option`
 * methods and they are EVERYWHERE in Rust. A method-name-only rule produces thousands of false
 * db-ops against `entityName: 'unknown'` — Rust's version of the `save`/`delete` problem
 * `python-dbops.ts` documents, an order of magnitude worse because iterator chains are
 * idiomatic. A verb call counts only when:
 *
 *   1. the receiver chain contains `::table` (`users::table.filter(…)`), or
 *   2. the chain roots at an identifier that is a KNOWN TABLE NAME from the entity index
 *      (covers `use schema::users::dsl::*;` then a bare `users.filter(…)`), or
 *   3. the chain contains `::Entity` or roots at a known entity module (sea-orm), or
 *   4. it is a `diesel::insert_into|update|delete(…)` free function.
 *
 * `sqlx::query!("…")` needs no gate: it carries REAL SQL, which `parseSqlOp` (the engine's own
 * pure SQL reader, reused rather than rewritten) turns into an op + table name. That table name
 * matches what the migration-DDL entity source produces, so `entityId` lands instead of
 * dangling. An unrecoverable receiver yields `entityName: 'unknown'` with NO `entityId` — never
 * a fabricated one.
 */
import type { DbOperation, DbOperationType, DbOpResolutionStats, FunctionNode, StableIdGenerator } from '@coredoc/core';
import { parseSqlOp } from '../engine/text-helpers.js';
import {
  CALL_EXPRESSION,
  DEF_TYPES,
  FIELD_EXPRESSION,
  GENERIC_FUNCTION,
  MACRO_INVOCATION,
  type RustFile,
  SCOPED_IDENTIFIER,
  type TsNode,
  itemName,
  nearestAncestor,
  rustFunctionId,
  rustStringValue,
  rustTypeChain,
} from './rust-cst.js';
import { makeFunctionNode } from '../file-nodes.js';

export interface RustDbOpConfig {
  /** Canonical id generator (seeded for this repo) — mints performer/db-op/function ids. */
  idGen: StableIdGenerator;
  /** Additional method names to treat as db-op verbs. Unknown extras classify as 'query'. */
  methods?: string[];
}

/**
 * Default verb → operation map across the three ORMs. A verb that is dual-natured collapses onto
 * the group it is listed under (a single `DbOperationType` cannot be both).
 */
export const DEFAULT_RS_DB_OP_MAP: Record<string, DbOperationType> = {
  // read — diesel DSL + sea-orm finders + sqlx executors
  load: 'read',
  get_result: 'read',
  get_results: 'read',
  first: 'read',
  find: 'read',
  filter: 'read',
  select: 'read',
  count: 'read',
  all: 'read',
  one: 'read',
  find_by_id: 'read',
  find_related: 'read',
  fetch_one: 'read',
  fetch_all: 'read',
  fetch_optional: 'read',
  // create
  insert: 'create',
  insert_into: 'create',
  insert_many: 'create',
  values: 'create',
  // update
  update: 'update',
  save: 'update',
  set: 'update',
  // delete
  delete: 'delete',
  delete_by_id: 'delete',
  delete_many: 'delete',
};

/** sqlx query macros whose FIRST string literal is real SQL. */
const SQLX_MACROS = new Set([
  'query',
  'query_as',
  'query_scalar',
  'query_file',
  'query_as_unchecked',
  'query_unchecked',
]);
/** diesel free functions that are a db op on their own terms (their arg names the table). */
const DIESEL_FREE_FNS: Record<string, DbOperationType> = {
  insert_into: 'create',
  insert_or_ignore_into: 'create',
  replace_into: 'create',
  update: 'update',
  delete: 'delete',
};

/** The receiver chain, walked to its leftmost root, recording the ORM markers seen on the way. */
interface ChainInfo {
  /** Leftmost identifier of the chain (`users` from `users::table.filter(…)`). */
  root?: string;
  /** A `::table` segment appeared (diesel). */
  hasTable: boolean;
  /** An `::Entity` segment appeared (sea-orm). */
  hasEntity: boolean;
  /** The module qualifying an `::Entity` (`post` from `post::Entity::find()`). */
  entityModule?: string;
}

/**
 * Walk a receiver expression to its root. Descends `field_expression.value`,
 * `call_expression.function` and — critically — `generic_function`, which the grammar inserts
 * between a `call_expression` and its `field_expression` on every turbofish
 * (`.load::<User>(conn)`); a walker that only knows `field_expression` skips those entirely.
 */
function chainInfo(node: TsNode | undefined | null): ChainInfo {
  const info: ChainInfo = { hasTable: false, hasEntity: false };
  let cur: TsNode | undefined | null = node;
  while (cur) {
    switch (cur.type) {
      case 'identifier':
        info.root = cur.text as string;
        return info;
      case SCOPED_IDENTIFIER: {
        const segments = (cur.text as string).split('::');
        if (segments.includes('table')) info.hasTable = true;
        const entityAt = segments.indexOf('Entity');
        if (entityAt >= 0) {
          info.hasEntity = true;
          if (entityAt > 0) info.entityModule = segments[entityAt - 1];
        }
        info.root = segments[0];
        return info;
      }
      case FIELD_EXPRESSION:
        cur = cur.childForFieldName?.('value');
        break;
      case CALL_EXPRESSION:
        cur = cur.childForFieldName?.('function');
        break;
      case GENERIC_FUNCTION:
        cur = cur.childForFieldName?.('function') ?? cur.namedChild?.(0);
        break;
      case 'await_expression':
      case 'try_expression':
      case 'reference_expression':
      case 'unary_expression':
      case 'parenthesized_expression':
        cur = cur.namedChild?.(0);
        break;
      default:
        return info;
    }
  }
  return info;
}

export function extractRustDbOps(
  files: RustFile[],
  tableNames: Set<string>,
  entityIdByName: Map<string, string>,
  cfg: RustDbOpConfig,
): { dbOperations: DbOperation[]; functions: FunctionNode[]; stats: DbOpResolutionStats } {
  const idGen = cfg.idGen;
  // Null-prototype: `method` is a source-derived string, so a plain object literal would answer
  // `opMap['constructor']` with `Object` — truthy, not a DbOperationType — and emit a db-op whose
  // `operation` is a function. Same reason `DIESEL_FREE_FNS` is read through `Object.hasOwn`.
  const opMap: Record<string, DbOperationType> = Object.assign(Object.create(null), DEFAULT_RS_DB_OP_MAP);
  for (const m of cfg.methods ?? []) if (!(m in opMap)) opMap[m] = 'query';

  const dbOperations: DbOperation[] = [];
  const functions = new Map<string, FunctionNode>();
  const seen = new Set<string>();
  // BR-4: sites the three walks ENUMERATE, before the table-or-entity gate each applies.
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };
  // One SOURCE site, one count: `diesel::insert_into(users::table)` is a candidate of both the
  // free-fn walk and the chain walk (`insert_into` is also an op verb). A site is keyed by its
  // node, and its VERDICT is settled after every walk has run (below): bound when some walk
  // emitted an op with an entity id, out of scope only when a walk rejected it and NO walk
  // emitted it — a later walk that binds the same node overrules an earlier rejection.
  const judged = new Set<string>();
  const rejected = new Set<string>();
  const emittedAt = new Set<string>();
  const boundAt = new Set<string>();
  const enumerate = (file: RustFile, node: TsNode): string => {
    const key = `${file.relPath}:${node.startIndex}`;
    if (!judged.has(key)) {
      judged.add(key);
      stats.dbOpSites++;
    }
    return key;
  };

  /** Record one op at `node` inside `file`, minting the performer node on demand. Returns
   * whether a performer existed — a module-scope site emits nothing and binds nothing. */
  const record = (
    file: RustFile,
    node: TsNode,
    operation: DbOperationType,
    entityName: string,
    entityId: string | undefined,
  ): boolean => {
    const fn = nearestAncestor(node, DEF_TYPES);
    if (!fn) return false; // a module-scope op site (a `static` initializer) has no performer
    const relPath = file.relPath;
    const performerId = rustFunctionId(idGen, relPath, fn);
    const startLine = node.startPosition.row + 1;
    const details = (node.text as string).slice(0, 200);
    const dedupKey = `${performerId}|${operation}|${entityName}|${startLine}|${details}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      const id = idGen.dbOperationId(performerId, entityName, operation, `${relPath}:${startLine}`);
      dbOperations.push({
        id,
        versionedId: idGen.versionedId(id, details),
        performerId,
        entityId,
        entityName,
        operation,
        details,
        location: { filePath: relPath, startLine, endLine: startLine },
      });
    }
    if (!functions.has(performerId)) {
      const kind: FunctionNode['kind'] = rustTypeChain(fn).length > 0 ? 'method' : 'function';
      functions.set(
        performerId,
        makeFunctionNode(idGen, performerId, itemName(fn) ?? 'anonymous', kind, relPath, fn.startPosition.row + 1),
      );
    }
    return true;
  };

  /** Record one enumerated site's outcome: bound only when an EMITTED op carries an entity id. */
  const credit = (key: string, emitted: boolean, entityId: string | undefined): void => {
    if (!emitted) return;
    emittedAt.add(key);
    if (entityId) boundAt.add(key);
  };

  for (const file of files) {
    // --- sqlx macros: real SQL, read by the engine's own parser ---
    for (const macro of file.root.descendantsOfType(MACRO_INVOCATION) as TsNode[]) {
      const macroPath = (macro.childForFieldName?.('macro')?.text ?? '') as string;
      const bare = macroPath.slice(macroPath.lastIndexOf('::') + 1).replace(/^:+/, '');
      if (!SQLX_MACROS.has(bare)) continue;
      const key = enumerate(file, macro);
      const tree = macro.child(macro.childCount - 1) as TsNode | undefined;
      const n = tree?.namedChildCount ?? 0;
      let sql: string | undefined;
      for (let i = 0; i < n; i++) {
        const c = tree.namedChild(i) as TsNode | undefined;
        // `query_as!(User, "SELECT …")` puts the output type first; the SQL is the first STRING.
        if (c?.type === 'string_literal' || c?.type === 'raw_string_literal') {
          sql = rustStringValue(c);
          break;
        }
      }
      if (!sql) continue;
      const parsed = parseSqlOp(sql);
      if (!parsed) continue;
      const entityName = parsed.entity.toLowerCase();
      const entityId = entityIdByName.get(entityName);
      credit(key, record(file, macro, parsed.op, entityName, entityId), entityId);
    }

    // --- diesel free functions: `diesel::insert_into(users::table)` ---
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const fn = call.childForFieldName?.('function') as TsNode | undefined;
      const name =
        fn?.type === SCOPED_IDENTIFIER
          ? (fn.childForFieldName?.('name')?.text as string | undefined)
          : fn?.type === 'identifier'
            ? (fn.text as string)
            : undefined;
      const freeOp = name && Object.hasOwn(DIESEL_FREE_FNS, name) ? DIESEL_FREE_FNS[name] : undefined;
      if (!freeOp) continue;
      const key = enumerate(file, call);
      // Gate 4: the argument must name a table — `users::table` or a known bare table name.
      const arg = call.childForFieldName?.('arguments')?.namedChild?.(0) as TsNode | undefined;
      const argChain = chainInfo(arg);
      const argRoot = argChain.root;
      if (!argChain.hasTable && !(argRoot && tableNames.has(argRoot))) {
        rejected.add(key); // the argument names no known table and no entity module
        continue;
      }
      const entityName = argRoot && tableNames.has(argRoot) ? argRoot : 'unknown';
      const freeEntityId = entityIdByName.get(entityName);
      credit(key, record(file, call, freeOp, entityName, freeEntityId), freeEntityId);
    }

    // --- diesel DSL + sea-orm verbs: method calls behind the receiver gate ---
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const fn = call.childForFieldName?.('function') as TsNode | undefined;
      const callee = fn?.type === GENERIC_FUNCTION ? (fn.childForFieldName?.('function') ?? fn.namedChild?.(0)) : fn;
      let method: string | undefined;
      if (callee?.type === FIELD_EXPRESSION) {
        method = callee.childForFieldName?.('field')?.text as string | undefined;
      } else if (callee?.type === SCOPED_IDENTIFIER) {
        method = callee.childForFieldName?.('name')?.text as string | undefined;
      }
      const operation = method ? opMap[method] : undefined;
      if (!operation) continue;
      const key = enumerate(file, call);

      const receiver =
        callee?.type === FIELD_EXPRESSION
          ? (callee.childForFieldName?.('value') as TsNode | undefined)
          : (callee as TsNode | undefined);
      const info = chainInfo(receiver);
      const rootIsTable = !!info.root && tableNames.has(info.root);
      const entityModuleKnown = !!info.entityModule && entityIdByName.has(info.entityModule);
      // Gates 1–3. Without one of them this is an ordinary Iterator/Option/HashMap call.
      if (!info.hasTable && !rootIsTable && !info.hasEntity && !entityModuleKnown) {
        rejected.add(key); // chain root is neither a known table nor an entity module
        continue;
      }

      let entityName = 'unknown';
      if (rootIsTable) entityName = info.root as string;
      else if (info.entityModule && entityIdByName.has(info.entityModule)) entityName = info.entityModule;
      const chainEntityId = entityIdByName.get(entityName);
      credit(key, record(file, call, operation, entityName, chainEntityId), chainEntityId);
    }
  }

  // Verdicts, once every walk has judged every node (BR-4).
  stats.boundDbOps = boundAt.size;
  for (const key of rejected) if (!emittedAt.has(key)) stats.outOfScopeDbOps++;

  return { dbOperations, functions: [...functions.values()], stats };
}
