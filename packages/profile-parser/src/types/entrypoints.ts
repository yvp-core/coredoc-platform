import type { ArgRef, Detector } from './detectors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an entrypoint rule resolves its handler.
 *
 * - `{ arg }` reads the handler off the registration call itself (`app.get(path, fn)`):
 *   a bare reference resolves to that function, an inline arrow synthesizes a node.
 *   Deliberately *not* an `ArgRef` — `as` describes how to read a **string** out of an
 *   argument, and a handler is a function, so no `as` variant is meaningful here.
 * - `{ via: 'handler-table', table }` resolves the handler reference through a
 *   named cross-file require/alias registry (see `HandlerTable`): the handler arg
 *   is matched against the alias→file map and the trailing method segment names
 *   the function in that file.
 *
 * Decorator routes use the decorated method itself, so `handler` is optional there.
 */
export type HandlerResolution =
  | {
      /** Which argument holds the handler. -1 = last argument (the middleware-chain tail). */
      arg: number;
    }
  | {
      via: 'handler-table';
      table: string;
      /** Which argument holds the handler reference. -1 = last argument. */
      arg: number;
    };

export type HttpEntrypointRule = {
  kind: 'http';
  detect: Detector;
  /** Class-decorator base path (decorator-route) when present. */
  basePath?: ArgRef;
  /** Decorator/method → HTTP verb map, or 'from-callee' for `router.get`. */
  method?: Record<string, string> | 'from-callee';
  methodPath: ArgRef;
  paramSyntax: 'colon' | 'brace' | 'template';
  /** Handler resolution for call-shape routes (decorator routes use the method). */
  handler?: HandlerResolution;
  /**
   * App-level route prefix prepended to every route this rule emits — NestJS
   * `app.setGlobalPrefix('/api/v1', { exclude })`. Without it the emitted
   * `fullPath` diverges from the path the app actually serves, so HTTP egress
   * that targets the real (prefixed) URL never joins these entrypoints. An
   * `exclude` entry is a route path without the leading slash, `*` matching any
   * tail (`.well-known/*`); a route it matches keeps its unprefixed path.
   */
  globalPrefix?: { path: string; exclude?: string[] };
};

export type QueueEntrypointRule = {
  kind: 'queue';
  detect: Detector;
  /** Must use the same transport spelling as producer rules; matching normalizes case/whitespace only. */
  system: string;
  topic: ArgRef;
  /** decorator → pattern map (event / request-response). */
  pattern?: Record<string, string>;
  handler?: HandlerResolution;
};

/**
 * A CLI command entrypoint declared as a fluent registration chain, e.g.
 * commander's `program.command('parse').option(…).action(handler)`. The `detect`
 * call-shape matches the command-declaring call (its string arg is the command
 * name); the handler lives in a sibling call (`action`) in the SAME chain — which
 * is an ancestor of the command call on the CST, so it is reachable from the
 * command site's enclosing-call chain.
 *
 * Convention-configurable: the command call, its name arg, the action call name,
 * and the handler arg all come from the profile — nothing is hard-coded to
 * commander. A bare function reference resolves to that function; an inline
 * arrow/function synthesizes a handler node named for the command.
 */
export type CliEntrypointRule = {
  kind: 'cli';
  detect: Detector;
  /** Command-name arg on the detected call (e.g. arg 0 of `.command('parse')`). */
  command: ArgRef;
  /**
   * The sibling call in the same fluent chain that carries the handler, and which
   * of its args holds it (e.g. commander's `.action(fn)` → `{ call: 'action', arg: 0 }`).
   */
  action: { call: string; arg: number };
};

/**
 * A gRPC method entrypoint declared by a method decorator, e.g. NestJS
 * `@GrpcMethod('HeroesService', 'FindOne')`. `detect.names` maps each decorator to
 * its streaming type (`@GrpcMethod` → 'unary', `@GrpcStreamMethod` → 'server', …).
 * `service`/`method` read the decorator's string args; each falls back (service →
 * enclosing class name, method → decorated method name) when its arg is absent.
 */
export type GrpcEntrypointRule = {
  kind: 'grpc';
  detect: Detector;
  /** Service-name arg on the decorator (e.g. arg 0). Falls back to the class name. */
  service?: ArgRef;
  /** Method-name arg on the decorator (e.g. arg 1). Falls back to the method name. */
  method?: ArgRef;
};

/**
 * A GraphQL resolver-field entrypoint: field decorators (`@Query`/`@Mutation`/
 * `@Subscription`) inside a `@Resolver()` class, e.g. NestJS code-first resolvers.
 * `detect` is the class decorator that scopes the resolver; `operation` maps each
 * field decorator to its operation type. `fieldName` reads an explicit field-name
 * override (falls back to the method name); `parentType` reads `@Resolver(() => T)`
 * (falls back to the root operation type — Query/Mutation/Subscription).
 */
export type GraphqlEntrypointRule = {
  kind: 'graphql';
  detect: Detector;
  /** Field decorator → operation type, e.g. `{ Query: 'query', Mutation: 'mutation' }`. */
  operation: Record<string, 'query' | 'mutation' | 'subscription'>;
  /** Explicit field-name override on the field decorator; falls back to the method name. */
  fieldName?: ArgRef;
  /** Parent GraphQL type from `@Resolver(() => T)`; falls back to the root operation type. */
  parentType?: ArgRef;
};

/**
 * File-convention HTTP routes (Next.js App Router). A `route.ts(x)` file under
 * `routeRoot` exporting an HTTP-verb function/const (`POST`, `GET`, …) is an
 * endpoint; the path is the directory chain under `routeRoot` (route-groups
 * `(grp)` and slots `@x` stripped, `[id]`→`{id}`, `[...slug]`→`{slug}`).
 */
export type NextAppRouterHttpRule = {
  kind: 'http';
  via: 'file-convention';
  framework: 'next-app-router';
  /** Directory under which the route tree lives (e.g. `app`). */
  routeRoot: string;
  /** The route file base names (default `route.ts`, `route.tsx`). */
  routeFiles?: string[];
};

/**
 * File-convention HTTP endpoints (Next.js PAGES Router API routes). EVERY module
 * file under `<routeRoot>/api/**` is an endpoint — there is no marker base name to
 * look for the way the app router has `route.ts`: `[param].ts` and `index.ts` count
 * too, only `_`-prefixed files/dirs (framework internals) drop out. The path is the
 * file's own path under `routeRoot` (`pages/api/projects/[ref]/settings.ts` →
 * `/api/projects/{ref}/settings`; `…/index.ts` → the parent path).
 *
 * The served verbs are NOT statically declared: a pages-router handler is one
 * default-exported function that switches on `req.method`, so each file yields ONE
 * entrypoint with method `ALL` rather than a fabricated verb fan-out.
 */
export type NextPagesApiHttpRule = {
  kind: 'http';
  via: 'file-convention';
  framework: 'next-pages-api';
  /**
   * Path SEGMENT under which the pages tree lives (e.g. `pages`) — matched
   * anywhere in a file's path, so one entry covers every app root in a monorepo.
   * Same semantics as `NextAppRouterHttpRule.routeRoot`, and deliberately NOT the
   * semantics of the frontend `FileConventionRouteRule.routeDir`, which is a
   * repo-relative directory PREFIX (`apps/studio/pages`) declared per app root.
   * Handing this field a prefix matches nothing; handing `routeDir` a segment
   * matches nothing.
   */
  routeRoot: string;
};

export type FileConventionHttpRule = NextAppRouterHttpRule | NextPagesApiHttpRule;

export type EntrypointRule =
  | HttpEntrypointRule
  | QueueEntrypointRule
  | FileConventionHttpRule
  | CliEntrypointRule
  | GrpcEntrypointRule
  | GraphqlEntrypointRule;

// ─────────────────────────────────────────────────────────────────────────────
// Handler tables — declarative cross-file require/alias registries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `handlerTable` resolves a handler reference through a cross-file
 * require/alias registry to a function in another file — the one pattern behind
 * the koa-router, pub-sub, and bg-queue handler resolutions.
 *
 * The engine builds an alias→file map by walking the `registryVar` object literal
 * (nested aliases joined by `.`, leaves are `require("app/…")` resolved to that
 * file). It then maps a handler reference to a function id:
 *
 * - `reference: 'member-chain'` — the handler arg is `<registryVar>.<alias…>.<method>`;
 *   the trailing segment is the method, the rest is the alias. (koa routes)
 *   When the alias has no trailing method segment, `defaultMethod` is used. (pub-sub)
 * - `reference: 'require-arg'` — the handler arg is `require("app/…")` (optionally
 *   the 2nd element of a `[name, require(...)]` array); resolve to `defaultMethod`
 *   in that file, falling back to the file's single exported function. (bg queues)
 */
export interface HandlerTable {
  /** Referenced by entrypoint rules via `handler: { via:'handler-table', table }`. */
  name: string;
  /** The var holding the alias→require map, e.g. "handlers". */
  registryVar: string;
  /** Repo-relative path where the registry is declared (required for member-chain). */
  inFile?: string;
  /** Object-literal leaves are `require("path")` → that file. */
  leaf: 'require';
  /** How a handler reference maps to (file, method). */
  reference: 'member-chain' | 'require-arg';
  /** Whether the registry object nests aliases (member-chain only). */
  nested?: boolean;
  /** Method when the ref has no trailing method segment (e.g. "onMessage"). */
  defaultMethod?: string;
  /** require() path prefix filter for leaves (default "app/"). */
  requirePrefix?: string;
}
