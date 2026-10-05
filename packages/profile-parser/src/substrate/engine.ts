/**
 * SubstrateProfileEngine — runs an ExtractionProfile over a backend-neutral
 * Substrate (tree-sitter structure + SCIP call graph) and produces a ParsedRepo.
 *
 * It dispatches each profile rule to a primitive that reads ONLY from the
 * Substrate:
 *   - decorator-route / decorator-queue / decorator-entity → substrate.classes()
 *   - call-route / call-queue / factory-entity            → substrate.callShapes()
 *   - db-operation / external-client                       → substrate.classes()
 *     for structure, substrate.internalCalls()/externalCalls() for edges
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSentinelEntityName } from '../entity-sentinels.js';
import { assemble, tagExportedMonikers } from '../facts/index.js';
import { isLanguageBuiltinCall } from './builtin-calls.js';
import { escapeRegExp, regexFromSource, requirePathToRel } from './regex-util.js';
import { type PrismaModel, loadPrismaModels } from './engine/prisma-schema.js';
import {
  HTTP_VERBS,
  NEXT_APP_PAGE_FILES,
  canonicalizeParams,
  applyGlobalPrefix,
  derivePagesRoutePath,
  deriveNextRoutePath,
  extractParams,
  isPagesApiRouteFile,
  isPagesRouteFile,
  nextSegmentsToRoutePath,
  packageLocalRouteRootIndex,
  httpMethodFromCallee,
  joinPaths,
  joinRoutePath,
  normalizeSegment,
} from './engine/path-helpers.js';
import {
  arrowTarget,
  boolEntry,
  boolEntryOpt,
  decoName,
  decoStringArgs,
  firstStringArg,
  firstWrappedMemberArg,
  objectEntryString,
  objectPropFromText,
  optionString,
  parseCypherOp,
  parseSqlStatement,
  queryText,
  receiverPatternMatches,
  resolveDecoratorFieldType,
  singularize,
  snakeCase,
} from './engine/text-helpers.js';
import type { BaselineResult } from '../facts/index.js';
import type { CodeGraph } from '../facts/graph/graph-builder.js';
import type {
  CallResolutionStats,
  ComponentNode,
  ComponentUsage,
  DbOperation,
  DbOperationType,
  EntityField,
  EntityNode,
  EntityRelation,
  Entrypoint,
  ExternalCallEdge,
  FunctionNode,
  HttpMethod,
  ParseError,
  ParsedRepo,
  RouteNode,
  StateStoreNode,
} from '@coredoc/core/types';
import type {
  ArgRef,
  CliEntrypointRule,
  ComponentRule,
  ConventionEntityRule,
  CustomRuleEmit,
  CustomRuleFacts,
  DbOpRule,
  Detector,
  EntrypointRule,
  GraphqlEntrypointRule,
  GrpcEntrypointRule,
  NextAppRouterHttpRule,
  NextPagesApiHttpRule,
  PrismaSchemaEntityRule,
  ExtractionProfile,
  FileConventionRouteRule,
  HandlerTable,
  HttpEntrypointRule,
  QueueEntrypointRule,
  RouteRule,
  StateStoreRule,
} from '../types.js';
import type {
  ArgNode,
  CallEdgeFact,
  CallSite,
  ComponentSite,
  Substrate,
  SubstrateClass,
  SubstrateFunction,
  SubstrateLoc,
  VueSubstrate,
} from './interface.js';
import { markUnresolved } from '../unresolved-sentinel.js';

/** Does this substrate parse `.vue` script blocks (and so offer Vue SFC sites)? */
function isVueSubstrate(s: Substrate): s is Substrate & VueSubstrate {
  return typeof (s as Partial<VueSubstrate>).vueComponentSites === 'function';
}

// ── re-exports (preserve the free-helper surface other modules may import) ────
export { regexFromSource, requirePathToRel } from './regex-util.js';
export { type PrismaModel, loadPrismaModels, parsePrismaSchema } from './engine/prisma-schema.js';
export {
  HTTP_VERBS,
  canonicalizeParams,
  deriveNextRoutePath,
  extractParams,
  httpMethodFromCallee,
  joinPaths,
  joinRoutePath,
  normalizeSegment,
  packageLocalRouteRootIndex,
} from './engine/path-helpers.js';
export {
  arrowTarget,
  boolEntry,
  boolEntryOpt,
  decoName,
  firstStringArg,
  firstWrappedMemberArg,
  objectEntryString,
  objectPropFromText,
  optionString,
  parseCypherOp,
  parseSqlOp,
  parseSqlStatement,
  queryText,
  receiverPatternMatches,
  resolveDecoratorFieldType,
  singularize,
  snakeCase,
} from './engine/text-helpers.js';

/**
 * Version-hash seed for an entity node. Folds the column/relation content into
 * the seed (after a name/line `prefix`) so a field-type/flag change with no line
 * shift still flips the checksum — the incremental cloud diff updates a node
 * only when its versionedId differs. Shared by the prisma/decorator/factory
 * entity paths so all three keep identical seed semantics (Ruby has its own,
 * since its columns come from schema.rb rather than the class body).
 */
export function entityVersionSeed(prefix: string, fields: unknown, relations: unknown): string {
  return `${prefix}:${JSON.stringify({ fields, relations })}`;
}

/** GraphQL root type for a root operation (`query` → `Query`, `mutation` → `Mutation`, …). */
function rootTypeFor(op: 'query' | 'mutation' | 'subscription'): string {
  return op.charAt(0).toUpperCase() + op.slice(1);
}

/** The string value of an expression text that IS a quoted literal (no interpolation), else undefined. */
function quotedLiteral(text: string): string | undefined {
  const m = /^(['"`])([^'"`]*)\1$/.exec(text.trim());
  return m ? m[2] : undefined;
}

/**
 * Whether an object-literal's raw text carries `key` as an ES6 shorthand property
 * (`{ groupId, topic }`). The substrate's structured `objectEntries` only surfaces
 * `pair` nodes, so a shorthand key is invisible there — but a shorthand IS a
 * property reference, and dropping it silently is the very fail-quiet this guards.
 * The binding it names is the key itself, which the const resolver then folds.
 */
function hasShorthandKey(objectText: string, key: string): boolean {
  // `key` is PROFILE-AUTHORED text, so it must be escaped before it reaches a RegExp. Interpolated
  // raw it is read as pattern syntax: `$topic` becomes an end-anchor and silently never matches,
  // `a|b` matches a bare `b`, and `topic(` throws SyntaxError and aborts the whole extraction.
  return new RegExp(`[{,]\\s*${escapeRegExp(key)}\\s*[,}]`).test(objectText);
}

/**
 * A required entrypoint dimension (queue topic, route path, cli command) that the
 * engine could not fold to a static string. Accumulated per rule per file so the
 * repo `errors[]` carries one warning with a count instead of one per site.
 */
interface UnresolvedDimension {
  file: string;
  line: number;
  ruleLabel: string;
  dimension: string;
  count: number;
  /** Distinct source expressions seen, insertion-ordered, capped for message size. */
  expressions: Set<string>;
}

/** How many distinct unresolved expressions a single warning message lists. */
const UNRESOLVED_SAMPLE_CAP = 5;

/** Where an unresolved dimension was seen, for the deduped warning record. */
interface UnresolvedContext {
  /** Human-readable rule identity, e.g. `queue entrypoint rule createKafkaConsumer`. */
  ruleLabel: string;
  dimension: string;
  file: string;
  line: number;
}

export class SubstrateProfileEngine {
  private readonly entrypoints: Entrypoint[] = [];
  private readonly entities: EntityNode[] = [];
  private readonly dbOps: DbOperation[] = [];
  /**
   * The db-op resolution record (spec BR-4/LIM-4), counted in SITES beside the existing
   * `continue`/`push` of the two db-op lanes — the emitted operations are untouched.
   *
   * A site is every `callShapes()` site whose method is in `dbOperations.opMap` and that has a
   * receiver, plus every raw-query matcher hit — counted BEFORE the receiver filters but AFTER the
   * enclosing-function guard. A site with no enclosing function is UNCOUNTED by construction, as
   * in every other substrate (Ruby/Python/Swift drop a module-scope site before counting): there
   * is no caller node to attribute an operation to, so it is not a miss of this extractor.
   * Sites the receiver filters then drop ARE misses, not exclusions: the DI-typing miss (a
   * repository prop the DI reader could not type) and `em.flush()` (a real operation with no
   * entity of its own) are IN scope and unbound — the rate never flatters the extractor (LIM-4).
   *
   * Bound is read back from the EMITTED ops by their minted id, never from a loop counter, so two
   * sites that mint one id count once. Raw-query sites are never out of scope: the profile
   * declared that call as a db surface, and TS has no repo-wide table registry to test an
   * unreadable table token against — an unresolved table there is in scope and unbound.
   */
  private readonly dbOpBoundById = new Map<string, boolean>();
  /**
   * Enumerated db-op SITES, keyed `callerId|file:line|expression` exactly as the call lane keys
   * its own (`callSiteKey`). A site two rules claim — two `rawQueries` matchers naming the same
   * method, or a raw matcher and the opMap — is one site, not two: counting it twice inflated
   * the denominator and deflated the rate (followups G-2).
   */
  private readonly dbOpSiteKeys = new Set<string>();
  private dbOpOutOfScope = 0;
  private readonly externals: ExternalCallEdge[] = [];
  /** Handler nodes synthesized by custom rules for inline/anonymous handlers. */
  private readonly synthesizedFunctions: FunctionNode[] = [];
  /**
   * Synthesized handlers whose span IS the inline handler site — the arrow/function
   * expression passed to the registration call. These own their span: they get its
   * source slice and the call/db/external facts recorded inside it. Identifier STUBS
   * (a named handler reference that didn't resolve in-file) are excluded — their body
   * lives elsewhere, so claiming the registration span would misattribute.
   */
  private readonly inlineHandlerIds = new Set<string>();
  /**
   * Entrypoints emitted with an `unresolved:` dimension, keyed `<ruleLabel>|<dimension>|<file>`
   * so the repo carries ONE warning per rule per file (see UnresolvedDimension).
   */
  private readonly unresolved = new Map<string, UnresolvedDimension>();
  private readonly entityNames = new Set<string>();
  private readonly entityIdByName = new Map<string, string>();
  /**
   * Non-substrate source files a rule attributed nodes to — a schema DSL (`schema.prisma`)
   * the substrate never parses, but whose models become entities with `fileId` pointing at
   * it. Each gets a file node so those ids resolve (see emitAttributedSourceFiles).
   */
  private readonly attributedSourceFiles = new Set<string>();
  private readonly components: ComponentNode[] = [];
  private readonly routes: RouteNode[] = [];
  private readonly stateStores: StateStoreNode[] = [];
  /** Ids of every emitted component — route componentIds must be in this set. */
  private validComponentIds = new Set<string>();
  /** SCIP-vs-fallback resolution telemetry for the FRONTEND.md report. */
  readonly frontendStats = {
    childUsages: 0,
    resolvedBySCIP: 0,
    /** Vue template tags resolved through the script block's imports (SCIP has no `.vue`). */
    resolvedByVueImport: 0,
    /** JSX child tags resolved through the import+tsconfig path (barrel/default-import cases). */
    resolvedByJsxImport: 0,
    trueDangling: 0,
    nullId: 0,
    routeComponentResolved: 0,
  };

  constructor(
    private readonly profile: ExtractionProfile,
    private readonly substrate: Substrate,
  ) {}

  /** Run the profile over the substrate and assemble a ParsedRepo. */
  run(baseline: BaselineResult, opts: { repoRoot: string; repoName: string; repoKey?: string }): ParsedRepo {
    this.extractEntities(opts.repoRoot);
    const packagePathById = new Map([...baseline.graph.packages.values()].map((pkg) => [pkg.id, pkg.path]));
    const packagePathByFile = new Map(
      [...baseline.graph.files.values()].map((file) => [file.path, packagePathById.get(file.packageId) ?? '.']),
    );
    this.extractEntrypoints(packagePathByFile);
    this.extractHandlerTableEntrypoints();
    this.extractDbOperations();
    this.extractExternalCalls();
    if (this.profile.components) this.extractComponents(this.profile.components);
    if (this.profile.routes) this.extractRoutes(this.profile.routes);
    for (const sr of this.profile.stateStores ?? []) this.extractStateStores(sr);
    // Facts-only escape hatch: runs AFTER the built-in passes (facts are populated)
    // and BEFORE assemble (emitted nodes flow into the graph below). See customRules.
    this.runCustomRules(opts.repoRoot);
    // All synthesis is done — give every inline handler its span's real source (and a
    // content-derived versionedId) before the nodes enter the graph.
    this.hydrateInlineHandlers(opts.repoRoot);

    const g = baseline.graph;
    // SDK-source export tagging: stamp each in-repo exported method with its own SCIP
    // package moniker (when the repo IS an SDK source, scip definitions carry a package
    // moniker; for app repos this is a harmless no-op). Must run BEFORE scopeGraph so the
    // surviving in-scope nodes carry the join identity the symbol hop consumes.
    if (baseline.scip) tagExportedMonikers(baseline.scip, g);
    // Prune out-of-scope structural nodes so counts match the golden scope.
    this.scopeGraph(g);
    // Add custom-rule-synthesized handler nodes after pruning (they're in scope by
    // construction) so an entrypoint's handlerId resolves to a real function node.
    for (const fn of this.synthesizedFunctions) g.addFunction(fn);
    // Same reason, for files: a schema DSL a rule attributed entities to is not in the
    // substrate, so scopeGraph would have dropped it — emit it after pruning.
    this.emitAttributedSourceFiles(g, opts.repoRoot);

    // The substrate attributes every fact to its nearest NAMED scope, so facts inside an
    // inline handler land on the surrounding registrar function — leaving the synthesized
    // handler node with zero outgoing edges. Re-parent calls/db-ops/externals located
    // inside an inline handler's span onto that handler (see inlineHandlerOwning).
    const callerSpans = new Map<string, SubstrateLoc>();
    for (const fn of g.functions.values()) callerSpans.set(fn.id, fn.location);
    for (const op of this.dbOps) {
      const h = this.inlineHandlerOwning(op.performerId, op.location, callerSpans);
      if (h) op.performerId = h.id;
    }
    for (const ext of this.externals) {
      const h = this.inlineHandlerOwning(ext.callerId, ext.location, callerSpans);
      if (h) ext.callerId = h.id;
    }

    for (const ep of this.entrypoints) g.addEntrypoint(ep);
    for (const en of this.entities) g.addEntity(en);
    for (const op of this.dbOps) g.addDbOperation(op);
    for (const ext of this.externals) g.addExternalCall(ext);

    // Replace the graph's SCIP/structural call edges with the scoped + DI-corrected set.
    // Unresolved edges into language/runtime/framework built-ins (`arr.map`,
    // `console.log`, `useState`, …) carry no internal call-graph target, so drop
    // them as noise. Resolved edges (`calleeId` set) are always kept — a built-in
    // name that SCIP bound to an in-repo node is a real edge, not noise.
    const idGen = this.substrate.idGen;
    const corrected = this.substrate.internalCalls();
    g.calls.clear();
    // Site key (from the ORIGINAL caller) → the ids its resolved facts were emitted under, so
    // callResolutionOf can read resolution back from the emitted set despite re-parenting.
    const emittedIdsBySite = new Map<string, string[]>();
    for (const e of corrected) {
      if (!e.calleeId && isLanguageBuiltinCall(e.calleeExpression)) continue;
      const h = this.inlineHandlerOwning(e.callerId, e.location, callerSpans);
      const callerId = h ? h.id : e.callerId;
      // Re-parented edges re-mint the id from the new caller (same derivation as
      // structuralToNodes) so the id stays a pure function of the edge's content.
      const id = h
        ? idGen.callEdgeId(callerId, e.calleeExpression, `${e.location.filePath}:${e.location.startLine}`)
        : e.id;
      if (e.calleeId) {
        const key = callSiteKey(e.callerId, e.location, e.calleeExpression);
        const ids = emittedIdsBySite.get(key);
        if (ids) ids.push(id);
        else emittedIdsBySite.set(key, [id]);
      }
      g.addCall({
        id,
        callerId,
        calleeId: e.calleeId,
        provenance: e.provenance,
        calleeExpression: e.calleeExpression,
        isMethodCall: e.isMethodCall,
        location: e.location,
        arguments: e.arguments,
      });
    }

    const result = assemble(g, opts, [...baseline.errors, ...this.unresolvedWarnings()], 0, baseline.plan);
    result.stats.callResolution = callResolutionOf(corrected, g, emittedIdsBySite);
    // Absent = not measured: a profile with no `dbOperations` block ran no db-op lane at all.
    if (this.profile.dbOperations)
      result.stats.dbOpResolution = {
        dbOpSites: this.dbOpSiteKeys.size,
        boundDbOps: [...this.dbOpBoundById.values()].filter(Boolean).length,
        outOfScopeDbOps: this.dbOpOutOfScope,
      };
    if (this.components.length) result.components = this.components;
    if (this.routes.length) result.routes = this.routes;
    if (this.stateStores.length) result.stateStores = this.stateStores;
    // Declarative repo classification: stamp the profile-author-supplied type (omitted ⇒ unset).
    if (this.profile.repoType) result.type = this.profile.repoType;
    return result;
  }

  // ── frontend: components + JSX render edges (SCIP componentId resolution) ─────

  private extractComponents(rule: ComponentRule): void {
    const sites = this.substrate.componentSites({
      functionalInExtensions: rule.functionalInExtensions,
      classComponents: rule.classComponents,
    });
    if (rule.vueSfc) {
      if (!isVueSubstrate(this.substrate)) {
        throw new Error('components.vueSfc requires a Vue-capable substrate (tree-sitter TS/JS)');
      }
      sites.push(...this.substrate.vueComponentSites());
    }
    // Phase 1: id of every component so child resolution can validate (no fabrication).
    const validIds = new Set(sites.map((s) => this.substrate.idGen.componentId(s.file, s.name)));
    this.validComponentIds = validIds;

    for (const s of sites) {
      const id = this.substrate.idGen.componentId(s.file, s.name);
      const children = this.resolveChildTags(s, rule, validIds);
      this.components.push({
        id,
        versionedId: this.substrate.idGen.versionedComponentId(s.file, s.name, `${s.name}@${s.loc.startLine}`),
        name: s.name,
        location: s.loc,
        kind: 'component',
        fileId: this.substrate.idGen.fileId(s.file),
        // A `.vue` file is a Vue component whatever the rule's framework says: one rule may
        // cover both surfaces (a React repo with a Vue periphery), so the file decides.
        framework: s.file.endsWith('.vue') ? 'vue' : rule.framework,
        componentType: s.componentType,
        childComponents: children,
      });
    }
  }

  private resolveChildTags(s: ComponentSite, rule: ComponentRule, validIds: Set<string>): ComponentUsage[] {
    const primitives = new Set(rule.frameworkPrimitives ?? []);
    const dedup = rule.childDedup ?? 'per-tag-line';
    const usages: ComponentUsage[] = [];
    const seen = new Set<string>();
    for (const tag of s.childTags) {
      if (primitives.has(tag.name)) continue;
      this.frontendStats.childUsages++;
      // SCIP resolution: the tag's reference occurrence → its definition. The
      // validator lets the substrate skip occurrences that don't name a real
      // component (default-export renames / barrels expose several symbols on a
      // line) — keeping precision at 0 fabricated ids.
      const isValid = (filePath: string, declaredName: string): boolean =>
        validIds.has(this.substrate.idGen.componentId(filePath, declaredName));
      // A Vue template tag has no SCIP occurrence (`.vue` is never indexed) — resolve it
      // through the script block's imports instead.
      const vueSub = s.file.endsWith('.vue') && isVueSubstrate(this.substrate) ? this.substrate : undefined;
      const resolved = vueSub
        ? vueSub.resolveVueTagByImport(s.file, tag.name, rule.imports)
        : this.substrate.resolveJsxTagBySCIP(s.file, tag.name, tag.line, isValid);
      let componentId: string | undefined;
      if (resolved) {
        const cand = this.substrate.idGen.componentId(resolved.filePath, resolved.declaredName);
        if (validIds.has(cand)) {
          componentId = cand;
          if (vueSub) this.frontendStats.resolvedByVueImport++;
          else this.frontendStats.resolvedBySCIP++;
        }
      }
      // Import+tsconfig fallback (incl. the barrel/re-export hop) — the same second tier the
      // ROUTE lane has always had. A child tag imported from a package barrel is a
      // document-`local` symbol to SCIP, so without this tier every shadcn-idiom child
      // reference stays a name-only stub. Same validator, so still 0 fabricated ids.
      if (!componentId && !vueSub) {
        const byImport = this.substrate.resolveJsxTagByImport(s.file, tag.name, rule.imports);
        const cand = byImport ? this.substrate.idGen.componentId(byImport.filePath, byImport.declaredName) : undefined;
        if (cand && validIds.has(cand)) {
          componentId = cand;
          this.frontendStats.resolvedByJsxImport++;
        }
      }
      if (componentId == null) this.frontendStats.nullId++;
      const key = dedup === 'per-tag-line' ? `${tag.name}:${tag.line}` : (componentId ?? `name:${tag.name}`);
      if (seen.has(key)) continue;
      seen.add(key);
      usages.push({
        ...(componentId ? { componentId } : {}),
        componentName: tag.name,
        location: { filePath: s.file, startLine: tag.line, endLine: tag.line },
      });
    }
    return usages;
  }

  /**
   * Emit a file node for every non-substrate source file a rule attributed nodes to (a
   * `schema.prisma` today). Without it those nodes carry a `fileId` that resolves to
   * nothing: 44 dangling `entities.fileId` refs on this repo's own parse.
   *
   * Same id convention as any other file (`idGen.fileId(relPath)`), so no consumer needs a
   * special case; `language` is the schema dialect (extension-derived) rather than a
   * programming language, which is what marks it as a schema source. It owns no functions
   * or classes — nothing parses it structurally. Runs AFTER scopeGraph so the package it is
   * attributed to is one that survived pruning (`.` always does).
   */
  private emitAttributedSourceFiles(g: BaselineResult['graph'], repoRoot: string): void {
    const idGen = this.substrate.idGen;
    for (const rel of this.attributedSourceFiles) {
      if (g.files.has(idGen.fileId(rel))) continue;
      let source: string;
      try {
        source = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // unreadable now though it parsed above — never fabricate a node for it
      }
      const contentHash = idGen.contentHash(source);
      const extension = rel.slice(rel.lastIndexOf('.'));
      g.addFile({
        id: idGen.fileId(rel),
        versionedId: idGen.versionedFileId(rel, contentHash),
        path: rel,
        extension,
        packageId: this.owningPackageId(g, rel),
        language: extension.replace(/^\./, ''),
        contentHash,
      });
    }
  }

  /** Id of the surviving package whose path is the file's longest prefix (root `.` is the fallback). */
  private owningPackageId(g: BaselineResult['graph'], rel: string): string {
    let best = '';
    let bestId = '';
    for (const pkg of g.packages.values()) {
      if (pkg.path !== '.' && !rel.startsWith(`${pkg.path}/`)) continue;
      const len = pkg.path === '.' ? 0 : pkg.path.length;
      if (bestId && len <= best.length) continue;
      best = pkg.path === '.' ? '' : pkg.path;
      bestId = pkg.id;
    }
    return bestId || this.substrate.idGen.packageId('.');
  }

  /** Drop functions/classes/files outside the profile scope. */
  private scopeGraph(g: BaselineResult['graph']): void {
    const scopedPaths = new Set(this.substrate.files().map((f) => f.relativePath));
    for (const [id, fn] of [...g.functions]) if (!scopedPaths.has(fn.location.filePath)) g.functions.delete(id);
    for (const [id, c] of [...g.classes]) if (!scopedPaths.has(c.location.filePath)) g.classes.delete(id);
    for (const [id, i] of [...g.interfaces]) if (!scopedPaths.has(i.location.filePath)) g.interfaces.delete(id);
    for (const [id, t] of [...g.typeAliases]) if (!scopedPaths.has(t.location.filePath)) g.typeAliases.delete(id);
    for (const [id, e] of [...g.enums]) if (!scopedPaths.has(e.location.filePath)) g.enums.delete(id);
    for (const [id, v] of [...g.variables]) if (!scopedPaths.has(v.location.filePath)) g.variables.delete(id);
    for (const [id, f] of [...g.files]) if (!scopedPaths.has(f.path)) g.files.delete(id);
    for (const [id, imp] of [...g.imports]) {
      const fileId = imp.sourceFileId;
      if (!g.files.has(fileId)) g.imports.delete(id);
    }
    // Package enumeration walks every package.json in the repo, which is a wider set than
    // the parsed surface: vendored grammars and test fixtures ship manifests but are
    // excluded from the substrate. Once their files are gone, an empty Package node is
    // noise in every downstream view, so drop it. The root stays — it is the documented
    // fallback owner for files outside any nested package.
    const owningPackageIds = new Set([...g.files.values()].map((f) => f.packageId));
    for (const [id, pkg] of [...g.packages]) {
      if (pkg.path !== '.' && !owningPackageIds.has(id)) g.packages.delete(id);
    }
    // Externals come fresh from the engine; clear any SCIP-superset residue.
    g.externalCalls.clear();
  }

  // ── frontend: routes (React-Router) ──────────────────────────────────────────

  /**
   * Emit a RouteNode per `<Route>`/config-array route, resolving its componentId
   * via the SCIP JSX-tag resolver validated against emitted component ids (0
   * dangling — only set componentId when it matches a real component, mirroring
   * the ts-morph engine's validComponentIds discipline).
   *
   * Table-driven routes (`recordTable`) arrive already resolved — the reader owns
   * the two hops (scene key → dynamic-import module → default export) — and are
   * validated against the same id set, never re-resolved.
   */
  private extractRoutes(rule: RouteRule): void {
    const idGen = this.substrate.idGen;
    const imports = this.profile.components?.imports;
    const isValid = (filePath: string, declaredName: string): boolean =>
      this.validComponentIds.has(idGen.componentId(filePath, declaredName));
    const validIdFor = (r: { filePath: string; declaredName: string } | undefined): string | undefined => {
      if (!r) return undefined;
      const cand = idGen.componentId(r.filePath, r.declaredName);
      return this.validComponentIds.has(cand) ? cand : undefined;
    };

    for (const site of this.substrate.routeSites(rule, imports)) {
      let componentId: string | undefined;
      let isLazy = site.isLazy ?? false;
      if (site.resolution) {
        // The reader already followed the reference (recordTable two-hop). Its answer
        // is the whole answer — re-resolving at a table-entry line could only fabricate.
        componentId = validIdFor(site.resolution.resolved);
      } else {
        // SCIP first (cross-file moniker); import+tsconfig fallback for the default-import /
        // barrel cases SCIP records as document-`local` symbols (ts-morph's resolution path).
        componentId = validIdFor(
          this.substrate.resolveJsxTagBySCIP(site.file, site.componentName, site.componentLine, isValid),
        );
        if (!componentId && imports) {
          componentId = validIdFor(this.substrate.resolveJsxTagByImport(site.file, site.componentName, imports));
        }
        // Lazy binding in the router file itself (`const X = lazy(() => import('./x.js'))`):
        // a document-`local` symbol with no import statement, so neither path above can
        // reach it. Resolving it here is what keeps code-split routes from being the only
        // ones with a null componentId.
        if (!componentId) {
          const lazyBinding = this.substrate.resolveLazyComponentBinding(site.file, site.componentName, isValid);
          if (lazyBinding) {
            isLazy = true;
            componentId = validIdFor(lazyBinding.resolved);
          }
        }
      }
      if (componentId) this.frontendStats.routeComponentResolved++;
      // The declaring file is part of the identity: the same path+component
      // pair legitimately appears in more than one router file, and hashing
      // only the pair collided their ids (duplicate graph nodes downstream).
      // MIGRATION NOTE (2026-08-12): adding the file changes every route id on
      // the next parse — the graph diff replaces route nodes wholesale once,
      // and route summaries regenerate on the next summarize.
      const id = idGen.routeId(`${site.file}:${site.path}:${site.componentName}`);
      this.routes.push({
        id,
        path: site.path,
        componentName: site.componentName,
        ...(componentId ? { componentId } : {}),
        isLazy,
        location: { filePath: site.file, startLine: site.componentLine, endLine: site.componentLine },
      });
    }

    for (const fc of rule.fileConvention ?? []) this.extractFileConventionPages(fc);
  }

  /**
   * Emit a RouteNode per file-convention page file (Next.js pages/app router). The route
   * path is the file's own path under `routeDir` — no declaration site exists, so the
   * page's `export default` names the component. componentId is set only when that name
   * resolves to an emitted component (the validComponentIds discipline); a page whose
   * default export is not a detected component still gets a route, name-only.
   */
  private extractFileConventionPages(rule: FileConventionRouteRule): void {
    const idGen = this.substrate.idGen;
    const prefix = `${rule.routeDir.replace(/\/+$/, '')}/`;
    for (const { relativePath: file } of this.substrate.files()) {
      if (!file.startsWith(prefix)) continue;
      const rel = file.slice(prefix.length);
      const segments = rel.split('/');
      let path: string;
      if (rule.framework === 'next-pages') {
        if (!isPagesRouteFile(rel)) continue;
        path = derivePagesRoutePath(rel);
      } else {
        if (!NEXT_APP_PAGE_FILES.has(segments[segments.length - 1])) continue;
        path = nextSegmentsToRoutePath(segments.slice(0, -1));
      }
      const declaredName = this.substrate.defaultExportedName(file);
      const componentName = declaredName ?? (segments[segments.length - 1].replace(/\.[^./]+$/, '') || rel);
      let componentId: string | undefined;
      if (declaredName) {
        const cand = idGen.componentId(file, declaredName);
        if (this.validComponentIds.has(cand)) componentId = cand;
      }
      if (componentId) this.frontendStats.routeComponentResolved++;
      const id = idGen.routeId(`${file}:${path}:${componentName}`);
      this.routes.push({
        id,
        path,
        componentName,
        ...(componentId ? { componentId } : {}),
        isLazy: false,
        location: { filePath: file, startLine: 1, endLine: 1 },
      });
    }
  }

  // ── frontend: state stores (zustand) ─────────────────────────────────────────

  private extractStateStores(rule: StateStoreRule): void {
    const idGen = this.substrate.idGen;
    for (const site of this.substrate.stateStoreSites(rule)) {
      const id = idGen.stateStoreId(site.file, site.storeName);
      this.stateStores.push({
        id,
        versionedId: idGen.versionedId(id, `${site.storeName}:${site.loc.startLine}`),
        name: site.storeName,
        location: site.loc,
        kind: 'state-store',
        fileId: idGen.fileId(site.file),
        library: rule.library,
        storeName: site.storeName,
        actions: site.actions.map((a) => ({ name: a.name, location: a.loc })),
        selectors: site.selectors.map((s) => ({ name: s.name, location: s.loc })),
      });
    }
  }

  // ── entities ───────────────────────────────────────────────────────────────

  private extractEntities(repoRoot: string): void {
    const rules = this.profile.entities ?? [];
    // Prisma models live in a schema.prisma DSL file; parse once, then register + emit.
    const prisma: { rule: PrismaSchemaEntityRule; models: PrismaModel[] }[] = [];
    for (const rule of rules) {
      if ('schemaPath' in rule) {
        const models = loadPrismaModels(repoRoot, rule.schemaPath);
        prisma.push({ rule, models });
        // The schema file is outside the substrate (it is not TS/JS), yet every model's
        // fileId names it — so it needs a file node of its own. Recorded only when the
        // schema actually parsed, so a mistyped schemaPath still fails loudly (no models,
        // no phantom file node).
        if (models.length > 0) this.attributedSourceFiles.add(rule.schemaPath);
        for (const m of models) {
          this.registerEntity(rule.schemaPath, m.name);
          // Prisma client accessors are camelCase (prisma.workspaceMember) while the
          // models are PascalCase — alias the lower-first form to the same id so the
          // `this.prisma.<model>.<op>()` dbOps link to their entity node.
          const lc = m.name.charAt(0).toLowerCase() + m.name.slice(1);
          const id = this.entityIdByName.get(m.name);
          if (id && lc !== m.name && !this.entityIdByName.has(lc)) this.entityIdByName.set(lc, id);
        }
      }
    }
    // First pass: collect convention entity names + ids so relation targets resolve.
    for (const rule of rules) {
      if ('schemaPath' in rule) continue;
      if (rule.detect.via === 'class-decorator') {
        for (const c of this.substrate.classes()) {
          if (this.hasDecorator(c, rule.detect.name)) this.registerEntity(c.loc.filePath, c.name);
        }
      } else if (rule.detect.via === 'call-shape') {
        for (const site of this.substrate.callShapes(rule.detect.callee)) {
          const name = this.entityNameFromCall(site, rule);
          if (name) this.registerEntity(site.file, name);
        }
      }
    }

    // Second pass: emit (all names registered, so relations resolve).
    for (const { rule, models } of prisma) this.emitPrismaEntities(rule, models);
    for (const rule of rules) {
      if ('schemaPath' in rule) continue;
      if (rule.detect.via === 'class-decorator') this.extractDecoratorEntities(rule);
      else if (rule.detect.via === 'call-shape') this.extractFactoryEntities(rule);
    }
  }

  private emitPrismaEntities(rule: PrismaSchemaEntityRule, models: PrismaModel[]): void {
    const idGen = this.substrate.idGen;
    for (const model of models) {
      const entityId = idGen.entityId(rule.schemaPath, model.name);
      this.entities.push({
        id: entityId,
        // Seed the version hash with column/relation content (not just the
        // declaration line) so a field-type/flag change with no line shift still
        // flips the checksum and the incremental cloud diff schedules an update.
        versionedId: idGen.versionedId(
          entityId,
          entityVersionSeed(`${model.name}:${model.line}`, model.fields, model.relations),
        ),
        name: model.name,
        kind: 'entity',
        fileId: idGen.fileId(rule.schemaPath),
        ormType: 'prisma',
        tableName: model.tableName,
        fields: model.fields,
        relations: model.relations.map((r) => ({ ...r, targetEntityId: this.entityIdByName.get(r.targetEntityName) })),
        location: { filePath: rule.schemaPath, startLine: model.line, endLine: model.line },
      });
    }
  }

  private registerEntity(filePath: string, name: string): void {
    this.entityNames.add(name);
    if (!this.entityIdByName.has(name)) this.entityIdByName.set(name, this.substrate.idGen.entityId(filePath, name));
  }

  private extractDecoratorEntities(rule: ConventionEntityRule): void {
    if (rule.detect.via !== 'class-decorator') return;
    const idGen = this.substrate.idGen;
    const fieldDecs = new Set(rule.fields.decorators ?? []);
    const relDecs = rule.relations.decorators ?? {};

    for (const c of this.substrate.classes()) {
      const entityDec = this.findDecorator(c, rule.detect.name);
      if (!entityDec) continue;
      const tableName = this.resolveTableName(c.name, rule, entityDec);
      const fields: EntityField[] = [];
      const relations: EntityRelation[] = [];

      for (const p of c.properties) {
        const relDec = p.decorators.find((d) => relDecs[decoName(d)] !== undefined);
        if (relDec) {
          relations.push(this.buildDecoratorRelation(p.name, relDec, relDecs, rule));
          continue;
        }
        const fieldDec = p.decorators.find((d) => fieldDecs.has(decoName(d)));
        if (fieldDec) fields.push(this.buildDecoratorField(p.name, p.type, fieldDec, p.decorators, rule));
      }

      const entityId = idGen.entityId(c.loc.filePath, c.name);
      this.entities.push({
        id: entityId,
        // Include column/relation content in the version seed: a decorator flag
        // edit (e.g. nullable false→true) can leave the line span unchanged, and
        // the incremental cloud diff updates nodes only when versionedId differs.
        versionedId: idGen.versionedId(
          entityId,
          entityVersionSeed(`${c.name}:${c.loc.startLine}-${c.loc.endLine}`, fields, relations),
        ),
        name: c.name,
        kind: 'entity',
        fileId: idGen.fileId(c.loc.filePath),
        ormType: rule.orm,
        tableName,
        fields,
        relations: relations.map((r) => ({ ...r, targetEntityId: this.entityIdByName.get(r.targetEntityName) })),
        location: c.loc,
      });
    }
  }

  private buildDecoratorField(
    propName: string,
    propType: string | undefined,
    fieldDec: string,
    allDecorators: string[],
    rule: ConventionEntityRule,
  ): EntityField {
    const pkName = rule.fields.pk;
    const isPk =
      pkName !== undefined && (decoName(fieldDec) === pkName || allDecorators.some((d) => decoName(d) === pkName));
    const columnName =
      (rule.fields.columnNameOption ? optionString(fieldDec, rule.fields.columnNameOption) : undefined) ??
      snakeCase(propName);
    const flags = rule.fields.flags ?? {};
    const nullable = flags.nullable ? new RegExp(flags.nullable).test(fieldDec) : false;
    const unique = flags.unique ? new RegExp(flags.unique).test(fieldDec) : false;
    const generated = isPk || (flags.generated ? new RegExp(flags.generated).test(fieldDec) : false);
    const defaultMatch = /\bdefault:\s*([^,}]+)/.exec(fieldDec);
    // Recover the DB type from the decorator's type/columnType option when the TS
    // annotation is missing or `unknown` (so `@Property({ type: 'int' })
    // retryNumber = 0` reports `int`, not `unknown`).
    const { dbType, typeText } = resolveDecoratorFieldType(
      fieldDec,
      propType,
      rule.fields.typeOption ?? ['type', 'columnType'],
      rule.fields.dataTypeMap,
    );
    return {
      name: propName,
      columnName,
      type: { text: typeText },
      dbType,
      isPrimaryKey: isPk,
      isNullable: nullable,
      isUnique: unique,
      isGenerated: generated,
      defaultValue: defaultMatch ? defaultMatch[1].trim() : undefined,
    };
  }

  private buildDecoratorRelation(
    propName: string,
    relDec: string,
    relDecorators: Record<string, string>,
    rule: ConventionEntityRule,
  ): EntityRelation {
    const relType = relDecorators[decoName(relDec)] as EntityRelation['type'];
    let target: string | undefined;
    if (rule.relations.target.as === 'arrow-target') target = arrowTarget(relDec);
    target = target ?? singularize(propName);
    const joinColumn = optionString(relDec, 'fieldName') ?? optionString(relDec, 'joinColumn');
    return { name: propName, type: relType, targetEntityName: target, joinColumn };
  }

  private extractFactoryEntities(rule: ConventionEntityRule): void {
    if (rule.detect.via !== 'call-shape') return;
    const idGen = this.substrate.idGen;
    const sites = this.substrate.callShapes(rule.detect.callee);
    // associations: Model.<assoc>(Target) grouped by receiver, per file.
    const assoc = rule.relations.assocMethods ?? {};
    const relationsByModel = new Map<string, EntityRelation[]>();
    for (const site of this.substrate.callShapes()) {
      if (!site.receiver || !site.method) continue;
      const relType = assoc[site.method] as EntityRelation['type'] | undefined;
      if (!relType) continue;
      const target = this.readArgIdentifier(site.args[rule.relations.target.arg]);
      if (!target) continue;
      const list = relationsByModel.get(site.receiver) ?? [];
      list.push({ name: target, type: relType, targetEntityName: target });
      relationsByModel.set(site.receiver, list);
    }

    for (const site of sites) {
      const name = this.entityNameFromCall(site, rule);
      if (!name) continue;
      const fieldsArgIdx = rule.fields.factoryFieldsArg ?? 1;
      const fieldsArg = site.args[fieldsArgIdx];
      const fields = fieldsArg?.objectEntries ? this.readFactoryFields(fieldsArg, rule) : [];
      const optsArg = site.args[fieldsArgIdx + 1];
      const tableName =
        (rule.tableName?.option ? objectEntryString(optsArg, rule.tableName.option) : undefined) ??
        (rule.tableName?.fallback === 'verbatim' ? name : snakeCase(name));
      const relations = (relationsByModel.get(name) ?? []).map((r) => ({
        ...r,
        targetEntityId: this.entityIdByName.get(r.targetEntityName),
      }));
      const entityId = idGen.entityId(site.file, name);
      this.entities.push({
        id: entityId,
        // Fold column/relation content into the version seed so factory-defined
        // field changes that don't move the call's line are still detected by the
        // incremental cloud diff (which compares versionedId only).
        versionedId: idGen.versionedId(
          entityId,
          entityVersionSeed(`${name}:${site.loc.startLine - 1}`, fields, relations),
        ),
        name,
        kind: 'entity',
        fileId: idGen.fileId(site.file),
        ormType: rule.orm,
        tableName,
        fields,
        relations,
        location: site.loc,
      });
    }
  }

  private entityNameFromCall(site: CallSite, rule: ConventionEntityRule): string | undefined {
    if (!rule.name) return undefined;
    const arg = site.args[rule.name.arg];
    if (!arg) return undefined;
    if (rule.name.as === 'const-string') {
      if (arg.stringLiteral !== undefined) return arg.stringLiteral;
      if (arg.identifier) return this.substrate.resolveConst(arg.identifier, site.file);
      return undefined;
    }
    return arg.stringLiteral;
  }

  private readFactoryFields(arg: ArgNode, rule: ConventionEntityRule): EntityField[] {
    const out: EntityField[] = [];
    const dataTypeMap = rule.fields.dataTypeMap ?? {};
    for (const e of arg.objectEntries ?? []) {
      const body = e.valueObject;
      let dbType = 'unknown';
      let isPk = false;
      let nullable = true;
      let unique = false;
      let generated = false;
      if (body) {
        const typeEntry = body.find((b) => b.key === 'type');
        const m = typeEntry ? /DataTypes\.([A-Z0-9_]+)/.exec(typeEntry.valueText) : null;
        const token = m ? m[1] : (typeEntry?.valueText.trim() ?? 'unknown');
        dbType = dataTypeMap[token] ?? token;
        isPk = boolEntry(body, 'primaryKey');
        generated = boolEntry(body, 'autoIncrement');
        unique = boolEntry(body, 'unique');
        const allowNull = boolEntryOpt(body, 'allowNull');
        nullable = allowNull === undefined ? !isPk : allowNull;
      } else {
        const m = /DataTypes\.([A-Z0-9_]+)/.exec(e.valueText);
        dbType = m ? (dataTypeMap[m[1]] ?? m[1]) : e.valueText.trim();
      }
      out.push({
        name: e.key,
        columnName: e.key,
        type: { text: dbType },
        dbType,
        isPrimaryKey: isPk,
        isNullable: nullable,
        isUnique: unique,
        isGenerated: isPk || generated,
      });
    }
    return out;
  }

  // ── entrypoints ──────────────────────────────────────────────────────────────

  private extractEntrypoints(packagePathByFile: ReadonlyMap<string, string>): void {
    for (const rule of this.profile.entrypoints ?? []) {
      if (!('detect' in rule)) {
        // File-convention HTTP routes (Next.js app/pages router): no class/decorator detector.
        if ('via' in rule && rule.via === 'file-convention') {
          if (rule.framework === 'next-pages-api') this.extractPagesApiEntrypoints(rule, packagePathByFile);
          else this.extractFileConventionRoutes(rule, packagePathByFile);
        }
        continue;
      }
      if (rule.kind === 'http') {
        if (rule.detect.via === 'class-decorator') this.extractDecoratorRoutes(rule);
        else if (rule.detect.via === 'method-decorator') this.extractMethodDecoratorEntrypoints(rule);
        else if (rule.detect.via === 'call-shape') this.extractCallShapeRoutes(rule);
      } else if (rule.kind === 'queue') {
        if (rule.detect.via === 'method-decorator') this.extractMethodDecoratorEntrypoints(rule);
        else if (rule.detect.via === 'call-shape') this.extractCallShapeQueues(rule);
      } else if (rule.kind === 'cli') {
        if (rule.detect.via === 'call-shape') this.extractCliEntrypoints(rule);
      } else if (rule.kind === 'grpc') {
        if (rule.detect.via === 'method-decorator') this.extractGrpcEntrypoints(rule);
      } else if (rule.kind === 'graphql') {
        if (rule.detect.via === 'class-decorator') this.extractGraphqlEntrypoints(rule);
      }
    }
  }

  /**
   * Next.js App Router file-convention HTTP endpoints: a `route.ts(x)` under `routeRoot`
   * exporting an HTTP-verb function (`GET`/`POST`/…) is an endpoint; its path is the
   * directory chain under `routeRoot` (route-groups `(grp)` + slots `@x` stripped,
   * `[id]`→`{id}`, `[...slug]`→`{slug}`). Mirrors the ts-morph engine's
   * extractFileConventionRoutes, reading exported functions from the substrate.
   */
  private extractFileConventionRoutes(
    rule: NextAppRouterHttpRule,
    packagePathByFile: ReadonlyMap<string, string>,
  ): void {
    const idGen = this.substrate.idGen;
    const routeFiles = new Set(rule.routeFiles ?? ['route.ts', 'route.tsx']);
    // Index exported HTTP-verb functions per route-file path.
    const byFile = new Map<string, { name: string; loc: { filePath: string; startLine: number; endLine: number } }[]>();
    for (const fn of this.substrate.functions()) {
      const base = fn.loc.filePath.split('/').pop() ?? '';
      if (!routeFiles.has(base) || !fn.isExported || !HTTP_VERBS.has(fn.name)) continue;
      const list = byFile.get(fn.loc.filePath) ?? [];
      list.push({ name: fn.name, loc: fn.loc });
      byFile.set(fn.loc.filePath, list);
    }
    for (const [filePath, fns] of byFile) {
      const packagePath = packagePathByFile.get(filePath) ?? '.';
      if (packageLocalRouteRootIndex(filePath, rule.routeRoot, packagePath) === -1) continue;
      const routePath = deriveNextRoutePath(filePath, rule.routeRoot, packagePath);
      for (const fn of fns) {
        const method = fn.name as HttpMethod;
        const handlerId = idGen.functionId(filePath, fn.name);
        const pathParams = extractParams(routePath, 'brace');
        const id = idGen.httpEntrypointId(method, routePath, filePath);
        this.entrypoints.push({
          id,
          versionedId: idGen.versionedId(id, `${fn.name}:${fn.loc.startLine}`),
          type: 'http',
          handlerId,
          location: fn.loc,
          details: {
            type: 'http',
            method,
            path: routePath,
            fullPath: routePath,
            ...(pathParams.length ? { pathParams } : {}),
          },
        });
      }
    }
  }

  /**
   * Next.js PAGES Router API endpoints: every module under `<routeRoot>/api/**` is an
   * endpoint (no marker base name — `[ref].ts` and `index.ts` count; `_`-prefixed
   * framework internals do not), and the path is the file's own path under `routeRoot`
   * (`pages/api/projects/[ref]/settings.ts` → `/api/projects/{ref}/settings`).
   *
   * ONE entrypoint per file, method `ALL`: a pages handler is a single default export
   * switching on `req.method`, so the served verbs are not statically declared and a
   * per-verb fan-out would fabricate endpoints. Narrowing the set would need the guard
   * (`if (req.method !== 'POST') return 405`) or an allowlist const read off the CST —
   * the substrate exposes neither source text nor a file CST to the engine, so it is
   * deliberately not attempted here rather than approximated.
   *
   * Handler: the file's `export default`, HOC-peeled by the substrate. When that name
   * is a function declared in the file, its real id; otherwise the documented synthetic
   * handler id (`"<METHOD> <path>"`, the integrity-validator exception shape).
   */
  private extractPagesApiEntrypoints(rule: NextPagesApiHttpRule, packagePathByFile: ReadonlyMap<string, string>): void {
    const idGen = this.substrate.idGen;
    const fnsByFile = new Map<string, SubstrateFunction[]>();
    for (const fn of this.substrate.functions()) {
      const list = fnsByFile.get(fn.loc.filePath);
      if (list) list.push(fn);
      else fnsByFile.set(fn.loc.filePath, [fn]);
    }
    for (const { relativePath: file } of this.substrate.files()) {
      const parts = file.split('/');
      const rootIdx = packageLocalRouteRootIndex(file, rule.routeRoot, packagePathByFile.get(file) ?? '.');
      if (rootIdx === -1) continue;
      const rel = parts.slice(rootIdx + 1).join('/');
      if (!isPagesApiRouteFile(rel)) continue;
      const routePath = derivePagesRoutePath(rel);
      const method: HttpMethod = 'ALL';
      // An API handler is a camelCase FUNCTION (`export default handler`), not a page
      // component — read the default export without the PascalCase bias, or the peel
      // returns nothing (or a type name) and every endpoint falls back to a synthetic id.
      const declaredName = this.substrate.defaultExportedName(file, { allowAnyCase: true });
      const handlerFn = declaredName ? fnsByFile.get(file)?.find((fn) => fn.name === declaredName) : undefined;
      const handlerId = handlerFn
        ? idGen.functionId(file, handlerFn.name)
        : idGen.functionId(file, `${method} ${routePath}`);
      const loc = handlerFn?.loc ?? { filePath: file, startLine: 1, endLine: 1 };
      const pathParams = extractParams(routePath, 'brace');
      const id = idGen.httpEntrypointId(method, routePath, file);
      this.entrypoints.push({
        id,
        versionedId: idGen.versionedId(id, `${handlerFn?.name ?? 'default'}:${loc.startLine}`),
        type: 'http',
        handlerId,
        location: loc,
        details: {
          type: 'http',
          method,
          path: routePath,
          fullPath: routePath,
          ...(pathParams.length ? { pathParams } : {}),
        },
      });
    }
  }

  private extractDecoratorRoutes(rule: HttpEntrypointRule): void {
    if (rule.detect.via !== 'class-decorator') return;
    const idGen = this.substrate.idGen;
    const methodMap = rule.method as Record<string, string>;
    for (const c of this.substrate.classes()) {
      const classDec = this.findDecorator(c, rule.detect.name);
      if (!classDec) continue;
      const basePath = normalizeSegment(rule.basePath ? (firstStringArg(classDec) ?? '') : '');
      for (const m of c.methods) {
        const httpDec = m.decorators.find((d) => methodMap[decoName(d)] !== undefined);
        if (!httpDec) continue;
        const httpMethod = methodMap[decoName(httpDec)] as HttpMethod;
        const methodPath = normalizeSegment(firstStringArg(httpDec) ?? '');
        const fullPathRaw = applyGlobalPrefix(rule.globalPrefix, joinPaths(basePath, methodPath));
        const pathRaw = methodPath === '' ? '/' : `/${methodPath}`;
        const handlerId = idGen.methodId(c.loc.filePath, c.name, m.name);
        this.emitHttp(
          rule.paramSyntax,
          httpMethod,
          fullPathRaw,
          pathRaw,
          handlerId,
          `${c.name}.${m.name}:${m.loc.startLine}`,
          m.loc,
        );
      }
    }
  }

  private extractMethodDecoratorEntrypoints(rule: HttpEntrypointRule | QueueEntrypointRule): void {
    if (rule.detect.via !== 'method-decorator') return;
    const idGen = this.substrate.idGen;
    const names = rule.detect.names;
    for (const c of this.substrate.classes()) {
      for (const m of c.methods) {
        const dec = m.decorators.find((d) => names[decoName(d)] !== undefined);
        if (!dec) continue;
        const handlerId = idGen.methodId(c.loc.filePath, c.name, m.name);
        if (rule.kind === 'queue') {
          const open = dec.indexOf('(');
          const innerRaw = open >= 0 ? dec.slice(open + 1, dec.lastIndexOf(')')).trim() : '';
          // Fallback topic mirrors the ts-morph engine's cleanExpr: strip quotes from the
          // raw inner expression (e.g. topicFor('x' as Topics) → ...(x as Topics)).
          let topic: string | undefined;
          if (rule.topic.as === 'wrapped-enum-member') {
            // Extract the enum member reference from the wrapper call text.
            // e.g. @EventPattern(topicFor(Topics.EntityUpdatedV1)) → "Topics.EntityUpdatedV1"
            // Returns undefined when arg is dynamic or no wrapper matches — edge dropped.
            topic = firstWrappedMemberArg(dec, rule.topic.unwrapCalls);
          } else if (rule.topic.as === 'object-property') {
            topic = objectPropFromText(dec, rule.topic.key) ?? '';
          } else {
            topic = firstStringArg(dec) ?? innerRaw.replace(/['"`]/g, '').trim();
          }
          if (topic === undefined) continue;
          const topicValue =
            rule.topic.as === 'wrapped-enum-member' ? this.substrate.resolveConst(topic, m.loc.filePath) : undefined;
          const pattern = rule.pattern?.[decoName(dec)];
          this.emitQueue(
            rule.system,
            topic,
            handlerId,
            `${c.name}.${m.name}:${m.loc.startLine}`,
            m.loc,
            pattern,
            topicValue,
          );
        } else {
          const httpMethod = names[decoName(dec)] as HttpMethod;
          const methodPath = normalizeSegment(firstStringArg(dec) ?? '');
          const fullPathRaw = applyGlobalPrefix(rule.globalPrefix, joinPaths('', methodPath));
          const pathRaw = methodPath === '' ? '/' : `/${methodPath}`;
          this.emitHttp(
            rule.paramSyntax,
            httpMethod,
            fullPathRaw,
            pathRaw,
            handlerId,
            `${c.name}.${m.name}:${m.loc.startLine}`,
            m.loc,
          );
        }
      }
    }
  }

  private emitHttp(
    syntax: 'colon' | 'brace' | 'template',
    method: HttpMethod,
    fullPathRaw: string,
    pathRaw: string,
    handlerId: string,
    seed: string,
    loc: { filePath: string; startLine: number; endLine: number },
  ): void {
    const idGen = this.substrate.idGen;
    const fullPath = canonicalizeParams(fullPathRaw, syntax);
    const path = canonicalizeParams(pathRaw, syntax);
    const pathParams = extractParams(fullPathRaw, syntax);
    const id = idGen.httpEntrypointId(method, fullPath, loc.filePath);
    this.entrypoints.push({
      id,
      versionedId: idGen.versionedId(id, seed),
      type: 'http',
      handlerId,
      location: loc,
      details: { type: 'http', method, path, fullPath, ...(pathParams.length ? { pathParams } : {}) },
    });
  }

  private emitQueue(
    system: string,
    topic: string,
    handlerId: string,
    seed: string,
    loc: { filePath: string; startLine: number; endLine: number },
    pattern?: string,
    topicValue?: string,
  ): void {
    const idGen = this.substrate.idGen;
    const id = idGen.queueEntrypointId(system, topic, loc.filePath);
    this.entrypoints.push({
      id,
      versionedId: idGen.versionedId(id, topicValue ? `${seed}:${topicValue}` : seed),
      type: 'queue',
      handlerId,
      location: loc,
      details: {
        type: 'queue',
        system,
        topic,
        ...(topicValue ? { topicValue } : {}),
        ...(pattern ? { pattern } : {}),
      },
    });
  }

  // ── cli / grpc / graphql entrypoints ────────────────────────────────────────

  /**
   * HTTP routes registered as a call, the functional/Express shape:
   * `app.get('/x', handler)`, `router.post('/y', mw, (req, res) => …)`.
   *
   * The handler is read straight off the registration call — a bare reference resolves
   * to that function, an inline arrow synthesizes a node — which is what separates this
   * from `extractHandlerTableEntrypoints`, where the handler is a cross-file alias that
   * only a `handlerTables` registry can resolve. Those rules are skipped here so a route
   * is never emitted twice.
   */
  private extractCallShapeRoutes(rule: HttpEntrypointRule): void {
    if (rule.detect.via !== 'call-shape') return;
    const handler = rule.handler;
    if (handler && 'via' in handler && handler.via === 'handler-table') return;
    const detect = rule.detect;
    // Default to the last argument: middleware chains (`app.get(p, auth, handler)`) put
    // the handler last, and a two-arg registration is the same position.
    const handlerArgIndex = handler && 'arg' in handler ? handler.arg : -1;
    for (const site of this.substrate.callShapes(detect.callee)) {
      const basePath = this.scopedBasePath(site, detect);
      if (basePath === undefined) continue; // scoped rule with no matching wrapper
      const method = httpMethodFromCallee(site.method, rule);
      if (!method) continue;
      const routePath = this.readArgString(site.args[rule.methodPath.arg], rule.methodPath, site.file);
      // A non-literal path (a regex SPA fallback, a computed prefix) has no stable route
      // to key an entrypoint on — skip rather than invent one.
      if (routePath === undefined) continue;
      const handlerArg = handlerArgIndex < 0 ? site.args[site.args.length - 1] : site.args[handlerArgIndex];
      if (!handlerArg) continue;
      const fullPathRaw = applyGlobalPrefix(rule.globalPrefix, joinRoutePath(basePath, routePath));
      const handlerId = this.resolveRegistrationHandler(
        handlerArg,
        `${method.toLowerCase()}:${fullPathRaw}`,
        site.loc,
        site.file,
      );
      this.emitHttp(
        rule.paramSyntax,
        method,
        fullPathRaw,
        routePath,
        handlerId,
        `${method}:${fullPathRaw}:${site.loc.startLine}`,
        site.loc,
      );
    }
  }

  /**
   * Queue subscriptions registered as a call: `createKafkaConsumer({ groupId, topic })`,
   * `subscribe('topic', handler)`. The queue analogue of {@link extractCallShapeRoutes}
   * — and, until it existed, a call-shape queue rule with no `handlerTable` emitted
   * nothing at all, however correctly it was authored.
   *
   * The handler comes from the rule's `handler.arg` when the registration takes one;
   * otherwise the registering function IS the subscription's code (a consumer built
   * from a config object inside a constructor), which keeps handlerId pointing at real
   * code instead of a synthetic stub.
   */
  private extractCallShapeQueues(rule: QueueEntrypointRule): void {
    if (rule.detect.via !== 'call-shape') return;
    const handler = rule.handler;
    // Handler-table rules are owned by extractHandlerTableEntrypoints — never emit twice.
    if (handler && 'via' in handler && handler.via === 'handler-table') return;
    const detect = rule.detect;
    const ruleLabel = `queue entrypoint rule ${detect.callee}`;
    for (const site of this.substrate.callShapes(detect.callee)) {
      if (this.scopedBasePath(site, detect) === undefined) continue; // scoped rule with no matching wrapper
      const topic = this.readTopic(site.args[rule.topic.arg], rule, site.file, {
        ruleLabel,
        file: site.file,
        line: site.loc.startLine,
      });
      if (!topic) continue;
      const handlerId = this.resolveQueueHandler(rule, site, topic.topic);
      this.entrypoints.push(this.makeQueueEp(rule.system, topic.topic, handlerId, site, topic.topicValue));
    }
  }

  /** Handler for a call-shape queue registration: the declared handler arg, else the registering function. */
  private resolveQueueHandler(rule: QueueEntrypointRule, site: CallSite, topic: string): string {
    const handler = rule.handler;
    if (handler && 'arg' in handler) {
      const node = handler.arg < 0 ? site.args[site.args.length - 1] : site.args[handler.arg];
      if (node) return this.resolveRegistrationHandler(node, `${rule.system}:${topic}`, site.loc, site.file);
    }
    return (
      this.substrate.enclosingFunctionId(site.file, site.loc.startLine) ??
      this.synthesizeHandler(`${rule.system}:${topic}`, site.loc, { stub: true })
    );
  }

  /**
   * CLI command entrypoints from a fluent registration chain
   * (`program.command('parse').option(…).action(handler)`). The detect call-shape
   * matches the command call; its command name is `command`'s arg. The handler is
   * read from a sibling `action` call in the SAME chain — an ancestor of the command
   * call on the CST, so it appears in the command site's enclosing-call chain. A bare
   * function reference resolves to that function; an inline handler synthesizes a node.
   *
   * A registration assigned to a variable (`const sub = program.command('profile')…`)
   * is a command GROUP: commands registered on that variable are its subcommands, and
   * are emitted with the full command path (`profile push`). Without the qualifier,
   * same-named subcommands under different groups (`parser push` / `profile push`)
   * collapse onto one entrypoint id and all but one are silently dropped.
   */
  private extractCliEntrypoints(rule: CliEntrypointRule): void {
    if (rule.detect.via !== 'call-shape') return;
    const idGen = this.substrate.idGen;
    const sites = this.substrate.callShapes(rule.detect.callee);
    const commandOf = (site: CallSite): string | undefined => {
      const raw = this.readArgString(site.args[rule.command.arg], rule.command, site.file);
      // A commander name can carry arg placeholders (`sync-status <jobId>`); the
      // command is the leading token.
      return raw?.trim().split(/\s+/)[0] || undefined;
    };
    const groups = new Map<string, { command: string; receiver?: string }>();
    for (const site of sites) {
      if (!site.assignedTo) continue;
      const command = commandOf(site);
      if (command) groups.set(`${site.file}:${site.assignedTo}`, { command, receiver: site.receiver });
    }
    for (const site of sites) {
      const command = commandOf(site);
      if (!command) continue;
      const actionSite = site.enclosingCallChain.find((c) => c.method === rule.action.call);
      const handlerArg = actionSite?.args[rule.action.arg];
      if (!actionSite || !handlerArg) continue;
      // Prepend group names by walking the receiver chain (cycle-guarded; a receiver
      // that isn't a known group — `program` itself — ends the walk).
      const segments = [command];
      const seen = new Set<string>();
      let receiver = site.receiver;
      while (receiver) {
        const key = `${site.file}:${receiver}`;
        if (seen.has(key)) break;
        seen.add(key);
        const group = groups.get(key);
        if (!group) break;
        segments.unshift(group.command);
        receiver = group.receiver;
      }
      const fullCommand = segments.join(' ');
      const handlerId = this.resolveRegistrationHandler(handlerArg, fullCommand, actionSite.loc, site.file);
      const id = idGen.entrypointId('cli', fullCommand, site.loc.filePath);
      this.entrypoints.push({
        id,
        versionedId: idGen.versionedId(id, `${fullCommand}:${site.loc.startLine}`),
        type: 'cli',
        handlerId,
        location: site.loc,
        details: { type: 'cli', command: fullCommand },
      });
    }
  }

  /**
   * Resolve the handler argument of a registration call (a CLI `.action(fn)`, an HTTP
   * `app.get(path, fn)`) to a function id. A bare reference that names a top-level
   * function in the same file resolves to it; otherwise (inline arrow / imported
   * reference) a node is synthesized under `fallbackName` so the handlerId always
   * resolves to a real node — mirroring the custom-rule inline-handler path.
   */
  private resolveRegistrationHandler(
    handlerArg: ArgNode,
    fallbackName: string,
    loc: SubstrateLoc,
    file: string,
  ): string {
    if (handlerArg.identifier) {
      const fid = this.substrate.functionId(file, handlerArg.identifier);
      return fid ?? this.synthesizeHandler(handlerArg.identifier, loc, { stub: true });
    }
    return this.synthesizeHandler(fallbackName, loc);
  }

  /** Synthesize (idempotently) a handler function node for an inline/unresolved handler. */
  private synthesizeHandler(name: string, loc: SubstrateLoc, opts?: { stub?: boolean }): string {
    const idGen = this.substrate.idGen;
    const id = idGen.functionId(loc.filePath, name);
    if (!this.synthesizedFunctions.some((f) => f.id === id)) {
      this.synthesizedFunctions.push({
        id,
        versionedId: idGen.versionedId(id, `${name}:${loc.startLine}`),
        name,
        kind: 'function',
        fileId: idGen.fileId(loc.filePath),
        location: loc,
        isAsync: false,
        isGenerator: false,
        parameters: [],
        isExported: false,
      });
    }
    if (!opts?.stub) this.inlineHandlerIds.add(id);
    return id;
  }

  /**
   * Backfill each inline synthesized handler with its span's source slice and re-derive
   * its versionedId from that content — the same checksum contract real function nodes
   * get in structuralToNodes, so an edit to the handler body re-versions the node.
   * Without source the summarizer can only guess from the node's name. Identifier stubs
   * stay source-less: their body lives elsewhere and the registration line would lie.
   */
  private hydrateInlineHandlers(repoRoot: string): void {
    const linesByFile = new Map<string, string[] | undefined>();
    for (const fn of this.synthesizedFunctions) {
      if (!this.inlineHandlerIds.has(fn.id)) continue;
      const { filePath, startLine, endLine } = fn.location;
      if (!linesByFile.has(filePath)) {
        // An unreadable file degrades this node to the source-less state it had before
        // hydration (the summarizer's documented signature-only fallback) — same
        // optional-source contract as structuralToNodes, so no throw.
        try {
          linesByFile.set(filePath, readFileSync(join(repoRoot, filePath), 'utf8').split('\n'));
        } catch {
          linesByFile.set(filePath, undefined);
        }
      }
      // Cap mirrors structuralToNodes' guard against pathological/minified spans.
      const source = linesByFile
        .get(filePath)
        ?.slice(startLine - 1, endLine)
        .join('\n')
        .slice(0, 20000);
      if (!source?.trim()) continue;
      fn.sourceCode = source;
      fn.versionedId = this.substrate.idGen.versionedId(fn.id, source);
    }
  }

  /**
   * The innermost inline synthesized handler that owns a fact recorded at `loc` under
   * `callerId`: the fact sits inside the handler's span while its recorded caller is a
   * lexical ANCESTOR of that span (span-contains-span). The ancestor guard keeps facts
   * owned by a named function nested inside the handler (`const helper = () => …`)
   * attributed to that function — only facts that fell through to the surrounding
   * registrar scope are re-parented.
   */
  private inlineHandlerOwning(
    callerId: string,
    loc: { filePath: string; startLine: number },
    callerSpans: Map<string, SubstrateLoc>,
  ): FunctionNode | undefined {
    let best: FunctionNode | undefined;
    for (const fn of this.synthesizedFunctions) {
      if (!this.inlineHandlerIds.has(fn.id) || fn.id === callerId) continue;
      const s = fn.location;
      if (s.filePath !== loc.filePath || loc.startLine < s.startLine || loc.startLine > s.endLine) continue;
      const caller = callerSpans.get(callerId);
      if (!caller || caller.filePath !== s.filePath || caller.startLine > s.startLine || caller.endLine < s.endLine) {
        continue;
      }
      if (!best || s.endLine - s.startLine < best.location.endLine - best.location.startLine) best = fn;
    }
    return best;
  }

  /** Read a string off a call-shape arg per an ArgRef (string-literal / const-string). */
  private readArgString(arg: ArgNode | undefined, ref: ArgRef, file: string): string | undefined {
    if (!arg) return undefined;
    if (ref.as === 'const-string') {
      if (arg.stringLiteral !== undefined) return arg.stringLiteral;
      return arg.identifier ? this.substrate.resolveConst(arg.identifier, file) : undefined;
    }
    return arg.stringLiteral;
  }

  /**
   * gRPC method entrypoints from a method decorator (`@GrpcMethod('Svc','M')`).
   * `detect.names` maps the decorator to its streaming type; service/method read the
   * decorator's string args, each with a fallback (class name / method name). The
   * handler is the decorated method itself, exactly like http decorator routes.
   */
  private extractGrpcEntrypoints(rule: GrpcEntrypointRule): void {
    if (rule.detect.via !== 'method-decorator') return;
    const idGen = this.substrate.idGen;
    const names = rule.detect.names;
    for (const c of this.substrate.classes()) {
      for (const m of c.methods) {
        const dec = m.decorators.find((d) => names[decoName(d)] !== undefined);
        if (!dec) continue;
        const streaming = (names[decoName(dec)] ?? 'unary') as 'unary' | 'server' | 'client' | 'bidirectional';
        const args = decoStringArgs(dec);
        const service = (rule.service ? args[rule.service.arg] : undefined) ?? c.name;
        const method = (rule.method ? args[rule.method.arg] : undefined) ?? m.name;
        const handlerId = idGen.methodId(c.loc.filePath, c.name, m.name);
        const id = idGen.grpcEntrypointId(service, method, c.loc.filePath);
        this.entrypoints.push({
          id,
          versionedId: idGen.versionedId(id, `${c.name}.${m.name}:${m.loc.startLine}`),
          type: 'grpc',
          handlerId,
          location: m.loc,
          details: { type: 'grpc', serviceName: service, methodName: method, streaming },
        });
      }
    }
  }

  /**
   * GraphQL resolver-field entrypoints: `@Query`/`@Mutation`/`@Subscription` methods
   * inside a `@Resolver()` class. `operation` maps the field decorator to the operation
   * type; `fieldName` falls back to the method name; `parentType` reads `@Resolver(() => T)`
   * and falls back to the root operation type. The handler is the decorated method.
   */
  private extractGraphqlEntrypoints(rule: GraphqlEntrypointRule): void {
    if (rule.detect.via !== 'class-decorator') return;
    const idGen = this.substrate.idGen;
    const opMap = rule.operation;
    for (const c of this.substrate.classes()) {
      const classDec = this.findDecorator(c, rule.detect.name);
      if (!classDec) continue;
      const resolverParent = rule.parentType ? this.readDecoString(classDec, rule.parentType) : undefined;
      for (const m of c.methods) {
        const opDec = m.decorators.find((d) => opMap[decoName(d)] !== undefined);
        if (!opDec) continue;
        const operationType = opMap[decoName(opDec)];
        const fieldName = (rule.fieldName ? this.readDecoString(opDec, rule.fieldName) : undefined) ?? m.name;
        const parentType = resolverParent ?? rootTypeFor(operationType);
        const handlerId = idGen.methodId(c.loc.filePath, c.name, m.name);
        const id = idGen.graphqlEntrypointId(operationType, fieldName, c.loc.filePath);
        this.entrypoints.push({
          id,
          versionedId: idGen.versionedId(id, `${c.name}.${m.name}:${m.loc.startLine}`),
          type: 'graphql',
          handlerId,
          location: m.loc,
          details: { type: 'graphql', operationType, fieldName, parentType },
        });
      }
    }
  }

  /** Read a string off a decorator per an ArgRef (string-literal / object-property / arrow-target). */
  private readDecoString(dec: string, ref: ArgRef): string | undefined {
    if (ref.as === 'object-property') return objectPropFromText(dec, ref.key);
    if (ref.as === 'arrow-target') return arrowTarget(dec);
    return firstStringArg(dec);
  }

  // ── handler-table entrypoints (require/alias registry resolution) ───────────

  private extractHandlerTableEntrypoints(): void {
    const tables = new Map((this.profile.handlerTables ?? []).map((t) => [t.name, t]));
    const aliasMaps = new Map<string, Map<string, string>>();
    const aliasMapFor = (t: HandlerTable): Map<string, string> => {
      let m = aliasMaps.get(t.name);
      if (!m) {
        m = t.inFile
          ? this.substrate.requireRegistry({
              registryVar: t.registryVar,
              inFile: t.inFile,
              nested: t.nested ?? false,
              requirePrefix: t.requirePrefix ?? 'app/',
            })
          : new Map<string, string>();
        aliasMaps.set(t.name, m);
      }
      return m;
    };

    for (const rule of this.profile.entrypoints ?? []) {
      // Only http/queue call-shape rules resolve a handler through a handler-table;
      // cli carries its handler in a sibling `action` call, grpc/graphql on the method.
      if (rule.kind !== 'http' && rule.kind !== 'queue') continue;
      if (!('detect' in rule) || rule.detect.via !== 'call-shape') continue;
      const handler = rule.handler;
      if (!handler || !('via' in handler) || handler.via !== 'handler-table') continue;
      const table = tables.get(handler.table);
      if (!table) continue;
      if (table.reference === 'member-chain') {
        this.extractMemberChainEntrypoints(rule, handler.arg, table, aliasMapFor(table));
      } else {
        this.extractRequireArgEntrypoints(rule, table);
      }
    }
  }

  private extractMemberChainEntrypoints(
    rule: HttpEntrypointRule | QueueEntrypointRule,
    handlerArg: number,
    table: HandlerTable,
    aliasMap: Map<string, string>,
  ): void {
    const detect = rule.detect as Extract<Detector, { via: 'call-shape' }>;
    for (const site of this.substrate.callShapes(detect.callee)) {
      const basePath = this.scopedBasePath(site, detect);
      if (basePath === undefined) continue; // scoped rule with no matching wrapper
      const handlerArgNode = handlerArg < 0 ? site.args[site.args.length - 1] : site.args[handlerArg];
      if (!handlerArgNode) continue;
      const handlerId = this.resolveMemberChainHandler(handlerArgNode.text, table, aliasMap);
      if (!handlerId || !this.substrate.hasFunctionId(handlerId)) continue;

      if (rule.kind === 'http') {
        const method = httpMethodFromCallee(site.method, rule);
        if (!method) continue;
        const routeArg = site.args[rule.methodPath.arg];
        if (routeArg?.stringLiteral === undefined) continue;
        const routePath = routeArg.stringLiteral;
        const fullPathRaw = applyGlobalPrefix(rule.globalPrefix, joinRoutePath(basePath, routePath));
        this.emitHttp(
          rule.paramSyntax,
          method,
          fullPathRaw,
          routePath,
          handlerId,
          `${method}:${fullPathRaw}:${site.loc.startLine}`,
          site.loc,
        );
      } else {
        const topicArg = site.args[rule.topic.arg];
        const topic = this.readTopic(topicArg, rule, site.file, {
          ruleLabel: `queue entrypoint rule ${detect.callee}`,
          file: site.file,
          line: site.loc.startLine,
        });
        if (!topic) continue;
        this.entrypoints.push(this.makeQueueEp(rule.system, topic.topic, handlerId, site, topic.topicValue));
      }
    }
  }

  private extractRequireArgEntrypoints(rule: EntrypointRule, table: HandlerTable): void {
    if (rule.kind !== 'queue') return;
    const detect = rule.detect as Extract<Detector, { via: 'call-shape' }>;
    const prefix = table.requirePrefix ?? 'app/';
    for (const site of this.substrate.callShapes(detect.callee)) {
      const obj = site.args[0];
      if (!obj?.objectEntries) continue;
      for (const entry of obj.objectEntries) {
        const file = requirePathToRel(entry.valueText, prefix);
        if (!file) continue;
        const handlerId = table.defaultMethod ? this.substrate.functionId(file, table.defaultMethod) : undefined;
        if (!handlerId || !this.substrate.hasFunctionId(handlerId)) continue;
        this.entrypoints.push(this.makeQueueEp(rule.system, entry.key, handlerId, site));
      }
    }
  }

  /**
   * For a scoped call-shape, return the wrapper's base-path arg (e.g.
   * `router.extend("/base", fn)`); '' for unscoped rules; undefined when scoped
   * but no matching wrapper encloses the site.
   */
  private scopedBasePath(site: CallSite, detect: Extract<Detector, { via: 'call-shape' }>): string | undefined {
    if (!detect.scopedBy) return '';
    for (const wrapper of site.enclosingCallChain) {
      if (wrapper.calleeText !== detect.scopedBy.callee) continue;
      const baseArg = wrapper.args[detect.scopedBy.basePathArg];
      if (baseArg?.stringLiteral !== undefined) return baseArg.stringLiteral;
    }
    return undefined;
  }

  private resolveMemberChainHandler(
    refText: string,
    table: HandlerTable,
    aliasMap: Map<string, string>,
  ): string | undefined {
    // Whitespace first: formatters wrap long chains (`handlers.a.b\n  .method`).
    const cleaned = refText.replace(/\s+/g, '').replace(/\(.*\)$/, '');
    const head = `${table.registryVar}.`;
    if (!cleaned.startsWith(head)) return undefined;
    const parts = cleaned.slice(head.length).split('.');
    if (parts.length === 0) return undefined;
    if (table.defaultMethod) {
      const wholeFile = aliasMap.get(parts.join('.'));
      if (wholeFile) return this.substrate.functionId(wholeFile, table.defaultMethod);
    }
    if (parts.length < 2) return undefined;
    const methodName = parts[parts.length - 1];
    const file = aliasMap.get(parts.slice(0, -1).join('.'));
    if (!file) return undefined;
    return this.substrate.functionId(file, methodName);
  }

  // ── unresolved required dimensions (emit-with-sentinel, never drop silently) ──

  /**
   * Record that a rule matched but its required dimension is not a static string,
   * so the entrypoint ships with an `unresolved:` value. Deduped per rule per file:
   * the warning carries the site count and the distinct expressions, which is what
   * a coverage scorecard needs — one line per site would be unreadable noise.
   */
  private noteUnresolved(ctx: UnresolvedContext, expression: string): void {
    const key = `${ctx.ruleLabel}|${ctx.dimension}|${ctx.file}`;
    let rec = this.unresolved.get(key);
    if (!rec) {
      rec = {
        file: ctx.file,
        line: ctx.line,
        ruleLabel: ctx.ruleLabel,
        dimension: ctx.dimension,
        count: 0,
        expressions: new Set<string>(),
      };
      this.unresolved.set(key, rec);
    }
    rec.count += 1;
    if (rec.expressions.size < UNRESOLVED_SAMPLE_CAP) rec.expressions.add(expression);
  }

  /** Flush the accumulated unresolved-dimension records into repo `errors[]` warnings. */
  private unresolvedWarnings(): ParseError[] {
    return [...this.unresolved.values()].map((r) => ({
      file: r.file,
      line: r.line,
      severity: 'warning' as const,
      message:
        `${r.ruleLabel}: ${r.count} site(s) emitted with an unresolved ${r.dimension} — ` +
        `not a static string and not a foldable module const (${[...r.expressions].join(', ')}). ` +
        `Emitted as "${markUnresolved('<expression>')}".`,
    }));
  }

  /**
   * Read a required entrypoint dimension (queue topic, and the seam any other
   * call-shape dimension would use) off the expression written at the site.
   *
   * A quoted literal IS the value. Otherwise ONE bounded hop through the
   * module-const resolver — same file first, then the import table to another
   * module's exported string const — supplies `runtimeValue` while `value` keeps
   * the token as written. Nothing is evaluated: an interpolated template, a call,
   * or a runtime member access does not fold, and then the value is sentinel-marked
   * and the site recorded. Never returns undefined — the caller has already
   * established that the rule describes this site.
   */
  private readRequiredDimension(
    expression: string,
    file: string,
    ctx: UnresolvedContext,
  ): { value: string; runtimeValue?: string } {
    const literal = quotedLiteral(expression);
    if (literal !== undefined) return { value: literal };
    const folded = this.substrate.resolveConst(expression, file);
    if (folded !== undefined) return { value: expression, runtimeValue: folded };
    this.noteUnresolved(ctx, expression);
    return { value: markUnresolved(expression) };
  }

  /**
   * The topic expression a queue rule points at, as written at the site — undefined
   * when the rule simply does not describe this call (no object property with the
   * declared key, no wrapper call for a `wrapped-enum-member` ref). That distinction
   * is what keeps emit-with-unresolved from inventing entrypoints: a MISSING
   * dimension means "not this shape"; a PRESENT but dynamic one means "unresolved".
   */
  private topicExpression(arg: ArgNode, rule: QueueEntrypointRule): string | undefined {
    if (rule.topic.as === 'object-property') {
      const key = rule.topic.key;
      const entry = arg.objectEntries?.find((e) => e.key === key);
      if (entry) return entry.valueText.trim();
      // ES6 shorthand `{ groupId, topic }`: the property names its own binding.
      return hasShorthandKey(arg.text, key) ? key : undefined;
    }
    if (rule.topic.as === 'wrapped-enum-member') {
      // Use the pre-parsed callExpr field from toArgNode for the call-shape path.
      // e.g. client.emit(topicFor(Topics.EntityUpdatedV1), ...) →
      //   arg.callExpr = { callee: 'topicFor', firstArgText: 'Topics.EntityUpdatedV1' }
      const callExpr = arg.callExpr;
      if (!callExpr || !rule.topic.unwrapCalls.includes(callExpr.callee)) return undefined;
      return callExpr.firstArgText;
    }
    return arg.stringLiteral ?? arg.text;
  }

  /**
   * The topic of a queue registration. Returns undefined ONLY when the rule does not
   * describe this call at all (see topicExpression); a topic that is present but
   * dynamic comes back sentinel-marked with a recorded warning, so the subscription
   * stays visible instead of vanishing with the whole entrypoint.
   *
   * `const-string` keeps its established semantics — the FOLDED value is the topic,
   * because producer/consumer cross-repo matching joins on it — while every other
   * `as` keeps the token as written and carries the folded value in `topicValue`
   * (the documented QueueEntrypointDetails contract).
   */
  private readTopic(
    arg: ArgNode | undefined,
    rule: QueueEntrypointRule,
    file: string,
    ctx: Omit<UnresolvedContext, 'dimension'>,
  ): { topic: string; topicValue?: string } | undefined {
    if (!arg) return undefined;
    const expression = this.topicExpression(arg, rule);
    if (expression === undefined) return undefined;
    const dimCtx = { ...ctx, dimension: 'topic' };
    if (rule.topic.as === 'const-string') {
      if (arg.stringLiteral !== undefined) return { topic: arg.stringLiteral };
      const folded = this.substrate.resolveConst(expression, file);
      if (folded !== undefined) return { topic: folded };
      this.noteUnresolved(dimCtx, expression);
      return { topic: markUnresolved(expression) };
    }
    // A literal arg is already the topic — no folding, no sentinel.
    if (rule.topic.as !== 'object-property' && arg.stringLiteral !== undefined) return { topic: arg.stringLiteral };
    const read = this.readRequiredDimension(expression, file, dimCtx);
    return { topic: read.value, ...(read.runtimeValue ? { topicValue: read.runtimeValue } : {}) };
  }

  private makeQueueEp(
    system: string,
    topic: string,
    handlerId: string,
    site: CallSite,
    topicValue?: string,
  ): Entrypoint {
    const idGen = this.substrate.idGen;
    const id = idGen.queueEntrypointId(system, topic, site.loc.filePath);
    return {
      id,
      versionedId: idGen.versionedId(id, `${topic}:${site.loc.startLine}${topicValue ? `:${topicValue}` : ''}`),
      type: 'queue',
      handlerId,
      location: site.loc,
      details: { type: 'queue', system, topic, ...(topicValue ? { topicValue } : {}) },
    };
  }

  // ── custom rules (facts-only escape hatch) ──────────────────────────────────

  /**
   * Run each profile.customRules entry over a READ-ONLY facts view + typed emitters.
   * The facts object exposes only already-extracted substrate reads; emit.entrypoint
   * builds a proper Entrypoint (mirroring makeQueueEp) and pushes to this.entrypoints,
   * so emitted nodes flow into the graph exactly like built-in ones. The narrow API
   * surface — not a sandbox — is what keeps a custom rule reviewable and bounded.
   */
  private runCustomRules(repoRoot: string): void {
    const rules = this.profile.customRules ?? [];
    if (rules.length === 0) return;
    const idGen = this.substrate.idGen;
    const facts: CustomRuleFacts = {
      repoRoot,
      callShapes: (p) => this.substrate.callShapes(p),
      functionId: (file, name) => this.substrate.functionId(file, name),
      enclosingFunctionId: (file, line) => this.substrate.enclosingFunctionId(file, line),
      resolveConstMember: (ref) => this.substrate.resolveConstMember(ref),
    };
    const emit = (ruleName: string): CustomRuleEmit => ({
      entrypoint: (n) => {
        const location = { filePath: n.file, startLine: n.startLine, endLine: n.endLine };
        const handlerId = this.requireEmittedFunction(ruleName, 'handlerId', n.handlerId) ?? '';
        if (n.type === 'http') {
          // Pick the param syntax off the path itself rather than adding a knob: a rule
          // reads whatever the registration call wrote, and the two forms are distinguishable.
          const syntax = /:[A-Za-z0-9_]+/.test(n.path) ? 'colon' : 'brace';
          this.emitHttp(syntax, n.method, n.path, n.path, handlerId, `${n.method}:${n.path}:${n.startLine}`, location);
          return;
        }
        const system = n.system ?? 'queue';
        const id = idGen.queueEntrypointId(system, n.channel, n.file);
        this.entrypoints.push({
          id,
          versionedId: idGen.versionedId(id, `${n.channel}:${n.startLine}`),
          type: 'queue',
          handlerId,
          location,
          details: { type: 'queue', system, topic: n.channel },
        });
      },
      externalCall: (n) => {
        const callerId = this.requireEmittedFunction(ruleName, 'callerId', n.callerId);
        if (!callerId) return;
        const location = { filePath: n.file, startLine: n.startLine, endLine: n.endLine };
        const id = idGen.generateNodeId(
          'external-call' as Parameters<typeof idGen.generateNodeId>[0],
          callerId,
          n.method,
          String(n.startLine),
        );
        const edge: ExternalCallEdge = {
          id,
          versionedId: idGen.versionedId(id, `${n.serviceName}.${n.method}`),
          callerId,
          serviceName: n.serviceName,
          method: n.method,
          location,
          ...(n.sdkName ? { sdkName: n.sdkName } : {}),
          ...(n.targetPattern ? { targetPattern: n.targetPattern } : {}),
        };
        if (n.httpMethod) {
          edge.targetDescriptor = {
            protocol: 'http',
            http: { method: n.httpMethod, pathTemplate: n.targetPattern ?? '' },
          };
        } else if (n.ipc) {
          edge.targetDescriptor = { protocol: 'ipc', ipc: n.ipc };
        }
        this.externals.push(edge);
      },
      dbOperation: (n) => {
        const performerId = this.requireEmittedFunction(ruleName, 'performerId', n.performerId);
        if (!performerId) return;
        const id = idGen.dbOperationId(performerId, `${n.entityName}:${n.startLine}`, n.operation, String(n.startLine));
        const entityId = this.entityIdByName.get(n.entityName);
        this.dbOps.push({
          id,
          versionedId: idGen.versionedId(id, n.details ?? n.entityName),
          performerId,
          ...(entityId ? { entityId } : {}),
          entityName: n.entityName,
          operation: n.operation,
          ...(n.details ? { details: n.details.slice(0, 200) } : {}),
          location: { filePath: n.file, startLine: n.startLine, endLine: n.endLine },
        });
      },
      handlerFunction: (n) => {
        // Always inline by contract (see CustomRuleEmit.handlerFunction): the span is
        // the handler's own site, so it participates in hydration + re-attribution.
        return this.synthesizeHandler(n.name, { filePath: n.file, startLine: n.startLine, endLine: n.endLine });
      },
    });
    for (const rule of rules) rule.run(facts, emit(rule.name));
  }

  /**
   * Validate a node id a custom rule passed in. A rule may only reference functions that
   * already exist — its own synthesized handlers included. Returning a dangling id would
   * put an unresolvable edge in the graph, so an unknown one throws naming the rule:
   * silently dropping it is how a rule ends up looking like it ran when it did not.
   */
  private requireEmittedFunction(ruleName: string, field: string, id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    if (this.substrate.hasFunctionId(id) || this.synthesizedFunctions.some((f) => f.id === id)) return id;
    throw new Error(
      `customRules['${ruleName}'] emitted ${field}='${id}', which is not a function node in this repo. ` +
        'Resolve it with facts.functionId(file, name), or synthesize one with emit.handlerFunction().',
    );
  }

  // ── db operations ────────────────────────────────────────────────────────────

  private extractDbOperations(): void {
    const rule = this.profile.dbOperations;
    if (!rule) return;
    this.extractRawQueryDbOps(rule);
    // No opMap → no ORM to match (raw-query-only profile). Skip the receiver pass rather
    // than walking every call shape to index an absent map.
    if (!rule.opMap) return;
    const opMap = rule.opMap;
    // We re-walk call sites via callShapes to get receiver/method/args + enclosing fn id.
    for (const site of this.substrate.callShapes()) {
      if (!site.method || !site.receiver) continue;
      const op = opMap[site.method] as DbOperationType | undefined;
      if (!op) continue;
      // enclosingFnId resolves against the substrate's emitted class/function
      // nodes, so a non-null id is already a real caller node. db ops still need
      // a real caller node; skip if none.
      const callerId = this.enclosingFnId(site);
      if (!callerId) continue;
      this.dbOpSiteKeys.add(callSiteKey(callerId, site.loc, site.calleeText));
      const receiver = site.receiver;
      const propName = receiver.startsWith('this.') ? receiver.slice('this.'.length) : receiver;

      // Receiver families, derived ONCE per site. The BR-4 scope observation below and the
      // binding branches that follow both read them; they used to be computed twice, the scope
      // check compiling fresh RegExps and re-running `diClassFor`/`repoBaseClassEntity`.
      const isModel =
        rule.modelReceiverPattern !== undefined && regexFromSource(rule.modelReceiverPattern).test(receiver);
      const isTransactionReceiver =
        rule.transactionReceiverPattern !== undefined &&
        regexFromSource(rule.transactionReceiverPattern).test(receiver);
      const isTransactionOp =
        isTransactionReceiver &&
        (op === 'transaction' || site.method === 'transaction' || site.method === 'inTransaction');
      const isEm = (rule.emReceivers ?? []).some((p) => receiverPatternMatches(receiver, p));
      // `diClassFor` and `repoBaseClassEntity` are the expensive derivations. The cheap families
      // above already decide both the scope answer and the branch taken, so skip them there —
      // the scope check short-circuited on exactly the same families before.
      const needsRepoLookup = !isModel && !isTransactionOp && !isEm;
      const diClass = needsRepoLookup ? this.diClassFor(site.file, propName) : undefined;
      const isRepo =
        needsRepoLookup &&
        rule.repoReceiverPattern !== undefined &&
        (regexFromSource(rule.repoReceiverPattern).test(propName) ||
          (diClass !== undefined && regexFromSource(rule.repoReceiverPattern).test(diClass)));
      // Repo-base-class entity: a call whose receiver resolves to a repository class that
      // extends a generic base repo typed with an entity. Two receiver shapes:
      //  (a) `this.<op>()` inside the repo class itself → enclosing-class entity;
      //  (b) `this.<diProp>.<op>()` where the DI prop is typed as a repo class.
      // The bound entity replaces the `unknown` an isRepo/this receiver would otherwise get.
      const repoEntity = needsRepoLookup ? this.repoBaseClassEntity(site, propName, diClass) : undefined;

      if (
        !this.dbOpReceiverInScope(receiver, {
          isModel,
          isTransactionReceiver,
          isEm,
          isRepo,
          repoEntity,
          diClass,
        })
      )
        this.dbOpOutOfScope++;

      // model-receiver: models.User.findAll() — entity named inline.
      if (isModel) {
        const modelName = receiver.split('.').pop() as string;
        this.pushDbOp(callerId, op, site, modelName, modelName);
        continue;
      }
      // transaction-ish receiver (entity-agnostic).
      if (isTransactionOp) {
        this.pushDbOp(callerId, 'transaction', site, 'transaction', 'transaction');
        continue;
      }
      // em / repo receivers.
      if (!isEm && !isRepo && !repoEntity) continue;

      if (isEm) {
        const entityArg = rule.entityFrom ? this.readArgIdentifier(site.args[rule.entityFrom.arg]) : undefined;
        if (entityArg && this.entityNames.has(entityArg)) {
          this.pushDbOp(callerId, op, site, `${receiver}.${site.method}`, entityArg);
        }
        // em.flush() etc — not entity-specific → drop (matches ts-morph).
      } else {
        this.pushDbOp(callerId, op, site, `${receiver}.${site.method}`, repoEntity ?? 'unknown');
      }
    }
  }

  /**
   * Build (lazily) the map of repository-class name → managed entity name, from any class
   * whose `extends Base<Entity>` heritage names a base in `dbOperations.repoBaseClasses`
   * and whose first generic type arg is a known entity. A base typed with a bare type
   * parameter (`extends EntityRepository<T>`) yields no entity (T isn't an entity) and is
   * skipped — so the generic `BaseRepository<T extends …>` itself never maps, only its
   * concrete subclasses (`FooRepository extends BaseRepository<Foo>`).
   */
  private repoEntityByClassMemo?: Map<string, string>;
  private repoEntityByClass(): Map<string, string> {
    if (this.repoEntityByClassMemo) return this.repoEntityByClassMemo;
    const out = new Map<string, string>();
    const bases = this.profile.dbOperations?.repoBaseClasses;
    if (bases?.length) {
      const baseSet = new Set(bases);
      for (const c of this.substrate.classes()) {
        const ext = c.extendsClass;
        if (!ext || !baseSet.has(ext.name)) continue;
        const firstArg = ext.typeArgs[0]?.replace(/<.*>/, '').trim();
        if (firstArg && this.entityNames.has(firstArg)) out.set(c.name, firstArg);
      }
    }
    this.repoEntityByClassMemo = out;
    return out;
  }

  /**
   * Resolve the managed entity for a db-op call whose receiver is a repository instance:
   *  (a) `this.<op>()` inside a repo class → that class's entity;
   *  (b) `this.<diProp>.<op>()` where the DI prop's type is a repo class → that class's entity.
   * Returns undefined when neither shape resolves to a repo-base-class entity.
   */
  private repoBaseClassEntity(site: CallSite, propName: string, diClass: string | undefined): string | undefined {
    const byClass = this.repoEntityByClass();
    // (a) `this.<op>()` — receiver is exactly `this`; resolve via the enclosing class.
    if (byClass.size > 0 && site.receiver === 'this') {
      const cls = this.enclosingClassName(site);
      if (cls) {
        const e = byClass.get(cls);
        if (e) return e;
      }
    }
    // (b) `this.<diProp>.<op>()` — the DI prop is typed as a custom repo subclass.
    if (byClass.size > 0 && diClass) {
      const e = byClass.get(diClass);
      if (e) return e;
    }
    // (c) `this.<diProp>.<op>()` where the DI prop is typed DIRECTLY as a generic base
    // repo (`EntityRepository<Customer>`) rather than a custom subclass — the
    // NestJS-MikroORM `@InjectRepository(Customer)` shape. Resolve from the injected
    // field's own generic type arg. Independent of repoEntityByClass / byClass.size.
    return this.diRepoEntityFromFieldGeneric(site.file, propName);
  }

  /**
   * Resolve the managed entity for a DI prop typed directly as `Base<Entity>` where
   * `Base ∈ dbOperations.repoBaseClasses` and `Entity` is a known entity — e.g.
   * `customerRepository: EntityRepository<Customer>`. Reads the RAW ctor-param type,
   * so it works even under `di.stripGenerics` (which only strips diClassFor's view).
   */
  private diRepoEntityFromFieldGeneric(file: string, propName: string): string | undefined {
    const bases = this.profile.dbOperations?.repoBaseClasses;
    if (!bases?.length) return undefined;
    const baseSet = new Set(bases);
    for (const c of this.substrate.classes()) {
      if (c.loc.filePath !== file) continue;
      const p = c.ctorParams.find((cp) => cp.name === propName);
      if (!p?.type) continue;
      const m = /^([A-Za-z_$][\w$]*)\s*<\s*([A-Za-z_$][\w$]*)/.exec(p.type.trim());
      if (m && baseSet.has(m[1]) && this.entityNames.has(m[2])) return m[2];
    }
    return undefined;
  }

  /** Name of the class whose span contains this call site (undefined when module-scope). */
  private enclosingClassName(site: CallSite): string | undefined {
    for (const c of this.substrate.classes()) {
      if (c.loc.filePath !== site.file) continue;
      if (c.loc.startLine <= site.loc.startLine && site.loc.startLine <= c.loc.endLine) return c.name;
    }
    return undefined;
  }

  /**
   * Is this db-op site's receiver something this repository could bind? True when the receiver
   * matches one of the profile's receiver families (model / transaction / em / repo / repo-base)
   * or names an in-repo entity or repository class. False means no node in this graph could be
   * its target (BR-4's analogue of BR-1), e.g. an external ORM constant.
   *
   * The families are derived ONCE per site by the caller and passed in: this check and the
   * binding branches need the same answers, and recomputing them here cost a second
   * `diClassFor` + `repoBaseClassEntity` (which rebuilds `substrate.classes()`) per site.
   */
  private dbOpReceiverInScope(receiver: string, fam: DbOpReceiverFamilies): boolean {
    if (fam.isModel || fam.isTransactionReceiver || fam.isEm || fam.isRepo || fam.repoEntity !== undefined) return true;
    const repoClasses = this.repoEntityByClass();
    for (const token of [...receiver.split('.'), ...(fam.diClass ? [fam.diClass] : [])])
      if (this.entityNames.has(token) || repoClasses.has(token)) return true;
    return false;
  }

  private extractRawQueryDbOps(rule: DbOpRule): void {
    for (const matcher of rule.rawQueries ?? []) {
      for (const site of this.substrate.callShapes()) {
        if (!site.method || !matcher.methods.includes(site.method)) continue;
        if (matcher.inPaths && !matcher.inPaths.some((p) => site.file.startsWith(p))) continue;
        if (
          matcher.receivers &&
          !(site.receiver && matcher.receivers.some((r) => new RegExp(r).test(site.receiver as string)))
        )
          continue;
        const callerId = this.enclosingFnId(site);
        if (!callerId) continue;
        this.dbOpSiteKeys.add(callSiteKey(callerId, site.loc, site.calleeText));
        const arg = site.args[matcher.queryArg ?? 0];
        const q = queryText(arg);
        // A SQL statement whose verb reads but whose table does not (an interpolated target,
        // a function in FROM) still describes a real operation; Cypher stays all-or-nothing.
        const parsed = q ? (matcher.dialect === 'cypher' ? parseCypherOp(q) : parseSqlStatement(q)) : undefined;
        if (parsed?.entity) {
          this.pushDbOp(callerId, parsed.op, site, `${parsed.entity}:${site.loc.startLine}`, parsed.entity);
          continue;
        }
        // No readable target: the call site IS a db-op surface (that is what the matcher
        // declared), so dropping it hides the surface entirely. Emit it marked — but only
        // where the profile asked for it, since a fragment-composing builder would flood.
        if (!matcher.emitUnresolved) continue;
        const marked = markUnresolved(arg?.text ?? site.calleeText);
        this.pushDbOp(callerId, parsed?.op ?? 'query', site, `${marked}:${site.loc.startLine}`, marked);
      }
    }
  }

  private pushDbOp(callerId: string, op: DbOperationType, site: CallSite, idKey: string, entityName: string): void {
    const idGen = this.substrate.idGen;
    const entityId = !isSentinelEntityName(entityName) ? this.entityIdByName.get(entityName) : undefined;
    const exprText = site.calleeText;
    const id = idGen.dbOperationId(callerId, idKey, op, String(site.loc.startLine));
    this.dbOpBoundById.set(id, entityId !== undefined);
    this.dbOps.push({
      id,
      versionedId: idGen.versionedId(id, exprText),
      performerId: callerId,
      ...(entityId ? { entityId } : {}),
      entityName,
      operation: op,
      details: exprText.slice(0, 200),
      location: site.loc,
    });
  }

  // ── external calls ───────────────────────────────────────────────────────────

  private extractExternalCalls(): void {
    const matchers = this.profile.externalCalls ?? [];
    for (const fact of this.substrate.externalCalls(matchers)) {
      const idGen = this.substrate.idGen;
      const id = idGen.generateNodeId(
        'external-call' as Parameters<typeof idGen.generateNodeId>[0],
        fact.callerId,
        fact.method,
        String(fact.location.startLine),
      );
      const edge: ExternalCallEdge = {
        id,
        versionedId: idGen.versionedId(
          id,
          `${fact.serviceName}.${fact.method}${fact.messaging?.destinationValue ? `:${fact.messaging.destinationValue}` : ''}`,
        ),
        callerId: fact.callerId,
        serviceName: fact.serviceName,
        sdkName: fact.sdkName,
        method: fact.method,
        location: fact.location,
      };
      if (fact.moniker) edge.moniker = fact.moniker;
      if (fact.dispatchMethod) edge.dispatchMethod = fact.dispatchMethod;
      if (fact.http) {
        // A config-driven service selector (CONFIG.<token> / entrypoints.<token>) sets
        // `targetService` on the fact — carry it onto the http descriptor so the linker
        // scopes the protocol hop to the right repo. Absent when no selector matched.
        // The absolute URL, when the host resolved from an in-repo const — the descriptor
        // carries only the path, so this is where the resolved host survives.
        if (fact.targetPattern) edge.targetPattern = fact.targetPattern;
        edge.targetDescriptor = {
          protocol: 'http',
          http: fact.http as never,
          ...(fact.targetService ? { targetService: fact.targetService } : {}),
        };
      } else if (fact.messaging !== undefined) {
        edge.targetPattern = fact.messaging.destinationValue ?? fact.messaging.destination;
        edge.targetDescriptor = {
          protocol: 'messaging',
          messaging: {
            system: fact.messaging.system,
            destination: fact.messaging.destination,
            ...(fact.messaging.destinationValue ? { destinationValue: fact.messaging.destinationValue } : {}),
          },
        };
      } else if (fact.protocol === 'http' || fact.protocol === 'grpc') {
        // Registry SDK egress (`loadStripe`, `new OpenAI()`) — path-less http/grpc with a
        // target-service hint (mirrors the ts-morph base parser's SDK_PACKAGES edge).
        edge.targetDescriptor = { protocol: fact.protocol, targetService: fact.targetService };
      } else if (fact.protocol === 'messaging') {
        // Path-less messaging egress (e.g. a client's close/connect) — protocol-only.
        edge.targetDescriptor = { protocol: 'messaging' };
      }
      // protocol === 'sdk' (Sentry) carries no targetDescriptor, matching ts-morph.
      this.externals.push(edge);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private enclosingFnId(site: CallSite): string | undefined {
    // Map a call site to its enclosing function/method id by line containment.
    // The substrate's internalCalls already carry callerIds keyed by site; reuse the
    // class/method index instead by finding the class/method whose span contains the call.
    for (const c of this.substrate.classes()) {
      if (c.loc.filePath !== site.file) continue;
      for (const m of c.methods) {
        if (m.loc.startLine <= site.loc.startLine && site.loc.startLine <= m.loc.endLine) {
          return this.substrate.idGen.methodId(site.file, c.name, m.name);
        }
      }
    }
    for (const f of this.substrate.functions()) {
      if (f.loc.filePath !== site.file) continue;
      if (f.loc.startLine <= site.loc.startLine && site.loc.startLine <= f.loc.endLine) {
        return this.substrate.functionId(site.file, f.name);
      }
    }
    return undefined;
  }

  private diClassFor(file: string, propName: string): string | undefined {
    for (const c of this.substrate.classes()) {
      if (c.loc.filePath !== file) continue;
      const p = c.ctorParams.find((cp) => cp.name === propName);
      if (p?.type) {
        return this.profile.di?.stripGenerics ? p.type.replace(/<.*>/, '').trim() : p.type.trim();
      }
    }
    return undefined;
  }

  private hasDecorator(c: SubstrateClass, name: string): boolean {
    return c.decorators.some((d) => decoName(d) === name);
  }
  private findDecorator(c: SubstrateClass, name: string): string | undefined {
    return c.decorators.find((d) => decoName(d) === name);
  }

  private readArgIdentifier(arg: ArgNode | undefined): string | undefined {
    if (!arg) return undefined;
    if (arg.identifier) return arg.identifier;
    if (arg.memberProperty) return arg.memberProperty;
    if (arg.stringLiteral !== undefined) return arg.stringLiteral;
    return undefined;
  }

  private resolveTableName(name: string, rule: ConventionEntityRule, dec: string | undefined): string {
    const opt = dec && rule.tableName?.option ? optionString(dec, rule.tableName.option) : undefined;
    if (opt) return opt;
    if (rule.tableName?.fallback === 'verbatim') return name;
    return snakeCase(name);
  }
}

/**
 * The receiver families a db-op site matched, derived once per site. Both the BR-4 scope
 * observation and the entity-binding branches read them.
 */
interface DbOpReceiverFamilies {
  isModel: boolean;
  isTransactionReceiver: boolean;
  isEm: boolean;
  isRepo: boolean;
  repoEntity: string | undefined;
  diClass: string | undefined;
}

/**
 * The language-neutral call-resolution record for a TS/JS parse (spec BR-1/BR-2/LIM-6).
 *
 * All three counters count call SITES, never facts: the structural and the SCIP layer can each
 * produce a `CallEdgeFact` for one site, and they do NOT share an edge id (the structural id is
 * minted from the call-expression text, the SCIP one from the moniker), so the site key is
 * `callerId|filePath:startLine|calleeExpression` — `SubstrateLoc` carries no column.
 *
 * Uncounted by construction (LIM-6): a site whose caller is outside the profile's scope, and a
 * site the SCIP/structural layer produced no call fact for. Built-in-dropped sites ARE counted,
 * because that drop happens after `internalCalls()`.
 *
 * A site is resolved when an EMITTED edge for it carries a `calleeId` — read back from the graph,
 * never from a loop counter, since `addCall` ignores a duplicate id and re-parented edges re-mint
 * theirs (hence `emittedIdsBySite`, filled where the fact and its emitted id are both in hand).
 */
function callSiteKey(callerId: string, loc: SubstrateLoc, calleeExpression: string): string {
  return `${callerId}|${loc.filePath}:${loc.startLine}|${calleeExpression}`;
}

function callResolutionOf(
  sites: readonly CallEdgeFact[],
  g: CodeGraph,
  emittedIdsBySite: ReadonlyMap<string, string[]>,
): CallResolutionStats {
  const declared = new Set<string>();
  for (const fn of g.functions.values()) declared.add(fn.name);

  const expressionBySite = new Map<string, string>();
  for (const site of sites)
    expressionBySite.set(callSiteKey(site.callerId, site.location, site.calleeExpression), site.calleeExpression);

  const resolved = new Set<string>();
  for (const [key, ids] of emittedIdsBySite) if (ids.some((id) => g.calls.get(id)?.calleeId)) resolved.add(key);

  let outOfScopeCalls = 0;
  for (const [key, calleeExpression] of expressionBySite) {
    if (resolved.has(key)) continue;
    // BR-1: the bare callee name (`log` in `console.log`). Declared here ⇒ the site stays in
    // scope and, unbound, counts against the extractor — the rate never flatters.
    const tail = /([A-Za-z_$][\w$]*)\s*$/.exec(calleeExpression)?.[1];
    if (tail && !declared.has(tail)) outOfScopeCalls++;
  }
  return { callSites: expressionBySite.size, resolvedCalls: resolved.size, outOfScopeCalls };
}
