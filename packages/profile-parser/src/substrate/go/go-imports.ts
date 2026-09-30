/**
 * Per-file import table + the repo's own package index — the backbone every other Go lane resolves
 * through (calls, entity references, egress client detection).
 *
 * Go's model is far simpler than Rust's `mod` tree and is deliberately NOT built up into one:
 *
 *   1. There is no per-file module scope. The PACKAGE (= one directory) is the unit, so every
 *      top-level identifier declared in `a.go` is visible UNQUALIFIED in `b.go` of the same
 *      directory. Nothing needs resolving for those — a same-directory lookup is the answer.
 *   2. Every cross-package reference is written `localName.Symbol`, and `localName` comes from this
 *      file's import table. That is the only resolution step Go needs.
 *
 * Two traps make the table worth a module of its own:
 *
 *   1. The default local name is the last path segment with a trailing `/vN` MAJOR-VERSION segment
 *      stripped: `github.com/go-chi/chi/v5` is imported as `chi`, never as `v5`. (gopkg.in spells
 *      the same thing as a `.vN` suffix — `gopkg.in/yaml.v3` is `yaml`.) Miss this and every
 *      selector on a v2+ dependency resolves to nothing.
 *   2. The default local name is a HEURISTIC: Go's real rule is "the name the package DECLARES",
 *      which a third-party import does not tell us. For this repo's OWN packages we do know it, so
 *      `resolveQualifier` corrects the guess against `GoPackageIndex.packageNameByDir`. For
 *      external packages the guess stands — a documented Tier-B bound.
 *
 * Dot imports (`import . "math"`) are RECORDED and never bound: they drop names into the file's
 * namespace unqualified, so an unresolved bare identifier in such a file could belong to that
 * package or to this one, and there is no way to tell from the CST. That ambiguity is a Tier-B gap
 * worth reporting, not guessing at. Blank imports (`import _ "github.com/lib/pq"`) bind nothing at
 * all — they are counted because they are the strongest signal a driver is registered.
 */
import { BLANK_IDENTIFIER, DOT, type GoFile, IMPORT_SPEC, type TsNode, goStringValue, packageName } from './go-cst.js';
import { type GoModule, moduleOwnerPath } from './go-modules.js';

/** A file's import table: what each local package qualifier in this file refers to. */
export interface GoImportTable {
  /** local package name → full import path (first wins; a duplicate local name is invalid Go). */
  byLocal: Map<string, string>;
  /** Import paths brought in with `.` — they bind unqualified names we cannot enumerate. */
  dotImports: string[];
  /** `_` imports: registered for side effects only, bound to no name. */
  blankCount: number;
}

/** The repo's own packages, joined from each file's directory and its owning module's path. */
export interface GoPackageIndex {
  /** import path (`github.com/acme/api/internal/db`) → repo-relative directory (`internal/db`). */
  byImportPath: Map<string, string>;
  /** repo-relative directory → its import path (the inverse of `byImportPath`). */
  importPathByDir: Map<string, string>;
  /** repo-relative directory → the files in it, sorted (a Go package IS a directory). */
  filesByDir: Map<string, string[]>;
  /** repo-relative directory → the name its files DECLARE, which need not match the directory. */
  packageNameByDir: Map<string, string>;
}

// =============================================================================
// Per-file import table
// =============================================================================

/**
 * The local name an import binds when it is written without an alias.
 *
 * `/vN` is Go's major-version suffix, not a package: `github.com/go-chi/chi/v5` binds `chi`.
 * gopkg.in spells the same convention as a `.vN` suffix on the last segment (`gopkg.in/yaml.v3` →
 * `yaml`); a Go identifier can never contain a dot, so a dotted last segment is always that
 * convention rather than a real package name.
 */
export function defaultLocalName(importPath: string): string {
  const segments = importPath.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  const base = segments.length > 1 && /^v\d+$/.test(last) ? segments[segments.length - 2] : last;
  return base.replace(/\.v\d+$/, '');
}

/**
 * One import table per parsed file, memoized on the `GoFile` object.
 *
 * Several lanes need the same table — the call resolver, the entity type resolver and the egress
 * client gate — and each would otherwise re-walk every `import_spec` in the file, contradicting the
 * substrate's own "each file is parsed ONCE and its CST root is reused across every extractor"
 * rule. Keyed on object identity rather than `relPath`, so a re-parse (a new `GoFile`) can never
 * read a stale table and the entry is collectable with the tree.
 */
const IMPORT_TABLE_CACHE = new WeakMap<GoFile, GoImportTable>();

/** A file's import table. Built on first call, reused by every later one. */
export function buildImportTable(file: GoFile): GoImportTable {
  const cached = IMPORT_TABLE_CACHE.get(file);
  if (cached) return cached;
  const table = computeImportTable(file);
  IMPORT_TABLE_CACHE.set(file, table);
  return table;
}

/**
 * Build a file's import table (one CST walk).
 *
 * `descendantsOfType(IMPORT_SPEC)` covers BOTH import forms: the single `import "fmt"` puts its
 * `import_spec` directly under the `import_declaration` with no `import_spec_list`, so a walk that
 * looked for the list would silently see no imports in every file that imports exactly one package.
 */
function computeImportTable(file: GoFile): GoImportTable {
  const byLocal = new Map<string, string>();
  const dotImports: string[] = [];
  let blankCount = 0;

  for (const spec of (file.root?.descendantsOfType?.(IMPORT_SPEC) ?? []) as TsNode[]) {
    const path = goStringValue(spec.childForFieldName?.('path'));
    if (!path) continue;
    const nameNode = spec.childForFieldName?.('name') as TsNode | undefined;
    // The alias slot is a distinct NODE TYPE per form: `package_identifier` for a real alias,
    // `blank_identifier` for `_`, `dot` for `.` — reading its text alone would bind a package to
    // the local name '_' or '.'.
    if (nameNode?.type === BLANK_IDENTIFIER) {
      blankCount++;
      continue;
    }
    if (nameNode?.type === DOT) {
      dotImports.push(path);
      continue;
    }
    const local = (nameNode?.text as string | undefined) ?? defaultLocalName(path);
    if (local && !byLocal.has(local)) byLocal.set(local, path);
  }

  return { byLocal, dotImports, blankCount };
}

/** The import path a local package qualifier refers to in this file, if any. */
export function resolveImportPath(table: GoImportTable, localName: string): string | undefined {
  return table.byLocal.get(localName);
}

// =============================================================================
// Repo package index
// =============================================================================

/** dirname of a repo-relative path ('' at the repo root). */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * Index this repo's own packages: import path ↔ directory, plus the files and declared package name
 * of each directory.
 *
 * Built by joining each file's DIRECTORY to its owning module's module path — the only way to get
 * from `pkg.Fn()` back to a declaration in this repo, because an import path is a module path plus
 * a directory suffix and nothing in a file records it.
 *
 * `go.work` entries are skipped: a workspace file has no `module` directive, so its `modulePath` is
 * a directory-derived fallback and prefixing import paths with it would mint paths that no import
 * can ever match. Files under no module at all are indexed for their files/package name but get NO
 * import path — a repo directory with no `go.mod` above it genuinely has no import path.
 */
export function buildPackageIndex(files: GoFile[], modules: GoModule[]): GoPackageIndex {
  const byImportPath = new Map<string, string>();
  const importPathByDir = new Map<string, string>();
  const filesByDir = new Map<string, string[]>();
  const packageNameByDir = new Map<string, string>();

  const importable = modules.filter((m) => !m.isWorkspace);
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));

  for (const file of sorted) {
    const dir = dirOf(file.relPath);
    const bucket = filesByDir.get(dir);
    if (bucket) bucket.push(file.relPath);
    else filesByDir.set(dir, [file.relPath]);
    // Files are visited in sorted order, so the winner is deterministic. In valid Go every file in
    // a directory declares the same package, so this is a read, not a vote.
    if (!packageNameByDir.has(dir)) {
      const declared = packageName(file);
      if (declared) packageNameByDir.set(dir, declared);
    }
  }

  for (const dir of filesByDir.keys()) {
    const ownerPath = moduleOwnerPath(dir, importable);
    const owner = ownerPath !== undefined ? importable.find((m) => m.path === ownerPath) : undefined;
    if (!owner) continue;
    const moduleDir = owner.path === '.' ? '' : owner.path;
    const suffix = dir === moduleDir ? '' : dir.slice(moduleDir ? moduleDir.length + 1 : 0);
    const importPath = suffix ? `${owner.modulePath}/${suffix}` : owner.modulePath;
    importPathByDir.set(dir, importPath);
    if (!byImportPath.has(importPath)) byImportPath.set(importPath, dir);
  }

  return { byImportPath, importPathByDir, filesByDir, packageNameByDir };
}

/**
 * Whether an import path resolves INSIDE one of this repo's own modules (as opposed to a
 * third-party or stdlib package).
 *
 * Answered from the module paths rather than from `GoPackageIndex.byImportPath` on purpose: a
 * package that exists in the repo but whose files are out of the profile's scope is still this
 * repo's code, and calling it "external" would let it be reported as an outbound dependency.
 * `byImportPath.get(p)` is the stricter question — "is it in scope, and where".
 */
export function isInternalImportPath(importPath: string, modules: GoModule[]): boolean {
  return modules.some(
    (m) => !m.isWorkspace && (importPath === m.modulePath || importPath.startsWith(`${m.modulePath}/`)),
  );
}

/**
 * Resolve a local package qualifier (`db` in `db.FindUser()`) to an import path, correcting the
 * default-local-name guess against what this repo's packages actually DECLARE.
 *
 * The unaliased local name is the package's declared name, which for a third-party import we can
 * only guess from the path — but for an in-repo import we can read it. A directory named
 * `internal/database` whose files say `package db` is imported unaliased and referred to as `db.`,
 * so the direct lookup misses and only this second pass finds it. Falls back to undefined rather
 * than to a nearest match: a qualifier that names nothing in the table is unresolvable, not
 * approximately resolvable.
 */
export function resolveQualifier(table: GoImportTable, index: GoPackageIndex, localName: string): string | undefined {
  const direct = table.byLocal.get(localName);
  if (direct) return direct;
  for (const importPath of table.byLocal.values()) {
    const dir = index.byImportPath.get(importPath);
    if (dir !== undefined && index.packageNameByDir.get(dir) === localName) return importPath;
  }
  return undefined;
}
