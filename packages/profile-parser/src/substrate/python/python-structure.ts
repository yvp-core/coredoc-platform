/**
 * Python STRUCTURE nodes — `Package`, `FileNode` and `ImportEdge` (audit gap G1).
 *
 * The Python substrate used to emit none of these ("TS/SCIP-derived, out of scope"), which held
 * only while a repo had exactly one target: in a multi-target merge every python function's
 * `fileId`, every entity's `fileId` and every method's `classId` pointed at nodes nobody emitted.
 * Ids here are minted with the SAME `StableIdGenerator` calls the other lanes already reference
 * (`fileId(relPath)`, `packageId(dir)`), so the joins hold by construction.
 *
 * PACKAGES are deliberately NOT a new taxonomy: a package is a Python DISTRIBUTION root — a
 * directory holding `pyproject.toml` / `setup.py` / `setup.cfg` — plus the repo root '.' as the
 * fallback owner, and files are assigned by the shared longest-prefix rule (`ownerPackagePath`)
 * that the TS workspace lane uses. Emitting a package per importable directory instead would mint
 * thousands of nodes that mean nothing to a reader.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FileNode, ImportEdge, ImportedName, Package, StableIdGenerator } from '@coredoc/core';
import { type WorkspacePackage, ownerPackagePath } from '../../facts/workspace.js';
import { toFileNodes } from '../file-nodes.js';
import type { PythonFile } from './python-cst.js';
import type { ImportTable } from './python-imports.js';

/** Manifest files that mark a directory as a Python distribution root. */
const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg'];

/** The manifest file present in `dir`, if any (checked in declaration order). */
function manifestIn(repoRoot: string, dir: string): string | undefined {
  for (const m of PY_MANIFESTS) {
    const rel = dir === '.' ? m : `${dir}/${m}`;
    if (existsSync(join(repoRoot, rel))) return rel;
  }
  return undefined;
}

/**
 * The Python distribution roots that own the in-scope files: every ancestor directory of a parsed
 * file that holds a manifest, plus the repo root '.' as the fallback owner (so EVERY FileNode has
 * a package that exists — the invariant `packageId` joins on). Only ancestors of real files are
 * considered, so an excluded subtree never appears as an empty package.
 */
export function detectPythonPackages(repoRoot: string, repoName: string, relPaths: string[]): WorkspacePackage[] {
  const candidates = new Set<string>();
  for (const rel of relPaths) {
    const parts = rel.split('/').slice(0, -1);
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      candidates.add(prefix);
    }
  }
  const roots = [...candidates].filter((dir) => manifestIn(repoRoot, dir) !== undefined).sort();
  return [{ path: '.', name: repoName }, ...roots.map((dir) => ({ path: dir, name: dir.split('/').pop() as string }))];
}

/**
 * `WorkspacePackage[]` → emitted `Package[]`. A detected distribution root is declared 'python';
 * the repo root '.' deliberately is NOT — it is the fallback owner EVERY target shares, and the
 * multi-target merge attributes its language from the dominant language of its merged files. On a
 * polyglot repo, stamping 'python' here would relabel a root that mostly holds TypeScript.
 */
export function toPythonPackages(repoRoot: string, packages: WorkspacePackage[], idGen: StableIdGenerator): Package[] {
  return packages.map((p) => {
    const manifestFile = manifestIn(repoRoot, p.path);
    return {
      id: idGen.packageId(p.path),
      name: p.name,
      path: p.path,
      ...(manifestFile ? { manifestFile } : {}),
      ...(p.path === '.' ? {} : { language: 'python' }),
    };
  });
}

/** One `FileNode` per parsed Python file, owned by its longest-prefix package. */
export function toPythonFileNodes(
  files: PythonFile[],
  packages: WorkspacePackage[],
  idGen: StableIdGenerator,
): FileNode[] {
  return toFileNodes(files, idGen, {
    language: 'python',
    commentPrefix: '#',
    packageIdFor: (relPath) => idGen.packageId(ownerPackagePath(relPath, packages)),
  });
}

/**
 * One `ImportEdge` per (file, module) pair from an already-built import table. Bindings are
 * grouped by module because the edge id is keyed on `(sourceFileId, moduleSpecifier)`: `from a
 * import x, y` is ONE dependency on `a` carrying two names, not two edges that would collide.
 *
 * `moduleSpecifier` is the ABSOLUTE dotted module — relative imports were already resolved
 * against the importing file's package by `buildImportTable`, and the absolute form is the only
 * one that joins to `targetFileId`. `isTypeOnly` is true only when EVERY binding for that module
 * came in under `if TYPE_CHECKING:`. `importKind` is 'namespace' for `import a.b` (a module
 * object is bound) and 'named' for `from a import b`; star imports and importlib dispatch are
 * counted as dropped by the import table and never bound, so they emit no edge.
 */
export function toPythonImportEdges(
  file: PythonFile,
  table: ImportTable,
  moduleIndex: Map<string, string>,
  idGen: StableIdGenerator,
): ImportEdge[] {
  const sourceFileId = idGen.fileId(file.relPath);
  interface Group {
    names: ImportedName[];
    typeOnly: boolean;
    named: boolean;
  }
  const byModule = new Map<string, Group>();

  for (const imp of table.byLocal.values()) {
    if (!imp.module) continue;
    const g = byModule.get(imp.module) ?? { names: [], typeOnly: true, named: false };
    const name = imp.symbol ?? imp.module;
    g.names.push(imp.local === name ? { name } : { name, alias: imp.local });
    g.typeOnly = g.typeOnly && imp.typeOnly;
    g.named = g.named || imp.symbol !== undefined;
    byModule.set(imp.module, g);
  }

  return [...byModule.entries()].map(([moduleSpecifier, g]) => {
    const targetFile = moduleIndex.get(moduleSpecifier);
    return {
      id: idGen.importEdgeId(sourceFileId, moduleSpecifier),
      sourceFileId,
      moduleSpecifier,
      ...(targetFile ? { targetFileId: idGen.fileId(targetFile) } : {}),
      isTypeOnly: g.typeOnly,
      importKind: g.named ? ('named' as const) : ('namespace' as const),
      importedNames: g.names,
    };
  });
}
