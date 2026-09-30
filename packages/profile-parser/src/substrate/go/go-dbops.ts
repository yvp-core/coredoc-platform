/**
 * Go DB-OPERATION extraction — sqlc query methods, raw `database/sql`/pgx/sqlx SQL and GORM chains
 * → `DbOperation[]`. Each matched site's performer is the enclosing func/method/closure (a
 * synthesized `FunctionNode` comes back in `functions` so the performer has a node even when the
 * call-graph lane didn't emit one).
 *
 * Three lanes, tried in that order per call site so one call never yields two ops:
 *
 *   1. **sqlc** — the lane that pays. sqlc reads `*.sql` files of the form
 *      `-- name: ListUsersByWorkspace :many` + a statement, and generates one Go method per query.
 *      Reading those files gives `queryName → (op, table)` from REAL SQL, and every call site whose
 *      selector ends in a known query name (`q.ListUsersByWorkspace(ctx, id)`) is then a db-op with
 *      a real table, attributed to the function that made the call. Nothing about it is hardcoded:
 *      the vocabulary comes from the repo's own `.sql` files.
 *   2. **Raw SQL** — `pool.Exec(ctx, "UPDATE users …")`, `db.QueryContext`, `tx.Exec`, `sqlx.Get`,
 *      `sqlx.NamedExec`, `gorm.Raw`. The argument carries REAL SQL, so it goes through `parseSqlOp`
 *      (the engine's own SQL reader, reused rather than rewritten) exactly like Rust's sqlx-macro
 *      lane. Multi-line SQL is a backticked `raw_string_literal`, which is why every string here is
 *      read with `goStringValue` — see the trap it documents.
 *   3. **GORM** — `db.Model(&User{}).Where(…).Find(&users)`, `db.Create(&User{…})`,
 *      `db.Table("users").Updates(…)`.
 *
 * **The GORM lane's table gate is mandatory, not an optimization.** `Find`, `First`, `Count`,
 * `Create`, `Save`, `Delete` and `Scan` are ordinary Go method names — `rows.Scan(&a, &b)` is in
 * every `database/sql` loop and `cache.Delete(k)` in every cache wrapper — so a verb-name-only rule
 * emits thousands of db-ops against `entityName: 'unknown'` (Rust documents the identical hazard
 * for iterator verbs). A GORM verb counts only when the chain names a table: a `.Model(&X{})` /
 * `.Table("x")` segment, or the verb's own composite-literal argument (`Create(&User{…})`). A model
 * passed as a plain variable (`db.Create(&u)`) names nothing the CST can read and is skipped — a
 * Tier-B gap that would need type inference, not a guess.
 *
 * Raw-SQL verbs are gated the other way round, on the verb: a string that parses as SQL is
 * unambiguous, but scanning EVERY call for one would attribute `fmt.Sprintf("SELECT …")` and log
 * lines as db-ops. A repo-specific executor wrapper is added through `cfg.methods`.
 *
 * Entity resolution never fabricates: a table that no entity in the index answers to yields
 * `entityId: undefined` (Rust's `audit_log` case), and a site with NO readable op AND no table is
 * dropped rather than emitted as noise.
 */
import { readFileSync } from 'node:fs';
import type { DbOperation, DbOpResolutionStats, DbOperationType, FunctionNode, StableIdGenerator } from '@coredoc/core';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { parseSqlOp, snakeCase } from '../engine/text-helpers.js';
import { globMatches } from '../glob.js';
import {
  ASSIGNMENT_STATEMENT,
  CALL_EXPRESSION,
  COMPOSITE_LITERAL,
  CONST_DECLARATION,
  CONST_SPEC,
  EXPRESSION_LIST,
  type GoFile,
  IDENTIFIER,
  METHOD_DECLARATION,
  SELECTOR_EXPRESSION,
  SHORT_VAR_DECLARATION,
  STRING_LITERAL_TYPES,
  type TsNode,
  VAR_DECLARATION,
  VAR_SPEC,
  baseTypeName,
  enclosingFunction,
  goDeclName,
  goFunctionId,
  goStringValue,
  namedChildrenOfType,
} from './go-cst.js';

export interface GoDbOpConfig {
  /** Canonical id generator (seeded for this repo) — mints performer/db-op/function ids. */
  idGen: StableIdGenerator;
  /**
   * Extra db verbs. Each entry joins BOTH the raw-SQL executor set (so a repo's own executor
   * wrapper has its SQL argument read) and — classified `'query'` when it isn't already a known
   * verb — the ORM verb map, where the table gate still applies.
   */
  methods?: string[];
  /** Where sqlc's annotated query files live. */
  sqlcQueryGlobs?: string[];
  /** Repo root, for reading the sqlc query files. Omitted ⇒ the sqlc lane is silent. */
  repoRoot?: string;
}

/**
 * Verbs whose string argument is real SQL: `database/sql` (pgx mirrors the same names), `sqlx`, and
 * GORM's raw escape hatches. The operation is never taken from the verb — it is read out of the SQL
 * — so this set only answers "could one of this call's arguments be a query".
 */
const DEFAULT_GO_SQL_VERBS: string[] = [
  // database/sql + pgx
  'Exec',
  'ExecContext',
  'Query',
  'QueryContext',
  'QueryRow',
  'QueryRowContext',
  'Prepare',
  'PrepareContext',
  // sqlx
  'Get',
  'GetContext',
  'Select',
  'SelectContext',
  'Queryx',
  'QueryxContext',
  'QueryRowx',
  'QueryRowxContext',
  'NamedExec',
  'NamedExecContext',
  'NamedQuery',
  'NamedQueryContext',
  'MustExec',
  'MustExecContext',
  // gorm raw
  'Raw',
];

/**
 * Default GORM verb → operation map. Only CHAIN-TERMINAL verbs are listed: the builders (`Model`,
 * `Table`, `Where`, `Joins`, `Preload`, `Order`, `Limit`, `Select`, `Omit`) are what the gate reads,
 * and mapping them too would emit a second op for the same statement. `Select` is deliberately
 * absent — GORM's `.Select("id")` is a projection while sqlx's `Select(&dst, "SELECT …")` is an
 * executor, and the raw-SQL lane already covers the one that carries a query.
 *
 * `Save` is GORM's upsert; a single `DbOperationType` cannot be both, so it collapses onto `update`
 * (the Rust map makes the same call).
 */
const DEFAULT_GO_ORM_OP_MAP: Record<string, DbOperationType> = {
  // read
  Find: 'read',
  FindInBatches: 'read',
  First: 'read',
  Last: 'read',
  Take: 'read',
  Count: 'read',
  Pluck: 'read',
  Scan: 'read',
  // create
  Create: 'create',
  CreateInBatches: 'create',
  FirstOrCreate: 'create',
  // update
  Save: 'update',
  Update: 'update',
  Updates: 'update',
  UpdateColumn: 'update',
  UpdateColumns: 'update',
  // delete
  Delete: 'delete',
};

/**
 * Where sqlc query files live by convention (`db/queries/*.sql`, `internal/query/*.sql`).
 * Depth-agnostic on purpose: in a multi-module Go repo they sit under the owning module, so a
 * root-anchored glob finds nothing.
 */
const DEFAULT_SQLC_QUERY_GLOBS: string[] = ['**/queries/**/*.sql', '**/query/**/*.sql'];

/** `-- name: GetUser :one` — sqlc's query annotation, the only marker its query files carry. */
const SQLC_NAME_DIRECTIVE = /^[^\S\n]*--[^\S\n]*name:[^\S\n]*(\w+)/gm;

/** `&User{}` wraps its composite literal in this node type, which go-cst has no constant for. */
const UNARY_EXPRESSION = 'unary_expression';

/** The name a package-scope db-op site is attributed to — Go really does run those in `init`. */
const PACKAGE_INIT_NAME = 'init';

/** One sqlc query: what its SQL does, and the SQL itself for the op's `details`. */
interface SqlcQuery {
  operation: DbOperationType;
  entity: string;
  sql: string;
}

// =============================================================================
// Call-site shape helpers
// =============================================================================

/** The method/function name a call invokes: the selector's final field, else a bare identifier. */
function calleeName(call: TsNode): string | undefined {
  const fn = call?.childForFieldName?.('function') as TsNode | undefined;
  if (fn?.type === SELECTOR_EXPRESSION) return fn.childForFieldName?.('field')?.text as string | undefined;
  if (fn?.type === IDENTIFIER) return fn.text as string | undefined;
  return undefined;
}

/**
 * The final field of a SELECTOR callee, and only that.
 *
 * sqlc query methods always hang off a `*Queries` value (`q.ListUsers(ctx)`, `s.q.ListUsers(ctx)`),
 * so requiring the selector form keeps a same-named local function from being read as a query.
 */
function calleeSelectorField(call: TsNode): string | undefined {
  const fn = call?.childForFieldName?.('function') as TsNode | undefined;
  return fn?.type === SELECTOR_EXPRESSION ? (fn.childForFieldName?.('field')?.text as string | undefined) : undefined;
}

/** The call's nth positional argument node. */
function argAt(call: TsNode, index: number): TsNode | undefined {
  return call?.childForFieldName?.('arguments')?.namedChild?.(index) as TsNode | undefined;
}

/**
 * The model type an argument names: `&User{}` / `User{}` / `&[]db.User{}` → 'User'.
 *
 * Only a COMPOSITE LITERAL names a type in the CST. `db.Create(&u)` passes a variable, whose type
 * lives in a declaration this substrate does not track — that is the Tier-B gap the gate documents,
 * and returning undefined is what keeps it from being guessed at.
 */
function modelTypeOfArg(arg: TsNode | undefined): string | undefined {
  const inner = arg?.type === UNARY_EXPRESSION ? (arg.childForFieldName?.('operand') as TsNode | undefined) : arg;
  if (inner?.type !== COMPOSITE_LITERAL) return undefined;
  return baseTypeName(inner.childForFieldName?.('type')?.text as string | undefined);
}

/** What a GORM chain says about the table it operates on. */
interface ChainTable {
  /** Type name from a `.Model(&X{})` segment. */
  modelType?: string;
  /** Literal from a `.Table("x")` segment. */
  tableLiteral?: string;
}

/**
 * Walk a receiver chain leftwards, recording the table GORM's builders name.
 *
 * The walk runs outermost-first, so the LAST `.Model(…)` / `.Table(…)` written in the chain is seen
 * first — which is also the one GORM itself honours when a chain names a table twice.
 */
function chainTable(node: TsNode | undefined | null): ChainTable {
  const info: ChainTable = {};
  let cur: TsNode | undefined | null = node;
  while (cur) {
    if (cur.type === CALL_EXPRESSION) {
      const name = calleeName(cur);
      if (name === 'Model' && !info.modelType) info.modelType = modelTypeOfArg(argAt(cur, 0));
      else if (name === 'Table' && !info.tableLiteral) info.tableLiteral = firstStringArg(cur);
      cur = cur.childForFieldName?.('function');
      continue;
    }
    if (cur.type === SELECTOR_EXPRESSION) {
      cur = cur.childForFieldName?.('operand');
      continue;
    }
    return info;
  }
  return info;
}

/** The first string-literal argument of a call, as a value. */
function firstStringArg(call: TsNode): string | undefined {
  const args = call?.childForFieldName?.('arguments') as TsNode | undefined;
  const n = args?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const a = args.namedChild(i) as TsNode | undefined;
    if (a && STRING_LITERAL_TYPES.has(a.type)) return goStringValue(a);
  }
  return undefined;
}

// =============================================================================
// String bindings — the `const q = "SELECT …"` indirection
// =============================================================================

/**
 * The (names, values) a binding node pairs up. `a, b := "x", "y"` and `const a, b = "x", "y"` pair
 * positionally, which is why both sides are returned as lists rather than a single name.
 */
function bindingPairs(node: TsNode): { names: TsNode[]; values: TsNode[] } | undefined {
  if (node.type === SHORT_VAR_DECLARATION || node.type === ASSIGNMENT_STATEMENT) {
    const left = node.childForFieldName?.('left') as TsNode | undefined;
    const right = node.childForFieldName?.('right') as TsNode | undefined;
    if (!left || !right) return undefined;
    return { names: namedChildrenOfType(left, IDENTIFIER), values: childList(right) };
  }
  if (node.type === VAR_SPEC || node.type === CONST_SPEC) {
    const value = node.childForFieldName?.('value') as TsNode | undefined;
    if (!value) return undefined;
    return { names: namedChildrenOfType(node, IDENTIFIER), values: childList(value) };
  }
  return undefined;
}

/** An `expression_list`'s elements, or the node itself when a single expression stands alone. */
function childList(node: TsNode): TsNode[] {
  if (node.type !== EXPRESSION_LIST) return [node];
  const out: TsNode[] = [];
  const n = node.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) out.push(node.namedChild(i));
  return out;
}

/** Collect `name → string value` from binding nodes. FIRST binding wins (see `stringBindings`). */
function collectBindings(nodes: TsNode[], into: Map<string, string>): void {
  for (const node of nodes) {
    const pair = bindingPairs(node);
    if (!pair) continue;
    for (let i = 0; i < pair.names.length; i++) {
      const name = pair.names[i]?.text as string | undefined;
      const value = pair.values[i];
      if (!name || name === '_' || into.has(name) || !value || !STRING_LITERAL_TYPES.has(value.type)) continue;
      const text = goStringValue(value);
      if (text !== undefined) into.set(name, text);
    }
  }
}

/**
 * String bindings visible at a call site: the enclosing function's own, then its package's.
 *
 * `db.QueryRow(ctx, getUserQuery, id)` with `const getUserQuery = ` + backticked SQL is the standard
 * `database/sql` / sqlx spelling — and it is exactly what sqlc's OWN generated code emits, so
 * without this indirection the raw-SQL lane finds almost nothing in a real Go repo. Package scope is
 * consulted second because Go has no per-file scope: a const declared in `queries.go` is visible
 * unqualified in `repo.go` of the same directory (`go-imports.ts` documents the same rule).
 *
 * Only the FIRST binding of a name is kept — the four binding node types are merged back into SOURCE
 * ORDER first, so "first" means the earliest one written rather than an artifact of which type was
 * scanned first. A query string rebound per branch therefore reports the first branch: one of the
 * two statements, never a merged fiction.
 */
function stringBindings(call: TsNode, packageStrings: Map<string, string>): Map<string, string> {
  const fn = enclosingFunction(call);
  const local = new Map<string, string>();
  if (fn) {
    const nodes = [
      ...(fn.descendantsOfType?.(SHORT_VAR_DECLARATION) ?? []),
      ...(fn.descendantsOfType?.(ASSIGNMENT_STATEMENT) ?? []),
      ...(fn.descendantsOfType?.(VAR_SPEC) ?? []),
      ...(fn.descendantsOfType?.(CONST_SPEC) ?? []),
    ] as TsNode[];
    nodes.sort((a, b) => (a.startIndex as number) - (b.startIndex as number));
    collectBindings(nodes, local);
  }
  for (const [k, v] of packageStrings) if (!local.has(k)) local.set(k, v);
  return local;
}

/** Package-scope string constants/vars of one file: the DIRECT `const`/`var` children of the root. */
function packageScopeStrings(file: GoFile): Map<string, string> {
  const out = new Map<string, string>();
  const root = file.root;
  const n = root?.namedChildCount ?? 0;
  const specs: TsNode[] = [];
  for (let i = 0; i < n; i++) {
    const decl = root.namedChild(i) as TsNode | undefined;
    if (decl?.type !== CONST_DECLARATION && decl?.type !== VAR_DECLARATION) continue;
    specs.push(...((decl.descendantsOfType?.(CONST_SPEC) ?? []) as TsNode[]));
    specs.push(...((decl.descendantsOfType?.(VAR_SPEC) ?? []) as TsNode[]));
  }
  collectBindings(specs, out);
  return out;
}

/** dirname of a repo-relative path ('' at the repo root) — a Go package IS a directory. */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

// =============================================================================
// sqlc query files
// =============================================================================

/**
 * Parse one sqlc query file into `queryName → (op, table, sql)`.
 *
 * A query body runs from its `-- name:` line to the next one (or EOF); leading comment lines are
 * dropped so `parseSqlOp` sees the statement itself. A query whose statement it cannot read — a
 * `WITH …` CTE, a `TRUNCATE`, a stored-procedure call — contributes NOTHING rather than a guessed
 * table, so its call sites simply do not appear.
 */
function parseSqlcQueries(text: string): Map<string, SqlcQuery> {
  const out = new Map<string, SqlcQuery>();
  const re = new RegExp(SQLC_NAME_DIRECTIVE);
  const marks: { name: string; bodyStart: number; markStart: number }[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    marks.push({ name: m[1], bodyStart: m.index + m[0].length, markStart: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].markStart : text.length;
    const body = text.slice(marks[i].bodyStart, end);
    const nl = body.indexOf('\n');
    // Drop the rest of the annotation line (` :many`) and any leading comment lines.
    const sql = (nl === -1 ? '' : body.slice(nl + 1)).replace(/^(?:[^\S\n]*--[^\n]*\n)+/, '');
    const parsed = parseSqlOp(sql);
    if (!parsed || out.has(marks[i].name)) continue;
    out.set(marks[i].name, { operation: parsed.op, entity: parsed.entity.toLowerCase(), sql });
  }
  return out;
}

/** Read every sqlc query file under `globs` into one index. Sorted for deterministic first-wins. */
function buildSqlcIndex(repoRoot: string, globs: string[]): Map<string, SqlcQuery> {
  const index = new Map<string, SqlcQuery>();
  for (const rel of enumerateRepoFiles(repoRoot)
    .filter((r) => r.endsWith('.sql') && globMatches(r, globs))
    .sort()) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, 'utf-8');
    } catch {
      continue;
    }
    for (const [name, query] of parseSqlcQueries(text)) if (!index.has(name)) index.set(name, query);
  }
  return index;
}

// =============================================================================
// Emission
// =============================================================================

/** A synthesized minimal-valid `FunctionNode` for the performer. */
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

/** Query/model text for `details`: whitespace collapsed (Go SQL is multi-line) and capped. */
function condense(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Naive plural of a snake_cased table stem — a LOOKUP candidate only, never an emitted name. */
function pluralize(name: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

export function extractGoDbOps(
  files: GoFile[],
  tableNames: Set<string>,
  entityIdByName: Map<string, string>,
  cfg: GoDbOpConfig,
): { dbOperations: DbOperation[]; functions: FunctionNode[]; stats: DbOpResolutionStats } {
  const idGen = cfg.idGen;
  const extras = cfg.methods ?? [];
  const sqlVerbs = new Set<string>([...DEFAULT_GO_SQL_VERBS, ...extras]);
  // Null-prototype: the verb is a source-derived string, so a plain object literal would answer
  // `opMap['constructor']` with `Object` — truthy, not a DbOperationType — and emit a db-op whose
  // `operation` is a function.
  const ormOps: Record<string, DbOperationType> = Object.assign(Object.create(null), DEFAULT_GO_ORM_OP_MAP);
  for (const m of extras) if (!(m in ormOps)) ormOps[m] = 'query';

  const sqlcIndex = cfg.repoRoot
    ? buildSqlcIndex(cfg.repoRoot, cfg.sqlcQueryGlobs ?? DEFAULT_SQLC_QUERY_GLOBS)
    : new Map<string, SqlcQuery>();

  // Package scope is a DIRECTORY, not a file: a const declared in `queries.go` is visible
  // unqualified from `repo.go` next to it.
  const packageStringsByDir = new Map<string, Map<string, string>>();
  for (const file of files) {
    const dir = dirOf(file.relPath);
    const bucket = packageStringsByDir.get(dir) ?? new Map<string, string>();
    for (const [k, v] of packageScopeStrings(file)) if (!bucket.has(k)) bucket.set(k, v);
    packageStringsByDir.set(dir, bucket);
  }

  const dbOperations: DbOperation[] = [];
  const functions = new Map<string, FunctionNode>();
  const seen = new Set<string>();

  /**
   * The db-op resolution record (spec BR-4/LIM-4), counted in SITES at each sub-lane's own
   * enumeration point: a sqlc query-name hit, an executor call carrying readable SQL, and a GORM
   * chain that names a table. A GORM VERB alone is not a candidate — `rows.Scan` and
   * `cache.Delete` are ordinary Go methods (see the table gate above), so counting them would
   * invent thousands of sites this lane never claimed.
   *
   * Out of scope is a `resolveEntity` miss: a table token that answers to neither an entity nor a
   * declared table. A KNOWN table with no entity behind it is IN scope and unbound — the third
   * bucket, which is why `bound + outOfScope < sites` on Go.
   */
  const stats: DbOpResolutionStats = { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 };
  const countSite = (resolved: { entityName: string; entityId?: string }): void => {
    stats.dbOpSites++;
    if (!resolved.entityId && !tableNames.has(resolved.entityName)) stats.outOfScopeDbOps++;
  };

  /**
   * The name/id a table-ish token resolves to. Candidates are tried in order and the one that HITS
   * becomes the emitted name, so a GORM model and a SQL statement that mean the same table land on
   * one entity. A miss falls back to the FIRST candidate — the spelling the source actually wrote —
   * because guessing for a lookup is free (a hit proves the guess) while guessing the emitted name
   * would fabricate a table that no file declares.
   */
  const resolveEntity = (candidates: string[]): { entityName: string; entityId?: string } => {
    for (const c of candidates) {
      const id = entityIdByName.get(c);
      if (id) return { entityName: c, entityId: id };
    }
    for (const c of candidates) if (tableNames.has(c)) return { entityName: c };
    return { entityName: candidates[0] };
  };

  /** Record one op at `node`, minting the performer node on demand. */
  const record = (
    file: GoFile,
    node: TsNode,
    operation: DbOperationType,
    entityName: string,
    entityId: string | undefined,
    details: string,
  ): void => {
    const relPath = file.relPath;
    const fn = enclosingFunction(node);
    // A package-scope site (`var stmt = db.Prepare("…")`) has no enclosing func, but Go really does
    // execute it — at init time. Attributing it to a file-level `init` performer keeps it in the
    // graph instead of dropping it; the id deliberately collides with a declared `func init()` in
    // the same file, which runs at the same moment.
    const performerId = fn ? goFunctionId(idGen, relPath, fn) : idGen.functionId(relPath, PACKAGE_INIT_NAME);
    const startLine = node.startPosition.row + 1;
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
      const kind: FunctionNode['kind'] = fn?.type === METHOD_DECLARATION ? 'method' : 'function';
      const name = fn ? goDeclName(fn) : PACKAGE_INIT_NAME;
      const line = fn ? fn.startPosition.row + 1 : startLine;
      functions.set(performerId, makeFunctionNode(idGen, performerId, name, kind, relPath, line));
    }
  };

  for (const file of files) {
    const packageStrings = packageStringsByDir.get(dirOf(file.relPath)) ?? new Map<string, string>();
    // One binding scan per enclosing function, not per call site: a repository file is one long
    // method with a dozen executor calls, and each scan walks that whole subtree four times.
    // Keyed on the tree-sitter node id, which is stable for the lifetime of this file's tree.
    const bindingsByFn = new Map<number, Map<string, string>>();
    const bindingsAt = (call: TsNode): Map<string, string> => {
      const key = (enclosingFunction(call)?.id ?? -1) as number;
      const cached = bindingsByFn.get(key);
      if (cached) return cached;
      const built = stringBindings(call, packageStrings);
      bindingsByFn.set(key, built);
      return built;
    };

    for (const call of (file.root?.descendantsOfType?.(CALL_EXPRESSION) ?? []) as TsNode[]) {
      // --- Lane 1: sqlc — a call whose selector names one of the repo's own queries ---
      const queryName = calleeSelectorField(call);
      const query = queryName ? sqlcIndex.get(queryName) : undefined;
      if (query) {
        const resolved = resolveEntity([query.entity]);
        countSite(resolved);
        record(file, call, query.operation, resolved.entityName, resolved.entityId, condense(query.sql));
        continue;
      }

      const verb = calleeName(call);
      if (!verb) continue;

      // --- Lane 2: raw SQL passed to a known executor ---
      if (sqlVerbs.has(verb)) {
        const found = sqlArgOf(call, () => bindingsAt(call));
        if (found) {
          const resolved = resolveEntity([found.parsed.entity.toLowerCase()]);
          countSite(resolved);
          record(file, call, found.parsed.op, resolved.entityName, resolved.entityId, condense(found.sql));
          continue;
        }
      }

      // --- Lane 3: GORM verbs, behind the table gate ---
      const operation = ormOps[verb];
      if (!operation) continue;
      const table = chainTable(call.childForFieldName?.('function'));
      const modelType = table.modelType ?? modelTypeOfArg(argAt(call, 0));
      // No `.Model(…)`, no `.Table(…)`, no composite-literal model: this is an ordinary Go method
      // call that happens to share a GORM verb's name.
      if (!table.tableLiteral && !modelType) continue;
      // GORM's real table name comes from `TableName()` or the naming strategy, neither of which is
      // readable here; snake_case and its plural are tried as lookup candidates only.
      const candidates = table.tableLiteral
        ? [table.tableLiteral.toLowerCase()]
        : [modelType as string, snakeCase(modelType as string), pluralize(snakeCase(modelType as string))];
      const resolved = resolveEntity(candidates);
      countSite(resolved);
      record(file, call, operation, resolved.entityName, resolved.entityId, condense(call.text as string));
    }
  }

  // Read back from the EMITTED ops, never a loop counter: `record` dedupes identical sites.
  stats.boundDbOps = dbOperations.filter((o) => o.entityId).length;
  return { dbOperations, functions: [...functions.values()], stats };
}

/**
 * The SQL an executor call carries, already parsed: the first argument that is a string literal, or
 * an identifier bound to one, whose text `parseSqlOp` can actually read.
 *
 * "Parses as SQL" is the real gate — a `ctx` first argument, a `&dest` destination and a trailing
 * `id` are all ordinary arguments of the same executors, and `Exec(ctx, "x")` is not a db op. The
 * `bindings` thunk keeps the (function-wide) binding scan from running for calls that never pass an
 * identifier where SQL is expected.
 */
function sqlArgOf(
  call: TsNode,
  bindings: () => Map<string, string>,
): { sql: string; parsed: NonNullable<ReturnType<typeof parseSqlOp>> } | undefined {
  const args = call?.childForFieldName?.('arguments') as TsNode | undefined;
  const n = args?.namedChildCount ?? 0;
  let table: Map<string, string> | undefined;
  for (let i = 0; i < n; i++) {
    const a = args.namedChild(i) as TsNode | undefined;
    if (!a) continue;
    let sql: string | undefined;
    if (STRING_LITERAL_TYPES.has(a.type)) {
      sql = goStringValue(a);
    } else if (a.type === IDENTIFIER) {
      table ??= bindings();
      sql = table.get(a.text as string);
    }
    if (!sql) continue;
    const parsed = parseSqlOp(sql);
    if (parsed) return { sql, parsed };
  }
  return undefined;
}
