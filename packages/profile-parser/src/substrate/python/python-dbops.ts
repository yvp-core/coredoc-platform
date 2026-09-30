/**
 * Python ORM DB-OPERATION extraction — Django QuerySet/Manager op sites
 * (`User.objects.filter/get/create/…`, `obj.save()`, `Model.objects.bulk_create(...)`) →
 * `DbOperation[]`. Each matched call's performer is the enclosing `def` (a synthesized
 * `FunctionNode`, returned in `functions` so the performer has a node even when the
 * call-graph lane didn't emit one — Ruby precedent).
 *
 * GENERIC + CONFIGURABLE. The method→operation map is a default Django ORM convention table;
 * `cfg.methods` names additional verbs (classified `'query'` unless already known). No client
 * model/table/company names are inlined (repo rule). Entity resolution is BEST-EFFORT and
 * never fabricates: only a Capitalized leftmost receiver root that is a known entity resolves
 * to that entity; everything else is `entityName: 'unknown'` with no `entityId`. Module-scope
 * calls (no enclosing def) are skipped.
 *
 *   `User.objects.filter(...)`             → read on User (id set)
 *   `User.objects.filter(...).update(...)` → update on User (chained queryset write; id set)
 *   `obj.save()`                           → create, entity 'unknown'
 *   `X.objects.create(...)`                → create on X (id set only if X is a known entity)
 */
import type { DbOperation, DbOperationType, DbOpResolutionStats, FunctionNode, StableIdGenerator } from '@coredoc/core';
import { parseSqlStatement } from '../engine/text-helpers.js';
import type { PythonRawQueryMatcher } from '../../types/python-profile.js';
import { markUnresolved } from '../../unresolved-sentinel.js';
import {
  ATTRIBUTE,
  CALL,
  CLASS_TYPES,
  DEF_TYPES,
  type PythonFile,
  type TsNode,
  defName,
  nearestAncestor,
  pythonClassChain,
  pythonFunctionId,
} from './python-cst.js';

export interface PythonDbOpConfig {
  /** Canonical id generator (seeded for this repo) — mints performer/db-op/function ids. */
  idGen: StableIdGenerator;
  /** Additional method names to treat as db-op verbs. Unknown extras classify as 'query'. */
  methods?: string[];
  /** Raw-SQL call shapes (`sync_execute(QUERY, params)`) — the non-ORM lane. */
  rawQueries?: PythonRawQueryMatcher[];
}

/**
 * Default Django ORM method → DB-operation map (the generic convention table). `get_or_create`
 * is grouped under READ (its primary path when the row exists); `update_or_create` under UPDATE.
 * A single `DbOperationType` can't be both, so the dual-nature verbs collapse onto the group
 * they're listed under.
 */
export const DEFAULT_PY_DB_OP_MAP: Record<string, DbOperationType> = {
  // read
  filter: 'read',
  get: 'read',
  all: 'read',
  exclude: 'read',
  first: 'read',
  last: 'read',
  count: 'read',
  exists: 'read',
  values: 'read',
  values_list: 'read',
  get_or_create: 'read',
  aggregate: 'read',
  annotate: 'read',
  // create
  create: 'create',
  bulk_create: 'create',
  save: 'create',
  add: 'create',
  // update
  update: 'update',
  bulk_update: 'update',
  update_or_create: 'update',
  // delete
  delete: 'delete',
  bulk_delete: 'delete',
};

/** Instance-mutator verbs accepted as op sites WITHOUT a `.objects.` Manager in the chain. */
const INSTANCE_METHODS = new Set<string>(['save', 'delete']);

/**
 * Whether a call passes any POSITIONAL argument.
 *
 * This is the discriminator for the instance-mutator shape. `save` and `delete` are accepted
 * with no Manager in the chain, which on its own matches every `image.save(path)`,
 * `cache.delete(key)` and `file.delete(name)` in a repo and emits them as db-ops against
 * `entityName: 'unknown'` — on a Django codebase that is plausibly most of the db-op set.
 * The ORM instance mutators take keyword arguments only (`obj.save()`,
 * `obj.save(update_fields=[…])`), while the non-ORM namesakes take a positional one, so the
 * call's own shape separates them without a receiver-name list in shared code.
 */
function hasPositionalArgs(call: TsNode): boolean {
  const args = call.childForFieldName?.('arguments');
  if (!args) return false;
  const n = args.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const a = args.namedChild?.(i) as TsNode | undefined;
    if (a && a.type !== 'keyword_argument' && a.type !== 'comment') return true;
  }
  return false;
}

/** A token is a model class name when its first char is uppercase. */
function isCapitalized(text: string): boolean {
  const c = text[0];
  return !!c && c >= 'A' && c <= 'Z';
}

/**
 * Walk a receiver chain to its leftmost identifier root, descending THROUGH chained calls.
 * For a plain `User.objects` chain this is the left-to-right roots; when the receiver roots at a
 * chained queryset call (`Model.objects.filter(...).update()` — the `.update()`'s receiver is the
 * `.filter(...)` call node), we descend the call's callee chain to the innermost `Model` root.
 * Returns the leftmost identifier text (`root`, undefined when the chain bottoms out at a
 * non-name node) and whether a `.objects.` Manager appears anywhere in the chain.
 */
function querysetReceiver(node: TsNode | undefined): { root?: string; hasObjects: boolean } {
  if (!node) return { hasObjects: false };
  if (node.type === 'identifier') return { root: node.text as string, hasObjects: false };
  if (node.type === ATTRIBUTE) {
    const inner = querysetReceiver(node.childForFieldName?.('object'));
    const attr = node.childForFieldName?.('attribute')?.text as string | undefined;
    return { root: inner.root, hasObjects: inner.hasObjects || attr === 'objects' };
  }
  if (node.type === CALL) {
    // A chained call (`X.filter(...)`) — descend its callee chain to the underlying root.
    return querysetReceiver(node.childForFieldName?.('function'));
  }
  return { hasObjects: false };
}

/** Queryset-write verbs (`update`/`delete`/`bulk_*`) accepted when they chain off a queryset call. */
function isQuerysetWriteMethod(method: string): boolean {
  return method === 'update' || method === 'delete' || method.startsWith('bulk_');
}

/**
 * A synthesized minimal-valid `FunctionNode` for an enclosing def — the performer of every
 * db-op inside it. `kind` is 'method' when nested in a class, else 'function'.
 */
function makeFunctionNode(
  idGen: StableIdGenerator,
  id: string,
  name: string,
  kind: FunctionNode['kind'],
  relPath: string,
  line: number,
): FunctionNode {
  return {
    id,
    versionedId: idGen.versionedId(id, `${name}@${relPath}:${line}`),
    name,
    kind,
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: line, endLine: line },
    isAsync: false,
    isGenerator: false,
    parameters: [],
  };
}

/**
 * Text of a `string` node with its quotes dropped: `string_content` pieces concatenated and
 * f-string `interpolation` children kept VERBATIM (`{table_name}`). The braces are what makes
 * an interpolated target unreadable to the SQL parser — which is the honest outcome, since the
 * value is only known at runtime. Prefixes (f/r/b) and triple quotes are handled by the CST.
 */
function stringNodeText(node: TsNode): string {
  let out = '';
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'string_content' || c.type === 'interpolation') out += c.text as string;
  }
  return out;
}

/**
 * Name → bound expression for every `NAME = <expr>` in a file, split by scope. Raw SQL in
 * Python lives in module-level constants (`INSERT_LOG_ENTRY_SQL = """…"""`) far more often
 * than at the call site, so a rawQueries lane that only reads literals sees a fraction of the
 * surface. Module bindings win over inner ones (a class attribute or local of the same name is
 * the rarer shape), and the FIRST binding of a name wins within each scope — re-binding is not
 * tracked, which is the accepted cost of a non-flow-sensitive table.
 */
function bindingTables(file: PythonFile): { module: Map<string, TsNode>; inner: Map<string, TsNode> } {
  const module = new Map<string, TsNode>();
  const inner = new Map<string, TsNode>();
  const scopes = new Set<string>([...DEF_TYPES, ...CLASS_TYPES]);
  for (const node of file.root.descendantsOfType('assignment') as TsNode[]) {
    const left = node.childForFieldName?.('left');
    const right = node.childForFieldName?.('right');
    if (left?.type !== 'identifier' || !right) continue;
    const name = left.text as string;
    const table = nearestAncestor(node, scopes) ? inner : module;
    if (!table.has(name)) table.set(name, right);
  }
  return { module, inner };
}

/**
 * Best-effort SQL text behind a query argument: a literal, a same-file constant, a constant
 * reached through `.format(...)`/`%`/`+`, or nothing. Never guesses — an unresolvable
 * expression returns undefined and the caller decides whether to mark or drop the site.
 */
function resolveSqlText(
  node: TsNode | undefined,
  tables: { module: Map<string, TsNode>; inner: Map<string, TsNode> },
  visited: Set<string> = new Set(),
): string | undefined {
  if (!node || visited.size > 4) return undefined;
  const byName = (name: string): string | undefined => {
    if (visited.has(name)) return undefined; // cyclic binding
    const bound = tables.module.get(name) ?? tables.inner.get(name);
    return bound ? resolveSqlText(bound, tables, new Set([...visited, name])) : undefined;
  };
  switch (node.type) {
    case 'string':
      return stringNodeText(node);
    case 'concatenated_string': {
      // Adjacent literals (`"SELECT …" "FROM …"`) — the CST keeps them as separate children.
      let out = '';
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild?.(i) as TsNode | undefined;
        if (c?.type === 'string') out += stringNodeText(c);
      }
      return out || undefined;
    }
    case 'parenthesized_expression':
      return resolveSqlText(node.namedChild?.(0) as TsNode | undefined, tables, visited);
    case 'identifier':
      return byName(node.text as string);
    case 'attribute': {
      // `self.REPLAY_EVENT_SQL` / `module.QUERY` — resolve by the attribute tail.
      const attr = node.childForFieldName?.('attribute')?.text as string | undefined;
      return attr ? byName(attr) : undefined;
    }
    case 'binary_operator':
      // `SQL % params` / `PREFIX + SUFFIX` — the leading operand carries the verb.
      return resolveSqlText(node.childForFieldName?.('left') as TsNode | undefined, tables, visited);
    case CALL: {
      // `TEMPLATE.format(...)` and friends: the statement text is the call's RECEIVER.
      const callee = node.childForFieldName?.('function');
      if (callee?.type !== ATTRIBUTE) return undefined;
      return resolveSqlText(callee.childForFieldName?.('object') as TsNode | undefined, tables, visited);
    }
    default:
      return undefined;
  }
}

/** Callee name of a call node: bare (`sync_execute`) or the attribute tail (`client.execute`). */
function calleeName(call: TsNode): string | undefined {
  const fn = call.childForFieldName?.('function');
  if (!fn) return undefined;
  if (fn.type === ATTRIBUTE) return fn.childForFieldName?.('attribute')?.text as string | undefined;
  if (fn.type === 'identifier') return fn.text as string;
  return undefined;
}

/** The Nth argument node, unwrapping `name=value` to its value. */
function argAt(call: TsNode, index: number): TsNode | undefined {
  const args = call.childForFieldName?.('arguments');
  const a = args?.namedChild?.(index) as TsNode | undefined;
  if (a?.type === 'keyword_argument') return a.childForFieldName?.('value') as TsNode | undefined;
  return a;
}

/**
 * Raw-SQL db-ops for one file: every call to a declared query function whose SQL argument
 * resolves to a statement. The op comes from the statement's verb; the entity from its table
 * when readable, else the unresolved-sentinel (only when the matcher asked for it — otherwise
 * the site is dropped, as it was before this lane existed).
 *
 * Entity binding follows the ORM lane's rule: a table name that matches a declared entity gets
 * its id, everything else stays name-only. Physical ClickHouse/SQL table names rarely match
 * Django model class names, and inventing a mapping here would be a fabrication.
 */
function rawQueryOps(
  file: PythonFile,
  matchers: PythonRawQueryMatcher[],
  entityIdByName: Map<string, string>,
  idGen: StableIdGenerator,
  dbOperations: DbOperation[],
  functions: Map<string, FunctionNode>,
  seen: Set<string>,
  stats: DbOpResolutionStats,
): void {
  const { relPath } = file;
  let tables: ReturnType<typeof bindingTables> | undefined;
  for (const call of file.root.descendantsOfType(CALL) as TsNode[]) {
    const name = calleeName(call);
    if (!name) continue;
    const matcher = matchers.find((m) => m.functions.includes(name));
    if (!matcher) continue;
    const def = nearestAncestor(call, DEF_TYPES);
    if (!def) continue; // module-scope calls have no performer (same rule as the ORM lane)
    stats.dbOpSites++;

    tables ??= bindingTables(file);
    const arg = argAt(call, matcher.queryArg ?? 0);
    const sql = resolveSqlText(arg, tables);
    const parsed = sql ? parseSqlStatement(sql) : undefined;
    let operation: DbOperationType;
    let entityName: string;
    if (parsed?.entity) {
      operation = parsed.op;
      entityName = parsed.entity;
    } else {
      if (!matcher.emitUnresolved) continue;
      operation = parsed?.op ?? 'query';
      entityName = markUnresolved(((arg?.text as string | undefined) ?? name).slice(0, 120));
    }
    // A table the SQL names but no entity declares is out of scope (BR-4); an unresolvable
    // statement — dropped or sentinel — stays IN scope and unbound.
    // `boundDbOps` is read back from the emitted ops once the walk is done (see
    // `extractPythonDbOps`), so only the out-of-scope count is tallied here.
    if (parsed?.entity && !entityIdByName.has(entityName)) stats.outOfScopeDbOps++;

    const performerId = pythonFunctionId(idGen, relPath, def);
    const startLine = call.startPosition.row + 1;
    const details = (call.text as string).slice(0, 200);
    const dedupKey = `${performerId}|${operation}|${entityName}|${startLine}|${details}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      const id = idGen.dbOperationId(performerId, entityName, operation, `${relPath}:${startLine}`);
      const entityId = entityIdByName.get(entityName);
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
      const kind: FunctionNode['kind'] = pythonClassChain(def).length > 0 ? 'method' : 'function';
      const label = defName(def) ?? name;
      functions.set(performerId, makeFunctionNode(idGen, performerId, label, kind, relPath, def.startPosition.row + 1));
    }
  }
}

export function extractPythonDbOps(
  files: PythonFile[],
  entityNames: Set<string>,
  entityIdByName: Map<string, string>,
  cfg: PythonDbOpConfig,
): { dbOperations: DbOperation[]; functions: FunctionNode[]; stats: DbOpResolutionStats } {
  const idGen = cfg.idGen;
  const opMap: Record<string, DbOperationType> = { ...DEFAULT_PY_DB_OP_MAP };
  for (const m of cfg.methods ?? []) if (!(m in opMap)) opMap[m] = 'query';
  // A verb the profile named explicitly is an op site on its own terms. The site rule below
  // encodes Django's Manager/queryset grammar, which no other ORM follows — SQLAlchemy's
  // `session.execute(...)` has no `.objects.` and is not an instance mutator, so without this
  // `dbOperations.methods` registered a verb that could never fire and the only configurable
  // knob on the Python db-op path was inert.
  const configuredMethods = new Set(cfg.methods ?? []);

  const rawMatchers = cfg.rawQueries ?? [];

  const dbOperations: DbOperation[] = [];
  const functions = new Map<string, FunctionNode>();
  const seen = new Set<string>();
  // BR-4: sites the walks ENUMERATE. A call with no enclosing `def` (module scope) is never a
  // site — nothing performs it (LIM-4).
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };

  for (const file of files) {
    const { relPath } = file;
    for (const call of file.root.descendantsOfType(CALL) as TsNode[]) {
      const fn = call.childForFieldName?.('function');
      // Only method calls (`recv.verb(...)`) are op sites.
      if (fn?.type !== ATTRIBUTE) continue;
      const method = fn.childForFieldName?.('attribute')?.text as string | undefined;
      if (!method) continue;
      const operation = opMap[method];
      if (operation === undefined) continue;

      const receiver = fn.childForFieldName?.('object');
      const { root, hasObjects } = querysetReceiver(receiver);
      const isManager = hasObjects;
      const rootIsKnownModel = !!root && isCapitalized(root) && entityNames.has(root);
      // Site rule: a Manager chain (`.objects.`), an instance `.save()/.delete()`, OR a
      // queryset-write (`update`/`delete`/`bulk_*`) chaining off a queryset call whose chain
      // includes `.objects.` or bottoms out at a known model (`Model.objects.filter().update()`).
      const isQuerysetWrite =
        receiver?.type === CALL && isQuerysetWriteMethod(method) && (hasObjects || rootIsKnownModel);
      const isInstanceMutator = INSTANCE_METHODS.has(method) && !hasPositionalArgs(call);
      if (!isManager && !isInstanceMutator && !isQuerysetWrite && !configuredMethods.has(method)) continue;

      // Performer: the enclosing def. Module-scope calls (no def) are skipped.
      const def = nearestAncestor(call, DEF_TYPES);
      if (!def) continue;
      stats.dbOpSites++;
      const performerId = pythonFunctionId(idGen, relPath, def);
      const defNameText = defName(def) ?? method;
      const kind: FunctionNode['kind'] = pythonClassChain(def).length > 0 ? 'method' : 'function';

      // Entity resolution: leftmost root recovered through any chained call; only a known
      // Capitalized entity resolves ('unknown' when the root can't be recovered — never fabricated).
      let entityName = 'unknown';
      let entityId: string | undefined;
      if (root && rootIsKnownModel) {
        entityName = root;
        entityId = entityIdByName.get(root);
      }
      // BR-4: a recovered receiver root that names no in-repo model is out of scope; an
      // unrecoverable root stays in scope and unbound. `boundDbOps` is counted from the
      // emitted ops below, not here — two identical calls on one line dedup to ONE op.
      if (!entityId && root && !rootIsKnownModel) stats.outOfScopeDbOps++;

      const startLine = call.startPosition.row + 1;
      const details = (call.text as string).slice(0, 200);
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
        functions.set(
          performerId,
          makeFunctionNode(idGen, performerId, defNameText, kind, relPath, def.startPosition.row + 1),
        );
      }
    }

    // Raw-SQL lane: declared query functions (`sync_execute(QUERY, params)`). Separate from the
    // ORM walk above because the site rule is a CALLEE NAME, not the Manager/queryset grammar.
    if (rawMatchers.length > 0)
      rawQueryOps(file, rawMatchers, entityIdByName, idGen, dbOperations, functions, seen, stats);
  }

  // BR-4: bound = an EMITTED operation that resolved an entity id. Read back from the output
  // (as Go and Zig do) rather than tallied in the walk, so a site the dedup key collapses is
  // counted once — a loop counter reported 2 bound where 1 op shipped.
  stats.boundDbOps = dbOperations.filter((o) => o.entityId !== undefined).length;
  return { dbOperations, functions: [...functions.values()], stats };
}
