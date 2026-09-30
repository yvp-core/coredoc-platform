/**
 * Go repo parser — assembles a linker-ready `ParsedRepoLike` plus the structural
 * (`packages`/`files`/`classes`/`interfaces`/`enums`/`typeAliases`) and intra-repo
 * (`entrypoints`/`entities`/`dbOperations`/`calls`/`externalCalls`) facts from the generic Go
 * extractors. All extraction is generic Go; per-repo TUNING comes from an optional `GoProfile`
 * (globs, struct tags, router methods, db verbs, client packages).
 *
 * Tree-sitter extraction always works; an optional compiler index enriches internal calls.
 *
 * Like the Rust substrate (and unlike Python) this emits REAL `FileNode`s with `language: 'go'`
 * and real module `Package`s. That is what makes a polyglot monorepo merge correctly: the
 * multi-target scope-overlap guard in `multi/merge.ts` and the scorecard's unclaimed-file report
 * both read `files`, and with an empty array every `.go` file reports as unclaimed.
 *
 * Each `.go` file is parsed ONCE (single cached Parser instance in go-cst) and its CST root is
 * reused across every extractor — never re-parsed per concern.
 */
import type { AnalysisRecord } from '@coredoc/core';
import { loadOptionalScip } from '../../facts/scip/source-manifest.js';
import { optionalAnalysis } from '../../facts/scip/index-host.js';
import { mergeScipCallFacts } from '../../facts/scip/call-facts.js';
import { goScipCallFacts } from './scip-calls.js';
import { runScipGo } from './scip-run.js';
import { readFileSync } from 'node:fs';
import {
  type CallEdge,
  type CallResolutionStats,
  type DbOpResolutionStats,
  type ClassNode,
  type DbOperation,
  type DecoratorInfo,
  type EntityNode,
  type Entrypoint,
  type EnumMember,
  type EnumNode,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type InterfaceNode,
  type Package,
  type ParsedRepo,
  type ParsedRepoLike,
  type PropertyNode,
  type RepoType,
  StableIdGenerator,
  type TypeAliasNode,
} from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import type { GoProfile } from '../../types.js';
import { indexGoDefs, resolveGoCalls } from './go-callgraph.js';
import {
  CONST_DECLARATION,
  CONST_SPEC,
  FIELD_DECLARATION,
  type GoFile,
  IDENTIFIER,
  INTERFACE_TYPE,
  METHOD_DECLARATION,
  METHOD_SPEC,
  STRUCT_TYPE,
  TYPE_ALIAS,
  TYPE_SPEC,
  type TsNode,
  baseTypeName,
  discoverGoFiles,
  fieldNames,
  goFunctionId,
  isExported,
  itemName,
  namedChildrenOfType,
  packageName,
  parseGo,
  receiverTypeName,
  structTags,
} from './go-cst.js';
import { extractGoDbOps } from './go-dbops.js';
import { extractGoEgress } from './go-egress.js';
import { extractGoEntities } from './go-entities.js';
import { extractGoEntrypoints } from './go-entrypoints.js';
import { buildImportTable, buildPackageIndex } from './go-imports.js';
import { type GoModule, discoverGoModules, moduleOwnerPath } from './go-modules.js';
import { buildGoTypeEnv } from './go-types.js';
import { toParsedRepo } from '../to-parsed-repo.js';

export interface ParseGoRepoOptions {
  /** Gateway prefix from RepoConfig.httpPrefix, propagated to the linker for prefix-aware matching. */
  httpPrefix?: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)). */
  repoKey?: string;
  /** Unused today (no incremental cache for Go yet); accepted for ParseOptions parity. */
  cacheDir?: string;
  scipOutDir?: string;
}

/** In-module parse stats surfaced on the final ParseStats (built here, not via `assemble()`). */
export interface GoParseStats {
  analysis?: AnalysisRecord;
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  totalImports: number;
  parseTimeMs: number;
  /** Language-neutral call-resolution counters from the Tier-B pass (spec BR-1/BR-2). */
  callResolution: CallResolutionStats;
  dbOpResolution: DbOpResolutionStats;
}

/** The Go parser's full output — the linker reads only the ParsedRepoLike subset. */
export interface GoParsedRepo extends ParsedRepoLike {
  packages: Package[];
  files: FileNode[];
  classes: ClassNode[];
  interfaces: InterfaceNode[];
  enums: EnumNode[];
  typeAliases: TypeAliasNode[];
  entities: EntityNode[];
  dbOperations: DbOperation[];
  calls: CallEdge[];
  /** Carrier for the in-module stats (toFullParsedRepo folds these into ParseStats). */
  parseStats: GoParseStats;
}

// =============================================================================
// Structure — modules → Packages, sources → FileNodes, type decls → type nodes
// =============================================================================

/**
 * The directory of a repo-relative path — a Go package IS a directory ('' at the repo root, the
 * same spelling `go-imports.ts` and `go-egress.ts` use, so package keys join across the modules).
 */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * A Go package `Package` node — one per DIRECTORY.
 *
 * The unit is the directory, NOT the `go.mod` module, because the directory is what Go itself
 * treats as the package: it is the import unit, and it is the scope in which a top-level
 * identifier is visible unqualified (the rule `go-callgraph.ts`'s Tier-A resolution relies on).
 * Mirroring Cargo and emitting one Package per module collapses a whole service into a single
 * node — a repo with one `go.mod` and 60 directories gave 1 Package for 483 files, which makes
 * `FileNode.packageId` carry no information at all.
 *
 * `name` is read from the `package` clause rather than taken from the path: Go does not require
 * them to match (`internal/database` may declare `package db`), and the clause is what every
 * import site actually writes.
 *
 * `dependencies` is stamped ONLY on the directory that holds the `go.mod`. A require list is a
 * MODULE fact; repeating it on every package under that module would assert that each of them
 * depends on all of it, which is false. The other packages still carry `manifestFile`, so the
 * owning module — and therefore its dependency set — stays discoverable from any of them.
 */
function directoryToPackage(
  dir: string,
  dirFiles: GoFile[],
  mod: GoModule | undefined,
  fallbackName: string,
  idGen: StableIdGenerator,
): Package {
  // A directory can hold more than one package clause (`foo` beside an external `foo_test`), so
  // take the most common one rather than whichever file happened to be enumerated first.
  const counts = new Map<string, number>();
  for (const f of dirFiles) {
    const n = packageName(f);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let name = dir === '.' ? fallbackName : (dir.split('/').pop() as string);
  let best = 0;
  for (const [n, c] of counts) {
    if (c > best) {
      best = c;
      name = n;
    }
  }
  return {
    id: idGen.packageId(dir),
    name,
    path: dir,
    manifestFile: mod?.manifestFile,
    version: mod?.goVersion,
    language: 'go',
    dependencies: mod && mod.path === dir ? Object.fromEntries([...mod.dependencies].map((d) => [d, '*'])) : undefined,
  };
}

/** A `FileNode` for one parsed source, assigned to its own directory's package. */
function toFileNode(file: GoFile, packageId: string, idGen: StableIdGenerator): FileNode {
  const contentHash = idGen.contentHash(file.source);
  return {
    id: idGen.fileId(file.relPath),
    versionedId: idGen.versionedFileId(file.relPath, contentHash),
    path: file.relPath,
    extension: '.go',
    packageId,
    language: 'go',
    contentHash,
    loc: file.source.split('\n').filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    }).length,
  };
}

/**
 * A struct field's tags as `DecoratorInfo`s. A Go struct tag IS the language's annotation
 * mechanism — it is what `json`, `db` and `gorm` read at runtime — so it belongs in the node's
 * `decorators` (documented as "Decorators/annotations") rather than being dropped. The value is
 * the tag's first comma segment (`json:"id,omitempty"` → 'id'), which is the part that NAMES a
 * column or wire field; `expression` keeps the round-trippable spelling.
 */
function tagDecorators(fieldDecl: TsNode): DecoratorInfo[] | undefined {
  const tags = structTags(fieldDecl);
  if (tags.size === 0) return undefined;
  return [...tags].map(([name, value]) => ({ name, arguments: [value], expression: `${name}:"${value}"` }));
}

/**
 * The `field_declaration` properties of a struct.
 *
 * `fieldNames` (not `childForFieldName('name')`) is load-bearing twice over: `a, b int` is ONE
 * declaration with two names, and an EMBEDDED field has none at all. An embedded field is a real
 * member — Go itself names it after its type — so it is emitted under that type name rather than
 * silently dropped.
 */
function structProperties(
  structNode: TsNode,
  classId: string,
  relPath: string,
  idGen: StableIdGenerator,
): PropertyNode[] {
  const out: PropertyNode[] = [];
  for (const fd of structNode.descendantsOfType(FIELD_DECLARATION) as TsNode[]) {
    const typeText = fd.childForFieldName?.('type')?.text as string | undefined;
    const names = fieldNames(fd);
    const embedded = names.length === 0 ? baseTypeName(typeText) : undefined;
    const decorators = tagDecorators(fd);
    for (const name of names.length > 0 ? names : embedded ? [embedded] : []) {
      out.push({
        id: idGen.generateNodeId('variable', relPath, `${classId}.${name}`),
        name,
        classId,
        // Go's ENTIRE visibility model is "the first rune is uppercase" — there is no modifier
        // node to read, so this is the only signal the CST can offer.
        visibility: isExported(name) ? 'public' : 'private',
        isStatic: false,
        isReadonly: false,
        // A pointer field is Go's only structural "may be absent" marker.
        isOptional: typeText?.startsWith('*') ?? false,
        type: typeText ? { text: typeText } : undefined,
        decorators,
        location: { filePath: relPath, startLine: fd.startPosition.row + 1, endLine: fd.endPosition.row + 1 },
      });
    }
  }
  return out;
}

/** The interface members of an `interface_type` — one per `method_spec`. */
function interfaceMembers(ifaceNode: TsNode, relPath: string): InterfaceNode['members'] {
  const members: InterfaceNode['members'] = [];
  for (const spec of ifaceNode.descendantsOfType(METHOD_SPEC) as TsNode[]) {
    const name = itemName(spec);
    if (!name) continue;
    const result = spec.childForFieldName?.('result')?.text as string | undefined;
    members.push({
      name,
      kind: 'method',
      isOptional: false,
      isReadonly: false,
      returnType: result ? { text: result } : undefined,
      location: { filePath: relPath, startLine: spec.startPosition.row + 1, endLine: spec.endPosition.row + 1 },
    });
  }
  return members;
}

/**
 * `dir#Type` → the const names declared with that type, in source order.
 *
 * Go HAS NO ENUM. The universal idiom is a defined type plus a const block whose specs carry that
 * type — usually with `iota`, sometimes with string literals:
 *
 *     type Status int
 *     const ( StatusActive Status = iota; StatusInactive )
 *
 * Only the FIRST spec of an `iota` group repeats the type, so a const_declaration is treated as
 * one group: if any of its specs names the type, every spec in it is a member. That pairing is
 * the ONLY static evidence a defined type is an enumeration — a defined type with no such const
 * block (`type UserID int64`) is a named type, not an enum, and stays a TypeAlias. Keyed by
 * DIRECTORY because a Go package spans files: the `const` block routinely lives beside the
 * `type` in another file of the same package.
 */
function enumMembersByType(files: GoFile[]): Map<string, EnumMember[]> {
  const out = new Map<string, EnumMember[]>();
  for (const file of files) {
    const dir = dirOf(file.relPath);
    for (const decl of file.root.descendantsOfType(CONST_DECLARATION) as TsNode[]) {
      const specs =
        namedChildrenOfType(decl, CONST_SPEC).length > 0
          ? namedChildrenOfType(decl, CONST_SPEC)
          : (decl.descendantsOfType(CONST_SPEC) as TsNode[]);
      let typeName: string | undefined;
      for (const spec of specs) {
        const t = baseTypeName(spec.childForFieldName?.('type')?.text as string | undefined);
        if (t) {
          typeName = t;
          break;
        }
      }
      if (!typeName) continue;
      const key = `${dir}#${typeName}`;
      const members = out.get(key) ?? [];
      for (const spec of specs) {
        for (const ident of namedChildrenOfType(spec, IDENTIFIER)) {
          const name = ident.text as string;
          // `_` is Go's explicit "skip this iota slot" — a real const with no name to record.
          if (name === '_') continue;
          members.push({ name });
        }
      }
      out.set(key, members);
    }
  }
  return out;
}

/**
 * `dir#Type` → the ids of the methods declared on that receiver type.
 *
 * Keyed on PACKAGE (directory) + type, not file + type. This is the one place Go is strictly
 * EASIER than Rust: Rust's `impl` blocks can sit in any module and it has to give up on the
 * cross-file case, whereas Go's own scoping rule says a method must be declared in the same
 * package as its receiver type — so package+type is not a heuristic, it is the language's rule,
 * and `ClassNode.methods` is COMPLETE rather than best-effort. (`svc/a.go` declaring
 * `func (s *Svc) Handle()` and `svc/b.go` declaring `func (s *Svc) Close()` is the normal shape.)
 */
function methodIdsByPackageType(files: GoFile[], idGen: StableIdGenerator): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { relPath, root } of files) {
    for (const decl of root.descendantsOfType(METHOD_DECLARATION) as TsNode[]) {
      const typeName = receiverTypeName(decl);
      if (!typeName) continue;
      const key = `${dirOf(relPath)}#${typeName}`;
      const ids = out.get(key) ?? [];
      const id = goFunctionId(idGen, relPath, decl);
      if (!ids.includes(id)) ids.push(id);
      out.set(key, ids);
    }
  }
  return out;
}

/**
 * `type X struct{…}` → `ClassNode`, `type X interface{…}` → `InterfaceNode`, a defined type with
 * a typed const block → `EnumNode`, anything else named → `TypeAliasNode`.
 *
 * An interface's `method_spec`s have NO body, so they are deliberately NOT `FunctionNode`s
 * (nothing can call into a signature). They stay in the graph as interface members instead of
 * vanishing — the same call Rust makes for `function_signature_item`.
 */
function extractTypeNodes(
  files: GoFile[],
  methodIds: Map<string, string[]>,
  enumMembers: Map<string, EnumMember[]>,
  idGen: StableIdGenerator,
): { classes: ClassNode[]; interfaces: InterfaceNode[]; enums: EnumNode[]; typeAliases: TypeAliasNode[] } {
  const classes: ClassNode[] = [];
  const interfaces: InterfaceNode[] = [];
  const enums: EnumNode[] = [];
  const typeAliases: TypeAliasNode[] = [];

  for (const { relPath, root } of files) {
    const dir = dirOf(relPath);
    // `type_spec` is `type X …`; `type_alias` is `type X = Y`. Both name a type, and neither
    // nests, so there is no Rust-style scope chain to build.
    const specs = [
      ...(root.descendantsOfType(TYPE_SPEC) as TsNode[]),
      ...(root.descendantsOfType(TYPE_ALIAS) as TsNode[]),
    ];
    for (const node of specs) {
      const name = itemName(node);
      if (!name) continue;
      const typeNode = node.childForFieldName?.('type') as TsNode | undefined;
      const fileId = idGen.fileId(relPath);
      const location = {
        filePath: relPath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      };

      if (typeNode?.type === STRUCT_TYPE) {
        const id = idGen.classId(relPath, name);
        classes.push({
          id,
          versionedId: idGen.versionedId(id, node.text as string),
          name,
          kind: 'class',
          fileId,
          isExported: isExported(name),
          isAbstract: false,
          methods: methodIds.get(`${dir}#${name}`) ?? [],
          properties: structProperties(typeNode, id, relPath, idGen),
          // Spelled out so TS does not pick up the implicit `Object.prototype.constructor`
          // shape for the optional `constructor` field (matches facts/structural/to-nodes.ts).
          constructor: undefined,
          location,
        });
        continue;
      }

      if (typeNode?.type === INTERFACE_TYPE) {
        const id = idGen.interfaceId(relPath, name);
        interfaces.push({
          id,
          versionedId: idGen.versionedId(id, node.text as string),
          name,
          kind: 'interface',
          fileId,
          isExported: isExported(name),
          members: interfaceMembers(typeNode, relPath),
          location,
        });
        continue;
      }

      // `type X = Y` is an ALIAS by definition — it introduces no new type, so it can never
      // carry a typed const block and is never an enum.
      const members = node.type === TYPE_ALIAS ? undefined : enumMembers.get(`${dir}#${name}`);
      if (members && members.length > 0) {
        const id = idGen.enumId(relPath, name);
        enums.push({
          id,
          versionedId: idGen.versionedId(id, node.text as string),
          name,
          kind: 'enum',
          fileId,
          isExported: isExported(name),
          // Go const blocks are always compile-time constant; `isConst` is TS's `const enum`
          // notion (an inlining directive), which Go has no analogue for.
          isConst: false,
          members,
          location,
        });
        continue;
      }

      const id = idGen.typeAliasId(relPath, name);
      typeAliases.push({
        id,
        versionedId: idGen.versionedId(id, node.text as string),
        name,
        kind: 'type-alias',
        fileId,
        isExported: isExported(name),
        aliasedType: { text: (typeNode?.text as string | undefined) ?? name },
        location,
      });
    }
  }
  return { classes, interfaces, enums, typeAliases };
}

// =============================================================================
// Parse
// =============================================================================

/**
 * Parse a Go repo on disk into a `GoParsedRepo`. Without a profile the code-level defaults
 * already extract modules, files, functions, types, entrypoints, entities, db-ops, egress and
 * the Tier-B call graph.
 */
export async function parseGoRepo(
  root: string,
  name: string,
  opts: ParseGoRepoOptions = {},
  profile?: GoProfile,
): Promise<GoParsedRepo> {
  const start = Date.now();
  // One id generator for the whole repo — the two-ID invariant's single seed
  // (repoHash = hash(repoKey ?? name)), exactly like the TS/Ruby/Swift/Python/Rust paths.
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);

  const include = profile?.substrate.include ?? ['**/*.go'];
  const exclude = profile?.substrate.exclude ?? [];
  const relPaths = discoverGoFiles(root, include, exclude, profile?.substrate.excludeDefaults);

  // Parse each file exactly once; every extractor reuses the shared CST root.
  const files: GoFile[] = [];
  const skippedFiles: string[] = [];
  for (const relPath of relPaths) {
    let source: string;
    try {
      source = readFileSync(`${root}/${relPath}`, 'utf-8');
    } catch {
      skippedFiles.push(relPath);
      continue;
    }
    try {
      const rootNode = await parseGo(source);
      files.push({ relPath, source, root: rootNode });
    } catch {
      // tree-sitter tolerates syntax errors (emits ERROR nodes, never throws) and utf-8 decode
      // is lenient, so this catch only fires on an unexpected parser/WASM failure. The file is
      // dropped and counted (never crashing the whole run).
      skippedFiles.push(relPath);
    }
  }

  // Directories → Packages. Only directories that actually hold an in-scope file are emitted, so
  // an excluded tree never appears as an empty package, and every FileNode is assigned to its own
  // directory's package — which keeps "every FileNode belongs to a Package" true by construction
  // rather than needing a synthetic fallback for files that sit under no `go.mod`.
  const modules = discoverGoModules(root);
  const moduleByPath = new Map(modules.map((m) => [m.path, m]));
  const filesByDir = new Map<string, GoFile[]>();
  for (const file of files) {
    const dir = dirOf(file.relPath) || '.';
    const list = filesByDir.get(dir) ?? [];
    list.push(file);
    filesByDir.set(dir, list);
  }
  const packages: Package[] = [...filesByDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, dirFiles]) => {
      // Resolve the owning module from a real FILE path, so the longest-prefix match behaves the
      // same way it does for every other caller (a bare '.' is not a path any module prefixes).
      const ownerPath = moduleOwnerPath(dirFiles[0].relPath, modules);
      return directoryToPackage(dir, dirFiles, ownerPath ? moduleByPath.get(ownerPath) : undefined, name, idGen);
    });

  // A module root that holds no .go file of its own still gets a Package, so the `go.mod` require
  // list has somewhere to live. `server/go.mod` beside `server/cmd/…` and `server/internal/…` is
  // the normal Go layout, and without this the module's dependency set would vanish from the
  // output entirely. Such a package owns zero files by construction — that is a fact about the
  // repo, not a placeholder.
  const emittedPaths = new Set(packages.map((p) => p.path));
  const inScopeModulePaths = new Set(
    [...filesByDir.values()].map((dirFiles) => moduleOwnerPath(dirFiles[0].relPath, modules)),
  );
  for (const mod of modules) {
    if (!inScopeModulePaths.has(mod.path) || emittedPaths.has(mod.path)) continue;
    packages.push({
      id: idGen.packageId(mod.path),
      name: mod.modulePath,
      path: mod.path,
      manifestFile: mod.manifestFile,
      version: mod.goVersion,
      language: 'go',
      dependencies: Object.fromEntries([...mod.dependencies].map((d) => [d, '*'])),
    });
  }
  packages.sort((a, b) => a.path.localeCompare(b.path));

  // Def index + a FunctionNode for every func, method and named closure.
  const index = indexGoDefs(files, idGen);
  const fnById = new Map<string, FunctionNode>(index.byId);

  const fileNodes: FileNode[] = files.map((f) => toFileNode(f, idGen.packageId(dirOf(f.relPath) || '.'), idGen));
  const { classes, interfaces, enums, typeAliases } = extractTypeNodes(
    files,
    methodIdsByPackageType(files, idGen),
    enumMembersByType(files),
    idGen,
  );

  // CALLS — Tier-B, already precision-filtered to the shippable provenances. The type environment
  // is built ONCE and shared with the entrypoint lane: both answer "what type does this value
  // hold", and two copies would drift into disagreeing about which handler a route points at.
  const packageIndex = buildPackageIndex(files, modules);
  const typeEnv = buildGoTypeEnv(files, packageIndex);
  const basicCalls = resolveGoCalls(files, index, idGen, packageIndex, typeEnv);
  const enhanced = await optionalAnalysis(
    'go',
    files.length ? profile?.substrate.analysis : { mode: 'basic' },
    () => runScipGo(root, { outDir: opts.scipOutDir ?? opts.cacheDir }),
    (path) =>
      mergeScipCallFacts(loadOptionalScip(path), goScipCallFacts(files, idGen), basicCalls.calls, basicCalls.stats),
  ).catch((error) => {
    releaseParsedTrees(files);
    throw error;
  });
  const { calls, stats: callResolution } = enhanced.result ?? basicCalls;
  const ambiguousCalls = callResolution.callSites - callResolution.resolvedCalls;

  // Entrypoints, entities, db-ops and egress run UNCONDITIONALLY with code-level defaults —
  // never gated on the profile declaring the corresponding key. `GoProfile` documents every knob
  // as optional with a default so that a bare `{ parserId, substrate }` profile already extracts
  // meaningfully; gating on key presence contradicts that (omitting `entities` would silently
  // yield zero entities AND zero db-ops with no error). Absence means "use the defaults", not
  // "opt out". Ruby and Swift gate; they are the older, worse behaviour.
  const entrypoints: Entrypoint[] = extractGoEntrypoints(files, idGen, {
    routerMethods: profile?.entrypoints?.http?.routerMethods,
    mountMethods: profile?.entrypoints?.http?.mountMethods,
    cliFrameworks: profile?.entrypoints?.cli?.frameworks,
    grpcServiceSuffixes: profile?.entrypoints?.grpc?.serviceSuffixes,
    modules,
    packageIndex,
    typeEnv,
  });

  const externalCalls: ExternalCallEdge[] = extractGoEgress(files, idGen, {
    clientPackages: profile?.egress?.clientPackages,
  });

  const { entities, entityIdByName, tableNames } = extractGoEntities(files, {
    idGen,
    repoRoot: root,
    structTags: profile?.entities?.structTags,
    orm: profile?.entities?.orm,
    schemaFileGlobs: profile?.entities?.schemaFileGlobs,
  });
  const dbRes = extractGoDbOps(files, tableNames, entityIdByName, {
    idGen,
    methods: profile?.dbOperations?.methods,
    sqlcQueryGlobs: profile?.dbOperations?.sqlcQueryGlobs,
    repoRoot: root,
  });
  const dbOperations: DbOperation[] = dbRes.dbOperations;
  const dbOpResolution = dbRes.stats;
  // The db-op performers are a subset of the defs plus the synthesized package-scope `init`
  // performers; add any the call-graph index missed (index nodes win — they carry real
  // endLine/params). Merged by canonical id.
  for (const f of dbRes.functions) if (!fnById.has(f.id)) fnById.set(f.id, f);

  // Observability: the three Tier-B holes a reader must be able to see. `buildImportTable` is
  // memoized per GoFile object, so this reads the tables the call/egress lanes already built
  // rather than re-walking.
  let totalImports = 0;
  let dotImports = 0;
  for (const f of files) {
    const t = buildImportTable(f);
    totalImports += t.byLocal.size;
    dotImports += t.dotImports.length;
  }
  if (skippedFiles.length > 0 || dotImports > 0 || ambiguousCalls > 0) {
    console.warn(
      `[coredoc] go ${name}: ${skippedFiles.length} file(s) skipped; ` +
        `${dotImports} dot import(s) unresolved (\`import . "pkg"\` binds names this substrate cannot see); ` +
        `${ambiguousCalls} ambiguous call site(s) dropped rather than guessed (a Tier-B gap); ` +
        `${typeEnv.gaps.resolved} operand type(s) inferred, ` +
        `${typeEnv.gaps.undecidable} left undecidable (interface values, range/type-switch bindings, ` +
        'promoted members, out-of-scope packages).',
    );
  }

  // Free the WASM-side trees: every lane has run and the returned repo holds only plain data.
  // web-tree-sitter never garbage-collects trees and its heap is hard-capped at 2GB.
  releaseParsedTrees(files);

  return {
    id: idGen.getRepoHash(),
    name,
    entrypoints,
    externalCalls,
    functions: [...fnById.values()],
    calls,
    type: 'backend',
    httpPrefix: opts.httpPrefix,
    packages,
    files: fileNodes,
    classes,
    interfaces,
    enums,
    typeAliases,
    entities,
    dbOperations,
    parseStats: {
      totalFiles: relPaths.length,
      parsedFiles: files.length,
      skippedFiles: skippedFiles.length,
      totalImports,
      parseTimeMs: Date.now() - start,
      callResolution,
      analysis: enhanced.analysis,
      dbOpResolution,
    },
  };
}

/**
 * Adapt a `GoParsedRepo` to a full `ParsedRepo` for the CLI parse → push → DB flow. `stats` is
 * built here in-module from the parser's own `parseStats` (NOT via `assemble()`). `httpPrefix` is
 * dropped (not a `ParsedRepo` field; applied at link time).
 */
export function toFullParsedRepo(
  gs: GoParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.2.0-go',
): ParsedRepo {
  const functions = gs.functions ?? [];
  const s = gs.parseStats;
  return toParsedRepo(
    {
      id: gs.id,
      name: gs.name,
      path: repoPath,
      type: (gs.type as RepoType | undefined) ?? 'backend',
      parsedAt,
      parserId,
      packages: gs.packages,
      files: gs.files,
      functions,
      classes: gs.classes,
      interfaces: gs.interfaces,
      typeAliases: gs.typeAliases,
      enums: gs.enums,
      entrypoints: gs.entrypoints,
      entities: gs.entities,
      dbOperations: gs.dbOperations,
      calls: gs.calls,
      externalCalls: gs.externalCalls,
      stats: {
        totalFiles: s.totalFiles,
        parsedFiles: s.parsedFiles,
        skippedFiles: s.skippedFiles,
        totalImports: s.totalImports,
        parseTimeMs: s.parseTimeMs,
        callResolution: s.callResolution,
        analysis: s.analysis,
        dbOpResolution: s.dbOpResolution,
      },
    },
    { parserVersion },
  );
}
