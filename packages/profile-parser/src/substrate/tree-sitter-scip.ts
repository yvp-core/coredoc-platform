/**
 * tree-sitter+SCIP Substrate implementation.
 *
 * Facts are sourced from:
 *   - tree-sitter structural output (classes/methods/properties/decorators/
 *     ctorParams/functions) — from buildBaseline's `structuralFiles`.
 *   - RAW tree-sitter CST (re-parsed here) — for the nesting-aware, structured-arg
 *     call-shape query the StructuralCall abstraction cannot express.
 *   - the SCIP semantic graph (`graph.calls` / `graph.externalCalls`) — for
 *     internal call edges and external egress, with three fixes applied:
 *       1. SCOPE: every fact filtered to the profile include/exclude globs (else
 *          demo-core's bundled `.yarn` JS inflates functions 628→4536, calls, etc.).
 *       2. EXTERNAL ALLOW-LIST: SCIP externals are a broad cross-package superset
 *          (9121 / 3085); filter to curated egress via the profile matchers.
 *       3. DI CORRECTION: SCIP misresolves `this.svc.method()` to the CONSTRUCTOR
 *          (it follows the receiver TYPE). A ctorParams-based DI map resolves the
 *          member-chain call to the right METHOD instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { TreeSitterLoader } from '../tree-sitter/tree-sitter-loader.js';
import type { StableIdGenerator } from '@coredoc/core';
import { releaseParsedTree } from '../tree-sitter/tree-release.js';
import type { CallProvenance, TypeInfo } from '@coredoc/core/types';
import type { BaselineResult, LoadedScip } from '../facts/index.js';
import { buildMappingHooks, decodeRange, isDefinition, packageSymbolKey, parseMoniker } from '../facts/index.js';
import { lookupSdkByPackage } from '@coredoc/core/base-parser/sdk-registry';
import type { StructuralCall, StructuralFile } from '../facts/index.js';
import type { Node as TsNode } from 'web-tree-sitter';
import type {
  ExternalClientMatcher,
  ImportResolution,
  RouteRule,
  StateStoreBuilders,
  StateStoreRule,
} from '../types.js';
import { globMatches } from './glob.js';
import { regexFromSource, requirePathToRel } from './regex-util.js';
import { text, unquote } from './scip/ts-text.js';
import { calleeName, calleeTail, lineAt, routeFileInScope } from './scip/call-shapes.js';
import { type RecordTableHost, recordTableRouteSites } from './scip/record-table-routes.js';
import {
  buildBareImports,
  egressTraversableCaller,
  externalReceiverMatches,
  importNameToModule,
  importedSdkSegment,
  matchRegistrySdk,
  moduleMatchesProvenance,
} from './scip/external-matchers.js';
import { reactAdminRouteSites } from './frameworks/react-admin.js';
import { vueTemplateTags } from './frameworks/vue-template.js';
import { extractVueScript, vueComponentName } from '../facts/structural/vue-sfc.js';
import { type ImportedName, importedNames, resolveHeritageName } from '../facts/structural/hierarchy-ref-identity.js';
import {
  DeclKind,
  type SymbolIdentityResolver,
  createSymbolIdentityResolver,
} from '../facts/structural/symbol-ref-identity.js';
import type { StructuralLocalBinding, StructuralParam } from '../facts/structural/ts-structural.js';
import {
  bareStringMethodName,
  bareStringVerb,
  fetchMethodFromOpts,
  inlineConstInterpolations,
  resolveHttpMethodArg,
  resolveHttpUrl,
  resolveQueueTopicReference,
  resolveServiceSelector,
  routePathFromUrl,
} from './scip/url-topic-helpers.js';
import type {
  ArgNode,
  CallEdgeFact,
  CallSite,
  ComponentSite,
  ExternalCallFact,
  JsxTag,
  RouteSite,
  StateStoreSite,
  Substrate,
  SubstrateClass,
  SubstrateFunction,
  SubstrateLoc,
  VueSubstrate,
} from './interface.js';

// ── re-exports (preserve the public surface tests import from this module) ────
export { regexFromSource, requirePathToRel } from './regex-util.js';
export { calleeName, calleeTail, lineAt, routeFileInScope } from './scip/call-shapes.js';
export {
  buildBareImports,
  egressTraversableCaller,
  externalReceiverMatches,
  importNameToModule,
  importedSdkSegment,
  matchRegistrySdk,
  moduleMatchesProvenance,
} from './scip/external-matchers.js';
export {
  bareStringMethodName,
  bareStringVerb,
  fetchMethodFromOpts,
  inlineConstInterpolations,
  resolveHttpMethodArg,
  resolveHttpUrl,
  resolveQueueTopic,
  resolveQueueTopicReference,
  resolveServiceSelector,
  routePathFromUrl,
  templateTailRoute,
} from './scip/url-topic-helpers.js';

/** Barrel chains are shallow by construction; a deeper walk is a cycle or a mistake. */
const MAX_REEXPORT_HOPS = 5;

export interface SubstrateScope {
  include: string[];
  exclude: string[];
}

export interface BuildSubstrateOptions {
  repoRoot: string;
  scope: SubstrateScope;
  /** constructor-type DI: build a param→type map per file (default true). */
  di?: boolean;
  stripGenerics?: boolean;
  language?: 'typescript' | 'javascript';
  /** Accessor-hook names from the profile's `callGraph.accessorHooks` (empty/absent = off). */
  accessorHooks?: string[];
}

/** A destructured `await import()` binding, resolved to the node it names, with its live span. */
interface DynamicImportAlias {
  file: string;
  startLine: number;
  endLine: number;
  localName: string;
  calleeId: string;
}

/** A destructured accessor-hook binding, resolved to the node it names, with its live span. */
interface AccessorHookBinding {
  file: string;
  startLine: number;
  endLine: number;
  localName: string;
  calleeId: string;
}

/**
 * Bound names of an `object_pattern` as (property, local) pairs. A shorthand binding is
 * both; `{ a: b }` binds property `a` to local `b`. A nested pattern (`{ a: { b } }`) names
 * no single local and is skipped rather than guessed at.
 */
/** Innermost span containing `line` (largest start), from a per-file span list. */
function innermostSpan(
  spans: { startLine: number; endLine: number }[],
  line: number,
): { startLine: number; endLine: number } | undefined {
  let best: { startLine: number; endLine: number } | undefined;
  for (const s of spans) {
    if (s.startLine > line || s.endLine < line) continue;
    if (!best || s.startLine > best.startLine) best = s;
  }
  return best;
}

/**
 * Identity of the function/method a call site sits in, as one map key. A method is keyed by its
 * class as well as its name, so two classes in one file declaring the same method name stay
 * distinct — the same reason the dispatch tier derives its callee id from the class's own file+name.
 */
function enclosingKey(kind: string | undefined, className: string | undefined, name: string): string {
  return `${kind ?? ''}|${className ?? ''}|${name}`;
}

function objectPatternBindings(pattern: TsNode): { propertyName: string; localName: string }[] {
  const out: { propertyName: string; localName: string }[] = [];
  for (const c of pattern.namedChildren) {
    if (c.type === 'shorthand_property_identifier_pattern') {
      out.push({ propertyName: text(c), localName: text(c) });
      continue;
    }
    if (c.type !== 'pair_pattern') continue;
    const key = c.childForFieldName('key');
    const val = c.childForFieldName('value');
    if (key && val?.type === 'identifier') out.push({ propertyName: text(key), localName: text(val) });
  }
  return out;
}

export class TreeSitterScipSubstrate implements Substrate, VueSubstrate {
  readonly idGen: StableIdGenerator;
  private readonly scopedFiles: StructuralFile[];
  private readonly baseline: BaselineResult;
  private readonly opts: BuildSubstrateOptions;

  // Parsed raw-CST roots, lazily filled by callShapes/resolveConst.
  private readonly cstRoots = new Map<string, TsNode>();
  // Raw source text per scoped file (for text-regex route extraction + line mapping).
  private readonly cstSource = new Map<string, string>();
  // Raw (unblanked) SFC text per scoped `.vue` file — the `<template>` tag scan needs it.
  private readonly vueSource = new Map<string, string>();
  private cstParsed = false;

  // DI map: filePath -> (ctor param name -> ClassName).
  private readonly diMap = new Map<string, Map<string, string>>();
  // DI provenance: filePath -> (ctor param name -> module its type is imported from).
  private readonly diImportModule = new Map<string, Map<string, string>>();
  // method id index: className -> (methodName -> methodId).
  private readonly methodsByClass = new Map<string, Map<string, string>>();
  // function id index: filePath -> Set(name).
  private readonly fnNamesByFile = new Map<string, Set<string>>();

  // ── SCIP indexes for JSX componentId resolution (built lazily on first use) ──
  // symbol → definition location (file, 1-based line). A JSX tag's reference
  // occurrence resolves to a symbol; the symbol's definition names the decl file.
  private scipDefLoc: Map<string, { file: string; line: number }> | undefined;
  // file → reference occurrences (symbol + 0-based start line/char), for tag lookup.
  private scipRefsByFile:
    | Map<string, { symbol: string; line: number; startChar: number; endChar: number }[]>
    | undefined;
  // declared PascalCase top-level names per file (to pick the declared component name).
  private declaredNamesByFile: Map<string, Set<string>> | undefined;
  // filePath → the declared name behind that file's `export default` (HOC-peeled).
  private defaultExportName: Map<string, string> | undefined;
  // Same, read WITHOUT the PascalCase bias — the API-handler lane (`export default handler`).
  private defaultExportNameAnyCase: Map<string, string> | undefined;
  // Destructured `await import()` bindings → the node they name (built lazily on first use).
  private dynamicImportAliases: DynamicImportAlias[] | undefined;
  // Destructured accessor-hook bindings → the node they name, as file → local name →
  // bindings (built lazily on first use; a file with no binding is absent, which is the
  // skip gate the per-call-site scan needs).
  private accessorHookBindings: Map<string, Map<string, AccessorHookBinding[]>> | undefined;
  // file → names DECLARED in it (CST bindings), for the barrel hop's stop condition.
  private readonly declaredBindingsByFile = new Map<string, Set<string>>();
  // `file::name` → barrel-hop answer, memoized (a barrel is asked for hundreds of names).
  private readonly reExportHopMemo = new Map<string, { filePath: string; declaredName: string } | undefined>();
  // `<config>|fromFile|specifier` → resolved repo-relative file (the ext probe hits the filesystem).
  private readonly specifierMemo = new Map<string, string | undefined>();
  // Identity of each ImportResolution config seen, so the specifier memo can key on it.
  private readonly importConfigIds = new Map<ImportResolution, string>();
  // file → its `import_statement` nodes (tag resolution asks per tag, not per file).
  private readonly importStatementsByFile = new Map<string, TsNode[]>();
  // path → scoped StructuralFile (built lazily; the linear scan it replaces ran per tag).
  private structuralByPath: Map<string, StructuralFile> | undefined;
  // Module-graph identity resolver for interface-dispatch binding. Built in `create()` (it is
  // async) and ONLY when some scoped class declares a bound `implements` clause — with no
  // implements relation in the parse the pass can never bind, so the index is not worth building.
  private symbolResolver: SymbolIdentityResolver | undefined;
  // interface node id → ids of the SCOPED classes declaring `implements` it (built lazily).
  private implementorsByInterface: Map<string, string[]> | undefined;
  private unboundImplementorNames: Set<string> | undefined;
  // ── per-file indexes for the interface-dispatch tier (lazy, one entry per touched file) ──
  // The tier runs inside the `internalCalls` loop — once per call edge in the repo — and every
  // lookup in it used to be a linear scan of the file's bindings, classes+methods and functions,
  // which is quadratic in file size on the parse hot path. Same lazy shape as `structuralByPath`.
  // file → binding name → its bindings (a name can be bound in several sibling scopes).
  private readonly localBindingsByFile = new Map<string, Map<string, StructuralLocalBinding[]>>();
  // file → `<kind>|<class>|<name>` → that method's/function's parameters.
  private readonly paramsByEnclosing = new Map<string, Map<string, StructuralParam[]>>();
  // file → local name → the name+module it is imported from (hoisted, as hierarchy-ref-identity
  // already does per file — `interfaceIdForName` rebuilt it on every single call).
  private readonly importedNamesByFile = new Map<string, Map<string, ImportedName>>();

  private constructor(baseline: BaselineResult, scopedFiles: StructuralFile[], opts: BuildSubstrateOptions) {
    this.baseline = baseline;
    this.scopedFiles = scopedFiles;
    this.opts = opts;
    this.idGen = baseline.idGen;
    this.buildIndexes();
  }

  /**
   * Re-parse all scoped files' raw CST up front (async). callShapes/resolveConst
   * then run synchronously. Must be awaited before those are used.
   */
  static async create(baseline: BaselineResult, opts: BuildSubstrateOptions): Promise<TreeSitterScipSubstrate> {
    const scoped = baseline.structuralFiles.filter((f) => globMatches(f.path, opts.scope.include, opts.scope.exclude));
    const sub = new TreeSitterScipSubstrate(baseline, scoped, opts);
    // Until `sub` is RETURNED no caller can reach `dispose()`, so a throw in either step would
    // strand every tree `parseCst` already built — permanently, since web-tree-sitter never GCs
    // them. `prepareInterfaceDispatch` does tsconfig + package.json IO and can genuinely throw,
    // and a multi-target run compounds the loss per target.
    try {
      await sub.parseCst();
      await sub.prepareInterfaceDispatch();
    } catch (err) {
      sub.dispose();
      throw err;
    }
    return sub;
  }

  /**
   * Build the module-graph identity resolver the interface-dispatch binding needs, but only when
   * the parse actually has an implements relation to bind through (`resolveHierarchyRefIdentity`
   * has already run at this point, so a bound clause is visible here). Async, hence its own step
   * next to `parseCst`; `internalCalls` then runs synchronously.
   */
  private async prepareInterfaceDispatch(): Promise<void> {
    const scopedPaths = new Set(this.scopedFiles.map((f) => f.path));
    const hasBoundImplements = [...this.baseline.graph.classes.values()].some(
      (c) => scopedPaths.has(c.location.filePath) && c.implements?.some((i) => i.resolvedId),
    );
    if (!hasBoundImplements) return;
    // Reuse the parse's own resolver: it was built over these exact `structuralFiles` and its
    // specifier/identity memos are already warm from the three reference passes. A fresh one here
    // would re-read every manifest, re-load the TypeScript compiler for the tsconfig walk and
    // re-walk every barrel chain from empty. Absent only on a hand-built baseline (tests).
    this.symbolResolver =
      this.baseline.identityResolver ??
      (await createSymbolIdentityResolver(this.baseline.structuralFiles, {
        repoRoot: this.opts.repoRoot,
        workspacePackageNames: this.baseline.workspacePackageNames ?? [],
      }));
  }

  private async parseCst(): Promise<void> {
    const loader = TreeSitterLoader.getInstance();
    for (const f of this.scopedFiles) {
      const langName = f.language === 'typescript' ? (f.path.endsWith('.tsx') ? 'tsx' : 'typescript') : 'javascript';
      const parser = await loader.getParser(langName);
      let source: string;
      try {
        source = readFileSync(join(this.opts.repoRoot, f.path), 'utf8');
      } catch {
        continue;
      }
      // A `.vue` file is SFC markup: parsing it raw with the TS grammar yields a garbage CST.
      // Parse its script block instead (blanked outside, so lines/columns still match the file);
      // the raw SFC text is kept separately for the `<template>` tag scan.
      if (f.path.endsWith('.vue')) {
        this.vueSource.set(f.path, source);
        source = extractVueScript(source).script;
      }
      this.cstRoots.set(f.path, parser.parse(source).rootNode);
      this.cstSource.set(f.path, source);
    }
    this.cstParsed = true;
  }

  /**
   * Free every retained WASM-side tree. Call once the engine has produced its `ParsedRepo`
   * (which holds only plain data) — after this the substrate's CST-reading methods must not
   * be used again.
   *
   * The whole-run CST retention above is deliberate: record-table routes, barrel hops and the
   * component/route scans all re-read roots across passes. But web-tree-sitter never
   * garbage-collects trees and its Emscripten heap is hard-capped at 2GB, so holding one tree
   * per file until process exit is what aborts large monorepos with `Aborted()`.
   */
  dispose(): void {
    for (const root of this.cstRoots.values()) releaseParsedTree(root);
    this.cstRoots.clear();
    this.cstSource.clear();
    this.vueSource.clear();
    this.localBindingsByFile.clear();
    this.paramsByEnclosing.clear();
    this.importedNamesByFile.clear();
    this.cstParsed = false;
  }

  private buildIndexes(): void {
    const di = this.opts.di !== false;
    for (const f of this.scopedFiles) {
      // function names
      const fnSet = this.fnNamesByFile.get(f.path) ?? new Set<string>();
      for (const fn of f.functions) fnSet.add(fn.name);
      this.fnNamesByFile.set(f.path, fnSet);

      for (const c of f.classes) {
        // method id index
        const mmap = this.methodsByClass.get(c.name) ?? new Map<string, string>();
        for (const m of c.methods) mmap.set(m.name, this.idGen.methodId(f.path, c.name, m.name));
        this.methodsByClass.set(c.name, mmap);

        // DI map from ctorParams
        if (di && c.ctorParams.length) {
          const fileMap = this.diMap.get(f.path) ?? new Map<string, string>();
          const importByName = importNameToModule(f);
          let provMap = this.diImportModule.get(f.path);
          for (const p of c.ctorParams) {
            if (!p.type) continue;
            const cleaned = this.opts.stripGenerics ? p.type.replace(/<.*>/, '').trim() : p.type.trim();
            fileMap.set(p.name, cleaned);
            // Provenance: the type's root identifier → its import module specifier.
            const typeRoot = cleaned.split(/[.<\s]/)[0];
            const mod = importByName.get(typeRoot);
            if (mod) {
              if (!provMap) {
                provMap = new Map<string, string>();
                this.diImportModule.set(f.path, provMap);
              }
              provMap.set(p.name, mod);
            }
          }
          this.diMap.set(f.path, fileMap);
        }
      }
    }
  }

  // ── plain structural facts ─────────────────────────────────────────────────

  files(): { relativePath: string }[] {
    return this.scopedFiles.map((f) => ({ relativePath: f.path }));
  }

  classes(): SubstrateClass[] {
    const out: SubstrateClass[] = [];
    for (const f of this.scopedFiles) {
      for (const c of f.classes) {
        out.push({
          name: c.name,
          decorators: c.decorators,
          ctorParams: c.ctorParams.map((p) => ({ name: p.name, type: p.type })),
          methods: c.methods.map((m) => ({
            name: m.name,
            decorators: m.decorators,
            params: m.params.map((p) => ({ name: p.name, type: p.type })),
            isStatic: m.isStatic,
            visibility: m.visibility,
            loc: { filePath: f.path, startLine: m.startLine, endLine: m.endLine },
          })),
          properties: c.properties.map((p) => ({
            name: p.name,
            decorators: p.decorators,
            type: p.type,
            loc: { filePath: f.path, startLine: p.startLine, endLine: p.endLine },
          })),
          extendsClass: c.extendsClass,
          loc: { filePath: f.path, startLine: c.startLine, endLine: c.endLine },
        });
      }
    }
    return out;
  }

  functions(): SubstrateFunction[] {
    const out: SubstrateFunction[] = [];
    for (const f of this.scopedFiles) {
      for (const fn of f.functions) {
        out.push({
          name: fn.name,
          isExported: fn.isExported,
          loc: { filePath: f.path, startLine: fn.startLine, endLine: fn.endLine },
        });
      }
    }
    return out;
  }

  hasFunctionId(id: string): boolean {
    return this.baseline.graph.functions.has(id);
  }

  resolveMethodOnClass(className: string, methodName: string): string | undefined {
    return this.methodsByClass.get(className)?.get(methodName);
  }

  functionId(filePath: string, name: string): string | undefined {
    if (this.fnNamesByFile.get(filePath)?.has(name)) return this.idGen.functionId(filePath, name);
    return undefined;
  }

  // ── RAW-CST call-shape query ───────────────────────────────────────────────

  resolveConst(ident: string, file: string): string | undefined {
    return this.baseline.resolver.resolve(ident, file);
  }

  /**
   * Inline `${IDENT}` interpolations that resolve to a string `const` into a raw
   * URL/template argument BEFORE route extraction.
   *
   * `templateTailRoute` treats a LEADING `${…}` interpolation as the runtime
   * config host and drops it (`${this.entrypoints.x.url}/path` → `/path`). That
   * is correct for a host, but wrong for a local route-prefix const:
   * `const BASE = '/vacation_policies/companies'` used as `` `${BASE}/${id}` ``
   * would lose its prefix and collapse to an all-param path that mis-resolves.
   * Inlining the const here turns `${BASE}` into the literal first, so the route
   * is literal-led and survives intact.
   *
   * Only BARE-identifier interpolations are considered — member expressions
   * (`${CONFIG.x.url}`, `${this.entrypoints.y.url}`) contain a `.`, don't match,
   * and remain droppable hosts. Param identifiers (`${companyUuid}`) and
   * runtime-valued consts don't resolve to a string const, so they are left as
   * `${ident}` and normalized/dropped downstream exactly as before.
   */
  inlineStringConstInterpolations(raw: string | undefined, file: string): string | undefined {
    return inlineConstInterpolations(raw, (ident) => this.resolveConst(ident, file));
  }

  /**
   * Value of a class string FIELD `<prop> = '<literal>'` in `file`, e.g.
   * `private readonly apiBase = 'https://api.turso.tech/v1'`. Used to inline a
   * `${this.<prop>}` host interpolation for the bareCallee `urlPattern` discriminator
   * (see {@link inlineUrlHostsForMatch}). undefined when the field is absent or its
   * initializer is not a plain string literal.
   */
  resolveClassStringProp(prop: string, file: string): string | undefined {
    const root = this.cstRoots.get(file);
    if (!root) return undefined;
    let found: string | undefined;
    const walk = (n: TsNode): void => {
      if (n.type === 'public_field_definition' && text(n.childForFieldName('name')) === prop) {
        const v = n.childForFieldName('value');
        if (v?.type === 'string') found = unquote(text(v));
      }
      if (found === undefined) for (const c of n.namedChildren) walk(c);
    };
    walk(root);
    return found;
  }

  /**
   * A URL argument with every `${…}` interpolation the parser can resolve to a
   * string inlined — module const (`${BASE}`), `Obj.MEMBER` const, or `this.<prop>`
   * class string field (`${this.apiBase}`). This exposes the concrete host so the
   * bareCallee `urlPattern` discriminator can match on it. Unresolvable
   * interpolations (path params, runtime values) are left verbatim.
   *
   * Match-ONLY: this is never fed to route extraction, which must keep a leading
   * `${this.apiBase}` droppable so `templateTailRoute` yields the route tail.
   */
  private inlineUrlHostsForMatch(raw: string | undefined, file: string): string | undefined {
    if (raw === undefined) return undefined;
    return raw.replace(/\$\{([^}]+)\}/g, (full, expr) => {
      const ref = String(expr).trim();
      let v: string | undefined;
      if (ref.startsWith('this.')) v = this.resolveClassStringProp(ref.slice('this.'.length), file);
      else if (ref.includes('.')) v = this.resolveConstMember(ref);
      else v = this.resolveConst(ref, file);
      return typeof v === 'string' && v.length > 0 ? v : full;
    });
  }

  // `Obj.MEMBER` → string value, built lazily across all scoped const-object literals.
  private constMemberMapMemo?: Map<string, string>;
  resolveConstMember(qualifiedRef: string): string | undefined {
    const dot = qualifiedRef.indexOf('.');
    if (dot < 0) return undefined;
    if (!this.constMemberMapMemo) {
      const map = new Map<string, string>();
      const visit = (objName: string, obj: TsNode): void => {
        for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
          const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
          const v = pair.childForFieldName('value');
          if (key && v?.type === 'string') map.set(`${objName}.${key}`, unquote(text(v)));
        }
      };
      const walk = (n: TsNode): void => {
        if (n.type === 'variable_declarator') {
          const name = text(n.childForFieldName('name'));
          // Unwrap `{…} as const` / `{…} satisfies T` so the inner object is reached.
          let v = n.childForFieldName('value');
          while (v && (v.type === 'as_expression' || v.type === 'satisfies_expression')) {
            v = v.namedChildren[0];
          }
          if (name && v?.type === 'object') visit(name, v);
        }
        for (const c of n.namedChildren) walk(c);
      };
      for (const root of this.cstRoots.values()) walk(root);
      this.constMemberMapMemo = map;
    }
    return this.constMemberMapMemo.get(qualifiedRef);
  }

  requireRegistry(args: {
    registryVar: string;
    inFile: string;
    nested: boolean;
    requirePrefix: string;
  }): Map<string, string> {
    const map = new Map<string, string>();
    const root = this.cstRoots.get(args.inFile);
    if (!root) return map;
    let registryObj: TsNode | undefined;
    const find = (n: TsNode): void => {
      if (n.type === 'variable_declarator' && text(n.childForFieldName('name')) === args.registryVar) {
        const v = n.childForFieldName('value');
        if (v?.type === 'object') registryObj = v;
      }
      if (!registryObj) for (const c of n.namedChildren) find(c);
    };
    find(root);
    if (!registryObj) return map;
    const walk = (obj: TsNode, prefix: string): void => {
      for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
        const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
        const alias = prefix ? `${prefix}.${key}` : key;
        const v = pair.childForFieldName('value');
        if (!v) continue;
        if (args.nested && v.type === 'object') walk(v, alias);
        else {
          const file = requirePathToRel(text(v), args.requirePrefix);
          if (file) map.set(alias, file);
        }
      }
    };
    walk(registryObj, '');
    return map;
  }

  callShapes(calleePattern?: string): CallSite[] {
    if (!this.cstParsed) throw new Error('callShapes() before CST parse — use TreeSitterScipSubstrate.create()');
    const out: CallSite[] = [];
    for (const [file, root] of this.cstRoots) {
      this.collectCallSites(root, file, [], calleePattern, out);
    }
    return out;
  }

  /** Recursive walk that threads the enclosing-call chain (nesting-aware). */
  private collectCallSites(
    n: TsNode,
    file: string,
    chain: CallSite[],
    pattern: string | undefined,
    out: CallSite[],
  ): void {
    if (n.type === 'call_expression') {
      const site = this.toCallSite(n, file, chain);
      if (this.calleeMatches(site, pattern)) out.push(site);
      // descend into args/callee with this site appended to the chain.
      const nextChain = [...chain, site];
      for (const c of n.namedChildren) this.collectCallSites(c, file, nextChain, pattern, out);
      return;
    }
    for (const c of n.namedChildren) this.collectCallSites(c, file, chain, pattern, out);
  }

  private toCallSite(call: TsNode, file: string, chain: CallSite[]): CallSite {
    const fn = call.childForFieldName('function');
    let receiver: string | undefined;
    let method: string | undefined;
    let calleeText = '';
    if (fn?.type === 'member_expression') {
      receiver = text(fn.childForFieldName('object'));
      method = text(fn.childForFieldName('property'));
      calleeText = text(fn);
    } else if (fn) {
      method = text(fn);
      calleeText = text(fn);
    }
    const argsNode = call.childForFieldName('arguments');
    const args = (argsNode ? argsNode.namedChildren : []).map((a) => this.toArgNode(a));
    return {
      calleeText,
      receiver,
      method,
      args,
      assignedTo: this.chainAssignmentTarget(call),
      enclosingCallChain: chain,
      file,
      loc: { filePath: file, startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 },
    };
  }

  /**
   * The variable receiving the call chain's result (`CallSite.assignedTo`). Walk out of the
   * enclosing fluent wrappers — but only while this node IS the receiver/callee of the wrapper
   * (`x.command('a').description(…)`), never through argument position (`fn(x.command('a'))`
   * assigns fn's result, not the chain's) — then read the declarator / plain-assignment target.
   */
  private chainAssignmentTarget(call: TsNode): string | undefined {
    let node: TsNode = call;
    let p = node.parent;
    while (p) {
      if (p.type === 'member_expression' && p.childForFieldName('object')?.id === node.id) {
        node = p;
      } else if (p.type === 'call_expression' && p.childForFieldName('function')?.id === node.id) {
        node = p;
      } else {
        break;
      }
      p = node.parent;
    }
    if (p?.type === 'variable_declarator') {
      const name = p.childForFieldName('name');
      if (name?.type === 'identifier') return text(name);
    } else if (p?.type === 'assignment_expression') {
      const left = p.childForFieldName('left');
      if (left?.type === 'identifier') return text(left);
    }
    return undefined;
  }

  private toArgNode(a: TsNode): ArgNode {
    const node: ArgNode = { text: text(a) };
    if (a.type === 'string') node.stringLiteral = unquote(text(a));
    else if (a.type === 'identifier') node.identifier = text(a);
    else if (a.type === 'member_expression') node.memberProperty = text(a.childForFieldName('property'));
    else if (a.type === 'arrow_function') {
      const body = a.childForFieldName('body');
      if (body && /^[A-Za-z0-9_$]+$/.test(text(body).trim())) node.arrowTargetIdent = text(body).trim();
      else {
        const m = /=>\s*([A-Za-z0-9_$]+)\s*$/.exec(text(a));
        if (m) node.arrowTargetIdent = m[1];
      }
    } else if (a.type === 'object') {
      node.objectEntries = this.readObjectEntries(a);
    } else if (a.type === 'call_expression') {
      const fn = a.childForFieldName('function');
      const callee = text(fn);
      const argsNode = a.childForFieldName('arguments');
      const firstArg = argsNode?.namedChildren[0];
      if (fn && firstArg) {
        node.callExpr = { callee, firstArgText: text(firstArg) };
      }
    }
    return node;
  }

  private readObjectEntries(obj: TsNode): NonNullable<ArgNode['objectEntries']> {
    const entries: NonNullable<ArgNode['objectEntries']> = [];
    for (const pair of obj.namedChildren.filter((c) => c.type === 'pair')) {
      const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
      if (!key) continue;
      const v = pair.childForFieldName('value');
      entries.push({
        key,
        valueText: text(v),
        valueObject: v && v.type === 'object' ? this.readObjectEntries(v) : undefined,
      });
    }
    return entries;
  }

  private calleeMatches(site: CallSite, pattern: string | undefined): boolean {
    if (!pattern) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return site.receiver === prefix;
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return site.method === suffix;
    }
    return site.calleeText === pattern || site.method === pattern;
  }

  // ── Frontend: JSX component / render-edge RAW-CST query ──────────────────────

  componentSites(opts: { functionalInExtensions?: string[]; classComponents?: boolean }): ComponentSite[] {
    if (!this.cstParsed) throw new Error('componentSites() before CST parse — use create()');
    const out: ComponentSite[] = [];
    for (const [file, root] of this.cstRoots) {
      const ext = file.slice(file.lastIndexOf('.'));
      const fnAllowed = !opts.functionalInExtensions || opts.functionalInExtensions.includes(ext);
      this.collectComponentSites(root, file, fnAllowed, opts.classComponents === true, out);
    }
    return out;
  }

  // ── Frontend: Vue SFC components (one per scoped `.vue` file) ────────────────

  /**
   * Every scoped `.vue` file is definitionally one component, named after its file stem; its
   * children are the component tags in the `<template>` block. Kept separate from the JSX walk:
   * a template is markup with no CST, so it has its own (text-scan) site source.
   */
  vueComponentSites(): ComponentSite[] {
    if (!this.cstParsed) throw new Error('vueComponentSites() before CST parse — use create()');
    // Component names of every scoped `.vue` file — the set a kebab-case tag may name even
    // when the template's file does not import it explicitly (globally registered components).
    const vueNames = new Set<string>();
    for (const path of this.vueSource.keys()) vueNames.add(vueComponentName(path));

    const out: ComponentSite[] = [];
    for (const [file, source] of this.vueSource) {
      const known = new Set(vueNames);
      for (const imp of this.scopedFiles.find((f) => f.path === file)?.imports ?? []) {
        for (const n of imp.names) known.add(n.alias ?? n.name);
      }
      out.push({
        name: vueComponentName(file),
        file,
        componentType: 'functional',
        loc: { filePath: file, startLine: 1, endLine: source.split('\n').length },
        childTags: vueTemplateTags(source, known),
      });
    }
    return out;
  }

  /**
   * Resolve a Vue template tag to its declaring `.vue` file via the script block's imports.
   * SCIP never indexes `.vue`, so the import path is the only resolution available here.
   */
  resolveVueTagByImport(
    file: string,
    tagName: string,
    imports: ImportResolution,
  ): { filePath: string; declaredName: string } | undefined {
    const root = this.cstRoots.get(file);
    if (!root) return undefined;
    for (const imp of this.importStatements(file, root)) {
      const src = imp.childForFieldName('source');
      const specifier = src ? unquote(text(src)) : '';
      if (!specifier) continue;
      const binding = this.importBinding(imp, tagName);
      if (!binding) continue;
      const declFile = this.resolveSpecifier(specifier, file, imports);
      if (!declFile) return undefined; // resolved outside scope / not found
      return {
        filePath: declFile,
        declaredName: declFile.endsWith('.vue') ? vueComponentName(declFile) : binding.originalName,
      };
    }
    return undefined;
  }

  /** Walk the CST for PascalCase fn/arrow/class declarations that render JSX. */
  private collectComponentSites(
    root: TsNode,
    file: string,
    fnAllowed: boolean,
    classAllowed: boolean,
    out: ComponentSite[],
  ): void {
    const visit = (n: TsNode): void => {
      // class X extends (React.)Component/PureComponent
      if (classAllowed && n.type === 'class_declaration') {
        const name = text(n.childForFieldName('name'));
        const heritage = n.namedChildren.find((c) => c.type === 'class_heritage');
        if (name && /^[A-Z]/.test(name) && /\b(Pure)?Component\b/.test(text(heritage))) {
          out.push(this.makeComponentSite(name, file, 'class', n));
        }
      }
      // function Foo() { … <JSX/> … }
      if (fnAllowed && n.type === 'function_declaration') {
        const name = text(n.childForFieldName('name'));
        if (name && /^[A-Z]/.test(name) && this.subtreeHasJsx(n)) {
          out.push(this.makeComponentSite(name, file, 'functional', n));
        }
      }
      // const Foo = (…) => <JSX/> / function(){} / memo(...) / forwardRef(...)
      if (fnAllowed && n.type === 'variable_declarator') {
        const name = text(n.childForFieldName('name'));
        const value = n.childForFieldName('value');
        if (name && /^[A-Z]/.test(name) && value) {
          const fn = this.unwrapFnNode(value);
          if (fn && this.subtreeHasJsx(fn)) {
            out.push(this.makeComponentSite(name, file, 'functional', n));
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(root);
  }

  private makeComponentSite(name: string, file: string, type: 'functional' | 'class', node: TsNode): ComponentSite {
    return {
      name,
      file,
      componentType: type,
      loc: { filePath: file, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      childTags: this.collectJsxTags(node, file),
    };
  }

  /** Peel forwardRef/memo around an initializer to the inner fn/arrow. */
  private unwrapFnNode(node: TsNode): TsNode | undefined {
    if (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function') return node;
    if (node.type === 'call_expression') {
      const callee = text(node.childForFieldName('function'));
      if (/(^|\.)(forwardRef|memo)$/.test(callee)) {
        const argsNode = node.childForFieldName('arguments');
        for (const a of argsNode?.namedChildren ?? []) {
          if (a.type === 'arrow_function' || a.type === 'function_expression' || a.type === 'function') return a;
          if (a.type === 'call_expression') {
            const inner = this.unwrapFnNode(a);
            if (inner) return inner;
          }
        }
      }
    }
    return undefined;
  }

  private subtreeHasJsx(n: TsNode): boolean {
    let found = false;
    const walk = (x: TsNode): void => {
      if (found) return;
      if (x.type === 'jsx_element' || x.type === 'jsx_self_closing_element' || x.type === 'jsx_fragment') {
        found = true;
        return;
      }
      for (const c of x.namedChildren) walk(c);
    };
    walk(n);
    return found;
  }

  /** PascalCase JSX tags rendered in the body + RR `component=`/`render=` props. */
  private collectJsxTags(n: TsNode, _file: string): JsxTag[] {
    const tags: JsxTag[] = [];
    const seen = new Set<string>();
    const add = (name: string, line: number): void => {
      const root = name.split('.')[0];
      if (!/^[A-Z]/.test(root)) return;
      const key = `${root}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      tags.push({ name: root, line });
    };
    const walk = (x: TsNode): void => {
      if (x.type === 'jsx_opening_element' || x.type === 'jsx_self_closing_element') {
        const tagName = text(
          x.childForFieldName('name') ??
            x.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression'),
        );
        if (tagName) add(tagName, x.startPosition.row + 1);
        // RR v5 component={X} / render={() => <X/>} props.
        for (const attr of x.namedChildren.filter((c) => c.type === 'jsx_attribute')) {
          const attrName = text(attr.namedChildren[0]);
          if (attrName !== 'component' && attrName !== 'render') continue;
          const expr = attr.namedChildren.find((c) => c.type === 'jsx_expression');
          if (!expr) continue;
          // {X}
          const ident = expr.namedChildren.find((c) => c.type === 'identifier');
          if (ident && /^[A-Z]/.test(text(ident))) add(text(ident), attr.startPosition.row + 1);
          // render arrow body JSX
          for (const inner of [
            ...this.descendantsOfType(expr, 'jsx_self_closing_element'),
            ...this.descendantsOfType(expr, 'jsx_opening_element'),
          ]) {
            const n2 = text(inner.childForFieldName('name'));
            if (n2 && /^[A-Z]/.test(n2)) add(n2, attr.startPosition.row + 1);
          }
        }
      }
      for (const c of x.namedChildren) walk(c);
    };
    walk(n);
    return tags;
  }

  private descendantsOfType(n: TsNode, type: string): TsNode[] {
    const out: TsNode[] = [];
    const walk = (x: TsNode): void => {
      if (x.type === type) out.push(x);
      for (const c of x.namedChildren) walk(c);
    };
    walk(n);
    return out;
  }

  // ── Frontend: React-Router route + state-store RAW-CST queries ───────────────

  /**
   * Mirror the ts-morph engine's `collectRoutes`: config-array `{ path, component }`
   * entries and JSX `<Route path="…" component={X}/>` / `render={() => <X/>}` props,
   * scoped to `inPaths` (startsWith) + `inPathContains` (substring). We run the same
   * text regexes the ts-morph engine uses (route paths are read literally), and
   * compute the component reference line from the match offset so the componentId
   * resolves through the same SCIP path childComponents use.
   */
  routeSites(rule: RouteRule, imports?: ImportResolution): RouteSite[] {
    if (!this.cstParsed) throw new Error('routeSites() before CST parse — use create()');
    const out: RouteSite[] = [];
    for (const [file, text] of this.cstSource) {
      if (!routeFileInScope(file, rule)) continue;
      const seen = new Set<string>();
      const add = (path: string, componentName: string, idx: number): void => {
        const key = `${path}::${componentName}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ path, componentName, componentLine: lineAt(text, idx), file });
      };
      if (rule.configArray) {
        const fwd = /\bpath:\s*"([^"]+)"[^{}]*?\bcomponent:\s*(\w+)/g;
        for (let m = fwd.exec(text); m !== null; m = fwd.exec(text)) add(m[1], m[2], m.index + m[0].lastIndexOf(m[2]));
        const rev = /\bcomponent:\s*(\w+)[^{}]*?\bpath:\s*"([^"]+)"/g;
        for (let m = rev.exec(text); m !== null; m = rev.exec(text)) add(m[2], m[1], m.index + m[0].indexOf(m[1]));
        // CST pass over the same flag: an object literal carrying a string-valued `path`
        // and an identifier-valued `component` at ONE nesting level. The regexes above
        // require double quotes and no braces between the two keys, which misses
        // config-object route factories (TanStack `createRoute({ path: '/x',
        // beforeLoad: …, component: X })`); the CST read is quote-agnostic and survives
        // intervening function-valued props. `seen` dedups the overlap.
        const root = this.cstRoots.get(file);
        if (root) this.collectConfigObjectRoutes(root, add);
      }
      if (rule.componentProp || rule.renderProp) {
        const statFwd = /<Route[^<>]*path="([^"]+)"[^<>]*component=\{(\w+)\}/g;
        for (let m = statFwd.exec(text); m !== null; m = statFwd.exec(text))
          add(m[1], m[2], m.index + m[0].lastIndexOf(m[2]));
        const statRev = /<Route[^<>]*component=\{(\w+)\}[^<>]*path="([^"]+)"/g;
        for (let m = statRev.exec(text); m !== null; m = statRev.exec(text))
          add(m[2], m[1], m.index + m[0].indexOf(m[1]));
        const tplFwd = /<Route[^<>]*path=\{`\$\{[^}]+\}([^`]*)`\}[^<>]*component=\{(\w+)\}/g;
        for (let m = tplFwd.exec(text); m !== null; m = tplFwd.exec(text))
          add(`[base]${m[1].trim() || '/'}`, m[2], m.index + m[0].lastIndexOf(m[2]));
        const tplRev = /<Route[^<>]*component=\{(\w+)\}[^<>]*path=\{`\$\{[^}]+\}([^`]*)`\}/g;
        for (let m = tplRev.exec(text); m !== null; m = tplRev.exec(text))
          add(`[base]${m[2].trim() || '/'}`, m[1], m.index + m[0].indexOf(m[1]));
        // React-Router v6: <Route path="/x" element={<Comp/>} /> (path-first; static + template path).
        const elemFwd = /<Route[^<>]*path="([^"]+)"[^<>]*element=\{<([A-Z]\w*)/g;
        for (let m = elemFwd.exec(text); m !== null; m = elemFwd.exec(text))
          add(m[1], m[2], m.index + m[0].lastIndexOf(m[2]));
        const elemTpl = /<Route[^<>]*path=\{`\$\{[^}]+\}([^`]*)`\}[^<>]*element=\{<([A-Z]\w*)/g;
        for (let m = elemTpl.exec(text); m !== null; m = elemTpl.exec(text))
          add(`[base]${m[1].trim() || '/'}`, m[2], m.index + m[0].lastIndexOf(m[2]));
      }
      if (rule.renderProp) {
        const rendFwd = /<Route[^<>]*path="([^"]+)"[^<>]*render=\{[^}]*?<([A-Z]\w*)/g;
        for (let m = rendFwd.exec(text); m !== null; m = rendFwd.exec(text))
          add(m[1], m[2], m.index + m[0].lastIndexOf(m[2]));
        const rendTpl = /<Route[^<>]*path=\{`\$\{[^}]+\}([^`]*)`\}[^<>]*render=\{[^}]*?<([A-Z]\w*)/g;
        for (let m = rendTpl.exec(text); m !== null; m = rendTpl.exec(text))
          add(`[base]${m[1].trim() || '/'}`, m[2], m.index + m[0].lastIndexOf(m[2]));
      }
    }
    // Framework-specific route conventions are dispatched to self-contained extractors in
    // ./frameworks (kept out of this generic substrate). The substrate owns only the scoping.
    if (rule.reactAdminResources) {
      for (const [file, root] of this.cstRoots) {
        if (routeFileInScope(file, rule)) out.push(...reactAdminRouteSites(root, file));
      }
    }
    // Table-driven routes carry their own file scoping (the rule's globs) and resolve
    // the component module themselves, so they bypass `routeFileInScope` and the
    // engine's SCIP fallback chain alike.
    if (rule.recordTable?.length) {
      const host: RecordTableHost = {
        cstRoots: this.cstRoots,
        resolveSpecifier: (specifier, fromFile, imp) => this.resolveSpecifier(specifier, fromFile, imp),
        defaultExportedName: (file) => this.defaultExportedName(file),
      };
      for (const recordTable of rule.recordTable) {
        out.push(...recordTableRouteSites(host, recordTable, imports ?? {}));
      }
    }
    return out;
  }

  /** Object-literal route configs: `{ path: <string>, component: <Identifier> }` at one level. */
  private collectConfigObjectRoutes(
    root: TsNode,
    add: (path: string, componentName: string, idx: number) => void,
  ): void {
    const visit = (n: TsNode): void => {
      if (n.type === 'object') {
        let routePath: string | undefined;
        let component: TsNode | undefined;
        for (const pair of n.namedChildren) {
          if (pair.type !== 'pair') continue;
          const key = text(pair.childForFieldName('key')).replace(/['"]/g, '');
          const value = pair.childForFieldName('value');
          if (!value) continue;
          if (key === 'path' && value.type === 'string') routePath = unquote(text(value));
          else if (key === 'component' && value.type === 'identifier') component = value;
        }
        if (routePath !== undefined && component) add(routePath, text(component), component.startIndex);
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(root);
  }

  /**
   * Mirror the ts-morph engine's `extractStateStores`: an exported const bound to
   * a `<factory>(…)` (or `<factory><T>()(…)`) call, with the factory imported from
   * `fromModule`. Actions are object-literal keys with function values; selectors
   * are the rest.
   */
  stateStoreSites(rule: StateStoreRule): StateStoreSite[] {
    if (!this.cstParsed) throw new Error('stateStoreSites() before CST parse — use create()');
    const out: StateStoreSite[] = [];
    for (const [file, root] of this.cstRoots) {
      if (rule.inPaths && !rule.inPaths.some((p) => file.startsWith(p))) continue;
      if (rule.fromModule && !this.factoryImportedFrom(root, rule.factory, rule.fromModule)) continue;

      const visit = (n: TsNode): void => {
        if (n.type === 'variable_declarator') {
          const nameNode = n.childForFieldName('name');
          const storeName = text(nameNode);
          const value = n.childForFieldName('value');
          if (storeName && value) {
            const factoryCall = this.findStoreFactoryCall(value, rule.factory);
            if (factoryCall) {
              // Builder-array shape when declared and present; otherwise the state object.
              const { actions, selectors } =
                (rule.builders && this.storeBuilderMembers(factoryCall, rule.builders, file)) ??
                this.storeMembers(this.storeStateObject(factoryCall), file);
              out.push({
                storeName,
                file,
                loc: { filePath: file, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 },
                actions,
                selectors,
              });
            }
          }
        }
        for (const c of n.namedChildren) visit(c);
      };
      visit(root);
    }
    return out;
  }

  private factoryImportedFrom(root: TsNode, factory: string, fromModule: string): boolean {
    let found = false;
    const walk = (n: TsNode): void => {
      if (found) return;
      if (n.type === 'import_statement') {
        const src = n.childForFieldName('source');
        if (src && unquote(text(src)) === fromModule) {
          // default import or named import matching the factory name.
          const idents = this.descendantsOfType(n, 'identifier').map((i) => text(i));
          if (idents.includes(factory)) found = true;
        }
      }
      if (!found) for (const c of n.namedChildren) walk(c);
    };
    walk(root);
    return found;
  }

  /** `create(...)`, `create<T>(...)`, `create<T>()(initializer)`, or `x.create(...)`. */
  private findStoreFactoryCall(node: TsNode, factory: string): TsNode | undefined {
    if (node.type !== 'call_expression') return undefined;
    const fn = node.childForFieldName('function');
    if (!fn) return undefined;
    // `create<T>()(initializer)` — the inner expression is itself a call to create<T>().
    if (fn.type === 'call_expression') {
      const innerCallee = calleeName(fn);
      if (innerCallee === factory || innerCallee.endsWith(`.${factory}`)) return node;
    }
    const callee = calleeName(node);
    if (callee === factory || callee.endsWith(`.${factory}`)) return node;
    return undefined;
  }

  /** State-state argument: an object literal, or the `({…})` body of an initializer fn. */
  private storeStateObject(call: TsNode): TsNode | undefined {
    const argsNode = call.childForFieldName('arguments');
    for (const a of argsNode?.namedChildren ?? []) {
      const obj = this.objectFromStoreArg(a);
      if (obj) return obj;
    }
    return undefined;
  }

  private objectFromStoreArg(arg: TsNode): TsNode | undefined {
    if (arg.type === 'object') return arg;
    if (arg.type === 'arrow_function' || arg.type === 'function_expression' || arg.type === 'function') {
      const body = arg.childForFieldName('body');
      if (!body) return undefined;
      if (body.type === 'object') return body;
      // `(set,get) => ({…})` — parenthesized object.
      if (body.type === 'parenthesized_expression') {
        const inner = body.namedChildren.find((c) => c.type === 'object');
        if (inner) return inner;
      }
      const nested = this.descendantsOfType(body, 'object')[0];
      if (nested) return nested;
    }
    return undefined;
  }

  /**
   * Builder-array members: `factory([actionBuilder({…}), selectorBuilder({…})])`.
   * Each array element that is a call to a listed builder contributes the top-level
   * keys of its object-literal argument (read through `objectFromStoreArg`, so a
   * `(deps) => ({…})` builder body unwraps too). Value shape does not classify here —
   * the declared list does. Names are deduped per store, keeping the first location.
   * Returns undefined when the factory takes no array argument, so the caller falls
   * back to the state-object path.
   */
  private storeBuilderMembers(
    call: TsNode,
    builders: StateStoreBuilders,
    file: string,
  ): { actions: { name: string; loc: SubstrateLoc }[]; selectors: { name: string; loc: SubstrateLoc }[] } | undefined {
    const argsNode = call.childForFieldName('arguments');
    const array = argsNode?.namedChildren.find((a) => a.type === 'array');
    if (!array) return undefined;

    const actions = new Map<string, SubstrateLoc>();
    const selectors = new Map<string, SubstrateLoc>();
    for (const element of array.namedChildren) {
      if (element.type !== 'call_expression') continue;
      const callee = calleeName(element);
      const isAction = builders.actionBuilders.includes(callee);
      const isSelector = builders.selectorBuilders.includes(callee);
      if (!isAction && !isSelector) continue;
      const obj = this.storeStateObject(element);
      if (!obj) continue;
      for (const { name, loc } of this.objectKeys(obj, file)) {
        if (isAction && !actions.has(name)) actions.set(name, loc);
        if (isSelector && !selectors.has(name)) selectors.set(name, loc);
      }
    }
    const toList = (m: Map<string, SubstrateLoc>) => [...m].map(([name, loc]) => ({ name, loc }));
    return { actions: toList(actions), selectors: toList(selectors) };
  }

  /** Top-level keys of an object literal (pairs + method shorthand), with locations. */
  private objectKeys(obj: TsNode, file: string): { name: string; loc: SubstrateLoc }[] {
    const out: { name: string; loc: SubstrateLoc }[] = [];
    for (const member of obj.namedChildren) {
      const keyNode =
        member.type === 'pair'
          ? member.childForFieldName('key')
          : member.type === 'method_definition'
            ? member.childForFieldName('name')
            : undefined;
      if (!keyNode) continue;
      const name = text(keyNode).replace(/['"]/g, '');
      if (!name) continue;
      out.push({
        name,
        loc: { filePath: file, startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
      });
    }
    return out;
  }

  private storeMembers(
    obj: TsNode | undefined,
    file: string,
  ): { actions: { name: string; loc: SubstrateLoc }[]; selectors: { name: string; loc: SubstrateLoc }[] } {
    const actions: { name: string; loc: SubstrateLoc }[] = [];
    const selectors: { name: string; loc: SubstrateLoc }[] = [];
    if (!obj) return { actions, selectors };
    for (const member of obj.namedChildren) {
      if (member.type === 'pair') {
        const key = text(member.childForFieldName('key')).replace(/['"]/g, '');
        if (!key) continue;
        const v = member.childForFieldName('value');
        const loc: SubstrateLoc = {
          filePath: file,
          startLine: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
        };
        const isFn = v?.type === 'arrow_function' || v?.type === 'function_expression' || v?.type === 'function';
        (isFn ? actions : selectors).push({ name: key, loc });
      } else if (member.type === 'method_definition') {
        const key = text(member.childForFieldName('name')).replace(/['"]/g, '');
        if (!key) continue;
        actions.push({
          name: key,
          loc: { filePath: file, startLine: member.startPosition.row + 1, endLine: member.endPosition.row + 1 },
        });
      }
    }
    return { actions, selectors };
  }

  // ── Import+tsconfig JSX tag resolution (ts-morph parity for default imports) ──

  resolveJsxTagByImport(
    file: string,
    tagName: string,
    imports: ImportResolution,
  ): { filePath: string; declaredName: string } | undefined {
    if (!this.defaultExportName) this.buildDefaultExportIndex();
    const root = this.cstRoots.get(file);
    if (!root) return undefined;

    for (const imp of this.importStatements(file, root)) {
      const src = imp.childForFieldName('source');
      const specifier = src ? unquote(text(src)) : '';
      if (!specifier) continue;
      const binding = this.importBinding(imp, tagName);
      if (!binding) continue;
      const declFile = this.resolveSpecifier(specifier, file, imports);
      if (!declFile) return undefined; // resolved outside scope / not found
      let declaredName = binding.originalName;
      if (binding.kind === 'default') {
        const declared = this.defaultExportName?.get(declFile);
        if (declared) declaredName = declared;
      }
      // Barrel hop: the specifier resolved to a file that does not DECLARE the name
      // (the shadcn/`packages/ui` idiom — `index.ts` only re-exports). Follow the
      // re-export chain to the declaring module; unresolvable chains keep the old
      // answer (the barrel file), which the caller's validator then rejects.
      if (!this.fileDeclaresBinding(declFile, declaredName)) {
        const hopped = this.followReExports(declFile, declaredName, imports);
        if (hopped) return hopped;
      }
      return { filePath: declFile, declaredName };
    }

    // Same-file declaration.
    if (this.declaredNamesByFile?.get(file)?.has(tagName) ?? this.fileDeclaresName(file, tagName)) {
      return { filePath: file, declaredName: tagName };
    }
    return undefined;
  }

  /**
   * Import statements of a file, memoized. Tag resolution asks per TAG, and a full-CST
   * descendant walk per tag turns a component-heavy file into an O(tags × nodes) scan.
   */
  private importStatements(file: string, root: TsNode): TsNode[] {
    let stmts = this.importStatementsByFile.get(file);
    if (!stmts) {
      stmts = this.descendantsOfType(root, 'import_statement');
      this.importStatementsByFile.set(file, stmts);
    }
    return stmts;
  }

  /** Match a JSX local name against an import clause; report kind + original name. */
  private importBinding(
    imp: TsNode,
    tagName: string,
  ): { kind: 'default' | 'named' | 'namespace'; originalName: string } | undefined {
    const clause = imp.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) return undefined;
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') {
        // default import: `import Foo from '…'`
        if (text(c) === tagName) return { kind: 'default', originalName: tagName };
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id && text(id) === tagName) return { kind: 'namespace', originalName: tagName };
      } else if (c.type === 'named_imports') {
        for (const spec of c.namedChildren.filter((x) => x.type === 'import_specifier')) {
          const nameNode = spec.childForFieldName('name');
          const aliasNode = spec.childForFieldName('alias');
          const local = text(aliasNode) || text(nameNode);
          if (local === tagName) return { kind: 'named', originalName: text(nameNode) };
        }
      }
    }
    return undefined;
  }

  /** Module specifier → repo-relative source file (relative/alias/baseUrl + ext probe). */
  private resolveSpecifier(specifier: string, fromFile: string, imports: ImportResolution): string | undefined {
    // The alias/baseUrl config is part of the answer — different rules pass different
    // ImportResolution objects, so the memo is keyed per config identity too.
    const memoKey = `${this.importConfigId(imports)}|${fromFile}|${specifier}`;
    if (this.specifierMemo.has(memoKey)) return this.specifierMemo.get(memoKey);
    const resolved = this.resolveSpecifierUncached(specifier, fromFile, imports);
    this.specifierMemo.set(memoKey, resolved);
    return resolved;
  }

  /** Stable per-run identity of an ImportResolution config (memo keys, never persisted). */
  private importConfigId(imports: ImportResolution): string {
    let id = this.importConfigIds.get(imports);
    if (id === undefined) {
      id = String(this.importConfigIds.size);
      this.importConfigIds.set(imports, id);
    }
    return id;
  }

  private resolveSpecifierUncached(specifier: string, fromFile: string, imports: ImportResolution): string | undefined {
    const repoRoot = this.opts.repoRoot;
    let baseAbs: string | undefined;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      baseAbs = resolve(dirname(join(repoRoot, fromFile)), specifier);
    } else {
      // tsconfig paths semantics: longest prefix wins (a repo with both `X` and `X/*`
      // entries must not let the exact key swallow `X/sub` — sort desc by key length),
      // and a key with no `*` and no trailing `/` is an EXACT alias, never a prefix
      // (trailing-`/` keys like `@/` keep their historical prefix behavior).
      const aliasEntries = Object.entries(imports.aliases ?? {}).sort((a, b) => b[0].length - a[0].length);
      for (const [prefix, target] of aliasEntries) {
        const bare = prefix.replace(/\*$/, '').replace(/\/$/, '');
        const pfx = prefix.replace(/\*$/, '');
        const exactOnly = !prefix.includes('*') && !prefix.endsWith('/');
        if (specifier === bare || (!exactOnly && specifier.startsWith(pfx))) {
          const rest = specifier === bare ? '' : specifier.slice(pfx.length);
          baseAbs = join(repoRoot, target.replace(/\*$/, ''), rest);
          break;
        }
      }
      if (!baseAbs && imports.baseUrl !== undefined && /^[@\w.]/.test(specifier)) {
        baseAbs = join(repoRoot, imports.baseUrl, specifier);
      }
    }
    if (!baseAbs) return undefined;
    // Vue specifiers carry their extension (`./Foo.vue`), so probe the bare path first for
    // those; every other specifier keeps the extensionless probe order (`.vue` last, so a
    // `./Foo` next to both `Foo.ts` and `Foo.vue` still resolves to the module).
    const exts = specifier.endsWith('.vue')
      ? ['']
      : ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js', '.vue', '/index.vue'];
    for (const ext of exts) {
      const cand = baseAbs + ext;
      if (existsSync(cand)) {
        const rel = relative(repoRoot, cand).replace(/\\/g, '/');
        // `confineTo` is one prefix or a list of them — a resolution is kept when it
        // starts with ANY entry (monorepo frontends span several roots).
        const confineRoots =
          imports.confineTo === undefined
            ? []
            : Array.isArray(imports.confineTo)
              ? imports.confineTo
              : [imports.confineTo];
        if (confineRoots.length > 0 && !confineRoots.some((root) => rel.startsWith(root))) return undefined;
        return rel;
      }
    }
    return undefined;
  }

  /** Scoped structural file by path (indexed — these lookups run per JSX tag). */
  private structuralFile(file: string): StructuralFile | undefined {
    if (!this.structuralByPath) {
      this.structuralByPath = new Map(this.scopedFiles.map((f) => [f.path, f]));
    }
    return this.structuralByPath.get(file);
  }

  /**
   * Initializer source text of the local binding named `name` that is visible at `line` in
   * `file` — the single hop argument resolution may take when a call argument is a bare local
   * name. Nothing is evaluated: the caller re-applies its own argument mode to this text.
   *
   * Refuses to answer wherever the answer would not be a single statically-decidable value:
   * a reassigned name, a name with no binding whose block spans the site (a parameter, an
   * import, a sibling scope), or two same-named bindings whose innermost spans tie.
   */
  private localBindingInitializer(file: string, name: string, line: number): string | undefined {
    const candidates = (this.structuralFile(file)?.localBindings ?? []).filter(
      (b) => b.name === name && !b.reassigned && b.scopeStartLine <= line && b.scopeEndLine >= line,
    );
    if (candidates.length === 0) return undefined;
    // Innermost visible block wins (shadowing); an exact tie is ambiguous, not a coin flip.
    const spanOf = (b: (typeof candidates)[number]) => b.scopeEndLine - b.scopeStartLine;
    const innermost = candidates.reduce((best, b) => (spanOf(b) < spanOf(best) ? b : best));
    if (candidates.filter((b) => spanOf(b) === spanOf(innermost)).length > 1) return undefined;
    return innermost.initialValue;
  }

  /**
   * Whether `file` DECLARES `name` itself (rather than only re-exporting it) — the barrel
   * hop's stop condition. Read off the CST, not the structural facts: a shadcn component is
   * `const ChartContainer = React.forwardRef(…)`, which is a value binding and not a
   * StructuralFunction, so `fileDeclaresName` would walk straight past its declaration site.
   */
  private fileDeclaresBinding(file: string, name: string): boolean {
    let names = this.declaredBindingsByFile.get(file);
    if (!names) {
      names = new Set<string>();
      const root = this.cstRoots.get(file);
      if (root) {
        for (const type of ['function_declaration', 'class_declaration', 'abstract_class_declaration']) {
          for (const n of this.descendantsOfType(root, type)) names.add(text(n.childForFieldName('name')));
        }
        for (const decl of this.descendantsOfType(root, 'variable_declarator')) {
          const nameNode = decl.childForFieldName('name');
          if (nameNode?.type === 'identifier') names.add(text(nameNode));
        }
      }
      this.declaredBindingsByFile.set(file, names);
    }
    return names.has(name);
  }

  private fileDeclaresName(file: string, name: string): boolean {
    const sf = this.structuralFile(file);
    if (!sf) return false;
    return sf.classes.some((c) => c.name === name) || sf.functions.some((fn) => fn.name === name);
  }

  /**
   * Follow a barrel's `export … from '…'` chain from (file, name) to the module that
   * DECLARES `name`, so a component imported through `packages/ui`'s index (the shadcn
   * idiom) resolves to its real declaration site instead of the barrel.
   *
   * Discipline, mirroring the python model-base walk:
   *  - NAMED re-exports first, honoring the alias direction (`export { Chart as ChartContainer }`
   *    re-exported as `ChartContainer` means the source module declares `Chart`);
   *  - `export *` only when EXACTLY ONE star target yields a declaration — a name two star
   *    barrels both claim is ambiguous, and picking one would fabricate the very
   *    mis-resolution this family exists to remove;
   *  - bounded to {@link MAX_REEXPORT_HOPS} hops and cycle-safe (`seen` on file::name),
   *    so a barrel ring can never loop.
   */
  private followReExports(
    file: string,
    name: string,
    imports: ImportResolution,
    depth = 0,
    seen = new Set<string>(),
  ): { filePath: string; declaredName: string } | undefined {
    if (depth >= MAX_REEXPORT_HOPS) return undefined;
    if (seen.has(`${file}::${name}`)) return undefined;
    // A barrel is asked for hundreds of distinct names and each walk probes every star
    // target's specifier, so memoize the ENTRY answer (a pure function of file+name+config).
    const key = `${this.importConfigId(imports)}|${file}::${name}`;
    if (depth === 0 && this.reExportHopMemo.has(key)) return this.reExportHopMemo.get(key);
    const answer = this.walkReExports(file, name, imports, depth, seen);
    if (depth === 0) this.reExportHopMemo.set(key, answer);
    return answer;
  }

  private walkReExports(
    file: string,
    name: string,
    imports: ImportResolution,
    depth: number,
    seen: Set<string>,
  ): { filePath: string; declaredName: string } | undefined {
    seen.add(`${file}::${name}`);
    const reExports = this.structuralFile(file)?.reExports;
    if (!reExports?.length) return undefined;

    for (const re of reExports) {
      if (re.kind !== 'named') continue;
      for (const n of re.names ?? []) {
        if ((n.alias ?? n.name) !== name) continue;
        const target = this.resolveSpecifier(re.moduleSpecifier, file, imports);
        if (!target) continue;
        if (this.fileDeclaresBinding(target, n.name)) return { filePath: target, declaredName: n.name };
        const deeper = this.followReExports(target, n.name, imports, depth + 1, seen);
        if (deeper) return deeper;
      }
    }

    const starHits = new Map<string, { filePath: string; declaredName: string }>();
    for (const re of reExports) {
      if (re.kind !== 'star') continue;
      const target = this.resolveSpecifier(re.moduleSpecifier, file, imports);
      if (!target) continue;
      const hit = this.fileDeclaresBinding(target, name)
        ? { filePath: target, declaredName: name }
        : this.followReExports(target, name, imports, depth + 1, seen);
      if (hit) starHits.set(`${hit.filePath}::${hit.declaredName}`, hit);
    }
    return starHits.size === 1 ? [...starHits.values()][0] : undefined;
  }

  defaultExportedName(file: string, opts?: { allowAnyCase?: boolean }): string | undefined {
    if (opts?.allowAnyCase) {
      if (!this.defaultExportNameAnyCase) this.buildDefaultExportIndex();
      return this.defaultExportNameAnyCase?.get(file);
    }
    if (!this.defaultExportName) this.buildDefaultExportIndex();
    return this.defaultExportName?.get(file);
  }

  /**
   * Build both filePath → `export default` name indexes in one CST pass:
   * the PascalCase (component) reading and the any-case (handler) reading.
   */
  private buildDefaultExportIndex(): void {
    const pascal = new Map<string, string>();
    const anyCase = new Map<string, string>();
    for (const [file, root] of this.cstRoots) {
      const name = this.readDefaultExportName(root, file, false);
      if (name) pascal.set(file, name);
      const anyName = this.readDefaultExportName(root, file, true);
      if (anyName) anyCase.set(file, anyName);
    }
    this.defaultExportName = pascal;
    this.defaultExportNameAnyCase = anyCase;
  }

  private readDefaultExportName(root: TsNode, file: string, allowAnyCase: boolean): string | undefined {
    for (const stmt of this.descendantsOfType(root, 'export_statement')) {
      const isDefault = stmt.children.some((c) => c.type === 'default');
      if (!isDefault) continue;
      // `export default <expr>` — value is the last named child (decl or expression).
      const value = stmt.childForFieldName('value') ?? stmt.namedChildren[stmt.namedChildren.length - 1];
      if (!value) continue;
      if (value.type === 'class_declaration' || value.type === 'function_declaration') {
        const nm = text(value.childForFieldName('name'));
        if (nm) return nm;
        continue;
      }
      return allowAnyCase
        ? this.peelToDeclaredHandlerName(text(value), file)
        : this.peelHocToDeclaredName(text(value), file);
    }
    return undefined;
  }

  /**
   * Any-case reading of an `export default <expr>` — for API-handler consumers, where the
   * exported function is camelCase (`export default handler`) and the PascalCase peel
   * (written for page COMPONENTS) yields nothing, or worse, a type name.
   *
   * Two shapes, in order:
   *  1. a bare identifier (`export default handler` / `export default wrapper`) → itself;
   *  2. any wrapper expression — `apiWrapper(req, res, handler)`, `withAuth(handler)`, and
   *     the arrow form `(req, res) => apiWrapper(req, res, handler)` — resolved to the ONE
   *     identifier in the expression that names a function declared in the same file.
   *     Uniqueness is the whole gate: `req`/`res`/imported wrappers/type annotations name
   *     no local function, so they drop out; two local candidates (nested local wrappers)
   *     are ambiguous and resolve to undefined rather than guessing.
   */
  private peelToDeclaredHandlerName(expr: string, file: string): string | undefined {
    const trimmed = expr.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
    const declared = new Set<string>();
    for (const ident of trimmed.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (this.fileDeclaresName(file, ident)) declared.add(ident);
    }
    return declared.size === 1 ? [...declared][0] : undefined;
  }

  /** Deepest PascalCase identifier the export-default expression names (HOC peel). */
  private peelHocToDeclaredName(expr: string, file: string): string | undefined {
    const trimmed = expr.trim();
    if (/^[A-Z][\w$]*$/.test(trimmed)) return trimmed;
    const idents = trimmed.match(/[A-Za-z_$][\w$]*/g) ?? [];
    for (let i = idents.length - 1; i >= 0; i--) {
      if (/^[A-Z]/.test(idents[i]) && this.fileDeclaresName(file, idents[i])) return idents[i];
    }
    for (let i = idents.length - 1; i >= 0; i--) {
      if (/^[A-Z]/.test(idents[i])) return idents[i];
    }
    return undefined;
  }

  // ── SCIP-based JSX componentId resolution ────────────────────────────────────

  private buildScipIndexes(): void {
    const defLoc = new Map<string, { file: string; line: number }>();
    const refsByFile = new Map<string, { symbol: string; line: number; startChar: number; endChar: number }[]>();
    const scip: LoadedScip | undefined = this.baseline.scip;
    if (scip) {
      for (const doc of scip.documents) {
        for (const occ of doc.occurrences) {
          const r = decodeRange(occ.range);
          if (isDefinition(occ.symbolRoles)) {
            if (!defLoc.has(occ.symbol)) defLoc.set(occ.symbol, { file: doc.relativePath, line: r.startLine + 1 });
          } else {
            const arr = refsByFile.get(doc.relativePath) ?? [];
            arr.push({ symbol: occ.symbol, line: r.startLine, startChar: r.startChar, endChar: r.endChar });
            refsByFile.set(doc.relativePath, arr);
          }
        }
      }
    }
    this.scipDefLoc = defLoc;
    this.scipRefsByFile = refsByFile;

    // declared PascalCase top-level names per file (for picking the declared name).
    const declared = new Map<string, Set<string>>();
    for (const f of this.scopedFiles) {
      const set = new Set<string>();
      for (const c of f.classes) if (/^[A-Z]/.test(c.name)) set.add(c.name);
      for (const fn of f.functions) if (/^[A-Z]/.test(fn.name)) set.add(fn.name);
      declared.set(f.path, set);
    }
    this.declaredNamesByFile = declared;
  }

  resolveJsxTagBySCIP(
    file: string,
    tagName: string,
    line: number,
    isValid?: (filePath: string, declaredName: string) => boolean,
  ): { filePath: string; declaredName: string } | undefined {
    if (!this.scipDefLoc) this.buildScipIndexes();
    const refs = this.scipRefsByFile?.get(file);
    if (!refs) return undefined;
    const want = line - 1;
    const onLine = refs.filter((r) => r.line === want);

    // SCIP records a JSX tag as a reference occurrence whose symbol moniker encodes
    // the component's DEFINITION file + declared name directly:
    //   `… components/ui/`button.tsx`/Button.`  → file=components/ui/button.tsx name=Button
    // The JSX local name often differs from the declared name (default-export rename,
    // re-export through a barrel) — so we do NOT gate on `tail === tagName`. Instead we
    // collect every in-repo def-bearing occurrence on the line and let the caller's
    // validator pick the one that names a real component (precision = no fabrication).
    const candidates: { filePath: string; declaredName: string }[] = [];
    const seen = new Set<string>();
    const push = (c: { filePath: string; declaredName: string } | undefined): void => {
      if (!c) return;
      const key = `${c.filePath}::${c.declaredName}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(c);
    };

    // Prefer the occurrence whose tail descriptor matches the tag name (the common
    // case: same local name as declared) so behavior is stable when several in-repo
    // symbols share a line.
    const matchTail = onLine.filter((r) => this.symbolTailName(r.symbol) === tagName);
    for (const r of [...matchTail, ...onLine]) {
      const fromSymbol = this.parseSymbolDefFileAndName(r.symbol);
      if (fromSymbol) {
        push(fromSymbol);
        continue;
      }
      // Fallback: the symbol's own Definition occurrence location.
      const def = this.scipDefLoc?.get(r.symbol);
      if (def) {
        const declaredName = this.declaredNameAt(def.file, def.line, tagName);
        if (declaredName) push({ filePath: def.file, declaredName });
      }
    }

    // Name-collision guard: a candidate must be ATTESTED for this tag (see
    // {@link scipNameAttested}). Without it, an unrelated in-repo symbol sharing the
    // line — or the single-declaration fallback in `declaredNameAt` — could satisfy
    // the caller's "is a real component" validator and produce a confidently WRONG
    // edge (measured: `<ChartContainer/>` → `packages/ui/…/Menu.tsx:Group`).
    const attested = candidates.filter((c) => this.scipNameAttested(tagName, c));
    if (!attested.length) return undefined;
    if (!isValid) return attested[0];
    for (const c of attested) if (isValid(c.filePath, c.declaredName)) return c;
    return undefined;
  }

  /**
   * Whether a resolved (file, declaredName) may answer for `tagName`. Either the
   * declaration carries the tag's own name, or the declaring file's DEFAULT export is
   * that declaration — the documented HOC-peel lane, where `export default withX(Foo)`
   * legitimately renames `Foo` at the import site. An arbitrary NAMED export whose name
   * differs from the tag is never attested: that is a collision, not a rename.
   */
  private scipNameAttested(tagName: string, c: { filePath: string; declaredName: string }): boolean {
    if (c.declaredName === tagName) return true;
    if (!this.defaultExportName) this.buildDefaultExportIndex();
    return this.defaultExportName?.get(c.filePath) === c.declaredName;
  }

  /**
   * Resolve `const X = lazy(() => import('./x.js'))` /
   * `const X = lazy(() => import('./x.js').then(m => ({ default: m.X })))` to the
   * component it lazily loads. The binding is a document-`local` symbol, so the
   * JSX/route SCIP path can't follow it and the specifier never appears in an
   * `import_statement`, so the import+tsconfig path can't either.
   *
   * Resolution is SCIP-driven: scip-typescript records, inside the declarator's
   * span, a reference occurrence for the dynamically imported module (`…/`x.tsx`/`)
   * and — for the `.then(m => ({ default: m.X }))` shape — for the named export
   * itself (`…/`x.tsx`/X().`). We read those, never the specifier text, so path
   * aliases / extension rewriting (`./x.js` → `x.tsx`) resolve for free.
   */
  resolveLazyComponentBinding(
    file: string,
    name: string,
    isValid?: (filePath: string, declaredName: string) => boolean,
  ): { resolved?: { filePath: string; declaredName: string } } | undefined {
    const root = this.cstRoots.get(file);
    if (!root) return undefined;
    const decl = this.descendantsOfType(root, 'variable_declarator').find(
      (d) => text(d.childForFieldName('name')) === name,
    );
    const value = decl?.childForFieldName('value');
    if (!decl || !value || !this.subtreeHasDynamicImport(value)) return undefined;

    if (!this.scipDefLoc) this.buildScipIndexes();
    if (!this.defaultExportName) this.buildDefaultExportIndex();
    const refs = (this.scipRefsByFile?.get(file) ?? []).filter(
      (r) => r.line >= decl.startPosition.row && r.line <= decl.endPosition.row,
    );
    const ok = (c: { filePath: string; declaredName: string }): boolean =>
      !isValid || isValid(c.filePath, c.declaredName);

    // A named export referenced inside the declarator (the `.then(m => …)` shape).
    // Same-file symbols are excluded: a lazy import always targets another module,
    // so a same-file hit is the wrapper (`lazy`) itself, never the component.
    // Two symbol readings, mirroring the JSX-tag resolver: the symbol's own descriptor
    // when it encodes an in-scope path, else the symbol's DEFINITION occurrence — in a
    // monorepo the descriptor path is package-relative (`src/routes/x.tsx`) while the
    // document path is repo-relative (`apps/web/src/routes/x.tsx`), so only the
    // definition lookup lands on a scoped file.
    const modules: string[] = [];
    for (const r of refs) {
      const named = this.parseSymbolDefFileAndName(r.symbol);
      if (named) {
        if (named.filePath !== file && ok(named)) return { resolved: named };
        continue;
      }
      const def = this.scipDefLoc?.get(r.symbol);
      if (!def || def.file === file) continue;
      if (this.isModuleSymbol(r.symbol)) {
        modules.push(def.file);
        continue;
      }
      const tail = this.symbolTailName(r.symbol);
      const declaredName = tail ? this.declaredNameAt(def.file, def.line, tail) : undefined;
      if (declaredName && ok({ filePath: def.file, declaredName }))
        return { resolved: { filePath: def.file, declaredName } };
    }
    // Bare `lazy(() => import('./x.js'))` — the module's DEFAULT export is the component.
    for (const modFile of modules) {
      const declaredName = this.defaultExportName?.get(modFile);
      if (declaredName && ok({ filePath: modFile, declaredName }))
        return { resolved: { filePath: modFile, declaredName } };
    }
    // A lazy binding whose target didn't resolve to a real component: report the
    // shape (the route IS lazy) without fabricating an id.
    return { resolved: undefined };
  }

  /** True when the subtree contains a dynamic `import(…)` call. */
  private subtreeHasDynamicImport(n: TsNode): boolean {
    return this.descendantsOfType(n, 'call_expression').some((c) => text(c.childForFieldName('function')) === 'import');
  }

  /**
   * True for a scip-typescript MODULE symbol (`… src/`x.tsx`/`) — the whole module,
   * not something declared inside it. That is what a bare `import('./x.js')` references.
   */
  private isModuleSymbol(symbol: string): boolean {
    const descMatch = symbol.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    const descriptor = descMatch ? descMatch[1] : symbol;
    return /`[^`]+\.(?:tsx?|jsx?)`\/$/.test(descriptor);
  }

  /** Trailing descriptor name of a SCIP symbol (drops a `.`/`#`/`()` suffix). */
  private symbolTailName(symbol: string): string | undefined {
    // strip any backtick-wrapped path segments first; the final descriptor is the name.
    const m = symbol.match(/([A-Za-z_$][\w$]*)\s*(?:\(\))?[.#]?\s*$/);
    return m?.[1];
  }

  /**
   * Parse a scip-typescript symbol into (def file, declared name). The symbol
   * encodes the path as backtick-wrapped segments ending in the file basename,
   * then `/Name.`:  `… components/ui/`button.tsx`/Button.`. Only in-repo symbols
   * (with a backtick-wrapped file segment) resolve; npm/@types symbols return
   * undefined (correctly unresolved — external).
   */
  private parseSymbolDefFileAndName(symbol: string): { filePath: string; declaredName: string } | undefined {
    // The descriptor is everything after `<scheme> <manager> <pkg> <version> `.
    // scip-typescript: `scip-typescript npm <pkg> <version> <descriptor>`.
    const descMatch = symbol.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    const descriptor = descMatch ? descMatch[1] : symbol;
    // A file segment is backtick-wrapped and ends in a source extension.
    const fileMatch = descriptor.match(/`([^`]+\.(?:tsx?|jsx?))`/);
    if (!fileMatch) return undefined; // external (no in-repo file segment)
    // Path = descriptor up to and including the file segment, backticks stripped.
    const fileEnd = descriptor.indexOf('`', descriptor.indexOf(fileMatch[0]) + fileMatch[0].length - 1) + 1;
    const pathPart = descriptor.slice(0, fileEnd).replace(/`/g, '');
    const filePath = pathPart.replace(/\/$/, '');
    // Declared name = trailing descriptor after the file segment.
    const tail = descriptor.slice(fileEnd);
    const nm = tail.match(/\/?([A-Za-z_$][\w$]*)\s*(?:\(\))?[.#]?\s*$/);
    if (!nm) return undefined;
    if (!this.scopedFiles.some((f) => f.path === filePath)) return undefined;
    return { filePath, declaredName: nm[1] };
  }

  /** Pick the declared PascalCase component name owning the definition line. */
  private declaredNameAt(file: string, line: number, fallback: string): string | undefined {
    const sf = this.scopedFiles.find((f) => f.path === file);
    if (!sf) return undefined;
    for (const c of sf.classes) {
      if (/^[A-Z]/.test(c.name) && c.startLine <= line && line <= c.endLine) return c.name;
    }
    for (const fn of sf.functions) {
      if (/^[A-Z]/.test(fn.name) && fn.startLine <= line && line <= fn.endLine) return fn.name;
    }
    // Default-export / declared-name fallback: any PascalCase decl in the file.
    const declared = this.declaredNamesByFile?.get(file);
    if (declared?.has(fallback)) return fallback;
    return declared && declared.size === 1 ? [...declared][0] : undefined;
  }

  // ── internal calls (SCIP, scoped, DI-corrected) ────────────────────────────

  internalCalls(): CallEdgeFact[] {
    const scopedFnIds = this.scopedFunctionIds();
    // Index structural call sites (receiver/method/enclosing) by (callerId, file, line)
    // so we can DI-correct SCIP edges that landed on a constructor.
    const siteIndex = this.structuralCallIndex();
    // id → callee-node name, for the final precision gate (drop any internal edge whose
    // resolved callee name ≠ the call-expression tail). Functions and methods both live
    // in graph.functions, so this covers DI-corrected method ids too.
    const fnNameById = new Map<string, string>();
    for (const fn of this.baseline.graph.functions.values()) fnNameById.set(fn.id, fn.name);

    const out: CallEdgeFact[] = [];
    for (const edge of this.baseline.graph.calls.values()) {
      if (!scopedFnIds.has(edge.callerId)) continue;
      // If the callee resolved but is out of scope, keep the edge but drop the callee.
      // Provenance tracks HOW the surviving calleeId was resolved, so consumers can tell a
      // compiler-grade SCIP edge from a heuristic DI inference. It moves in lockstep with calleeId.
      let calleeId = edge.calleeId;
      let provenance: CallProvenance | undefined = calleeId ? 'scip' : undefined;
      if (calleeId && !scopedFnIds.has(calleeId)) {
        calleeId = undefined;
        provenance = undefined;
      }

      // Dynamic-import binding: `const { fn } = await import('m'); fn()`. The call site's
      // symbol is a document-`local`, so the SCIP edge pass left it unresolved — resolve it
      // through the binding site, where SCIP DID record the module's real export.
      let viaDynamicImport = false;
      if (!calleeId) {
        const bound = this.dynamicImportCallee(edge.calleeExpression, edge.location.filePath, edge.location.startLine);
        if (bound && scopedFnIds.has(bound)) {
          calleeId = bound;
          provenance = 'scip';
          viaDynamicImport = true;
        }
      }

      // Accessor-hook binding: `const { m } = useAccessor(ref); m()`. Same blind spot as the
      // dynamic import — the call site's symbol is a document-`local` — but the evidence is the
      // hook argument's defining file plus a uniquely-named function in it.
      let viaAccessorHook = false;
      if (!calleeId) {
        const bound = this.accessorHookCallee(edge.calleeExpression, edge.location.filePath, edge.location.startLine);
        if (bound && scopedFnIds.has(bound)) {
          calleeId = bound;
          provenance = 'accessor-hook';
          viaAccessorHook = true;
        }
      }

      // DI correction: a member-chain call `this.svc.method()` that SCIP pointed at a
      // CONSTRUCTOR (or left unresolved) — re-resolve to the real method via the ctor DI map.
      const corrected = this.diCorrect(edge.callerId, edge.location.filePath, edge.location.startLine, siteIndex);
      if (corrected && scopedFnIds.has(corrected)) {
        calleeId = corrected;
        provenance = 'di';
        viaAccessorHook = false;
        // The site index is keyed by line only, so a correction can land on an edge the
        // dynamic-import pass already resolved. The name-gate exemption belongs to THAT
        // resolution alone — carrying it over would let a mismatched DI callee through.
        viaDynamicImport = false;
      }

      // Interface-dispatch binding: `activities.m()` where `activities` is a PARAMETER typed by
      // an in-repo interface with exactly one implementing class in scope. Last of the internal
      // tiers because every earlier one is stronger evidence — this is an inference about which
      // object the parameter holds, not a compiler fact (see the `iface-impl` provenance doc).
      if (!calleeId) {
        const bound = this.interfaceDispatchCallee(edge.callerId, edge.location.filePath, edge.location.startLine, {
          siteIndex,
          scopedFnIds,
        });
        if (bound) {
          calleeId = bound;
          provenance = 'iface-impl';
        }
      }

      // Final precision gate: a resolved callee's node name must equal the call-expression
      // tail (`a.b.foo(...)` → `foo`). Drops any internal call edge that slipped through
      // with a mismatched callee (e.g. a SCIP misresolution to an enclosing scope).
      // Exempt: an aliased dynamic-import binding (`const { a: b } = await import(…); b()`)
      // legitimately calls `b` while the callee node is named `a` — the alias itself is the
      // compiler-grade evidence, so name equality would be the wrong invariant here. An aliased
      // accessor-hook binding (`const { a: b } = useAccessor(ref); b()`) is exempt for the same
      // reason: the callee is name-verified against the PROPERTY name at the binding site.
      if (calleeId && !viaDynamicImport && !viaAccessorHook) {
        const calleeName = fnNameById.get(calleeId);
        const tail = calleeTail(edge.calleeExpression);
        // Normalize the `#` private-method sigil: node name `#foo` vs tail `foo`.
        const norm = (s: string): string => (s.startsWith('#') ? s.slice(1) : s);
        if (calleeName !== undefined && tail !== undefined && norm(calleeName) !== norm(tail)) {
          calleeId = undefined;
          provenance = undefined;
        }
      }

      out.push({
        id: edge.id,
        callerId: edge.callerId,
        calleeId,
        provenance,
        calleeExpression: edge.calleeExpression,
        isMethodCall: edge.isMethodCall,
        location: edge.location,
        arguments: edge.arguments,
      });
    }

    // Calls through a destructured `await import()` binding whose structural edge no
    // longer exists: the SCIP pass reclassified the site (its symbol is a document-`local`)
    // and dropped the sibling, so there is nothing to upgrade above — mint the edge from
    // the structural call site instead. Same evidence, same precision gate (the binding
    // resolved to a real in-repo function, and the call names that binding exactly).
    const seenSites = new Set(
      out.map((e) => `${e.callerId}|${e.location.filePath}|${e.location.startLine}|${e.calleeExpression}`),
    );
    for (const f of this.scopedFiles) {
      if (!f.dynamicImports?.length) continue;
      for (const call of f.calls) {
        if (call.receiver) continue; // `obj.fn()` names a member, not the binding
        const callerId = this.enclosingId(call, f.path);
        if (!callerId || !scopedFnIds.has(callerId)) continue;
        const site = `${callerId}|${f.path}|${call.startLine}|${call.expressionText}`;
        if (seenSites.has(site)) continue;
        const calleeId = this.dynamicImportCallee(call.expressionText, f.path, call.startLine);
        if (!calleeId || !scopedFnIds.has(calleeId)) continue;
        seenSites.add(site);
        out.push({
          id: this.idGen.callEdgeId(callerId, call.expressionText, `${f.path}:${call.startLine}`),
          callerId,
          calleeId,
          provenance: 'scip',
          calleeExpression: call.expressionText,
          isMethodCall: false,
          location: { filePath: f.path, startLine: call.startLine, endLine: call.endLine },
          arguments: call.arguments.length ? call.arguments : undefined,
        });
      }
    }

    // Same residue problem for accessor-hook bindings, and here it is the COMMON case: the
    // destructured name's symbol usually resolves to the hook return type's generated property,
    // which is in-repo but sits in no function span — so the SCIP pass dropped the structural
    // sibling and reclassified the site as external. (The correction pass above covers the
    // other shape: a return type that erases to `any`, where the name stays a document-`local`
    // and the sibling survives.) Mint from the structural call site, on exactly the evidence
    // the binding index already verified.
    if (this.opts.accessorHooks?.length) {
      for (const f of this.scopedFiles) {
        if (!this.accessorHookBindingsIn(f.path)) continue; // no binding in this file — nothing to mint
        for (const call of f.calls) {
          if (call.receiver) continue; // `obj.m()` names a member, not the binding
          const callerId = this.enclosingId(call, f.path);
          if (!callerId || !scopedFnIds.has(callerId)) continue;
          const site = `${callerId}|${f.path}|${call.startLine}|${call.expressionText}`;
          if (seenSites.has(site)) continue;
          const calleeId = this.accessorHookCallee(call.expressionText, f.path, call.startLine);
          if (!calleeId || !scopedFnIds.has(calleeId)) continue;
          seenSites.add(site);
          out.push({
            id: this.idGen.callEdgeId(callerId, call.expressionText, `${f.path}:${call.startLine}`),
            callerId,
            calleeId,
            provenance: 'accessor-hook',
            calleeExpression: call.expressionText,
            isMethodCall: false,
            location: { filePath: f.path, startLine: call.startLine, endLine: call.endLine },
            arguments: call.arguments.length ? call.arguments : undefined,
          });
        }
      }
    }
    return out;
  }

  /**
   * Callee id for a bare call (`fn(…)`) whose name is bound by a destructured
   * `await import()` in scope at that site, or undefined when there is none.
   */
  private dynamicImportCallee(calleeExpression: string, file: string, line: number): string | undefined {
    if (!this.dynamicImportAliases) this.dynamicImportAliases = this.buildDynamicImportAliases();
    // Only a bare identifier call can be the binding: `obj.fn()` names a member, not the binding.
    const alias = this.dynamicImportAliases.find(
      (a) => a.localName === calleeExpression && a.file === file && line >= a.startLine && line <= a.endLine,
    );
    return alias?.calleeId;
  }

  /**
   * Accessor-hook bindings declared in `file`, indexed by local name — or undefined when the
   * profile lists no hooks and when the file declares none (the mint loop's skip gate).
   */
  private accessorHookBindingsIn(file: string): Map<string, AccessorHookBinding[]> | undefined {
    const hooks = this.opts.accessorHooks;
    if (!hooks?.length) return undefined;
    if (!this.accessorHookBindings) this.accessorHookBindings = this.buildAccessorHookBindings(new Set(hooks));
    return this.accessorHookBindings.get(file);
  }

  /**
   * Callee id for a bare call (`m(…)`) whose name is bound by a destructured accessor-hook
   * call in scope at that site, or undefined when there is none / the profile lists no hooks.
   *
   * Shadowing: a binding's span is its whole enclosing function, so an outer binding contains
   * a nested closure's rebinding of the same name. The NARROWEST containing span wins — that
   * is the one whose declaration the call actually sees. Two bindings with the identical span
   * naming different targets (the same name destructured twice from different refs in one
   * function) is a genuine ambiguity: abstain.
   */
  private accessorHookCallee(calleeExpression: string, file: string, line: number): string | undefined {
    // Only a bare identifier call can be the binding: `obj.m()` names a member, not the binding.
    if (calleeExpression.includes('.')) return undefined;
    const inScope = (this.accessorHookBindingsIn(file)?.get(calleeExpression) ?? []).filter(
      (b) => line >= b.startLine && line <= b.endLine,
    );
    if (!inScope.length) return undefined;
    let best = inScope[0];
    for (const c of inScope) {
      if (c.startLine > best.startLine || (c.startLine === best.startLine && c.endLine < best.endLine)) best = c;
    }
    const tied = inScope.filter((c) => c.startLine === best.startLine && c.endLine === best.endLine);
    if (tied.some((c) => c.calleeId !== best.calleeId)) return undefined;
    return best.calleeId;
  }

  /**
   * Index every `const { a, b: c } = <hook>(ref)` binding to the in-repo node it names,
   * as file → local name → bindings.
   *
   * The compiler binds each destructured name to a GENERATED property of the hook's return
   * type, which no SCIP reading can turn into a function: the property's definition site sits
   * in no function span, and when the type erases it (an `any`/index-signature return) the
   * name is only a document-`local`. What IS compiler-grade here is `ref` — an ordinary
   * identifier whose SCIP symbol names its defining file. So the binding resolves as: property
   * name, looked up among the function nodes of the file that defines `ref`. That last step
   * trusts NAME UNIQUENESS inside the target file — it is not an export or reachability proof
   * (see the `accessor-hook` CallProvenance doc).
   *
   * Abstains (records nothing) on every ambiguity: a hook call that is not `hook(<identifier>)`,
   * a `ref` whose SCIP symbol is a document-`local` (only unique per document, so it can never
   * name a file) or which SCIP cannot place in a scoped file, a property with no same-named
   * function there, or more than one such function (two same-named methods on different classes).
   *
   * Scope: the enclosing function of the binding (the whole file for a top-level binding).
   * Calls in nested closures are covered because the span contains them; a nested REBINDING of
   * the same name is disambiguated at lookup time by narrowest span.
   */
  private buildAccessorHookBindings(hookNames: Set<string>): Map<string, Map<string, AccessorHookBinding[]>> {
    const out = new Map<string, Map<string, AccessorHookBinding[]>>();
    if (!this.baseline.scip) return out;
    if (!this.scipDefLoc) this.buildScipIndexes();
    // One pass over the graph's functions builds both indexes this needs, so neither the
    // candidate lookup nor the enclosing-span lookup rescans them per binding:
    //   file → (function name → ids)  — the unique-candidate rule. Methods live in
    //     graph.functions too, which is why a name can legitimately be claimed more than once.
    //   file → spans                  — the binding's enclosing function.
    const fnIdsByFileName = new Map<string, Map<string, string[]>>();
    const spansByFile = new Map<string, { startLine: number; endLine: number }[]>();
    for (const fn of this.baseline.graph.functions.values()) {
      const path = fn.location.filePath;
      const byName = fnIdsByFileName.get(path) ?? new Map<string, string[]>();
      byName.set(fn.name, [...(byName.get(fn.name) ?? []), fn.id]);
      fnIdsByFileName.set(path, byName);
      const spans = spansByFile.get(path) ?? [];
      spans.push({ startLine: fn.location.startLine, endLine: fn.location.endLine });
      spansByFile.set(path, spans);
    }
    for (const [file, root] of this.cstRoots) {
      const refs = this.scipRefsByFile?.get(file) ?? [];
      for (const decl of this.descendantsOfType(root, 'variable_declarator')) {
        const pattern = decl.childForFieldName('name');
        const value = decl.childForFieldName('value');
        if (pattern?.type !== 'object_pattern' || value?.type !== 'call_expression') continue;
        const callee = value.childForFieldName('function');
        if (callee?.type !== 'identifier' || !hookNames.has(text(callee))) continue;
        const args = value.childForFieldName('arguments')?.namedChildren ?? [];
        if (args.length !== 1 || args[0].type !== 'identifier') continue;
        const targetFile = this.scipDefFileAt(refs, args[0].startPosition.row, args[0].startPosition.column);
        if (!targetFile) continue;
        const byName = fnIdsByFileName.get(targetFile);
        if (!byName) continue;
        const span = innermostSpan(spansByFile.get(file) ?? [], decl.startPosition.row + 1);
        for (const b of objectPatternBindings(pattern)) {
          const ids = byName.get(b.propertyName);
          if (ids?.length !== 1) continue;
          const byLocal = out.get(file) ?? new Map<string, AccessorHookBinding[]>();
          const bucket = byLocal.get(b.localName) ?? [];
          bucket.push({
            file,
            startLine: span?.startLine ?? 1,
            endLine: span?.endLine ?? Number.MAX_SAFE_INTEGER,
            localName: b.localName,
            calleeId: ids[0],
          });
          byLocal.set(b.localName, bucket);
          out.set(file, byLocal);
        }
      }
    }
    return out;
  }

  /**
   * Scoped file that DEFINES the identifier occurring at (0-based row, column) in a file,
   * read off its SCIP reference occurrence — the symbol's own descriptor path first, then the
   * symbol's definition occurrence. Undefined when there is no occurrence there or the
   * definition lies outside the profile's scope.
   *
   * A document-`local` symbol NEVER answers: `local N` is unique only within its document,
   * while every index here is keyed on the raw symbol string, so the first document to define
   * `local N` would answer for every other file's `local N` — a confidently wrong file.
   */
  private scipDefFileAt(
    refs: { symbol: string; line: number; startChar: number }[],
    row: number,
    column: number,
  ): string | undefined {
    const occ = refs.find((r) => r.line === row && r.startChar === column);
    if (!occ) return undefined;
    if ('local' in parseMoniker(occ.symbol)) return undefined;
    const named = this.parseSymbolDefFileAndName(occ.symbol);
    if (named) return named.filePath;
    const def = this.scipDefLoc?.get(occ.symbol);
    if (!def) return undefined;
    return this.scopedFiles.some((f) => f.path === def.file) ? def.file : undefined;
  }

  /**
   * Index every destructured `await import('<spec>')` binding to the in-repo node it
   * names, by two readings of the SAME index the static-import path uses — the specifier
   * text is never resolved by hand:
   *
   *  1. The occurrence AT THE BINDING SITE. For a relative/same-package import,
   *     scip-typescript records the module's real export there, so one lookup is enough.
   *  2. Otherwise (a workspace package imported through its barrel `dist/index.d.ts`,
   *     where the binding site is only a document-`local`), the module reference in the
   *     declarator names the PACKAGE — join `<package> <exportName>` onto that package's
   *     source definition, exactly the cross-package key the static path resolves through.
   *
   * A binding whose specifier isn't a literal, whose package is ambiguous, or that finds
   * no in-repo definition is simply absent — unresolved, never guessed.
   *
   * Scope: the enclosing function of the binding (the whole file for a top-level-await
   * binding). Calls in nested closures are covered because the span contains them.
   */
  private buildDynamicImportAliases(): DynamicImportAlias[] {
    const out: DynamicImportAlias[] = [];
    const scip = this.baseline.scip;
    if (!scip) return out;
    if (!this.scipDefLoc) this.buildScipIndexes();
    const hooks = buildMappingHooks(scip, this.baseline.graph);
    const byPackageKey = this.packageExportIndex(hooks);
    for (const f of this.scopedFiles) {
      const dyn = f.dynamicImports ?? [];
      if (!dyn.length) continue;
      const refs = this.scipRefsByFile?.get(f.path) ?? [];
      for (const imp of dyn) {
        if (!imp.moduleSpecifier) continue; // non-literal specifier — unresolvable by design
        const pkg = this.importedPackageName(refs, imp.startLine, imp.endLine);
        for (const b of imp.bindings) {
          const occ = refs.find((r) => r.line === b.line - 1 && r.startChar === b.column);
          const direct = occ ? hooks.symbolToNodeId(occ.symbol) : undefined;
          // Both descriptor suffixes an export can carry: `name().` (function/method) and
          // `name.` (term). Nothing else is a callable export.
          const calleeId =
            direct ??
            (pkg
              ? (byPackageKey.get(`${pkg} ${b.exportName}().`) ?? byPackageKey.get(`${pkg} ${b.exportName}.`))
              : undefined);
          if (!calleeId) continue;
          const span = this.enclosingFunctionSpan(f.path, b.line);
          out.push({
            file: f.path,
            startLine: span?.startLine ?? 1,
            endLine: span?.endLine ?? Number.MAX_SAFE_INTEGER,
            localName: b.localName,
            calleeId,
          });
        }
      }
    }
    return out;
  }

  /**
   * Package name of the module a dynamic import pulls in, read from the module reference
   * scip-typescript records inside the declarator. Undefined when the declarator names no
   * package or more than one (ambiguous — resolve nothing rather than pick).
   */
  private importedPackageName(
    refs: { symbol: string; line: number }[],
    startLine: number,
    endLine: number,
  ): string | undefined {
    const names = new Set<string>();
    for (const r of refs) {
      if (r.line < startLine - 1 || r.line > endLine - 1) continue;
      if (!this.isModuleSymbol(r.symbol)) continue;
      const mon = parseMoniker(r.symbol);
      if ('local' in mon || !mon.packageName) continue;
      names.add(mon.packageName);
    }
    return names.size === 1 ? [...names][0] : undefined;
  }

  /**
   * `<package> <descriptor-suffix>` → in-repo node id, over every DEFINITION in the index.
   * A key that two distinct definitions claim is dropped, preserving the precision rule the
   * cross-package join in the SCIP edge pass follows.
   */
  private packageExportIndex(hooks: { symbolToNodeId(symbol: string): string | undefined }): Map<string, string> {
    const idx = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const doc of this.baseline.scip?.documents ?? []) {
      for (const occ of doc.occurrences) {
        if (!isDefinition(occ.symbolRoles)) continue;
        const key = packageSymbolKey(occ.symbol);
        if (!key || ambiguous.has(key)) continue;
        const nodeId = hooks.symbolToNodeId(occ.symbol);
        if (!nodeId) continue;
        const existing = idx.get(key);
        if (existing && existing !== nodeId) {
          ambiguous.add(key);
          idx.delete(key);
          continue;
        }
        idx.set(key, nodeId);
      }
    }
    return idx;
  }

  /** Innermost function-node span containing (file, line). */
  private enclosingFunctionSpan(file: string, line: number): { startLine: number; endLine: number } | undefined {
    let best: { startLine: number; endLine: number } | undefined;
    for (const fn of this.baseline.graph.functions.values()) {
      const loc = fn.location;
      if (loc.filePath !== file || loc.startLine > line || loc.endLine < line) continue;
      if (!best || loc.startLine > best.startLine) best = { startLine: loc.startLine, endLine: loc.endLine };
    }
    return best;
  }

  /** Resolve `this.<injected>.method()` at a site to the real method id via the DI map. */
  private diCorrect(
    callerId: string,
    file: string,
    line: number,
    siteIndex: Map<string, StructuralCall>,
  ): string | undefined {
    const site = siteIndex.get(`${callerId}|${file}|${line}`);
    if (!site || !site.receiver || !site.methodName) return undefined;
    // member chain: receiver = `this.svc` (or `svc`); property after the last dot is the DI prop.
    const recv = site.receiver;
    const propName = recv.startsWith('this.') ? recv.slice('this.'.length) : recv;
    if (propName.includes('.')) return undefined; // deeper chains: leave to SCIP
    const targetClass = this.diMap.get(file)?.get(propName);
    if (!targetClass) return undefined;
    return this.resolveMethodOnClass(targetClass, site.methodName);
  }

  /**
   * Callee id for `recv.m()` where `recv` is a parameter of the enclosing function/method whose
   * annotated type names exactly ONE in-repo interface, and exactly ONE scoped class implements
   * that interface — the Temporal-style activity-proxy shape, expressed on observed type structure
   * rather than on any framework identity.
   *
   * Every step abstains rather than guesses (see the `iface-impl` CallProvenance doc for what the
   * binding does and does not claim):
   *  - a dotted receiver (`this.x.m()`) names a member, not a parameter;
   *  - a local binding shadowing the parameter name means the receiver is not the parameter;
   *  - a type naming zero or several in-repo interfaces (an intersection of two, a `typeof` query
   *    the type parser deliberately leaves unstructured) is not one interface;
   *  - zero or several implementors is not one implementation;
   *  - the callee id is derived from the IMPLEMENTING CLASS's own file+name, never from the
   *    repo-wide bare-name method index (two classes of one name in different files would collide
   *    there), and it must name a real, in-scope function node.
   */
  private interfaceDispatchCallee(
    callerId: string,
    file: string,
    line: number,
    ctx: { siteIndex: Map<string, StructuralCall>; scopedFnIds: Set<string> },
  ): string | undefined {
    if (!this.symbolResolver) return undefined;
    const site = ctx.siteIndex.get(`${callerId}|${file}|${line}`);
    const recv = site?.receiver;
    if (!site || !recv || !site.methodName || recv.includes('.')) return undefined;
    const param = this.receiverParam(site, file, recv, line);
    if (!param?.typeInfo) return undefined;
    const interfaceId = this.soleInterfaceNamedBy(param.typeInfo, file);
    if (!interfaceId) return undefined;
    const implementors = this.implementorsOf(interfaceId);
    if (implementors.length !== 1) return undefined;
    // A bound sole implementor is not enough: an UNBOUND `implements` clause naming this interface
    // (a dotted, default-imported or unresolvable base the binder could not resolve) is a potential
    // second implementor, so abstain rather than bind to the one we happened to resolve.
    const iface = this.baseline.graph.interfaces.get(interfaceId);
    if (iface && this.hasUnboundImplementorNamed(iface.name)) return undefined;
    const cls = this.baseline.graph.classes.get(implementors[0]);
    if (!cls) return undefined;
    const methodId = this.idGen.methodId(cls.location.filePath, cls.name, site.methodName);
    // The class may implement the interface without declaring THIS member (an inherited or
    // merged implementation the structural layer did not emit as its own method node).
    return this.baseline.graph.functions.has(methodId) && ctx.scopedFnIds.has(methodId) ? methodId : undefined;
  }

  /**
   * The enclosing function's/method's parameter named `recv`, or undefined when there is none —
   * or when a local binding of the same name is visible at the call line, which means the
   * receiver is that local and its type is unknown to this pass.
   */
  private receiverParam(site: StructuralCall, file: string, recv: string, line: number): StructuralParam | undefined {
    const f = this.structuralFile(file);
    if (!f || !site.enclosingName) return undefined;
    const shadowed = (this.localBindingIndex(f).get(recv) ?? []).some(
      (b) => b.scopeStartLine <= line && line <= b.scopeEndLine,
    );
    if (shadowed) return undefined;
    const params = this.paramIndex(f).get(enclosingKey(site.enclosingKind, site.enclosingClass, site.enclosingName));
    return params?.find((p) => p.name === recv);
  }

  /** `file`'s local bindings grouped by name, built once on first touch. */
  private localBindingIndex(f: StructuralFile): Map<string, StructuralLocalBinding[]> {
    let index = this.localBindingsByFile.get(f.path);
    if (index) return index;
    index = new Map();
    for (const b of f.localBindings ?? []) {
      const bucket = index.get(b.name);
      if (bucket) bucket.push(b);
      else index.set(b.name, [b]);
    }
    this.localBindingsByFile.set(f.path, index);
    return index;
  }

  /** `file`'s method and function parameter lists, keyed by their enclosing identity. */
  private paramIndex(f: StructuralFile): Map<string, StructuralParam[]> {
    let index = this.paramsByEnclosing.get(f.path);
    if (index) return index;
    index = new Map();
    for (const cls of f.classes) {
      for (const m of cls.methods) index.set(enclosingKey('method', cls.name, m.name), m.params);
    }
    for (const fn of f.functions) index.set(enclosingKey('function', undefined, fn.name), fn.params);
    this.paramsByEnclosing.set(f.path, index);
    return index;
  }

  /** `file`'s named imports as local name → exported name + module, built once on first touch. */
  private importedNamesOf(f: StructuralFile): Map<string, ImportedName> {
    let index = this.importedNamesByFile.get(f.path);
    if (!index) {
      index = importedNames(f);
      this.importedNamesByFile.set(f.path, index);
    }
    return index;
  }

  /**
   * The single in-repo interface a parameter's type names, reading type-reference names depth
   * first THROUGH generic arguments (`ActivityInterfaceFor<Pick<IFoo, 'm'>>` names `IFoo`), or
   * undefined when the type names none or more than one. Each name is bound over the module graph
   * (same-file declaration, then a named import followed to its declaring module) — never by a
   * repo-wide name match, so a same-named interface in an unrelated module cannot capture it.
   */
  private soleInterfaceNamedBy(type: TypeInfo, file: string): string | undefined {
    const names: string[] = [];
    const walk = (info: TypeInfo): void => {
      const s = info.structure;
      if (!s) return;
      switch (s.kind) {
        case 'reference':
          names.push(s.name);
          for (const arg of s.typeArguments ?? []) walk(arg);
          break;
        case 'array':
          walk(s.elementType);
          break;
        case 'tuple':
          for (const el of s.elements) walk(el);
          break;
        case 'union':
        case 'intersection':
          for (const t of s.types) walk(t);
          break;
        default:
          break;
      }
    };
    walk(type);
    const ids = new Set<string>();
    for (const name of names) {
      const id = this.interfaceIdForName(name, file);
      if (id) ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  /** Interface node id a name refers to AS SEEN FROM `file`, over the module graph. */
  private interfaceIdForName(name: string, file: string): string | undefined {
    const resolver = this.symbolResolver;
    const f = this.structuralFile(file);
    if (!resolver || !f) return undefined;
    const outcome = resolveHeritageName(
      this.baseline.graph,
      resolver,
      this.idGen,
      file,
      this.importedNamesOf(f),
      name,
      [DeclKind.Interface],
    );
    return outcome.kind === 'bound' && this.baseline.graph.interfaces.has(outcome.id) ? outcome.id : undefined;
  }

  /**
   * Classes across the WHOLE baseline whose `implements` clause is BOUND to `interfaceId` (07a
   * resolved the ids). Counted over every target, not just the scoped files: a second implementor
   * in another target of a MultiTargetProfile must defeat the sole-implementation test, or a call
   * dispatched over the interface binds to whichever implementation this target happened to see.
   */
  private implementorsOf(interfaceId: string): string[] {
    this.buildImplementorIndex();
    return this.implementorsByInterface!.get(interfaceId) ?? [];
  }

  /**
   * Interface NAMES that appear in at least one UNBOUND (`resolvedId` absent), non-external
   * `implements` clause. An unbound clause is a potential extra implementor the binder could not
   * resolve — a dotted base (`implements Contracts.IActivities`), a default/namespace import, or an
   * unresolvable specifier. The sole-implementation test abstains when the interface's name is in
   * here, because a second implementor may exist that this pass simply failed to bind.
   *
   * Radius: this keys on the bare NAME across the WHOLE baseline (the unbound clause carries no
   * resolvable identity, so name is all there is), so one unbound `implements Foo` anywhere silences
   * every `Foo` dispatch binding in every target. That is deliberately fail-closed — it trades
   * recall for precision — but it means the interface-dispatch bind-rate must be RE-MEASURED on the
   * fleet after this change to distinguish a precision win from a silently-disabled tier.
   */
  private hasUnboundImplementorNamed(interfaceName: string): boolean {
    this.buildImplementorIndex();
    return this.unboundImplementorNames!.has(interfaceName);
  }

  private buildImplementorIndex(): void {
    if (this.implementorsByInterface) return;
    const bound = new Map<string, string[]>();
    const unboundNames = new Set<string>();
    for (const cls of this.baseline.graph.classes.values()) {
      for (const impl of cls.implements ?? []) {
        if (impl.resolvedId) {
          bound.set(impl.resolvedId, [...(bound.get(impl.resolvedId) ?? []), cls.id]);
        } else if (!impl.external) {
          // Last segment of a possibly-dotted base (`Contracts.IActivities` → `IActivities`), the
          // form an interface node is named by. `external` clauses are proven outside the repo, so
          // they are not this repo's implementors and never suppress a bind.
          const base = impl.name.split('.').pop();
          if (base) unboundNames.add(base);
        }
      }
    }
    this.implementorsByInterface = bound;
    this.unboundImplementorNames = unboundNames;
  }

  private structuralCallIndex(): Map<string, StructuralCall> {
    const idx = new Map<string, StructuralCall>();
    for (const f of this.scopedFiles) {
      for (const call of f.calls) {
        const callerId = this.enclosingId(call, f.path);
        if (!callerId) continue;
        idx.set(`${callerId}|${f.path}|${call.startLine}`, call);
      }
    }
    return idx;
  }

  private enclosingId(call: StructuralCall, filePath: string): string | undefined {
    if (call.enclosingKind === 'method' && call.enclosingClass && call.enclosingName) {
      return this.idGen.methodId(filePath, call.enclosingClass, call.enclosingName);
    }
    if (call.enclosingKind === 'function' && call.enclosingName) {
      return this.idGen.functionId(filePath, call.enclosingName);
    }
    return undefined;
  }

  enclosingFunctionId(filePath: string, line: number): string | undefined {
    let best: { id: string; span: number } | undefined;
    for (const fn of this.baseline.graph.functions.values()) {
      const l = fn.location;
      if (l.filePath !== filePath || line < l.startLine || line > l.endLine) continue;
      const span = l.endLine - l.startLine;
      if (!best || span < best.span) best = { id: fn.id, span };
    }
    return best?.id;
  }

  private _scopedFnIds: Set<string> | undefined;
  private scopedFunctionIds(): Set<string> {
    if (this._scopedFnIds) return this._scopedFnIds;
    const ids = new Set<string>();
    const scopedPaths = new Set(this.scopedFiles.map((f) => f.path));
    for (const fn of this.baseline.graph.functions.values()) {
      if (scopedPaths.has(fn.location.filePath)) ids.add(fn.id);
    }
    this._scopedFnIds = ids;
    return ids;
  }

  // ── external calls (SCIP superset → curated allow-list) ────────────────────

  externalCalls(matchers: ExternalClientMatcher[]): ExternalCallFact[] {
    const scopedFnIds = this.scopedFunctionIds();
    const out: ExternalCallFact[] = [];
    // De-dup by (callerId, method, startLine) — registry + matcher passes can both
    // recognize the same site (mirrors the ts-morph base parser's id de-dup).
    const seen = new Set<string>();
    const push = (fact: ExternalCallFact): void => {
      const key = `${fact.callerId}|${fact.method}|${fact.location.startLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(fact);
    };

    // The curated egress is convention-defined (receiver/verb/DI-type), exactly like the
    // ts-morph engine's tryEmitExternalCall — so we evaluate matchers over the STRUCTURAL
    // call sites (which carry receiver/method/args), gated by the DI map. SCIP's raw
    // externalCalls superset is NOT the source: it is a cross-package symbol-ref dump, far
    // broader than curated egress (9121/3085) and lacks receiver/URL fidelity.
    //
    // new-instance SDK provenance (`const a = new Anthropic(); a.messages.create(…)`): the
    // ts-morph engine pre-scans `new <Ctor>(…)` bindings (import-checked against `fromModule`)
    // so an `instance.method()` call classifies as an SDK egress. Mirror that here per file.
    const newInstancesByFile = this.buildNewInstanceMap(matchers);

    for (const f of this.scopedFiles) {
      const fileInstances = newInstancesByFile.get(f.path);
      // Registry-driven SDK detection (import-anchored, profile-independent): the
      // ts-morph base parser emits these for every recognized SDK package import.
      const bareImports = buildBareImports(f);
      // One bounded lineage hop for composed constructors (`const RetryOctokit =
      // Octokit.plugin(retry)`) — see composedSdkCtors.
      const composedCtors = this.composedSdkCtors(f, bareImports);
      const composedInstances = this.composedInstanceBindings(f, composedCtors);
      for (const call of f.calls) {
        const callerId = this.enclosingId(call, f.path);
        if (!callerId || !scopedFnIds.has(callerId)) continue;
        // Attribute egress for every traversable caller — top-level functions, class
        // non-constructor methods, and object-literal-property methods (the react-admin
        // dataProvider pattern) — matching the internal call graph. Constructors are skipped.
        if (!egressTraversableCaller(call)) continue;

        // Registry: `Sentry.addBreadcrumb(…)` (namespace) / `loadStripe(…)` (factory) /
        // `new Anthropic()` (constructor handled in registryNewExternals below).
        const reg = matchRegistrySdk(call, callerId, f.path, bareImports);
        if (reg) {
          push(reg);
          continue;
        }

        // Method call on an instance of a composed ctor (`octokit.graphql.paginate(…)`).
        // No profile matcher can express this receiver — `newInstanceOf` is gated on the
        // ctor being IMPORTED, and a plugin-composed ctor is a local binding — so the
        // lineage lane carries the method calls itself.
        if (composedInstances.size) {
          const composedFact = this.matchComposedInstanceSdk(call, f.path, callerId, composedInstances);
          if (composedFact) {
            push(composedFact);
            continue;
          }
        }

        // Receiver-less bare-callee http (browser `fetch('/api', {method})`).
        if (!call.receiver && call.methodName) {
          const fact = this.matchBareFetch(call, f.path, callerId, matchers);
          if (fact) {
            push(fact);
            continue;
          }
        }
        if (!call.methodName || !call.receiver) continue;
        // new-instance SDK egress on a `new <Ctor>()`-bound instance.
        if (fileInstances) {
          const fact = this.matchNewInstanceSdk(call, f.path, callerId, fileInstances, matchers);
          if (fact) {
            push(fact);
            continue;
          }
        }
        const fact = this.matchExternal(call, f.path, callerId, matchers);
        if (fact) push(fact);
      }
      // Registry: `new <Ctor>()` constructor egress (`new OpenAI()`), import-anchored —
      // or anchored through the composed-ctor lineage (`new RetryOctokit()`).
      for (const fact of this.registryNewExternals(f, bareImports, composedCtors, scopedFnIds)) push(fact);
    }
    return out;
  }

  /**
   * SDK constructor egress: `new <Ctor>(…)` where `<Ctor>` is a registry package import,
   * or a local ctor composed from one (`composedCtors` — `const RetryOctokit =
   * Octokit.plugin(retry)`).
   */
  private registryNewExternals(
    f: StructuralFile,
    bareImports: Map<string, { modulePath: string; kind: 'default' | 'named' | 'namespace' }>,
    composedCtors: Map<string, string>,
    scopedFnIds: Set<string>,
  ): ExternalCallFact[] {
    const root = this.cstRoots.get(f.path);
    if (!root) return [];
    const out: ExternalCallFact[] = [];
    const visit = (n: TsNode): void => {
      if (n.type === 'new_expression') {
        const ctorNode = n.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression');
        const ctorName = text(ctorNode);
        const localName = ctorName.split('.')[0];
        const modulePath = bareImports.get(localName)?.modulePath ?? composedCtors.get(localName);
        const pkg = modulePath ? lookupSdkByPackage(modulePath) : undefined;
        if (modulePath && pkg) {
          const startLine = n.startPosition.row + 1;
          const callerId = this.enclosingFnIdByLine(f, startLine);
          if (callerId && scopedFnIds.has(callerId)) {
            out.push({
              callerId,
              serviceName: pkg.service,
              sdkName: modulePath,
              method: 'new',
              location: { filePath: f.path, startLine, endLine: n.endPosition.row + 1 },
              protocol: pkg.protocol,
              targetService: pkg.protocol === 'http' || pkg.protocol === 'grpc' ? pkg.service : undefined,
            });
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(root);
    return out;
  }

  /**
   * ONE bounded lineage hop for composed constructors — the Octokit plugin idiom:
   *
   *   import { Octokit } from '@octokit/core';
   *   const RetryOctokit = Octokit.plugin(retry);   // ← this map: RetryOctokit → '@octokit/core'
   *
   * A local const bound to a STATIC METHOD CALL on an identifier that already carries a
   * registry identity (an SDK-package import, or an earlier composed ctor in the same file)
   * inherits that identity. Three detector paths skip this idiom today: `matchRegistrySdk`
   * rejects a named-import receiver (correctly — `Octokit.plugin()` is not egress),
   * `registryNewExternals` sees a local ctor with no import, and the instance receiver is a
   * local binding. Same file only, source order only — no flow analysis: a name reassigned
   * or composed across files is simply absent.
   */
  private composedSdkCtors(
    f: StructuralFile,
    bareImports: Map<string, { modulePath: string; kind: 'default' | 'named' | 'namespace' }>,
  ): Map<string, string> {
    const out = new Map<string, string>();
    const root = this.cstRoots.get(f.path);
    if (!root) return out;
    for (const decl of this.descendantsOfType(root, 'variable_declarator')) {
      const varName = text(decl.childForFieldName('name'));
      const value = decl.childForFieldName('value');
      if (!varName || value?.type !== 'call_expression') continue;
      const fn = value.childForFieldName('function');
      if (fn?.type !== 'member_expression') continue;
      // Receiver root: `Octokit` in `Octokit.plugin(retry)`, and in a chained
      // `Octokit.plugin(a).plugin(b)` too (the chain's head is still the SDK class).
      const receiverRoot = text(fn.childForFieldName('object')).split(/[.(]/)[0];
      const modulePath = bareImports.get(receiverRoot)?.modulePath ?? out.get(receiverRoot);
      if (!modulePath || !lookupSdkByPackage(modulePath)) continue;
      out.set(varName, modulePath);
    }
    return out;
  }

  /**
   * Local bindings of a composed-ctor instance: `const inst = new RetryOctokit(…)` and the
   * plain-assignment form (`octokitInstance = new RetryOctokit(…)` onto a module-level
   * `let`), mapped to the SDK package the ctor inherited. Same file only.
   */
  private composedInstanceBindings(f: StructuralFile, composedCtors: Map<string, string>): Map<string, string> {
    const out = new Map<string, string>();
    if (!composedCtors.size) return out;
    const root = this.cstRoots.get(f.path);
    if (!root) return out;
    const bind = (target: TsNode | null, value: TsNode | null): void => {
      if (target?.type !== 'identifier' || value?.type !== 'new_expression') return;
      const ctorNode = value.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression');
      const modulePath = composedCtors.get(text(ctorNode).split('.')[0]);
      if (modulePath) out.set(text(target), modulePath);
    };
    for (const decl of this.descendantsOfType(root, 'variable_declarator')) {
      bind(decl.childForFieldName('name'), decl.childForFieldName('value'));
    }
    for (const assign of this.descendantsOfType(root, 'assignment_expression')) {
      bind(assign.childForFieldName('left'), assign.childForFieldName('right'));
    }
    return out;
  }

  /** `instance.method()` on a composed-ctor instance → registry SDK egress. */
  private matchComposedInstanceSdk(
    call: StructuralCall,
    file: string,
    callerId: string,
    composedInstances: Map<string, string>,
  ): ExternalCallFact | undefined {
    if (!call.receiver || !call.methodName) return undefined;
    const rootIdent = call.receiver.split('.')[0];
    const modulePath = composedInstances.get(rootIdent);
    const pkg = modulePath ? lookupSdkByPackage(modulePath) : undefined;
    if (!modulePath || !pkg) return undefined;
    // Method chain after the instance, e.g. `graphql.paginate` — same reading as the
    // profile-declared new-instance lane (matchNewInstanceSdk).
    const expr = call.expressionText;
    const method = expr.startsWith(`${rootIdent}.`)
      ? expr.slice(rootIdent.length + 1).replace(/\(.*$/, '')
      : call.methodName;
    return {
      callerId,
      serviceName: pkg.service,
      sdkName: modulePath,
      method,
      location: { filePath: file, startLine: call.startLine, endLine: call.endLine },
      protocol: pkg.protocol,
      targetService: pkg.protocol === 'http' || pkg.protocol === 'grpc' ? pkg.service : undefined,
    };
  }

  /**
   * Enclosing function/method id of a 1-based line via class/method then function span
   * containment. Constructors and object-literal methods are skipped — ts-morph's egress
   * detector never traverses those bodies, so attributing an SDK `new` there would over-emit.
   */
  private enclosingFnIdByLine(f: StructuralFile, line: number): string | undefined {
    for (const c of f.classes) {
      for (const m of c.methods) {
        if (m.name === 'constructor') continue;
        if (m.startLine <= line && line <= m.endLine) return this.idGen.methodId(f.path, c.name, m.name);
      }
    }
    for (const fn of f.functions) {
      if (fn.startLine <= line && line <= fn.endLine) return this.idGen.functionId(f.path, fn.name);
    }
    return undefined;
  }

  /**
   * Per-file map `ctorName -> Set(localVarName)` for every `const v = new <Ctor>(…)` whose
   * `<Ctor>` is one of the `newInstanceOf` SDK matchers and (when `fromModule` is set) is
   * imported from that module — the ts-morph engine's `trackNewInstances` provenance gate.
   */
  private buildNewInstanceMap(matchers: ExternalClientMatcher[]): Map<string, Map<string, Set<string>>> {
    const sdkMatchers = matchers.filter(
      (m): m is Extract<ExternalClientMatcher, { kind: 'sdk' }> =>
        m.kind === 'sdk' && 'newInstanceOf' in m && !!m.newInstanceOf,
    );
    const byFile = new Map<string, Map<string, Set<string>>>();
    if (!sdkMatchers.length) return byFile;

    for (const f of this.scopedFiles) {
      const root = this.cstRoots.get(f.path);
      if (!root) continue;
      const declarators: TsNode[] = [];
      const collect = (n: TsNode): void => {
        if (n.type === 'variable_declarator') declarators.push(n);
        for (const c of n.namedChildren) collect(c);
      };
      collect(root);
      for (const decl of declarators) {
        const value = decl.childForFieldName('value');
        if (value?.type !== 'new_expression') continue;
        const ctorNode = value.namedChildren.find((c) => c.type === 'identifier' || c.type === 'member_expression');
        if (!ctorNode) continue;
        const ctorName = text(ctorNode);
        const ctorTail = ctorName.split('.').pop() ?? ctorName;
        const varName = text(decl.childForFieldName('name'));
        if (!varName) continue;
        for (const m of sdkMatchers) {
          if (ctorTail !== m.newInstanceOf) continue;
          if (m.fromModule && !this.ctorImportedFrom(f, m.newInstanceOf!, m.fromModule)) continue;
          let byCtor = byFile.get(f.path);
          if (!byCtor) {
            byCtor = new Map();
            byFile.set(f.path, byCtor);
          }
          let set = byCtor.get(m.newInstanceOf!);
          if (!set) {
            set = new Set();
            byCtor.set(m.newInstanceOf!, set);
          }
          set.add(varName);
        }
      }
    }
    return byFile;
  }

  /** True when `ctor` is imported (default/named/namespace) from `fromModule` in `file`. */
  private ctorImportedFrom(file: StructuralFile, ctor: string, fromModule: string): boolean {
    for (const imp of file.imports) {
      if (imp.moduleSpecifier !== fromModule) continue;
      if (imp.kind === 'default' && imp.names.some((n) => n.name === ctor)) return true;
      if (imp.kind === 'namespace' && imp.names.some((n) => n.name === ctor.split('.')[0])) return true;
      if (imp.kind === 'named' && imp.names.some((n) => (n.alias ?? n.name) === ctor)) return true;
    }
    return false;
  }

  /** `instance.method()` on a `new <Ctor>()`-bound instance → SDK egress (provenance). */
  private matchNewInstanceSdk(
    call: StructuralCall,
    file: string,
    callerId: string,
    fileInstances: Map<string, Set<string>>,
    matchers: ExternalClientMatcher[],
  ): ExternalCallFact | undefined {
    const receiver = call.receiver!;
    const rootIdent = receiver.split('.')[0];
    const loc: SubstrateLoc = { filePath: file, startLine: call.startLine, endLine: call.endLine };
    for (const m of matchers) {
      if (m.kind !== 'sdk' || !('newInstanceOf' in m) || !m.newInstanceOf) continue;
      if (!fileInstances.get(m.newInstanceOf)?.has(rootIdent)) continue;
      // Method chain after the instance, e.g. `messages.create`.
      const expr = call.expressionText;
      const sdkMethod = expr.startsWith(`${rootIdent}.`)
        ? expr.slice(rootIdent.length + 1).replace(/\(.*$/, '')
        : (call.methodName ?? '');
      return { callerId, serviceName: m.serviceName, sdkName: m.sdkName, method: sdkMethod, location: loc };
    }
    return undefined;
  }

  /** Browser `fetch('/api/x', { method })` → linkable HTTP egress (receiver-less bareCallee). */
  private matchBareFetch(
    call: StructuralCall,
    file: string,
    callerId: string,
    matchers: ExternalClientMatcher[],
  ): ExternalCallFact | undefined {
    const loc: SubstrateLoc = { filePath: file, startLine: call.startLine, endLine: call.endLine };
    for (const m of matchers) {
      if (m.kind !== 'http' || !('bareCallee' in m) || m.bareCallee !== call.methodName) continue;
      // Host discriminator: a matcher with `urlPattern` claims ONLY calls whose URL
      // (with host/prefix interpolations inlined — `${this.apiBase}` → the concrete
      // host) matches. Non-matching → try the NEXT matcher, so multiple `fetch`
      // matchers don't collapse to the first; a pattern-less matcher is the fallback.
      if (m.urlPattern !== undefined) {
        const hostArg = this.inlineUrlHostsForMatch(call.arguments?.[m.url?.arg ?? 0], file);
        // Strip the literal's surrounding quotes/backticks so the pattern matches the
        // URL value itself (an anchored `^https://…` works as authored).
        const hostUrl = hostArg !== undefined ? unquote(hostArg.trim()) : undefined;
        if (hostUrl === undefined || !regexFromSource(m.urlPattern).test(hostUrl)) continue;
      }
      // The URL argument exactly as written at the call site. Captured BEFORE any const
      // inlining because it is the only form that still shows whether the host was typed
      // here or came from the repo — see routePathFromUrl.
      const urlArgText = m.url ? call.arguments?.[m.url.arg] : undefined;
      // Inline `${CONST}` string consts BEFORE route extraction so a leading
      // const route-prefix (`${BASE}/…`) isn't mistaken for a config host and
      // dropped by templateTailRoute (see inlineStringConstInterpolations).
      const rawUrlArg = m.url ? this.inlineStringConstInterpolations(urlArgText, file) : undefined;
      const rawUrl = m.url ? resolveHttpUrl(rawUrlArg, m.url) : undefined;
      // Resolve `${CONST}` prefix interpolations surviving as `{IDENT}` placeholders to
      // their string-const value (e.g. `const BASE = 'foo'` → `/${BASE}/items/${x}` →
      // `/foo/items/{x}`), so a const-prefixed egress URL matches a concrete entrypoint.
      // Path PARAMS (`{id}`) don't resolve to a const → left as-is.
      const resolvedUrl = rawUrl?.replace(/\{([A-Za-z_$][\w$]*)\}/g, (full, ident) => {
        const v = this.resolveConst(ident, file);
        return typeof v === 'string' && v.length > 0 ? v : full;
      });
      // An absolute URL whose host came from an IN-REPO const still routes on its path;
      // one written absolute at the call site is third-party by construction and stays
      // unresolved. `urlArgText` (pre-inlining) is what draws that line — see
      // routePathFromUrl. Matched the callee but no linkable path → still a match (stop),
      // no fact (mirrors ts-morph).
      const url = routePathFromUrl(resolvedUrl, urlArgText);
      if (!url) return undefined;
      // Keep the host the substrate resolved rather than discarding it with the prefix.
      const absoluteTarget = resolvedUrl && resolvedUrl !== url ? resolvedUrl : undefined;
      // A positional method arg (e.g. `sendRequest(data, 'POST', url)`) wins when it
      // names a known verb; otherwise fall back to the `{ method }` 2nd-arg option / GET.
      const positionalMethod = m.methodArg ? bareStringVerb(call.arguments?.[m.methodArg.arg]) : undefined;
      const httpMethod = positionalMethod ?? fetchMethodFromOpts(call.arguments?.[1]);
      // Config-driven target service: a token read from the call (CONFIG.<token> arg /
      // uri-template member) translated through serviceMap. Unmapped → undefined.
      const targetService = m.serviceSelector
        ? resolveServiceSelector(m.serviceSelector, call.arguments ?? [], url)
        : undefined;
      return {
        callerId,
        serviceName: m.serviceName,
        sdkName: m.sdkName,
        method: httpMethod,
        location: loc,
        http: { method: httpMethod, pathTemplate: url },
        ...(absoluteTarget ? { targetPattern: absoluteTarget } : {}),
        targetService,
      };
    }
    return undefined;
  }

  private matchExternal(
    call: StructuralCall,
    file: string,
    callerId: string,
    matchers: ExternalClientMatcher[],
  ): ExternalCallFact | undefined {
    const receiver = call.receiver!;
    const methodName = call.methodName!;
    const propName = receiver.startsWith('this.') ? receiver.slice('this.'.length) : receiver;
    const diClass = this.diMap.get(file)?.get(propName);
    const loc: SubstrateLoc = { filePath: file, startLine: call.startLine, endLine: call.endLine };
    // Root DI prop of a (possibly chained) receiver, e.g. `apiClient` in
    // `this.apiClient.authSessions` → import-provenance lookup.
    const rootProp = propName.split('.')[0];
    const diImportMod = this.diImportModule.get(file)?.get(rootProp);

    for (const m of matchers) {
      if (m.kind === 'imported-sdk') {
        if (diImportMod === undefined || !moduleMatchesProvenance(diImportMod, m)) continue;
        const segment = importedSdkSegment(propName, rootProp);
        const serviceName =
          m.serviceFromSegment && segment ? `${m.serviceSegmentPrefix ?? ''}${segment}` : m.serviceName;
        const fact: ExternalCallFact = {
          callerId,
          serviceName,
          sdkName: m.sdkName,
          method: methodName,
          location: loc,
        };
        // SDK-mediated: tag with the package moniker so the symbol hop can join. The
        // package is the matched provenance module; the descriptor is the member chain
        // tail (`<segment>.<method>`), the raw form the normalizer keys off at link time.
        const pkg = Array.isArray(m.fromModule) ? m.fromModule[0] : (m.fromModule ?? diImportMod);
        if (pkg) {
          const descriptor = segment ? `${segment}#${methodName}().` : `${methodName}().`;
          fact.moniker = { packageName: pkg, descriptor };
        }
        if (m.protocol === 'http' || m.protocol === 'grpc') {
          fact.protocol = m.protocol;
          fact.targetService = segment;
        } else if (m.protocol === 'messaging') {
          fact.protocol = 'messaging';
        }
        return fact;
      }
      if (m.kind === 'sdk') {
        const byDi = diClass !== undefined && (m.diTypeSuffix ?? []).some((s) => diClass.endsWith(s));
        const byReceiver = m.receiverPattern !== undefined && regexFromSource(m.receiverPattern).test(receiver);
        if (byDi || byReceiver) {
          return {
            callerId,
            serviceName: m.serviceName,
            sdkName: m.sdkName ?? (byDi ? diClass : undefined),
            method: methodName,
            location: loc,
          };
        }
        continue;
      }
      // bareCallee http (fetch) + new-instance sdk are ts-morph-only frontend
      // matchers; the substrate doesn't classify them.
      if (m.kind === 'http' && 'bareCallee' in m) continue;
      if (!externalReceiverMatches(receiver, propName, m)) continue;
      if (m.kind === 'http') {
        if (!('verbs' in m) || !m.verbs.includes(methodName)) continue;
        // Inline `${CONST}` string consts BEFORE route extraction so a leading
        // const route-prefix (`${BASE}/…`) isn't mistaken for a config host and
        // dropped by templateTailRoute (see inlineStringConstInterpolations).
        const rawUrlArg = m.url ? this.inlineStringConstInterpolations(call.arguments?.[m.url.arg], file) : undefined;
        const rawPathTemplate = m.url ? resolveHttpUrl(rawUrlArg, m.url) : undefined;
        // Resolve `${CONST}` prefix interpolations that survive as `{IDENT}` placeholders
        // to their string-const value (e.g. `const BASE = 'foo'` → `/${BASE}/items/${x}`
        // → `/foo/items/{x}`), so a const-prefixed egress URL matches a concrete
        // entrypoint. Path PARAMS (`{id}`) don't resolve to a const → left as-is.
        const pathTemplate = rawPathTemplate?.replace(/\{([A-Za-z_$][\w$]*)\}/g, (full, ident) => {
          const v = this.resolveConst(ident, file);
          return typeof v === 'string' && v.length > 0 ? v : full;
        });
        // The HTTP verb: read from an arg (request-wrapper `{ method: 'POST' }`) when
        // `httpMethodFrom` is set, else the matched method name upper-cased (axios-style
        // `client.get(url)`). Falls back to the method name when the arg has no verb.
        const httpMethod =
          (m.httpMethodFrom
            ? resolveHttpMethodArg(call.arguments?.[m.httpMethodFrom.arg], m.httpMethodFrom)
            : undefined) ?? methodName.toUpperCase();
        // Config-driven target service: a token read from the call (CONFIG.<token> arg /
        // uri-template member) translated through serviceMap. Unmapped → undefined.
        // The uri-template selector reads from the SAME arg the URL lives in.
        const selectorUrlArg =
          m.serviceSelector?.via === 'uri-template' ? call.arguments?.[m.url?.arg ?? 0] : undefined;
        const targetService = m.serviceSelector
          ? resolveServiceSelector(m.serviceSelector, call.arguments ?? [], selectorUrlArg)
          : undefined;
        // Dynamic-dispatch wrappers (`this.performApiRequest('listResources', …)`)
        // carry the SDK method NAME in a positional string-literal arg; capture it onto
        // `dispatchMethod` so the cross-repo sdkMapping fallback can resolve it. A
        // non-literal arg (`performApiRequest(method, …)`) yields undefined (unresolved).
        const dispatchMethod = m.methodNameArg
          ? bareStringMethodName(call.arguments?.[m.methodNameArg.arg])
          : undefined;
        return {
          callerId,
          serviceName: m.serviceName,
          sdkName: m.sdkName,
          method: httpMethod,
          location: loc,
          http: pathTemplate ? { method: httpMethod, pathTemplate } : undefined,
          targetService,
          ...(dispatchMethod ? { dispatchMethod } : {}),
        };
      }
      if (m.kind === 'queue') {
        if (!m.methods.includes(methodName)) continue;
        const raw = call.arguments?.[m.topic.arg];
        // A topic written through a local const (`const t = …; emit(t, …)`) resolves via ONE
        // in-scope hop back to its initializer, re-read with this rule's own topic mode.
        const topic = resolveQueueTopicReference(
          raw,
          m.topic,
          (ref) => this.baseline.resolver.resolve(ref, file),
          (name) => this.localBindingInitializer(file, name, call.startLine),
        );
        // Drop empty/unresolvable topics rather than emit `topic: ''`.
        if (topic === undefined) continue;
        return {
          callerId,
          serviceName: m.system,
          method: methodName,
          location: loc,
          messaging: {
            system: m.system,
            destination: topic.topic,
            ...(topic.topicValue ? { destinationValue: topic.topicValue } : {}),
          },
        };
      }
    }
    return undefined;
  }
}
