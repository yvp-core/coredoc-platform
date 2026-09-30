import { CONCRETE_HTTP_METHODS, WILDCARD_HTTP_METHOD } from '../types/output.js';
import type { ExternalCallTarget, HttpMethod } from '../types/output.js';
import { HopVia, UnresolvedCode, type HopResult, type ResolvedHop, type UnresolvedReason } from './types.js';

/**
 * Protocol hop — the workhorse of cross-repo linking.
 *
 * One normalizer (`normalizePath`), one entrypoint index spanning HTTP and
 * queue/event entrypoints, and one `matchProtocolHop`. HTTP uses two-tier
 * (exact → segment-wise) matching with a `:_` placeholder and gateway prefix
 * strip; queue/event uses composite `messagingKey(system, destination)` address
 * keys, so a destination only joins within its own transport — all behind ONE
 * normalizer.
 */

/** Minimal entrypoint shape the index needs. Adapters map ParsedRepo entrypoints / Turso rows onto this. */
export interface EntrypointLike {
  id: string;
  repoName: string;
  /** 'http' uses `http`; queue/event consumers use the messaging address fields. */
  type: 'http' | 'queue' | 'event' | string;
  http?: { method: HttpMethod; path?: string; fullPath?: string };
  /** Transport spelling from queue.system or event.emitter. Missing means legacy/unknown. */
  system?: string;
  /** Queue topic or event name token. */
  destination?: string;
  /** Runtime destination when the token is statically resolvable. */
  destinationValue?: string;
}

/** Minimal egress shape `matchProtocolHop` reads. */
export interface ExternalCallLike {
  id: string;
  /**
   * Node id of the function/method that issues this call. Used by the call-edge
   * hop to find the caller's intra-repo CALLS edges into SDK method nodes.
   */
  callerId?: string;
  /**
   * Name of the repo (or target slice) the call was extracted from. Scopes the
   * call-edge hop's `callTargetsByCaller` lookup — node ids embed only a repo-NAME
   * hash, so two same-named repos in one workspace would otherwise share a caller
   * bucket. Absent means the call-edge hop cannot fire for this call.
   */
  sourceRepoName?: string;
  targetDescriptor?: ExternalCallTarget;
  /** SDK/client package name (e.g. `@myorg/api-client`). Used by the symbol hop. */
  sdkName?: string;
  /** Method name being called. Used by the symbol hop structural fallback. */
  method?: string;
  /**
   * Dynamic-dispatch SDK method name (e.g. `performApiRequest('listResources')`),
   * when present. The sdkMapping fallback keys its (package/class, method) lookup off
   * this in preference to `method`, which holds only the wrapper verb in that shape.
   */
  dispatchMethod?: string;
  /**
   * Raw SCIP package moniker preserved at extraction. Present only on
   * SDK-mediated calls whose call site decoded to a package moniker.
   * `descriptor` is the raw SCIP descriptor tail (version excluded).
   */
  moniker?: { packageName: string; descriptor: string };
}

/** Per-source-repo config carried into matching (the caller's gateway prefix, from coredoc.config.json). */
export interface RepoCfg {
  httpPrefix?: string;
  /**
   * Gateway prefix to STRIP from the head of the caller path before matching, so a
   * fully-prefixed SDK/gateway route (`/v3/management/assistant/x`) matches a service
   * whose entrypoints are at the bare (setGlobalPrefix-relative) path (`/x`). Set
   * by the chain-walker when it resolves the target repo by route-prefix because the
   * service hint did not translate. Distinct from `httpPrefix`, which PRE-pends.
   */
  stripPrefix?: string;
  /**
   * When provided, restrict HTTP entrypoint candidates to this repo name.
   * Prevents equal-path entrypoints in different services from collapsing to
   * ambiguous when the chain-walker already knows the target repo.
   */
  targetRepo?: string;
}

/**
 * The single service-name normalizer. A service hint (`targetDescriptor.targetService`,
 * an `override.services[].name`, or an alias) is matched case-insensitively with
 * surrounding whitespace trimmed. There is exactly ONE normalizer for service
 * names — `buildServiceRepoMap` (keys) and `translateServiceToRepo` (lookups)
 * both route through it so a hint resolves regardless of casing/whitespace skew.
 */
export function normalizeServiceName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Translate a service HINT (the value carried on `targetDescriptor.targetService`,
 * a logical service name, NOT a repo name) to the identity that owns its
 * entrypoints. A {@link ServiceRepoMap} is built from `override.services[]` — each
 * `{ name, repo, aliases, target? }` registers `name` and every `alias` (both
 * normalized) → `(repo, target?)`. `toRepo` scopes `matchHttp`. Undeclared hints
 * return undefined (caller falls back to an unscoped match).
 */
/** A service's identity: the repo it lives in, plus its target inside that repo (v2). */
export interface ServiceIdentity {
  repo: string;
  /** v2: profile target inside `repo`. Absent = whole repo is the service. */
  target?: string;
}

export interface ServiceRepoMap {
  /** Translate a service hint to its repo name, or undefined when undeclared. */
  toRepo(serviceHint: string | undefined): string | undefined;
}

/**
 * Resolve a route to the repo that owns its gateway prefix, by matching the
 * route's leading path segments against each repo's declared `httpPrefix`
 * (`httpPrefixByRepo`, built in `linker.ts` from each repo's config). This is the
 * gateway recovery lever: an SDK/http egress carries a full prefixed path like
 * `/v3/management/assistant/x`, but the target service did NOT translate to a repo
 * (no `services[]` alias), so the linker has no repo to scope+strip against. Here
 * the route's own prefix names the repo.
 *
 * Longest-prefix wins — `/v2/management/calculations/...` resolves to the repo
 * whose prefix is `/v2/management/calculations`, NOT a repo whose prefix is just
 * `/v2/management`. A genuine tie (two repos sharing an equal-length matching
 * prefix) is reported as ambiguous, never guessed.
 *
 * Returns the matched `{ repo, prefix }` on a unique longest match, `'ambiguous'`
 * on an equal-length tie, or `undefined` when no repo prefix is a leading match.
 */
export function resolveRepoByRoutePrefix(
  path: string,
  httpPrefixByRepo: Record<string, string | undefined>,
): { repo: string; prefix: string } | 'ambiguous' | undefined {
  const routeSig = normalizePath(path);
  let best: { repo: string; prefix: string; len: number } | undefined;
  let tiedAtBest = false;
  for (const [repo, rawPrefix] of Object.entries(httpPrefixByRepo)) {
    if (!rawPrefix) continue;
    const prefixSig = normalizePath(rawPrefix);
    // A leading match means the route is exactly the prefix or continues past it
    // on a segment boundary — not a partial segment collision (e.g. `/v2/manage`
    // must not match prefix `/v2/management`).
    if (routeSig !== prefixSig && !routeSig.startsWith(`${prefixSig}/`)) continue;
    const len = prefixSig.length;
    if (!best || len > best.len) {
      best = { repo, prefix: rawPrefix, len };
      tiedAtBest = false;
    } else if (len === best.len && repo !== best.repo) {
      tiedAtBest = true;
    }
  }
  if (!best) return undefined;
  if (tiedAtBest) return 'ambiguous';
  return { repo: best.repo, prefix: best.prefix };
}

/** Build a {@link ServiceRepoMap} from the override's `services[]` entries. */
export function buildServiceRepoMap(
  services: ReadonlyArray<{ name: string; repo: string; aliases?: string[]; target?: string }>,
): ServiceRepoMap {
  const byHint = new Map<string, ServiceIdentity>();
  for (const svc of services) {
    const identity: ServiceIdentity =
      svc.target !== undefined ? { repo: svc.repo, target: svc.target } : { repo: svc.repo };
    byHint.set(normalizeServiceName(svc.name), identity);
    for (const alias of svc.aliases ?? []) {
      byHint.set(normalizeServiceName(alias), identity);
    }
  }
  return {
    toRepo(serviceHint) {
      if (serviceHint === undefined) return undefined;
      return byHint.get(normalizeServiceName(serviceHint))?.repo;
    },
  };
}

export interface EntrypointIndex {
  /**
   * Returns the ids of entrypoints matching `(method, path)` after normalization.
   * Two-tier: exact-signature hit first, then segment-wise literal-vs-param scan
   * (a caller literal matches an entrypoint path-param; most-specific wins).
   * When `opts.httpPrefix` is set the caller path is also tried with the prefix
   * PRE-pended, so an unprefixed UI caller matches a prefixed gateway entrypoint.
   * When `opts.stripPrefix` is set the caller path is also tried with that prefix
   * RE-moved from its head, so a fully-prefixed gateway/SDK caller path
   * (`/v3/management/assistant/x`) matches a service whose entrypoints are at the
   * BARE path (`/x`, NestJS `setGlobalPrefix` relative `@Controller`s).
   * When `opts.targetRepo` is provided, only entrypoints belonging to that repo are
   * considered — this prevents equal-path entrypoints in different services from
   * collapsing to ambiguous when the chain-walker already knows the target.
   * More than one id means ambiguity — the caller decides how to bucket it.
   */
  matchHttp(
    method: string,
    path: string,
    opts?: { httpPrefix?: string; stripPrefix?: string; targetRepo?: string },
  ): string[];
  /** Match a case-sensitive destination within a normalized messaging system. */
  matchMessaging(system: string | undefined, destination: string): string[];
  /**
   * Normalized systems that DO index `destination`, sorted. Diagnostic only: a
   * messaging miss is otherwise indistinguishable from "nobody consumes this",
   * and the commonest cause is one bus spelled two ways across repos — which the
   * per-profile spelling lint cannot see. Never widens matching.
   */
  systemsForDestination(destination: string): string[];
}

/**
 * The single normalizer. Collapses `${name}` / `{name}` / `:name` to one
 * placeholder token, strips query/fragment, collapses duplicate slashes, drops
 * the trailing slash, and ensures a leading slash. There is no second
 * normalizer after this.
 */
export function normalizePath(path: string): string {
  return (
    path
      // Path only — query string and fragment are not significant for routing.
      .replace(/[?#].*$/, '')
      // A `${...}`/`{...}` interpolation GLUED to a segment word-char (e.g.
      // `/items/{id}/list{params}`, `/.../foo{queryString}`) is an appended query string
      // / dynamic tail, NOT a path param (real params follow `/`, e.g. `/items/${id}/sub`).
      // Drop it and everything after so the route matches its static prefix. The leading
      // word-char class excludes `/` and `$`, so a normal `${param}` after `/` is left for
      // the param-collapse step below.
      .replace(/([A-Za-z0-9._-])(?:\$\{[^}]*\}|\{[^}]*\}).*$/, '$1')
      // Template literals ${name}, OpenAPI {name}, Express :name → one token.
      .replace(/\$\{[^}]+\}/g, ':_')
      .replace(/\{[^}]+\}/g, ':_')
      .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, ':_')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .replace(/^([^/])/, '/$1')
  );
}

interface IndexedHttpEp {
  id: string;
  repoName: string;
  segs: string[]; // normalized signature split on '/', leading '' dropped
}

class EntrypointIndexImpl implements EntrypointIndex {
  /** Exact normalized-signature lookup: `${method}|${sig}` → indexed entries. */
  private readonly httpExact = new Map<string, IndexedHttpEp[]>();
  /** Segment-wise candidates: `${method}|${segCount}` → indexed entrypoints. */
  private readonly httpByLength = new Map<string, IndexedHttpEp[]>();
  /** Messaging lookup: normalized system + exact destination → ids. Empty system is legacy/unknown. */
  private readonly byMessaging = new Map<string, string[]>();
  /** Diagnostic side-index: exact destination → the normalized systems that carry it. */
  private readonly systemsByDestination = new Map<string, string[]>();

  add(ep: EntrypointLike): void {
    if (ep.type === 'http') {
      const http = ep.http;
      if (!http?.method) return;
      // Index under both `path` and `fullPath` so callers that issue either form match.
      const candidates = new Set<string>();
      if (http.path) candidates.add(http.path);
      if (http.fullPath) candidates.add(http.fullPath);
      if (candidates.size === 0) return;
      // A wildcard (`ALL`) handler serves every verb, so index it under each concrete verb as
      // well as under `ALL`. Both lookup tiers key on an exact method string, so without this
      // expansion a caller issuing `GET` can never reach a wildcard entrypoint — which is every
      // Next.js pages-router API file, and every `router.all(...)` route.
      const indexMethods =
        http.method === WILDCARD_HTTP_METHOD ? [...CONCRETE_HTTP_METHODS, WILDCARD_HTTP_METHOD] : [http.method];
      const seenSegs = new Set<string>();
      for (const candidate of candidates) {
        const sig = normalizePath(candidate);
        const entry: IndexedHttpEp = { id: ep.id, repoName: ep.repoName, segs: sig.split('/').slice(1) };
        for (const method of indexMethods) pushIndexed(this.httpExact, `${method}|${sig}`, entry);
        const segKey = `${ep.id}|${entry.segs.join('§')}`;
        if (seenSegs.has(segKey)) continue;
        seenSegs.add(segKey);
        for (const method of indexMethods) pushIndexed(this.httpByLength, `${method}|${entry.segs.length}`, entry);
      }
      return;
    }
    // Queue + event share one broker-agnostic address index. Index both token and
    // resolved value so partially resolved graphs still join without losing system scope.
    const system = normalizeMessagingSystem(ep.system);
    if (ep.destination) {
      push(this.byMessaging, messagingKey(system, ep.destination), ep.id);
      push(this.systemsByDestination, ep.destination, system);
    }
    if (ep.destinationValue && ep.destinationValue !== ep.destination) {
      push(this.byMessaging, messagingKey(system, ep.destinationValue), ep.id);
      push(this.systemsByDestination, ep.destinationValue, system);
    }
  }

  matchHttp(
    method: string,
    path: string,
    opts?: { httpPrefix?: string; stripPrefix?: string; targetRepo?: string },
  ): string[] {
    const filter = opts?.targetRepo;
    const direct = this.matchHttpOne(method, normalizePath(path), filter);
    if (direct.length > 0) return direct;
    // Gateway (prepend): try the caller path WITH the repo prefix prepended, so an
    // unprefixed UI path matches a prefixed gateway entrypoint.
    if (opts?.httpPrefix) {
      const joined = `${opts.httpPrefix}/${path}`.replace(/\/+/g, '/');
      const prepended = this.matchHttpOne(method, normalizePath(joined), filter);
      if (prepended.length > 0) return prepended;
    }
    // Gateway (strip): try the caller path WITH the repo prefix removed from its
    // head, so a fully-prefixed SDK/gateway path matches a service whose
    // entrypoints are at the bare (setGlobalPrefix-relative) path.
    if (opts?.stripPrefix) {
      const stripped = stripLeadingPrefix(normalizePath(path), normalizePath(opts.stripPrefix));
      if (stripped !== undefined) return this.matchHttpOne(method, stripped, filter);
    }
    return [];
  }

  private matchHttpOne(method: string, sig: string, targetRepo?: string): string[] {
    // Tier 1: exact normalized signature.
    const exactCandidates = this.httpExact.get(`${method}|${sig}`);
    const exact = targetRepo
      ? (exactCandidates ?? []).filter((e) => e.repoName === targetRepo)
      : (exactCandidates ?? []);
    if (exact.length > 0) return dedupe(exact.map((e) => e.id));

    // Tier 2: segment-wise. An entrypoint param segment (`:_`) accepts any
    // caller segment; a caller param (`:_`) only matches an entrypoint param.
    const callerSegs = sig.split('/').slice(1);
    const bucket = this.httpByLength.get(`${method}|${callerSegs.length}`);
    if (!bucket || bucket.length === 0) return [];
    const candidates = targetRepo ? bucket.filter((e) => e.repoName === targetRepo) : bucket;
    const matches: IndexedHttpEp[] = [];
    for (const cand of candidates) {
      let ok = true;
      for (let i = 0; i < callerSegs.length; i++) {
        const c = callerSegs[i];
        const e = cand.segs[i];
        if (c === e) continue;
        if (e === ':_') continue; // entrypoint param accepts any caller value
        ok = false;
        break;
      }
      if (ok) matches.push(cand);
    }
    if (matches.length === 0) return [];
    if (matches.length === 1) return [matches[0]!.id];
    // Prefer the most specific route — fewest `:_` placeholder segments.
    const paramCount = (e: IndexedHttpEp) => e.segs.filter((s) => s === ':_').length;
    matches.sort((a, b) => paramCount(a) - paramCount(b));
    const best = paramCount(matches[0]!);
    const winners = matches.filter((m) => paramCount(m) === best);
    // A single most-specific winner resolves; an equal-specificity tie is ambiguous (caller buckets it).
    return dedupe(winners.map((w) => w.id));
  }

  matchMessaging(system: string | undefined, destination: string): string[] {
    if (!destination) return [];
    return dedupe(this.byMessaging.get(messagingKey(normalizeMessagingSystem(system), destination)) ?? []);
  }

  systemsForDestination(destination: string): string[] {
    if (!destination) return [];
    return dedupe(this.systemsByDestination.get(destination) ?? []).sort();
  }
}

function normalizeMessagingSystem(system: string | undefined): string {
  return system?.trim().toLowerCase() ?? '';
}

function messagingKey(system: string, destination: string): string {
  return `${system}\u0000${destination}`;
}

function pushIndexed(map: Map<string, IndexedHttpEp[]>, key: string, value: IndexedHttpEp): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Remove `prefixSig` from the head of an already-normalized `routeSig`, returning
 * the bare remainder (with a leading slash, never empty). Both inputs must already
 * be `normalizePath`-normalized. Returns undefined when the prefix is not a
 * leading segment-boundary match — so a partial collision (`/v2/manage` vs prefix
 * `/v2/management`) does not strip.
 */
function stripLeadingPrefix(routeSig: string, prefixSig: string): string | undefined {
  if (routeSig === prefixSig) return '/';
  if (!routeSig.startsWith(`${prefixSig}/`)) return undefined;
  return routeSig.slice(prefixSig.length);
}

/** Build the protocol-hop index over a flat list of entrypoints (all repos). */
export function buildEntrypointIndex(entrypoints: EntrypointLike[]): EntrypointIndex {
  const index = new EntrypointIndexImpl();
  for (const ep of entrypoints) index.add(ep);
  return index;
}

/**
 * Confidence for a resolved protocol hop. An exact normalized-signature match
 * is the strongest deterministic signal we have short of a moniker join, so it
 * scores 0.95; exact messaging-address matches are equally deterministic at 0.95.
 */
const PROTOCOL_HOP_CONFIDENCE = 0.95;

function resolved(sourceId: string, targetId: string, via: ResolvedHop['via']): ResolvedHop {
  return { kind: 'protocol', sourceId, targetId, via, confidence: PROTOCOL_HOP_CONFIDENCE };
}

function unresolved(sourceId: string, code: UnresolvedReason['code'], detail?: string): UnresolvedReason {
  return { sourceId, code, ...(detail ? { detail } : {}) };
}

/**
 * Detail for a messaging miss. When the destination IS indexed but under other
 * systems, say so: the dominant cause of a zero-recall messaging join is one bus
 * spelled two ways (`gcp-pubsub` / `google-pubsub`) across a producer profile and
 * a consumer profile, and the parse-time lint only ever sees ONE profile. Without
 * this the failure is indistinguishable from "nobody consumes this destination".
 */
function messagingMissDetail(index: EntrypointIndex, system: string | undefined, destination: string): string {
  const requested = normalizeMessagingSystem(system);
  const others = index.systemsForDestination(destination).filter((candidate) => candidate !== requested);
  if (others.length === 0) return destination;
  const spelled = others.map((candidate) => candidate || '(no system)').join(', ');
  return `${destination} (indexed under ${spelled}, not ${requested || '(no system)'} — same bus spelled two ways?)`;
}

/**
 * Resolve a single egress call to a target entrypoint via the protocol hop.
 * Honest bucketing:
 *   - http with no path template            → no-path
 *   - http, one match                        → resolved(via 'http')
 *   - http, zero matches                     → no-entrypoint-match
 *   - http, >1 match (equal specificity)     → ambiguous
 *   - messaging with empty destination       → no-destination
 *   - messaging, one address match           → resolved(via messaging)
 *   - messaging, zero address matches        → no-messaging-match
 *   - messaging, >1 address matches          → ambiguous
 *   - ipc uses the same address index under the implicit electron-ipc system.
 * Remaining protocols are explicitly unsupported by this matcher.
 */
export function matchProtocolHop(call: ExternalCallLike, index: EntrypointIndex, cfg: RepoCfg): HopResult {
  const desc = call.targetDescriptor;
  if (!desc) {
    return unresolved(call.id, UnresolvedCode.UnsupportedProtocol, 'protocol unknown not handled by the protocol hop');
  }
  const protocol = desc.protocol;

  if (protocol === 'http') {
    const http = desc.http;
    if (!http?.pathTemplate || !http.method) {
      return unresolved(call.id, UnresolvedCode.NoPath, 'http external call has no path template');
    }
    const ids = index.matchHttp(http.method, http.pathTemplate, {
      httpPrefix: cfg.httpPrefix,
      stripPrefix: cfg.stripPrefix,
      targetRepo: cfg.targetRepo,
    });
    if (ids.length === 0) {
      return unresolved(call.id, UnresolvedCode.NoEntrypointMatch, `${http.method} ${http.pathTemplate}`);
    }
    if (ids.length > 1) return unresolved(call.id, UnresolvedCode.Ambiguous, `${http.method} ${http.pathTemplate}`);
    return resolved(call.id, ids[0]!, HopVia.Http);
  }

  if (protocol === 'messaging') {
    const destinationValue = desc.messaging?.destinationValue;
    const destinationRef = desc.messaging?.destination;
    const system = desc.messaging?.system;
    if (!destinationValue && !destinationRef) {
      return unresolved(call.id, UnresolvedCode.NoDestination, 'messaging external call has empty destination');
    }
    // Prefer the resolved runtime value, fall back to the source token — a graph
    // where only one side resolved the enum still joins.
    const destinations = [destinationValue, destinationRef].filter(
      (candidate, position, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === position,
    );
    let destination = destinations[0] ?? '';
    let ids: string[] = [];
    for (const candidate of destinations) {
      destination = candidate;
      ids = index.matchMessaging(system, candidate);
      if (ids.length > 0) break;
    }
    if (ids.length === 0) {
      return unresolved(call.id, UnresolvedCode.NoMessagingMatch, messagingMissDetail(index, system, destination));
    }
    if (ids.length > 1) return unresolved(call.id, UnresolvedCode.Ambiguous, destination);
    return resolved(call.id, ids[0]!, HopVia.Messaging);
  }

  if (protocol === 'ipc') {
    const channel = desc.ipc?.channel ?? '';
    if (!channel) return unresolved(call.id, UnresolvedCode.NoDestination, 'ipc external call has empty channel');
    const ids = index.matchMessaging('electron-ipc', channel);
    if (ids.length === 0) {
      // `electron-ipc` is a reserved literal on the egress side — a handler
      // registered under any other `system` spelling lands here, so name it.
      return unresolved(call.id, UnresolvedCode.NoMessagingMatch, messagingMissDetail(index, 'electron-ipc', channel));
    }
    if (ids.length > 1) return unresolved(call.id, UnresolvedCode.Ambiguous, channel);
    return resolved(call.id, ids[0]!, HopVia.Ipc);
  }

  switch (protocol) {
    case 'grpc':
    case 'graphql':
    case 'subprocess':
    case 'internal':
      return unresolved(
        call.id,
        UnresolvedCode.UnsupportedProtocol,
        `protocol ${protocol ?? 'unknown'} not handled by the protocol hop`,
      );
    default: {
      // Compile-time exhaustiveness, but stay TOTAL at runtime. `protocol` reaches
      // here through unchecked casts off persisted text (`from-turso.ts`
      // rebuildTargetDescriptor, `repository.ts` row.protocol), so an out-of-union
      // value must bucket as unresolved — returning the `never` binding would hand
      // callers `undefined` and blow up in `isResolved`'s `'targetId' in r`.
      const exhaustive: never = protocol;
      return unresolved(
        call.id,
        UnresolvedCode.UnsupportedProtocol,
        `protocol ${String(exhaustive)} not handled by the protocol hop`,
      );
    }
  }
}
