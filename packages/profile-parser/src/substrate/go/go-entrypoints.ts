/**
 * Go ENTRYPOINT extraction — HTTP routes, huma operations, generated gRPC services and CLI commands.
 *
 * Go has no route ANNOTATION: every framework registers routes with a plain method call
 * (`r.Get("/users", h)`, `e.GET(…)`, `mux.HandleFunc(…)`), so all of this is call-shape work.
 * Four lanes run:
 *
 *   1. **HTTP** — a registration call whose selector names a router verb and whose first path
 *      argument is a string literal. The BASE PATH is composed from the two statically-decidable
 *      mount forms, because emitting a leaf path unprefixed reports a route the server does not
 *      serve and breaks the cross-repo path join at both ends:
 *        - LEXICAL, chi's shape: `r.Route("/api", func(r chi.Router) { r.Get("/x", h) })` — the
 *          nested registration is a CST descendant of the mount call, so walking the ancestors
 *          composes it exactly.
 *        - BOUND, gin's and echo's shape: `v1 := r.Group("/api/v1")` then `v1.GET("/x", h)` — the
 *          prefix travels through a variable, resolved per file and transitively through chains
 *          (`v2 := v1.Group("/beta")`), with a visited guard so a cyclic rebinding cannot hang.
 *      gorilla's `r.HandleFunc("/p", h).Methods("GET")` is read off the chained `.Methods(…)`.
 *   2. **gRPC** — generated code registers a service with `pb.RegisterUserServiceServer(s, impl)`.
 *      The service NAME comes from that call and the entrypoints are the exported methods on the
 *      implementing type, which is where the request actually lands.
 *   3. **huma** — `huma.Register(api, huma.Operation{Method, Path}, h)` and the `huma.Get(…)` verb
 *      helpers. These are PACKAGE functions on the huma import, not router methods, and the path is
 *      usually a const concatenation (`ManagementPrefix + "/x"`), so it is evaluated through the
 *      package's string consts. Gated on the huma module like the CLI lane.
 *   4. **CLI** — a `cobra.Command` / `cli.Command` composite literal. Each lane is GATED on the
 *      framework's module appearing in a `go.mod` require block, so a repo that does not depend on
 *      cobra can never have a `cobra.Command`-shaped literal of its own reported as a command.
 *
 * Deliberately out of scope: queue/event consumers. Go's consumer shape is a bare
 * `for msg := range ch` or a vendor-specific callback with no shared convention, so there is
 * nothing to key on that would not be a guess — a documented Tier-B gap, not a silent one.
 */
import type {
  CliEntrypointDetails,
  Entrypoint,
  GrpcEntrypointDetails,
  HttpMethod,
  StableIdGenerator,
} from '@coredoc/core';
import {
  ASSIGNMENT_STATEMENT,
  BINARY_EXPRESSION,
  CALL_EXPRESSION,
  COMPOSITE_LITERAL,
  CONST_DECLARATION,
  CONST_SPEC,
  FUNCTION_DECLARATION,
  FUNC_LITERAL,
  type GoFile,
  IDENTIFIER,
  KEYED_ELEMENT,
  METHOD_DECLARATION,
  PARENTHESIZED_EXPRESSION,
  RETURN_STATEMENT,
  SELECTOR_EXPRESSION,
  SHORT_VAR_DECLARATION,
  STRING_LITERAL_TYPES,
  UNARY_EXPRESSION,
  VAR_DECLARATION,
  VAR_SPEC,
  type TsNode,
  baseTypeName,
  goFunctionId,
  goStringValue,
  isExported,
  itemName,
  namedChildrenOfType,
  nearestAncestor,
  receiverTypeName,
} from './go-cst.js';
import { type GoPackageIndex, buildImportTable, buildPackageIndex } from './go-imports.js';
import { type GoModule, dependsOnAny } from './go-modules.js';
import { type GoTypeEnv, buildGoTypeEnv } from './go-types.js';
import { httpEntrypoint } from '../file-nodes.js';
import { repoDir } from '../glob.js';

export interface GoEntrypointConfig {
  /** Router methods that REGISTER a handler. Default: the verb set in both spellings + Handle/Method. */
  routerMethods?: string[];
  /** Sub-router builders that contribute a base path. Default: ['Route','Mount','Group','PathPrefix']. */
  mountMethods?: string[];
  /** CLI frameworks to detect. Default: both (each still gated on its module). */
  cliFrameworks?: string[];
  /** Suffix of the generated gRPC registration function. Default: ['Server'] (`RegisterFooServer`). */
  grpcServiceSuffixes?: string[];
  /** The repo's modules — the dependency gate for the CLI lane. */
  modules: GoModule[];
  /**
   * The repo's package index and shared type environment. Both are DERIVED, not tuning: the parser
   * passes the ones it already built so a repo is not walked twice, and a caller that omits them
   * (the tests, an embedding tool) gets identical results from locally-built ones. Absence must
   * never mean "resolve fewer handlers" — that is the silent-hole failure this substrate avoids.
   */
  packageIndex?: GoPackageIndex;
  typeEnv?: GoTypeEnv;
}

/**
 * Router registration verbs, in BOTH ecosystem spellings: chi / gorilla / stdlib write
 * `r.Get("/p", h)`, gin / echo write `r.GET("/p", h)`. Casing is NOT normalised away here — the
 * two spellings are two different APIs and a profile must be able to name exactly one.
 */
const DEFAULT_ROUTER_METHODS = [
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'Connect',
  'Trace',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'Handle',
  'HandleFunc',
  'Method',
  'MethodFunc',
];

const DEFAULT_MOUNT_METHODS = ['Route', 'Mount', 'Group', 'PathPrefix'];
const DEFAULT_CLI_FRAMEWORKS = ['cobra', 'urfave'];

/** Which module must be a declared dependency before a CLI detector may run. */
const CLI_GATE_MODULES: Record<string, string[]> = {
  cobra: ['github.com/spf13/cobra'],
  urfave: ['github.com/urfave/cli'],
};

/** The composite-literal type + the fields each CLI framework names a command and its action with. */
const CLI_SHAPES: Record<string, { typeName: string; nameField: string; actionFields: string[] }> = {
  cobra: { typeName: 'cobra.Command', nameField: 'Use', actionFields: ['RunE', 'Run'] },
  urfave: { typeName: 'cli.Command', nameField: 'Name', actionFields: ['Action'] },
};

/**
 * huma registers operations through PACKAGE functions, not router methods: `huma.Register(api,
 * huma.Operation{Method, Path}, h)` and the `huma.Get(api, "/p", h)` convenience helpers. The
 * receiver is the `huma` import itself, so the router-method lane never sees these calls.
 */
const HUMA_MODULE = 'github.com/danielgtaylor/huma';
const HUMA_IMPORT_RE = /^github\.com\/danielgtaylor\/huma(?:\/v\d+)?$/;
const HUMA_VERB_HELPERS: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
};

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Registration verbs that take the HTTP method as their FIRST argument (chi's explicit form). */
const VERB_ARG_METHODS = new Set(['Method', 'MethodFunc']);

/** Registration verbs that carry no verb of their own (stdlib `ServeMux`, chi `Handle`). */
const VERBLESS_METHODS = new Set(['Handle', 'HandleFunc']);

// =============================================================================
// Small CST readers
// =============================================================================

/** A call's positional argument nodes, in order. */
function callArgs(call: TsNode): TsNode[] {
  const args = call.childForFieldName?.('arguments');
  const out: TsNode[] = [];
  const n = args?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = args.namedChild(i) as TsNode | undefined;
    if (c) out.push(c);
  }
  return out;
}

/** A node's value when it IS a string literal (a computed expression stays undefined). */
function literalValue(node: TsNode | undefined): string | undefined {
  if (!node || !STRING_LITERAL_TYPES.has(node.type)) return undefined;
  return goStringValue(node);
}

/** The `recv.Field` parts of a selector CALL (`r.Get(…)`), else undefined. */
function selectorCall(call: TsNode): { operand: TsNode; field: string } | undefined {
  const fn = call.childForFieldName?.('function') as TsNode | undefined;
  if (fn?.type !== SELECTOR_EXPRESSION) return undefined;
  const field = fn.childForFieldName?.('field')?.text as string | undefined;
  const operand = fn.childForFieldName?.('operand') as TsNode | undefined;
  return field && operand ? { operand, field } : undefined;
}

/** Ensure a leading slash, collapse duplicate slashes, and drop a trailing one (except the root). */
function normalizePath(p: string): string {
  const joined = `/${p.trim()}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * Go route params to the `{param}` template the cross-repo linker joins on. chi, gorilla and the
 * Go 1.22 `ServeMux` already write `{id}` (gorilla additionally allows a `{id:[0-9]+}` regex
 * constraint, whose pattern is not part of the path); gin and echo write `:id` and `*rest`.
 */
function templatize(raw: string): string {
  return (
    raw
      .replace(/\{([^}:]+)(:[^}]*)?\}/g, (_m, inner: string) => `{${inner.trim()}}`)
      .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
      .replace(/\*([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
      // A bare `*` (chi's and echo's catch-all) names no parameter; `{_}` is the linker's
      // wildcard spelling, and leaving a literal `*` in the path would never join.
      .replace(/\*/g, '{_}')
  );
}

// =============================================================================
// Base-path composition
// =============================================================================

/** One variable's mount prefix: the segments it adds, plus the variable it was derived from. */
interface PrefixBinding {
  parent?: string;
  segments: string[];
}

/**
 * Per-file `variableName → prefix binding` for the BOUND mount form
 * (`v1 := r.Group("/api/v1")`, `s := r.PathPrefix("/api").Subrouter()`).
 *
 * File-scoped on purpose: a router variable is a local, and a same-named local in another file is
 * a different router. Composing across files would silently prefix one module's routes with
 * another's base.
 */
function prefixBindings(file: GoFile, mountMethods: Set<string>): Map<string, PrefixBinding> {
  const bindings = new Map<string, PrefixBinding>();
  const record = (target: TsNode | undefined, value: TsNode | undefined): void => {
    const name = target?.text as string | undefined;
    if (!name || name === '_' || !value) return;
    const segments: string[] = [];
    // Document order, so a chained `r.Group("/a").Group("/b")` composes as `/a/b`.
    for (const call of value.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const sel = selectorCall(call);
      if (!sel || !mountMethods.has(sel.field)) continue;
      const raw = literalValue(callArgs(call)[0]);
      if (raw !== undefined) segments.push(raw);
    }
    if (segments.length === 0) return;
    // The innermost operand identifier is the router this chain was derived FROM.
    let cur: TsNode | undefined = value;
    let parent: string | undefined;
    while (cur) {
      if (cur.type === IDENTIFIER) {
        parent = cur.text as string;
        break;
      }
      const next =
        cur.type === CALL_EXPRESSION
          ? (cur.childForFieldName?.('function') as TsNode | undefined)
          : cur.type === SELECTOR_EXPRESSION
            ? (cur.childForFieldName?.('operand') as TsNode | undefined)
            : undefined;
      if (!next) break;
      cur = next;
    }
    if (!bindings.has(name)) bindings.set(name, { parent: parent === name ? undefined : parent, segments });
  };

  for (const stmt of [
    ...(file.root.descendantsOfType(SHORT_VAR_DECLARATION) as TsNode[]),
    ...(file.root.descendantsOfType(ASSIGNMENT_STATEMENT) as TsNode[]),
  ]) {
    const left = stmt.childForFieldName?.('left') as TsNode | undefined;
    const right = stmt.childForFieldName?.('right') as TsNode | undefined;
    const n = left?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) record(left.namedChild(i), right?.namedChild?.(i));
  }
  for (const spec of file.root.descendantsOfType(VAR_SPEC) as TsNode[]) {
    const value = spec.childForFieldName?.('value') as TsNode | undefined;
    const names = namedChildrenOfType(spec, IDENTIFIER);
    names.forEach((nameNode: TsNode, i: number) => record(nameNode, value?.namedChild?.(i)));
  }
  return bindings;
}

/** Resolve a bound router variable to its full prefix, guarding against a cyclic rebinding. */
function boundPrefix(name: string | undefined, bindings: Map<string, PrefixBinding>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = name;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const binding = bindings.get(cur);
    if (!binding) break;
    parts.unshift(...binding.segments);
    cur = binding.parent;
  }
  return parts.join('/');
}

/**
 * The LEXICAL mount prefix of a registration call — the path arguments of every enclosing mount
 * call, outermost first. This is chi's shape and it is exact: the nested registration really is
 * inside the closure the mount was given.
 */
function lexicalPrefix(call: TsNode, mountMethods: Set<string>): string {
  const parts: string[] = [];
  let cur: TsNode | null = call.parent ?? null;
  while (cur) {
    if (cur.type === CALL_EXPRESSION) {
      const sel = selectorCall(cur);
      const raw = sel && mountMethods.has(sel.field) ? literalValue(callArgs(cur)[0]) : undefined;
      if (raw !== undefined) parts.unshift(raw);
    }
    cur = cur.parent;
  }
  return parts.join('/');
}

/**
 * Verbs from a chained `.Methods("GET", "POST")` — gorilla/mux's shape, where the registration
 * call itself carries no verb and the restriction hangs off its return value.
 */
function chainedMethods(call: TsNode): HttpMethod[] {
  const selector = call.parent;
  if (selector?.type !== SELECTOR_EXPRESSION) return [];
  if ((selector.childForFieldName?.('field')?.text as string | undefined) !== 'Methods') return [];
  const outer = selector.parent;
  if (outer?.type !== CALL_EXPRESSION) return [];
  return callArgs(outer)
    .map((a: TsNode) => literalValue(a)?.toUpperCase())
    .filter((v: string | undefined): v is HttpMethod => v !== undefined && HTTP_VERBS.has(v));
}

// =============================================================================
// Declaration indexes (handler resolution)
// =============================================================================

interface DeclIndex {
  /** `${dir}#${name}` → package-scope func ids. A list, so an ambiguous name can be dropped. */
  funcIds: Map<string, string[]>;
  /** `${dir}#${Type}` → (method name → id). */
  methods: Map<string, Map<string, string>>;
  /** `${dir}#${Type}` → the method NODES, so the gRPC lane can read their locations. */
  methodNodes: Map<string, Array<{ file: GoFile; node: TsNode }>>;
  /** package-scope func id → its declaration, so a handler FACTORY can be looked inside. */
  funcNodes: Map<string, { file: GoFile; node: TsNode }>;
}

/** Index the package-scope funcs and the methods per receiver type, keyed by PACKAGE (directory). */
function indexDecls(files: GoFile[], idGen: StableIdGenerator): DeclIndex {
  const funcIds = new Map<string, string[]>();
  const methods = new Map<string, Map<string, string>>();
  const methodNodes = new Map<string, Array<{ file: GoFile; node: TsNode }>>();
  const funcNodes = new Map<string, { file: GoFile; node: TsNode }>();

  for (const file of files) {
    const dir = repoDir(file.relPath);
    for (const fn of file.root.descendantsOfType(FUNCTION_DECLARATION) as TsNode[]) {
      const name = itemName(fn);
      if (!name || nearestAncestor(fn, new Set([FUNCTION_DECLARATION, METHOD_DECLARATION, FUNC_LITERAL]))) continue;
      const key = `${dir}#${name}`;
      const list = funcIds.get(key) ?? [];
      const id = goFunctionId(idGen, file.relPath, fn);
      list.push(id);
      funcIds.set(key, list);
      if (!funcNodes.has(id)) funcNodes.set(id, { file, node: fn });
    }
    for (const decl of file.root.descendantsOfType(METHOD_DECLARATION) as TsNode[]) {
      const typeName = receiverTypeName(decl);
      const name = itemName(decl);
      if (!typeName || !name) continue;
      const key = `${dir}#${typeName}`;
      let m = methods.get(key);
      if (!m) {
        m = new Map<string, string>();
        methods.set(key, m);
      }
      if (!m.has(name)) m.set(name, goFunctionId(idGen, file.relPath, decl));
      const nodes = methodNodes.get(key) ?? [];
      nodes.push({ file, node: decl });
      methodNodes.set(key, nodes);
    }
  }
  return { funcIds, methods, methodNodes, funcNodes };
}

/**
 * Resolve a handler ARGUMENT to a real FunctionNode id.
 *
 * Three decidable shapes:
 *
 *   - an inline closure, whose id the def index also mints, so the entrypoint points at a real node;
 *   - a bare name — a package-scope func, resolved only when UNIQUE in the package;
 *   - `v.Method`, where `v`'s named TYPE comes from the shared type environment. This is the shape
 *     real routers are written in (`h := handler.New(…)` in `main`, `r.Get("/api/me", h.GetMe)`
 *     with `Handler` declared in another package), and it subsumes the enclosing method's own
 *     receiver (`s.ListUsers`) — a receiver is just a `parameter_declaration` to the environment.
 *     The method index is keyed by PACKAGE, and the lookup uses the type's OWN directory rather
 *     than the registering file's: `main` almost never declares the handlers it mounts.
 *
 * Everything the environment cannot decide (an interface-typed value, `http.HandlerFunc(h)`, a
 * handler reached through an embedded struct) falls back to the synthetic id, exactly like Rust's
 * router lane — a route the graph still lists, with no fabricated handler attached.
 */
function resolveHandler(
  arg: TsNode | undefined,
  file: GoFile,
  index: DeclIndex,
  idGen: StableIdGenerator,
  typeEnv: GoTypeEnv,
): string | undefined {
  if (!arg) return undefined;
  if (arg.type === FUNC_LITERAL) return goFunctionId(idGen, file.relPath, arg);
  if (arg.type === IDENTIFIER) {
    const ids = index.funcIds.get(`${repoDir(file.relPath)}#${arg.text as string}`);
    return ids && ids.length === 1 ? ids[0] : undefined;
  }
  if (arg.type === CALL_EXPRESSION) {
    // A handler FACTORY — `r.Get("/x", handleX(dep))`, `huma.Register(api, op, handleX(dep))` —
    // closes over its dependencies and returns the real handler. The request lands in that
    // returned closure, so it is the handler; a factory returning anything else is itself the
    // nearest real node.
    const fn = arg.childForFieldName?.('function') as TsNode | undefined;
    if (fn?.type !== IDENTIFIER) return undefined;
    const ids = index.funcIds.get(`${repoDir(file.relPath)}#${fn.text as string}`);
    if (!ids || ids.length !== 1) return undefined;
    const decl = index.funcNodes.get(ids[0]);
    const closures = returnedClosures(decl?.node);
    return decl && closures.length === 1 ? goFunctionId(idGen, decl.file.relPath, closures[0]) : ids[0];
  }
  if (arg.type === SELECTOR_EXPRESSION) {
    const operand = arg.childForFieldName?.('operand') as TsNode | undefined;
    const field = arg.childForFieldName?.('field')?.text as string | undefined;
    if (!operand || !field) return undefined;
    const receiver = typeEnv.resolveOperand(operand, file);
    if (receiver.kind !== 'type') return undefined;
    // Keyed on the TYPE's declaring directory, never the registering file's. `main` mounts handlers
    // it does not declare, so the caller's dir finds nothing at best — and at worst finds a
    // same-named type sitting next to `main` and binds the route to a method that never serves it.
    return index.methods.get(`${receiver.type.dir}#${receiver.type.name}`)?.get(field);
  }
  return undefined;
}

/** The `func_literal`s a declaration returns DIRECTLY (not from a nested closure). */
function returnedClosures(decl: TsNode | undefined): TsNode[] {
  if (!decl) return [];
  const body = decl?.childForFieldName?.('body') as TsNode | undefined;
  if (!body) return [];
  const out: TsNode[] = [];
  for (const ret of body.descendantsOfType(RETURN_STATEMENT) as TsNode[]) {
    if (nearestAncestor(ret, new Set([FUNCTION_DECLARATION, METHOD_DECLARATION, FUNC_LITERAL]))?.id !== decl.id)
      continue;
    const list = ret.namedChild(0) as TsNode | undefined;
    const value = list?.type === FUNC_LITERAL ? list : (list?.namedChild?.(0) as TsNode | undefined);
    if (value?.type === FUNC_LITERAL) out.push(value);
  }
  return out;
}

// =============================================================================
// Entrypoint builders
// =============================================================================

/**
 * The HTTP methods a registration call declares.
 *
 * `Method("GET", "/p", h)` names its verb in argument 0. `Handle`/`HandleFunc` name none — except
 * under Go 1.22's `ServeMux`, whose pattern may lead with the verb (`"GET /items"`), which is read
 * off the path. A registration that still names no verb falls back to GET, the same convention the
 * python and rust substrates use and for the same reason: the cross-repo linker joins on the PATH,
 * so the verb is a label rather than part of the key, and dropping the route entirely would lose
 * every stdlib `ServeMux` endpoint.
 */
function methodsOf(field: string, args: TsNode[], rawPath: string): { methods: HttpMethod[]; path: string } {
  if (VERB_ARG_METHODS.has(field)) {
    const declared = literalValue(args[0])?.toUpperCase();
    return { methods: declared && HTTP_VERBS.has(declared) ? [declared as HttpMethod] : [], path: rawPath };
  }
  if (VERBLESS_METHODS.has(field)) {
    const m = /^([A-Z]+)\s+(\/.*)$/.exec(rawPath);
    if (m && HTTP_VERBS.has(m[1])) return { methods: [m[1] as HttpMethod], path: m[2] };
    return { methods: ['GET'], path: rawPath };
  }
  const verb = field.toUpperCase();
  return { methods: HTTP_VERBS.has(verb) ? [verb as HttpMethod] : [], path: rawPath };
}

/** Every HTTP entrypoint registered through a router call shape. */
function httpEntrypoints(
  files: GoFile[],
  idGen: StableIdGenerator,
  index: DeclIndex,
  routerMethods: Set<string>,
  mountMethods: Set<string>,
  typeEnv: GoTypeEnv,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const file of files) {
    const bindings = prefixBindings(file, mountMethods);
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const sel = selectorCall(call);
      if (!sel || !routerMethods.has(sel.field)) continue;
      const args = callArgs(call);
      // The path is argument 0 for every form except the explicit-verb one, where it is argument 1.
      const pathArg = VERB_ARG_METHODS.has(sel.field) ? args[1] : args[0];
      const rawPath = literalValue(pathArg);
      // A path held in a const or built at runtime is not statically decidable — skipped rather
      // than reported at a path the server does not serve.
      if (rawPath === undefined) continue;

      const { methods, path } = methodsOf(sel.field, args, rawPath);
      // A registration path is ALWAYS rooted. This gate is the only thing separating a route from
      // the enormous set of same-named non-router calls that also take a string literal:
      // `r.Header.Get("Authorization")` appears in essentially every authenticated Go handler, and
      // `params.Get("page")` / `viper.Get("key")` / any map-like `Get` are just as common. Without
      // it `normalizePath` bolts a leading slash onto the argument and fabricates `GET
      // /Authorization` — and because `go-signals.ts` applies this same rule to the DENOMINATOR,
      // the fabricated routes would inflate the numerator past the denominator and read as a PASS.
      // Checked AFTER methodsOf so Go 1.22's `ServeMux` verb-in-pattern form ("GET /items", whose
      // path has already been split out) still passes. The cost is the rare framework-tolerated
      // relative registration (gin accepts `v1.GET("users", h)`); dropping those is the correct
      // direction for a precision-first substrate.
      if (!path.startsWith('/')) continue;
      const chained = chainedMethods(call);
      const verbs = chained.length > 0 ? chained : methods;
      if (verbs.length === 0) continue;

      const base = [
        boundPrefix(sel.operand.type === IDENTIFIER ? (sel.operand.text as string) : undefined, bindings),
        lexicalPrefix(call, mountMethods),
      ]
        .filter(Boolean)
        .join('/');
      const fullPath = normalizePath(templatize(`${base}/${path}`));
      const handlerArg = VERB_ARG_METHODS.has(sel.field) ? args[2] : args[1];
      const handlerId = resolveHandler(handlerArg, file, index, idGen, typeEnv);
      for (const method of verbs) {
        out.push(
          httpEntrypoint(
            idGen,
            method,
            fullPath,
            file.relPath,
            call.startPosition.row + 1,
            call.endPosition.row + 1,
            handlerId,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * gRPC services: `pb.RegisterUserServiceServer(s, impl)` names the SERVICE, and the entrypoints are
 * the exported methods on the implementing type — that is where a request lands. The generated
 * `mustEmbedUnimplemented…` guard method is excluded: it is a compile-time forward-compatibility
 * marker with no wire presence.
 */
function grpcEntrypoints(
  files: GoFile[],
  idGen: StableIdGenerator,
  index: DeclIndex,
  suffixes: string[],
): Entrypoint[] {
  const out: Entrypoint[] = [];
  const registerRe = new RegExp(
    `^Register(.+?)(${suffixes.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  );

  for (const file of files) {
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const fn = call.childForFieldName?.('function') as TsNode | undefined;
      const name =
        fn?.type === SELECTOR_EXPRESSION
          ? (fn.childForFieldName?.('field')?.text as string | undefined)
          : fn?.type === IDENTIFIER
            ? (fn.text as string)
            : undefined;
      const m = name ? registerRe.exec(name) : null;
      if (!m) continue;
      const serviceName = m[1];
      const impl = callArgs(call)[1];
      const typeName = implTypeName(impl, file);
      if (!typeName) continue;
      for (const { file: methodFile, node } of index.methodNodes.get(`${repoDir(file.relPath)}#${typeName}`) ?? []) {
        const methodName = itemName(node);
        if (!methodName || !isExported(methodName) || methodName.startsWith('mustEmbedUnimplemented')) continue;
        const id = idGen.grpcEntrypointId(serviceName, methodName, methodFile.relPath);
        const details: GrpcEntrypointDetails = {
          type: 'grpc',
          serviceName,
          methodName,
          // Streaming is declared in the .proto, not in the Go signature this substrate reads;
          // 'unary' is the shape of the overwhelming majority and the honest default to state.
          streaming: 'unary',
        };
        out.push({
          id,
          versionedId: idGen.versionedId(id, `${serviceName}.${methodName}`),
          type: 'grpc',
          handlerId: goFunctionId(idGen, methodFile.relPath, node),
          location: {
            filePath: methodFile.relPath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          },
          details,
        });
      }
    }
  }
  return out;
}

/**
 * The TYPE of a gRPC service implementation argument: `&server{}` / `server{}` directly, or a name
 * bound to one earlier in the same file (`srv := &server{}`). A value from anywhere else is not
 * resolvable without type inference and is dropped.
 */
function implTypeName(arg: TsNode | undefined, file: GoFile): string | undefined {
  if (!arg) return undefined;
  const literal =
    arg.type === COMPOSITE_LITERAL ? arg : (arg.descendantsOfType?.(COMPOSITE_LITERAL)?.[0] as TsNode | undefined);
  if (literal && arg.type !== IDENTIFIER) {
    return baseTypeName(literal.childForFieldName?.('type')?.text as string | undefined);
  }
  if (arg.type !== IDENTIFIER) return undefined;
  const wanted = arg.text as string;
  for (const stmt of file.root.descendantsOfType(SHORT_VAR_DECLARATION) as TsNode[]) {
    const left = stmt.childForFieldName?.('left') as TsNode | undefined;
    const right = stmt.childForFieldName?.('right') as TsNode | undefined;
    const n = left?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      if ((left.namedChild(i)?.text as string | undefined) !== wanted) continue;
      const value = right?.namedChild?.(i) as TsNode | undefined;
      const lit =
        value?.type === COMPOSITE_LITERAL
          ? value
          : (value?.descendantsOfType?.(COMPOSITE_LITERAL)?.[0] as TsNode | undefined);
      const typeName = baseTypeName(lit?.childForFieldName?.('type')?.text as string | undefined);
      if (typeName) return typeName;
    }
  }
  return undefined;
}

/** The `Key: value` elements of a composite literal's body, by key name. */
function literalFields(literal: TsNode): Map<string, TsNode> {
  const out = new Map<string, TsNode>();
  const body = literal.childForFieldName?.('body') as TsNode | undefined;
  for (const el of namedChildrenOfType(body, KEYED_ELEMENT)) {
    const key = el.namedChild(0) as TsNode | undefined;
    const value = el.namedChild(1) as TsNode | undefined;
    const keyText = (key?.text ?? '') as string;
    if (keyText && value && !out.has(keyText)) out.set(keyText, value.namedChild?.(0) ?? value);
  }
  return out;
}

/** CLI commands declared as a framework `Command` composite literal. */
function cliEntrypoints(
  files: GoFile[],
  idGen: StableIdGenerator,
  index: DeclIndex,
  frameworks: string[],
  typeEnv: GoTypeEnv,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const file of files) {
    for (const literal of file.root.descendantsOfType(COMPOSITE_LITERAL) as TsNode[]) {
      const typeText = literal.childForFieldName?.('type')?.text as string | undefined;
      const framework = frameworks.find((f) => CLI_SHAPES[f] && typeText === CLI_SHAPES[f].typeName);
      if (!framework) continue;
      const shape = CLI_SHAPES[framework];
      const fields = literalFields(literal);
      // cobra writes usage, not just a name: `Use: "serve [flags]"` — the command is the first word.
      const raw = literalValue(fields.get(shape.nameField));
      const command = raw?.trim().split(/\s+/)[0];
      if (!command) continue;
      const actionNode = shape.actionFields.map((f) => fields.get(f)).find((n) => n !== undefined);
      const id = idGen.entrypointId('cli', command, file.relPath);
      const details: CliEntrypointDetails = { type: 'cli', command };
      out.push({
        id,
        versionedId: idGen.versionedId(id, `${framework}:${command}`),
        type: 'cli',
        handlerId:
          resolveHandler(actionNode, file, index, idGen, typeEnv) ?? idGen.functionId(file.relPath, `cli ${command}`),
        location: {
          filePath: file.relPath,
          startLine: literal.startPosition.row + 1,
          endLine: literal.endPosition.row + 1,
        },
        details,
      });
    }
  }
  return out;
}

// =============================================================================
// huma operations
// =============================================================================

/** `dir` → package-scope `const`/`var` name → its value expression (first binding wins). */
type PackageValues = Map<string, Map<string, TsNode>>;

function packageScopeValues(files: GoFile[]): PackageValues {
  const out: PackageValues = new Map();
  for (const file of files) {
    const dir = repoDir(file.relPath);
    const bucket = out.get(dir) ?? new Map<string, TsNode>();
    out.set(dir, bucket);
    const n = file.root?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      const decl = file.root.namedChild(i) as TsNode | undefined;
      if (decl?.type !== CONST_DECLARATION && decl?.type !== VAR_DECLARATION) continue;
      const specs = [
        ...((decl.descendantsOfType?.(CONST_SPEC) ?? []) as TsNode[]),
        ...((decl.descendantsOfType?.(VAR_SPEC) ?? []) as TsNode[]),
      ];
      for (const spec of specs) {
        const value = spec.childForFieldName?.('value') as TsNode | undefined;
        namedChildrenOfType(spec, IDENTIFIER).forEach((ident: TsNode, idx: number) => {
          const name = ident.text as string;
          const v = value?.namedChild?.(idx) as TsNode | undefined;
          if (v && name !== '_' && !bucket.has(name)) bucket.set(name, v);
        });
      }
    }
  }
  return out;
}

/**
 * The static string an expression evaluates to: a literal, a `+` concatenation, or a package-scope
 * const/var of the same package (`ManagementPrefix + "/ping"`, the dominant huma spelling).
 * Anything runtime-built stays undefined, so the route is skipped rather than reported wrong.
 */
function staticString(
  node: TsNode | undefined,
  dir: string,
  values: PackageValues,
  seen = new Set<string>(),
): string | undefined {
  if (!node) return undefined;
  if (STRING_LITERAL_TYPES.has(node.type)) return goStringValue(node);
  if (node.type === PARENTHESIZED_EXPRESSION) return staticString(node.namedChild(0), dir, values, seen);
  if (node.type === BINARY_EXPRESSION) {
    if ((node.childForFieldName?.('operator')?.text as string | undefined) !== '+') return undefined;
    const left = staticString(node.childForFieldName?.('left'), dir, values, seen);
    const right = left === undefined ? undefined : staticString(node.childForFieldName?.('right'), dir, values, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === IDENTIFIER) {
    const name = node.text as string;
    const key = `${dir}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    return staticString(values.get(dir)?.get(name), dir, values, seen);
  }
  return undefined;
}

/** `http.MethodGet` / `"GET"` → the verb. */
function humaMethod(node: TsNode | undefined): HttpMethod | undefined {
  if (!node) return undefined;
  const raw =
    node.type === SELECTOR_EXPRESSION
      ? (node.childForFieldName?.('field')?.text as string | undefined)?.replace(/^Method/, '')
      : literalValue(node);
  const verb = raw?.toUpperCase();
  return verb && HTTP_VERBS.has(verb) ? (verb as HttpMethod) : undefined;
}

/** The `huma.Operation{…}` literal an argument holds: inline, `&…`, or a local bound to one. */
function operationLiteral(arg: TsNode | undefined, call: TsNode): TsNode | undefined {
  if (!arg) return undefined;
  if (arg.type === UNARY_EXPRESSION) return operationLiteral(arg.childForFieldName?.('operand'), call);
  if (arg.type === COMPOSITE_LITERAL) return arg;
  if (arg.type !== IDENTIFIER) return undefined;
  const scope = nearestAncestor(call, new Set([FUNCTION_DECLARATION, METHOD_DECLARATION, FUNC_LITERAL]));
  for (const stmt of (scope?.descendantsOfType?.(SHORT_VAR_DECLARATION) ?? []) as TsNode[]) {
    const left = stmt.childForFieldName?.('left') as TsNode | undefined;
    const right = stmt.childForFieldName?.('right') as TsNode | undefined;
    const n = left?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      if ((left.namedChild(i)?.text as string | undefined) !== arg.text) continue;
      const value = right?.namedChild?.(i) as TsNode | undefined;
      if (value?.type === COMPOSITE_LITERAL || value?.type === UNARY_EXPRESSION) return operationLiteral(value, call);
    }
  }
  return undefined;
}

/**
 * huma operations. A call counts only when its qualifier is THIS file's import of the huma module
 * (so an unrelated `Register` never matches), and the path must evaluate statically and be rooted —
 * the same precision gate the router lane applies.
 */
function humaEntrypoints(
  files: GoFile[],
  idGen: StableIdGenerator,
  index: DeclIndex,
  typeEnv: GoTypeEnv,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  const values = packageScopeValues(files);
  for (const file of files) {
    const imports = buildImportTable(file);
    const humaLocals = new Set([...imports.byLocal].filter(([, path]) => HUMA_IMPORT_RE.test(path)).map(([l]) => l));
    if (humaLocals.size === 0) continue;
    const dir = repoDir(file.relPath);
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const sel = selectorCall(call);
      if (!sel || sel.operand.type !== IDENTIFIER || !humaLocals.has(sel.operand.text as string)) continue;
      const args = callArgs(call);
      let method: HttpMethod | undefined;
      let rawPath: string | undefined;
      if (sel.field === 'Register') {
        const op = operationLiteral(args[1], call);
        if (!op) continue;
        const fields = literalFields(op);
        method = humaMethod(fields.get('Method'));
        rawPath = staticString(fields.get('Path'), dir, values);
      } else if (HUMA_VERB_HELPERS[sel.field]) {
        method = HUMA_VERB_HELPERS[sel.field];
        rawPath = staticString(args[1], dir, values);
      } else {
        continue;
      }
      if (!method || rawPath === undefined || !rawPath.startsWith('/')) continue;
      const fullPath = normalizePath(templatize(rawPath));
      const handlerId = resolveHandler(args[2], file, index, idGen, typeEnv);
      out.push(
        httpEntrypoint(
          idGen,
          method,
          fullPath,
          file.relPath,
          call.startPosition.row + 1,
          call.endPosition.row + 1,
          handlerId,
        ),
      );
    }
  }
  return out;
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Extract Go entrypoints: HTTP routes from router call shapes (with statically-decidable base-path
 * composition), generated gRPC service methods, and gated CLI commands. De-duped by entrypoint id,
 * which is what keeps a route registered inside a helper called from two places from being emitted
 * twice.
 */
export function extractGoEntrypoints(files: GoFile[], idGen: StableIdGenerator, cfg: GoEntrypointConfig): Entrypoint[] {
  const routerMethods = new Set(cfg.routerMethods ?? DEFAULT_ROUTER_METHODS);
  const mountMethods = new Set(cfg.mountMethods ?? DEFAULT_MOUNT_METHODS);
  const grpcSuffixes = cfg.grpcServiceSuffixes ?? ['Server'];
  const frameworks = (cfg.cliFrameworks ?? DEFAULT_CLI_FRAMEWORKS).filter((f) => {
    const gate = CLI_GATE_MODULES[f];
    // An unknown framework name has no gate module to check; running it would be exactly the
    // fabrication risk the gate exists to prevent, so it stays off.
    return gate !== undefined && dependsOnAny(cfg.modules, gate);
  });

  const index = indexDecls(files, idGen);
  // Derived inputs, built here only when the caller had none to share (see GoEntrypointConfig).
  const packageIndex = cfg.packageIndex ?? buildPackageIndex(files, cfg.modules);
  const typeEnv = cfg.typeEnv ?? buildGoTypeEnv(files, packageIndex);

  const out: Entrypoint[] = [];
  const seen = new Set<string>();
  for (const ep of [
    ...httpEntrypoints(files, idGen, index, routerMethods, mountMethods, typeEnv),
    ...(dependsOnAny(cfg.modules, [HUMA_MODULE]) ? humaEntrypoints(files, idGen, index, typeEnv) : []),
    ...grpcEntrypoints(files, idGen, index, grpcSuffixes),
    ...cliEntrypoints(files, idGen, index, frameworks, typeEnv),
  ]) {
    if (seen.has(ep.id)) continue;
    seen.add(ep.id);
    out.push(ep);
  }
  return out;
}
