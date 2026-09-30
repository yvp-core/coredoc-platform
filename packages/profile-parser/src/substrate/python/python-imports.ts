/**
 * Per-file Python import table + repo module index — the foundation for Tier-B call
 * resolution, entity/type resolution, and egress client detection.
 *
 * Import-table policy (spec Decision 2026-07-24, implemented EXACTLY):
 *   - `import a.b` / `import a.b as m` → bind local (`a` / `m`) → module 'a.b'.
 *   - `from a.b import c as d` → local 'd', module 'a.b', symbol 'c'.
 *   - Relative imports (`from . import x`, `from ..pkg import y`) resolved against the FILE's
 *     package path (its dir as a dotted module, honoring `__init__.py`).
 *   - `if TYPE_CHECKING:` imports → `typeOnly: true` (usable for entity/type resolution,
 *     NEVER for runtime call/egress edges).
 *   - `try: import x except ImportError: import y as x` → all candidates seen, the
 *     unconditional/first one PREFERRED (held in `byLocal`).
 *   - Star imports, `importlib.import_module(...)`, `__import__(...)` dynamic dispatch → COUNTED
 *     drops (`droppedDynamic`), never bound (Tier-B gap, surfaced in stats). `getattr(...)` is
 *     ordinary attribute access, NOT an import mechanism — it is not counted.
 */
import type { PythonFile, TsNode } from './python-cst.js';

/** One name bound into a file's namespace by an import. */
export interface ImportedName {
  /** The name bound in this file's namespace. */
  local: string;
  /** The module path it came from (e.g. 'posthog.event_usage'), relative imports resolved to absolute. */
  module: string;
  /** For `from m import s`, the imported symbol ('s'); undefined for `import m`. */
  symbol?: string;
  /** Imported under `if TYPE_CHECKING:` — usable for type/entity resolution, NEVER runtime edges. */
  typeOnly: boolean;
}

/** A file's resolved import table. */
export interface ImportTable {
  /** local name → resolved import (unconditional preferred over try/except candidates). */
  byLocal: Map<string, ImportedName>;
  /** star imports + importlib/__import__ dynamic dispatch counted (Tier-B gap). */
  droppedDynamic: number;
}

// =============================================================================
// Module-path derivation (repo-relative path → dotted module)
// =============================================================================

/** Whether a path is a package initializer (`__init__.py` or its `.pyi` stub). */
function isPackageInitPath(relPath: string): boolean {
  return /(^|\/)__init__\.pyi?$/.test(relPath);
}

/** The dotted-module segments of a repo-relative `.py`/`.pyi` path (honoring `__init__.py`). */
function moduleParts(relPath: string): string[] {
  let p = relPath.replace(/\.pyi?$/, '');
  if (p.endsWith('/__init__')) p = p.slice(0, -'/__init__'.length);
  else if (p === '__init__') p = '';
  return p ? p.split('/') : [];
}

/** The package (dotted) that CONTAINS a module — a regular module drops its own name; a package is itself. */
function filePackageParts(relPath: string): string[] {
  const parts = moduleParts(relPath);
  return isPackageInitPath(relPath) ? parts : parts.slice(0, -1);
}

/**
 * Resolve a `relative_import` node (`.`, `..pkg`, `.mod`) to an absolute dotted module,
 * against the importing file's package. One dot = the file's own package; each extra dot
 * climbs one level; any trailing dotted suffix is appended.
 */
function resolveRelative(relImportNode: TsNode, relPath: string): string {
  const text = (relImportNode.text ?? '') as string;
  const dots = (text.match(/^\.+/)?.[0].length ?? 0) || 1;
  const suffix = text.slice(dots);
  const base = filePackageParts(relPath);
  const climbed = base.slice(0, Math.max(0, base.length - (dots - 1)));
  const suffixParts = suffix ? suffix.split('.') : [];
  return [...climbed, ...suffixParts].join('.');
}

// =============================================================================
// TYPE_CHECKING / try-guard detection
// =============================================================================

/**
 * Whether an `if`-condition is a bare `TYPE_CHECKING` guard: the `TYPE_CHECKING` identifier or a
 * dotted `typing.TYPE_CHECKING` attribute. A NEGATED (`if not TYPE_CHECKING:`) or compound
 * (`A and TYPE_CHECKING`) condition is a RUNTIME branch — explicitly rejected — so its imports
 * stay runtime edges instead of being wrongly flagged type-only.
 */
function isTypeCheckingCond(cond: TsNode | null | undefined): boolean {
  if (!cond) return false;
  if (cond.type === 'not_operator' || cond.type === 'boolean_operator') return false;
  if (cond.type === 'identifier') return cond.text === 'TYPE_CHECKING';
  if (cond.type === 'attribute') return (cond.text as string).endsWith('.TYPE_CHECKING');
  return false;
}

/** Whether `node` sits in the consequence of an `if TYPE_CHECKING:` guard. */
function inTypeChecking(node: TsNode): boolean {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === 'if_statement') {
      const cond = cur.childForFieldName?.('condition');
      const consequence = cur.childForFieldName?.('consequence');
      if (
        isTypeCheckingCond(cond) &&
        consequence &&
        node.startIndex >= consequence.startIndex &&
        node.endIndex <= consequence.endIndex
      ) {
        return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

/** Whether `node` is inside a `try_statement` (a conditional import candidate). */
function inTry(node: TsNode): boolean {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === 'try_statement') return true;
    cur = cur.parent;
  }
  return false;
}

// =============================================================================
// Import table
// =============================================================================

/** Build the per-file import table (one CST walk). */
export function buildImportTable(file: PythonFile): ImportTable {
  const byLocal = new Map<string, ImportedName>();
  const conditionalOf = new Map<string, boolean>();
  let droppedDynamic = 0;
  const root = file.root;

  // First-wins, EXCEPT an unconditional import replaces a conditional one (unconditional preference).
  const addBinding = (imported: ImportedName, conditional: boolean): void => {
    const existing = byLocal.get(imported.local);
    if (!existing) {
      byLocal.set(imported.local, imported);
      conditionalOf.set(imported.local, conditional);
      return;
    }
    if (conditionalOf.get(imported.local) && !conditional) {
      byLocal.set(imported.local, imported);
      conditionalOf.set(imported.local, conditional);
    }
  };

  // `import a.b`, `import a.b as m`
  for (const imp of root.descendantsOfType('import_statement') as TsNode[]) {
    const conditional = inTry(imp);
    const typeOnly = inTypeChecking(imp);
    for (let i = 0; i < imp.namedChildCount; i++) {
      const c = imp.namedChild(i);
      if (!c) continue;
      if (c.type === 'dotted_name') {
        const module = c.text as string;
        addBinding({ local: module.split('.')[0], module, symbol: undefined, typeOnly }, conditional);
      } else if (c.type === 'aliased_import') {
        const module = (c.childForFieldName?.('name')?.text ?? '') as string;
        const local = (c.childForFieldName?.('alias')?.text ?? module.split('.')[0]) as string;
        addBinding({ local, module, symbol: undefined, typeOnly }, conditional);
      }
    }
  }

  // `from a.b import c as d`, `from . import x`, `from a import *`
  for (const imp of root.descendantsOfType('import_from_statement') as TsNode[]) {
    const modNode = imp.childForFieldName?.('module_name');
    const module =
      modNode?.type === 'relative_import' ? resolveRelative(modNode, file.relPath) : ((modNode?.text ?? '') as string);
    const typeOnly = inTypeChecking(imp);
    const conditional = inTry(imp);
    for (let i = 0; i < imp.childCount; i++) {
      const c = imp.child(i);
      if (!c) continue;
      if (c.type === 'wildcard_import') {
        droppedDynamic++; // `from a import *` — a Tier-B blind spot, counted not bound.
        continue;
      }
      if (imp.fieldNameForChild?.(i) !== 'name') continue;
      if (c.type === 'aliased_import') {
        const symbol = c.childForFieldName?.('name')?.text as string | undefined;
        const local = (c.childForFieldName?.('alias')?.text ?? symbol) as string;
        addBinding({ local, module, symbol, typeOnly }, conditional);
      } else if (c.type === 'dotted_name') {
        const symbol = c.text as string;
        addBinding({ local: symbol.split('.').pop() ?? symbol, module, symbol, typeOnly }, conditional);
      }
    }
  }

  // Genuine dynamic-import mechanisms that defeat static resolution — counted, never bound.
  // (`getattr(...)` is pervasive ordinary attribute access, not an import — deliberately excluded.)
  for (const call of root.descendantsOfType('call') as TsNode[]) {
    const callee = call.childForFieldName?.('function')?.text as string | undefined;
    if (callee === 'importlib.import_module' || callee === '__import__') {
      droppedDynamic++;
    }
  }

  return { byLocal, droppedDynamic };
}

// =============================================================================
// Repo module index
// =============================================================================

/**
 * The directory prefixes that are NOT Python packages, i.e. the plausible source roots.
 *
 * A dotted module name is relative to whatever `sys.path` entry holds it, so a repo-relative
 * path is only the module name when the package root IS the repo root. Under the common
 * layouts — PEP-621 `src/`, or a `backend/` / `api/` service dir in a monorepo —
 * `src/myapp/services.py` is imported as `myapp.services`, never `src.myapp.services`. A
 * directory that has no `__init__.py` cannot contribute a segment to any dotted name, so it
 * is exactly the boundary to strip at.
 */
function sourceRootPrefixes(files: PythonFile[]): Set<string> {
  const packageDirs = new Set<string>();
  for (const { relPath } of files) {
    if (!isPackageInitPath(relPath)) continue;
    const i = relPath.lastIndexOf('/');
    packageDirs.add(i === -1 ? '' : relPath.slice(0, i));
  }
  const roots = new Set<string>();
  for (const { relPath } of files) {
    const dirs = relPath.split('/').slice(0, -1);
    // Walk down from the repo root; every leading non-package dir is strippable, and the
    // walk stops at the first package dir because everything below it IS part of the name.
    let prefix = '';
    for (const d of dirs) {
      prefix = prefix ? `${prefix}/${d}` : d;
      if (packageDirs.has(prefix)) break;
      roots.add(prefix);
    }
  }
  return roots;
}

/**
 * Module path → repo-relative file, honoring package `__init__.py`. A dir with `__init__.py`
 * maps `pkg` → `pkg/__init__.py`; `pkg/mod.py` → module `pkg.mod`. Root `__init__.py`
 * (module '') is skipped.
 *
 * Each file is registered under its repo-relative dotted path AND under the path with a
 * source-root prefix removed (see `sourceRootPrefixes`). Both are kept rather than choosing:
 * a repo may have several roots, PEP-420 namespace packages carry no `__init__.py` to
 * disambiguate with, and an extra key can only ever resolve an import that would otherwise
 * have been dropped. The repo-relative form stays authoritative on collision.
 */
export function buildModuleIndex(files: PythonFile[]): Map<string, string> {
  const index = new Map<string, string>();
  const roots = sourceRootPrefixes(files);
  const register = (module: string, relPath: string, authoritative: boolean): void => {
    if (!module) return;
    // __init__.py wins the package name over any accidental same-name collision, and a
    // repo-relative key always outranks a root-stripped alias. An incumbent initializer is
    // never displaced — otherwise a `__init__.pyi` stub would evict its own `__init__.py`.
    const incumbent = index.get(module);
    if (incumbent === undefined || (authoritative && isPackageInitPath(relPath) && !isPackageInitPath(incumbent))) {
      index.set(module, relPath);
    }
  };
  for (const { relPath } of files) {
    register(moduleParts(relPath).join('.'), relPath, true);
  }
  for (const { relPath } of files) {
    for (const root of roots) {
      if (!relPath.startsWith(`${root}/`)) continue;
      register(moduleParts(relPath.slice(root.length + 1)).join('.'), relPath, false);
    }
  }
  return index;
}

/** Look up the repo-relative file that a dotted module resolves to (undefined if external). */
export function resolveModuleToFile(module: string, index: Map<string, string>): string | undefined {
  return index.get(module);
}

/**
 * Resolve an imported LOCAL name (or a `mod.attr` chain) to a def's owning file + symbol, for
 * Tier-B calls. Prefers a submodule interpretation (`module.symbol` as its own file) over a
 * symbol-in-module one. Returns undefined when the head name isn't imported in this file.
 */
export function resolveImportedTarget(
  table: ImportTable,
  index: Map<string, string>,
  localOrChain: string,
): { filePath?: string; module: string; symbol?: string } | undefined {
  const parts = localOrChain.split('.');
  const imp = table.byLocal.get(parts[0]);
  if (!imp) return undefined;
  const rest = parts.slice(1);
  const module = imp.module;
  // `import a.b as m` binds no symbol; `m.f` → symbol f on module a.b.
  const symbol = imp.symbol ?? (rest.length > 0 ? rest[0] : undefined);

  if (symbol) {
    const sub = `${module}.${symbol}`;
    const subFile = resolveModuleToFile(sub, index);
    if (subFile) return { filePath: subFile, module: sub, symbol: undefined };
  }
  return { filePath: resolveModuleToFile(module, index), module, symbol };
}
