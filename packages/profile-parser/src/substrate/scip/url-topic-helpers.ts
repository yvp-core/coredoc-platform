/**
 * URL / HTTP-verb / queue-topic free helpers (mirror the ts-morph engine semantics).
 */
import { escapeRegExp } from '../regex-util.js';
import type { ArgRef, ServiceSelector } from '../../types.js';

/** HTTP method from a `fetch(url, { method: 'POST' })` 2nd-arg options literal; GET default. */
export function fetchMethodFromOpts(optsText: string | undefined): string {
  if (!optsText) return 'GET';
  const m = /method\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(optsText);
  return m ? m[1].toUpperCase() : 'GET';
}

/**
 * HTTP verb from a POSITIONAL string-literal method argument (e.g. the `'POST'` in
 * `sendRequest(data, 'POST', url)`). Returns the upper-cased verb only when the arg
 * is a bare string literal naming a known HTTP method; otherwise undefined so the
 * caller falls back. Non-literal method args (a variable, an expression) are NOT
 * recoverable here and yield undefined rather than a wrong guess.
 */
const BARE_HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export function bareStringVerb(argText: string | undefined): string | undefined {
  if (!argText) return undefined;
  const m = /^["'`]([A-Za-z]+)["'`]$/.exec(argText.trim());
  if (!m) return undefined;
  const verb = m[1].toUpperCase();
  return BARE_HTTP_VERBS.has(verb) ? verb : undefined;
}

/**
 * Dynamic-dispatch SDK method NAME from a POSITIONAL string-literal argument, e.g.
 * the `"listResources"` in `this.performApiRequest("listResources", [args])`
 * (an SDK client's repository layer). Unlike {@link bareStringVerb} the
 * value is an arbitrary SDK method name, not an HTTP verb, so it is returned verbatim
 * (no verb allow-list). It must name a plain JS identifier: a variable, member access,
 * interpolated template, or non-identifier literal (a URL/array/object) yields
 * undefined so a non-literal dispatch (`this.performApiRequest(method, …)`) stays
 * honestly unresolved rather than capturing an expression that is not a method name.
 */
export function bareStringMethodName(argText: string | undefined): string | undefined {
  if (!argText) return undefined;
  const m = /^["'`]([A-Za-z_$][\w$]*)["'`]$/.exec(argText.trim());
  return m ? m[1] : undefined;
}

/**
 * Resolve the HTTP URL path-template from a raw call-argument expression per the
 * matcher's `url` ArgRef, then normalize template params.
 *
 *  - `object-property`: the URL lives in a named key of an object-literal argument,
 *    e.g. `this.request({ entrypoint, uri: `/v2/management/...`, method: 'PUT' })`
 *    with `key: 'uri'`. Read the keyed STRING/TEMPLATE value out of the raw object
 *    text (the same shape `resolveQueueTopic`'s object-property branch handles) and
 *    normalize THAT — not the whole multi-line object literal, which would collapse
 *    to garbage under `normalizeUrlTemplate`. Returns undefined when the key is
 *    absent or its value is not a static string/template literal (so the call is
 *    honestly unresolved rather than mis-pathed).
 *  - everything else: the arg itself is (or resolves to) the URL string literal —
 *    normalize it directly.
 */
export function resolveHttpUrl(rawArg: string | undefined, url: ArgRef): string | undefined {
  if (rawArg === undefined) return undefined;
  if (url.as === 'object-property') {
    // Capture the keyed value's INNER text between matching quotes/backticks. A
    // backtick template (`/v2/.../${id}`) has no inner backtick, so the non-greedy
    // body stops at the closing backtick; the captured `${…}` is normalized below.
    const m = new RegExp(`\\b${escapeRegExp(url.key)}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(rawArg);
    if (!m) return undefined;
    const value = `${m[1]}${m[2]}${m[1]}`;
    // A template whose base is a leading `${…}` interpolation (the runtime config
    // host, `${this.entrypoints.<svc>.url}/...`) yields the STATIC TAIL after it as
    // the route — the base carries no routing signal. A literal-led template
    // (`/v2/.../${id}`) has no leading interpolation, so this is a no-op there.
    const tail = templateTailRoute(value);
    if (tail !== undefined) return tail;
    return normalizeUrlTemplate(`\`${m[2]}\``);
  }
  // The raw arg itself may be a leading-interpolation template literal too
  // (e.g. a bareCallee URL arg `` `${CONFIG.x.url}/path` ``).
  const tail = templateTailRoute(rawArg);
  if (tail !== undefined) return tail;
  return normalizeUrlTemplate(rawArg);
}

/**
 * Inline `${IDENT}` interpolations that resolve to a string value (via the
 * caller's `resolveConst`) into a raw URL/template argument, BEFORE route
 * extraction. A leading `${BASE}` const route prefix would otherwise be
 * mistaken for a runtime config host and dropped by
 * {@link templateTailRoute}, collapsing the route to an all-param path that
 * mis-resolves cross-repo.
 *
 * Only BARE identifiers (`${BASE}`) match — member expressions (`${CONFIG.x.url}`,
 * `${this.entrypoints.y.url}`) contain a `.`, don't match, and stay droppable
 * hosts. Identifiers the resolver can't resolve to a non-empty string (path
 * params like `${companyUuid}`, runtime-valued consts) are left verbatim and
 * normalized/dropped downstream.
 */
export function inlineConstInterpolations(
  raw: string | undefined,
  resolveConst: (ident: string) => string | undefined,
): string | undefined {
  if (raw === undefined) return raw;
  return raw.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (full, ident) => {
    const v = resolveConst(ident);
    return typeof v === 'string' && v.length > 0 ? v : full;
  });
}

/**
 * Static route TAIL of a URL whose base is a single leading `${…}` interpolation —
 * the config-driven cross-repo egress shape:
 *
 *   `${this.entrypoints.requests.url}/v2/management/requests/companies/${uuid}/x`
 *      → `/v2/management/requests/companies/{uuid}/x`
 *
 * The leading interpolation is the runtime base host (a config entrypoint), which
 * carries no routing signal; the literal tail after it is the real route on the
 * target service. Only the LAST leading-base interpolation is dropped — embedded
 * `${id}` path params later in the tail are normalized to `{param}` as usual.
 *
 * Returns the normalized tail, or undefined when the value is not a template
 * literal, has no leading interpolation, or the tail is empty (honestly
 * unresolved rather than a synthetic `/`).
 */
export function templateTailRoute(rawArg: string | undefined): string | undefined {
  if (rawArg === undefined) return undefined;
  const trimmed = rawArg.trim();
  // Must be a backtick template literal opening with an interpolation.
  if (!trimmed.startsWith('`')) return undefined;
  const body = trimmed.replace(/^`/, '').replace(/`$/, '');
  const m = /^\$\{[^}]*\}(.*)$/s.exec(body);
  if (!m) return undefined;
  const tail = m[1];
  if (!tail) return undefined;
  return normalizeUrlTemplate(`\`${tail}\``);
}

/**
 * Read a config-driven target-service token from a call and translate it through
 * the selector's `serviceMap` to a target repo/service name. See {@link ServiceSelector}.
 *
 * - `arg-member`: token = the `<container>.<token>` member of `args[arg]`
 *   (a bare member expression or a template literal `` `${<container>.<token>}/...` ``);
 *   falls back to `default` when the arg is absent.
 * - `uri-template`: token = the first `<container>.<token>` interpolation member in
 *   `urlArg` (the URL template-literal value).
 *
 * Returns the mapped target service, or undefined when no token is found or the
 * token has no `serviceMap` entry — the call then stays honestly unresolved.
 */
export function resolveServiceSelector(
  selector: ServiceSelector,
  args: readonly string[],
  urlArg: string | undefined,
): string | undefined {
  let token: string | undefined;
  if (selector.via === 'arg-member') {
    const raw = args[selector.arg];
    token = raw === undefined ? selector.default : (memberToken(raw, selector.container) ?? selector.default);
  } else {
    token = urlArg === undefined ? undefined : memberToken(urlArg, selector.container);
  }
  if (token === undefined) return undefined;
  // Unmapped tokens (Rails-bound / out-of-substrate sentinels) → undefined: the
  // call stays honestly unresolved rather than fabricating a target.
  return selector.serviceMap[token];
}

/** First `<container>.<token>` member token in a raw expression, or undefined. */
function memberToken(rawExpr: string, container: string): string | undefined {
  const re = new RegExp(`\\b${escapeRegExp(container)}\\.([A-Za-z_$][\\w$]*)`);
  return re.exec(rawExpr)?.[1];
}

/**
 * Read an HTTP verb from a call argument per the matcher's `httpMethodFrom` ArgRef.
 * `object-property` reads the `<key>` value from an object-literal arg (the request
 * wrapper `{ method: 'POST' }` shape); a plain ref reads the arg's own string literal.
 * Returns the upper-cased verb only when it names a known HTTP method; otherwise
 * undefined so the caller falls back to the matched method name.
 */
export function resolveHttpMethodArg(rawArg: string | undefined, ref: ArgRef): string | undefined {
  if (rawArg === undefined) return undefined;
  if (ref.as === 'object-property') {
    const m = new RegExp(`\\b${escapeRegExp(ref.key)}\\s*:\\s*(['"\`])([A-Za-z]+)\\1`).exec(rawArg);
    return m ? upperHttpVerb(m[2]) : undefined;
  }
  return bareStringVerb(rawArg);
}

/** Upper-case a string and return it only when it is a known HTTP verb. */
function upperHttpVerb(s: string): string | undefined {
  const v = s.toUpperCase();
  return BARE_HTTP_VERBS.has(v) ? v : undefined;
}

function normalizeUrlTemplate(arg?: string): string | undefined {
  if (!arg) return undefined;
  let s = arg
    .trim()
    .replace(/^['"`]/, '')
    .replace(/['"`]$/, '');
  s = s.replace(/\$\{([^}]*)\}/g, (_f, expr: string) => {
    const ident = /([A-Za-z0-9_]+)\s*$/.exec(String(expr).trim());
    return `{${ident ? ident[1] : 'p'}}`;
  });
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  if (/[([]/.test(s)) return undefined;
  if (!s.startsWith('/') && !s.startsWith('{') && !s.startsWith('http') && !s.includes('/')) return undefined;
  return s.length > 0 ? s : undefined;
}

/** True when a URL string carries its own `scheme://` — i.e. the host is written at the site. */
function isAbsoluteUrl(url: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url);
}

/** Strip one layer of surrounding quotes/backticks off a source-argument expression. */
function unquoteArg(text: string): string {
  return text
    .trim()
    .replace(/^['"`]/, '')
    .replace(/['"`]$/, '');
}

/**
 * Reduce a resolved egress URL to the path that carries its routing signal.
 *
 * A URL arrives absolute when its host interpolation resolved — `const base =
 * 'http://localhost:4747'` inlined into `` `${base}/api/info` `` — which is strictly *more*
 * information than an unresolved `${base}` leaves behind. Without this, that extra
 * knowledge makes the extractor emit *less*: the absolute form fails the path gate and the
 * whole edge is dropped, so every egress routed through a same-file base const disappears
 * while its unresolvable siblings survive. Host-only URLs (no path) stay undefined —
 * honestly unresolved rather than a synthetic `/`.
 *
 * The host is only dropped when it came from an in-repo const. `siteArgText` draws that
 * line, and it must be the **untouched source expression** of the URL argument — not any
 * normalized or const-inlined form of it. That distinction is the whole point: once the
 * const has been substituted in, `http://host/api/info` looks exactly the same whether the
 * host was resolved from the repo or typed at the call site, so a discriminator computed
 * downstream can only ever answer "absolute", and the in-repo-const branch becomes
 * unreachable.
 *
 * Why site-literal hosts must survive: stripping the host off
 * `fetch('https://api.stripe.com/v1/charges')` yields a bare `/v1/charges` that the linker's
 * unscoped tier can bind to any workspace repo's `GET /v1/:_` — a confident false cross-repo
 * edge no reader can tell from a real one. So a site-literal host keeps the edge unresolved,
 * exactly as it was before const resolution existed.
 */
export function routePathFromUrl(url: string | undefined, siteArgText?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return url;
  // Absolute at the source site (not via a const) → third-party by construction. Drop.
  if (siteArgText !== undefined && isAbsoluteUrl(unquoteArg(siteArgText))) return undefined;
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(\/.*)$/.exec(url);
  return m?.[1] && m[1] !== '/' ? m[1] : undefined;
}

/**
 * Resolve a queue/event topic from a raw call-argument expression per the matcher's
 * ArgRef. Handles the three real shapes:
 *  - string-literal:  client.emit('user.created', …)          → "user.created"
 *  - const-string:    client.emit(Topics.EntityCreated, …)     → resolveConst callback
 *  - object-property: client.emit({ pattern: 'x' }) (nestjs) / producer.send({ topic: 'x' }) (kafkajs)
 * Returns undefined when no literal can be recovered, so the caller drops the edge
 * instead of emitting an empty topic.
 *
 * The `resolveConst` callback must handle both a bare identifier (e.g. `MY_CONST`) and
 * a dotted const-member reference (e.g. `Topics.EntityUpdatedV1`).
 */
export interface QueueTopicResolution {
  /** Stable source token, or the literal itself when written inline. */
  topic: string;
  /** Runtime string when a source token was statically folded. */
  topicValue?: string;
}

/** A bare local name — the only argument shape the local-binding hop accepts. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Resolve the topic, taking at most ONE hop through a local binding when the argument as
 * written does not resolve. `resolveLocalBinding` returns the initializer source text of a
 * non-reassigned binding visible at the call site (see the substrate's localBindingInitializer);
 * the rule's OWN declared mode is then re-applied to that text.
 *
 * Deliberate boundaries — a full dataflow is out of scope and would not stay deterministic:
 *  - exactly one hop: the hopped-to expression is resolved by the plain, hop-free resolver, so
 *    an initializer that is itself a bare local name does NOT resolve;
 *  - hop only from a bare identifier argument, or from a bare identifier INSIDE the declared
 *    unwrap call (`wrap(t)`), never from an arbitrary expression;
 *  - a failed hop leaves the pre-existing behaviour untouched: undefined, and the caller drops
 *    the edge rather than inventing a destination.
 */
export function resolveQueueTopicReference(
  rawArg: string | undefined,
  topic: ArgRef,
  resolveConst: (ref: string) => string | undefined,
  resolveLocalBinding?: (name: string) => string | undefined,
): QueueTopicResolution | undefined {
  const direct = resolveQueueTopicAsWritten(rawArg, topic, resolveConst);
  if (direct !== undefined || !resolveLocalBinding || rawArg === undefined) return direct;
  const hopped = hopThroughLocalBinding(rawArg.trim(), topic, resolveLocalBinding);
  return hopped === undefined ? undefined : resolveQueueTopicAsWritten(hopped, topic, resolveConst);
}

/** The argument expression rewritten with its local binding's initializer, or undefined. */
function hopThroughLocalBinding(
  raw: string,
  topic: ArgRef,
  resolveLocalBinding: (name: string) => string | undefined,
): string | undefined {
  if (BARE_IDENTIFIER.test(raw)) return resolveLocalBinding(raw);
  if (topic.as === 'wrapped-enum-member') {
    for (const fn of topic.unwrapCalls) {
      const inner = new RegExp(`^${escapeRegExp(fn)}\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)$`).exec(raw);
      if (!inner) continue;
      const init = resolveLocalBinding(inner[1]);
      return init === undefined ? undefined : `${fn}(${init})`;
    }
  }
  return undefined;
}

function resolveQueueTopicAsWritten(
  rawArg: string | undefined,
  topic: ArgRef,
  resolveConst: (ref: string) => string | undefined,
): QueueTopicResolution | undefined {
  if (rawArg === undefined) return undefined;
  const raw = rawArg.trim();
  if (raw === '') return undefined;
  if (topic.as === 'object-property') {
    // Read `<key>: 'value'` out of the raw object-literal argument text.
    const m = new RegExp(`\\b${escapeRegExp(topic.key)}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(raw);
    return m?.[2] ? { topic: m[2] } : undefined;
  }
  if (topic.as === 'wrapped-enum-member') {
    // Match `topicFor(Topics.EntityUpdatedV1)` from raw arg text.
    // Returns the enum member reference (e.g. "Topics.EntityUpdatedV1") as the stable key.
    // Returns undefined when arg is dynamic (e.g. topicFor(someVar) — no dot).
    for (const fn of topic.unwrapCalls) {
      const re = new RegExp(`^${escapeRegExp(fn)}\\(([A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*)\\)$`);
      const m = re.exec(raw);
      if (m) {
        const topicRef = m[1];
        const topicValue = resolveConst(topicRef);
        return { topic: topicRef, ...(topicValue ? { topicValue } : {}) };
      }
    }
    return undefined;
  }
  if (topic.as === 'identifier') {
    // A destination named by a bare identifier (e.g. a Temporal workflow function passed
    // to `client.workflow.start(workflowFn, …)`). The identifier itself is the stable
    // destination key; a resolvable string const additionally yields the concrete value.
    // Member expressions and call expressions stay unresolved — this mode is deliberately
    // bare-identifier-only so it cannot misread `obj.prop` receivers as destinations.
    if (!BARE_IDENTIFIER.test(raw)) return undefined;
    const value = resolveConst(raw);
    return { topic: raw, ...(value ? { topicValue: value } : {}) };
  }
  // A surrounding-quote string literal resolves directly (string-literal or const-string).
  const lit = /^(['"`])([\s\S]*)\1$/.exec(raw);
  if (lit) return lit[2] ? { topic: lit[2] } : undefined;
  if (topic.as === 'const-string') {
    const resolved = resolveConst(raw);
    return resolved?.length ? { topic: raw, topicValue: resolved } : undefined;
  }
  // string-literal ArgRef but the arg is not a literal → not a recoverable topic.
  return undefined;
}

/** Backward-compatible scalar view used by existing helper callers/tests. */
export function resolveQueueTopic(
  rawArg: string | undefined,
  topic: ArgRef,
  resolveConst: (ref: string) => string | undefined,
): string | undefined {
  const resolved = resolveQueueTopicReference(rawArg, topic, resolveConst);
  return resolved?.topicValue ?? resolved?.topic;
}
