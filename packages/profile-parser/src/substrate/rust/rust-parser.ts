/**
 * Rust substrate — extracts the structural
 * (`packages`/`files`/`classes`) and intra-repo (`entities`/`dbOperations`/`calls`) facts from
 * the generic Rust extractors. All extraction is generic Rust; per-repo TUNING comes from an
 * optional `RustProfile` (globs, derive macros, route attributes, client crates).
 *
 * Tier-B only: tree-sitter CST + `mod`/`use`-aware resolution. No Rust semantic indexer exists
 * in this repo (no scip-rust / rust-analyzer wiring), so there is no Tier-A seam to degrade
 * from — the tiers in `rust-callgraph.ts` are the call graph.
 *
 * Unlike the Python substrate this emits REAL `FileNode`s (with `language: 'rust'`) and real
 * crate `Package`s. That is what makes a polyglot monorepo merge correctly: the multi-target
 * scope-overlap guard in `multi/merge.ts` and the scorecard's unclaimed-file report both read
 * `files`, and with an empty array every `.rs` file reports as unclaimed.
 *
 * Each `.rs` file is parsed ONCE (single cached Parser instance in rust-cst) and its CST root
 * is reused across every extractor — never re-parsed per concern.
 *
 * `FileNode`s cover TWO scopes: the `.rs` substrate globs, and the plain-SQL schema/migration
 * files the entity lane reads (`language: 'sql'`). The second is not a widening of scope — those
 * files already back emitted `EntityNode`s, and omitting them left every DDL entity's `fileId`
 * pointing at nothing.
 */
import { rustScipCallFacts } from './scip-calls.js';
import { runScipRust } from './scip-run.js';
import {
  type ClassNode,
  type DbOperation,
  type Entrypoint,
  type EnumNode,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type InterfaceNode,
  type Package,
  type StableIdGenerator,
} from '@coredoc/core';
import type { RustProfile } from '../../types.js';
import { indexRustDefs, resolveRustCalls } from './rust-callgraph.js';
import { extractRustClasses } from './rust-classes.js';
import { type RustCrate, crateOwnerPath, discoverCrates } from './rust-crates.js';
import {
  ENUM_ITEM,
  type RustFile,
  TRAIT_ITEM,
  type TsNode,
  discoverRustFileScope,
  isPublic,
  itemName,
} from './rust-cst.js';
import { extractRustDbOps } from './rust-dbops.js';
import { extractRustEgress } from './rust-egress.js';
import { type RustSchemaFile, extractRustEntities } from './rust-entities.js';
import { extractRustEntrypoints } from './rust-entrypoints.js';
import { buildModuleIndex, buildUseTable } from './rust-imports.js';
import type { Substrate } from '../parse-substrate.js';

// =============================================================================
// Structure — crates → Packages, sources → FileNodes, items → type nodes
// =============================================================================

/** A crate `Package` node. Rust's `Package.language` is always 'rust' (single-language crate). */
function crateToPackage(crate: RustCrate, idGen: StableIdGenerator): Package {
  return {
    id: idGen.packageId(crate.path),
    name: crate.name,
    path: crate.path,
    manifestFile: crate.manifestFile,
    version: crate.version,
    language: 'rust',
    dependencies: Object.fromEntries([...crate.dependencies].map((d) => [d, '*'])),
  };
}

/** A `FileNode` for one parsed source, assigned to its owning crate. */
function toFileNode(file: RustFile, packageId: string, idGen: StableIdGenerator): FileNode {
  const contentHash = idGen.contentHash(file.source);
  return {
    id: idGen.fileId(file.relPath),
    versionedId: idGen.versionedFileId(file.relPath, contentHash),
    path: file.relPath,
    extension: '.rs',
    packageId,
    language: 'rust',
    contentHash,
    loc: file.source.split('\n').filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    }).length,
  };
}

/**
 * A `FileNode` for one plain-SQL schema/migration file that backed an emitted entity.
 *
 * The `.sql` files live OUTSIDE the `.rs` substrate scope but inside the graph: `extractRustEntities`
 * mints `fileId(<the .sql path>)` on every DDL-derived entity. `language` is the honest 'sql'
 * (`FileNode.language` is a free-form string, so no union needed) — calling it 'rust' would make
 * `list-file-symbols` and every language rollup lie about the repo's composition.
 */
function toSchemaFileNode(file: RustSchemaFile, packageId: string, idGen: StableIdGenerator): FileNode {
  const contentHash = idGen.contentHash(file.source);
  return {
    id: idGen.fileId(file.relPath),
    versionedId: idGen.versionedFileId(file.relPath, contentHash),
    path: file.relPath,
    extension: '.sql',
    packageId,
    language: 'sql',
    contentHash,
    loc: file.source.split('\n').filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('--');
    }).length,
  };
}

/**
 * Traits → `InterfaceNode`, enums → `EnumNode`. Structs (and every other method-bearing type) →
 * `ClassNode` in `rust-classes.ts`, which is reference-driven off the `classId` the methods
 * already compute.
 */
function extractTypeNodes(
  files: RustFile[],
  idGen: StableIdGenerator,
): { interfaces: InterfaceNode[]; enums: EnumNode[] } {
  const interfaces: InterfaceNode[] = [];
  const enums: EnumNode[] = [];

  for (const { relPath, root } of files) {
    for (const node of root.descendantsOfType(TRAIT_ITEM) as TsNode[]) {
      const name = itemName(node);
      if (!name) continue;
      const id = idGen.interfaceId(relPath, name);
      // A trait method with no body is a `function_signature_item`, not a `function_item`, so it
      // is deliberately NOT a FunctionNode (nothing can call into a signature — it has no body).
      // It is still a real declaration, so it lives here as an interface member instead of
      // vanishing from the graph.
      const members: InterfaceNode['members'] = [];
      for (const sig of node.descendantsOfType('function_signature_item') as TsNode[]) {
        const memberName = itemName(sig);
        if (!memberName) continue;
        members.push({
          name: memberName,
          kind: 'method',
          isOptional: false,
          isReadonly: false,
          returnType: sig.childForFieldName?.('return_type')?.text
            ? { text: sig.childForFieldName('return_type').text as string }
            : undefined,
          location: { filePath: relPath, startLine: sig.startPosition.row + 1, endLine: sig.endPosition.row + 1 },
        });
      }
      interfaces.push({
        id,
        versionedId: idGen.versionedId(id, node.text as string),
        name,
        kind: 'interface',
        fileId: idGen.fileId(relPath),
        isExported: isPublic(node),
        members,
        location: { filePath: relPath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      });
    }
    for (const node of root.descendantsOfType(ENUM_ITEM) as TsNode[]) {
      const name = itemName(node);
      if (!name) continue;
      const id = idGen.enumId(relPath, name);
      const members: EnumNode['members'] = [];
      for (const v of node.descendantsOfType('enum_variant') as TsNode[]) {
        const vName = itemName(v);
        if (vName) members.push({ name: vName });
      }
      enums.push({
        id,
        versionedId: idGen.versionedId(id, node.text as string),
        name,
        kind: 'enum',
        fileId: idGen.fileId(relPath),
        isExported: isPublic(node),
        isConst: false,
        members,
        location: { filePath: relPath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      });
    }
  }
  return { interfaces, enums };
}

// =============================================================================
// Parse
// =============================================================================

/**
 * The Rust substrate. Without profile knobs the code-level defaults already extract crates, files,
 * functions and types plus the Tier-B call graph.
 */
export const rustSubstrate: Substrate<RustProfile, RustFile> = {
  language: 'rust',
  parserVersion: '1.2.1-rust',
  grammar: 'rust',
  scope: (profile, root) =>
    discoverRustFileScope(
      root,
      profile.substrate.include ?? [],
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    ),
  scip: { language: 'rust', run: runScipRust, facts: rustScipCallFacts },

  async extract({ root, name, profile, idGen, files, skipped, enhanceCalls }) {
    // ENTITIES run here, ahead of package assembly, because the plain-SQL DDL source reads `.sql`
    // migration files that are NOT in the `.rs` substrate scope. Those files back real entity nodes,
    // so they must be owned by a crate and emitted as FileNodes like any other source — otherwise
    // every sqlx entity's `fileId` dangles (22 of them on PostHog).
    const { entities, entityIdByName, tableNames, schemaFiles } = extractRustEntities(files, {
      idGen,
      repoRoot: root,
      deriveMacros: profile.entities?.deriveMacros,
      orm: profile.entities?.orm,
      schemaFileGlobs: profile.entities?.schemaFileGlobs,
    });

    // Crates → Packages. Only crates that actually own an in-scope file are emitted, so an
    // out-of-scope crate does not appear as an empty package; a file under no manifest falls
    // back to a synthetic repo-root package, keeping "every FileNode belongs to a Package" true.
    const crates = discoverCrates(root);
    const ownerOf = new Map<string, string>();
    const usedCratePaths = new Set<string>();
    let needsRootFallback = false;
    for (const relPath of [...files.map((f) => f.relPath), ...schemaFiles.map((s) => s.relPath)]) {
      const owner = crateOwnerPath(relPath, crates);
      if (owner === undefined) {
        ownerOf.set(relPath, '.');
        needsRootFallback = true;
        continue;
      }
      ownerOf.set(relPath, owner);
      usedCratePaths.add(owner);
    }
    const packages: Package[] = crates.filter((c) => usedCratePaths.has(c.path)).map((c) => crateToPackage(c, idGen));
    if (needsRootFallback && !packages.some((p) => p.path === '.')) {
      packages.push({ id: idGen.packageId('.'), name, path: '.', language: 'rust' });
    }

    // Def index + a FunctionNode for every fn.
    const index = indexRustDefs(files, idGen);
    const fnById = new Map<string, FunctionNode>(index.byId);

    const packageIdOf = (relPath: string): string => idGen.packageId(ownerOf.get(relPath) ?? '.');
    const fileNodes: FileNode[] = [
      ...files.map((f) => toFileNode(f, packageIdOf(f.relPath), idGen)),
      ...schemaFiles.map((s) => toSchemaFileNode(s, packageIdOf(s.relPath), idGen)),
    ];
    const classes: ClassNode[] = extractRustClasses(files, idGen);
    const { interfaces, enums } = extractTypeNodes(files, idGen);

    // CALLS — Tier-B, already precision-filtered to SHIPPABLE_PROVENANCE.
    const moduleIndex = buildModuleIndex(files, crates);
    const basicCalls = resolveRustCalls(files, index, idGen, crates, moduleIndex);
    const { calls, stats: callResolution } = await enhanceCalls(basicCalls);

    // Entrypoints, entities, db-ops and egress run UNCONDITIONALLY with code-level defaults —
    // never gated on the profile declaring the corresponding key. `RustProfile` documents every
    // knob as optional with a default so that a bare `{ parserId, substrate }` profile already
    // extracts meaningfully; gating on key presence contradicts that (omitting `entities` would
    // silently yield zero entities AND zero db-ops with no error). Absence means "use the
    // defaults", not "opt out". Ruby and Swift gate; they are the older, worse behaviour.
    const crateNameOf = new Map<string, string>();
    const crateByPath = new Map(crates.map((c) => [c.path, c]));
    for (const [rel, cratePath] of ownerOf) {
      const crate = crateByPath.get(cratePath);
      if (crate) crateNameOf.set(rel, crate.name);
    }

    const entrypoints: Entrypoint[] = extractRustEntrypoints(files, idGen, {
      routeAttributes: profile.entrypoints?.http?.routeAttributes,
      routerMethods: profile.entrypoints?.http?.routerMethods,
      registrationCalls: profile.entrypoints?.http?.registrationCalls,
      contractFrameworks: profile.entrypoints?.contracts?.frameworks,
      grpcServiceSuffixes: profile.entrypoints?.grpc?.serviceSuffixes,
      crates,
      crateNameOf,
    });

    const externalCalls: ExternalCallEdge[] = extractRustEgress(files, idGen, {
      clientCrates: profile.egress?.clientCrates,
    });

    const dbRes = extractRustDbOps(files, tableNames, entityIdByName, {
      idGen,
      methods: profile.dbOperations?.methods,
    });
    const dbOperations: DbOperation[] = dbRes.dbOperations;
    // The db-op performers are a subset of the defs; add any the call-graph index missed (index
    // nodes win — they carry real endLine/params). Merged by canonical id.
    for (const f of dbRes.functions) if (!fnById.has(f.id)) fnById.set(f.id, f);

    // Observability: unresolved glob-import sites + skipped files. `buildUseTable` is memoized per
    // file, so this reads the tables the call and egress lanes already built rather than re-walking.
    let totalImports = 0;
    let globImports = 0;
    for (const f of files) {
      const t = buildUseTable(f);
      totalImports += t.byLocal.size;
      globImports += t.globCount;
    }
    if (skipped.length > 0 || globImports > 0) {
      console.warn(
        `[coredoc] rust ${name}: ${skipped.length} file(s) skipped; ` +
          `${globImports} glob import(s) unresolved (\`use m::*\` — a Tier-B gap).`,
      );
    }

    return {
      type: 'backend',
      entrypoints,
      externalCalls,
      functions: [...fnById.values()],
      calls,
      packages,
      files: fileNodes,
      classes,
      interfaces,
      enums,
      entities,
      dbOperations,
      stats: { totalImports, callResolution, dbOpResolution: dbRes.stats },
    };
  },
};
