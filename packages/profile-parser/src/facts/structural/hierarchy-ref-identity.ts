/**
 * Binds the heritage clauses of the parse — `class B extends A`, `class C implements I`,
 * `interface J extends K` — to the nodes they name, so the storage layer emits EXTENDS and
 * IMPLEMENTS_INTERFACE instead of falling back to a bare-name type usage.
 *
 * Identity is proved over the module graph (see `symbol-ref-identity.ts`), never by a repo-wide
 * name match: a `Base` declared in an unrelated module must not capture the edge. A base that is
 * namespace-qualified, default-imported or simply unaccounted for keeps its NAME and no id — the
 * honest refusal, which the transformer still renders as an ambiguous by-name usage.
 *
 * A base PROVEN external (an npm class) keeps its name too, but is marked `external`: the name is
 * still what the class declares it extends, while the marker tells the transformer that no in-repo
 * declaration can be it — a same-named local class is a different symbol, and matching it would
 * fabricate a hierarchy edge at full confidence.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { TypeReference } from '@coredoc/core/types';
import type { CodeGraph } from '../graph/graph-builder.js';
import {
  DeclKind,
  type SymbolIdentityResolver,
  type SymbolIdentityResolverOptions,
  createSymbolIdentityResolver,
} from './symbol-ref-identity.js';
import type { StructuralFile } from './ts-structural.js';

/**
 * Declaration forms a clause can bind to, most specific first. TypeScript lets a class implement
 * another class's shape and an interface extend a class, so the other form stays reachable — the
 * clause only decides which one wins when a file declares BOTH under one name.
 */
const CLASS_EXTENDS_KINDS = [DeclKind.Class, DeclKind.Interface] as const;
const IMPLEMENTS_KINDS = [DeclKind.Interface, DeclKind.Class] as const;
const INTERFACE_EXTENDS_KINDS = [DeclKind.Interface, DeclKind.Class] as const;

/** Where a locally-visible name came from: the name its module exports it as, and that module. */
export interface ImportedName {
  exportedName: string;
  specifier: string;
}

/** Whether any file declares a heritage clause — the only reason this pass has work to do. */
export function hasHeritageClauses(structuralFiles: StructuralFile[]): boolean {
  return structuralFiles.some(
    (f) =>
      f.classes.some((c) => c.extendsClass || c.implementsNames.length > 0) ||
      (f.interfaces ?? []).some((i) => i.extends.length > 0),
  );
}

/**
 * `prebuilt` lets the caller hand in the parse's ONE `SymbolIdentityResolver` (see `buildBaseline`):
 * every consumer walks the same `structuralFiles` and re-reading the manifests, re-loading the
 * TypeScript compiler for the tsconfig walk and re-filling the barrel memos per consumer is pure
 * repeated work. Omitted, this builds its own — the standalone path tests use.
 */
export async function resolveHierarchyRefIdentity(
  g: CodeGraph,
  structuralFiles: StructuralFile[],
  idGen: StableIdGenerator,
  opts: SymbolIdentityResolverOptions,
  prebuilt?: SymbolIdentityResolver,
): Promise<void> {
  if (!hasHeritageClauses(structuralFiles)) return;
  const resolver = prebuilt ?? (await createSymbolIdentityResolver(structuralFiles, opts));

  for (const file of structuralFiles) {
    const imports = importedNames(file);
    const bind = (ref: TypeReference | undefined, kinds: readonly DeclKind[]): void => {
      if (!ref) return;
      const outcome = resolveHeritageName(g, resolver, idGen, file.path, imports, ref.name, kinds);
      // Externality is a PROOF, and a load-bearing one: the storage layer's by-name fallback would
      // otherwise match the base's name against an unrelated same-named local declaration and
      // fabricate a hierarchy the code does not have.
      if (outcome.kind === 'external') ref.external = true;
      else if (outcome.kind === 'bound') ref.resolvedId = outcome.id;
    };
    for (const cls of file.classes) {
      const node = g.classes.get(idGen.classId(file.path, cls.name || 'AnonymousClass'));
      if (!node) continue;
      bind(node.extends, CLASS_EXTENDS_KINDS);
      for (const impl of node.implements ?? []) bind(impl, IMPLEMENTS_KINDS);
    }
    for (const iface of file.interfaces ?? []) {
      const node = g.interfaces.get(idGen.interfaceId(file.path, iface.name));
      if (!node) continue;
      for (const ext of node.extends ?? []) bind(ext, INTERFACE_EXTENDS_KINDS);
    }
  }
}

/** What a heritage name resolved to: a node of this parse, a proven-external symbol, or nothing. */
export type HeritageOutcome = { kind: 'bound'; id: string } | { kind: 'external' } | { kind: 'unresolved' };

const UNRESOLVED: HeritageOutcome = { kind: 'unresolved' };

/**
 * What the heritage name resolves to. A same-file declaration wins first (it is the name's only
 * possible meaning); otherwise the name must come from a named import, whose module is then either
 * resolved to its declaring file or PROVEN external. Anything else is an honest `unresolved`.
 */
export function resolveHeritageName(
  g: CodeGraph,
  resolver: SymbolIdentityResolver,
  idGen: StableIdGenerator,
  filePath: string,
  imports: Map<string, ImportedName>,
  name: string,
  kinds: readonly DeclKind[],
): HeritageOutcome {
  // `ns.Base` names a symbol through a namespace: no local declaration, no import to follow.
  if (!name || name.includes('.')) return UNRESOLVED;
  const local = resolver.declares(filePath, name, kinds);
  if (local) return bound(existingNodeId(g, idGen, filePath, name, local));
  const imported = imports.get(name);
  if (!imported) return UNRESOLVED;
  const identity = resolver.resolve(filePath, imported.exportedName, imported.specifier, kinds);
  if (identity.kind === 'external') return { kind: 'external' };
  return identity.kind === 'declared'
    ? bound(existingNodeId(g, idGen, identity.filePath, identity.declaredName, identity.declKind))
    : UNRESOLVED;
}

/** A found node id is a binding; a declaration the profile did not emit is not. */
function bound(id: string | undefined): HeritageOutcome {
  return id ? { kind: 'bound', id } : UNRESOLVED;
}

/** The declaring node's own id — only when that node really is in the graph. */
function existingNodeId(
  g: CodeGraph,
  idGen: StableIdGenerator,
  filePath: string,
  name: string,
  kind: DeclKind,
): string | undefined {
  if (kind === DeclKind.Class) {
    const id = idGen.classId(filePath, name);
    return g.classes.has(id) ? id : undefined;
  }
  if (kind === DeclKind.Interface) {
    const id = idGen.interfaceId(filePath, name);
    return g.interfaces.has(id) ? id : undefined;
  }
  return undefined;
}

/**
 * Local name → the name+module it is imported from, for NAMED imports only. A default or
 * namespace import gives no exported name to look up in the target module, so a base bound that
 * way stays unresolved rather than guessed.
 */
export function importedNames(file: StructuralFile): Map<string, ImportedName> {
  const map = new Map<string, ImportedName>();
  for (const imp of file.imports) {
    if (imp.kind !== 'named') continue;
    for (const n of imp.names) {
      map.set(n.alias ?? n.name, { exportedName: n.name, specifier: imp.moduleSpecifier });
    }
  }
  return map;
}
