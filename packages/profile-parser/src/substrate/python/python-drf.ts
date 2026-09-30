/**
 * DRF router surface (audit gap G5): `router.register()` tables, NESTED routers, router-object
 * mounts, `@action` sub-routes, and handler wiring to the real ViewSet methods.
 *
 * What the urlconf lane alone got wrong, and why this module exists:
 *   - A nested registration (`projects_router.register(r"feature_flags", …)`) is not a top-level
 *     route: its real path is the PARENT's path plus the parent-lookup segment. Emitted flat, an
 *     entire product API lands on `/feature_flags/` — a path nothing serves, poisoning the
 *     cross-repo linker at both ends (the same failure `include()` mounts had).
 *   - A router is mounted by `path("api/", include(router.urls))`, where the mount argument is a
 *     VARIABLE, not a module string — so the module-following mount pass could never see it and
 *     every router route came out missing its `/api` prefix.
 *   - `@action(detail=True, url_path=…)` methods are additional routes on the registered prefix;
 *     none were extracted at all.
 *   - Route handlers were synthetic ids, so impact analysis dead-ended at every route.
 *
 * BOUNDED LINEAGE. Router variables are tracked across ROUTE FILES only (the files the profile's
 * `routeFileGlobs` selects) and are resolved by name: a local assignment first, else the file's
 * import table (`from posthog.api import router as root_router`). One hop, no re-export chains.
 * A router that arrives through a shape this cannot see (a tuple-unpacking helper return, a
 * function parameter) is marked OPAQUE: its registrations degrade to the file's own mount prefix
 * — exactly what the extractor emitted before this module existed, never a guessed prefix.
 *
 * VIEWSET RESOLUTION. The registered ViewSet expression is resolved to a class node through the
 * same one-hop import rule plus a same-file fallback, and its methods are collected along the
 * repo-declared base chain (capped, cycle-safe). Every emitted handlerId is the canonical id of a
 * method def that the def index also emits, so it always names a real FunctionNode; when the
 * class or method cannot be found the caller keeps the documented synthetic fallback.
 */
import type { HttpMethod, StableIdGenerator } from '@coredoc/core';
import {
  CLASS_DEF,
  FUNCTION_DEF,
  type PythonFile,
  type TsNode,
  baseNames,
  decoratorName,
  decoratorsOf,
  defName,
  pythonClassChain,
  pythonFunctionId,
  undecorate,
} from './python-cst.js';
import { type ImportTable, buildImportTable, resolveImportedTarget } from './python-imports.js';
import {
  calleeLastName,
  calleeReceiverName,
  keywordArg,
  normalizePath,
  positionalArgs,
  stringListValue,
  stringValue,
  templatize,
} from './python-urlconf.js';

/** One route the DRF lane resolves, with the file that declares it. */
export interface DrfRoute {
  method: HttpMethod;
  fullPath: string;
  line: number;
  /** The ViewSet method that serves it, when the class + method are resolvable. */
  handlerId?: string;
}

/**
 * The standard DRF `SimpleRouter` mapping — the collection/detail routes a registered ViewSet
 * exposes, each with the ViewSet method name that serves it. This is the action↔method map DRF
 * itself hardcodes in `SimpleRouter.routes`; it is a property of the router, not of any repo.
 */
const DRF_STANDARD_ROUTES: { method: HttpMethod; detail: boolean; action: string }[] = [
  { method: 'GET', detail: false, action: 'list' },
  { method: 'POST', detail: false, action: 'create' },
  { method: 'GET', detail: true, action: 'retrieve' },
  { method: 'PUT', detail: true, action: 'update' },
  { method: 'PATCH', detail: true, action: 'partial_update' },
  { method: 'DELETE', detail: true, action: 'destroy' },
];

/** HTTP methods an `@action(methods=[…])` may name (DRF lowercases them). */
const HTTP_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};

/** Decorator names that mark a DRF extra route (`@action`, `@decorators.action`). */
const ACTION_DECORATORS = ['action'];

/** How far a ViewSet's base chain is followed when looking for its methods. */
const MAX_BASE_HOPS = 6;

/** The `parent_lookup_` kwarg prefix drf-nested-routers/rest_framework_extensions generate. */
const PARENT_LOOKUP_PREFIX = 'parent_lookup_';

// =============================================================================
// Class index (ViewSet resolution)
// =============================================================================

interface ClassRef {
  relPath: string;
  node: TsNode;
}

/** Module-level classes across the repo, keyed `${relPath}#${name}` — the ViewSet lookup table. */
function buildClassIndex(files: PythonFile[]): Map<string, ClassRef> {
  const out = new Map<string, ClassRef>();
  for (const { relPath, root } of files) {
    for (const cls of root.descendantsOfType(CLASS_DEF) as TsNode[]) {
      // Module-level only: a ViewSet nested inside another class/def is not importable by the
      // dotted name a router registration writes, so indexing it could only mis-resolve.
      if (pythonClassChain(cls).length > 0) continue;
      const name = defName(cls);
      if (!name) continue;
      const key = `${relPath}#${name}`;
      if (!out.has(key)) out.set(key, { relPath, node: cls }); // first wins (same collapse as the def index)
    }
  }
  return out;
}

/**
 * A method def with the file that DECLARES it. The declaring file is carried because an inherited
 * method's canonical id is scoped to the BASE's file, not the subclass's — minting it against the
 * subclass would produce an id no FunctionNode has (a dangling handler).
 */
interface MethodRef {
  relPath: string;
  def: TsNode;
}

/** The DIRECT methods of a class body, by name (decorated defs unwrapped). */
function directMethods(cls: ClassRef): Map<string, MethodRef> {
  const out = new Map<string, MethodRef>();
  const body = cls.node.childForFieldName?.('body');
  const n = body?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = undecorate(body.namedChild?.(i) as TsNode);
    if (child?.type !== FUNCTION_DEF) continue;
    const name = defName(child);
    if (name && !out.has(name)) out.set(name, { relPath: cls.relPath, def: child });
  }
  return out;
}

// =============================================================================
// Router graph
// =============================================================================

interface RegisterSite {
  file: string;
  line: number;
  /** The registered prefix, already templatized. */
  prefix: string;
  /** The router variable the registration is called on ('projects_router'); undefined if not a bare name. */
  receiver?: string;
  /** `parents_query_lookups` as declared (4th positional arg or keyword) — the segment names. */
  lookups: string[];
  /** The registered ViewSet expression as written ('project.RootProjectViewSet'). */
  viewset?: string;
}

type RouterVar =
  | { kind: 'root' }
  | { kind: 'nested'; site: RegisterSite }
  /** Assigned by a shape this lane cannot follow (tuple unpacking, a helper's return value). */
  | { kind: 'opaque' };

/** `${relPath}#${varName}` — a router variable's repo-wide identity. */
function routerKey(file: string, name: string): string {
  return `${file}#${name}`;
}

/** The `parents_query_lookups` list of a nested `register(prefix, viewset, basename, lookups)` call. */
function registerLookups(call: TsNode): string[] {
  const positional = positionalArgs(call)[3];
  return stringListValue(positional) ?? stringListValue(keywordArg(call, 'parents_query_lookups')) ?? [];
}

/** Build a `RegisterSite` from a `X.register(...)` call, or undefined when the prefix is not a literal. */
function toRegisterSite(call: TsNode, file: string): RegisterSite | undefined {
  const args = positionalArgs(call);
  const first = args[0];
  if (first?.type !== 'string') return undefined; // a non-literal prefix has no derivable path
  const viewset = args[1];
  return {
    file,
    line: (call.startPosition?.row ?? 0) + 1,
    prefix: templatize(stringValue(first), true),
    receiver: calleeReceiverName(call),
    lookups: registerLookups(call),
    viewset: viewset?.type === 'identifier' || viewset?.type === 'attribute' ? (viewset.text as string) : undefined,
  };
}

// =============================================================================
// @action expansion
// =============================================================================

/** The `@action(...)` decorator call on a method def, if it carries one. */
function actionDecoratorCall(def: TsNode): TsNode | undefined {
  for (const dec of decoratorsOf(def)) {
    const name = decoratorName(dec);
    if (!ACTION_DECORATORS.some((n) => name === n || name.endsWith(`.${n}`))) continue;
    // The decorator's expression is its first non-`@` child; a bare `@action` (no call) has no
    // kwargs to read and is not a route DRF can register, so only the call form matters.
    for (let i = 0; i < dec.childCount; i++) {
      const c = dec.child(i) as TsNode | undefined;
      if (c && c.type !== '@') return c.type === 'call' ? c : undefined;
    }
  }
  return undefined;
}

interface ActionRoute {
  methods: HttpMethod[];
  detail: boolean;
  urlPath: string;
}

/**
 * The route shape an `@action` declares, or undefined when it is not statically decidable.
 *
 * `methods` defaults to `['get']` and `url_path` to the method name — both are DRF's own
 * defaults. `detail` has NO default in DRF (it asserts on a missing value), so an action whose
 * `detail` is absent or non-literal yields nothing rather than a guessed collection route: a
 * wrong path is worse than a missing one for the cross-repo linker.
 */
function actionRoute(def: TsNode, name: string): ActionRoute | undefined {
  const call = actionDecoratorCall(def);
  if (!call) return undefined;
  const detailNode = keywordArg(call, 'detail');
  const detailText = detailNode?.text as string | undefined;
  if (detailText !== 'True' && detailText !== 'False') return undefined;
  const rawMethods = stringListValue(keywordArg(call, 'methods')) ?? ['get'];
  const methods = rawMethods.map((m) => HTTP_METHODS[m.toLowerCase()]).filter((m): m is HttpMethod => Boolean(m));
  if (methods.length === 0) return undefined;
  const urlPathNode = keywordArg(call, 'url_path');
  // A non-literal `url_path=` (an f-string, a constant) has no derivable segment; falling back to
  // the method name would invent a path that is not served.
  if (urlPathNode && urlPathNode.type !== 'string') return undefined;
  const urlPath = urlPathNode ? stringValue(urlPathNode) : name;
  return { methods, detail: detailText === 'True', urlPath: templatize(urlPath, true) };
}

// =============================================================================
// Extraction
// =============================================================================

export interface DrfRouteOptions {
  /** Every parsed file (the ViewSet class index spans the whole repo). */
  files: PythonFile[];
  /** The files the profile's `routeFileGlobs` selected — the only place routers are tracked. */
  routeFiles: Set<string>;
  /** Mount prefixes per route file, from the `include('<module>')` pass (the degrade fallback). */
  filePrefixes: Map<string, Set<string>>;
  /** Repo module index (`buildModuleIndex`), for one-hop import resolution. */
  moduleIndex: Map<string, string>;
  idGen: StableIdGenerator;
}

/**
 * Resolve every DRF `register()` in the route files into routes, grouped by the file that
 * DECLARES the registration (which is the file the entrypoint id is scoped to).
 */
export function extractDrfRoutes(opts: DrfRouteOptions): Map<string, DrfRoute[]> {
  const { files, routeFiles, filePrefixes, moduleIndex, idGen } = opts;
  const classIndex = buildClassIndex(files);
  const importTables = new Map<string, ImportTable>();
  const routers = new Map<string, RouterVar>();
  const sites: RegisterSite[] = [];
  /** router key → the mount prefixes `path(p, include(<router>.urls))` gives it. */
  const mounts = new Map<string, Set<string>>();

  const routeFileList = files.filter((f) => routeFiles.has(f.relPath));
  const fileByPath = new Map(files.map((f) => [f.relPath, f]));
  /** Import table for any parsed file, built once on demand (route files, plus ViewSet/base files). */
  const importsOf = (relPath: string): ImportTable | undefined => {
    const cached = importTables.get(relPath);
    if (cached) return cached;
    const file = fileByPath.get(relPath);
    if (!file) return undefined;
    const table = buildImportTable(file);
    importTables.set(relPath, table);
    return table;
  };
  for (const file of routeFileList) importsOf(file.relPath);

  /** A name in a file → the router variable it denotes: local assignment first, else one import hop. */
  const resolveRouter = (file: string, name: string): string | undefined => {
    const local = routerKey(file, name);
    if (routers.has(local)) return local;
    const table = importsOf(file);
    if (!table) return undefined;
    const target = resolveImportedTarget(table, moduleIndex, name);
    if (!target?.filePath) return undefined;
    const imported = routerKey(target.filePath, target.symbol ?? name);
    return routers.has(imported) ? imported : undefined;
  };

  // Pass 1 — router variables and registration sites.
  for (const file of routeFileList) {
    const siteByStart = new Map<number, RegisterSite>();
    for (const call of file.root.descendantsOfType('call') as TsNode[]) {
      if (calleeLastName(call) !== 'register') continue;
      const site = toRegisterSite(call, file.relPath);
      if (!site) continue;
      sites.push(site);
      siteByStart.set(call.startIndex as number, site);
    }
    for (const assign of file.root.descendantsOfType('assignment') as TsNode[]) {
      const left = assign.childForFieldName?.('left') as TsNode | undefined;
      const right = assign.childForFieldName?.('right') as TsNode | undefined;
      if (!left) continue;
      if (left.type !== 'identifier') {
        // `a, b = helper(...)` — the routers exist but their lineage is not derivable here.
        for (const ident of left.descendantsOfType('identifier') as TsNode[]) {
          routers.set(routerKey(file.relPath, ident.text as string), { kind: 'opaque' });
        }
        continue;
      }
      if (right?.type !== 'call') continue;
      const site = siteByStart.get(right.startIndex as number);
      routers.set(routerKey(file.relPath, left.text as string), site ? { kind: 'nested', site } : { kind: 'root' });
    }
  }

  // Pass 2 — router-object mounts: `path("api/", include(<router>.urls))`.
  for (const file of routeFileList) {
    for (const call of file.root.descendantsOfType('call') as TsNode[]) {
      const name = calleeLastName(call);
      if (name !== 'path' && name !== 're_path') continue;
      const args = positionalArgs(call);
      const inner = args[1]?.type === 'call' && calleeLastName(args[1]) === 'include' ? args[1] : undefined;
      const mountArg = inner ? positionalArgs(inner)[0] : undefined;
      if (mountArg?.type !== 'attribute') continue;
      const obj = mountArg.childForFieldName?.('object') as TsNode | undefined;
      if (obj?.type !== 'identifier') continue;
      const key = resolveRouter(file.relPath, obj.text as string);
      if (!key) continue;
      const raw = args[0]?.type === 'string' ? stringValue(args[0]) : '';
      const prefix = templatize(raw, name === 're_path');
      const set = mounts.get(key) ?? new Set<string>();
      for (const base of filePrefixes.get(file.relPath) ?? ['']) set.add(normalizePath(`${base}/${prefix}`));
      mounts.set(key, set);
    }
  }

  // Pass 3 — router paths, memoized. A router that is on the current chain is a cycle
  // (`a = b.register(...)` can only be written once, but an import cycle could still fake one),
  // so it resolves to no path and its registrations take the documented file-prefix fallback.
  const memo = new Map<string, string[]>();
  const onPath = new Set<string>();
  const routerPaths = (key: string): string[] => {
    const cached = memo.get(key);
    if (cached) return cached;
    if (onPath.has(key)) return [];
    onPath.add(key);
    const router = routers.get(key);
    let paths: string[] = [];
    if (router?.kind === 'root') {
      // An unmounted root router keeps '' — the honest answer when no mount is known.
      paths = [...(mounts.get(key) ?? new Set(['']))];
    } else if (router?.kind === 'nested') {
      paths = sitePaths(router.site);
    }
    onPath.delete(key);
    memo.set(key, paths);
    return paths;
  };

  /**
   * The path(s) a registration serves at. A nested registration inserts the PARENT's lookup
   * segment before its own prefix (`projects/{parent_lookup_project_id}/environments`); the
   * segment is named only from what the source declares — the last `parents_query_lookups`
   * entry, which is the one belonging to the immediate parent — and degrades to the positional
   * `{_}` token when the registration declares none.
   */
  function sitePaths(site: RegisterSite): string[] {
    const parentKey = site.receiver ? resolveRouter(site.file, site.receiver) : undefined;
    if (!parentKey) return [];
    const parent = routers.get(parentKey);
    const lookup =
      parent?.kind === 'root'
        ? ''
        : `/{${site.lookups.length > 0 ? `${PARENT_LOOKUP_PREFIX}${site.lookups[site.lookups.length - 1]}` : '_'}}`;
    return routerPaths(parentKey).map((p) => normalizePath(`${p}${lookup}/${site.prefix}`));
  }

  /** The ViewSet class a registration names, via one import hop then a same-file fallback. */
  const resolveViewSet = (site: RegisterSite): ClassRef | undefined => {
    if (!site.viewset) return undefined;
    const name = site.viewset.split('.').pop() as string;
    const table = importsOf(site.file);
    const target = table ? resolveImportedTarget(table, moduleIndex, site.viewset) : undefined;
    if (target?.filePath) {
      const viaImport = classIndex.get(`${target.filePath}#${name}`);
      if (viaImport) return viaImport;
    }
    return classIndex.get(`${site.file}#${name}`);
  };

  /**
   * A ViewSet's methods by name, merged along its repo-declared base chain (bases first so the
   * subclass wins). Bases are resolved by the same one-hop rule; a framework base (`ModelViewSet`)
   * is simply not in the index, which is why the standard actions usually stay synthetic.
   */
  const methodsOf = (cls: ClassRef, hops: number, seen: Set<string>): Map<string, MethodRef> => {
    const key = `${cls.relPath}#${defName(cls.node) ?? ''}`;
    if (seen.has(key) || hops > MAX_BASE_HOPS) return new Map();
    seen.add(key);
    const out = new Map<string, MethodRef>();
    const table = importsOf(cls.relPath);
    for (const base of baseNames(cls.node)) {
      const baseName = base.split('.').pop() as string;
      const target = table ? resolveImportedTarget(table, moduleIndex, base) : undefined;
      const baseRef =
        (target?.filePath ? classIndex.get(`${target.filePath}#${baseName}`) : undefined) ??
        classIndex.get(`${cls.relPath}#${baseName}`);
      if (!baseRef) continue;
      for (const [n, node] of methodsOf(baseRef, hops + 1, seen)) out.set(n, node);
    }
    for (const [n, node] of directMethods(cls)) out.set(n, node);
    return out;
  };

  // Pass 4 — routes.
  const out = new Map<string, DrfRoute[]>();
  const push = (file: string, route: DrfRoute): void => {
    const list = out.get(file) ?? [];
    list.push(route);
    out.set(file, list);
  };

  for (const site of sites) {
    const resolved = sitePaths(site);
    // DEGRADE (documented): a registration whose router lineage is opaque keeps the file's own
    // mount prefix — the pre-nested-router behaviour — instead of being dropped or guessed.
    const bases =
      resolved.length > 0
        ? resolved
        : [...(filePrefixes.get(site.file) ?? [''])].map((b) => normalizePath(`${b}/${site.prefix}`));

    const cls = resolveViewSet(site);
    const methods = cls ? methodsOf(cls, 0, new Set()) : new Map<string, MethodRef>();
    const handlerFor = (name: string): string | undefined => {
      const m = methods.get(name);
      return m ? pythonFunctionId(idGen, m.relPath, m.def) : undefined;
    };

    for (const base of bases) {
      for (const { method, detail, action } of DRF_STANDARD_ROUTES) {
        push(site.file, {
          method,
          fullPath: normalizePath(detail ? `${base}/{pk}/` : `${base}/`),
          line: site.line,
          handlerId: handlerFor(action),
        });
      }
      for (const [name, m] of methods) {
        const route = actionRoute(m.def, name);
        if (!route) continue;
        const path = normalizePath(route.detail ? `${base}/{pk}/${route.urlPath}/` : `${base}/${route.urlPath}/`);
        const handlerId = pythonFunctionId(idGen, m.relPath, m.def);
        for (const method of route.methods) {
          push(site.file, { method, fullPath: path, line: site.line, handlerId });
        }
      }
    }
  }
  return out;
}
