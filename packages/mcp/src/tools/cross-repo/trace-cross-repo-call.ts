/**
 * trace_cross_repo_call Tool Handler
 *
 * Trace a call from one service to another.
 *
 * Supports two modes:
 * 1. Finding external calls TO a target service (from current scope)
 * 2. Finding entrypoints matching a call pattern
 */

import { type IGraphReadRepository } from '@coredoc/db';
import type { ExternalCallInfo, EntrypointInfo as DbEntrypointInfo } from '@coredoc/db';
// NodeType is a runtime value — imported from @coredoc/core (the canonical
// source) so it survives `vi.mock('@coredoc/db')` in the tool tests.
import { NodeType, normalizePath } from '@coredoc/core';
import { createMetadata, formatStalenessHeader } from '../../response-formatter.js';
import { crossRepoLookupHashes } from '../../scope-resolver.js';
import { debug, debugResult } from '../../debug-logger.js';
import { httpMethodMatches, splitHttpMethodPrefix } from '../../http-method.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  McpResponseMetadata,
  FunctionInfo,
  EntrypointInfo,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import {
  filterFunctionInfo,
  filterEntrypointInfo,
  resolveDetailLevel,
  detailEscalationFooter,
} from '../../detail-level.js';
import { effectiveTarget } from './external-call-target.js';
import {
  collectMessagingGraph,
  displayMessagingSystem,
  normalizeRequestedMessagingSystem,
  messagingStalenessWarning,
  resolveMessagingQueryHashes,
  UNKNOWN_MESSAGING_SYSTEM,
  type MessagingConsumerSite,
  type MessagingProducerSite,
} from './messaging-data.js';

/**
 * Build a call pattern string from ExternalCallInfo based on protocol
 */
function buildCallPattern(call: ExternalCallInfo): string {
  if (call.messagingDestination) return call.messagingDestination;
  switch (call.protocol) {
    case 'http':
      return `${call.httpMethod || 'HTTP'} ${call.pathTemplate || ''}`;
    case 'grpc':
      return `${call.grpcService || ''}/${call.grpcMethod || ''}`;
    case 'graphql':
      return `${call.graphqlOperationType || ''} ${call.graphqlOperationName || ''}`;
    default:
      return call.method || '';
  }
}

// The linker's own normalizer (`@coredoc/core` `normalizePath`), so this tool
// compares paths exactly the way the RESOLVES_TO edges it explains were built:
// `{x}` / `${x}` / `:x` collapse to one token, a placeholder glued to a segment
// (`…/superbooking_groups{paramStr}`, a query-string builder) is dropped with
// everything after it, and the result always has a leading slash. Lowercased on
// top only to tolerate agent-side spelling.
function normalizeHttpPath(p: string): string {
  return normalizePath(p).toLowerCase();
}

// Parse "POST /api/foo" into { method, path }. Method is optional and the path
// is returned even when the caller didn't include a verb.
function parseCallPattern(pattern: string): { method?: string; path: string } {
  return splitHttpMethodPrefix(pattern);
}

// Count meaningful path segments (non-empty, ignoring leading/trailing slash).
// Used to gate suffix matching: a 1-segment path like "/" or "/foo" is too
// ambiguous to substring-match against a longer pattern.
function hasMinSegments(p: string, n: number): boolean {
  return p.split('/').filter(Boolean).length >= n;
}

/** Whether a node id belongs to one of `repoHashes` (ids are `<repoHash>:…`). */
function inScope(repoHashes: string[], nodeId: string | undefined): boolean {
  return !!nodeId && repoHashes.some((hash) => nodeId.startsWith(`${hash}:`));
}

/** Project a db-layer entrypoint row onto the MCP response shape. */
function toEntrypointInfo(ep: DbEntrypointInfo): EntrypointInfo {
  return {
    id: ep.id,
    type: ep.type,
    method: ep.method,
    path: ep.path,
    fullPath: ep.fullPath,
    handlerId: ep.handlerId || '',
    handlerName: ep.handlerName || '',
    filePath: ep.filePath,
    startLine: ep.startLine || 0,
  };
}

async function loadEntrypointById(
  repo: IGraphReadRepository,
  id: string,
  repoHashes: string[],
): Promise<EntrypointInfo | undefined> {
  const rows = await repo.listEntrypoints({ id, limit: 1 }, repoHashes);
  return rows[0] ? toEntrypointInfo(rows[0]) : undefined;
}

async function findEntrypointsByPath(
  repo: IGraphReadRepository,
  path: string,
  method: string | undefined,
  repoHashes: string[],
): Promise<EntrypointInfo[]> {
  const rows = await repo.listEntrypoints({ pathPattern: path }, repoHashes);
  const matched = method ? rows.filter((row) => httpMethodMatches(method, row.method)) : rows;
  return matched.map(toEntrypointInfo);
}

/**
 * How many same-named symbols the handler-token lookup will consider. A handler
 * name like `getSuperBookingGroups` legitimately exists in several services of one
 * fleet, and only some of them are the resolved target — so this cannot stop at
 * the first hit, but it is a fixed budget rather than a fleet-wide scan.
 */
const HANDLER_TOKEN_CANDIDATE_LIMIT = 8;

/**
 * How many rows the name search fetches BEFORE the exact-name filter runs.
 *
 * `findCode` matches by substring, so capping the fetch at the candidate budget
 * capped the wrong population: for a short token (`create`, `handler`, `index`)
 * the whole budget is consumed by substring neighbours — `createOrder`,
 * `createUser` — and the exactly-named handler never appears in the page at all,
 * producing a confident answer assembled from whatever survived. The budget that
 * matters is on EXACT matches, so fetch a wider page and let the filter cut it.
 */
const HANDLER_TOKEN_FETCH_LIMIT = 100;

/**
 * Entrypoints whose handler is named `token`.
 *
 * There is no handler-name filter on `listEntrypoints`, and an entrypoint node's
 * `name` is its own id, so the name is only reachable through the handler
 * FUNCTION: find the functions, then ask which entrypoints reach them (the
 * HANDLES edge is depth 1). Exact name match only — a fuzzy hit would put a
 * wrong service's endpoint at the end of a "cross-repo trace".
 */
async function findEntrypointsByHandlerToken(
  repo: IGraphReadRepository,
  token: string,
  repoHashes: string[],
): Promise<EntrypointInfo[]> {
  if (!token) return [];
  const functions = await repo.findCode(
    { pattern: token, types: [NodeType.Function], limit: HANDLER_TOKEN_FETCH_LIMIT },
    repoHashes,
  );
  // Filter to the exact name FIRST, then apply the budget — the reverse order
  // let substring neighbours evict the real handler before it was ever considered.
  const exact = functions
    .filter((fn) => fn.name.toLowerCase() === token.toLowerCase())
    .slice(0, HANDLER_TOKEN_CANDIDATE_LIMIT);
  // Each hop is an independent read; issuing them serially made a bounded lookup
  // cost eight sequential round-trips against Ladybug/Neo4j.
  const reached = await Promise.all(exact.map((fn) => repo.getReachingEntrypoints(fn.id, 1, repoHashes)));
  const found = new Map<string, EntrypointInfo>();
  for (const entrypoints of reached) {
    for (const ep of entrypoints) {
      if (!found.has(ep.id)) found.set(ep.id, toEntrypointInfo(ep));
    }
  }
  return [...found.values()];
}

interface ChainHop {
  kind: string;
  via: string;
  sourceId: string;
  targetId: string;
}

/**
 * How many OTHER matching bridges are named alongside the primary one. A fleet
 * routinely has several services whose handler carries the same name, so
 * returning one hop with no hint that others matched is how a trace quietly
 * answers about the wrong pair of services.
 */
const ALTERNATIVE_BRIDGE_LIMIT = 3;

/** One other resolved bridge the same pattern matched. */
export interface AlternativeBridge {
  caller: string;
  callerRepo: string;
  targetRepo: string;
  filePath: string;
  startLine: number;
}

export interface CrossRepoCallResult {
  caller: {
    function: FunctionInfo;
    repo: string;
  };
  target: {
    entrypoint?: EntrypointInfo;
    repo: string;
    pattern: string;
  };
  chain?: ChainHop[];
  callTree?: FunctionInfo[];
  /** Present when the matched caller was found outside the requested scope. */
  scopeNote?: string;
  /** Other resolved bridges the same pattern matched (capped). */
  alternatives?: AlternativeBridge[];
  summary: string;
}

export interface MessagingDestinationTraceResult {
  mode: 'destination';
  destination: string;
  system?: string;
  status: 'matched' | 'not-found' | 'ambiguous';
  availableSystems?: string[];
  /**
   * Repos whose snapshot predates messaging descriptors. Their producers and
   * consumers are ABSENT from this result — an empty answer here means "re-parse
   * these", not "nothing publishes this destination".
   */
  staleRepos?: string[];
  producers: MessagingProducerSite[];
  consumers: MessagingConsumerSite[];
  summary: string;
}

/**
 * Resolve the queried destination within ONE system.
 *
 * A site carries the runtime destination plus the source token it was written
 * as (`destinationRef`), and the two sides of a topic often disagree about
 * which one they resolved: a producer may emit `orders.v1` where the consumer
 * only ever saw `Topics.ORDERS`. So a token DOES have to join those sites.
 *
 * What it must NOT do is join them TRANSITIVELY. A token is only evidence of
 * identity when it denotes exactly ONE runtime destination. Unresolved or
 * generic tokens (`TOPIC`, `this.topic`, a shared constant) appear on many
 * sites with DIFFERENT destinations; treating those as alias edges collapses
 * unrelated topics into one component, so a query for `orders` also returns the
 * `billing` producer. Hence: a ref that maps to 2+ destinations is discarded as
 * non-discriminating rather than used to merge them.
 *
 * Each site is reduced to one canonical key and compared once — a single pass,
 * replacing a `while (changed)` closure that rescanned every site until the
 * alias set stopped growing.
 */
function matchDestinationWithinSystem(
  destination: string,
  system: string,
  producers: MessagingProducerSite[],
  consumers: MessagingConsumerSite[],
): { producers: MessagingProducerSite[]; consumers: MessagingConsumerSite[] } {
  const producersInSystem = producers.filter((site) => site.system === system);
  const consumersInSystem = consumers.filter((site) => site.system === system);

  // token → the distinct runtime destinations it resolves to, from sites that
  // actually resolved it (destination !== ref).
  const refTargets = new Map<string, Set<string>>();
  for (const site of [...producersInSystem, ...consumersInSystem]) {
    const ref = site.destinationRef;
    if (!ref || ref === site.destination) continue;
    const seen = refTargets.get(ref);
    if (seen) seen.add(site.destination);
    else refTargets.set(ref, new Set([site.destination]));
  }
  /** A token is a usable alias only while it is unambiguous. */
  const aliasOf = (token: string): string | undefined => {
    const seen = refTargets.get(token);
    if (!seen || seen.size !== 1) return undefined;
    return seen.values().next().value;
  };
  // An unresolved site's `destination` IS its token, so route it through the
  // alias; a resolved site is already canonical.
  const keyOf = (site: { destination: string; destinationRef?: string }): string =>
    site.destinationRef && site.destinationRef !== site.destination
      ? site.destination
      : (aliasOf(site.destination) ?? site.destination);

  const queryKey = aliasOf(destination) ?? destination;
  // The `ref === destination` arm keeps an explicit query FOR an ambiguous token
  // honest: asking for `TOPIC` returns every site written as `TOPIC`, while
  // asking for `orders` still never reaches them.
  const matches = (site: { destination: string; destinationRef?: string }): boolean =>
    keyOf(site) === queryKey || site.destinationRef === destination;

  return {
    producers: producersInSystem.filter(matches),
    consumers: consumersInSystem.filter(matches),
  };
}

function formatMessagingDestinationTrace(result: MessagingDestinationTraceResult): string {
  const lines = [`## Messaging Destination Trace`, '', result.summary];
  const staleWarning = messagingStalenessWarning(result.staleRepos ?? []);
  if (staleWarning) lines.push('', staleWarning);
  if (result.availableSystems) lines.push('', `Available systems: ${result.availableSystems.join(', ')}`);
  if (result.producers.length > 0) {
    lines.push('', '### Producers');
    for (const site of result.producers) {
      lines.push(`- ${site.caller} (${site.repo}) — ${site.filePath}:${site.startLine}`);
    }
  }
  if (result.consumers.length > 0) {
    lines.push('', '### Consumers');
    for (const site of result.consumers) {
      lines.push(`- ${site.handler} (${site.repo}) — ${site.filePath}:${site.startLine}`);
    }
  }
  return lines.join('\n');
}

/**
 * Handle trace_cross_repo_call tool
 */
export async function handleTraceCrossRepoCall(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<CrossRepoCallResult | MessagingDestinationTraceResult | string>> {
  const targetService = args.targetService as string | undefined;
  const callPattern = args.callPattern as string | undefined;
  const destination = args.destination as string | undefined;
  const requestedSystem = args.system as string | undefined;

  // Bad arguments are a normal tool outcome, not a crash: return a response the
  // caller can read, with `isError` so composing tools and metrics see the miss.
  // Throwing instead is NOT symmetric across hosts — the local server converts it
  // to `Tool execution failed: …` (server.ts) while the cloud wrapper rethrows into
  // MCP-Nest (base-tool.ts), so the same bad call surfaces two different shapes.
  if (requestedSystem && !destination) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw'
          ? { error: '"system" is only valid with "destination"' }
          : '"system" is only valid with "destination"',
      isError: true,
      metadata,
    } as McpResponse<CrossRepoCallResult | MessagingDestinationTraceResult | string>;
  }
  if (destination && (targetService || callPattern)) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw'
          ? { error: '"destination" cannot be combined with "targetService" or "callPattern"' }
          : '"destination" cannot be combined with "targetService" or "callPattern"',
      isError: true,
      metadata,
    } as McpResponse<CrossRepoCallResult | MessagingDestinationTraceResult | string>;
  }

  if (destination) {
    const hashes = resolveMessagingQueryHashes(args.scope as string | undefined, scope);
    const graph = await collectMessagingGraph(repository, hashes);
    // `undefined` = unfiltered; the reserved word `unknown` maps to the
    // systemless sentinel, matching `list_entrypoints(system:)`.
    const normalizedSystem = normalizeRequestedMessagingSystem(requestedSystem);
    const systems =
      normalizedSystem !== undefined
        ? [normalizedSystem]
        : [...new Set([...graph.producers, ...graph.consumers].map((site) => site.system))].sort();
    const matchesBySystem = new Map<
      string,
      { producers: MessagingProducerSite[]; consumers: MessagingConsumerSite[] }
    >();
    for (const system of systems) {
      const matches = matchDestinationWithinSystem(destination, system, graph.producers, graph.consumers);
      if (matches.producers.length > 0 || matches.consumers.length > 0) matchesBySystem.set(system, matches);
    }

    // No systemless bucket to reconcile: `collectMessagingGraph` drops sites from a
    // stale snapshot outright, so every site here carries a system its own snapshot
    // recorded. A mixed fleet surfaces as the current repos' sites plus `staleRepos`
    // naming what to re-parse, instead of guessing the old rows' broker.

    // Sort on the DISPLAY label — the systemless sentinel is '' and would otherwise
    // sort ahead of everything while rendering as `unknown`.
    const availableSystems = [...matchesBySystem.keys()].sort((a, b) =>
      displayMessagingSystem(a).localeCompare(displayMessagingSystem(b)),
    );

    let result: MessagingDestinationTraceResult;
    if (normalizedSystem === undefined && availableSystems.length > 1) {
      result = {
        mode: 'destination',
        destination,
        status: 'ambiguous',
        availableSystems: availableSystems.map(displayMessagingSystem),
        ...(graph.staleRepos.length > 0 ? { staleRepos: graph.staleRepos } : {}),
        producers: [],
        consumers: [],
        summary: `Destination \`${destination}\` exists in multiple messaging systems; pass \`system\` to disambiguate.`,
      };
    } else {
      const selectedSystem = normalizedSystem ?? availableSystems[0];
      const selectedMatches = selectedSystem !== undefined ? matchesBySystem.get(selectedSystem) : undefined;
      const producers = (selectedMatches?.producers ?? []).map((site) => ({
        ...site,
        system: displayMessagingSystem(site.system),
      }));
      const consumers = (selectedMatches?.consumers ?? []).map((site) => ({
        ...site,
        system: displayMessagingSystem(site.system),
      }));
      const status = producers.length > 0 || consumers.length > 0 ? 'matched' : 'not-found';
      const label = selectedSystem !== undefined ? displayMessagingSystem(selectedSystem) : undefined;
      result = {
        mode: 'destination',
        destination,
        ...(label !== undefined ? { system: label } : {}),
        status,
        ...(graph.staleRepos.length > 0 ? { staleRepos: graph.staleRepos } : {}),
        producers,
        consumers,
        summary:
          status === 'matched'
            ? `Found ${producers.length} producer(s) and ${consumers.length} consumer(s) for \`${label ?? UNKNOWN_MESSAGING_SYSTEM}:${destination}\`.`
            : `No producers or consumers found for \`${label !== undefined ? `${label}:` : ''}${destination}\`.`,
      };
    }

    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return { data: format === 'raw' ? result : formatMessagingDestinationTrace(result), metadata };
  }

  if (!targetService && !callPattern) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw'
          ? { error: 'Must specify either "targetService", "callPattern", or "destination"' }
          : 'Must specify either "targetService", "callPattern", or "destination"',
      isError: true,
      metadata,
    } as McpResponse<CrossRepoCallResult | MessagingDestinationTraceResult | string>;
  }

  debug('findCrossRepoCalls', `targetService=${targetService}, callPattern=${callPattern}`);

  // Strategy 1: If targetService is specified, find external calls to that service
  if (targetService) {
    const externalCalls = await repository.getExternalCalls(scope.repoHashes, targetService);
    debugResult('getExternalCalls', externalCalls.length);

    if (externalCalls.length > 0) {
      const call = externalCalls[0]!;

      // Build call pattern from protocol-specific fields
      const callPatternStr = buildCallPattern(call);

      // Get caller function details
      const callerFunc = await repository.findFunction(call.callerName, scope.repoHashes);
      const callerInfo: FunctionInfo = callerFunc
        ? {
            id: callerFunc.id,
            name: callerFunc.name,
            filePath: callerFunc.filePath,
            startLine: callerFunc.startLine,
            endLine: callerFunc.endLine,
            type: 'function',
            kind: callerFunc.kind,
            summary: callerFunc.summary,
          }
        : {
            id: call.callerId,
            name: call.callerName,
            filePath: call.callerFilePath,
            startLine: call.startLine,
            type: 'function',
            kind: 'function',
          };

      const config = detailConfig || resolveDetailLevel('full');
      const filteredCallerFunction = filterFunctionInfo(callerInfo, config) as FunctionInfo;

      // Caller repo from the caller's own node-id hash, not scope.resolvedRepos[0].
      let s1CallerRepo = scope.resolvedRepos[0] || 'unknown';
      const s1CallerHash = callerInfo.id ? callerInfo.id.split(':')[0] : undefined;
      if (s1CallerHash) {
        const ov = await repository.getRepoOverview([s1CallerHash]);
        s1CallerRepo = ov[0]?.name || s1CallerRepo;
      }

      // Name the EFFECTIVE target: reporting serviceName here answers a query for
      // `client-admin-api` with "calls acme-backend" whenever a profile fills both. A call that
      // resolves back into the caller's own repo names no service, so it is reported as unknown
      // rather than as the caller depending on itself.
      const matchedEffectiveTarget = effectiveTarget(call, s1CallerRepo) ?? 'unknown';

      const result: CrossRepoCallResult = {
        caller: {
          function: filteredCallerFunction,
          repo: s1CallerRepo,
        },
        target: {
          repo: matchedEffectiveTarget,
          pattern: callPatternStr,
        },
        summary: `${call.callerName} calls ${matchedEffectiveTarget} via ${call.protocol}: ${callPatternStr}`,
      };

      const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
      if (format === 'raw') {
        return { data: result, metadata };
      }
      return { data: formatCrossRepoCall(result, metadata), metadata };
    }
  }

  // Strategy 2: Match the callPattern against external_calls in this scope
  // FIRST (the caller side — UI repo, gateway, etc.), then optionally resolve
  // to the downstream entrypoint. Doing entrypoint lookup first returns
  // "No cross-repo calls found" whenever the scope is the *origin* of the
  // call rather than the *target*, even when the matching external_call is
  // right there (e.g. a UI scope querying its own outbound
  // `/shifts/.../analyze-conflicts` call).
  let targetEntrypoint: EntrypointInfo | undefined;
  let matchingCall: ExternalCallInfo | undefined;
  let chain: ChainHop[] | undefined;
  // Set when the answer came from outside the requested scope. Reported rather
  // than silently returned: the agent asked about one repo and is being told
  // about another one's caller.
  let leftScope = false;
  let boundedByWorkspace = false;
  let alternatives: ExternalCallInfo[] = [];
  /**
   * Same-named entrypoints the tool had to choose between with no bridge to
   * decide it. Non-empty means the reported `targetEntrypoint` is ONE of several
   * equally-supported candidates, and the answer must say so.
   */
  let ambiguousTargets: EntrypointInfo[] = [];

  if (callPattern) {
    const { method: patternMethod, path: patternPath } = parseCallPattern(callPattern);
    const normalizedPattern = normalizeHttpPath(patternPath);

    // Rank a set of external_calls against the pattern and pick the BEST match —
    // exact match wins, otherwise the longest segment-boundary-aligned suffix.
    // Runs over the in-scope set first and the whole-graph set second, so the
    // ranking is identical either way.
    // Why not bi-directional substring? The parser emits some calls with
    // `pathTemplate: "/"` (literal slash, e.g. when the URL arg is
    // `apiBaseUrl` with no path). A naive substring check makes `"/"` match
    // every agent query — picking up `usePatternsApi.ts:36` (path "/", no
    // resolvedTargetId) instead of the correct `useTemplatesApi.ts:84` (path
    // /shifts/.../analyze-conflicts, resolvedTargetId set). Segment-boundary
    // suffix prevents `/` from colliding with `/shifts/...` while still
    // allowing parser-relative paths to match agent-supplied gateway-full
    // paths.
    // A path-shaped pattern ("POST /x/y", "/x/y") matches the HTTP pathTemplate.
    // A bare token ("linkSubscription", a messaging destination) matches the SDK
    // method, dynamic-dispatch method, or exact generic destination instead:
    // `apiClient.plans.linkSubscription(...)` carry NO pathTemplate, so the
    // path-only filter silently dropped every one of them (the dominant shape in
    // SDK-first codebases). The resolved target entrypoint is still
    // reached the same way below via resolvedTargetId.
    const looksLikePath = !!patternMethod || patternPath.includes('/');
    const matchExternalCalls = (externalCalls: ExternalCallInfo[]): ExternalCallInfo[] => {
      let candidates: ExternalCallInfo[];
      if (looksLikePath) {
        candidates = externalCalls
          .filter((c) => {
            if (c.protocol !== 'http' || !c.pathTemplate) return false;
            if (patternMethod && c.httpMethod && c.httpMethod.toUpperCase() !== patternMethod) return false;
            const np = normalizeHttpPath(c.pathTemplate);
            if (np === normalizedPattern) return true;
            // Segment-boundary suffix match in either direction. Requires the
            // shorter side to be at least 2 segments long ("/x/y") to avoid the
            // degenerate "/" matches anything bug.
            if (!hasMinSegments(np, 2) && !hasMinSegments(normalizedPattern, 2)) return false;
            // Both sides start with `/`, so a plain suffix test is segment-aligned.
            // A 1-segment pattern never suffix-matches a longer call (`/users`
            // would claim every `…/users`).
            if (!np || !normalizedPattern) return false;
            return (
              normalizedPattern.endsWith(np) || (hasMinSegments(normalizedPattern, 2) && np.endsWith(normalizedPattern))
            );
          })
          // Rank: exact match first, then by descending normalized-path length
          // (longest match wins among suffix-aligned candidates), then by
          // whether resolvedTargetId is set (prefer pre-resolved calls).
          .map((c) => ({ c, np: normalizeHttpPath(c.pathTemplate || '') }))
          .sort((a, b) => {
            const aExact = a.np === normalizedPattern ? 1 : 0;
            const bExact = b.np === normalizedPattern ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;
            if (a.np.length !== b.np.length) return b.np.length - a.np.length;
            const aRes = a.c.resolvedTargetId ? 1 : 0;
            const bRes = b.c.resolvedTargetId ? 1 : 0;
            return bRes - aRes;
          })
          .map((x) => x.c);
      } else {
        const token = patternPath.trim().toLowerCase();
        candidates = externalCalls
          .filter((c) => {
            const m = (c.method || '').toLowerCase();
            const dm = (c.dispatchMethod || '').toLowerCase();
            const messagingDestination = c.messagingDestination || '';
            return (
              m === token ||
              dm === token ||
              messagingDestination === patternPath.trim() ||
              // `plans.linkSubscription` query vs stored `linkSubscription`, and
              // the reverse, so namespaced SDK calls match a bare method name.
              (!!m && token.endsWith(`.${m}`)) ||
              (!!m && m.endsWith(`.${token}`))
            );
          })
          // Prefer pre-resolved calls so resolvedTargetId can be followed.
          .sort((a, b) => (b.resolvedTargetId ? 1 : 0) - (a.resolvedTargetId ? 1 : 0));
      }
      return candidates;
    };

    // The CALLER of a cross-repo call is, by construction, usually NOT in the
    // scope the agent is standing in — asking "who calls GET /x" from the
    // service that SERVES /x is the normal question. Filtering the caller-side
    // scan by `scope.repoHashes` is what made this tool answer with
    // `caller repo == target repo` and `*Caller function not tracked*`: the
    // in-scope scan found nothing, and only the target-side path lookup
    // survived. So: try the scope first (a local caller is the better answer
    // when one exists), then widen to the whole graph, which is where the
    // resolved bridge lives. A cloud workspace scope widens only to its
    // connected repos (`workspaceRepoHashes`).
    const lookupHashes = crossRepoLookupHashes(scope);
    const widens =
      scope.repoHashes.length > 0 && (lookupHashes.length === 0 || lookupHashes.length > scope.repoHashes.length);
    // ONE scan, over the widest set this scope is allowed to see. The in-scope
    // rows are a subset of it, and the ranking below puts them first, so there
    // is no second query — and no way for an in-scope match to hide the
    // cross-repo one the tool exists to find.
    const allCalls = await repository.getExternalCalls(widens ? lookupHashes : scope.repoHashes);
    let candidates = matchExternalCalls(allCalls);
    // TARGET-side resolution: find the entrypoints the pattern names, then walk
    // the RESOLVES_TO spine BACKWARDS to their callers. This is the only route
    // for a pattern that names the callee rather than the call — a handler name
    // (`getSuperBookingGroups`) lives on the entrypoint, never on the caller's
    // external_call row, whose `method` is just `GET`. A bare token is a handler
    // name often enough that this runs even when the caller-side scan already
    // matched (the two can name DIFFERENT bridges, and hiding one of them is how
    // a trace silently answers about the wrong pair of services); a path pattern
    // only needs it as a fallback, where the caller-side scan already answers.
    let targetEntrypoints: EntrypointInfo[] = [];
    if (looksLikePath && candidates.length === 0) {
      // Scope first: when several repos expose the same path, the one the agent
      // named is the one it meant. Widen only when the scope has none.
      targetEntrypoints = await findEntrypointsByPath(repository, patternPath, patternMethod, scope.repoHashes);
      if (targetEntrypoints.length === 0 && widens) {
        targetEntrypoints = await findEntrypointsByPath(repository, patternPath, patternMethod, lookupHashes);
      }
      // The path lookup is a substring match, so a query for `/users` also
      // returns `/users/:id`. When any endpoint matches the pattern EXACTLY,
      // the looser siblings are not the endpoint that was asked about — and
      // must not pull their own inbound bridges into the answer.
      const exact = targetEntrypoints.filter(
        (ep) =>
          normalizeHttpPath(ep.path ?? '') === normalizedPattern ||
          normalizeHttpPath(ep.fullPath ?? '') === normalizedPattern,
      );
      if (exact.length > 0) targetEntrypoints = exact;
    } else if (!looksLikePath) {
      const found = await findEntrypointsByHandlerToken(repository, patternPath.trim(), lookupHashes);
      // In-scope handlers first, same reason.
      targetEntrypoints = [...found].sort(
        (a, b) => Number(inScope(scope.repoHashes, b.id)) - Number(inScope(scope.repoHashes, a.id)),
      );
    }
    const entrypointById = new Map(targetEntrypoints.map((ep) => [ep.id, ep]));
    if (targetEntrypoints.length > 0) {
      const known = new Set(candidates.map((c) => c.id));
      const inbound = allCalls.filter(
        (c) => c.resolvedTargetId && entrypointById.has(c.resolvedTargetId) && !known.has(c.id),
      );
      candidates = [...candidates, ...inbound];
    }

    // Rank: a bridge that touches the requested scope on EITHER side answers the
    // scoped question best; among the rest, order is the matcher's (exactness,
    // then pre-resolved). Stable sort keeps that order within each tier.
    const touchesScope = (c: ExternalCallInfo): boolean =>
      inScope(scope.repoHashes, c.callerId) || inScope(scope.repoHashes, c.resolvedTargetId);
    if (scope.repoHashes.length > 0 && candidates.length > 1) {
      candidates = [...candidates].sort((a, b) => Number(touchesScope(b)) - Number(touchesScope(a)));
    }

    matchingCall = candidates[0];
    debugResult('externalCallByPattern', matchingCall ? 1 : 0);
    if (matchingCall && !scope.repoHashes.some((hash) => matchingCall?.callerId.startsWith(`${hash}:`))) {
      leftScope = true;
    }
    alternatives = candidates.slice(1, 1 + ALTERNATIVE_BRIDGE_LIMIT);
    // A workspace scope is a hard boundary, so "no caller" here means "no caller
    // among the CONNECTED repos" — a different fact from "nothing calls this",
    // and the one the agent needs to act on.
    if (!matchingCall && scope.origin === 'workspace') {
      boundedByWorkspace = true;
    }

    // Follow the matched call's stored linkage to its downstream entrypoint —
    // across the whole graph, because the resolver linked it to a repo that is
    // by definition not the caller's. Re-searching by path in the CURRENT scope
    // instead cannot see sibling repos.
    if (matchingCall?.resolvedTargetId) {
      targetEntrypoint =
        entrypointById.get(matchingCall.resolvedTargetId) ??
        (await loadEntrypointById(repository, matchingCall.resolvedTargetId, lookupHashes));
    } else if (!matchingCall && targetEntrypoints.length > 0) {
      // The endpoint exists but nothing in the graph resolves to it — report the
      // target rather than "no cross-repo calls found".
      targetEntrypoint = targetEntrypoints[0];
      // …but say so when the set was ambiguous. With no bridge to disambiguate,
      // the only ordering applied is in-scope-first, so among out-of-scope repos
      // this pick is DB order. A handler token like `getSuperBookingGroups` exists
      // in several services of one fleet; naming one of them with no hedge is the
      // failure `alternatives` exists to prevent, and `alternatives` cannot cover
      // it because it is derived from external-call candidates, which is exactly
      // the set that is empty on this branch.
      if (targetEntrypoints.length > 1) {
        ambiguousTargets = targetEntrypoints.slice(0, 1 + ALTERNATIVE_BRIDGE_LIMIT);
      }
    }

    // Fallback path-based search when there's no resolvedTargetId (cross-repo
    // resolution hadn't run, or this call didn't resolve). Searches the whole
    // graph for the same reason the resolvedTargetId lookup does: the endpoint
    // being called lives in the callee's repo, not the caller's scope.
    if (!targetEntrypoint) {
      const pathToSearch = matchingCall?.pathTemplate || patternPath;
      // Scope first — with no bridge to follow, an endpoint in the repo the
      // agent named beats a same-path endpoint in an unrelated one — then the
      // whole graph, because the endpoint being called normally lives elsewhere.
      targetEntrypoint = (await findEntrypointsByPath(repository, pathToSearch, patternMethod, scope.repoHashes))[0];
      if (!targetEntrypoint && widens) {
        targetEntrypoint = (await findEntrypointsByPath(repository, pathToSearch, patternMethod, lookupHashes))[0];
      }
    }

    // Walk the stored multi-hop chain provenance (spec §8 D2): the resolved
    // end-edge carries the per-hop trace, so a multi-hop SDK-mediated call
    // (consumer → SDK method → entrypoint) is rendered from one read. Optional
    // method — backends without RESOLVES_TO edge storage keep single-hop.
    if (matchingCall?.id && repository.getResolvesEdge) {
      const resolvesEdge = await repository.getResolvesEdge(matchingCall.id);
      if (resolvesEdge?.chain && resolvesEdge.chain.length > 0) {
        chain = resolvesEdge.chain.map((h) => ({
          kind: h.kind,
          via: h.via,
          sourceId: h.sourceId,
          targetId: h.targetId,
        }));
      }
    }
  }

  debugResult('findCrossRepoCalls', (targetEntrypoint ? 1 : 0) + (matchingCall ? 1 : 0));

  // Both sides empty → genuine no-match. If we matched at least the caller
  // side, report what we know (caller-only response) instead of telling the
  // agent "nothing found."
  if (!targetEntrypoint && !matchingCall) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const desc = targetService || callPattern || 'specified target';
    // A total miss is exactly when the workspace boundary matters most, and it
    // used to be dropped here: `boundedByWorkspace` is computed above but this
    // return discarded it, so the note could only ever appear when something ELSE
    // matched — the opposite of the case it was written for. A no-match under a
    // workspace scope is not evidence that nothing calls the endpoint, and an
    // agent told a flat "no cross-repo calls found" will conclude it is dead.
    const boundaryNote = boundedByWorkspace
      ? 'No caller found among the repos connected to this workspace. That is a workspace boundary, not ' +
        'evidence that nothing calls this endpoint — connect the calling repo to see the bridge.'
      : undefined;
    return {
      data:
        format === 'raw'
          ? // Never a bare `{}`: a raw caller JSON.parses this and an empty object
            // carries no reason at all, the same defect the argument guards fixed.
            { found: false, target: { pattern: desc }, ...(boundaryNote ? { scopeNote: boundaryNote } : {}) }
          : `No cross-repo calls found to '${desc}'.${boundaryNote ? `\n\n> ${boundaryNote}` : ''}`,
      metadata,
    } as McpResponse<CrossRepoCallResult | MessagingDestinationTraceResult | string>;
  }

  const callerInfo: FunctionInfo = matchingCall
    ? {
        id: matchingCall.callerId,
        name: matchingCall.callerName,
        filePath: matchingCall.callerFilePath,
        startLine: matchingCall.startLine,
        type: 'function',
        kind: 'function',
      }
    : {
        id: '',
        name: 'unknown',
        filePath: '',
        startLine: 0,
        type: 'function',
        kind: 'function',
      };

  // Filter results based on detail level
  const config = detailConfig || resolveDetailLevel('full');
  const filteredCallerFunction = filterFunctionInfo(callerInfo, config) as FunctionInfo;
  const filteredTargetEntrypoint = targetEntrypoint
    ? (filterEntrypointInfo(targetEntrypoint, config) as EntrypointInfo)
    : undefined;

  // Report the target repo name. Prefer the REAL repo derived from the
  // resolved entrypoint (when available — the resolver linked the call to
  // a concrete repo). Falls back to the matched call's EFFECTIVE target
  // (`effectiveTarget`, the same precedence the query filtered on), then
  // caller-supplied targetService, then 'unknown'. Without this, a wired-up
  // resolvedTargetId still gets reported under a virtual name instead of the
  // actual repo, so the agent can't name the right hop in its trace response.
  const matchedTarget = matchingCall ? effectiveTarget(matchingCall) : undefined;
  let targetRepo: string;
  if (targetEntrypoint?.id) {
    // Entrypoint IDs are `<repoHash>:entrypoint:<filePath>:<key>` — the
    // first colon-separated segment is the repo hash. Look it up to get
    // the human-readable repo name.
    const targetHash = targetEntrypoint.id.split(':')[0];
    if (targetHash) {
      const overviews = await repository.getRepoOverview([targetHash]);
      targetRepo = overviews[0]?.name || matchedTarget || targetService || 'unknown';
    } else {
      targetRepo = matchedTarget || targetService || 'unknown';
    }
  } else {
    targetRepo = matchedTarget || targetService || 'unknown';
  }

  // Derive the caller's repo from its own node-id hash — NOT scope.resolvedRepos[0],
  // which is just the first repo in a project-wide scope and mislabels the caller
  // (e.g. a api-server caller reported as web-app). Mirrors the targetRepo logic.
  let callerRepo = scope.resolvedRepos[0] || 'unknown';
  const callerHash = callerInfo.id ? callerInfo.id.split(':')[0] : undefined;
  if (callerHash) {
    const callerOverviews = await repository.getRepoOverview([callerHash]);
    callerRepo = callerOverviews[0]?.name || callerRepo;
  }

  // Repo attribution for the alternatives, resolved in ONE lookup: node ids
  // carry the repo hash, and `getRepositoryNames` maps hash → name without the
  // per-repo count subqueries `getRepoOverview` runs.
  const hashOf = (id: string | undefined): string => (id ? (id.split(':')[0] ?? '') : '');
  let alternativeBridges: AlternativeBridge[] = [];
  if (alternatives.length > 0) {
    const hashes = [
      ...new Set(alternatives.flatMap((c) => [hashOf(c.callerId), hashOf(c.resolvedTargetId)]).filter(Boolean)),
    ];
    const nameByHash = new Map((await repository.getRepositoryNames(hashes)).map((row) => [row.hash, row.name]));
    alternativeBridges = alternatives.map((c) => ({
      caller: c.callerName,
      callerRepo: nameByHash.get(hashOf(c.callerId)) ?? 'unknown',
      targetRepo: nameByHash.get(hashOf(c.resolvedTargetId)) ?? c.targetService ?? c.serviceName ?? 'unresolved target',
      filePath: c.callerFilePath,
      startLine: c.startLine,
    }));
  }

  const result: CrossRepoCallResult = {
    caller: {
      function: filteredCallerFunction,
      repo: callerRepo,
    },
    target: {
      entrypoint: filteredTargetEntrypoint,
      repo: targetRepo,
      pattern: callPattern || (matchingCall ? buildCallPattern(matchingCall) : ''),
    },
    chain,
    ...(alternativeBridges.length > 0 ? { alternatives: alternativeBridges } : {}),
    // Ambiguity outranks the scope notes: a caveat about WHICH repo answered is
    // useless if the reader does not first know the named target was a pick.
    ...(ambiguousTargets.length > 1
      ? {
          scopeNote:
            `${ambiguousTargets.length} entrypoints match this pattern and no call edge resolves to any of them, ` +
            `so the one named above is a PICK, not a trace: ${ambiguousTargets
              .map((ep) => `${ep.handlerName ?? 'unknown'} in ${ep.filePath ?? 'unknown'}`)
              .join('; ')}. Name the calling repo in scope, or trace from the caller, to decide between them.`,
        }
      : leftScope && scope.resolvedRepos.length > 0
        ? {
            scopeNote:
              `Answered outside the requested scope (${scope.resolvedRepos.join(', ')}): the caller lives in ` +
              `${callerRepo}. A cross-repo call is normally issued from a repo other than the one it reaches.`,
          }
        : boundedByWorkspace
          ? {
              scopeNote:
                'No caller found among the repos connected to this workspace. That is a workspace boundary, not ' +
                'evidence that nothing calls this endpoint — connect the calling repo to see the bridge.',
            }
          : {}),
    summary: buildCallSummary(callPattern || '', targetEntrypoint, matchingCall),
  };

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);

  if (format === 'raw') {
    return { data: result, metadata };
  }

  return { data: formatCrossRepoCall(result, metadata), metadata };
}

/**
 * Build summary of cross-repo call
 */
function buildCallSummary(
  pattern: string,
  targetEntrypoint: EntrypointInfo | undefined,
  matchingCall: ExternalCallInfo | undefined,
): string {
  if (targetEntrypoint) {
    return `Call pattern \`${pattern}\` matches entrypoint handled by \`${targetEntrypoint.handlerName}\` in ${targetEntrypoint.filePath}`;
  }
  if (matchingCall) {
    const target = effectiveTarget(matchingCall) ?? 'unknown';
    return `Call pattern \`${pattern}\` matches outbound call to \`${target}\` (downstream entrypoint unresolved — target repo may not be parsed)`;
  }
  return `Call pattern \`${pattern}\` not found`;
}

/**
 * Format cross-repo call result as text
 */
function formatCrossRepoCall(
  result: CrossRepoCallResult,
  metadata: Pick<McpResponseMetadata, 'staleness' | 'detailLevel' | 'scope'>,
): string {
  const lines: string[] = [];

  // Staleness warning
  lines.push(formatStalenessHeader(metadata.staleness, metadata.scope?.sessionKey));

  lines.push(`## Cross-Repo Call Trace\n`);
  lines.push(`**Summary:** ${result.summary}\n`);
  if (result.scopeNote) {
    lines.push(`> ${result.scopeNote}\n`);
  }

  // Caller info
  lines.push(`### Caller (${result.caller.repo})`);
  if (result.caller.function.id) {
    const callerName = result.caller.function.className
      ? `${result.caller.function.className}.${result.caller.function.name}`
      : result.caller.function.name;
    lines.push(`- Function: \`${callerName}\``);
    lines.push(`- Location: ${result.caller.function.filePath}:${result.caller.function.startLine}`);
    if (result.caller.function.summary) {
      lines.push(`- Summary: ${result.caller.function.summary}`);
    }
  } else {
    lines.push(`- *Caller function not tracked (external call tracking required)*`);
  }
  lines.push('');

  // Target info
  lines.push(`### Target (${result.target.repo})`);
  lines.push(`- Pattern: \`${result.target.pattern}\``);

  if (result.target.entrypoint) {
    const ep = result.target.entrypoint;
    if (ep.type === 'http') {
      lines.push(`- Endpoint: ${ep.method || 'HTTP'} ${ep.fullPath || ep.path}`);
    } else {
      lines.push(`- Endpoint: ${ep.type} ${ep.fullPath || ep.path || ep.topic || ''}`);
    }
    lines.push(`- Handler: \`${ep.handlerName}\``);
    lines.push(`- Location: ${ep.filePath}:${ep.startLine}`);
  } else {
    lines.push(`- *Target entrypoint not found in parsed data*`);
  }

  // Other bridges the same pattern matched — named with both repos so the agent
  // can tell whether it is looking at the hop it meant.
  if (result.alternatives && result.alternatives.length > 0) {
    lines.push('');
    lines.push(`### Other matching bridges (${result.alternatives.length})`);
    for (const alt of result.alternatives) {
      lines.push(`- \`${alt.caller}\` (${alt.callerRepo}) → ${alt.targetRepo} — ${alt.filePath}:${alt.startLine}`);
    }
  }

  // Resolution chain (multi-hop provenance)
  if (result.chain && result.chain.length > 0) {
    lines.push('');
    lines.push(`### Resolution Chain (${result.chain.length} hops)`);
    for (const hop of result.chain) {
      lines.push(`- ${hop.kind} via \`${hop.via}\`: \`${hop.sourceId}\` → \`${hop.targetId}\``);
    }
  }

  // Call tree if available
  if (result.callTree && result.callTree.length > 0) {
    lines.push('');
    lines.push(`### Handler Call Tree`);
    for (const fn of result.callTree.slice(0, 10)) {
      const fnName = fn.className ? `${fn.className}.${fn.name}` : fn.name;
      lines.push(`- \`${fnName}\``);
    }
    if (result.callTree.length > 10) {
      lines.push(`- ... and ${result.callTree.length - 10} more`);
    }
  }

  const footer = detailEscalationFooter(metadata.detailLevel);
  if (footer) {
    lines.push('');
    lines.push(footer);
  }

  return lines.join('\n');
}
