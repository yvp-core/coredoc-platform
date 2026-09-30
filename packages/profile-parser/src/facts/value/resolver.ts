import { dirname, join, normalize } from 'node:path';
import type { ReExport, StructuralFile, StructuralImport, ValueBinding } from '../structural/ts-structural.js';
import { isStringLiteral, unquoteLiteral } from './literal.js';

export interface RepoValueResolver {
  /** Fold a value expression to its string literal, or undefined if not statically resolvable. */
  resolve(expr: string, fromFile: string): string | undefined;
}

/** name -> binding, per file. */
type FileIndex = Map<string, Map<string, ValueBinding>>;

export function buildRepoValueResolver(
  bindings: ValueBinding[],
  imports: Map<string, StructuralImport[]>,
  reExports: Map<string, ReExport[]> = new Map(),
): RepoValueResolver {
  const index: FileIndex = new Map();
  for (const b of bindings) {
    const m = index.get(b.filePath) ?? new Map<string, ValueBinding>();
    m.set(b.name, b);
    index.set(b.filePath, m);
  }

  // Map a no-extension module path to an actual indexed/re-exporting file path (strip ext + optional /index).
  // The query is also normalized so an explicit `./constants/index` matches the same file as `./constants`.
  function findFile(moduleNoExt: string): string | undefined {
    const queryNoExt = moduleNoExt.replace(/\/index$/, '');
    const candidates = new Set<string>([...index.keys(), ...reExports.keys()]);
    for (const fp of candidates) {
      const fpNoExt = fp.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
      if (fpNoExt === queryNoExt) return fp;
    }
    return undefined;
  }

  // Resolve `exportedName` as exported by module file `inFile`, following named/star re-exports.
  function resolveExportedBinding(
    exportedName: string,
    inFile: string,
    visited: Set<string>,
  ): ValueBinding | undefined {
    const key = `${inFile}#${exportedName}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const direct = index.get(inFile)?.get(exportedName);
    if (direct) return direct;
    for (const re of reExports.get(inFile) ?? []) {
      const targetNoExt = resolveRelativeModule(inFile, re.moduleSpecifier);
      if (!targetNoExt) continue;
      const targetFile = findFile(targetNoExt);
      if (!targetFile) continue;
      if (re.kind === 'named') {
        const spec = re.names?.find((n) => (n.alias ?? n.name) === exportedName);
        if (spec) {
          const b = resolveExportedBinding(spec.name, targetFile, visited);
          if (b) return b;
        }
      } else {
        const b = resolveExportedBinding(exportedName, targetFile, visited);
        if (b) return b;
      }
    }
    return undefined;
  }

  // Cross-file resolution via relative imports, following re-export chains at the target.
  function resolveImportedBinding(name: string, fromFile: string): ValueBinding | undefined {
    for (const imp of imports.get(fromFile) ?? []) {
      if (imp.isTypeOnly) continue;
      // does this import bring in `name` (directly or via alias)?
      const spec = imp.names.find((n) => (n.alias ?? n.name) === name);
      if (!spec) continue;
      const targetNoExt = resolveRelativeModule(fromFile, imp.moduleSpecifier);
      if (!targetNoExt) continue;
      const targetFile = findFile(targetNoExt);
      if (!targetFile) continue;
      const b = resolveExportedBinding(spec.name, targetFile, new Set());
      if (b) return b;
    }
    return undefined;
  }

  function lookupBinding(name: string, fromFile: string): ValueBinding | undefined {
    // same-file first; cross-file via imports follows re-export chains.
    return index.get(fromFile)?.get(name) ?? resolveImportedBinding(name, fromFile);
  }

  function resolve(expr: string, fromFile: string): string | undefined {
    const s = expr.trim();
    if (isStringLiteral(s)) return unquoteLiteral(s);
    // member / enum-member: ROOT.PROP  (single dot, simple identifiers)
    const m = s.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (m) {
      const b = lookupBinding(m[1], fromFile);
      return b?.members?.[m[2]];
    }
    // bare identifier → literal binding
    if (/^[A-Za-z_$][\w$]*$/.test(s)) {
      const b = lookupBinding(s, fromFile);
      return b?.kind === 'literal' ? b.literal : undefined;
    }
    return undefined; // function call, template interpolation, computed → not statically foldable
  }

  return { resolve };
}

/** Assemble a RepoValueResolver from all parsed structural files (their valueBindings + imports + reExports). */
export function resolverFromStructuralFiles(files: StructuralFile[]): RepoValueResolver {
  const bindings = files.flatMap((f) => f.valueBindings ?? []);
  const imports = new Map<string, StructuralImport[]>(files.map((f) => [f.path, f.imports]));
  const reExports = new Map<string, ReExport[]>(files.map((f) => [f.path, f.reExports ?? []]));
  return buildRepoValueResolver(bindings, imports, reExports);
}

/** Resolve a relative module specifier from a repo-relative importing file to a candidate repo-relative path. */
function resolveRelativeModule(fromFile: string, moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined; // only relative imports are file-resolvable here
  const base = join(dirname(fromFile), moduleSpecifier);
  return normalize(base).split('\\').join('/'); // without extension; we match by stripping ext in the index
}
