// ─────────────────────────────────────────────────────────────────────────────
// Frontend rules — components / routes / state stores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-specifier → file resolution config. Frontend id-resolution lives or
 * dies on turning an import specifier into the repo-relative file that *declares*
 * the component. Two mapping styles cover the common cases:
 *
 * - `alias`: a tsconfig `paths` prefix, e.g. `@/*` → repo root (`@/x` → `x`).
 * - `baseUrl`: a CRA/`baseUrl` root, e.g. `"src"` so a bare specifier
 *   `components/Foo` → `src/components/Foo`.
 *
 * Relative specifiers (`./x`, `../x`) always resolve against the importing file's
 * directory. Extensions are probed in `.tsx,.ts,.jsx,.js,/index.{tsx,ts,jsx,js}`
 * order. A resolution that lands outside `confineTo` (when set) is rejected — we
 * never fabricate an id for a node we won't actually emit. `confineTo` accepts a
 * single prefix or a list of them (a monorepo whose frontend spans e.g.
 * `frontend/src/` and `products/` confines to both, and a resolution is kept when
 * it starts with ANY entry).
 */
export interface ImportResolution {
  /** tsconfig path aliases: prefix (e.g. `@/`) → repo-relative base (e.g. ``). */
  aliases?: Record<string, string>;
  /** baseUrl root for bare specifiers (e.g. `src`). */
  baseUrl?: string;
  /**
   * Only accept resolved files under this repo-relative prefix (e.g. `src/`), or
   * under any one of several prefixes (e.g. `['frontend/src/', 'products/']`).
   */
  confineTo?: string | string[];
}

/**
 * How the engine recognizes and reads a React component. The detector is fixed
 * (PascalCase function/arrow/class that renders JSX) — the profile tunes which
 * flavours are in play and how their ids resolve.
 */
export interface ComponentRule {
  framework: string;
  /** Detect function-declaration + arrow/fn-expression const components. */
  functional?: boolean;
  /** Detect `class X extends (React.)Component/PureComponent`. */
  classComponents?: boolean;
  /**
   * Emit one component per scoped `.vue` file (name = PascalCase file stem), with child edges
   * from the `<template>` block's component tags. Every `.vue` file is definitionally one
   * component, so there is nothing to detect — the flag only opts the profile in.
   */
  vueSfc?: boolean;
  /**
   * Restrict functional-component detection to these file extensions
   * (e.g. `['.tsx']` — JSX only lives in tsx). Class components are detected in
   * any matched file. Defaults to all parsed files.
   */
  functionalInExtensions?: string[];
  /** Child render edges: always 'jsx-walk' (PascalCase tags in the render body). */
  childComponents: 'jsx-walk';
  /** Id resolution strategy: 'import+tsconfig' = import → file → declared name. */
  idResolution: 'import+tsconfig';
  /** Module-specifier resolution config (alias / baseUrl / confineTo). */
  imports: ImportResolution;
  /**
   * HOC wrapper call names to peel when reading a file's `export default`
   * (e.g. `withTranslation`, `withRouter`, `connect`, `memo`, `forwardRef`,
   * `SortableContainer`). The peel always picks the deepest PascalCase identifier
   * the file declares, so this list is advisory documentation rather than a gate.
   */
  hocWrappers?: string[];
  /** JSX tags that are framework primitives, never emitted as child edges. */
  frameworkPrimitives?: string[];
  /**
   * Child-usage dedup granularity:
   * - `per-tag-line` (default): one usage per (tag name, source line) — keeps a
   *   component used on several lines as several usages (the render-edge-per-site
   *   view; matches the financial-data-analyst golden).
   * - `per-id`: one usage per resolved component id (or per name when unresolved)
   *   across the whole parent — the deduplicated dependency view.
   */
  childDedup?: 'per-tag-line' | 'per-id';
}

/**
 * File-convention frontend routes: the route tree is the directory tree, so there is
 * no declaration site to read — the path comes from the page file's own path.
 *
 * - `next-pages`: every module under `routeDir` is a page except `_`-prefixed files
 *   (`_app`, `_document`) and the `api/` subtree (those are HTTP endpoints, covered by
 *   `FileConventionHttpRule`). `pages/foo/index.tsx` → `/foo`, `pages/index.tsx` → `/`.
 * - `next-app`: only `page.{tsx,ts,jsx,js}` files are pages; the path is the directory
 *   chain with route-groups `(grp)` and slots `@x` stripped.
 *
 * Both map `[id]` → `{id}` and `[...slug]` → `{slug}` (the brace convention every
 * other path primitive emits).
 */
export interface FileConventionRouteRule {
  framework: 'next-pages' | 'next-app';
  /**
   * Repo-relative DIRECTORY holding the route tree, matched as a path prefix — e.g.
   * `apps/studio/pages`, `apps/docs/app`. One entry per app root; a monorepo declares
   * several. NOT the single-segment form `FileConventionHttpRule.routeRoot` takes (that
   * one is one path SEGMENT, e.g. `app`, located anywhere in the path).
   */
  routeDir: string;
}

/**
 * The second table of a {@link RecordTableRouteRule}: scene key → the module that
 * dynamically imports the route's component.
 *
 * `via: 'dynamic-import'` is the only shape today — the entry's value contains
 * `() => import('<module>')` (directly, or under `property` when the value is an
 * object literal carrying the thunk alongside metadata). The component is that
 * module's default export, read through the same HOC-peeling default-export
 * machinery file-convention routes use.
 */
export interface RecordTableSceneTableRule {
  /**
   * Repo-relative GLOBS of the files declaring the scene table (e.g.
   * `['frontend/src/scenes/appScenes.ts']`). Omit when the scene table lives in the
   * same files as the route table.
   */
  files?: string[];
  /** Name of the scene-table object (an exported const, or an object property). */
  table: string;
  /** The value carries the component module as a dynamic `import()` thunk. */
  via: 'dynamic-import';
  /**
   * Property holding the thunk when the entry value is an object literal
   * (`{ import: () => import('…'), name: '…' }` → `'import'`). Omit when the value
   * IS the thunk (`() => import('…')`).
   */
  property?: string;
  /**
   * How the imported module names its component when it is NOT the module's default
   * export: an exported const bound to an object literal, plus the property naming the
   * component — `export const scene = { component: Dashboard, logic: … }` →
   * `{ export: 'scene', property: 'component' }`.
   *
   * Tried BEFORE the default export (routers that support both read the descriptor
   * object first), falling back to it. When neither names a component the route is
   * still emitted, name-only. Measured need: PostHog's scene modules export a
   * `SceneExport` descriptor and mostly have no default export at all, so the
   * default-export-only read resolved 13 of 177 scenes.
   */
  moduleComponent?: { export: string; property: string };
}

/**
 * Table-driven routes: a path-keyed `Record` whose VALUE names a scene key, joined
 * through a SECOND table that maps that scene key to the component module
 * (`() => import('…')`). Two hops, no `<Route>` element and no component reference
 * anywhere near the path — so neither the JSX nor the config-array detector sees a
 * single route.
 *
 * This is a SHAPE, not a framework: any router whose table reads
 * `{ '<path>': [<sceneKey>, …] }` + `{ <sceneKey>: () => import('<module>') }`
 * declares it (measured on kea-router, which spells the tables `routes` +
 * `appScenes` / a product manifest's `routes` + `scenes`).
 *
 * Keys are read literally when they are string literals. When they are COMPUTED
 * (`[urls.foo(':id')]`), `resolveComputedKeyVia` const-evaluates them; a key that
 * does not fold still yields a route, with its path marked unresolved (the callee
 * text) rather than dropped.
 */
export interface RecordTableRouteRule {
  /**
   * Repo-relative GLOBS of the files declaring the route table (e.g.
   * `['frontend/src/products.tsx']`, or a per-product manifest glob).
   */
  files: string[];
  /**
   * Name of the route-table object. Matched against an exported/local const
   * (`export const routes = {…}`) AND against an object property (`manifest.routes`),
   * so a table nested inside a bigger config object needs no extra locator.
   */
  table: string;
  /** Where the route path comes from. `'key'` (the table's key) is the only shape today. */
  path: 'key';
  /**
   * Where the scene key sits in the entry VALUE — an array/tuple index
   * (`['ErrorTracking', 'errorTracking']` → `{ tupleIndex: 0 }`).
   */
  sceneKey: { tupleIndex: number };
  /** The second table: scene key → component module. */
  sceneTable: RecordTableSceneTableRule;
  /**
   * Const-eval for computed keys of the form `[<urlsObject>.<fn>(<'literal'>…)]`.
   * The named object's property must be a single-expression arrow returning a
   * template literal or a plain string; the call's string-literal arguments are
   * substituted into the placeholders that name the arrow's parameters. One spread
   * hop is followed (`urls = { ...productUrls, … }` → the imported object literal).
   * Anything else (conditionals, concatenation, helper calls, non-literal args)
   * leaves the route emitted with an `unresolved:` path.
   */
  resolveComputedKeyVia?: {
    /** Name of the object literal holding the path-builder functions (e.g. `urls`). */
    urlsObject: string;
    /** Repo-relative path PREFIXES of the files that may declare it. */
    inPaths: string[];
  };
}

/**
 * React-Router-style route extraction. Routes are read from config arrays
 * (`{ path, component }`) and JSX `<Route component={X} />` / `render={() => <X/>}`
 * props (RR v5 passes the component as a prop, not a child). `reactAdminResources`
 * covers react-admin, which generates routes from `<Resource>` rather than `<Route>`.
 * `fileConvention` covers frameworks whose routes are files, not declarations.
 */
export interface RouteRule {
  /** Restrict route scanning to files whose path starts with one of these. */
  inPaths?: string[];
  /** Also scan files whose path contains one of these substrings. */
  inPathContains?: string[];
  /** Read `component={X}` props on `<Route>`. */
  componentProp?: boolean;
  /** Read `render={() => <X/>}` / `render={(p) => <X/>}` props on `<Route>`. */
  renderProp?: boolean;
  /** Read config-array `{ path: '…', component: X }` entries. */
  configArray?: boolean;
  /**
   * Read react-admin `<Resource name="x" list/show/edit/create={Component}/>` declarations.
   * Each present CRUD prop yields one route — `/x` (list), `/x/create` (create), `/x/:id`
   * (edit), `/x/:id/show` (show) — whose component is the prop's identifier. react-admin
   * generates these routes from `<Resource>` instead of declaring `<Route>` elements.
   */
  reactAdminResources?: boolean;
  /** Derive routes from the page-file tree of a file-convention framework (Next.js). */
  fileConvention?: FileConventionRouteRule[];
  /**
   * Read routes from path-keyed `Record` tables joined to a scene→module table
   * (kea-router and friends). One entry per table pair.
   */
  recordTable?: RecordTableRouteRule[];
}

/**
 * Builder-array member extraction. Some store factories take an ARRAY of builder
 * calls instead of a state object — `factory([actions({…}), selectors({…})])` —
 * so there is no single object literal to read keys from. Declaring which builder
 * callees carry which kind of member turns that array into members.
 *
 * Every listed builder's object-literal argument contributes its TOP-LEVEL keys,
 * regardless of value shape (a non-function value under an action builder is still
 * an action). A builder named in both lists contributes to both. Builders that
 * appear in neither list are ignored — nothing is inferred from the callee name.
 */
export interface StateStoreBuilders {
  /** Builder callees whose object-literal argument's keys are ACTION names. */
  actionBuilders: string[];
  /** Builder callees whose object-literal argument's keys are SELECTOR/value names. */
  selectorBuilders: string[];
}

/**
 * State-store detector. Today: a factory call (`create(...)` for zustand,
 * `configureStore`/`createSlice` for redux) bound to an exported const whose
 * name is the store name. Actions/selectors are the keys of the returned object
 * literal (function-valued vs value-valued), or — when `builders` is declared and
 * the factory argument is an array — the keys of the listed builders' arguments.
 */
export interface StateStoreRule {
  library: 'redux' | 'zustand' | 'mobx' | 'pinia' | 'vuex' | 'recoil' | 'jotai' | 'other';
  /** Factory callee that creates a store, e.g. `create` (zustand), `createSlice`. */
  factory: string;
  /** require the factory to be imported from this module (provenance). */
  fromModule?: string;
  /** Restrict store scanning to files whose path starts with one of these. */
  inPaths?: string[];
  /**
   * The factory's argument is an ARRAY of builder calls, not a state object literal.
   * Ignored for stores whose factory argument is not an array.
   */
  builders?: StateStoreBuilders;
}
