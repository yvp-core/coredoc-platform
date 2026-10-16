/**
 * Per-file `use` table + repo module index — the backbone every other Rust tier resolves
 * through (calls, entity references, egress client detection).
 *
 * Three rules here are cheap to get wrong and expensive to debug, because each fails SILENTLY
 * into an empty resolution table:
 *
 *   1. The `moduleDir` asymmetry. For a file `F` declaring `mod foo;`, the child is
 *      `moduleDir(F)/foo.rs` or `moduleDir(F)/foo/mod.rs`, where `moduleDir(F)` is `dirname(F)`
 *      when `basename(F)` ∈ {lib.rs, main.rs, mod.rs} and `dirname(F)/stem(F)` otherwise. So
 *      `src/lib.rs` → `src/db.rs`, but `src/db.rs` declaring `mod models;` → `src/db/models.rs`.
 *      A naive `dirname(F)/foo.rs` is right for crate roots and wrong for every 2018-style
 *      `foo.rs` + `foo/` pair — and then the whole module graph is wrong.
 *   2. Cargo `my-api` is `my_api` in code. `[package] name` uses hyphens, `use my_api::…` uses
 *      underscores; both spellings are indexed or every cross-crate `use` fails to resolve.
 *   3. Module paths are derived by WALKING `mod` declarations forward from each crate root, not
 *      from file paths. A `.rs` file that no `mod` declares is not part of the crate, and giving
 *      it a path-derived name invents a module path no `use` will ever match. Files the walk
 *      never reaches still get a path-derived name registered NON-AUTHORITATIVELY (the same
 *      second-pass trick `python-imports.ts` uses: an extra key can only ever resolve an import
 *      that would otherwise have been dropped).
 *
 * `use foo::*` glob imports are COUNTED and never bound, exactly as Python treats star imports.
 * Anchor `#[program]` mods contain `use super::*;` universally and diesel's
 * `use schema::users::dsl::*;` is how bare table names come into scope — which is precisely why
 * the db-op gate matches against known table names instead of trying to resolve the glob.
 */
import { type RustCrate, crateCodeName, crateOwnerPath } from './rust-crates.js';
import { MOD_ITEM, type RustFile, type TsNode, itemName } from './rust-cst.js';
import { repoDir } from '../glob.js';

/** One name bound into a file's namespace by a `use`. */
export interface UseBinding {
  /** The name bound in this file's namespace (the alias when `as` is used). */
  local: string;
  /** The full path as written, e.g. 'crate::db::models::User' — head not yet absolutized. */
  path: string;
  /**
   * The INLINE `mod` names enclosing the `use` statement.
   *
   * `self`/`super` are resolved against the lexical module, not the file: a `use super::*;`
   * written inside `mod prog { … }` in `lib.rs` means the CRATE ROOT, while the same line at
   * the top of that file would mean the crate root's parent (i.e. nothing). Anchor's
   * `#[program]` mods contain exactly that inner `use super::*;`, so ignoring the scope
   * resolves it one level too high and the whole delegation hop is lost.
   */
  scope: string[];
}

/** A `use m::*` site: it binds no name, but its own module path and lexical scope are known. */
export interface GlobImport {
  path: string;
  scope: string[];
}

/** A file's resolved `use` table. */
export interface UseTable {
  /** local name → binding (first wins; a later shadowing `use` is a rare, deliberate drop). */
  byLocal: Map<string, UseBinding>;
  /** `use m::*` sites — counted, never bound to a NAME (a Tier-B blind spot, surfaced in stats). */
  globCount: number;
  /**
   * The glob imports, with their module paths (`use super::*` → 'super').
   *
   * A glob never binds a name — we cannot know what it brought in. But a glob's own path IS
   * written down, so a `mod::fn()` call whose head is otherwise unbound can be tried under it:
   * either `<globPath>::<head>` is a real module in the index or it is not, which is a lookup,
   * not a guess. This is what resolves the universal Anchor shape — a `#[program]` mod contains
   * `use super::*;` and its instruction bodies delegate one hop via `instructions::foo(ctx)`.
   */
  globs: GlobImport[];
}

/** The repo-wide module graph. */
export interface ModuleIndex {
  /** absolute module path (`my_crate::db::models`) → repo-relative file. */
  byModule: Map<string, string>;
  /** repo-relative file → its absolute module path (the walk's authoritative naming). */
  moduleOfFile: Map<string, string>;
  /** repo-relative file → its crate's root module name (`my_api`). */
  crateOfFile: Map<string, string>;
}

// =============================================================================
// Per-file `use` table
// =============================================================================

/** The `use` sub-tree's own path text, from the `path` field. */
function pathText(node: TsNode): string {
  return (node?.childForFieldName?.('path')?.text ?? '') as string;
}

/** Last `::` segment of a path — the name a plain `use a::b::C;` binds. */
function tailSegment(path: string): string {
  const i = path.lastIndexOf('::');
  return i === -1 ? path : path.slice(i + 2);
}

/**
 * Walk one `use` argument sub-tree, emitting bindings. Handles the five shapes:
 * `scoped_identifier` / `identifier` (plain), `use_as_clause` (alias), `scoped_use_list`
 * (braced group, arbitrarily nested), `use_list` and `use_wildcard` (counted, never bound).
 */
function collectUseBindings(
  node: TsNode,
  prefix: string,
  scope: string[],
  out: UseBinding[],
  glob: { count: number; imports: GlobImport[] },
): void {
  if (!node) return;
  switch (node.type) {
    case 'use_wildcard': {
      glob.count++;
      // `use a::b::*` → the module path `a::b`; a bare `use *` has none.
      const inner = pathText(node) || ((node.namedChild?.(0)?.text ?? '') as string);
      const full = prefix ? (inner ? `${prefix}::${inner}` : prefix) : inner;
      if (full) glob.imports.push({ path: full, scope });
      return;
    }
    case 'use_as_clause': {
      const p = pathText(node);
      const alias = node.childForFieldName?.('alias')?.text as string | undefined;
      const full = prefix ? `${prefix}::${p}` : p;
      if (alias) out.push({ local: alias, path: full, scope });
      return;
    }
    case 'scoped_use_list': {
      const p = pathText(node);
      const next = prefix ? `${prefix}::${p}` : p;
      const list = node.childForFieldName?.('list') as TsNode | undefined;
      const n = list?.namedChildCount ?? 0;
      for (let i = 0; i < n; i++) collectUseBindings(list.namedChild(i), next, scope, out, glob);
      return;
    }
    case 'use_list': {
      const n = node.namedChildCount ?? 0;
      for (let i = 0; i < n; i++) collectUseBindings(node.namedChild(i), prefix, scope, out, glob);
      return;
    }
    case 'self': {
      // `use foo::{self, Bar}` binds `foo` itself.
      if (prefix) out.push({ local: tailSegment(prefix), path: prefix, scope });
      return;
    }
    default: {
      // scoped_identifier / identifier / crate / super — a plain path binding its tail.
      const text = (node.text ?? '') as string;
      if (!text) return;
      const full = prefix ? `${prefix}::${text}` : text;
      out.push({ local: tailSegment(text), path: full, scope });
    }
  }
}

/** The INLINE `mod` names enclosing a node, outermost first (all in-file by definition). */
function inlineModScope(node: TsNode): string[] {
  const chain: string[] = [];
  let cur: TsNode | null = node?.parent ?? null;
  while (cur) {
    if (cur.type === MOD_ITEM) {
      const n = itemName(cur);
      if (n) chain.unshift(n);
    }
    cur = cur.parent;
  }
  return chain;
}

/**
 * One `use` table per parsed file, memoized on the `RustFile` object.
 *
 * Three lanes need the same table — the call resolver, the egress client gate and the import
 * stats — and each was re-walking every `use_declaration` in the file, which contradicts the
 * substrate's own "each file is parsed ONCE and its CST root is reused across every extractor"
 * rule. Keyed on object identity rather than `relPath`, so a re-parse (a new `RustFile`) can
 * never read a stale table and the entry is collectable with the tree.
 */
const USE_TABLE_CACHE = new WeakMap<RustFile, UseTable>();

/** A file's resolved `use` table. Built on first call, reused by every later one. */
export function buildUseTable(file: RustFile): UseTable {
  const cached = USE_TABLE_CACHE.get(file);
  if (cached) return cached;
  const table = computeUseTable(file);
  USE_TABLE_CACHE.set(file, table);
  return table;
}

/** Build a file's `use` table (one CST walk). */
function computeUseTable(file: RustFile): UseTable {
  const byLocal = new Map<string, UseBinding>();
  const glob = { count: 0, imports: [] as GlobImport[] };
  for (const decl of file.root.descendantsOfType('use_declaration') as TsNode[]) {
    const arg = decl.childForFieldName?.('argument') as TsNode | undefined;
    const bindings: UseBinding[] = [];
    collectUseBindings(arg, '', inlineModScope(decl), bindings, glob);
    for (const b of bindings) if (!byLocal.has(b.local)) byLocal.set(b.local, b);
  }
  const seen = new Set<string>();
  const globs = glob.imports.filter((g) => {
    const key = `${g.scope.join('::')}|${g.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { byLocal, globCount: glob.count, globs };
}

// =============================================================================
// Module index — walk `mod` declarations forward from each crate root
// =============================================================================

/** Basenames that make a file its directory's module root rather than a submodule. */
const ROOT_BASENAMES = new Set(['lib.rs', 'main.rs', 'mod.rs']);

/** basename of a repo-relative path. */
function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/**
 * The directory a file's `mod foo;` declarations resolve against. `lib.rs`/`main.rs`/`mod.rs`
 * own their OWN directory; any other `foo.rs` owns the sibling `foo/` directory. See rule 1.
 */
export function moduleDir(rel: string): string {
  const dir = repoDir(rel);
  const base = baseOf(rel);
  if (ROOT_BASENAMES.has(base)) return dir;
  const stem = base.replace(/\.rs$/, '');
  return dir ? `${dir}/${stem}` : stem;
}

/** Join a dir + child path, tolerating an empty (repo-root) dir. */
function joinRel(dir: string, child: string): string {
  return dir ? `${dir}/${child}` : child;
}

/** The direct `mod_item` children of an item scope (source_file root or a declaration_list). */
function directModItems(scope: TsNode): TsNode[] {
  const out: TsNode[] = [];
  const n = scope?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = scope.namedChild(i) as TsNode | undefined;
    if (c?.type === MOD_ITEM) out.push(c);
  }
  return out;
}

/** The crate-root source files of a crate, in preference order (lib before main). */
function crateRootFiles(crate: RustCrate, byPath: Map<string, RustFile>): string[] {
  const candidates = [
    joinRel(crate.path === '.' ? '' : crate.path, 'src/lib.rs'),
    joinRel(crate.path === '.' ? '' : crate.path, 'src/main.rs'),
    joinRel(crate.path === '.' ? '' : crate.path, 'lib.rs'),
    joinRel(crate.path === '.' ? '' : crate.path, 'main.rs'),
  ];
  return candidates.filter((c) => byPath.has(c));
}

/**
 * Build the repo module graph by walking `mod` declarations forward from every crate root.
 *
 * An inline `mod m { … }` names a module inside the SAME file and shifts the directory its own
 * `mod` children resolve against (`mod inline { mod sub; }` → `<dir>/inline/sub.rs`), so the
 * walk carries (file, dir, modulePath) rather than just a file.
 */
export function buildModuleIndex(files: RustFile[], crates: RustCrate[]): ModuleIndex {
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const byModule = new Map<string, string>();
  const moduleOfFile = new Map<string, string>();
  const crateOfFile = new Map<string, string>();

  const registerModule = (mod: string, rel: string): void => {
    if (mod && !byModule.has(mod)) byModule.set(mod, rel);
  };

  const walkScope = (
    file: RustFile,
    scope: TsNode,
    dir: string,
    modulePath: string,
    crateRoot: string,
    seen: Set<string>,
  ): void => {
    for (const mod of directModItems(scope)) {
      const name = itemName(mod);
      if (!name) continue;
      const childModule = `${modulePath}::${name}`;
      const body = mod.childForFieldName?.('body') as TsNode | undefined;
      if (body) {
        // Inline module — same file, but its own `mod` children live under `<dir>/<name>/`.
        registerModule(childModule, file.relPath);
        walkScope(file, body, joinRel(dir, name), childModule, crateRoot, seen);
        continue;
      }
      // File-backed module. The ABSENCE of a body is the resolution trigger — not a name
      // convention — so `mod m;` is exactly the declaration that points at another file.
      const candidates = [joinRel(dir, `${name}.rs`), joinRel(dir, `${name}/mod.rs`)];
      const childRel = candidates.find((c) => byPath.has(c));
      if (!childRel || seen.has(childRel)) continue;
      seen.add(childRel);
      const childFile = byPath.get(childRel) as RustFile;
      registerModule(childModule, childRel);
      if (!moduleOfFile.has(childRel)) moduleOfFile.set(childRel, childModule);
      if (!crateOfFile.has(childRel)) crateOfFile.set(childRel, crateRoot);
      walkScope(childFile, childFile.root, moduleDir(childRel), childModule, crateRoot, seen);
    }
  };

  for (const crate of crates) {
    const rootName = crateCodeName(crate.name);
    for (const rel of crateRootFiles(crate, byPath)) {
      const file = byPath.get(rel) as RustFile;
      registerModule(rootName, rel);
      // Cargo's hyphenated spelling can never appear in code, but indexing it too costs
      // nothing and makes a manifest-derived lookup work either way (rule 2).
      registerModule(crate.name, rel);
      if (!moduleOfFile.has(rel)) moduleOfFile.set(rel, rootName);
      if (!crateOfFile.has(rel)) crateOfFile.set(rel, rootName);
      walkScope(file, file.root, moduleDir(rel), rootName, rootName, new Set([rel]));
    }
  }

  // Second pass — files the walk never reached (no `mod` declares them: a `bin/` target, a
  // crate outside any manifest, a module behind `#[cfg]`). A path-derived name is registered
  // NON-AUTHORITATIVELY: it can only ever resolve a path that would otherwise be dropped.
  for (const file of files) {
    if (moduleOfFile.has(file.relPath)) continue;
    const ownerPath = crateOwnerPath(file.relPath, crates);
    const crate = ownerPath !== undefined ? crates.find((c) => c.path === ownerPath) : undefined;
    const rootName = crate ? crateCodeName(crate.name) : '';
    const withoutCrate = crate && crate.path !== '.' ? file.relPath.slice(crate.path.length + 1) : file.relPath;
    const segments = withoutCrate
      .replace(/\.rs$/, '')
      .split('/')
      .filter((s) => s !== 'src' && s !== 'mod');
    const derived = [rootName, ...segments].filter(Boolean).join('::');
    if (!derived) continue;
    registerModule(derived, file.relPath);
    moduleOfFile.set(file.relPath, derived);
    if (rootName) crateOfFile.set(file.relPath, rootName);
  }

  return { byModule, moduleOfFile, crateOfFile };
}

// =============================================================================
// Path resolution
// =============================================================================

/** A resolved path target: the owning file plus the unresolved tail segments (fn / Type::fn). */
export interface ResolvedPath {
  filePath: string;
  /** Segments beyond the module — `['handler']` for a free fn, `['Repo','new']` for an assoc fn. */
  tail: string[];
  /** Whether resolution went through the file's `use` table (else the path was explicit). */
  viaUse: boolean;
}

/**
 * Absolutize a path's head: `crate` → the file's crate root, `self` → the file's own module,
 * `super` → its parent module. Any other head is already absolute (an external crate name or
 * an in-repo crate name). Returns undefined when the head cannot be anchored.
 */
function absolutize(segments: string[], relPath: string, index: ModuleIndex, scope: string[]): string[] | undefined {
  const head = segments[0];
  if (head !== 'crate' && head !== 'self' && head !== 'super' && head !== '$crate') return segments;
  if (head === 'crate' || head === '$crate') {
    const crateRoot = index.crateOfFile.get(relPath);
    return crateRoot ? [crateRoot, ...segments.slice(1)] : undefined;
  }
  const own = index.moduleOfFile.get(relPath);
  if (!own) return undefined;
  // The LEXICAL module: the file's own module path plus any inline `mod`s around the site.
  const ownSegments = [...own.split('::'), ...scope];
  if (head === 'self') return [...ownSegments, ...segments.slice(1)];
  // `super` — one level up; at a crate root there is no parent, so the path is unresolvable.
  if (ownSegments.length < 2) return undefined;
  return [...ownSegments.slice(0, -1), ...segments.slice(1)];
}

/**
 * Resolve a call path (`f`, `m::f`, `crate::a::b::f`, `Type::assoc`) to the in-repo file that
 * defines it, plus the tail segments the caller still has to match against a def index.
 *
 * Precision-first: only the LONGEST module prefix that is actually in the index resolves, the
 * tail is capped at two segments (`fn` or `Type::fn`), and a path that anchors nowhere returns
 * undefined rather than guessing a file.
 */
export function resolveUseTarget(
  table: UseTable,
  index: ModuleIndex,
  relPath: string,
  path: string,
  callerScope: string[] = [],
): ResolvedPath | undefined {
  const written = path.split('::').filter(Boolean);
  if (written.length === 0) return undefined;

  const binding = table.byLocal.get(written[0]);
  if (binding) {
    // The head is a `use`-bound local: substitute the bound path and keep the rest. `self`/
    // `super` in the BINDING resolve against the `use` statement's own lexical scope.
    const segments = [...binding.path.split('::'), ...written.slice(1)];
    return lookupPath(segments, relPath, index, true, binding.scope);
  }

  // An explicit path (`crate::a::f`, `super::f`, `some_crate::f`) resolves against the CALL
  // SITE's lexical scope.
  const direct = lookupPath(written, relPath, index, false, callerScope);
  if (direct) return direct;

  // The head named no binding and no in-repo module of its own. If the file has a glob import,
  // the glob's own MODULE PATH is written down, so the head can be tried under it — a lookup
  // that either hits a real module or does not, never a guess.
  for (const g of table.globs) {
    const hit = lookupPath([...g.path.split('::'), ...written], relPath, index, true, g.scope);
    if (hit) return hit;
  }
  return undefined;
}

/** Absolutize a segment list and resolve its longest in-index module prefix. */
function lookupPath(
  segments: string[],
  relPath: string,
  index: ModuleIndex,
  viaUse: boolean,
  scope: string[],
): ResolvedPath | undefined {
  const absolute = absolutize(segments, relPath, index, scope);
  if (!absolute || absolute.length === 0) return undefined;
  // Longest module prefix wins; the remaining 1–2 segments are the symbol (fn, or Type::fn).
  for (let cut = absolute.length - 1; cut >= 1; cut--) {
    const tail = absolute.slice(cut);
    if (tail.length > 2) break;
    const file = index.byModule.get(absolute.slice(0, cut).join('::'));
    if (file) return { filePath: file, tail, viaUse };
  }
  return undefined;
}
