/**
 * Go EGRESS extraction — the outbound calls a Go service makes to OTHER services, which is what
 * makes it a cross-repo CONSUMER. Generic HTTP client PACKAGES only (`net/http` / resty,
 * profile-configurable) plus the shared SDK registry; NO client-specific hosts, paths or type
 * names live here.
 *
 * Everything routes through ONE question — "which package does this call's receiver come from?" —
 * answered by `valuePackage()` and then dispatched two ways:
 *
 *   (1) the package is a configured HTTP CLIENT → an http edge carrying a joinable path template
 *       and `serviceName: ''` (the linker recovers the target from the route prefix);
 *   (2) the package is a known SDK in `@coredoc/core`'s registry → an edge whose destination is
 *       the SERVICE ITSELF (`serviceName: 'Stripe'`), with no path — the SDK owns the wire format.
 *
 * The receiver resolves through three tiers, mirroring `rust-egress.ts`:
 *   (a) a package qualifier — `http.Get(url)`, `http.DefaultClient.Get(url)`, `openai.NewClient(k)`;
 *   (b) a LOCAL or PARAMETER bound to a client value — `c := resty.New()`, `func f(c *http.Client)`;
 *   (c) a STRUCT FIELD whose declared type is a client — `s.http.Get(url)` where the enclosing
 *       method's receiver type declares `http *http.Client`. Go splits a type's declaration and its
 *       methods across files of one package routinely, so this index is PACKAGE-scoped (= per
 *       directory), not per file.
 *
 * Once a tier resolves the ROOT of a chain, further field hops stay inside that package —
 * `c.sdk.Chat.Completions.New(ctx, p)` is the openai-go client reached through two namespace
 * fields, and resolving only `c.sdk` would drop every call a modern namespaced SDK actually makes.
 *
 * A receiver that resolves to no package is SKIPPED. `Get` is also `http.Header.Get`,
 * `url.Values.Get` and every map-ish accessor in the ecosystem, so an ungated verb match would bury
 * the real egress edges. That gate is why `resp.Header.Get("Content-Type")` — the single most
 * common `.Get` in Go — emits nothing: a FIELD access (`resp.Header`) is only followed when its
 * operand is a package qualifier or a client-typed struct field, never as a bare chain.
 *
 * A URL is read from the call's argument, and — when that argument is a bare name — from the ONE
 * expression the enclosing function assigns it (`singleAssignedLocals`). Go's dominant request
 * idiom builds the URL on the line above the call, so reading only the argument drops most of a
 * repo's egress.
 *
 * Documented Tier-B gaps (bounded on purpose, never guessed):
 *   - `client.Do(req)` emits NOTHING. The request it sends carries no URL at the `Do` call site;
 *     the `http.NewRequest*` that BUILT it is the site that has both the method and the URL, and it
 *     already emitted the edge. Emitting at both would double-count every stdlib request.
 *   - a URL assembled from a PACKAGE-level `const baseURL` / `const apiPath` resolves only as far
 *     as its literal part — const inlining is the engine's job, not the substrate's. Only
 *     FUNCTION-local names resolve, and only when the function assigns them exactly once.
 *   - a URL that arrives as a PARAMETER (`func doGet(ctx, apiURL string)`) stays unresolved: the
 *     literal sits at the caller, one intra-procedural hop away.
 *   - a request EXECUTED through a repo-internal dispatcher — `func (c *Client) do(req
 *     *resty.Request, method, path string)` with a single `req.Execute(method, path)` inside —
 *     emits nothing. Both the verb and the path are parameters at the only client call site; the
 *     literals sit at the dispatcher's CALLERS, one intra-repo hop away. Following that hop is
 *     inter-procedural, which this substrate deliberately does not do.
 *   - `<base var> + <path var>` (`c.BaseURL + path`) renders to no literal at all and is dropped:
 *     a template of just `{_}` joins to every route in the target repo, so it is worse than none.
 *   - `url.JoinPath` / `path.Join` URL assembly is not rendered.
 *   - bindings are collected per file and are NOT flow-sensitive (the python/rust precedent): a
 *     name bound to a client anywhere in a file counts throughout it.
 */
import type { ExternalCallEdge, HttpMethod, StableIdGenerator } from '@coredoc/core';
import { type SdkPackage, lookupSdkByPackage } from '@coredoc/core/base-parser/sdk-registry';
import {
  ASSIGNMENT_STATEMENT,
  CALL_EXPRESSION,
  COMPOSITE_LITERAL,
  DEF_TYPES,
  EXPRESSION_LIST,
  FIELD_DECLARATION,
  type GoFile,
  IDENTIFIER,
  METHOD_DECLARATION,
  PARAMETER_DECLARATION,
  QUALIFIED_TYPE,
  RANGE_CLAUSE,
  SELECTOR_EXPRESSION,
  SHORT_VAR_DECLARATION,
  STRING_LITERAL_TYPES,
  STRUCT_TYPE,
  TYPE_SPEC,
  type TsNode,
  VAR_SPEC,
  baseTypeName,
  enclosingFunction,
  fieldNames,
  goFunctionId,
  goStringValue,
  itemName,
  namedChildrenOfType,
  nearestAncestor,
  receiverTypeName,
} from './go-cst.js';
import { type GoImportTable, buildImportTable, defaultLocalName } from './go-imports.js';

/**
 * Client packages whose calls are egress. `net/http` is the stdlib client every Go service already
 * has; resty is the dominant third-party one. Both are PUBLIC ecosystem conventions, not repo
 * specifics — a per-repo profile extends the list (`clientPackages`) for anything else.
 */
const DEFAULT_CLIENT_PACKAGES = ['net/http', 'github.com/go-resty/resty'];

/** The stdlib client package, whose call shapes are a fixed table rather than the verb rule. */
const NET_HTTP = 'net/http';
/** The stdlib formatting package — `fmt.Sprintf` is how most dynamic Go URLs are assembled. */
const FMT = 'fmt';

/** Node types the Go substrate does not otherwise need, so they are not in `go-cst.ts`. */
const BINARY_EXPRESSION = 'binary_expression';
const UNARY_EXPRESSION = 'unary_expression';
const PARENTHESIZED_EXPRESSION = 'parenthesized_expression';

/** HTTP verbs that name an egress call when they are a method on a client value. */
const VERBS = new Set<string>(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * Where a `net/http` call keeps its URL and its verb.
 *
 * Encoded as a TABLE rather than discovered by scanning the arguments for something string-shaped:
 * `http.Post(url, contentType, body)` has two string arguments and only the first is a URL, and
 * `http.NewRequest("PATCH", url, body)` has the verb in one and the URL in the next. A scan would
 * silently emit `POST application/json` for the first and `GET /PATCH` for the second.
 *
 * The same names are the verb methods on an `*http.Client` value (`client.Get(url)`), so one table
 * serves both the package-call and the method-call shape. `Do` is deliberately absent (see header).
 */
interface HttpCallShape {
  /** The verb, when the function name fixes it. */
  method?: HttpMethod;
  /** Argument index holding the verb, when the call takes it as a parameter. */
  methodArg?: number;
  /** Argument index holding the URL. */
  urlArg: number;
}

// A Map, not a Record: the key is an arbitrary method name read out of source, and an object index
// would hand back `Object.prototype` members for a method named `toString` or `constructor`.
const NET_HTTP_CALLS = new Map<string, HttpCallShape>([
  ['Get', { method: 'GET', urlArg: 0 }],
  ['Head', { method: 'HEAD', urlArg: 0 }],
  ['Post', { method: 'POST', urlArg: 0 }],
  ['PostForm', { method: 'POST', urlArg: 0 }],
  ['NewRequest', { methodArg: 0, urlArg: 1 }],
  ['NewRequestWithContext', { methodArg: 1, urlArg: 2 }],
]);

/** `http.MethodPost` → 'POST'. The prefix of the stdlib's verb constants. */
const METHOD_CONST_PREFIX = 'Method';

/** Go's universal constructor convention: `resty.New()`, `openai.NewClient(k)`, `s3.NewFromConfig(c)`. */
const CONSTRUCTOR_PREFIX = 'New';

/**
 * The tail a Go client TYPE name ends with, by near-universal convention (`http.Client`,
 * `resty.Client`, `s3.Client`, `openai.Client`, and the `http.DefaultClient` package value).
 * Requiring it is what keeps `req, _ := http.NewRequest(…)`-style bindings from turning every
 * `*http.Request` field into an HTTP client.
 */
const CLIENT_TYPE_SUFFIX = 'Client';

/** What a file's egress pass resolves names against. */
interface FileScope {
  /** package qualifier → import path, for every qualifier this file can name. */
  qualifiers: Map<string, string>;
  /** local / parameter name → the import path of the package whose value it holds. */
  bindings: Map<string, string>;
  /** struct name → field name → import path, for every struct in this file's PACKAGE. */
  fields: Map<string, Map<string, string>>;
}

/** The receiver of the method a call site sits in — `func (s *Svc)` → `{ name: 's', type: 'Svc' }`. */
interface MethodReceiver {
  name: string;
  type: string;
}

// =============================================================================
// Package resolution
// =============================================================================

/**
 * Whether an import path is one of the configured packages, matched on the path PREFIX at a
 * segment boundary: a gate written `github.com/go-resty/resty` matches the real import
 * `github.com/go-resty/resty/v2`, so a profile never has to spell a major-version suffix.
 */
function matchesPackage(importPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => importPath === p || importPath.startsWith(`${p}/`));
}

/** Drop Go's language marker from a module's short name: `stripe-go` / `go-openai` → the service. */
function stripLanguageMarker(name: string): string {
  return name.replace(/^go[-.]/, '').replace(/-go$/, '');
}

/**
 * The package qualifiers a file can name: its import table plus ONE correction.
 *
 * `go-imports` derives an unaliased import's local name from the path's last segment and documents
 * that as a heuristic — Go's real rule is the name the package DECLARES, which only the package's
 * own source knows. The convention that breaks the guess most often is precisely the one the SDK
 * registry cares about: a module named `<x>-go` / `go-<x>` declares `package <x>`, so
 * `github.com/twilio/twilio-go` is written `twilio.NewRestClient()` and the last-segment guess
 * ('twilio-go') is not even a legal identifier. The stripped name is therefore registered as an
 * alias of the same path when nothing else claims it. A third-party package whose declared name
 * follows no convention at all stays unresolved rather than being guessed at.
 *
 * Resolution stays inside the file's own imports on purpose: an HTTP client or an SDK is external
 * by definition, so the repo package index (`resolveQualifier`) has nothing to add here.
 */
function qualifierIndex(table: GoImportTable): Map<string, string> {
  const qualifiers = new Map(table.byLocal);
  for (const [local, importPath] of table.byLocal) {
    const stripped = stripLanguageMarker(local);
    if (stripped && stripped !== local && !qualifiers.has(stripped)) qualifiers.set(stripped, importPath);
  }
  return qualifiers;
}

/** The package a written-down CLIENT type refers to: `*http.Client` → 'net/http'. */
function clientTypePackage(typeNode: TsNode | undefined, qualifiers: Map<string, string>): string | undefined {
  if (!typeNode) return undefined;
  const qualified = (typeNode.type === QUALIFIED_TYPE ? typeNode : typeNode.descendantsOfType?.(QUALIFIED_TYPE)?.[0]) as
    | TsNode
    | undefined;
  if (!qualified) return undefined;
  if (!(baseTypeName(qualified.text) ?? '').endsWith(CLIENT_TYPE_SUFFIX)) return undefined;
  const qualifier = qualified.childForFieldName?.('package')?.text as string | undefined;
  return qualifier ? qualifiers.get(qualifier) : undefined;
}

/** Peel `&x` / `(x)`, which wrap a value without changing what it is. */
function unwrapValue(node: TsNode | undefined): TsNode | undefined {
  let cur = node;
  while (cur?.type === UNARY_EXPRESSION || cur?.type === PARENTHESIZED_EXPRESSION) {
    cur = (cur.childForFieldName?.('operand') ?? cur.namedChild?.(0)) as TsNode | undefined;
  }
  return cur;
}

/**
 * The package a bound VALUE was constructed from, when the binding site says so statically:
 *
 *   - `pkg.New…(…)`, including through a fluent builder chain (`resty.New().SetBaseURL(base)`,
 *     where every link returns the same client and only the root call constructs it);
 *   - `pkg.Client{…}` / `&pkg.Client{…}` — a composite literal of a client type;
 *   - `pkg.DefaultClient`               — a package-level client value.
 *
 * Deliberately NOT "anything rooted at a package": `resp, _ := http.Get(url)` roots at `http` too,
 * and binding `resp` to net/http would make the ubiquitous `resp.Header.Get("Content-Type")` read
 * as an outbound GET.
 */
function constructedPackage(value: TsNode | undefined, qualifiers: Map<string, string>): string | undefined {
  let cur = unwrapValue(value);
  while (cur?.type === CALL_EXPRESSION) {
    const fn = cur.childForFieldName?.('function') as TsNode | undefined;
    if (fn?.type !== SELECTOR_EXPRESSION) return undefined; // a bare `newClient()` — no provenance
    const field = (fn.childForFieldName?.('field')?.text ?? '') as string;
    const operand = unwrapValue(fn.childForFieldName?.('operand'));
    if (field.startsWith(CONSTRUCTOR_PREFIX)) {
      return operand?.type === IDENTIFIER ? qualifiers.get(operand.text as string) : undefined;
    }
    cur = operand; // a builder method — keep descending toward the constructor
  }
  if (cur?.type === COMPOSITE_LITERAL) return clientTypePackage(cur.childForFieldName?.('type'), qualifiers);
  if (cur?.type !== SELECTOR_EXPRESSION) return undefined;
  const field = (cur.childForFieldName?.('field')?.text ?? '') as string;
  if (!field.endsWith(CLIENT_TYPE_SUFFIX)) return undefined;
  const operand = cur.childForFieldName?.('operand') as TsNode | undefined;
  return operand?.type === IDENTIFIER ? qualifiers.get(operand.text as string) : undefined;
}

/**
 * Names in a file bound to a package's client value (tier b): a `:=` / `var` initialized from a
 * constructor, a `var` or PARAMETER with a declared client type. A declared type is the same class
 * of evidence as tier (c)'s struct field — Go writes the type down at the binding site — and it is
 * how a helper or a handler receives the client it uses.
 */
function collectBindings(file: GoFile, qualifiers: Map<string, string>): Map<string, string> {
  const bindings = new Map<string, string>();
  const bind = (name: TsNode | undefined, importPath: string | undefined): void => {
    const text = (name?.text ?? '') as string;
    if (text && text !== '_' && importPath) bindings.set(text, importPath);
  };

  for (const param of file.root.descendantsOfType(PARAMETER_DECLARATION) as TsNode[]) {
    const importPath = clientTypePackage(param.childForFieldName?.('type'), qualifiers);
    if (!importPath) continue;
    // `func f(a, b *http.Client)` is ONE declaration with two names — the `name` field is only the
    // first of them.
    for (const name of namedChildrenOfType(param, IDENTIFIER)) bind(name, importPath);
  }

  for (const spec of file.root.descendantsOfType(VAR_SPEC) as TsNode[]) {
    const names = namedChildrenOfType(spec, IDENTIFIER);
    const declared = clientTypePackage(spec.childForFieldName?.('type'), qualifiers);
    const values = spec.childForFieldName?.('value') as TsNode | undefined;
    names.forEach((name, i) => {
      bind(name, declared ?? constructedPackage(values?.namedChild?.(i) as TsNode | undefined, qualifiers));
    });
  }

  for (const decl of file.root.descendantsOfType(SHORT_VAR_DECLARATION) as TsNode[]) {
    const left = decl.childForFieldName?.('left') as TsNode | undefined;
    const right = decl.childForFieldName?.('right') as TsNode | undefined;
    if (left?.type !== EXPRESSION_LIST || right?.type !== EXPRESSION_LIST) continue;
    // Paired positionally, so `client, err := newBoth()` binds nothing rather than binding `err`.
    for (let i = 0; i < left.namedChildCount; i++) {
      bind(left.namedChild(i), constructedPackage(right.namedChild(i) as TsNode | undefined, qualifiers));
    }
  }

  return bindings;
}

/**
 * Client-typed struct fields, per struct name, for one file (tier c).
 *
 * Merged across a whole DIRECTORY by the caller: a Go package is a directory, and splitting
 * `type Svc struct{…}` into `types.go` while its methods live in `service.go` is the norm, so a
 * per-file index would miss the receiver type of most real call sites.
 */
function collectFields(file: GoFile, qualifiers: Map<string, string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const spec of file.root.descendantsOfType(TYPE_SPEC) as TsNode[]) {
    const structName = itemName(spec);
    const struct = spec.childForFieldName?.('type') as TsNode | undefined;
    if (!structName || struct?.type !== STRUCT_TYPE) continue;
    const fields = new Map<string, string>();
    for (const decl of struct.descendantsOfType(FIELD_DECLARATION) as TsNode[]) {
      const importPath = clientTypePackage(decl.childForFieldName?.('type'), qualifiers);
      if (!importPath) continue;
      for (const name of fieldNames(decl)) fields.set(name, importPath);
    }
    if (fields.size > 0) out.set(structName, fields);
  }
  return out;
}

/**
 * The package a receiver expression's value comes from, or undefined when it cannot be traced.
 *
 * Descends METHOD-CALL chains (`c.R().SetBody(b).Post(url)` → `c`) and FIELD chains
 * (`c.sdk.Chat.Completions` → `c.sdk`), but a field access off a plain IDENTIFIER is a boundary
 * with exactly two ways through: the identifier is a package qualifier (`http.DefaultClient.Get(…)`),
 * or it is the enclosing method's receiver and the field is client-typed (`s.http.Get(…)`). That
 * boundary is the whole precision story — it is what keeps `resp.Header.Get(…)` and
 * `r.URL.Query().Get(…)` out of the output, and descending a longer chain does not widen it: the
 * chain still has to bottom out at one of those two, so `s.cfg.Client.Get(…)` on a non-client `cfg`
 * resolves to nothing exactly as before.
 */
function valuePackage(
  expr: TsNode | undefined,
  scope: FileScope,
  recv: MethodReceiver | undefined,
): string | undefined {
  let cur = expr;
  while (cur) {
    switch (cur.type) {
      case IDENTIFIER:
        return scope.bindings.get(cur.text as string) ?? scope.qualifiers.get(cur.text as string);
      case UNARY_EXPRESSION:
      case PARENTHESIZED_EXPRESSION:
        cur = (cur.childForFieldName?.('operand') ?? cur.namedChild?.(0)) as TsNode | undefined;
        break;
      case CALL_EXPRESSION: {
        // A method call keeps the chain alive through its receiver; a bare `newClient()` has no
        // package provenance at all and ends it.
        const fn = cur.childForFieldName?.('function') as TsNode | undefined;
        cur = fn?.type === SELECTOR_EXPRESSION ? (fn.childForFieldName?.('operand') as TsNode | undefined) : undefined;
        break;
      }
      case SELECTOR_EXPRESSION: {
        const operand = cur.childForFieldName?.('operand') as TsNode | undefined;
        const field = cur.childForFieldName?.('field')?.text as string | undefined;
        if (!operand || !field) return undefined;
        if (operand.type !== IDENTIFIER) {
          // A field hop off something that is itself an expression — keep walking toward the root.
          // The gate is unchanged: whatever the root turns out to be still has to be a qualifier or
          // a client-typed receiver field, so this only reaches sub-namespaces of a value that
          // ALREADY resolved (`c.sdk.Chat`), never a new class of receiver.
          cur = operand;
          break;
        }
        const qualified = scope.qualifiers.get(operand.text as string);
        if (qualified) return qualified;
        if (recv && operand.text === recv.name) return scope.fields.get(recv.type)?.get(field);
        return undefined;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

/** The receiver of the method declaration a call site sits in, if any (tier c's anchor). */
function methodReceiver(call: TsNode): MethodReceiver | undefined {
  // `DEF_TYPES` excludes `func_literal` on purpose: a closure inside a method still sees that
  // method's receiver variable, so the nearest DECLARATION is the right anchor either way.
  const decl = nearestAncestor(call, DEF_TYPES);
  if (decl?.type !== METHOD_DECLARATION) return undefined;
  const param = decl.childForFieldName?.('receiver')?.descendantsOfType?.(PARAMETER_DECLARATION)?.[0] as
    | TsNode
    | undefined;
  const name = param?.childForFieldName?.('name')?.text as string | undefined;
  const type = receiverTypeName(decl);
  return name && type ? { name, type } : undefined;
}

// =============================================================================
// URL templates
// =============================================================================

/** A rendered URL fragment: literal text, or `null` for a piece that is not statically known. */
type UrlToken = string | null;

/** Go's `fmt` verbs — `%s`, `%-8.2f`, `%+v`, `%[1]d`, and the `%%` literal-percent escape. */
const FORMAT_VERB = /%(?:\[\d+\])?[#+\-\s0']*[\d*]*(?:\.[\d*]+)?[a-zA-Z%]/g;

/** Split a `fmt` format string into literal chunks and dynamic (verb) holes. */
function formatStringTokens(format: string): UrlToken[] {
  const out: UrlToken[] = [];
  let last = 0;
  FORMAT_VERB.lastIndex = 0;
  for (let m = FORMAT_VERB.exec(format); m; m = FORMAT_VERB.exec(format)) {
    if (m.index > last) out.push(format.slice(last, m.index));
    // `%%` is an escaped percent, not an interpolation.
    out.push(m[0].endsWith('%') ? '%' : null);
    last = m.index + m[0].length;
  }
  if (last < format.length) out.push(format.slice(last));
  return out;
}

/**
 * The expression a function assigns to each name it assigns EXACTLY ONCE.
 *
 * This is the smallest honest form of const inlining, and it buys the dominant Go request idiom —
 * the URL is built on the line ABOVE the call, not inside it:
 *
 *   endpoint := fmt.Sprintf("%s/app/installations/%d", strings.TrimRight(base, "/"), id)
 *   req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
 *
 * Both halves sit in one function, so nothing inter-procedural is needed; reading only the
 * argument would drop the edge anyway.
 *
 * EXACTLY ONCE is what makes it safe without real dataflow. A name assigned twice — a retry that
 * rewrites the URL, a branch per host, a `for … range` rebinding it per iteration — has no single
 * value, and rendering whichever assignment happened to be indexed would draw an edge to a route
 * the code never calls. Such a name is left unresolved and its call site is skipped, the same
 * outcome as a URL that is dynamic outright. PARAMETERS are tallied for the same reason: they
 * carry no value this substrate can see, so a same-named local must not lend one to them.
 *
 * Scoped to the enclosing DECLARATION rather than the nearest closure because Go closures capture
 * the enclosing function's variables — that also makes an assignment inside a closure count
 * toward the outer name, which is the conservative direction.
 */
function singleAssignedLocals(fn: TsNode | undefined): Map<string, TsNode> {
  const counts = new Map<string, number>();
  const values = new Map<string, TsNode>();
  if (!fn) return values;

  const note = (name: TsNode | undefined, value: TsNode | undefined): void => {
    const text = (name?.text ?? '') as string;
    if (!text || text === '_') return;
    counts.set(text, (counts.get(text) ?? 0) + 1);
    if (value) values.set(text, value);
  };

  for (const param of fn.descendantsOfType(PARAMETER_DECLARATION) as TsNode[]) {
    for (const name of namedChildrenOfType(param, IDENTIFIER)) note(name, undefined);
  }
  for (const clause of fn.descendantsOfType(RANGE_CLAUSE) as TsNode[]) {
    const left = clause.childForFieldName?.('left') as TsNode | undefined;
    for (let i = 0; i < (left?.namedChildCount ?? 0); i++) note(left?.namedChild(i), undefined);
  }
  for (const spec of fn.descendantsOfType(VAR_SPEC) as TsNode[]) {
    const value = spec.childForFieldName?.('value') as TsNode | undefined;
    namedChildrenOfType(spec, IDENTIFIER).forEach((name, i) =>
      note(name, value?.namedChild?.(i) as TsNode | undefined),
    );
  }
  // `:=` and `=` share one shape. Paired positionally, like `collectBindings`, so `u, err := f()`
  // records no value for `u` while still tallying the assignment.
  for (const decl of [
    ...fn.descendantsOfType(SHORT_VAR_DECLARATION),
    ...fn.descendantsOfType(ASSIGNMENT_STATEMENT),
  ] as TsNode[]) {
    const left = decl.childForFieldName?.('left') as TsNode | undefined;
    const right = decl.childForFieldName?.('right') as TsNode | undefined;
    if (left?.type !== EXPRESSION_LIST) continue;
    for (let i = 0; i < left.namedChildCount; i++) {
      note(
        left.namedChild(i),
        right?.type === EXPRESSION_LIST ? (right.namedChild(i) as TsNode | undefined) : undefined,
      );
    }
  }

  for (const [name, count] of counts) if (count !== 1) values.delete(name);
  return values;
}

/**
 * Flatten a URL expression into literal/dynamic tokens: a string literal, a `+` concatenation
 * (Go's `baseURL + "/v1/things"`), a `fmt.Sprintf(…)`, a name `locals` resolves to exactly one
 * assignment of, or — for anything else — one dynamic hole.
 */
function urlTokens(
  node: TsNode | undefined,
  scope: FileScope,
  locals: Map<string, TsNode>,
  seen: Set<string> = new Set(),
): UrlToken[] {
  if (!node) return [null];
  if (STRING_LITERAL_TYPES.has(node.type)) return [goStringValue(node) ?? ''];
  if (node.type === PARENTHESIZED_EXPRESSION) {
    return urlTokens(node.namedChild?.(0) as TsNode | undefined, scope, locals, seen);
  }
  if (node.type === IDENTIFIER) {
    const name = node.text as string;
    // Valid Go cannot make this cycle (a self-referential name is assigned at least twice, and
    // `singleAssignedLocals` already dropped it), but a partial parse must not spin here.
    if (seen.has(name)) return [null];
    const value = locals.get(name);
    if (!value) return [null];
    return urlTokens(value, scope, locals, new Set([...seen, name]));
  }
  if (node.type === BINARY_EXPRESSION) {
    // Only `+` concatenates; any other operator in a URL slot is not a template.
    if ((node.childForFieldName?.('operator')?.text as string | undefined) !== '+') return [null];
    return [
      ...urlTokens(node.childForFieldName?.('left') as TsNode | undefined, scope, locals, seen),
      ...urlTokens(node.childForFieldName?.('right') as TsNode | undefined, scope, locals, seen),
    ];
  }
  if (node.type === CALL_EXPRESSION) {
    const fn = node.childForFieldName?.('function') as TsNode | undefined;
    if (fn?.type !== SELECTOR_EXPRESSION) return [null];
    const operand = fn.childForFieldName?.('operand') as TsNode | undefined;
    const isSprintf =
      (fn.childForFieldName?.('field')?.text as string | undefined) === 'Sprintf' &&
      operand?.type === IDENTIFIER &&
      scope.qualifiers.get(operand.text as string) === FMT;
    if (!isSprintf) return [null];
    const format = node.childForFieldName?.('arguments')?.namedChild?.(0) as TsNode | undefined;
    if (!format || !STRING_LITERAL_TYPES.has(format.type)) return [null];
    return formatStringTokens(goStringValue(format) ?? '');
  }
  return [null];
}

/**
 * Render tokens as a path template. A LEADING dynamic token is the HOST (`baseURL + "/v1/x"`,
 * `fmt.Sprintf("%s/v1/x", base)`) and is dropped; every later one becomes the linker's positional
 * param token `{_}`, which normalizes exactly like a named `{id}` would. This is rust-egress's
 * `format!` policy — the only difference is that Go has no named interpolations to preserve.
 */
function renderTemplate(tokens: UrlToken[]): string {
  let out = '';
  let sawContent = false;
  for (const token of tokens) {
    if (token === null) {
      if (!sawContent) continue;
      out += '{_}';
      continue;
    }
    out += token;
    if (token.length > 0) sawContent = true;
  }
  return out;
}

/** Normalize a raw template to a path: strip a leading `http(s)://host`; require a leading `/`. */
function toPathTemplate(raw: string): string | undefined {
  let out = raw;
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(out);
  if (m) {
    // A host-only URL has no joinable route → SKIP. Emitting a bare '/' would be a bogus edge that
    // pollutes the cross-repo route join.
    if (!m[1]) return undefined;
    out = m[1];
  }
  return out.startsWith('/') ? out : undefined;
}

// =============================================================================
// Call shapes
// =============================================================================

/** The nth named argument of a call (commas and parens are anonymous; `nil` is a real node). */
function argAt(call: TsNode, index: number): TsNode | undefined {
  return call.childForFieldName?.('arguments')?.namedChild?.(index) as TsNode | undefined;
}

/**
 * The verb an `http.NewRequest`-style call passes as an argument: a string literal ("PATCH") or the
 * stdlib constant (`http.MethodPatch`). Anything else — a variable, a helper's parameter — returns
 * undefined and the SITE IS SKIPPED rather than defaulted to GET: the verb is half the join key the
 * linker matches on, so a guessed one draws an edge to the wrong route.
 */
function verbArgument(arg: TsNode | undefined, scope: FileScope): HttpMethod | undefined {
  let literal: string | undefined;
  if (arg && STRING_LITERAL_TYPES.has(arg.type)) {
    literal = goStringValue(arg);
  } else if (arg?.type === SELECTOR_EXPRESSION) {
    const operand = arg.childForFieldName?.('operand') as TsNode | undefined;
    const field = (arg.childForFieldName?.('field')?.text ?? '') as string;
    if (
      operand?.type === IDENTIFIER &&
      scope.qualifiers.get(operand.text as string) === NET_HTTP &&
      field.startsWith(METHOD_CONST_PREFIX)
    ) {
      literal = field.slice(METHOD_CONST_PREFIX.length);
    }
  }
  const verb = (literal ?? '').toLowerCase();
  return VERBS.has(verb) ? (verb.toUpperCase() as HttpMethod) : undefined;
}

/**
 * The HTTP shape of a call on a client package: the stdlib's fixed table for `net/http`, and the
 * verb-method rule (`Get`/`Post`/… with the URL first) for every other client package — which is
 * resty's shape, and the shape every Go HTTP client library follows.
 */
function httpCallShape(importPath: string, name: string): HttpCallShape | undefined {
  if (importPath === NET_HTTP) return NET_HTTP_CALLS.get(name);
  return VERBS.has(name.toLowerCase()) ? { method: name.toUpperCase() as HttpMethod, urlArg: 0 } : undefined;
}

// =============================================================================
// SDK registry
// =============================================================================

/**
 * Go import paths that can be looked up in the shared SDK registry. Only the KEY SHAPE is derived
 * here — every service name still comes from the registry, so this stays a translation and never
 * becomes a second list of SDKs. That single-registry rule is what makes a TS repo importing
 * `@slack/web-api` and this repo importing `github.com/slack-go/slack` one Slack node downstream.
 *
 * Three public conventions, in order of confidence:
 *   - the whole import path: the registry carries Go MODULE PATHS as first-class keys, and its
 *     longest-prefix walk absorbs the `/v2`+ suffix and any subpackage, so one key covers
 *     `…/slack`, `…/slack/slackevents` and `…/openai-go/v3` alike;
 *   - the two vendor namespaces whose Go SDKs are laid out one module per service, mapped onto the
 *     registry's own per-service key shape (`…/aws-sdk-go-v2/service/s3` → `@aws-sdk/client-s3`,
 *     `cloud.google.com/go/storage` → `@google-cloud/storage`);
 *   - the last path segment with Go's LANGUAGE MARKER stripped (`stripe-go` → `stripe`,
 *     `go-openai` → `openai`).
 *
 * The language marker is REQUIRED for that last rule, and that requirement is load-bearing: an
 * in-repo package at `github.com/acme/api/internal/openai` would otherwise be read as the OpenAI
 * SDK. The cost is that a third-party module the marker rule cannot reach needs an explicit
 * registry key — which is where the registry's Go entries come from, not from a Go-only fork of
 * the list.
 */
function registryKeyCandidates(importPath: string): string[] {
  const candidates = [importPath];
  // `defaultLocalName` already strips `/vN` and gopkg.in's `.vN`, which is exactly the segment
  // normalization this needs — the module's own short name.
  const last = defaultLocalName(importPath);
  const segments = importPath.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('aws-sdk-go'))) candidates.push(`@aws-sdk/client-${last}`);
  if (importPath.startsWith('cloud.google.com/go/')) candidates.push(`@google-cloud/${last}`);
  const stripped = stripLanguageMarker(last);
  if (stripped !== last && stripped) candidates.push(stripped);
  return candidates;
}

/** The registry entry for a Go import path, if it names a known third-party service SDK. */
function sdkForImportPath(importPath: string): SdkPackage | undefined {
  for (const candidate of registryKeyCandidates(importPath)) {
    const hit = lookupSdkByPackage(candidate);
    if (hit) return hit;
  }
  return undefined;
}

// =============================================================================
// Edges
// =============================================================================

/**
 * The function a call site is attributed to. `enclosingFunction` includes closures, so a handler
 * written inline (`http.HandleFunc("/x", func(…){ … })`) attributes to the closure that `go-cst`
 * mints an id for, not to the function that registered it. A call at PACKAGE scope (a `var`
 * initializer, which Go really does run at init time with no owning function) gets the synthetic
 * `egress@<line>` caller the python and rust substrates use.
 */
function callerIdFor(idGen: StableIdGenerator, relPath: string, call: TsNode, line: number): string {
  const fn = enclosingFunction(call);
  return fn ? goFunctionId(idGen, relPath, fn) : idGen.functionId(relPath, `egress@${line}`);
}

/** Build the `ExternalCallEdge` for one HTTP egress call site. */
function httpEdge(
  idGen: StableIdGenerator,
  relPath: string,
  call: TsNode,
  method: HttpMethod,
  path: string,
  originalPath: string,
): ExternalCallEdge {
  const line = (call.startPosition.row as number) + 1;
  const callerId = callerIdFor(idGen, relPath, call, line);
  const id = idGen.externalCallId(callerId, '', method, `${relPath}:${line}:${path}`);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${path}`),
    callerId,
    // A DOCUMENTED ABSENCE, identical to what `rust-egress.ts`, `python-egress.ts` and the ruby
    // substrate emit: an HTTP client call names a URL, never a service, so there is no honest name
    // to put here. Both consumers read `targetDescriptor.targetService ?? serviceName` and treat
    // the empty result as "no service": `cross-repo/linker.ts` skips the `unresolvableServices`
    // exclusion for it and resolves the target from the path template instead, and MCP's
    // `list-service-dependencies` drops the row rather than opening a blank service.
    //
    // Filling it would be worse than leaving it empty. The transport literal 'http' collides with
    // the linker's `unresolvableServices` and would exclude every egress call; a host or a client
    // type name would become a service node that no producer repo can ever match.
    serviceName: '',
    method,
    targetDescriptor: { protocol: 'http', http: { method, pathTemplate: path, originalPath } },
    location: { filePath: relPath, startLine: line, endLine: line },
  };
}

/**
 * Build the `ExternalCallEdge` for one SDK call site. Here the destination IS the service, so
 * `serviceName` carries the registry's name and there is no path: the SDK owns the wire format.
 * A `protocol: 'sdk'` entry (Sentry and friends) carries NO descriptor, matching what the engine
 * emits for the ts-morph registry path.
 */
function sdkEdge(
  idGen: StableIdGenerator,
  relPath: string,
  call: TsNode,
  sdk: SdkPackage,
  importPath: string,
  method: string,
): ExternalCallEdge {
  const line = (call.startPosition.row as number) + 1;
  const callerId = callerIdFor(idGen, relPath, call, line);
  const id = idGen.externalCallId(callerId, importPath, method, `${relPath}:${line}`);
  const edge: ExternalCallEdge = {
    id,
    versionedId: idGen.versionedId(id, `${sdk.service}.${method}`),
    callerId,
    serviceName: sdk.service,
    sdkName: importPath,
    method,
    location: { filePath: relPath, startLine: line, endLine: line },
  };
  if (sdk.protocol === 'http' || sdk.protocol === 'grpc') {
    edge.targetDescriptor = { protocol: sdk.protocol, targetService: sdk.service };
  }
  return edge;
}

// =============================================================================
// Entry point
// =============================================================================

/** The directory of a repo-relative path — a Go package IS a directory ('' at the repo root). */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * Extract outbound calls across `files` into `ExternalCallEdge`s: HTTP client calls carry a
 * joinable path template with `serviceName: ''`, registry SDK calls carry the service name and no
 * path. One edge per call site, in file then document order.
 */
export function extractGoEgress(
  files: GoFile[],
  idGen: StableIdGenerator,
  opts: { clientPackages?: string[] },
): ExternalCallEdge[] {
  const clientPackages = opts.clientPackages ?? DEFAULT_CLIENT_PACKAGES;
  const edges: ExternalCallEdge[] = [];

  const resolved = files.map((file) => ({ file, qualifiers: qualifierIndex(buildImportTable(file)) }));

  // Tier (c) is package-scoped: merge every file's client-typed struct fields by directory first,
  // so a call in `service.go` can see a type declared in `types.go`.
  const fieldsByDir = new Map<string, Map<string, Map<string, string>>>();
  for (const { file, qualifiers } of resolved) {
    const dir = dirOf(file.relPath);
    const merged = fieldsByDir.get(dir) ?? new Map<string, Map<string, string>>();
    for (const [structName, fields] of collectFields(file, qualifiers)) {
      const existing = merged.get(structName);
      if (existing) for (const [k, v] of fields) existing.set(k, v);
      else merged.set(structName, new Map(fields));
    }
    fieldsByDir.set(dir, merged);
  }

  for (const { file, qualifiers } of resolved) {
    const scope: FileScope = {
      qualifiers,
      bindings: collectBindings(file, qualifiers),
      fields: fieldsByDir.get(dirOf(file.relPath)) ?? new Map(),
    };

    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const fn = call.childForFieldName?.('function') as TsNode | undefined;
      // Only a selector call can have package provenance: a bare `helper(url)` names nothing we
      // can resolve, and guessing from the argument shape is what this gate exists to prevent.
      if (fn?.type !== SELECTOR_EXPRESSION) continue;
      const name = fn.childForFieldName?.('field')?.text as string | undefined;
      if (!name) continue;

      const importPath = valuePackage(fn.childForFieldName?.('operand'), scope, methodReceiver(call));
      if (!importPath) continue;

      if (matchesPackage(importPath, clientPackages)) {
        const shape = httpCallShape(importPath, name);
        if (!shape) continue; // `Do`, `R()`, `SetHeader(…)` — client plumbing, not a request
        const method = shape.method ?? verbArgument(argAt(call, shape.methodArg ?? 0), scope);
        if (!method) continue; // a non-literal verb — see `verbArgument`
        // Built per SURVIVING call site, not per file: only a call that already resolved to a
        // client package and a literal verb gets this far, so the scan is a handful per repo.
        const locals = singleAssignedLocals(nearestAncestor(call, DEF_TYPES));
        const raw = renderTemplate(urlTokens(argAt(call, shape.urlArg), scope, locals));
        const path = toPathTemplate(raw);
        if (!path) continue; // host-only / fully dynamic → no bogus hostless edge
        edges.push(httpEdge(idGen, file.relPath, call, method, path, raw));
        continue;
      }

      const sdk = sdkForImportPath(importPath);
      if (sdk) edges.push(sdkEdge(idGen, file.relPath, call, sdk, importPath, name));
    }
  }

  return edges;
}
