import type { ArgRef } from './detectors.js';

// ─────────────────────────────────────────────────────────────────────────────
// External client matchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Config-driven service selector for HTTP egress wrappers that route to one of N
 * backends by a *token* read out of the call — the token then translates to a
 * concrete target repo via `serviceMap`. Two read shapes cover the real wrappers:
 *
 *  - `arg-member`: a member of a positional argument, `CONFIG.<token>` at arg N
 *    (e.g. sample-admin's `sendRequest(data, method, url, CONFIG.client_admin_api)`
 *    → token `client_admin_api`). The arg may also be a template literal whose head
 *    is `${CONFIG.<token>}` — the member is still read. When the arg is absent,
 *    `default` supplies the token (the wrapper's default parameter value).
 *  - `uri-template`: the interpolation member inside the URL template literal,
 *    `<object>.<token>` (e.g. client-admin-api's
 *    `` uri: `${this.entrypoints.requests.url}/v2/management/requests/...` `` → token
 *    `requests`). `object` names the interpolated container (`entrypoints`); the
 *    matcher reads the FIRST `<object>.<token>` interpolation in the URL value.
 *
 * The extracted token is looked up in `serviceMap` (token → target repo/service
 * name the linker can scope to a repo). A token with no map entry leaves
 * `targetService` UNSET — the call stays honestly unresolved (never fabricated).
 */
export type ServiceSelector =
  | {
      via: 'arg-member';
      /** Positional argument whose `<container>.<token>` member names the selector. */
      arg: number;
      /** Container identifier the token is a member of, e.g. `CONFIG`. */
      container: string;
      /** Token used when the arg is absent (the wrapper's default param value). */
      default?: string;
      /** selector token → target repo/service name (a `services[]` name or alias). */
      serviceMap: Record<string, string>;
    }
  | {
      via: 'uri-template';
      /** Container identifier interpolated in the URL template, e.g. `entrypoints`. */
      container: string;
      /** selector token → target repo/service name (a `services[]` name or alias). */
      serviceMap: Record<string, string>;
    };

export type ExternalClientMatcher =
  | {
      kind: 'http';
      receiver?: string;
      receiverPattern?: string;
      verbs: string[];
      url?: ArgRef;
      /**
       * Read the real HTTP verb from an argument rather than the matched call method
       * name. For a request WRAPPER (`this.performRequest({ uri, method: 'POST' })`)
       * the `verbs` entry is the wrapper method (`performRequest`), so the descriptor's
       * HTTP method must come from the `{ method }` option, not the wrapper name. Use
       * an `object-property` ArgRef keyed on `method`. When unset, the verb is the
       * matched method name upper-cased (the existing axios-style `client.get(url)`).
       */
      httpMethodFrom?: ArgRef;
      /**
       * The request library's own default verb (got / request / axios: `'GET'`), used when
       * the `httpMethodFrom` object argument has NO such key at all
       * (`this.request({ uri })`). A key whose value is not a literal verb, or an object
       * with a spread (`{ ...opts, uri }`) that might carry it, still falls back to the
       * matched method name.
       */
      httpMethodDefault?: string;
      /**
       * Dynamic-dispatch SDK method name: the POSITIONAL string-literal argument that
       * holds the SDK method NAME for a generic request wrapper that dispatches by name
       * rather than by a static path — `this.performApiRequest('listResources', […])`
       * (an SDK client). When set, the arg's string literal is captured onto
       * the edge's `dispatchMethod`, which the cross-repo sdkMapping fallback keys on
       * (the call site carries no path, so `url`/`httpMethodFrom` cannot resolve it). A
       * non-literal arg (`performApiRequest(method, …)`) is left unresolved. Distinct
       * from `methodArg` (a bareCallee POSITIONAL HTTP *verb*, validated against the
       * verb set); this captures an arbitrary method name, not a verb.
       */
      methodNameArg?: { arg: number };
      /**
       * Config-driven target-service selector (see {@link ServiceSelector}). When set,
       * the extracted token translates through `serviceMap` to the emitted edge's
       * `targetService`. Unmapped tokens leave `targetService` unset.
       */
      serviceSelector?: ServiceSelector;
      serviceName: string;
      sdkName?: string;
    }
  | {
      kind: 'http';
      /** Receiver-less call, e.g. browser `fetch('/api/x', {method})`. */
      bareCallee: string;
      /**
       * Host discriminator (regex source) for repos with SEVERAL `fetch` matchers
       * that differ only by host — `api.github.com`, `api.turso.tech`, etc. The
       * pattern is tested against the URL argument with every resolvable host/prefix
       * interpolation inlined (module const, `Obj.MEMBER`, and `this.<prop>` class
       * string field), so `fetch(`${this.apiBase}/…`)` matches on the concrete host
       * even though `apiBase` is interpolated. A matcher whose pattern does not match
       * is SKIPPED, so the first matcher no longer greedily claims every `fetch`; a
       * matcher with no `urlPattern` is the fallback. When unset, any `fetch` matches
       * (the existing single-matcher behaviour).
       */
      urlPattern?: string;
      /** ArgRef for the URL (arg 0). The HTTP method is read from a 2nd-arg
       * `{ method: 'POST' }` option, defaulting to GET. */
      url?: ArgRef;
      /**
       * Optional POSITIONAL HTTP-method argument for wrappers whose verb is a bare
       * string arg, not a `{ method }` option — e.g. `sendRequest(data, 'POST', url)`
       * (`{ arg: 1 }`). When set, the method is read from this arg's string literal
       * (case-insensitive, validated against the known HTTP verbs); when the arg is
       * absent or not a recognized verb, it falls back to the `{ method }` 2nd-arg
       * option, then GET. When unset, the existing `{ method }`/GET behaviour stands.
       */
      methodArg?: { arg: number };
      /**
       * Config-driven target-service selector (see {@link ServiceSelector}). When set,
       * the extracted token translates through `serviceMap` to the emitted edge's
       * `targetService`. Unmapped tokens leave `targetService` unset.
       */
      serviceSelector?: ServiceSelector;
      serviceName: string;
      sdkName?: string;
    }
  | {
      kind: 'queue';
      receiver?: string;
      receiverPattern?: string;
      methods: string[];
      topic: ArgRef;
      /** Must use the same transport spelling as consumer rules; matching normalizes case/whitespace only. */
      system: string;
    }
  | {
      kind: 'sdk';
      /** Match when an injected DI param's type ends with one of these suffixes. */
      diTypeSuffix?: string[];
      /** Match when the call receiver matches this pattern (regex source). */
      receiverPattern?: string;
      /**
       * Match a call on an instance bound to `new <newInstanceOf>(…)`, e.g.
       * `const a = new Anthropic(); a.messages.create(…)`. With `fromModule`,
       * the constructor must be imported from that module (provenance).
       */
      newInstanceOf?: string;
      fromModule?: string;
      serviceName: string;
      sdkName?: string;
    }
  | {
      /**
       * Import-provenance SDK matcher. Matches a call whose receiver is bound to a
       * DI-injected param (`this.<prop>.…`) or a local identifier whose declared
       * TYPE is imported from a module matching `fromModule`/`fromModulePattern`.
       * This captures egress into a workspace/internal SDK package whose client
       * type does not follow a `*Client` naming convention (so `diTypeSuffix`
       * misses it) — the package itself, named in the PROFILE, is the signal.
       *
       * e.g. `constructor(private apiClient: DemoApiClientService)` where the type
       * is imported from `@sample/demo-api-client`, then
       * `this.apiClient.authSessions.createSession(…)` → an SDK external call.
       */
      kind: 'imported-sdk';
      /** Exact module specifier(s) the receiver's type must be imported from. */
      fromModule?: string | string[];
      /** Regex source matched against the receiver type's import module specifier. */
      fromModulePattern?: string;
      serviceName: string;
      sdkName?: string;
      /**
       * Derive the per-call service name from the first member segment after the
       * matched DI prop (`this.apiClient.<segment>.<method>` → `<segment>`), so a
       * single client into N sub-services yields N distinct serviceNames. When the
       * receiver has no segment (`this.apiClient.<method>`), falls back to
       * `serviceName`.
       */
      serviceFromSegment?: boolean;
      /** Prefix prepended to the derived segment (e.g. `demo-`). */
      serviceSegmentPrefix?: string;
      /** targetDescriptor protocol; `http`/`grpc` also set targetService. */
      protocol?: 'http' | 'grpc' | 'messaging' | 'sdk';
    };
