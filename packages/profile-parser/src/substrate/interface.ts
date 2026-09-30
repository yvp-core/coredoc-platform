/**
 * Substrate — the backend-neutral fact interface the profile primitives read.
 *
 * It exposes exactly the facts an ExtractionProfile needs, decoupled from HOW
 * those facts are produced. The tree-sitter+SCIP engine (see tree-sitter-scip.ts)
 * reads them off web-tree-sitter structural output + the SCIP semantic graph
 * from the facts layer (../facts).
 *
 * The capability the StructuralCall abstraction lacks — nesting-aware call-shape
 * queries over RAW CST with structured argument access and an in-file const
 * resolver — lives behind `callShapes(...)`. Everything else maps to the
 * structural facts the baseline already produces.
 */
import type { StableIdGenerator } from '@coredoc/core';
import type { CallProvenance } from '@coredoc/core/types';
import type { ExternalClientMatcher, ImportResolution, RouteRule, StateStoreRule } from '../types.js';

export interface SubstrateLoc {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface SubstrateParam {
  name: string;
  type?: string;
}

export interface SubstrateMethod {
  name: string;
  decorators: string[];
  params: SubstrateParam[];
  isStatic: boolean;
  visibility: 'public' | 'private' | 'protected';
  loc: SubstrateLoc;
}

export interface SubstrateProperty {
  name: string;
  decorators: string[];
  type?: string;
  loc: SubstrateLoc;
}

export interface SubstrateClass {
  name: string;
  /** Full decorator text, e.g. `Controller('v2/x')`, `ManyToOne(() => Companies)`. */
  decorators: string[];
  methods: SubstrateMethod[];
  properties: SubstrateProperty[];
  /** Constructor params (param name → type) — the DI primitive. */
  ctorParams: SubstrateParam[];
  /**
   * `extends Base<...>` heritage: base-class name + generic type-arg texts. Undefined
   * when the class has no `extends` clause. Drives repo-base-class entity resolution.
   */
  extendsClass?: { name: string; typeArgs: string[] };
  loc: SubstrateLoc;
}

export interface SubstrateFunction {
  name: string;
  isExported: boolean;
  loc: SubstrateLoc;
}

// ── Call-shape query ─────────────────────────────────────────────────────────

/**
 * A structured argument node from a raw-CST call site. Only the shapes the
 * profile ArgRefs need are surfaced.
 */
export interface ArgNode {
  /** `'foo'` → "foo" (quotes stripped). */
  stringLiteral?: string;
  /** A bare identifier argument → its text. */
  identifier?: string;
  /** `() => Companies` → "Companies". */
  arrowTargetIdent?: string;
  /** Object-literal entries (one level), value text + nested object when present. */
  objectEntries?: { key: string; valueText: string; valueObject?: ArgNode['objectEntries'] }[];
  /** Member-expression property tail, e.g. `models.Target` → "Target". */
  memberProperty?: string;
  /**
   * When the arg is a call expression: the callee name + its first argument text.
   * e.g. for `topicFor(Topics.EntityUpdatedV1)`:
   *   callExpr: { callee: 'topicFor', firstArgText: 'Topics.EntityUpdatedV1' }
   * Used by the `wrapped-enum-member` ArgRef to detect and unwrap wrapper calls.
   */
  callExpr?: { callee: string; firstArgText: string };
  /** Raw expression text of the argument (always present). */
  text: string;
}

export interface CallSite {
  /** Full callee text, e.g. `router.get`, `sequelize.define`, `initHandler`. */
  calleeText: string;
  /** Receiver (object) text for member calls, e.g. `router`; undefined for bare calls. */
  receiver?: string;
  /** Method/property for member calls, or the bare callee name. */
  method?: string;
  args: ArgNode[];
  /**
   * Variable receiving the outermost chain result when this call is the chain's head or a
   * link in it: `const sub = program.command('x').description(…)` → "sub". Undefined when
   * the result is not assigned (statement position, argument position, etc.).
   */
  assignedTo?: string;
  /** Enclosing call sites, innermost-last (e.g. the `router.extend(BASE, fn)` wrapper). */
  enclosingCallChain: CallSite[];
  file: string;
  loc: SubstrateLoc;
}

/** A scoped, DI-corrected internal call edge (caller/callee are graph node ids). */
export interface CallEdgeFact {
  id: string;
  callerId: string;
  calleeId?: string;
  /** How `calleeId` was resolved ('scip' | 'di'); absent when unresolved. See CallProvenance. */
  provenance?: CallProvenance;
  calleeExpression: string;
  isMethodCall: boolean;
  location: SubstrateLoc;
  arguments?: string[];
}

// ── Frontend: JSX component / render-edge query ──────────────────────────────

/** A PascalCase JSX tag rendered in a component body (incl. RR route props). */
export interface JsxTag {
  /** Local binding name (head of `Foo.Bar` → `Foo`). */
  name: string;
  line: number;
}

/** A React component declaration discovered on the raw CST (frontend analogue of a CallSite). */
export interface ComponentSite {
  name: string;
  file: string;
  componentType: 'functional' | 'class';
  loc: SubstrateLoc;
  /** PascalCase JSX tags rendered in the body (deduped by name+line). */
  childTags: JsxTag[];
}

/**
 * A `<Route>` JSX usage discovered on the raw CST. Carries the route path plus
 * the component reference (from `component={X}` or `render={() => <X/>}`) as a
 * tag name + reference line so the SCIP resolver can map it to a component id —
 * the same mechanism childComponents use. `path` may be undefined for config-only
 * usages; `componentName`/`componentLine` are undefined when no component prop.
 */
export interface RouteSite {
  path: string;
  componentName: string;
  /** 1-based line of the component reference occurrence (for SCIP resolution). */
  componentLine: number;
  file: string;
  /**
   * Set by readers that follow the component reference THEMSELVES (the recordTable
   * two-hop: route → scene key → `() => import('<module>')` → the module's default
   * export). Its presence tells the engine not to run the SCIP/import/lazy fallback
   * chain — at a table-entry line the only symbols are table keys, so re-resolving
   * there could only fabricate. `resolved` absent = the hop dead-ended: the route is
   * still emitted, name-only.
   */
  resolution?: { resolved?: { filePath: string; declaredName: string } };
  /** The route loads its component through a dynamic import. Defaults to false. */
  isLazy?: boolean;
}

/** A state-store factory call (`create(...)`) bound to an exported const. */
export interface StateStoreSite {
  storeName: string;
  file: string;
  loc: SubstrateLoc;
  /** Object-literal keys with function values → actions; others → selectors. */
  actions: { name: string; loc: SubstrateLoc }[];
  selectors: { name: string; loc: SubstrateLoc }[];
}

/** A scoped external egress edge (filtered to curated matchers). */
export interface ExternalCallFact {
  callerId: string;
  serviceName: string;
  sdkName?: string;
  method: string;
  /**
   * Dynamic-dispatch SDK method name read from a positional string-literal arg
   * (`this.performApiRequest('listResources', …)`). When set, `method` holds only
   * the wrapper verb; this carries the real SDK method so the cross-repo sdkMapping
   * fallback can resolve `(sdkName, dispatchMethod)` → route. Unset for ordinary calls.
   */
  dispatchMethod?: string;
  location: SubstrateLoc;
  http?: { method: string; pathTemplate: string };
  /**
   * The full absolute URL, when the host resolved from an in-repo const. `pathTemplate`
   * carries only the path (that is what the linker joins on), so without this the host
   * the substrate DID resolve would be thrown away. Absent when the URL was relative.
   */
  targetPattern?: string;
  /** Broker-agnostic destination extracted by a queue matcher. */
  messaging?: {
    system: string;
    /** Destination token/reference as written at the call site. */
    destination: string;
    /** Runtime destination when the token is statically resolvable. */
    destinationValue?: string;
  };
  /**
   * Registry-driven SDK egress (`loadStripe(…)`, `Sentry.init(…)`, `new OpenAI()`)
   * carries a transport protocol + target-service hint instead of an http path or
   * messaging destination; mirrors the ts-morph base parser's SDK_PACKAGES detector.
   */
  protocol?: 'http' | 'grpc' | 'sdk' | 'messaging';
  targetService?: string;
  /**
   * Raw SCIP package moniker for SDK-mediated egress (consumer side), carried from
   * the substrate to the emitted ExternalCallEdge. { packageName, raw descriptor tail }.
   */
  moniker?: { packageName: string; descriptor: string };
}

/**
 * Backend (code-structure) capabilities: files, classes, functions, the raw-CST call-shape
 * query, const/registry resolution, and the SCIP call graph. A backend-only language
 * substrate (Go/Java/Ruby-via-interface) implements THIS — it must not be forced to stub
 * the frontend (JSX/route/state-store) methods, which live in `FrontendSubstrate` (ISP).
 */
export interface BackendSubstrate {
  /** Files already scoped to the profile include/exclude globs. */
  files(): { relativePath: string }[];
  classes(): SubstrateClass[];
  functions(): SubstrateFunction[];
  /**
   * RAW-CST call-shape query. `calleePattern` supports an exact callee, a
   * `recv.*` glob (any method on a receiver), or `*.method` (any receiver).
   * Pass undefined to get every call site (scoped to include globs).
   */
  callShapes(calleePattern?: string): CallSite[];
  /** Resolve an identifier to its in-file string-literal const declaration. */
  resolveConst(ident: string, file: string): string | undefined;
  /**
   * Resolve a `Obj.MEMBER` const-object member reference (e.g. `IpcChannels.CHAT_SEND`)
   * to its string-literal value, scanning const-object literals across scoped files.
   * The cross-file, object-member analogue of `resolveConst` — for channel/route maps
   * declared as `export const X = { A: 'a', … }`. Undefined when it doesn't resolve.
   */
  resolveConstMember(qualifiedRef: string): string | undefined;
  /**
   * Walk a require/alias registry object literal (the `handlerTable` primitive):
   * `const <registryVar> = { a: { b: require("app/x") } }` → alias→file map
   * (nested aliases joined by `.`, `require()` leaves filtered to `requirePrefix`).
   */
  requireRegistry(args: {
    registryVar: string;
    inFile: string;
    nested: boolean;
    requirePrefix: string;
  }): Map<string, string>;
  /** SCIP internal calls, scoped + DI-corrected for member chains. */
  internalCalls(): CallEdgeFact[];
  /** SCIP externals filtered by the profile's externalCalls matchers. */
  externalCalls(matchers: ExternalClientMatcher[]): ExternalCallFact[];
  /** Function-id existence probe (mirrors the golden's resolved-handler gate). */
  hasFunctionId(id: string): boolean;
  /** Resolve a method id on a class by name (DI target resolution). */
  resolveMethodOnClass(className: string, methodName: string): string | undefined;
  /** Resolve a top-level function id by (file, name). */
  functionId(filePath: string, name: string): string | undefined;
  /**
   * Tightest already-emitted function node whose span contains (filePath, line) —
   * how a caller is attributed for a call site known only by location (e.g. a
   * custom rule reading raw call shapes). Undefined at module top level.
   */
  enclosingFunctionId(filePath: string, line: number): string | undefined;
  idGen: StableIdGenerator;
}

/**
 * Frontend (React/JSX) capabilities: component declarations + JSX render tags, JSX-tag
 * resolution (SCIP + import paths), React-Router route sites, and state-store factory sites.
 * Segregated from {@link BackendSubstrate} so a backend-only language substrate need not
 * stub them (ISP).
 */
export interface FrontendSubstrate {
  /**
   * Frontend: RAW-CST query for React component declarations + their JSX child
   * render tags. The frontend analogue of `callShapes`.
   */
  componentSites(opts: { functionalInExtensions?: string[]; classComponents?: boolean }): ComponentSite[];
  /**
   * Resolve a JSX tag (a reference occurrence at `file:line`) to the
   * repo-relative file + declared name of the component it imports, using the
   * SCIP semantic index. Returns undefined when SCIP can't resolve it (external
   * package, dynamic tag, or no SCIP). This is the SCIP-vs-ts-morph resolution path.
   */
  resolveJsxTagBySCIP(
    file: string,
    tagName: string,
    line: number,
    isValid?: (filePath: string, declaredName: string) => boolean,
  ): { filePath: string; declaredName: string } | undefined;
  /**
   * Resolve a JSX tag to its declaring (file, name) by following the importing
   * file's import declarations + tsconfig (alias/baseUrl/relative + ext probing +
   * default-export HOC-peel) — the import-resolution path the ts-morph engine uses,
   * for the default-import / barrel cases SCIP records as document-`local` symbols.
   * Returns undefined when the specifier doesn't resolve in-scope.
   */
  resolveJsxTagByImport(
    file: string,
    tagName: string,
    imports: ImportResolution,
  ): { filePath: string; declaredName: string } | undefined;
  /**
   * Resolve a route/JSX component name that is bound in the SAME file to a lazy
   * dynamic import — `const X = lazy(() => import('./x.js'))` or
   * `const X = lazy(() => import('./x.js').then(m => ({ default: m.X })))`.
   * Neither the SCIP tag path nor the import path can reach those: the binding is
   * a document-`local` symbol and the specifier never appears in an
   * `import_statement`. Returns undefined when `name` is not such a binding;
   * returns `{ resolved: undefined }` when it IS one but the target can't be
   * resolved to a real component (the caller still knows the route is lazy).
   */
  resolveLazyComponentBinding(
    file: string,
    name: string,
    isValid?: (filePath: string, declaredName: string) => boolean,
  ): { resolved?: { filePath: string; declaredName: string } } | undefined;
  /**
   * Frontend: RAW-CST query for React-Router `<Route>` usages + config-array
   * `{ path, component }` entries, scoped to the rule's `inPaths`/`inPathContains`.
   * Each site carries the route path + the component reference (name + line) so
   * the componentId resolves through the same SCIP path childComponents use.
   *
   * `imports` (the profile's component import-resolution config) is needed only by
   * the `recordTable` reader, which resolves module specifiers itself.
   */
  routeSites(rule: RouteRule, imports?: ImportResolution): RouteSite[];
  /**
   * The declared name behind a file's `export default`, HOC-peeled. File-convention
   * routes have no component reference site to resolve, so the page's own default
   * export IS the component. Undefined when the file declares no default export or
   * the expression names nothing.
   *
   * `allowAnyCase` drops the PascalCase bias for consumers whose default export is a
   * FUNCTION, not a component — the Next.js pages-api handler lane (`export default
   * handler`, `export default (req, res) => apiWrapper(req, res, handler)`). It reads
   * the same statement under a different rule (bare identifier, else the one identifier
   * in the expression that names a function declared in the same file); page-component
   * resolution keeps the PascalCase reading unchanged.
   */
  defaultExportedName(file: string, opts?: { allowAnyCase?: boolean }): string | undefined;
  /**
   * Frontend: RAW-CST query for state-store factory calls
   * (`export const X = create((set,get) => ({…}))`), scoped to the rule's
   * `inPaths` and gated on the factory being imported from `fromModule`.
   */
  stateStoreSites(rule: StateStoreRule): StateStoreSite[];
  idGen: StableIdGenerator;
}

/**
 * The full substrate — backend code structure AND frontend (JSX) extraction. A combined
 * substrate (e.g. `TreeSitterScipSubstrate` for TS/JS) implements both halves; the
 * `SubstrateProfileEngine` consumes the union because it runs both passes in one profile
 * run. Backend-only substrates implement {@link BackendSubstrate} alone.
 */
export interface Substrate extends BackendSubstrate, FrontendSubstrate {}

/**
 * Vue SFC capabilities: one component per `.vue` file plus template-tag resolution. Separate
 * from {@link FrontendSubstrate} (ISP) — the JSX walk and the template scan share nothing but
 * the emitted shape, and only a substrate that parses `.vue` script blocks can offer these.
 */
export interface VueSubstrate {
  /** One site per scoped `.vue` file, with its `<template>` child-component tags. */
  vueComponentSites(): ComponentSite[];
  /**
   * Resolve a Vue template tag to its declaring file + component name through the script
   * block's imports (SCIP never indexes `.vue`). Undefined when the tag names no import or
   * the specifier does not resolve in scope.
   */
  resolveVueTagByImport(
    file: string,
    tagName: string,
    imports: ImportResolution,
  ): { filePath: string; declaredName: string } | undefined;
}
