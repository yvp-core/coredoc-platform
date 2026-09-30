/**
 * `ImportEdge` emission for Kotlin (§Declarations, `import_header` bullet).
 *
 * One edge per distinct `(file, dotted path)`, `moduleSpecifier` = the path as written.
 * `targetFileId` is set when the path, its class prefix, or — for a wildcard — the package it
 * names resolves to exactly ONE emitting file of this repository.
 *
 * `importedNames` is set ONLY when `targetFileId` resolved. An unresolved import that carries
 * names is routed by `packages/db/src/transformer.ts` into `FileNode.packageImports` and fed to
 * the cross-repo package linker, so every `import androidx.*` / `import java.*` would land there
 * as noise no workspace package could ever match.
 */
import type { ImportEdge, StableIdGenerator } from '@coredoc/core';
import type { KotlinFileFacts, KotlinImport, KotlinTypeDecl } from './kotlin-declarations.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';

interface Scope {
  /** Repo-relative path → the emitted `FileNode` id. */
  fileIdByPath: Map<string, string>;
  /** Kotlin package → the file ids declaring it; a package of exactly one file resolves. */
  filesByPackage: Map<string, string[]>;
}

function soleFileOfPackage(pkg: string, scope: Scope): string | undefined {
  const files = scope.filesByPackage.get(pkg);
  return files && files.length === 1 ? files[0] : undefined;
}

/** `targetFileId` for one import, or `undefined` when it leaves this repository. */
function resolveTarget(
  imp: KotlinImport,
  index: KotlinTypeIndex,
  scope: Scope,
): { fileId: string; decl?: KotlinTypeDecl } | undefined {
  if (imp.isWildcard) {
    const fileId = soleFileOfPackage(imp.path, scope);
    return fileId ? { fileId } : undefined;
  }

  const direct = index.byFullyQualifiedName(imp.path);
  if (direct) {
    const fileId = scope.fileIdByPath.get(direct.filePath);
    if (fileId) return { fileId, decl: direct };
  }

  const dot = imp.path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const prefix = imp.path.slice(0, dot);

  // `a.b.C.member` — the class prefix carries the file.
  const owner = index.byFullyQualifiedName(prefix);
  if (owner) {
    const fileId = scope.fileIdByPath.get(owner.filePath);
    if (fileId) return { fileId, decl: owner };
  }

  // `a.b.topLevelFn` — a package of exactly one emitting file is unambiguous.
  const fileId = soleFileOfPackage(prefix, scope);
  return fileId ? { fileId } : undefined;
}

/**
 * Every file's import edges, in file order then first-seen path order.
 *
 * `isTypeOnly` is always false: Kotlin has no type-only import form.
 */
export function buildKotlinImportEdges(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  idGen: StableIdGenerator,
): ImportEdge[] {
  const scope: Scope = { fileIdByPath: new Map(), filesByPackage: new Map() };
  for (const facts of allFacts) {
    scope.fileIdByPath.set(facts.relPath, facts.fileId);
    const files = scope.filesByPackage.get(facts.packageName);
    if (files) files.push(facts.fileId);
    else scope.filesByPackage.set(facts.packageName, [facts.fileId]);
  }

  const edges: ImportEdge[] = [];
  for (const facts of allFacts) {
    const seen = new Set<string>();
    for (const imp of facts.imports) {
      if (seen.has(imp.path)) continue;
      seen.add(imp.path);
      const target = resolveTarget(imp, index, scope);
      const resolvedId = target?.decl?.classId ?? target?.decl?.interfaceId ?? target?.decl?.enumId;
      edges.push({
        id: idGen.importEdgeId(facts.fileId, imp.path),
        sourceFileId: facts.fileId,
        moduleSpecifier: imp.path,
        ...(target ? { targetFileId: target.fileId } : {}),
        isTypeOnly: false,
        importKind: imp.isWildcard ? 'namespace' : 'named',
        // Only a resolved import names anything; see the module comment.
        ...(target && !imp.isWildcard
          ? {
              importedNames: [
                {
                  name: imp.path.slice(imp.path.lastIndexOf('.') + 1),
                  ...(imp.alias ? { alias: imp.alias } : {}),
                  ...(resolvedId ? { resolvedId } : {}),
                },
              ],
            }
          : {}),
      });
    }
  }
  return edges;
}
